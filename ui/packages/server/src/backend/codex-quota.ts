import { join } from "node:path"
import { readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from "node:fs"
import type { ProviderQuota, QuotaWindow } from "@fray-ui/shared"
import { defaultCodexHome } from "./codex.ts"

// Read the Codex subscription quota (5-hour + weekly rate-limit windows) from the SAME rollout JSONL
// files fray already tails — no credentials, no network. Every Codex `token_count` event carries a
// `rate_limits` block that is ACCOUNT-GLOBAL (identical across concurrent sessions), so the freshest
// one from the most-recently-written rollout is the whole account's live state:
//
//   {"type":"token_count","info":{…},"rate_limits":{
//     "limit_id":"codex","plan_type":"pro",
//     "primary":  {"used_percent":12.5,"window_minutes":300,  "resets_at":1783730191},  // 5-hour
//     "secondary":{"used_percent":40.0,"window_minutes":10080,"resets_at":1784316991}}} // weekly (7d)
//
// window_minutes disambiguates which window is which rather than trusting primary/secondary names:
// 300 → "5h", 10080 → "Weekly". used_percent is 0..100 (remaining = 100 - used_percent); resets_at is
// unix seconds. Grounded in captured 0.144.1 rollouts (backend/codex.fixtures/*.jsonl).

function sessionsDir(codexHome: string): string {
  return join(codexHome, "sessions")
}

// Newest-first walk of the date-sharded rollout tree (YYYY/MM/DD dirs + flat legacy files), bounded so
// a pathological "thousands of sessions" tree can't blow the budget. Mirrors codex.ts's own discovery
// ordering (descending dir/file names visit today's shard first). Degrades to [] on any fs error.
const descByName = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
function newestRollouts(dir: string, out: string[], budget: { n: number }): void {
  if (budget.n <= 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(descByName)
  const files = entries
    .filter((e) => e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl"))
    .map((e) => e.name)
    .sort(descByName)
  for (const d of dirs) {
    if (budget.n <= 0) return
    newestRollouts(join(dir, d), out, budget)
  }
  for (const f of files) {
    if (budget.n <= 0) return
    out.push(join(dir, f))
    budget.n--
  }
}

// A rate_limits window as it appears in a token_count event.
interface RawWindow {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

// Read only the TAIL of a rollout — a live transcript can be tens of MB, but the `token_count` event we
// need is emitted every turn and the file ends within a few records of the last turn, so the last chunk
// always holds the freshest rate_limits. Bounds every read; degrades to "" on any fs error (never throws).
const TAIL_BYTES = 512 * 1024
function readTail(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const len = size - start
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.toString("utf8", 0, read)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already closed / gone */
      }
    }
  }
}

function toWindow(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as RawWindow
  const used = typeof w.used_percent === "number" && Number.isFinite(w.used_percent) ? w.used_percent : undefined
  if (used === undefined) return undefined
  const minutes = typeof w.window_minutes === "number" ? w.window_minutes : undefined
  // Label by window length: 300 min = 5h, 10080 min = weekly; anything else falls back to an hour count.
  const key = minutes === 300 ? "5h" : minutes && minutes >= 10080 ? "weekly" : minutes ? `${Math.round(minutes / 60)}h` : "window"
  const label = key === "weekly" ? "Weekly" : key
  const resetsAt = typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at : undefined
  return { key, label, usedPercent: used, resetsAt }
}

// Parse the LAST token_count event out of a rollout's raw text → its rate_limits, or undefined. Scans
// lines from the end so a long rollout only JSON-parses its tail. Handles BOTH captured shapes: the
// live rollout wraps it as {type:"event_msg", payload:{type:"token_count", rate_limits}}, while some
// exec/fixture captures flatten rate_limits onto the top-level object. Total: never throws.
export function parseCodexQuotaFromRollout(raw: string): ProviderQuota | undefined {
  const lines = raw.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes("\"token_count\"") || !line.includes("rate_limits")) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue
    const top = obj as Record<string, unknown>
    const payload = top.payload && typeof top.payload === "object" ? (top.payload as Record<string, unknown>) : undefined
    const rl = top.rate_limits ?? payload?.rate_limits
    if (!rl || typeof rl !== "object") continue
    const r = rl as Record<string, unknown>
    const windows = [toWindow(r.primary), toWindow(r.secondary)].filter((x): x is QuotaWindow => x !== undefined)
    if (windows.length === 0) continue
    const planType = typeof r.plan_type === "string" ? r.plan_type : undefined
    return { status: "ok", planType, windows }
  }
  return undefined
}

// Short read-through memo — the rate_limits state changes only per turn and the newest rollout is small
// to tail, but repeated 60s polls shouldn't re-walk the tree every time. Keyed by codexHome so distinct
// homes (tests) never collide.
const TTL_MS = 20_000
const memo = new Map<string, { at: number; quota: ProviderQuota }>()

// The Codex provider quota (RPC-facing). Walks the newest handful of rollouts, returns the freshest
// rate_limits it can parse, and degrades to a neutral "unavailable" (never throws) when Codex has no
// sessions yet or none recorded a rate_limits block.
export function readCodexQuota(codexHome = defaultCodexHome()): ProviderQuota {
  const now = Date.now()
  const hit = memo.get(codexHome)
  if (hit && now - hit.at < TTL_MS) return hit.quota
  let quota: ProviderQuota = { status: "unavailable", windows: [], detail: "No recent Codex session" }
  try {
    const rollouts: string[] = []
    newestRollouts(sessionsDir(codexHome), rollouts, { n: 8 })
    // Order the candidates by mtime so the freshest rate_limits wins even across date shards.
    const byMtime = rollouts
      .map((path) => {
        try {
          return { path, mtimeMs: statSync(path).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((x): x is { path: string; mtimeMs: number } => x !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { path } of byMtime) {
      const parsed = parseCodexQuotaFromRollout(readTail(path))
      if (parsed) {
        quota = parsed
        break
      }
    }
  } catch {
    quota = { status: "unavailable", windows: [], detail: "Codex rollouts unreadable" }
  }
  memo.set(codexHome, { at: now, quota })
  return quota
}
