import { join } from "node:path"
import { homedir, platform } from "node:os"
import { readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AuthSnapshot, ProviderAuth } from "@fray-ui/shared"
import { tokenFromCredentialsJson } from "./claude-quota.ts"
import { defaultCodexHome } from "./codex.ts"

const execFileAsync = promisify(execFile)

// Whether a provider's LOCAL credential exists — the signal the new-thread gate keys on. Deliberately
// distinct from quota's `status: "unavailable"`, which is OVERLOADED (it also fires on a flaky usage
// endpoint or a 5s timeout). Blocking a dispatch must never turn on a network blip, so this reader
// reports credential PRESENCE only, and separates a positive "no credential" ("signed-out") from an
// "I couldn't tell" ("unknown"). The gate blocks on "signed-out" and FAILS OPEN on "unknown".

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Classify the on-disk ~/.claude/.credentials.json into a credential state. "token" = a usable OAuth
// token is present; "absent" = the file simply isn't there (expected on a Keychain-backed macOS
// install, where the credential lives in the login Keychain instead); "empty" = the file exists but
// carries no token; "error" = it exists but couldn't be read/parsed (→ we can't tell).
type CredState = "token" | "absent" | "empty" | "error"
function claudeFileState(configDir: string): CredState {
  let raw: string
  try {
    raw = readFileSync(join(configDir, ".credentials.json"), "utf8")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "error"
  }
  return tokenFromCredentialsJson(raw) ? "token" : "empty"
}

// Classify the macOS login Keychain entry ("Claude Code-credentials"). darwin-only; on any other
// platform the Keychain isn't a source, so callers treat it as "absent". `security` exits non-zero
// with a distinctive "could not be found" message when the item genuinely doesn't exist — that's a
// clean "absent"; any other failure is "error" (→ unknown, fail open).
async function claudeKeychainState(): Promise<CredState> {
  // DEV/QA seam: on a Keychain-backed macOS install, pointing CLAUDE_CONFIG_DIR at an empty dir does
  // NOT simulate signed-out because the Keychain still holds the real token. FRAY_KEYCHAIN_DISABLED
  // forces the Keychain source to read as absent so the signed-out gate can be exercised locally. Never
  // honored in a production build, so it can't weaken real auth detection in a deploy.
  if (process.env.FRAY_KEYCHAIN_DISABLED && process.env.NODE_ENV !== "production") return "absent"
  if (platform() !== "darwin") return "absent"
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 4000,
    })
    return tokenFromCredentialsJson(String(stdout).trim()) ? "token" : "empty"
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string }
    const notFound = e.code === 44 || (typeof e.stderr === "string" && /could not be found/i.test(e.stderr))
    return notFound ? "absent" : "error"
  }
}

// The Claude credential state, resolved in the order Claude Code itself resolves it: the on-disk file
// first, then the macOS Keychain. A token from EITHER source ⇒ authed. When neither yields a token, we
// distinguish a clean "no credential anywhere" (signed-out) from a source that errored (unknown).
export async function readClaudeAuthState(configDir = claudeConfigDir()): Promise<ProviderAuth> {
  const file = claudeFileState(configDir)
  if (file === "token") return "authed"
  const keychain = await claudeKeychainState()
  if (keychain === "token") return "authed"
  if (file === "error" || keychain === "error") return "unknown"
  // Both sources cleanly reported absent/empty → genuinely signed out.
  return "signed-out"
}

// The Codex credential state, from $CODEX_HOME/auth.json (default ~/.codex/auth.json). Codex stores
// either an API key (OPENAI_API_KEY) or a ChatGPT-plan OAuth blob (tokens.access_token); either one
// present ⇒ authed. Missing file ⇒ signed-out; present-but-unreadable/unparseable ⇒ unknown (fail open).
export function readCodexAuthState(codexHome = defaultCodexHome()): ProviderAuth {
  // Codex ALSO authenticates from the environment — fray forwards OPENAI_API_KEY / CODEX_API_KEY /
  // CODEX_ACCESS_TOKEN into the spawned app-server (CODEX_APP_SERVER_ENV_KEYS in codex-app-server.ts).
  // A user authed that way has NO auth.json, so checking the file alone would falsely block them with
  // no way to recover (the "codex login" the modal suggests isn't how they authed). Honor those keys
  // first, matching the exact set fray forwards.
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) return "authed"
  let raw: string
  try {
    raw = readFileSync(join(codexHome, "auth.json"), "utf8")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "signed-out" : "unknown"
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return "unknown"
  }
  if (!doc || typeof doc !== "object") return "unknown"
  const root = doc as Record<string, unknown>
  const apiKey = typeof root.OPENAI_API_KEY === "string" && root.OPENAI_API_KEY ? root.OPENAI_API_KEY : undefined
  const tokens = root.tokens && typeof root.tokens === "object" ? (root.tokens as Record<string, unknown>) : undefined
  const accessToken = tokens && typeof tokens.access_token === "string" && tokens.access_token ? tokens.access_token : undefined
  return apiKey || accessToken ? "authed" : "signed-out"
}

// Dispatch preflight rejection: the server refuses to create ANY thread state (scratchpad, tmux
// session, registry row) for a provider that is positively signed out. The message is a stable
// sentinel the web client parses to open the sign-in modal instead of a generic failure toast.
export class ProviderAuthRequiredError extends Error {
  readonly backend: "claude" | "codex"
  constructor(backend: "claude" | "codex") {
    super(`AUTH_REQUIRED:${backend}`)
    this.name = "ProviderAuthRequiredError"
    this.backend = backend
  }
}

// Parse `claude auth status --json` stdout into a tri-state. Positive-signal only: a definite
// `loggedIn: false` in the JSON is the ONLY thing that reads as signed-out; anything unparseable is
// undefined (→ unknown upstream, fail open). The CLI may print human noise around the JSON, so scan
// for the outermost object rather than trusting the whole stream to be JSON.
export function parseClaudeAuthStatusJson(stdout: string): boolean | undefined {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    const doc = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    return typeof doc.loggedIn === "boolean" ? doc.loggedIn : undefined
  } catch {
    return undefined
  }
}

// The dispatch-preflight Claude signal: `claude auth status --json` run with the worker's own
// executable in the project cwd (maintainer call: the auth-status CLI is the right detection signal
// for Claude). Exit 0 ⇒ the CLI considers the user logged in. A non-zero exit is only signed-out when
// the emitted JSON POSITIVELY says `loggedIn: false` — a missing binary, timeout, or unparseable
// output is "unknown" so the gate fails open. NOTE this is a presence check, not validity proof: an
// expired/revoked token still passes and is caught by the runtime 401 classifier.
export async function readClaudeAuthStatusCli(opts?: {
  claudeBin?: string
  cwd?: string
  timeoutMs?: number
}): Promise<ProviderAuth> {
  const bin = opts?.claudeBin ?? "claude"
  try {
    const { stdout } = await execFileAsync(bin, ["auth", "status", "--json"], {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 5000,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    })
    return parseClaudeAuthStatusJson(String(stdout)) === false ? "signed-out" : "authed"
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    const loggedIn = typeof stdout === "string" ? parseClaudeAuthStatusJson(stdout) : undefined
    if (loggedIn === false) return "signed-out"
    if (loggedIn === true) return "authed"
    return "unknown"
  }
}

// The per-provider auth snapshot the new-thread gate reads. Never throws — each provider degrades to
// "unknown" independently, and the gate fails open on "unknown".
export async function readAuthSnapshot(): Promise<AuthSnapshot> {
  const [claude, codex] = await Promise.all([
    readClaudeAuthState().catch((): ProviderAuth => "unknown"),
    Promise.resolve().then(() => readCodexAuthState()).catch((): ProviderAuth => "unknown"),
  ])
  return { claude, codex }
}
