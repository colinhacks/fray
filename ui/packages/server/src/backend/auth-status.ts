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

// The per-provider auth snapshot the new-thread gate reads. Never throws — each provider degrades to
// "unknown" independently, and the gate fails open on "unknown".
export async function readAuthSnapshot(): Promise<AuthSnapshot> {
  const [claude, codex] = await Promise.all([
    readClaudeAuthState().catch((): ProviderAuth => "unknown"),
    Promise.resolve().then(() => readCodexAuthState()).catch((): ProviderAuth => "unknown"),
  ])
  return { claude, codex }
}
