import { execFileSync } from "node:child_process"
import { isAbsolute, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { tmuxSessionName } from "@fray-ui/shared"
import {
  TMUX_MARKER_PROJECT_ID,
  TMUX_MARKER_PROJECT_ROOT,
  deriveLegacySocket,
  deriveSocket,
  tmuxProjectRootHash,
  validateTmuxSocketName,
} from "./tmux-socket.ts"

export { deriveLegacySocket, deriveProjectSocket, deriveSocket, deriveWorktreeSocket } from "./tmux-socket.ts"

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
let pinnedSocket: string | null = null
let socketMarker: { projectId: string; projectRootHash: string } | null = null

// Install the active socket (call ONCE at server init, before any tmux call). Idempotent.
export function setSocket(name: string): void {
  socket = name ? validateTmuxSocketName(name) : "fray"
  socketMarker = null
}

/** Production pins one pre-resolved migration choice before any tmux read or write. */
export function pinSocket(
  name: string,
  owner: { projectId: string; projectDir: string },
  managed = true,
): void {
  const selected = validateTmuxSocketName(name)
  const marker = managed
    ? { projectId: owner.projectId, projectRootHash: tmuxProjectRootHash(owner.projectDir) }
    : null
  if (pinnedSocket && (
    pinnedSocket !== selected || socketMarker?.projectId !== marker?.projectId ||
    socketMarker?.projectRootHash !== marker?.projectRootHash
  )) {
    throw new Error("tmux socket choice is already pinned for another project")
  }
  socket = selected
  pinnedSocket = selected
  socketMarker = marker
}

// The active socket name — exported so the terminal PTY attach hits the SAME server as spawn().
export function socketName(): string {
  return socket
}

export type CrossSocketOwner = "live" | "absent" | "unknown"

// A pre-project-socket Fray worker can be recovered without starting a duplicate only when its
// pane still proves both the project directory and the native provider conversation it belongs to.
// The full pane tuple is kept so the eventual paste is authorized by tmux itself, rather than by a
// racy name lookup.
export interface CompatibleLegacyWorker extends PaneIdentity {
  socket: string
}

export type CompatibleLegacyWorkerLookup =
  | { kind: "found"; worker: CompatibleLegacyWorker }
  | { kind: "absent" }
  | { kind: "unknown" }

// A legacy server may still be the literal `tmux -L fray`; the first project-scoped migration used
// the short UUID socket; current servers use the full project socket. Before reusing a dead local
// name, inspect all compatible locations. We intentionally do not contact the discovered process:
// a live matching pane is an ownership conflict, and uncertainty is also closed rather than spawning
// a second worker merely because the selected socket changed.
export function crossSocketLiveOwner(slug: string, project: { id: string; dir: string }): CrossSocketOwner {
  const candidates = [...new Set([socket, "fray", deriveLegacySocket(project.id), deriveSocket(project.id)])]
  const name = tmuxSessionName(slug)
  const belongs = (cwd: string) => {
    if (!isAbsolute(cwd)) return false
    const rel = relative(resolve(project.dir), resolve(cwd))
    return rel === "" || (rel !== ".." && !rel.startsWith("../"))
  }
  for (const candidate of candidates) {
    if (candidate === socket) continue // caller already proved this socket's slug dead
    try {
      const out = execFileSync("tmux", ["-L", candidate, "list-panes", "-t", name, "-F", "#{pane_dead}\t#{pane_current_path}"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim()
      if (!out) return "unknown"
      for (const line of out.split("\n")) {
        const [dead, cwd] = line.split("\t")
        if ((dead !== "0" && dead !== "1") || !cwd) return "unknown"
        // A same-name session outside this project is not ours, but it still makes a name-based
        // fallback unsafe. Treat it as unknown rather than guessing an owner.
        if (!belongs(cwd)) return "unknown"
        if (dead === "0") return "live"
      }
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "") : ""
      if (!/(?:no server running|can't find (?:session|window|pane)|no sessions|failed to connect|error connecting to .*\((?:no such file or directory|connection refused)\))/i.test(stderr)) return "unknown"
    }
  }
  return "absent"
}

function sessionCommandMatches(command: string, nativeSessionId: string): boolean {
  // Claude's historical launch forms used both --session-id and -r.  Match the exact argument
  // boundary, never a substring, so a similarly-prefixed conversation cannot be adopted.
  const escaped = nativeSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\s)(?:--session-id|-r)\\s+${escaped}(?=\\s|$)`).test(command)
}

function codexCommandMatches(command: string, sessionId: string): boolean {
  // Codex has NO --session-id flag: `codex resume [--cd cwd] … -s <sandbox> <rolloutId> [message]`
  // carries the rollout id as a bare positional.  Match it as an exact whitespace-bounded token — a
  // full codex rollout id is unique enough that this is as precise as Claude's flagged form — and
  // additionally require the `resume` subcommand so an id that merely appears inside a trailing prompt
  // message can never masquerade as the launch identity.
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return /(?:^|\s)resume(?:\s|$)/.test(command) && new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command)
}

// Identity match for a legacy pane's start command, per backend.  Codex and Claude pin the native
// conversation id in entirely different argv shapes; a wrong matcher silently degrades a live codex
// worker to "unknown", stranding every timer/CI wake (see crossSocketLiveOwner's terminal throw).
function commandMatchesIdentity(command: string, nativeSessionId: string, backend: string | undefined): boolean {
  return backend === "codex"
    ? codexCommandMatches(command, nativeSessionId)
    : sessionCommandMatches(command, nativeSessionId)
}

function compatibleLegacyCondition(worker: CompatibleLegacyWorker): string {
  return `#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{pane_id},${worker.paneId}},#{&&:#{==:#{pane_pid},${worker.panePid}},#{==:#{session_created},${worker.sessionCreated}}}}}`
}

/**
 * Find a legacy-socket worker that is conclusively this persisted provider conversation.  A live
 * same-name pane with a different/opaque command remains unsafe and is deliberately "unknown".
 */
export function findCompatibleLegacyWorker(
  slug: string,
  project: { id: string; dir: string },
  nativeSessionId: string,
  backend?: string,
): CompatibleLegacyWorkerLookup {
  // Cover EVERY socket crossSocketLiveOwner can flag as live, minus the caller-proved-dead active one
  // (skipped below).  Historically this list omitted deriveSocket(project.id) on the assumption it always
  // equals the active socket — but when the runtime boots on a different socket (a FRAY_TMUX_SOCKET
  // override, a linked-worktree socket, or a cross-version derivation change) a live worker stranded on
  // the full project socket was DETECTED as live yet never reachable here, so every wake threw
  // "A live matching worker exists …" and retried to silent exhaustion.  Scanning it closes that gap.
  const candidates = [...new Set(["fray", deriveLegacySocket(project.id), deriveSocket(project.id)])]
  const name = tmuxSessionName(slug)
  const belongs = (cwd: string) => {
    if (!isAbsolute(cwd)) return false
    const rel = relative(resolve(project.dir), resolve(cwd))
    return rel === "" || (rel !== ".." && !rel.startsWith("../"))
  }
  let found: CompatibleLegacyWorker | undefined
  for (const candidate of candidates) {
    if (candidate === socket) continue
    try {
      const out = execFileSync("tmux", ["-L", candidate, "list-panes", "-t", name,
        "-F", "#{pane_dead}\t#{pane_id}\t#{pane_pid}\t#{session_created}\t#{pane_current_path}\t#{pane_start_command}"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim()
      if (!out) return { kind: "unknown" }
      // pane_start_command is arbitrary user text and can itself contain literal newlines.  The
      // identifying fields precede it on the first record; treating its continuation as another
      // pane would turn every multiline worker prompt into a false ambiguity.
      const [dead, paneId, pidRaw, createdRaw, cwd, command] = out.split("\n", 1)[0]!.split("\t")
      const identity = parsePaneIdentity(`${paneId}\t${pidRaw}\t${createdRaw}`)
      if ((dead !== "0" && dead !== "1") || !identity || !cwd || command === undefined) return { kind: "unknown" }
      if (!belongs(cwd)) return { kind: "unknown" }
      if (dead === "1") continue
      if (!commandMatchesIdentity(command, nativeSessionId, backend)) return { kind: "unknown" }
      const worker = { socket: candidate, ...identity }
      if (found) return { kind: "unknown" } // more than one exact claimant is still ambiguous
      found = worker
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "") : ""
      if (!/(?:no server running|can't find (?:session|window|pane)|no sessions|failed to connect|error connecting to .*\((?:no such file or directory|connection refused)\))/i.test(stderr)) return { kind: "unknown" }
    }
  }
  return found ? { kind: "found", worker: found } : { kind: "absent" }
}

// Capture and submit use a single server-side condition over the immutable pane tuple.  If the
// command returns an error after tmux accepted it, callers must treat delivery as ambiguous and
// never replay it.
export function captureCompatibleLegacyWorker(worker: CompatibleLegacyWorker, escaped = false): ExactPaneCapture {
  try {
    const out = execFileSync("tmux", ["-L", worker.socket, "if-shell", "-t", worker.paneId, "-F", compatibleLegacyCondition(worker),
      `display-message -p ${EXACT_ACTION_OK} ; capture-pane -p${escaped ? " -e" : ""} -t ${worker.paneId}`,
      `display-message -p ${EXACT_ACTION_MISS}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const prefix = `${EXACT_ACTION_OK}\n`
    return out.startsWith(prefix) ? { kind: "captured", text: out.slice(prefix.length) } : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

export function sendTextToCompatibleLegacyWorker(worker: CompatibleLegacyWorker, text: string): boolean {
  const buffer = `fray-legacy-${randomUUID()}`
  try {
    const out = execFileSync("tmux", ["-L", worker.socket,
      "load-buffer", "-b", buffer, "-", ";",
      "if-shell", "-t", worker.paneId, "-F", compatibleLegacyCondition(worker),
      `paste-buffer -b ${buffer} -t ${worker.paneId} ; send-keys -t ${worker.paneId} Enter ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`, ";", "delete-buffer", "-b", buffer],
    { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    return false
  }
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
  if (socketMarker) {
    try {
      tmux(
        "set-option", "-gq", TMUX_MARKER_PROJECT_ID, socketMarker.projectId,
        ";", "set-option", "-gq", TMUX_MARKER_PROJECT_ROOT, socketMarker.projectRootHash,
      )
    } catch {
      // A marker is also queued atomically with every new-session below. An empty server may exit
      // before this best-effort label; no worker can exist in that gap.
    }
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

export const ADOPTION_ATTEMPT_ENV = "FRAY_ADOPTION_ATTEMPT"
export const PROFILE_HANDOFF_ENV = "FRAY_PROFILE_HANDOFF"

export type TmuxSpawnStage =
  | "new-session"
  | "read-identity"
  | "record-identity"
  | "remain-on-exit"
  | "status"

export interface TmuxSpawnOptions {
  adoptionAttemptToken?: string
  // Called synchronously immediately after new-session returns its exact tuple and before either
  // setup command. Adoption uses this hook for the durable SQLite bind.
  onCreated?: (identity: PaneIdentity) => void
  // Narrow deterministic seam used by crash-window tests; production does not provide it.
  onStage?: (stage: "created" | "remain-on-exit" | "status", identity: PaneIdentity) => void
}

export class TmuxSpawnError extends Error {
  readonly stage: TmuxSpawnStage
  readonly identity?: PaneIdentity

  constructor(stage: TmuxSpawnStage, identity?: PaneIdentity) {
    super(stage === "new-session" ? "worker spawn failed" : "worker spawn setup failed")
    this.name = "TmuxSpawnError"
    this.stage = stage
    this.identity = identity
  }
}

export type TmuxSpawnRunner = (args: readonly string[]) => string

const runSpawnCommand: TmuxSpawnRunner = (args) => execFileSync(
  "tmux",
  [...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)

function validAdoptionAttemptToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
}

function parsePaneIdentity(raw: string): PaneIdentity | null {
  const [paneId, pidRaw, createdRaw] = raw.trim().split("\t")
  const panePid = Number.parseInt(pidRaw ?? "", 10)
  const sessionCreated = Number.parseInt(createdRaw ?? "", 10)
  if (!/^%\d+$/.test(paneId ?? "") || !Number.isSafeInteger(panePid) || !Number.isSafeInteger(sessionCreated)) {
    return null
  }
  return { paneId, panePid, sessionCreated }
}

// Kept separate from spawn() so deterministic tests can stop after any tmux command without touching
// a live server. The runner receives the complete argv, but failures never log the runner error: Node's
// exec error embeds that argv (including prompts and environment credentials).
export function spawnWithRunner(
  slug: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string> | undefined,
  options: TmuxSpawnOptions,
  runner: TmuxSpawnRunner,
): PaneIdentity {
  const name = tmuxSessionName(slug)
  if (options.adoptionAttemptToken && !validAdoptionAttemptToken(options.adoptionAttemptToken)) {
    throw new TmuxSpawnError("new-session")
  }
  const launchEnv = { ...(env ?? {}) }
  if (options.adoptionAttemptToken) launchEnv[ADOPTION_ATTEMPT_ENV] = options.adoptionAttemptToken
  const envFlags = Object.entries(launchEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  let stage: TmuxSpawnStage = "new-session"
  let identity: PaneIdentity | undefined
  try {
    const markerArgs = socketMarker ? [
      ";", "set-option", "-gq", TMUX_MARKER_PROJECT_ID, socketMarker.projectId,
      ";", "set-option", "-gq", TMUX_MARKER_PROJECT_ROOT, socketMarker.projectRootHash,
    ] : []
    const created = runner([
      "-L", socket, "new-session", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}\t#{session_created}",
      "-s", name, "-x", "220", "-y", "50", "-c", cwd, ...envFlags, "--", ...cmd,
      ...markerArgs,
    ])
    invalidateLiveness()
    stage = "read-identity"
    identity = parsePaneIdentity(created) ?? undefined
    if (!identity) throw new Error("missing tmux identity")
    stage = "record-identity"
    options.onCreated?.(identity)
    options.onStage?.("created", identity)

    stage = "remain-on-exit"
    runner(["-L", socket, "set-option", "-t", identity.paneId, "remain-on-exit", "on"])
    options.onStage?.("remain-on-exit", identity)

    stage = "status"
    runner(["-L", socket, "set-option", "-t", identity.paneId, "status", "off"])
    options.onStage?.("status", identity)
    invalidateLiveness()
    return identity
  } catch {
    // Intentionally exclude the original error, stderr, argv, cwd, and environment. Any one of them
    // can contain the full user prompt or credentials; stage + created-bit is enough to operate.
    console.error(`[fray-ui] tmux worker spawn failed (stage=${stage}, created=${identity ? "yes" : "no"})`)
    throw new TmuxSpawnError(stage, identity)
  }
}

// Spawn `cmd` (argv, run via execvp — NO shell) detached in a new session sized for the
// embedded xterm. `--` fences the command so a leading-dash arg is never eaten by tmux.
export function spawn(
  slug: string,
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
  options: TmuxSpawnOptions = {},
): PaneIdentity {
  return spawnWithRunner(slug, cmd, cwd, env, options, runSpawnCommand)
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

// Same pane with SGR escapes preserved. The live-permission controller uses Codex's dim placeholder
// style to distinguish an empty composer from human-typed text before injecting a slash command.
export function capturePaneEscaped(slug: string): string {
  try {
    return tmux("capture-pane", "-p", "-e", "-t", tmuxSessionName(slug))
  } catch {
    return ""
  }
}

export interface PaneIdentity {
  paneId: string
  panePid: number
  sessionCreated: number
}

export interface PaneSnapshot extends PaneIdentity {
  dead: boolean
  adoptionAttemptToken: string | null
  profileHandoffToken?: string | null
}

export type AdoptionPaneLookup =
  | { kind: "found"; pane: PaneSnapshot }
  | { kind: "absent" }
  | { kind: "unknown" }

export interface ExpectedAdoptionPane {
  attempt_token: string
  pane_id: string | null
  pane_pid: number | null
  session_created: number | null
}

export interface ExpectedProfileHandoffPane extends PaneIdentity {
  handoffToken: string
}

const PANE_SNAPSHOT_FORMAT = `#{session_name}\t#{pane_dead}\t#{pane_id}\t#{pane_pid}\t#{session_created}\t#{E:${ADOPTION_ATTEMPT_ENV}}\t#{E:${PROFILE_HANDOFF_ENV}}`

function parsePaneSnapshot(line: string): { name: string; pane: PaneSnapshot } | null {
  const [name, deadRaw, paneId, pidRaw, createdRaw, tokenRaw = "", profileTokenRaw = ""] = line.trim().split("\t")
  const identity = parsePaneIdentity(`${paneId}\t${pidRaw}\t${createdRaw}`)
  if (!name || !identity || (deadRaw !== "0" && deadRaw !== "1")) return null
  return {
    name,
    pane: {
      ...identity,
      dead: deadRaw === "1",
      adoptionAttemptToken: validAdoptionAttemptToken(tokenRaw) ? tokenRaw : null,
      profileHandoffToken: validAdoptionAttemptToken(profileTokenRaw) ? profileTokenRaw : null,
    },
  }
}

function expectedProfileHandoffCondition(expected: ExpectedProfileHandoffPane, requireLive = true): string | null {
  if (!validAdoptionAttemptToken(expected.handoffToken) || !/^%\d+$/.test(expected.paneId) ||
      !Number.isSafeInteger(expected.panePid) || !Number.isSafeInteger(expected.sessionCreated)) return null
  const owner = `#{&&:#{==:#{pane_id},${expected.paneId}},#{&&:#{==:#{pane_pid},${expected.panePid}},#{&&:#{==:#{session_created},${expected.sessionCreated}},#{==:#{E:${PROFILE_HANDOFF_ENV}},${expected.handoffToken}}}}}`
  return requireLive ? `#{&&:#{==:#{pane_dead},0},${owner}}` : owner
}

function sameExpectedPane(expected: ExpectedAdoptionPane, pane: PaneSnapshot): boolean {
  return (
    expected.pane_id !== null &&
    expected.pane_pid !== null &&
    expected.session_created !== null &&
    pane.adoptionAttemptToken === expected.attempt_token &&
    pane.paneId === expected.pane_id &&
    pane.panePid === expected.pane_pid &&
    pane.sessionCreated === expected.session_created
  )
}

function expectedAdoptionCondition(expected: ExpectedAdoptionPane, requireLive = true): string | null {
  if (
    !validAdoptionAttemptToken(expected.attempt_token) ||
    expected.pane_id === null ||
    !/^%\d+$/.test(expected.pane_id) ||
    expected.pane_pid === null ||
    !Number.isSafeInteger(expected.pane_pid) ||
    expected.session_created === null ||
    !Number.isSafeInteger(expected.session_created)
  ) {
    return null
  }
  const owner = `#{&&:#{==:#{pane_id},${expected.pane_id}},#{&&:#{==:#{pane_pid},${expected.pane_pid}},#{&&:#{==:#{session_created},${expected.session_created}},#{==:#{E:${ADOPTION_ATTEMPT_ENV}},${expected.attempt_token}}}}}`
  return requireLive ? `#{&&:#{==:#{pane_dead},0},${owner}}` : owner
}

function expectedPaneIdentityCondition(expected: PaneIdentity, requireLive = true): string | null {
  if (!/^%\d+$/.test(expected.paneId) ||
      !Number.isSafeInteger(expected.panePid) ||
      !Number.isSafeInteger(expected.sessionCreated)) return null
  const owner = `#{&&:#{==:#{pane_id},${expected.paneId}},#{&&:#{==:#{pane_pid},${expected.panePid}},#{==:#{session_created},${expected.sessionCreated}}}}`
  return requireLive ? `#{&&:#{==:#{pane_dead},0},${owner}}` : owner
}

const EXACT_ACTION_OK = "FRAY_EXACT_ACTION_OK_9A74D2"
const EXACT_ACTION_MISS = "FRAY_EXACT_ACTION_MISS_9A74D2"
const INPUT_SETTLE_COMMAND = "/bin/sleep 0.25"

// Codex can read a pasted block and an immediately adjacent key as one input burst, leaving the
// text in its composer even though tmux accepted both commands. A blocking run-shell remains part
// of this one tmux server queue but gives the TUI one event-loop boundary to finish the paste. The
// immutable pane condition is checked before the paste and again before the delayed key, so a pane
// replacement during that boundary cannot receive either half under a reused name/id.
function sendTextWithKeyToPane(
  socketName: string,
  paneId: string,
  condition: string,
  bufferPrefix: string,
  text: string,
  key: "Enter" | "Tab",
): boolean {
  const buffer = `${bufferPrefix}-${randomUUID()}`
  const complete = `send-keys -t ${paneId} ${key} ; display-message -p ${EXACT_ACTION_OK}`
  const afterSettle = `if-shell -t ${paneId} -F '${condition}' '${complete}' 'display-message -p ${EXACT_ACTION_MISS}'`
  const authorized = `paste-buffer -b ${buffer} -t ${paneId} ; run-shell '${INPUT_SETTLE_COMMAND}' ; ${afterSettle}`
  try {
    const out = execFileSync("tmux", [
      "-L", socketName,
      "load-buffer", "-b", buffer, "-",
      ";",
      "if-shell", "-t", paneId, "-F", condition,
      authorized,
      `display-message -p ${EXACT_ACTION_MISS}`,
      ";",
      "delete-buffer", "-b", buffer,
    ], {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    return false
  }
}

function exactPaneAction(expected: ExpectedAdoptionPane, command: string, onMiss = ""): boolean {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return false
  try {
    const out = tmux(
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `${command} ; display-message -p ${EXACT_ACTION_OK}`,
      `${onMiss}${onMiss ? " ; " : ""}display-message -p ${EXACT_ACTION_MISS}`,
    )
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    return false
  }
}

export type ExactPaneCapture =
  | { kind: "captured"; text: string }
  | { kind: "unavailable" }

// Check token + full tuple and capture in one tmux server command. A pane replacement cannot slip
// between authorization and capture, and a renamed exact owner remains addressable by pane id.
export function captureExpectedAdoptionPane(
  expected: ExpectedAdoptionPane,
  escaped = false,
): ExactPaneCapture {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return { kind: "unavailable" }
  try {
    const out = tmux(
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `display-message -p ${EXACT_ACTION_OK} ; capture-pane -p${escaped ? " -e" : ""} -t ${expected.pane_id}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    const prefix = `${EXACT_ACTION_OK}\n`
    return out.startsWith(prefix)
      ? { kind: "captured", text: out.slice(prefix.length) }
      : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

// The literal payload stays on stdin and the entire buffer lifecycle is one tmux client command
// queue: load, token+tuple authorization, paste/send, unconditional delete. There is no process-
// visible staging interval in which Fray can be killed while a secret-bearing tmux buffer remains.
export function sendTextToExpectedAdoptionPane(
  expected: ExpectedAdoptionPane,
  text: string,
  submit: boolean,
): boolean {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return false
  const buffer = `fray-exact-${randomUUID()}`
  try {
    const out = execFileSync("tmux", [
      "-L", socket,
      "load-buffer", "-b", buffer, "-",
      ";",
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `paste-buffer -b ${buffer} -t ${expected.pane_id}${submit ? ` ; send-keys -t ${expected.pane_id} Enter` : ""} ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
      ";",
      "delete-buffer", "-b", buffer,
    ], {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    // A single tmux client submitted the complete server-side queue. Never retry an ambiguous paste:
    // the server either rejected it before authorization or finishes the queued cleanup itself.
    return false
  }
}

export function sendTextWithKeyToExpectedAdoptionPane(
  expected: ExpectedAdoptionPane,
  text: string,
  key: "Enter" | "Tab",
): boolean {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return false
  return sendTextWithKeyToPane(socket, expected.pane_id, condition, "fray-exact", text, key)
}

export function sendKeyToExpectedAdoptionPane(
  expected: ExpectedAdoptionPane,
  key: "Enter" | "Tab" | "Up" | "Down" | "Escape",
): boolean {
  if (expected.pane_id === null) return false
  return exactPaneAction(expected, `send-keys -t ${expected.pane_id} ${key}`)
}

// The PTY runs this exact conditional itself. Unlike a canAttach preflight followed by
// `attach-session -t <slug>`, no reusable-name race exists; false authorization simply exits.
export function expectedAdoptionAttachArgs(expected: ExpectedAdoptionPane): string[] | null {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return null
  return [
    "if-shell", "-t", expected.pane_id, "-F", condition,
    `attach-session -t ${expected.pane_id}`,
    "",
  ]
}

// Tri-state lookup for destructive recovery. "unknown" is deliberately distinct from absence: a
// transient tmux error must retain the durable claim instead of authorizing artifact/ownership loss.
export function lookupAdoptionPane(slug: string): AdoptionPaneLookup {
  const name = tmuxSessionName(slug)
  try {
    const out = runSpawnCommand([
      "-L", socket, "list-panes", "-t", name, "-F", PANE_SNAPSHOT_FORMAT,
    ])
    const parsed = parsePaneSnapshot(out.split("\n")[0] ?? "")
    return parsed ? { kind: "found", pane: parsed.pane } : { kind: "unknown" }
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : ""
    if (/no server running|can't find (?:session|window|pane)|no sessions/i.test(stderr)) {
      return { kind: "absent" }
    }
    return { kind: "unknown" }
  }
}

// Find an orphan by its unguessable attempt token across the whole private tmux server. This is the
// recovery path for a process killed after new-session but before SQLite could record the returned
// tuple, and it remains correct even if an operator renamed the session before restart.
export function findAdoptionPane(attemptToken: string): AdoptionPaneLookup {
  return findAdoptionPanes([attemptToken]).get(attemptToken) ?? { kind: "unknown" }
}

// Profile handoffs tag every target/rollback spawn before tmux creates the pane. This closes the
// crash gap between new-session and SQLite's tuple checkpoint without borrowing a reusable slug.
export function findProfileHandoffPane(handoffToken: string): AdoptionPaneLookup {
  if (!validAdoptionAttemptToken(handoffToken)) return { kind: "unknown" }
  try {
    const matches = runSpawnCommand(["-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT])
      .split("\n")
      .map(parsePaneSnapshot)
      .filter((entry): entry is { name: string; pane: PaneSnapshot } => entry?.pane.profileHandoffToken === handoffToken)
    return matches.length === 1 ? { kind: "found", pane: matches[0].pane }
      : matches.length === 0 ? { kind: "absent" } : { kind: "unknown" }
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : ""
    return /no server running|no sessions/i.test(stderr) ? { kind: "absent" } : { kind: "unknown" }
  }
}

export function captureExpectedProfileHandoffPane(
  expected: ExpectedProfileHandoffPane,
  escaped = false,
): ExactPaneCapture {
  const condition = expectedProfileHandoffCondition(expected)
  if (!condition) return { kind: "unavailable" }
  try {
    const out = tmux(
      "if-shell", "-t", expected.paneId, "-F", condition,
      `display-message -p ${EXACT_ACTION_OK} ; capture-pane -p${escaped ? " -e" : ""} -t ${expected.paneId}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    const prefix = `${EXACT_ACTION_OK}\n`
    return out.startsWith(prefix) ? { kind: "captured", text: out.slice(prefix.length) } : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

export function killExpectedProfileHandoffPane(expected: ExpectedProfileHandoffPane): boolean {
  const condition = expectedProfileHandoffCondition(expected, false)
  if (!condition) return false
  try {
    const out = tmux(
      "if-shell", "-t", expected.paneId, "-F", condition,
      `kill-pane -t ${expected.paneId} ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    invalidateLiveness()
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    invalidateLiveness()
    return false
  }
}

// Inventory the private server once for any number of permanent retired tokens. Recovery calls this
// on a level-triggered timer, so historical attempts add only in-memory lookups to every sweep.
export function findAdoptionPanes(attemptTokens: readonly string[]): Map<string, AdoptionPaneLookup> {
  const result = new Map<string, AdoptionPaneLookup>()
  const valid = [...new Set(attemptTokens)].filter((token) => {
    if (validAdoptionAttemptToken(token)) return true
    result.set(token, { kind: "unknown" })
    return false
  })
  if (valid.length === 0) return result
  try {
    const wanted = new Set(valid)
    const grouped = new Map(valid.map((token) => [token, [] as PaneSnapshot[]]))
    const entries = runSpawnCommand([
      "-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT,
    ])
      .split("\n")
      .map(parsePaneSnapshot)
      .filter((entry): entry is { name: string; pane: PaneSnapshot } => Boolean(entry))
    for (const entry of entries) {
      const token = entry.pane.adoptionAttemptToken
      if (token && wanted.has(token)) grouped.get(token)!.push(entry.pane)
    }
    for (const token of valid) {
      const matches = grouped.get(token)!
      result.set(token, matches.length === 1
        ? { kind: "found", pane: matches[0] }
        : matches.length === 0 ? { kind: "absent" } : { kind: "unknown" })
    }
    return result
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : ""
    const lookup: AdoptionPaneLookup = /no server running|no sessions/i.test(stderr)
      ? { kind: "absent" }
      : { kind: "unknown" }
    for (const token of valid) result.set(token, lookup)
    return result
  }
}

export function findPaneIdentity(identity: PaneIdentity): AdoptionPaneLookup {
  if (!/^%\d+$/.test(identity.paneId) || !Number.isSafeInteger(identity.panePid) || !Number.isSafeInteger(identity.sessionCreated)) {
    return { kind: "unknown" }
  }
  try {
    const matches = runSpawnCommand([
      "-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT,
    ])
      .split("\n")
      .map(parsePaneSnapshot)
      .filter((entry): entry is { name: string; pane: PaneSnapshot } => Boolean(
        entry &&
        entry.pane.paneId === identity.paneId &&
        entry.pane.panePid === identity.panePid &&
        entry.pane.sessionCreated === identity.sessionCreated,
      ))
    return matches.length === 1 ? { kind: "found", pane: matches[0].pane } : matches.length === 0
      ? { kind: "absent" }
      : { kind: "unknown" }
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : ""
    if (/no server running|no sessions/i.test(stderr)) return { kind: "absent" }
    return { kind: "unknown" }
  }
}

// A finalized owner is absent only when BOTH independent durable locators are absent. This catches
// renamed sessions and token-preserving respawns without ever treating a reusable slug as proof.
export function findExpectedAdoptionPane(expected: ExpectedAdoptionPane): AdoptionPaneLookup {
  if (
    expected.pane_id === null ||
    expected.pane_pid === null ||
    expected.session_created === null
  ) {
    const tokenOnly = findAdoptionPane(expected.attempt_token)
    return tokenOnly.kind === "absent" ? { kind: "absent" } : { kind: "unknown" }
  }
  const identity = {
    paneId: expected.pane_id,
    panePid: expected.pane_pid,
    sessionCreated: expected.session_created,
  }
  const byToken = findAdoptionPane(expected.attempt_token)
  const byIdentity = findPaneIdentity(identity)
  if (
    byToken.kind === "found" &&
    byIdentity.kind === "found" &&
    sameExpectedPane(expected, byToken.pane) &&
    sameExpectedPane(expected, byIdentity.pane)
  ) {
    return { kind: "found", pane: byToken.pane }
  }
  if (byToken.kind === "absent" && byIdentity.kind === "absent") return { kind: "absent" }
  return { kind: "unknown" }
}

export function isExpectedAdoptionPane(expected: ExpectedAdoptionPane, pane: PaneSnapshot): boolean {
  return sameExpectedPane(expected, pane)
}

// Atomically authorize and kill using the unguessable attempt token plus the complete pane tuple.
// Dead remain-on-exit panes are valid teardown targets. Callers still verify global token+tuple
// absence after this action; false means no authorized target was touched.
export function killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean {
  const condition = expectedAdoptionCondition(expected, false)
  if (!condition || expected.pane_id === null) return false
  try {
    const out = tmux(
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `kill-pane -t ${expected.pane_id} ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    invalidateLiveness()
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    invalidateLiveness()
    return false
  }
}

// Kill the exact pane returned by new-session, never whichever process later happens to own a slug.
// Pane ids can be reused after a tmux-server restart, so validate the complete tuple and perform the
// conditional kill as one server-side command. There is deliberately no name-targeted fallback.
export function killPane(identity: PaneIdentity): void {
  if (!/^%\d+$/.test(identity.paneId) || !Number.isFinite(identity.panePid) || !Number.isFinite(identity.sessionCreated)) return
  try {
    const exactIdentity = `#{&&:#{==:#{pane_id},${identity.paneId}},#{&&:#{==:#{pane_pid},${identity.panePid}},#{==:#{session_created},${identity.sessionCreated}}}}`
    tmux("if-shell", "-t", identity.paneId, "-F", exactIdentity, `kill-pane -t ${identity.paneId}`, "")
  } catch {
    // The captured pane already exited/was replaced. Never fall back to a name-targeted kill.
  }
  invalidateLiveness()
}

// A PID alone is not a process-generation identity: it can be reused, and a same-name tmux session
// can be replaced while an async readiness probe is running. Bind all three values tmux owns.
export function paneIdentity(slug: string): PaneIdentity | null {
  try {
    const out = tmux(
      "list-panes",
      "-t",
      tmuxSessionName(slug),
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{session_created}",
    ).trim()
    const [paneId, pidRaw, createdRaw] = (out.split("\n")[0] ?? "").split("\t")
    const panePid = Number.parseInt(pidRaw ?? "", 10)
    const sessionCreated = Number.parseInt(createdRaw ?? "", 10)
    if (!paneId || !Number.isFinite(panePid) || !Number.isFinite(sessionCreated)) return null
    return { paneId, panePid, sessionCreated }
  } catch {
    return null
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
let livenessMap = new Map<string, PaneSnapshot>() // session name -> exact pane generation + dead bit

function paneMap(): Map<string, PaneSnapshot> {
  const now = Date.now()
  if (now - livenessAt > LIVENESS_TTL_MS) {
    const map = new Map<string, PaneSnapshot>()
    try {
      for (const line of tmux("list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT).split("\n")) {
        const parsed = parsePaneSnapshot(line)
        if (!parsed) continue
        // Fray owns single-pane sessions. If a future/manual session adds panes, prefer a live pane;
        // an exact adoption binding still matches only its persisted tuple.
        const current = map.get(parsed.name)
        if (!current || (current.dead && !parsed.pane.dead)) map.set(parsed.name, parsed.pane)
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
  return paneMap().get(tmuxSessionName(slug))?.dead !== false
}

export function isLiveCached(slug: string): boolean {
  return paneMap().get(tmuxSessionName(slug))?.dead === false
}

export function paneSnapshotCached(slug: string): PaneSnapshot | null {
  return paneMap().get(tmuxSessionName(slug)) ?? null
}

export function isExpectedAdoptionPaneLiveCached(slug: string, expected: ExpectedAdoptionPane): boolean {
  const pane = paneSnapshotCached(slug)
  return Boolean(pane && !pane.dead && sameExpectedPane(expected, pane))
}

export function isExpectedAdoptionPaneLiveAnywhereCached(expected: ExpectedAdoptionPane): boolean {
  for (const pane of paneMap().values()) {
    if (!pane.dead && sameExpectedPane(expected, pane)) return true
  }
  return false
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

// Lower-level terminal controls for version-gated TUI automation. Callers must capture + validate the
// pane before using these; unlike sendKeys, these never guess that a literal string is a user prompt.
export function sendLiteral(slug: string, text: string): void {
  tmux("send-keys", "-t", tmuxSessionName(slug), "-l", text)
}

export function sendTextWithKey(slug: string, text: string, key: "Enter" | "Tab"): boolean {
  const identity = paneIdentity(slug)
  if (!identity) return false
  const condition = expectedPaneIdentityCondition(identity)
  if (!condition) return false
  return sendTextWithKeyToPane(socket, identity.paneId, condition, "fray-input", text, key)
}

export function sendKey(slug: string, key: "Enter" | "Tab" | "Up" | "Down" | "Escape"): void {
  tmux("send-keys", "-t", tmuxSessionName(slug), key)
}

// Multiline-safe injection: stage the text in a tmux paste-buffer (load-buffer from stdin,
// so newlines/quotes survive untouched), paste it, then Enter. -d deletes the buffer after.
export function pasteText(slug: string, text: string): void {
  const name = tmuxSessionName(slug)
  execFileSync("tmux", ["-L", socket, "load-buffer", "-"], { input: text })
  tmux("paste-buffer", "-t", name, "-d")
  tmux("send-keys", "-t", name, "Enter")
}
