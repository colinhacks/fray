import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import type { FenceView } from "./tailer.ts"

const execFileAsync = promisify(execFile)

// ---- WAKERS: fray-ui as the durable scheduler that RESUMES a rested session when its declared wait
// condition fires (audit finding-4: an `awaiting` fence must not excuse a thread forever with nobody
// owning the wake). The mechanism is the EXISTING `awaiting` fence — no new agent tool. On a tick, for
// every non-archived, at-rest, registered session thread whose lastFence is `awaiting` with an
// actionable hint (timer/pr/ci), we check the condition OUT OF BAND and, when it fires, RESUME the
// session with a steer describing what happened. The agent's new turn supersedes the fence (the tailer
// clears lastFence on the new activity) → naturally idempotent.
//
// ---- THE BOOT-MASS-FIRE SAFETY GUARD (critical — the maintainer has ~14 real sessions) ----
// We fire ONLY on a wait condition we witness transition from UNMET → MET while the scheduler is
// watching it live. Concretely, a hint arms only after we OBSERVE it unmet at least once; a hint that
// is ALREADY MET the first time we see it (a long-past `timer:`, an already-merged `pr:`) NEVER fires.
// So a server (re)start that inherits a pile of already-elapsed awaiting fences resumes NOTHING —
// there was no live transition. Layer two: a PERSISTED fired-marker (keyed by slug + the fence's hint
// identity) makes a resume single-fire ACROSS a restart, closing the window between the resume and the
// agent's superseding turn landing in the JSONL. When a thread's awaiting fence clears/changes (the
// agent moved on, or re-awaits something new), we forget both the in-memory arming and the persisted
// marker, so a genuinely-new wait arms and can fire again.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// The distilled PR status we act on (from one `gh pr view … --json state,mergedAt,statusCheckRollup`).
export interface PrStatus {
  state: string // OPEN | CLOSED | MERGED
  mergedAt: string | null
  rollup: RollupEntry[] // statusCheckRollup entries (CheckRun and/or StatusContext shapes)
}
interface RollupEntry {
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | PENDING | WAITING
  conclusion?: string // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ACTION_REQUIRED | SKIPPED | STALE
  state?: string // StatusContext: PENDING | SUCCESS | FAILURE | ERROR | EXPECTED
}

// Parse a PR reference out of a hint value: `owner/repo#123` or a GitHub PR URL. Undefined when neither
// shape matches (e.g. an actions-run URL with no PR number) → that hint is simply not actionable.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/
export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}
function refKey(r: PrRef): string {
  return `${r.owner}/${r.repo}#${r.number}`
}

// Reduce a statusCheckRollup to a terminal verdict. `done` = every check has reached a terminal state
// (nothing queued/in-progress/pending); `ok` = none concluded in failure. An EMPTY rollup is treated
// as still-pending (no checks reported yet) so a `ci:` wait never fires before any check exists.
export function evalRollup(rollup: RollupEntry[]): { done: boolean; ok: boolean } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { done: false, ok: false }
  let pending = false
  let failed = false
  for (const c of rollup) {
    if (!c || typeof c !== "object") continue
    const status = typeof c.status === "string" ? c.status : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    // An entry is terminal ONLY if it AFFIRMATIVELY says so: a CheckRun with status COMPLETED, or a
    // StatusContext whose state is a settled value. An entry we can't classify (no recognizable
    // status/state — a `{}` or a future/unknown shape) is treated as still-PENDING, never as
    // done+green — so a shape surprise can never launder a `ci:` wait into a false "green" fire.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) pending = true
    const bad =
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED" ||
      conclusion === "ACTION_REQUIRED" ||
      conclusion === "STARTUP_FAILURE" ||
      state === "FAILURE" ||
      state === "ERROR"
    if (bad) failed = true
  }
  return { done: !pending, ok: !failed }
}

// Is a hint one this scheduler can act on? timer with a parseable ISO instant; pr/ci with a parseable
// PR reference. `session:` waits are NOT resolved here (no cross-session liveness signal to key off) —
// they fall through untouched, so a `session:` awaiting fence still parks the thread quietly.
function isActionable(hint: FenceView["hints"][number]): boolean {
  if (hint.kind === "timer") return Number.isFinite(Date.parse(hint.value))
  if (hint.kind === "pr" || hint.kind === "ci") return parsePrRef(hint.value) !== undefined
  return false
}

// A stable identity for the CURRENT awaiting rest of a thread: the sorted set of its actionable hints.
// A different set (the agent re-awaits something new) is a fresh arming cycle; the same set across ticks
// (and across a restart — hints are derived deterministically from the JSONL) is the same wait.
function fenceIdentity(hints: FenceView["hints"]): string {
  return hints
    .filter(isActionable)
    .map((h) => `${h.kind}:${h.value}`)
    .sort()
    .join("|")
}

// A single hint's verdict this tick: met? + the steer to send when it fires. `undefined` = indeterminate
// (a PR fetch we couldn't complete) → neither arm nor fire; try again next poll.
interface Verdict {
  met: boolean
  steer: string
  reason: string
}
function evalHint(hint: FenceView["hints"][number], nowMs: number, prCache: Map<string, PrStatus>, fenceBody: string): Verdict | undefined {
  if (hint.kind === "timer") {
    const target = Date.parse(hint.value)
    if (!Number.isFinite(target)) return undefined
    const desc = fenceBody.trim().replace(/\s+/g, " ").slice(0, 200)
    return { met: nowMs >= target, steer: `⏰ Your timer fired${desc ? `: ${desc}` : ""}. Continue.`, reason: `timer ${hint.value}` }
  }
  const ref = parsePrRef(hint.value)
  if (!ref) return undefined
  const s = prCache.get(refKey(ref))
  if (!s) return undefined // no PR data this window (fetch failed / not yet polled) → indeterminate
  if (hint.kind === "pr") {
    const merged = !!s.mergedAt || s.state === "MERGED"
    const closed = s.state === "CLOSED"
    const steer = merged
      ? `✅ PR ${refKey(ref)} merged. Continue.`
      : `ℹ️ PR ${refKey(ref)} was closed without merging. Continue.`
    return { met: merged || closed, steer, reason: `pr ${refKey(ref)} ${s.state}` }
  }
  // ci
  const { done, ok } = evalRollup(s.rollup)
  const steer = ok ? `✅ CI is green on ${refKey(ref)}. Continue.` : `❌ CI failed on ${refKey(ref)}. Continue.`
  return { met: done, steer, reason: `ci ${refKey(ref)} ${done ? (ok ? "green" : "failed") : "pending"}` }
}

// Default gh-backed PR fetcher. Uses the USER'S `gh` (their auth) via execFile — NO shell. Any failure
// (gh missing → ENOENT, not authed / rate-limited → nonzero exit, malformed JSON) resolves to undefined
// so the tick logs + skips and NEVER crashes. Timeout-bounded so a hung gh can't wedge the scheduler.
async function defaultFetchPr(ref: PrRef): Promise<PrStatus | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", refKey(ref), "--json", "state,mergedAt,statusCheckRollup"],
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const j = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown }
    // A SHAPE SURPRISE (valid JSON, but no string `state`) is INDETERMINATE, not "OPEN with no
    // checks" — returning a fabricated `{state:"", rollup:[]}` would read as UNMET and ARM the hint,
    // so a later accurate read could then fire an already-merged PR. Undefined = try again next poll.
    if (typeof j.state !== "string" || !j.state) return undefined
    return {
      state: j.state,
      mergedAt: typeof j.mergedAt === "string" ? j.mergedAt : null,
      rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as RollupEntry[]) : [],
    }
  } catch {
    return undefined
  }
}

// Per-thread arming state for the CURRENT awaiting rest (reset when the fence identity changes/clears).
interface ThreadWake {
  fenceId: string
  armed: Map<string, boolean> // hintKey → have we witnessed it UNMET at least once?
  fired: boolean // resumed for this rest already (awaiting the superseding turn)
  lastPollAt: number // last gh poll for this thread's pr/ci hints (throttle)
  prCache: Map<string, PrStatus> // last-known PR statuses, keyed by refKey (kept between polls)
}

const FIRED_CAP = 500 // defensive cap on the persisted fired-marker set

export interface SchedulerDeps {
  storage: Storage
  tailer: Tailer
  // Resume/steer a thread (prod: the shared resumeThread; tests: a spy). May throw — the tick catches.
  resume: (slug: string, message: string) => void
  now?: () => number
  fetchPr?: (ref: PrRef) => Promise<PrStatus | undefined>
  log?: (msg: string) => void
  tickMs?: number // how often to check (timers resolve at this cadence)
  pollMs?: number // minimum spacing between gh polls for a given thread's pr/ci hints
}

export interface Scheduler {
  start(): void
  stop(): void
  tick(): Promise<void> // exposed for tests + boot
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  const fetchPr = deps.fetchPr ?? defaultFetchPr
  const log = deps.log ?? ((m: string) => console.log(`[fray-ui] ${m}`))
  const tickMs = deps.tickMs ?? 10_000
  const pollMs = deps.pollMs ?? 60_000

  const threads = new Map<string, ThreadWake>() // slug → arming state
  // Persisted single-fire markers, key = `${slug}\u0000${fenceId}`. Loaded from ui.db so a resume
  // stays single-fire across a restart; pruned when the fence clears/changes.
  const fired = new Set<string>(loadFired())
  let timer: NodeJS.Timeout | null = null
  let running = false // guard against overlapping async ticks (a slow gh poll)

  function loadFired(): string[] {
    const raw = deps.storage.getSetting("waker.fired")
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
  }
  function saveFired(): void {
    deps.storage.setSetting("waker.fired", [...fired].slice(-FIRED_CAP))
  }
  function rememberFired(key: string): void {
    fired.add(key)
    saveFired()
  }
  function forgetFired(key: string): void {
    if (fired.delete(key)) saveFired()
  }
  // NUL-delimited so no slug/fenceId content can forge a different pair's key (slugs match a
  // space-free regex and actionable hint values carry no NUL, so this is collision-proof).
  const firedKey = (slug: string, fenceId: string) => `${slug}\u0000${fenceId}`

  async function evalThread(slug: string, fence: FenceView, nowMs: number): Promise<void> {
    const actionable = fence.hints.filter(isActionable)
    if (actionable.length === 0) {
      threads.delete(slug)
      return
    }
    const fenceId = fenceIdentity(fence.hints)
    let st = threads.get(slug)
    if (!st || st.fenceId !== fenceId) {
      // A new/changed awaiting rest: drop the previous rest's persisted marker + arming, start fresh.
      if (st) forgetFired(firedKey(slug, st.fenceId))
      st = { fenceId, armed: new Map(), fired: false, lastPollAt: 0, prCache: new Map() }
      threads.set(slug, st)
    }
    const persistKey = firedKey(slug, fenceId)
    if (fired.has(persistKey)) st.fired = true
    if (st.fired) return // already resumed for this rest — wait for the agent's turn to supersede the fence

    // Refresh PR statuses on the slow cadence (one fetch per distinct ref, shared by pr+ci hints).
    const needsPr = actionable.some((h) => h.kind === "pr" || h.kind === "ci")
    if (needsPr && (st.lastPollAt === 0 || nowMs - st.lastPollAt >= pollMs)) {
      st.lastPollAt = nowMs
      const refs = new Map<string, PrRef>()
      for (const h of actionable) {
        if (h.kind !== "pr" && h.kind !== "ci") continue
        const ref = parsePrRef(h.value)
        if (ref) refs.set(refKey(ref), ref)
      }
      for (const [k, ref] of refs) {
        try {
          const s = await fetchPr(ref)
          if (s) st.prCache.set(k, s) // keep the last-known status on a transient failure
          else log(`waker: gh check skipped for ${k} (${slug}) — gh unavailable / not authed / rate-limited`)
        } catch (err) {
          log(`waker: gh check errored for ${k} (${slug}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    for (const h of actionable) {
      const key = `${h.kind}:${h.value}`
      const verdict = evalHint(h, nowMs, st.prCache, fence.body)
      if (!verdict) continue // indeterminate this tick
      if (!verdict.met) {
        st.armed.set(key, true) // WITNESSED unmet → this hint is now eligible to fire on a later met
        continue
      }
      // met — fire ONLY if we previously witnessed it unmet (the boot-mass-fire guard). An already-met
      // condition at first sight was never armed → we never fire it.
      if (!st.armed.get(key)) continue
      st.fired = true
      rememberFired(persistKey)
      log(`waker: resuming ${slug} — ${verdict.reason}`)
      try {
        deps.resume(slug, verdict.steer)
      } catch (err) {
        // Keep `fired` set so a resume failure doesn't retry-loop; the human still sees the parked thread.
        log(`waker: resume FAILED for ${slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
      return // one resume per thread per rest
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const nowMs = now()
      const seen = new Set<string>()
      for (const row of deps.storage.allSessions()) {
        if (row.state === "archived" || row.archived === 1) continue // non-archived only
        const tele = deps.tailer.get(row.slug)
        if (!tele || tele.turn !== "idle") continue // only a thread genuinely AT REST is a waker candidate
        const fence = tele.lastFence
        if (!fence || fence.kind !== "awaiting" || !fence.hints.some(isActionable)) continue
        seen.add(row.slug)
        try {
          await evalThread(row.slug, fence, nowMs)
        } catch (err) {
          log(`waker: tick error for ${row.slug}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // The awaiting fence vanished (superseded, archived, or no longer at rest): forget its arming +
      // persisted marker so a future re-await arms fresh and can fire again.
      for (const [slug, st] of [...threads]) {
        if (!seen.has(slug)) {
          forgetFired(firedKey(slug, st.fenceId))
          threads.delete(slug)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      void tick() // derive current state immediately (arms live waits; boot-safe — never fires on first sight)
      timer = setInterval(() => void tick(), tickMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}
