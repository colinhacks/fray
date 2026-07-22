import type { PermissionMode } from "@fray-ui/shared"
import type { FenceView, SubAgentView, BgShellView, PendingAskData, TurnState } from "../tailer.ts"

// ---- The agent-backend abstraction (Codex-support epic, Phase 1) ----
// One interface, one implementation per agent CLI. The server holds an AgentBackend per session and
// routes spawn / resume / transcript-location / line-folding through it, so the tailer + dispatcher
// stay backend-blind. Phase 1 ships ClaudeBackend as the sole implementation with byte-for-byte
// identical observable behavior; Phase 2 adds CodexBackend behind this same interface.

export type BackendKind = "claude" | "codex"

// A verified native TUI modal that blocks the backend before it can append another transcript
// record. This is intentionally tiny and presentation-safe: pane contents/options never cross the
// server boundary (they can contain commands, repository data, or secrets). Backends emit only a
// coarse family plus a fixed, sanitized title after matching their own version-grounded modal chrome.
export type NativeInputKind = "tool-approval" | "permission" | "confirmation" | "selection"
export interface NativeInputRequiredData {
  kind: NativeInputKind
  title: string
}

// A backend-neutral transcript record: the vocabulary a backend's parser emits, and — for a backend
// whose turn model maps cleanly onto it (codex's explicit task_started/task_complete brackets) — the
// unit the tailer's generic fold would consume. Each backend maps its raw transcript lines onto this
// union; sidecar/unknown lines map to nothing (skipped).
//
// NOTE (Phase 1): Claude's OWN fold does NOT route through this union. Claude's turn signal is the
// 3-way assistant `stop_reason` (end_turn / tool_use / unknown-with-5s-backstop) that computeTurn and
// the corpus-verified tailer tests depend on, and that distinction cannot be expressed by
// turn-start/turn-end/assistant-text{final} without information loss. So ClaudeBackend keeps its
// corpus-verified applyRecord fold (AgentBackend.foldLine) and exposes parseLine only as the
// normalized VIEW — the codex-facing seam + the unit-test surface.
export type NormalizedEvent =
  | { kind: "turn-start"; at?: string } // a turn began (→ in-flight)
  | { kind: "turn-end"; at?: string; finalText?: string } // a turn finished (→ idle); finalText carries the fence
  | { kind: "assistant-text"; at?: string; text: string; final: boolean } // streamed assistant text (final=the answer, not commentary)
  | { kind: "user-message"; at?: string; text?: string; synthetic: boolean } // human turn (synthetic=peer/notification/tool-result echo — never bumps lastUserAt)
  | { kind: "tool-call"; at?: string; id: string; name: string; input: unknown }
  | { kind: "tool-result"; at?: string; id: string; text: string }
  | { kind: "reasoning"; at?: string; text: string } // model-reasoning SUMMARY (Codex plaintext summary[]; Claude thinking is redacted → never emitted)
  | { kind: "title"; title: string } // backend's own session auto-title (ai-title / codex thread title)

// The shape a backend's fold produces per session — the SAME shape board.ts already consumes as
// SessionTelemetry, minus `permPrompt` (which is pane-sniffed live, not folded from the transcript).
// A documented contract for what every backend's fold must surface; Phase-1 Claude realizes it as
// SessionTelemetry directly (see tailer.get()).
export interface NormalizedTail {
  turn: TurnState
  // Backend-observed session profile when its transcript records it. Claude assistant records expose
  // the actual model but not effort; codex turn_context exposes both. Optional by design.
  model?: string
  effort?: string
  profileAt?: string
  profileRevision?: number
  // Backend-observed permission/sandbox state. Codex emits this in turn_context and
  // thread_settings_applied; Claude emits permission-mode sidecars.
  permissionMode?: PermissionMode
  // Timestamp of the Codex profile event. Claude's permission-mode sidecar has no timestamp, so it
  // remains undefined there. Used to distinguish a pre-reattach Codex turn_context from a later
  // manual /permissions change.
  permissionModeAt?: string
  lastActivityAt?: string
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output (rest time; excludes sub-agent/system bumps)
  lastAssistant?: string
  aiTitle?: string
  lastUserAt?: string
  lastUserText?: string // latest genuine human message (used to confirm durable Codex input delivery)
  lastFence?: FenceView // parsed by the shared fence grammar from the final message
  pendingQuestion: boolean
  subAgents: SubAgentView[] // codex: always []
  bgShells: BgShellView[] // codex: always []
  pendingAsk?: PendingAskData // codex: undefined
  authFault?: "authentication_rejected" // runtime provider-auth rejection (see FoldState.authFault)
}

// The backend-NEUTRAL fold accumulator: the running derivation a backend folds each transcript line
// into, and exactly the fields needed to produce a NormalizedTail. This is the state `foldLine`
// mutates — decoupled from the tailer's private TailState (which EXTENDS this, adding byte-cursor
// bookkeeping + Claude-only sub-agent/ask tracking + Claude's stop_reason turn inputs), so this
// interface no longer leaks Claude internals. A backend whose turn model maps onto NormalizedEvent
// (codex's explicit task_started/task_complete brackets) drives this via `applyEvent`; Claude reuses
// its corpus-verified `applyRecord` over the richer TailState (see the NOTE on NormalizedEvent).
export interface FoldState {
  turn: TurnState // in-flight while a turn runs; idle once it brackets closed
  sawRecords: boolean // any substantive record folded yet (a fresh/booting session guard)
  model?: string // latest concrete backend-observed model
  effort?: string // latest concrete backend-observed reasoning effort
  profileAt?: string // timestamp of latest model/effort record
  profileRevision?: number // increments even when a profile record repeats
  permissionMode?: PermissionMode // latest concrete backend-observed permission/sandbox mode
  permissionModeAt?: string // timestamp of the latest timestamped permission profile event
  permissionModeRevision?: number // increments for every profile record, even when the value repeats
  lastActivityAt?: string // ISO8601 of the latest timestamped event (ANY line, incl. sub-agent/system)
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output — the rest-time key (see NormalizedTail)
  lastAssistant?: string // ~200-char preview of the latest assistant text
  aiTitle?: string // the backend's own session auto-title (latest non-empty wins)
  // A backend may carry one in-band auto-title candidate on its first finalized response. Recording
  // that first final lets a backend distinguish a later recovery signal from an initial title; only a
  // replaceable automatic fallback may accept that later signal.
  titleCandidateFinalSeen?: boolean
  // Raw text of that first finalized response. Codex repeats the answer on task_complete; remembering
  // it lets the fold strip the same hidden marker from the echo without treating a later turn as a
  // second title candidate.
  titleCandidateFinalText?: string
  // Provenance for Codex's auto title. A bounded dispatch fallback exists only so an omitted in-band
  // signal never leaves the board on an internal slug; a later valid Fray signal may replace it.
  // A generated signal or provider-native title is final for automatic naming (manual titles are
  // guarded separately by storage's title_auto CAS).
  autoTitleSource?: "fallback" | "fray" | "native"
  lastUserAt?: string // ISO8601 of the newest GENUINE (non-synthetic) human turn — the listing sort key
  lastUserText?: string // exact text of that genuine human turn when the backend records it
  lastFence?: FenceView // done/awaiting excusal fence on the final message (cleared by any user turn)
  lastAssistantHasQuestion: boolean // the final message carries an unanswered ```question fence
  // Runtime provider-auth rejection (claude-auth plan, Slice A). Set when the backend records a
  // SYNTHETIC auth-error response (Claude: isApiErrorMessage + 401/login text) — never from user or
  // ordinary assistant content — and cleared by the next real assistant text (a genuine response
  // proves the credential works). Only this typed category ever leaves the fold; raw error/pane text
  // stays out of persisted state.
  authFault?: "authentication_rejected"
}

// A file a backend needs on disk BEFORE the detached spawn (e.g. codex's session-scoped AGENTS.md).
// Claude's system prompt rides a file too, but buildClaudeCommand writes it as a side effect, so
// ClaudeBackend returns an empty prewrite list.
export interface PrewriteFile {
  path: string
  contents: string
  // Sensitive prompt transports should be owner-only while the spawned CLI is consuming them.
  // Optional so existing backend prewrites retain their current platform default.
  mode?: number
}

export interface BuiltCommand {
  argv: string[]
  env: Record<string, string>
  prewrite: PrewriteFile[]
}

// Present ⇒ mount the fray "spawn a new board thread" MCP tool (server `fray_spawn`, tool
// `spawn_fray_thread`) for this worker. Carries the abs path to the stdio MCP server script and the
// project state dir it reads `server.lock` from. Computed by the dispatch layer (resolveWorkerPluginDir
// + project.stateDir) and threaded through both backends; absent in tests / when the plugin dir or
// script can't be resolved (→ no injection, worker simply lacks the tool).
export interface SpawnThreadMcp {
  scriptPath: string
  stateDir: string
}

// The ONE canonical Chrome DevTools MCP server spec both backends inject into every worker they
// spawn — the runtime release gate requires driving a real browser, and neither backend can assume
// the operator configured a browser MCP themselves. Claude mounts it via inline `--mcp-config` JSON
// (+ a server-level `--allowedTools mcp__chrome-devtools` pre-approval); codex mounts it via `-c`
// TOML overrides (+ `default_tools_approval_mode="approve"`). Deriving both from this constant is
// what keeps the two backends' browser tooling in lockstep — edit HERE, never in one backend alone.
// `--isolated` gives each worker a disposable browser profile (never the operator's own Chrome).
export const CHROME_DEVTOOLS_MCP = {
  name: "chrome-devtools",
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest", "--experimentalPageIdRouting", "--isolated", "--no-usage-statistics"],
  startupTimeoutSec: 120,
} as const

export interface SpawnOpts {
  sessionId: string // claude: pinned via --session-id. codex: advisory (id is discovered post-spawn)
  cwd: string
  prompt: string // the composed first user message (task + orientation)
  workerContract: string // workerPrompt.ts norms — injected at system level per backend
  extraSystemPrompt?: string // scratchpad/plan orientation
  permissionMode: PermissionMode
  model?: string
  effort?: string
  spawnThreadMcp?: SpawnThreadMcp
}
export interface ResumeOpts extends Omit<SpawnOpts, "prompt"> {
  // Omitted when fray is only re-attaching an idle saved conversation to apply a per-thread
  // permission change. Present for an ordinary dead-session follow-up.
  message?: string
}

export interface AgentBackend {
  readonly kind: BackendKind

  // ---- spawn / resume (argv + injection) ----
  // Build the detached-spawn argv + any files that must exist on disk first. The caller runs
  // `tmux.spawn(slug, argv, cwd, env)` after writing the prewrite files.
  buildSpawn(opts: SpawnOpts): BuiltCommand
  // Resume/reattach the pinned session; `message` starts a turn when present, otherwise the CLI opens
  // idle at its prompt (used for a controlled permission-profile restart).
  buildResume(opts: ResumeOpts): BuiltCommand

  // ---- transcript location ----
  // Deterministic path for a session's transcript (claude: <logDir>/<sessionId>.jsonl), or undefined
  // when it can't be computed yet (codex: the rollout id isn't known until the process writes
  // session_meta — discoverSession then resolves it).
  transcriptPath(sessionId: string): string | undefined
  // Phase 2 (codex) only — ClaudeBackend omits it (its path is deterministic from the pinned id).
  discoverSession?(cwd: string, spawnedAtMs: number): { sessionId: string; path: string } | undefined

  // ---- parsing ----
  // Pure, defensive NORMALIZED view of one raw transcript line (bad line → []). The codex-facing seam
  // + the unit-test surface. A backend whose turn model maps onto NormalizedEvent drives its fold off
  // this; Claude does not (see the NOTE on NormalizedEvent).
  parseLine(line: string): NormalizedEvent[]
  // The AUTHORITATIVE per-backend fold the tailer's driver invokes: fold one raw transcript line into
  // the backend-neutral session accumulator (FoldState). Claude reuses its corpus-verified applyRecord
  // (narrowing FoldState back to the concrete TailState the tailer hands it); a codex backend can
  // implement this as `for (const ev of this.parseLine(line)) applyEvent(state, ev)`.
  foldLine(state: FoldState, line: string): void

  // ---- optional pane-sniff (native interactive prompt; no jsonl signal) ----
  matchesPermPrompt?(pane: string): boolean // claude: the empirical markers; codex: its own or omitted
  // Structured, backend-specific native-modal detection. Implementations MUST match verified terminal
  // chrome rather than arbitrary model output and MUST NOT return pane-derived option/detail text.
  detectNativeInput?(pane: string): NativeInputRequiredData | undefined
}
