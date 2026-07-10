import { execFileSync } from "node:child_process"
import { tmuxSessionName } from "@fray-ui/shared"

// All tmux goes through a PRIVATE socket `tmux -L <socket>` so fray's detached agent sessions
// never collide with (or show up in) the user's default tmux server. One session per thread,
// named fray-<slug>. `remain-on-exit on` keeps the pane after the command exits so we can read
// the exit state (pane_dead) instead of the session just vanishing.

// ---- Per-project socket -----------------------------------------------------------------------
// The socket name is PER-PROJECT, not the literal "fray": two fray-ui instances (e.g. :4917 nub and
// :4918 scratch) sharing one `tmux -L fray` server would collide on session NAMES (both spawn
// fray-<slug>), so one instance could attach/kill the other's agent. Deriving the socket from the
// stable project id isolates each instance's tmux server. Set ONCE at server init via setSocket(),
// before any tmux call; defaults to the bare "fray" until then (and for any caller that never inits).
let socket = "fray"

// Derive a per-project socket name from the stable project id (a UUID). First 8 alnum chars keep it
// short, readable, and collision-safe across the handful of instances a user runs; empty id → "fray".
export function deriveSocket(projectId: string | undefined | null): string {
  const short = (projectId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  return short ? `fray-${short}` : "fray"
}

// Install the active socket (call ONCE at server init, before any tmux call). Idempotent.
export function setSocket(name: string): void {
  socket = name || "fray"
}

// The active socket name — exported so the terminal PTY attach hits the SAME server as spawn().
export function socketName(): string {
  return socket
}

// stderr is ignored: has-session / list-panes on a gone session and start-server races all write
// EXPECTED diagnostics ("no server running", "can't find window") that callers already handle via
// the thrown exception — leaking them would spam the log now that the tailer polls liveness every 1s.
function tmux(...args: string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

// Idempotent: start-server is a no-op if the socket's server is already up.
export function ensureServer(): void {
  try {
    tmux("start-server")
  } catch {
    // already running / race — harmless
  }
  try {
    // Size windows to the MOST RECENT client, not the smallest: with the default, any second
    // attach (another browser tab, a screenshot run, a manual `tmux attach`) shrinks the pane for
    // every viewer and forces a full redraw — the embedded terminal visibly reflowed each time.
    tmux("set-option", "-g", "window-size", "latest")
  } catch {
    // best-effort; older tmux without the option just keeps default behavior
  }
}

export function hasSession(slug: string): boolean {
  try {
    tmux("has-session", "-t", tmuxSessionName(slug))
    return true
  } catch {
    return false
  }
}

export function listSessions(): string[] {
  try {
    return tmux("list-sessions", "-F", "#{session_name}").split("\n").map((s) => s.trim()).filter(Boolean)
  } catch {
    // no server / no sessions
    return []
  }
}

export function killSession(slug: string): void {
  try {
    tmux("kill-session", "-t", tmuxSessionName(slug))
  } catch {
    // already gone
  }
  invalidateLiveness()
}

// Spawn `cmd` (argv, run via execvp — NO shell) detached in a new session sized for the
// embedded xterm. `--` fences the command so a leading-dash arg is never eaten by tmux.
export function spawn(slug: string, cmd: string[], cwd: string, env?: Record<string, string>): void {
  const name = tmuxSessionName(slug)
  const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  try {
    // Capture stderr (not "ignore") so a failure yields tmux's OWN short reason. execFileSync's
    // thrown message is "Command failed: tmux … <entire argv, incl. the worker prompt>" — ~KBs — and
    // it flows straight to the user toast via the RPC error. We swallow that here: full diagnostics go
    // to the SERVER log only, and we rethrow a concise "worker spawn failed: <reason>" (see C2).
    execFileSync(
      "tmux",
      ["-L", socket, "new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", cwd, ...envFlags, "--", ...cmd],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err && (err as { stderr?: unknown }).stderr ? String((err as { stderr: unknown }).stderr).trim() : ""
    // Full detail (the giant "Command failed: …" message + tmux stderr) stays server-side.
    console.error(`[fray-ui] tmux spawn failed for session ${name} on socket ${socket}:`, err instanceof Error ? err.message : String(err), stderr ? `\n  tmux stderr: ${stderr}` : "")
    const reason = stderr.split("\n").find(Boolean)?.slice(0, 200) || "tmux new-session failed"
    throw new Error(`worker spawn failed: ${reason}`)
  }
  tmux("set-option", "-t", name, "remain-on-exit", "on")
  // The pane should look like pure claude, not tmux: no green status bar in the embedded xterm.
  tmux("set-option", "-t", name, "status", "off")
  invalidateLiveness() // the new session must be visible to cached liveness immediately
}

// Visible pane text (no history), for UI-state sniffing — e.g. detecting a pending permission
// prompt, which has no JSONL signal. Empty string if the session is gone.
export function capturePane(slug: string): string {
  try {
    return tmux("capture-pane", "-p", "-t", tmuxSessionName(slug))
  } catch {
    return ""
  }
}

// pane_pid of the (single) pane — the live child's pid, or null if the session is gone.
export function panePid(slug: string): number | null {
  try {
    const out = tmux("list-panes", "-t", tmuxSessionName(slug), "-F", "#{pane_pid}").trim()
    const pid = parseInt(out.split("\n")[0] ?? "", 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

// pane_dead is "1" once the command has exited (session still present thanks to
// remain-on-exit). A missing session reads as dead too.
export function paneDead(slug: string): boolean {
  try {
    const out = tmux("list-panes", "-t", tmuxSessionName(slug), "-F", "#{pane_dead}").trim()
    return (out.split("\n")[0] ?? "1") === "1"
  } catch {
    return true
  }
}

// Alive ⟺ the session exists AND its command has not exited.
export function isLive(slug: string): boolean {
  return hasSession(slug) && !paneDead(slug)
}

// ---- Batched liveness cache -------------------------------------------------------------------
// hasSession/paneDead are one subprocess EACH, and the hot paths ask per-thread: the board's
// deriveRuntime on every overlay refresh (16 threads × 2 calls) and the tailer's 1s tick (one per
// session row). Those sync execs stacked up and starved the event loop — RPC latency climbed to
// many seconds while any agent was streaming. One `list-panes -a` answers ALL sessions in a single
// subprocess; cache it briefly (below the tailer's poll period) so each tick pays for one exec.
const LIVENESS_TTL_MS = 900
let livenessAt = 0
let livenessMap = new Map<string, boolean>() // session name -> pane dead?

function deadMap(): Map<string, boolean> {
  const now = Date.now()
  if (now - livenessAt > LIVENESS_TTL_MS) {
    const map = new Map<string, boolean>()
    try {
      for (const line of tmux("list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}").split("\n")) {
        const [name, dead] = line.trim().split("\t")
        // A session is dead only if EVERY pane is dead (ours are single-pane anyway).
        if (name) map.set(name, (map.get(name) ?? true) && dead === "1")
      }
    } catch {
      // no tmux server → nothing live; the empty map reads as all-dead below
    }
    livenessMap = map
    livenessAt = now
  }
  return livenessMap
}

// Cached (≤900ms stale) equivalents for the hot paths. A session absent from the map is dead.
export function paneDeadCached(slug: string): boolean {
  return deadMap().get(tmuxSessionName(slug)) !== false
}

export function isLiveCached(slug: string): boolean {
  return deadMap().get(tmuxSessionName(slug)) === false
}

// Test seam / post-mutation freshness: drop the cache so the next read re-lists (spawn/kill call
// this so a just-created or just-killed session is visible immediately, not TTL-later).
export function invalidateLiveness(): void {
  livenessAt = 0
}

// Inject a single-line follow-up: send the text literally (-l, so no key interpretation),
// then a separate Enter. For multiline use pasteText.
export function sendKeys(slug: string, text: string): void {
  const name = tmuxSessionName(slug)
  tmux("send-keys", "-t", name, "-l", text)
  tmux("send-keys", "-t", name, "Enter")
}

// Multiline-safe injection: stage the text in a tmux paste-buffer (load-buffer from stdin,
// so newlines/quotes survive untouched), paste it, then Enter. -d deletes the buffer after.
export function pasteText(slug: string, text: string): void {
  const name = tmuxSessionName(slug)
  execFileSync("tmux", ["-L", socket, "load-buffer", "-"], { input: text })
  tmux("paste-buffer", "-t", name, "-d")
  tmux("send-keys", "-t", name, "Enter")
}
