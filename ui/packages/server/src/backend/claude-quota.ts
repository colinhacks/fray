import { join } from "node:path"
import { homedir, platform } from "node:os"
import { readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderQuota, QuotaWindow } from "@fray-ui/shared"

const execFileAsync = promisify(execFile)

// Read the Claude subscription quota (5-hour + 7-day windows) the way Claude Code's own `/usage`
// command does — there is NO on-disk source for remaining-window quota (the transcript records only
// per-message token usage; stats-cache.json is cumulative lifetime cost), so the only source is the
// OAuth usage endpoint:
//
//   GET https://api.anthropic.com/api/oauth/usage
//     Authorization: Bearer <oauth access token from ~/.claude/.credentials.json>
//     anthropic-beta: oauth-2025-04-20
//     User-Agent: claude-code/<version>      ← REQUIRED; without it the endpoint 429s aggressively
//
//   → { five_hour:{utilization 0..100, reset_at ISO}, seven_day:{…}, seven_day_opus, seven_day_sonnet }
//
// This endpoint is UNDOCUMENTED and unstable (no SLA, aggressive rate limiting), so this reader is
// defensive on every axis: it reads the credential only to authorize this one call, caches for 3+
// minutes, and degrades to a neutral "unavailable" on ANY error rather than throwing. It is invoked
// only from the quota RPC — never during board/tailer work.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA = "oauth-2025-04-20"
// The endpoint rate-limits callers without a claude-code User-Agent; a plausible recent version is
// enough (it gates by product, not exact version).
const USER_AGENT = "claude-code/2.0.0"
// Undocumented endpoint — cache generously so a 60s UI poll can't hammer it. 3 min is the community
// floor observed to avoid persistent 429s.
const TTL_MS = 3 * 60_000

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Pull the OAuth access token out of a Claude credentials blob. The shape has drifted across
// versions, so probe the known nests defensively; return undefined when absent.
export function tokenFromCredentialsJson(raw: string): string | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== "object") return undefined
  const root = doc as Record<string, unknown>
  const oauth = root.claudeAiOauth && typeof root.claudeAiOauth === "object" ? (root.claudeAiOauth as Record<string, unknown>) : root
  const token = oauth.accessToken ?? oauth.access_token
  return typeof token === "string" && token ? token : undefined
}

// macOS stores the Claude Code OAuth blob in the login Keychain (generic password
// "Claude Code-credentials"), NOT in ~/.claude/.credentials.json — that file simply does not exist on
// a Keychain-backed install. `security find-generic-password -w` prints the raw secret (the same JSON
// blob shape as the file). Defensive: darwin-only, short timeout, swallow any error → undefined. ASYNC
// on purpose: reading the Keychain can, in the worst case (an ACL prompt), block until the timeout —
// synchronous exec would freeze the whole server event loop for that window, so we never do that here.
async function readKeychainToken(): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 4000,
    })
    return tokenFromCredentialsJson(String(stdout).trim())
  } catch {
    return undefined
  }
}

// The OAuth access token, tried in the order Claude Code itself resolves it: the on-disk
// ~/.claude/.credentials.json first (Linux, and macOS installs that opted out of the Keychain), then
// the macOS login Keychain (the default on macOS, where the file is absent). Returns undefined
// (→ "unavailable") only when NEITHER source yields a token.
async function readAccessToken(configDir: string): Promise<string | undefined> {
  try {
    const fromFile = tokenFromCredentialsJson(readFileSync(join(configDir, ".credentials.json"), "utf8"))
    if (fromFile) return fromFile
  } catch {
    // Missing/unreadable file is expected on a Keychain-backed macOS install — fall through.
  }
  return readKeychainToken()
}

// Map one usage window from the endpoint (utilization 0..100, reset_at ISO) → a QuotaWindow.
function toWindow(raw: unknown, key: string, label: string): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const util = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined
  if (util === undefined) return undefined
  const resetIso = typeof w.reset_at === "string" ? w.reset_at : undefined
  const resetMs = resetIso ? Date.parse(resetIso) : NaN
  const resetsAt = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : undefined
  return { key, label, usedPercent: util, resetsAt }
}

// Parse the endpoint's JSON body → a ProviderQuota. Total: never throws. Exported for a fixture test.
// Surfaces the model-specific weekly caps (seven_day_opus / seven_day_sonnet) too: on a Max plan the
// Opus weekly cap is frequently the BINDING limit, so omitting it would let the chip show a rosy general
// weekly % while the user is actually near their Opus wall. The chip's "tightest window" then reflects it.
export function parseClaudeUsage(body: unknown, planType?: string): ProviderQuota {
  if (!body || typeof body !== "object") return { status: "unavailable", windows: [], detail: "Malformed usage response" }
  const b = body as Record<string, unknown>
  const windows = [
    toWindow(b.five_hour, "5h", "5h"),
    toWindow(b.seven_day, "weekly", "Weekly"),
    toWindow(b.seven_day_opus, "weekly-opus", "Opus wk"),
    toWindow(b.seven_day_sonnet, "weekly-sonnet", "Sonnet wk"),
  ].filter((x): x is QuotaWindow => x !== undefined)
  if (windows.length === 0) return { status: "unavailable", windows: [], detail: "No usage windows reported" }
  return { status: "ok", planType, windows }
}

const memo = new Map<string, { at: number; quota: ProviderQuota }>()

// The Claude provider quota (RPC-facing). Reads the OAuth token, calls the usage endpoint with the
// required headers, and degrades to "unavailable" on any error. Cached ≥3 min. Never throws.
export async function readClaudeQuota(configDir = claudeConfigDir()): Promise<ProviderQuota> {
  const now = Date.now()
  const hit = memo.get(configDir)
  if (hit && now - hit.at < TTL_MS) return hit.quota
  let quota: ProviderQuota
  try {
    const token = await readAccessToken(configDir)
    if (!token) {
      quota = { status: "unavailable", windows: [], detail: "Not logged in to Claude" }
    } else {
      // Hard 5s timeout: the endpoint is unstable/rate-limited, and readQuota awaits this alongside the
      // clean Codex read — an un-bounded stall would hold the whole quota RPC open (undici's default
      // header timeout is minutes). AbortSignal.timeout throws on fire → caught below → "unavailable".
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA,
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        quota = { status: "unavailable", windows: [], detail: `Usage endpoint ${res.status}` }
      } else {
        const body = (await res.json()) as Record<string, unknown>
        const planType = typeof body.plan_type === "string" ? body.plan_type : undefined
        quota = parseClaudeUsage(body, planType)
      }
    }
  } catch {
    quota = { status: "unavailable", windows: [], detail: "Usage endpoint unreachable" }
  }
  memo.set(configDir, { at: now, quota })
  return quota
}
