import { statSync, openSync, readSync, closeSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { isValidAwaitingTimer, isValidGithubReviewTarget, PermissionMode } from "@fray-ui/shared"
import type { Bus } from "./bus.ts"
import { permMarkerPath, type Project } from "./project.ts"
import type { Storage, SessionRow } from "./storage.ts"
import { discoverTranscriptId, DISCOVERY_GRACE_MS } from "./discover.ts"
import type { AgentBackend, FoldState, NativeInputRequiredData, NormalizedEvent, NormalizedTail } from "./backend/types.ts"
import * as tmux from "./tmux.ts"
import { detectClaudePermissionMode } from "./permission-controller.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { normalizeObservedThreadModel, validateThreadProfile } from "./backend/thread-profiles.ts"

// The JSONL tailer: incrementally reads each registered session's Claude Code transcript
// (~/.claude/projects/<cwdSlug>/<session_id>.jsonl) to derive liveness telemetry — last activity
// time, a preview of the last assistant text, and whether the current TURN is in flight or idle.
// Per the architecture invariant, this file is TELEMETRY ONLY: it never gates correctness, parses
// defensively (bad line skipped, unknown type ignored, never throws), and degrades to "unknown"
// on any schema surprise rather than crashing.
//
// ---- TURN-STATE HEURISTIC (chosen empirically) ----
// Investigated the 15 real transcripts in ~/.claude/projects/-Users-colinmcd94-Documents-projects-fray/.
// Record `type`s observed: assistant, user, attachment, queue-operation, last-prompt, ai-title,
// permission-mode, mode, bridge-session, file-history-snapshot, system. Only `assistant`, `user`,
// and `system` carry a `timestamp`; the rest are sidecar metadata (no timestamp).
//
// The DEFINITIVE turn-end signal is `assistant.message.stop_reason`. Across every transcript, an
// assistant message is split into one JSONL record per content block, and ALL records of a given
// message share the same stop_reason:
//   - "tool_use"  → the model is calling tools; the turn CONTINUES (a tool_result user record and
//                   further assistant records will follow).
//   - "end_turn"  → the model has finished; control returns to the prompt (the agent is IDLE).
// Empirically EVERY completed transcript's last substantive record is an assistant `end_turn`
// (optionally trailed by sidecar `system`/`last-prompt`/`ai-title` records). Counts across the
// corpus: 363 tool_use+tool_use, 209 tool_use+thinking, 117 tool_use+text, 41 end_turn.
//
// Derivation over the "last substantive record" (assistant or user; sidecar types ignored):
//   - assistant, stop_reason "end_turn"  → idle (definitive)
//   - assistant, stop_reason "tool_use"  → in-flight (tool exchange ongoing; DO NOT time out —
//                                          Opus tool latency routinely exceeds 5s)
//   - assistant, stop_reason missing/other → BACKSTOP: idle iff no append for >5s, else in-flight
//   - user (a fresh prompt or a tool_result) → in-flight (the model is about to respond)
//   - no substantive records yet             → in-flight (spawning; the pane is live)
// The 5s backstop only fires for an UNKNOWN stop_reason, so it can never override a clear tool_use.

const IDLE_BACKSTOP_MS = 5000
const POLL_MS = 1000
// Claude writes an untimestamped permission sidecar just before (or alongside) its footer redraw.
// Give the footer the arrival poll plus two more redraw polls, then discard a stable mismatch so a
// killed pane's late sidecar cannot cause a permanent capture-pane/SQLite hot loop.
const CLAUDE_PERMISSION_CONFIRM_POLLS = 3
// A tracked background sub-agent whose transcript file has gone this long without an append is
// treated as "stale" — a liveness fallback for a completion record we somehow missed (the child
// died, or the worker session ended before the <task-notification> landed). ~5min: comfortably
// longer than a child's between-tool quiet gaps, short enough that a dead child clears promptly.
const SUBAGENT_STALE_MS = 5 * 60_000
// How long the transcript must be silent while a turn still looks in-flight before we spend a
// tmux capture-pane to sniff for an interactive permission prompt. Keeps us from shelling out
// every tick for a healthily-streaming turn; a real prompt only appears after a tool_use record
// (which stamps lastActivityAt), so by the time one shows the transcript has already gone quiet.
const PERM_SNIFF_MS = 4000
// Whole-directory FOREIGN-session discovery: a *.jsonl in the log dir with no registry row is a
// maintainer terminal, surfaced as a read-only thread. Only files touched within this window are
// "live" foreign threads (the dir accumulates every session ever); a file that ages past it drops
// out of foreignIds() but keeps its cached tail. Exported so other verticals share the freshness rule.
export const FOREIGN_FRESH_MS = 24 * 60 * 60_000
// Cap on concurrently-surfaced foreign threads (most-recent by mtime) — defensive against a log dir
// holding thousands of historical sessions.
const FOREIGN_MAX = 20
// Foreign discovery is a readdir + per-file stat; too costly per 1s tick, so scan at most every 5th
// tick (~5s) plus the very first tick. Between scans the last fresh set is reused verbatim.
const FOREIGN_SCAN_EVERY = 5
// While a thread's transcript is still unresolved (missing past the grace window), re-run discovery at
// most this often — the file may yet appear (a very late boot) or a drifted transcript may materialize.
const DISCOVER_RETRY_MS = 15_000
// Per-session sink for a captured boot-failure pane, so a stall's root cause (claude's own error text,
// frozen in the remain-on-exit pane) survives past the pane being killed. Best-effort; inert litter.
const STALL_LOG_DIR = join(tmpdir(), "fray-worker-logs")

export type TurnState = "in-flight" | "idle"

// A live background sub-agent as surfaced to the board (mirrors @fray-ui/shared SubAgentView; kept
// as a local shape so the tailer's telemetry stays decoupled from the wire schema).
export interface SubAgentView {
  label: string
  startedAt: string // ISO8601 of the dispatch record
  state: "running" | "stale"
  subagentType?: string // the dispatch's input.subagent_type verbatim (e.g. "fray:fray-opus-high"); absent when unset
  id: string // the dispatch tool_use id — the drill-in drawer's stable handle to this exact child
}

// A signal fence parsed from the FINAL assistant message (mirrors @fray-ui/shared ThreadFence; kept
// as a local shape so the tailer's telemetry stays decoupled from the wire schema). The fence
// language IS the state, the body is the message; `hint` is the one supported `<kind>: <value>` line
// parsed from an awaiting body. Only meaningful while it is the final message — any newer activity
// changes its generation identity.
export interface FenceView {
  kind: "done" | "awaiting"
  body: string
  hint?: { kind: "github-review" | "timer"; value: string }
  at?: string
}

// Per-session derived telemetry surfaced to the board overlay. Structurally a NormalizedTail (the
// backend-neutral fold-output contract) PLUS `permPrompt` — which is pane-sniffed live, not folded
// from the transcript. `extends` makes tsc enforce that this stays a superset of the shared contract.
export interface SessionTelemetry extends NormalizedTail {
  turn: TurnState
  permPrompt: boolean // paused on an interactive permission prompt (pane-sniffed; no jsonl signal)
  // A verified backend-native modal that blocks transcript progress. Its fixed presentation-safe
  // title/kind are the ONLY pane-derived data exposed; option/detail content never leaves the server.
  nativeInputRequired?: NativeInputRequiredData
  // Monotonic within this tail state. The permission controller uses it to distinguish an
  // authoritative profile emitted by the freshly attached backend from the pre-reattach fold.
  permissionModeRevision?: number
  lastActivityAt?: string // ISO8601 of the last timestamped record (ANY record, incl. sub-agent/system)
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output — rest time (excludes sub-agent/system bumps)
  lastAssistant?: string // trimmed preview (~200 chars) of the last assistant text block
  aiTitle?: string // Claude's own auto-generated session title (latest ai-title sidecar record)
  // Claude's native `/rename` is distinguished from ordinary ai-title churn so the control plane can
  // prove that a title record was emitted AFTER its exact command submission.
  customTitle?: string
  customTitleRevision?: number
  subAgents: SubAgentView[] // live background sub-agents this session dispatched (empty when none)
  bgShells: BgShellView[] // live background shells this session launched (empty when none)
  pendingAsk?: PendingAskData // a pending native AskUserQuestion the session is frozen on (else absent)
  pendingQuestion: boolean // at rest with an unanswered ```question block as the last assistant message
  lastUserAt?: string // ISO8601 of the newest USER-role record (answer/steer/dispatch) — the listing sort key
  lastFence?: FenceView // done/awaiting excusal fence on the latest assistant message (else absent)
  // The pinned transcript never materialized and discovery found no drifted one either (worker likely
  // failed to boot). Drives the board's degraded/stalled runtime instead of an eternal "Spinning up…".
  noTranscript?: boolean
}

// ---- Interactive permission-prompt sniff (pane text; no jsonl signal) ----
// Even under `--permission-mode auto`, claude still stops on an interactive permission prompt for
// some tool calls, and the transcript gives NO signal — the last record stays assistant +
// stop_reason:"tool_use" (in-flight) indefinitely. The only observable is the rendered TUI. These
// markers were captured empirically (claude 2.1.198, --permission-mode default) for both a Bash
// and an Edit approval:
//
//   Bash command
//     touch approved-me.txt
//     Create empty file approved-me.txt
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and always allow access to permtest/ from this project
//     3. No
//   Esc to cancel · Tab to amend · ctrl+e to explain
//
//   Edit file / file.txt / <diff>
//   Do you want to make this edit to file.txt?
//   ❯ 1. Yes
//     2. Yes, allow all edits during this session (shift+tab)
//     3. No
//   Esc to cancel · Tab to amend
//
// Recurring across tools: a question line ("Do you want…"), a numbered "1. Yes" option, and the modal
// footer "Esc to cancel" (an idle prompt shows neither). We require the "1. Yes" option AND (the
// question OR the footer) — two independent signals, so a model merely printing "Do you want…" or its
// own numbered list can't trip it.
//
// The wording is NOT stable across every modal, so both signals carry alternates. ExitPlanMode's
// approval asks "Would you like to proceed?" and footers with "ctrl+g to edit in VS Code · …" — it
// matches NEITHER original spelling and was invisible here (adversarial review, claude 2.1.214). That
// is a hang-forever miss, not a cosmetic one: `detectNativeInput` is registered on the Codex backend
// ONLY (backend/codex.ts), so for a Claude worker this matcher is the single blocking-modal signal.
//
// Those content signals alone are NOT enough, because the capture is the whole visible pane: any
// TRANSCRIPT text on screen counts. A worker that quotes an approval prompt, reads this very file, or
// pastes a probe's terminal output re-trips the matcher on every ≥PERM_SNIFF_MS quiet gap and the
// thread oscillates between the sidebar's running band and Needs-you (reported 2026-07-18). Two
// STRUCTURAL gates fix that, both empirically grounded in 81 real-prompt captures (claude 2.x — the
// pre-boot trust prompt, a Bash approval, an Edit/Write approval) against 87 negatives (69 captures of
// a live pane merely quoting a prompt, plus every live worker pane on this box):
//
//   1. A live composer means the pane is ACCEPTING INPUT, so anything on it is transcript. A modal
//      replaces the composer: not one real-prompt capture carries the composer's mode line
//      ("⏵⏵ auto mode on", "⏸ manual mode on", "⏵⏵ accept edits on", "bypass permissions on"), while
//      every idle AND streaming Claude pane does. `ctrl+o`'s detailed-transcript view is the one other
//      composer-less-but-live screen (its own footer replaces the composer, and it is sticky for the
//      session), so it counts as a composer here — without it, a worker toggled into that view kept
//      re-tripping on quoted text. Scoped to the last rows, never the whole pane, so an agent that
//      merely PRINTS "auto mode on" mid-transcript cannot suppress a genuine prompt.
//   2. The modal is always the BOTTOM block. Its option row and footer land within the last handful
//      of non-blank rows, so only that tail is scanned — history scrolled above it is not evidence.
const PERM_YES_OPTION = /(^|\n)\s*(❯\s*)?1\.\s+Yes\b/
const PERM_QUESTION = /\b(?:Do you want|Would you like)\b/
const PERM_FOOTER = /\bEsc to (cancel|reject)\b/
// The four mode-footer spellings, plus plan mode and the ctrl+o transcript view. permission-controller's
// detectClaudePermissionMode() reads the same footer for a DIFFERENT purpose (which mode is active, from
// a narrower anchor), so the two intentionally do not share a regex — but a TUI wording change must be
// applied to both. NOTE: that one has no `plan` branch and returns undefined on a plan-mode pane.
const PERM_COMPOSER_FOOTER = /\bbypass permissions on\b|\baccept edits(?: mode)? on\b|\b(?:auto|manual|plan) mode on\b|\bShowing detailed transcript\b/i
// Rows of the modal's own tail that must contain the signals. Deepest `1. Yes` row observed is
// ExitPlanMode's at 6 rows from the end (Bash 4, trust 3); this keeps real margin over that.
const PERM_MODAL_TAIL_ROWS = 16
// Rows the composer occupies at the bottom of an input-accepting pane (divider, prompt row, divider,
// project line, mode line) — the mode line is always last, so this window need not cover all five.
const PERM_COMPOSER_TAIL_ROWS = 4

export function matchesPermPrompt(pane: string): boolean {
  if (!pane) return false
  const rows = pane.split("\n").filter((row) => row.trim() !== "")
  if (rows.length === 0) return false
  if (rows.slice(-PERM_COMPOSER_TAIL_ROWS).some((row) => PERM_COMPOSER_FOOTER.test(row))) return false
  const tail = rows.slice(-PERM_MODAL_TAIL_ROWS).join("\n")
  if (!PERM_YES_OPTION.test(tail)) return false
  return PERM_QUESTION.test(tail) || PERM_FOOTER.test(tail)
}

// One tracked live background sub-agent, keyed in TailState by its dispatch tool_use id (the
// correlation key present BOTH on the Agent tool_use block AND in the completion <task-notification>'s
// <tool-use-id>). Registered on the background dispatch, enriched with `outputFile` from the launch
// tool_result, and removed on a terminal completion notification.
interface SubAgentEntry {
  kind: "agent" | "shell" // an Agent sub-agent (drill-in) vs a background Bash shell (display-only)
  toolUseId: string
  label: string // the dispatch's input.description (shell: falls back to the command's first-line summary)
  startedAt: string // ISO8601 — the dispatch record's timestamp
  subagentType?: string // the dispatch's input.subagent_type verbatim (agents only; may be absent)
  outputFile?: string // the child/shell's output path (from the launch tool_result); its mtime = liveness
  // The RUNTIME task id (Bash "…with ID: <id>", Monitor "(task <id>…)", Agent "agentId: <id>"), parsed
  // from the launch ack. This is the ONE identifier a `TaskStop` references (its `input.task_id`) and
  // it also rides every natural completion notification as `<task-id>` — so it is the correlation key
  // for a MANUAL stop, which carries no tool_use id at all. Absent until the launch ack is seen.
  taskId?: string
}

// A live background shell as surfaced to the board (mirrors @fray-ui/shared BgShellView).
export interface BgShellView {
  label: string
  startedAt: string
  state: "running" | "stale"
}

// A pending native AskUserQuestion (structured, capped). Mirrors @fray-ui/shared PendingAsk; `id` is
// the tool_use id used to clear it when its tool_result lands.
interface AskOptionData {
  label: string
  description?: string
}
interface AskQuestionData {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOptionData[]
}
export interface PendingAskData {
  id: string
  questions: AskQuestionData[]
}

// A COMPLETED sub-agent retained for post-hoc review (reviewing a finished child is the main reason to
// open its drawer). On its terminal notification a live SubAgentEntry moves into a bounded ring here —
// EXCLUDED from every live surface (banner / counts / spinner stay live-only), but still resolvable by
// the drill-in drawer via its retained outputFile. The ring caps memory; its file may later be cleaned
// from disk, in which case the drawer degrades to its "transcript unavailable" state.
interface RetiredSubAgent {
  toolUseId: string
  label: string
  subagentType?: string
  outputFile?: string
  finishedAt?: string // ISO8601 of the completion notification
  status: "completed" | "failed" | "killed"
}
// How many terminal sub-agents to retain per thread for drawer review (newest-wins ring).
const RETAINED_SUBAGENTS_MAX = 20

// Mutable accumulator for one session's tail. Extends the backend-neutral FoldState (the running
// derivation `applyRecord`/`applyEvent` fold into — turn, lastActivityAt, lastAssistant, aiTitle,
// lastUserAt, lastFence, lastAssistantHasQuestion, sawRecords); adds the tailer's own byte cursor
// (`offset`/`partial`) plus Claude-only tracking the neutral shape doesn't carry.
export interface TailState extends FoldState {
  slug: string
  sessionId: string
  nativeSessionId: string
  runtimeGeneration: number
  path: string
  // A FOREIGN thread (a maintainer terminal discovered from the log dir, no registry row). Structural
  // guarantee that this state can NEVER shell out to tmux — no pane-sniff, no pane-death, no notify /
  // storage write — since no `fray-<slug>` tmux session exists for it. Keyed by session id, not slug.
  foreign: boolean
  offset: number
  partial: string
  // Claude's turn model: the kind of the last substantive record + (for assistant) its stop_reason.
  // NOT in the neutral FoldState — codex brackets turns explicitly (applyEvent sets `turn` directly);
  // only Claude's computeTurn reads these two (+ the 5s unknown-stop-reason backstop).
  lastKind?: "assistant" | "user"
  lastStopReason?: string
  // live background OPS (sub-agents AND background shells), keyed by dispatch/launch tool_use id
  // (insertion order = launch order); the `kind` field distinguishes them at the view boundary.
  subAgents: Map<string, SubAgentEntry>
  // completed sub-agents retained for drawer review (bounded ring; NOT surfaced live) — see above
  retiredSubAgents: Map<string, RetiredSubAgent>
  // a pending native AskUserQuestion the session is frozen on (no tool_result yet), else undefined
  pendingAsk?: PendingAskData
  subAgentsSig?: string // last-emitted signature of the derived background-ops + ask view (dirty-change detection)
  // transition tracking (dedupe)
  primed: boolean // first tick restores state WITHOUT firing transition notifies (boot/restart)
  permPrompt: boolean // last pane-sniff verdict (see matchesPermPrompt)
  nativeInputRequired?: NativeInputRequiredData // last structured native-modal verdict
  paneDead: boolean
  // ---- read-side transcript discovery (registered rows only; foreign states never touch these) ----
  // The pinned `<session_id>.jsonl` never appeared and discovery found no drifted transcript: a boot
  // failure. Surfaces a degraded runtime rather than an eternal spinner. Cleared if a transcript binds.
  noTranscript: boolean
  // Throttle: next epoch-ms at which discovery may re-run for an unresolved (missing-transcript) row.
  nextDiscoverMs: number
  // One-shot guard so a stall's pane is captured/logged once, not every tick.
  stallLogged: boolean
  customTitle?: string
  customTitleRevision: number
  // Claude permission sidecars are untimestamped. Hold an incremental observation until the live
  // footer redraw proves which generation emitted it; do not lose a genuine record that arrived a
  // tick before the footer became visible.
  unconfirmedPermissionMode?: PermissionMode
  unconfirmedPermissionPolls?: number
}

// A single parsed JSONL record — only the fields the derivation needs are typed; the rest are
// ignored. `unknown`-shaped so a schema surprise degrades rather than throws.
interface Record {
  type?: string
  timestamp?: string
  isMeta?: boolean // `/rename <title>` reminder record: CLI metadata, not a user/model turn
  aiTitle?: string // present only on ai-title sidecar records
  customTitle?: string // present only on custom-title records (written by /rename)
  permissionMode?: unknown // present only on Claude permission-mode sidecars
  content?: unknown // top-level string on queue-operation records — carries the <task-notification> XML
  promptSource?: string // on user records: typed/queued (human) · "system" (peer msg / task-notification)
  isApiErrorMessage?: boolean // synthetic assistant record claude writes for a provider API error
  message?: { stop_reason?: string; content?: unknown; model?: string }
}

// Narrow text conjunction for a Claude AUTH error (vs other API errors riding the same synthetic
// record — overloaded, rate-limit, 5xx). The canonical observed line is
// "Please run /login · API Error: 401 Invalid authentication credentials".
export function isClaudeAuthErrorText(text: string): boolean {
  if (/Please run \/login/i.test(text)) return true
  return /\b401\b/.test(text) && /authenticat|credential|OAuth/i.test(text)
}

// A fresh, unread tail cursor for a session (exported for tick + tests).
export function newTailState(
  slug: string,
  sessionId: string,
  path: string,
  foreign = false,
  nativeSessionId = sessionId,
  runtimeGeneration = 0,
): TailState {
  return {
    slug,
    sessionId,
    nativeSessionId,
    runtimeGeneration,
    path,
    foreign,
    offset: 0,
    partial: "",
    sawRecords: false,
    lastAssistantHasQuestion: false,
    subAgents: new Map(),
    retiredSubAgents: new Map(),
    primed: false,
    turn: "in-flight",
    permPrompt: false,
    nativeInputRequired: undefined,
    paneDead: false,
    noTranscript: false,
    nextDiscoverMs: 0,
    stallLogged: false,
    customTitleRevision: 0,
  }
}

// Defensive JSON parse: a malformed line yields null (skipped), never an exception.
export function parseLine(line: string): Record | null {
  const s = line.trim()
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === "object" ? (v as Record) : null
  } catch {
    return null
  }
}

// The RAW last text block of an assistant message (newlines intact). Handles the streaming split (one
// block per record) and a defensive multi-block array alike. Kept raw because the question-fence
// detection below needs the line structure the preview collapses away.
function lastTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text: string | undefined
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") text = t
    }
  }
  return text
}

// The board preview of an assistant text block: whitespace collapsed to single spaces, trimmed, capped
// at ~200 chars. Empty/whitespace-only → undefined (leaves the prior preview in place).
function previewText(raw: string): string | undefined {
  const norm = raw.replace(/\s+/g, " ").trim()
  if (!norm) return undefined
  return norm.length > 200 ? `${norm.slice(0, 200)}…` : norm
}

// Minimal server-side MIRROR of the web's ```question fence convention (web/src/lib/questionBlocks.ts
// QUESTION_BLOCK) — a presence check only, not a full parse: an opening ```question line (optional
// kind info-string like `approval`), its body, then a closing ``` line. Kept in sync BY HAND (the
// architecture forbids importing web code into the server). Drives the derived pending-question safety
// net: a worker that asked the human IN CHAT but never flipped its thread file to blocked.
// Info-string grammar mirrors the web exactly: one or more space-separated tokens (```question
// approval danger) — the old single-token form silently missed multi-token gates the prompt teaches.
const QUESTION_BLOCK_RE = /^```question(?:[ \t]+[A-Za-z][^\r\n]*?)?[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*$/m
export function hasQuestionBlock(text: string | undefined): boolean {
  return typeof text === "string" && QUESTION_BLOCK_RE.test(text)
}

// ---- signal-fence grammar (maintainer-settled) ----
// Exactly two EXCUSAL fences: ```done and ```awaiting. The fence LANGUAGE is the state; the BODY is
// the message. The opening line is the bare language word (trailing spaces/tabs tolerated, nothing
// else after it); the body runs to a closing ``` line. If a text carries several signal fences the
// LAST wins — and the last fence must be the FINAL NON-WHITESPACE CONTENT of the text (the prompt's
// "at the very end" rule): a fence merely QUOTED mid-message (a worker explaining the protocol to the
// human) must never excuse the thread from the queue. Malformed/unclosed fences never match.
// CRLF-tolerant (normalized before matching).
// ONE implementation so the grammar lives in a single place (mirrors QUESTION_BLOCK_RE's spirit). The
// ```question fence keeps its own separate machinery (hasQuestionBlock) — it is NOT a signal fence.
const SIGNAL_FENCE_RE = /^```(done|awaiting)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm
// An awaiting-body hint line: `<kind>: <value>`. Kind is case-insensitive (lowercased on output); the
// value must start with a non-space char (a bare hint name with nothing after stays prose).
const AWAITING_HINT_RE = /^(github-review|timer):\s*(\S.*)$/i
const FENCE_BODY_MAX = 500 // defensive: never let a worker's fence body fatten the snapshot
const HINT_VALUE_MAX = 200 // defensive cap on a single hint value

function capFenceBody(s: string): string {
  return s.length > FENCE_BODY_MAX ? `${s.slice(0, FENCE_BODY_MAX)}…` : s
}

// Parse the done/awaiting signal fence out of an assistant text, or undefined if none. Pure and
// defensive (never throws) so it is unit-testable and degrades on any surprise. For `awaiting`,
// exactly one supported `<kind>: <value>` line becomes `hint` and is removed from `body`. Zero or
// multiple supported lines are intentionally non-signaling and remain visible as prose.
export function parseSignalFence(text: string | undefined): FenceView | undefined {
  if (typeof text !== "string") return undefined
  const norm = text.replace(/\r\n/g, "\n")
  SIGNAL_FENCE_RE.lastIndex = 0
  let kind: "done" | "awaiting" | undefined
  let raw = ""
  let end = 0
  let m: RegExpExecArray | null
  while ((m = SIGNAL_FENCE_RE.exec(norm)) !== null) {
    kind = m[1] as "done" | "awaiting" // last-fence-wins: keep overwriting
    raw = m[2]
    end = m.index + m[0].length
  }
  if (!kind) return undefined
  // End-anchor: the fence only signals when it closes the message (trailing whitespace tolerated).
  // Prose after the last fence means it was quoted/explanatory, not a signal — no excusal.
  if (norm.slice(end).trim() !== "") return undefined
  if (kind === "done") return { kind, body: capFenceBody(raw.trim()) }
  const candidates: NonNullable<FenceView["hint"]>[] = []
  const rest: string[] = []
  for (const line of raw.split("\n")) {
    const hm = line.match(AWAITING_HINT_RE)
    if (hm) {
      const k = hm[1].toLowerCase() as NonNullable<FenceView["hint"]>["kind"]
      const value = hm[2].trim()
      candidates.push({ kind: k, value: value.length > HINT_VALUE_MAX ? value.slice(0, HINT_VALUE_MAX) : value })
    } else {
      rest.push(line)
    }
  }
  if (candidates.length !== 1) return { kind, body: capFenceBody(raw.trim()) }
  const candidate = candidates[0]
  if (
    (candidate.kind === "timer" && !isValidAwaitingTimer(candidate.value)) ||
    (candidate.kind === "github-review" && !isValidGithubReviewTarget(candidate.value))
  ) return { kind, body: capFenceBody(raw.trim()) }
  return { kind, body: capFenceBody(rest.join("\n").trim()), hint: candidate }
}

// A user record is a REAL user interaction (a typed prompt / answer / steer / dispatch) rather than a
// mere tool_result fed back to the model mid-turn. The distinction matters for the chronological
// listing order: only the user's OWN messages should bump a row, never the agent's tool activity.
// Shape: a real prompt's `content` is a STRING (or an array carrying at least one non-tool_result
// block — text/image); a tool exchange's `content` is an array of ONLY tool_result blocks.
export function isRealUserMessage(content: unknown): boolean {
  if (typeof content === "string") return true
  if (!Array.isArray(content)) return false
  return content.some((b) => !(b && typeof b === "object" && (b as { type?: string }).type === "tool_result"))
}

// Flatten a tool_result's `content` (an array of {type:"text", text} blocks, or a bare string) into
// one string so we can regex the launch metadata out of it. Defensive: anything unexpected → "".
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") out += t
    }
  }
  return out
}

// One-line summary of a shell command: first non-blank line, whitespace-collapsed, capped. The label
// for a background shell when the model gave no `description`.
function shellSummary(command: unknown): string {
  if (typeof command !== "string") return "background shell"
  const first = (command.split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ")
  if (!first) return "background shell"
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

// Register each BACKGROUND OP in an assistant message as a tracked live entry, keyed by tool_use id:
//   • an `Agent` dispatch (unless run_in_background:false — a foreground/blocking child the spinner
//     already covers; Agent defaults to background) → kind "agent" (drill-in + [type] tag).
//   • a `Bash` with run_in_background:true (a persist-across-rest shell — a CI watcher, a long build)
//     → kind "shell" (display-only).
//   • a `Monitor` (always background in Claude Code; finite or session-persistent) → kind "shell" too.
//     Tracking it keeps an off-turn worker in Active while the monitor owns an automatable wait.
// Re-seeing the same id preserves any outputFile already resolved from its launch result.
function trackDispatches(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; name?: string; id?: unknown; input?: unknown }
    if (b.type !== "tool_use") continue
    const id = typeof b.id === "string" ? b.id : undefined
    if (!id) continue
    const input = (b.input ?? {}) as { description?: unknown; run_in_background?: unknown; subagent_type?: unknown; command?: unknown }
    const startedAt = typeof rec.timestamp === "string" ? rec.timestamp : (state.lastActivityAt ?? "")
    const outputFile = state.subAgents.get(id)?.outputFile
    const desc = typeof input.description === "string" && input.description.trim() ? input.description.trim() : undefined
    if (b.name === "Agent") {
      if (input.run_in_background === false) continue // foreground (blocking) — visible via the spinner
      // The worker-profile cell (model+effort), shown verbatim as a "[type]" tag — no stripping.
      const subagentType = typeof input.subagent_type === "string" && input.subagent_type.trim() ? input.subagent_type.trim() : undefined
      state.subAgents.set(id, { kind: "agent", toolUseId: id, label: desc ?? "sub-agent", startedAt, subagentType, outputFile })
    } else if ((b.name === "Bash" && input.run_in_background === true) || b.name === "Monitor") {
      state.subAgents.set(id, { kind: "shell", toolUseId: id, label: desc ?? shellSummary(input.command), startedAt, outputFile })
    }
  }
}

// Corpus-verified LAUNCH-ACK shapes (2026-07-09; surveyed across the real transcripts in
// ~/.claude/projects — three Agent ack wordings + the Bash/Monitor shell acks coexist in the wild):
//   • "Async agent launched successfully…"  — older Agent ack; MAY carry "output_file: <path>"
//   • "Spawned successfully…"               — newer mailbox/teammate ack; carries "agentId: <id>", NO path
//   • "Command running in background…"      — Bash shell ack; carries "Output is being written to: <path>"
//   • "Monitor started…"                    — Monitor ack; task id but no output path
// A tracked id's tool_result matching one of these means the child is now RUNNING DETACHED — keep
// tracking. Anything else on a tracked AGENT id is the synchronous (foreground) call's final report —
// its completion (an error/denial result also means the dispatch is over). The earlier discriminator
// ("no output_file: token ⇒ foreground") retired live background children of the two path-less ack
// shapes — including every mailbox-style Agent and every background shell — on their own launch ack.
const LAUNCH_ACK_RE = /^\s*(Async agent launched successfully|Spawned successfully|Command running in background|Monitor started)/

// Move a tracked AGENT entry into the bounded retained ring (drawer review), evicting the oldest.
// Shared by the foreground-completion path and the <task-notification> path.
function retireToRing(state: TailState, entry: SubAgentEntry, finishedAt: string | undefined, status: "completed" | "failed" | "killed"): void {
  state.retiredSubAgents.delete(entry.toolUseId)
  state.retiredSubAgents.set(entry.toolUseId, {
    toolUseId: entry.toolUseId,
    label: entry.label,
    subagentType: entry.subagentType,
    outputFile: entry.outputFile,
    finishedAt,
    status,
  })
  while (state.retiredSubAgents.size > RETAINED_SUBAGENTS_MAX) {
    const oldest = state.retiredSubAgents.keys().next().value
    if (oldest === undefined) break
    state.retiredSubAgents.delete(oldest)
  }
}

// Retire a live entry however it was CORRELATED (by tool_use id from a notification, or by runtime
// task id from a manual stop) — the map key is always its tool_use id. A display-only SHELL just
// clears; an AGENT moves into the review ring. The single exit for every terminal signal.
function retireLive(state: TailState, entry: SubAgentEntry, finishedAt: string | undefined, status: "completed" | "failed" | "killed"): void {
  state.subAgents.delete(entry.toolUseId)
  if (entry.kind === "shell") return // display-only — nothing to review, no retention ring
  retireToRing(state, entry, finishedAt, status)
}

// Find a live tracked op by its RUNTIME task id — the correlation key a manual `TaskStop` carries (it
// has no tool_use id). Maps hold a handful of live ops, so a scan beats a second index that every
// removal path would have to keep in sync (index desync is the exact bug class this change closes).
function findLiveByTaskId(state: TailState, taskId: string): SubAgentEntry | undefined {
  for (const e of state.subAgents.values()) if (e.taskId === taskId) return e
  return undefined
}

// Resolve a tracked child's transcript path from its launch ack, best shape first: an explicit
// "output_file:" (older Agent ack), the shell ack's "Output is being written to:", else DERIVED from
// the mailbox ack's agentId — subagent transcripts live at <session-dir>/subagents/agent-<id>.jsonl
// beside the parent's own jsonl (verified on disk 2026-07-09). Undefined when nothing resolves (the
// entry then simply never goes stale — its completion notification still clears it).
function launchOutputFile(state: TailState, text: string): string | undefined {
  const m = text.match(/output_file:\s*(\S+)/) ?? text.match(/Output is being written to:\s*(\S+)/)
  // The shell ack embeds the path mid-sentence ("… written to: <path>. You will be notified …") —
  // strip the sentence period or the staleness stat hits a nonexistent path and flags every shell stale.
  if (m) return m[1].replace(/\.$/, "")
  const aid = text.match(/agentId:\s*(\S+)/)?.[1]
  if (aid) return `${state.path.replace(/\.jsonl$/, "")}/subagents/agent-${aid}.jsonl`
  return undefined
}

// The RUNTIME task id from a launch ack — the key a later `TaskStop` (and every natural completion
// notification) references. One per corpus-verified ack shape: the Bash background ack, the Monitor
// ack, and the mailbox Agent ack (whose agentId doubles as its TaskStop handle). Undefined for the
// path-only older Agent ack, which has no manual-stop handle and clears on its notification anyway.
function launchTaskId(text: string): string | undefined {
  return (
    text.match(/Command running in background with ID:\s*(\S+)/)?.[1]?.replace(/\.$/, "") ??
    text.match(/Monitor started \(task\s+(\w+)/)?.[1] ??
    text.match(/agentId:\s*(\S+)/)?.[1]
  )
}

// Process tool_results for tracked background ops: enrich a launch ack with the child's transcript
// path (staleness clock) and keep tracking; retire a tracked AGENT whose tool_result is NOT a launch
// ack (a synchronous call's final report / an error — no task-notification ever fires for those;
// missing this leaked 26 phantom "running" sub-agents on a busy session, found 2026-07-09). A tracked
// SHELL follows the same launch discriminator: a recognized background/Monitor ack stays live; any
// synchronous error/non-ack result means no detached operation exists and is removed immediately.
// Once launched, its terminal signal remains the <task-notification>.
function trackLaunchResults(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown; content?: unknown }
    if (b.type !== "tool_result") continue
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
    if (!id) continue
    const entry = state.subAgents.get(id)
    if (!entry) continue
    const text = toolResultText(b.content)
    if (!entry.outputFile) entry.outputFile = launchOutputFile(state, text)
    if (!entry.taskId) entry.taskId = launchTaskId(text)
    if (LAUNCH_ACK_RE.test(text)) continue // background launch ack — the child/shell is alive, keep tracking
    if (entry.kind === "shell") {
      state.subAgents.delete(id) // synchronous launch failure: no notification will ever arrive
      continue
    }
    // Foreground completion (or a failed dispatch): the tool_result IS the terminal signal.
    state.subAgents.delete(id)
    retireToRing(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, "completed")
  }
}

// RETIRE a tracked sub-agent when its <task-notification> reports a TERMINAL status: move it OUT of the
// live map (so banner/counts/spinner stop showing it) and INTO the bounded retained ring (so the
// drill-in drawer can still resolve its transcript for review). Notifications ride TWO record shapes
// (both must be handled — missing the second leaked 20+ phantom "running" sub-agents on a busy
// session, found 2026-07-09): (a) queue-operation records with a top-level `content` string, and
// (b) USER records whose message.content (string, or text blocks) embeds the <task-notification>
// XML — the shape newer harness versions emit. A record can carry multiple notification blocks;
// each is retired independently. A task-id can notify more than once (a resumed background agent
// re-notifies) and a non-terminal "running" ping exists too, so only completed/failed/killed retire
// the entry. Idempotent: a repeat terminal notify finds nothing live to move (no-op).
function notificationText(rec: Record): string | undefined {
  if (typeof rec.content === "string") return rec.content
  const c = rec.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    const text = c
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n")
    return text || undefined
  }
  return undefined
}

function trackCompletions(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0) return
  const raw = notificationText(rec)
  if (!raw || !raw.includes("<task-notification>")) return
  for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const status = block.match(/<status>([^<]*)<\/status>/)?.[1]
    if (status !== "completed" && status !== "failed" && status !== "killed") continue
    // Correlate by tool-use-id, then fall back to the runtime task-id (both ride the notification).
    // Some emitters omit tool-use-id; before we captured task ids at launch that was a safe no-op, and
    // now it RESOLVES against the entry's captured task id instead of leaking a phantom row.
    const id = block.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)?.[1]
    const taskId = block.match(/<task-id>([^<]*)<\/task-id>/)?.[1]
    const entry = (id ? state.subAgents.get(id) : undefined) ?? (taskId ? findLiveByTaskId(state, taskId) : undefined)
    if (!entry) continue // not live (unknown id, or already retired by an earlier notify) — no-op
    retireLive(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, status)
  }
}

// A manual `TaskStop` is a first-class STOP event, symmetric with the launch `tool_use` that started
// the op. Its structured result confirms "Successfully stopped task: <id>" and carries the runtime
// `task_id` — the SAME id captured at launch, and the ONLY correlation key a manual stop exposes (it
// has no tool_use id). This is the signal that retires a shell/agent killed by hand — the one the
// board previously never saw, leaving a phantom pulsing row until the pane died.
function stoppedTaskId(text: string): string | undefined {
  // Guard on the success confirmation so a failed/no-op stop never retires a still-live row, then read
  // the structured task_id field (the first match is the real field — it precedes `command` in the JSON).
  if (!/Successfully stopped task/.test(text)) return undefined
  return text.match(/"task_id"\s*:\s*"([^"]+)"/)?.[1]
}

function trackStops(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; content?: unknown }
    if (b.type !== "tool_result") continue
    const taskId = stoppedTaskId(toolResultText(b.content))
    if (!taskId) continue
    const entry = findLiveByTaskId(state, taskId)
    if (!entry) continue // already retired by its own notification, or never tracked — safe no-op
    retireLive(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, "killed")
  }
}

// Cap a foreign string defensively (AskUserQuestion is an UNTRUSTED tool payload — never let it
// fatten the snapshot). Caps chosen so the read-only render stays a compact card.
function capAsk(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
// Parse an AskUserQuestion tool_use `input.questions` into the capped structured shape. Defensive at
// every level: a missing/misshaped field is skipped, never thrown. Empty result → treat as "no ask".
function parseAskInput(input: unknown): AskQuestionData[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs)) return []
  const out: AskQuestionData[] = []
  for (const q of qs.slice(0, 8)) {
    if (!q || typeof q !== "object") continue
    const qq = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown }
    const question = typeof qq.question === "string" && qq.question.trim() ? capAsk(qq.question.trim(), 400) : ""
    if (!question) continue
    const header = typeof qq.header === "string" && qq.header.trim() ? capAsk(qq.header.trim(), 60) : undefined
    const multiSelect = qq.multiSelect === true ? true : undefined
    const options: AskOptionData[] = []
    if (Array.isArray(qq.options)) {
      for (const o of qq.options.slice(0, 12)) {
        if (!o || typeof o !== "object") continue
        const oo = o as { label?: unknown; description?: unknown }
        const label = typeof oo.label === "string" && oo.label.trim() ? capAsk(oo.label.trim(), 160) : undefined
        if (!label) continue
        const description = typeof oo.description === "string" && oo.description.trim() ? capAsk(oo.description.trim(), 300) : undefined
        options.push({ label, description })
      }
    }
    out.push({ question, header, multiSelect, options })
  }
  return out
}
// Capture a PENDING native AskUserQuestion: an AskUserQuestion tool_use whose tool_result hasn't landed
// yet freezes the session at a TUI dialog. Same correlation pattern as sub-agent tracking (keyed by
// tool_use id). Cleared by clearAskOnResult when the matching tool_result arrives.
function trackAsk(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; name?: string; id?: unknown; input?: unknown }
    if (b.type !== "tool_use" || b.name !== "AskUserQuestion") continue
    const id = typeof b.id === "string" ? b.id : undefined
    if (!id) continue
    const questions = parseAskInput(b.input)
    if (questions.length) state.pendingAsk = { id, questions }
  }
}
// Clear the pending ask once its tool_result lands (the human answered in the terminal).
function clearAskOnResult(state: TailState, rec: Record): void {
  const pending = state.pendingAsk
  if (!pending) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown }
    if (b.type === "tool_result" && b.tool_use_id === pending.id) {
      state.pendingAsk = undefined
      return
    }
  }
}

// Fold one record into the running derivation. Only assistant/user records are "substantive" (they
// move the turn state); assistant/user/system records with a timestamp advance lastActivityAt.
export function applyRecord(state: TailState, rec: Record): void {
  const type = rec.type
  // A `type:"user"` record with promptSource:"system" is a peer (SendMessage) message or a sub-agent
  // <task-notification> — NOT a human turn. It DOES re-invoke the agent (the model wakes to process
  // it), so it moves the TURN to in-flight (shimmer during the resume) and advances lastActivityAt like
  // any record. What it must NOT do is bump `lastUserAt` — the ROW-ORDER key — because that would jump
  // the row to the top from motion the human didn't cause. (An earlier fix over-suppressed the turn
  // flip too, which made a thread look IDLE/stalled while the agent was actually resuming after a
  // sub-agent returned — no shimmer, then a message appeared out of nowhere. Found 2026-07-09.)
  const systemUserRec = type === "user" && rec.promptSource === "system"
  // Native slash commands can append a type:user,isMeta:true reminder without invoking the model.
  // Treating that as a real user record leaves an idle session falsely in-flight forever because no
  // assistant record follows. It is sidecar metadata: no activity, turn, fence, or row-order change.
  const metaUserRec = type === "user" && rec.isMeta === true
  if (typeof rec.timestamp === "string" && (type === "assistant" || (type === "user" && !metaUserRec) || type === "system")) {
    state.lastActivityAt = rec.timestamp
  }
  if (type === "permission-mode") {
    const parsed = PermissionMode.safeParse(rec.permissionMode)
    if (parsed.success) {
      state.permissionMode = parsed.data
      state.permissionModeRevision = (state.permissionModeRevision ?? 0) + 1
    }
  } else if (type === "assistant") {
    state.sawRecords = true
    state.lastKind = "assistant"
    // The agent's OWN output timestamp = the rest-time key. For an at-rest thread the last assistant
    // record IS its final resting message; unlike lastActivityAt this never moves from a sub-agent's
    // completion notification (a promptSource:system USER record), so the queue never reshuffles on
    // background-child motion. tool_result echoes are `type:user`, not assistant, so they don't bump it.
    if (typeof rec.timestamp === "string") state.lastAssistantAt = rec.timestamp
    state.lastStopReason = typeof rec.message?.stop_reason === "string" ? rec.message.stop_reason : undefined
    // Claude records the actual resolved model on every assistant message. It does NOT record the
    // launch effort, so that half continues to come from the persisted dispatch profile. Ignore the
    // synthetic placeholder some generated/error records use rather than overwriting a real model.
    const observedModel = typeof rec.message?.model === "string" ? rec.message.model.trim() : ""
    if (observedModel && observedModel !== "<synthetic>") {
      state.model = observedModel
      state.profileAt = typeof rec.timestamp === "string" ? rec.timestamp : undefined
      state.profileRevision = (state.profileRevision ?? 0) + 1
    }
    const raw = lastTextBlock(rec.message?.content)
    // Runtime auth classifier (claude-auth plan): claude records a rejected credential as a SYNTHETIC
    // assistant record (isApiErrorMessage:true, model "<synthetic>") whose text is the 401/login
    // recovery line. Keying on the synthetic flag makes user-authored or quoted "401" text
    // structurally unable to trigger the fault; the text conjunction keeps other API errors
    // (overloaded, rate-limit) from reading as auth. A later REAL assistant text clears it —
    // a genuine response is proof the credential works again.
    if (rec.isApiErrorMessage === true) {
      if (raw !== undefined && isClaudeAuthErrorText(raw)) state.authFault = "authentication_rejected"
    } else if (raw !== undefined) {
      state.authFault = undefined
    }
    if (raw !== undefined) {
      const preview = previewText(raw)
      if (preview !== undefined) state.lastAssistant = preview
      // Track whether THIS (now the latest) assistant text carries an unanswered question fence.
      state.lastAssistantHasQuestion = hasQuestionBlock(raw)
      // Recompute the done/awaiting signal fence from THIS text — an assistant text with no fence
      // clears it (the fence only signals while it is the final message). Same lifecycle as the
      // question flag: set per assistant text, cleared by any user record below.
      const fence = parseSignalFence(raw)
      state.lastFence = fence && typeof rec.timestamp === "string" ? { ...fence, at: rec.timestamp } : fence
    }
    trackDispatches(state, rec) // register any background Agent dispatches + background shells
    trackAsk(state, rec) // capture a pending native AskUserQuestion (frozen at a TUI dialog)
  } else if (type === "user" && !metaUserRec) {
    state.sawRecords = true
    // A user record — human turn, tool_result, OR a re-invoking system record (peer/notification) —
    // flips the turn to IN-FLIGHT: the model is about to respond, so the thread reads as WORKING
    // (shimmer), not idle. This is what shows motion while an agent resumes after a sub-agent returns.
    state.lastKind = "user"
    state.lastStopReason = undefined
    // A newer user record supersedes any pending chat question / excusal fence (they only signal as the
    // FINAL message); the NEXT assistant record recomputes them.
    state.lastAssistantHasQuestion = false
    state.lastFence = undefined
    // `lastUserAt` is the ROW-ORDER key — bump it ONLY for a genuine HUMAN interaction. A tool_result
    // is agent activity (excluded by isRealUserMessage); a system record (peer/notification) is
    // machine motion the human didn't cause — neither may jump the row to the top (the one part of the
    // earlier over-fix that WAS a real bug).
    if (!systemUserRec && typeof rec.timestamp === "string" && isRealUserMessage(rec.message?.content)) state.lastUserAt = rec.timestamp
    trackLaunchResults(state, rec) // resolve a background dispatch's transcript path from its launch result
    trackStops(state, rec) // a manual TaskStop is a terminal signal — retire the op it killed
    clearAskOnResult(state, rec) // the AskUserQuestion answer landed → clear the pending ask
  } else if (type === "ai-title") {
    // Sidecar record carrying Claude's own auto-generated session title. Emitted repeatedly (often
    // identical) as the session evolves — take the latest non-empty. Never touches turn state.
    if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) state.aiTitle = rec.aiTitle.trim()
  } else if (type === "custom-title") {
    // Written by /rename (bare /rename auto-generates a slug; /rename <name> sets it). Keep it in a
    // dedicated observation slot only: the rename controller must confirm the readable second record
    // and atomically persist it before any board/file surface changes. Promoting an intermediate or
    // mismatched record to aiTitle leaked rejected slugs into the UI and paired .fray files.
    if (typeof rec.customTitle === "string" && rec.customTitle.trim()) {
      state.customTitle = rec.customTitle.trim()
      state.customTitleRevision++
    }
  }
  // all other types (attachment, queue-operation, last-prompt, mode,
  // bridge-session, file-history-snapshot, system) are sidecar metadata — ignored for turn state.
  // Sub-agent completion rides queue-operation records (a top-level <task-notification> string), so
  // it's checked for EVERY record regardless of type (the helper self-guards on shape + tracked ids).
  trackCompletions(state, rec)
}

// Derive the final-message-dependent fields (preview + question flag + done/awaiting fence) from the
// text of a FINAL assistant message. Shared by assistant-text{final:true} and turn-end.finalText so
// the same derivation lands whichever event a backend carries the final answer on. Mirrors the
// assistant-text arm of applyRecord — minus Claude's every-block fence recompute (a normalized
// backend fences only on the final message; a codex `commentary` block must never excuse the thread).
function applyFinalText(state: FoldState, text: string): void {
  const preview = previewText(text)
  if (preview !== undefined) state.lastAssistant = preview
  state.lastAssistantHasQuestion = hasQuestionBlock(text)
  const fence = parseSignalFence(text)
  state.lastFence = fence && state.lastAssistantAt ? { ...fence, at: state.lastAssistantAt } : fence
}

// Fold one NORMALIZED event into the backend-neutral accumulator — the codex-facing counterpart to
// applyRecord (which folds raw Claude records). A backend whose turn model maps cleanly onto
// NormalizedEvent (codex's explicit task_started/task_complete brackets) drives its fold as
// `for (const ev of parseLine(line)) applyEvent(state, ev)`; it produces the SAME FoldState fields
// applyRecord does, so the tailer/board consume either identically. Claude does NOT use this path —
// its 3-way stop_reason + 5s backstop turn signal can't round-trip through the union without loss
// (see the NOTE on NormalizedEvent in backend/types.ts).
export function applyEvent(state: FoldState, ev: NormalizedEvent): void {
  // Every timestamped event advances the activity clock (events map 1:1 to substantive lines; only the
  // untimestamped `title` lacks an `at`). Folded in file order, so the latest `at` wins.
  if ("at" in ev && typeof ev.at === "string") state.lastActivityAt = ev.at
  switch (ev.kind) {
    case "turn-start":
      // A turn opened → the agent is working.
      state.sawRecords = true
      state.turn = "in-flight"
      break
    case "turn-end":
      // A turn bracketed closed → idle. finalText (when the backend carries the final message on the
      // bracket) is authoritative: (re)derive preview + question/excusal fence from it. The bracket's
      // `at` is the agent's rest time — the queue/at-rest-label key (see NormalizedTail.lastAssistantAt).
      state.sawRecords = true
      state.turn = "idle"
      if (typeof ev.at === "string") state.lastAssistantAt = ev.at
      if (ev.finalText !== undefined) applyFinalText(state, ev.finalText)
      break
    case "assistant-text":
      // Streamed assistant text. The FINAL answer sets preview + question/excusal fence; a non-final
      // (commentary) block only refreshes the row preview and must NOT carry a fence. Turn state is
      // untouched — the turn brackets on turn-start/turn-end, not on a text block. A FINAL block's `at`
      // is the agent's own output time → the rest-time key (turn-end usually carries the same instant).
      state.sawRecords = true
      if (ev.final) {
        if (typeof ev.at === "string") state.lastAssistantAt = ev.at
        applyFinalText(state, ev.text)
      } else {
        const preview = previewText(ev.text)
        if (preview !== undefined) state.lastAssistant = preview
      }
      break
    case "user-message":
      // A human/peer/notification turn re-opens the turn (the model is about to respond → in-flight)
      // and supersedes any pending question / excusal fence (they only signal as the FINAL message).
      // Only a GENUINE human turn bumps lastUserAt — a synthetic one (peer msg / notification /
      // tool-result echo) is machine motion the human didn't cause, so it never jumps the row.
      state.sawRecords = true
      state.turn = "in-flight"
      state.lastAssistantHasQuestion = false
      state.lastFence = undefined
      if (!ev.synthetic) {
        if (typeof ev.at === "string") state.lastUserAt = ev.at
        if (typeof ev.text === "string") state.lastUserText = ev.text
      }
      break
    case "tool-call":
    case "tool-result":
      // Agent activity mid-turn: it advanced the activity clock (above) but doesn't move the turn
      // (still bracketed in-flight) or the preview. Codex has no sub-agent/bg-shell tracking to fold;
      // Claude's rich tool tracking rides applyRecord, never this path. NOTE (deliberate divergence
      // from applyRecord's user arm): a tool-result does NOT clear lastFence/lastAssistantHasQuestion —
      // tool activity is mid-turn (a user-message re-open already cleared any prior-turn fence, and the
      // final message recomputes it), so a normalized backend must not let tool motion excuse a fence.
      state.sawRecords = true
      break
    case "title":
      // The backend's own session auto-title (codex thread title / Claude ai-title). Never touches turn.
      state.aiTitle = ev.title
      break
  }
}

// Derive the turn state from the folded tail (see the header heuristic). `nowMs` drives only the
// unknown-stop-reason backstop; a clear end_turn/tool_use is time-independent.
export function computeTurn(state: TailState, nowMs: number): TurnState {
  if (state.lastKind === "assistant") {
    if (state.lastStopReason === "end_turn") return "idle"
    if (state.lastStopReason === "tool_use") return "in-flight"
    // unknown/missing stop_reason: only the 5s-silence backstop can call it idle
    const at = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN
    if (Number.isFinite(at) && nowMs - at > IDLE_BACKSTOP_MS) return "idle"
    return "in-flight"
  }
  // A backend that brackets turns EXPLICITLY never sets lastKind (codex: applyEvent writes `state.turn`
  // directly on task_started/task_complete and touches neither lastKind nor lastStopReason) — trust its
  // folded turn verbatim instead of clobbering it back to in-flight. This is BEHAVIOR-NEUTRAL for Claude:
  // applyRecord assigns lastKind on EVERY substantive record (tailer.ts:633/653) and never clears it, so
  // for Claude `lastKind === undefined` holds ONLY before any substantive record — and there `state.turn`
  // is still the newTailState "in-flight" the old fallthrough returned. For codex it makes the explicit
  // task_started/task_complete brackets authoritative (the fix: a folded `idle` survives the tick).
  if (state.lastKind === undefined) return state.turn
  // last substantive record was a user prompt/tool_result → in-flight (the model is about to respond)
  return "in-flight"
}

// A compact change-key for a session's derived sub-agent view — lets the tick mark the board dirty
// on any add / removal / running→stale transition (a completion clears an entry WITHOUT touching
// lastActivityAt, so without this the suffix would linger until the next full reconcile).
function subAgentSignature(views: SubAgentView[]): string {
  return views.map((v) => `${v.label}\u0000${v.state}\u0000${v.startedAt}`).join("\u0001")
}

// Order-sensitive equality of two fresh-foreign sets (id order = mtime desc). A membership OR ordering
// change means the board's foreign rows changed → the tick marks itself dirty.
function sameForeign(a: { id: string }[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false
  return true
}

export interface Tailer {
  get(slug: string): SessionTelemetry | undefined
  // FOREIGN session ids (JSONL files in the project dir with no registry row — maintainer terminals)
  // whose transcript is FRESH (recent mtime): the board lists these as read-only session threads.
  // Keyed by session id (the thread id for a foreign thread IS its session id).
  foreignIds(): string[]
  // Drill-in drawer lookup: a tracked or retained sub-agent's transcript path + state, or undefined if
  // unknown (never dispatched, or aged out of the retained ring). The router maps undefined → "gone".
  subAgent(slug: string, id: string): { outputFile?: string; state: "running" | "stale" | "done" } | undefined
  // Drop a session's in-memory tail state (registered + foreign) — called when its row is hard-deleted
  // (forgetSession) so a stale TailState bound to the gone transcript can't mis-tail a later same-slug
  // re-dispatch. A no-op for an unknown slug.
  forget(slug: string): void
  // Record the launch value after the controller has synchronously folded every sidecar written
  // during the handoff. Any later backend record remains authoritative (for example a model/version
  // that rejects or coerces a requested mode).
  notePermissionMode?(slug: string, permissionMode: PermissionMode): void
  start(): void
  stop(): void
  tick(): void // exposed for tests + boot; the interval calls it every POLL_MS
}

export interface TailerDeps {
  project: Project
  storage: Storage
  bus: Bus
  onChange: () => void // triggers a board rebuild when derived state changes (batched: ≤1/tick)
  // Reports the sessions whose JSONL advanced this tick (bytes consumed) — the exact signal that a
  // thread's rendered transcript may have changed. The /ws transcript producer uses it to push updates
  // to subscribed clients (replacing the client's 1.5s poll). Optional: unset = no transcript push.
  onTranscriptChange?: (slugs: string[]) => void
  now?: () => number // injectable clock (tests)
  paneDead?: (slug: string) => boolean // injectable liveness (tests)
  capturePane?: (slug: string) => string // injectable pane text (tests); defaults to tmux
  findExpectedAdoptionPane?: (expected: tmux.ExpectedAdoptionPane) => tmux.AdoptionPaneLookup
  captureExpectedAdoptionPane?: (expected: tmux.ExpectedAdoptionPane) => tmux.ExactPaneCapture
  sessionLogDir?: string // injectable transcript dir (tests); defaults to the Claude Code path
  mtimeMs?: (path: string) => number | undefined // injectable file mtime (tests); a sub-agent transcript's staleness clock
  // The agent backend that locates + folds a session's transcript (Codex-support epic). Injected by
  // the composition layer as a ClaudeBackend; when absent (tests) the tailer folds with its own
  // corpus-verified applyRecord + deterministic Claude path — a byte-identical default.
  backend?: AgentBackend
  // Per-session backend resolver (Codex-support epic, Phase 2): the tailer picks a backend per ROW by
  // its `backend` column so a codex row folds through the codex rollout parser while every claude row
  // (and all foreign maintainer terminals) stays on the corpus-verified Claude fold. Injected by the
  // composition layer; when absent (tests) the single `backend`/default Claude fold covers every row —
  // byte-identical to before. Takes precedence over `backend` when both are set.
  backendFor?: (kind?: string) => AgentBackend
  // The structured PermissionRequest signal (Claude workers with the cc-worker plugin): the worker's
  // perm-observe.mjs hook drops `<stateDir>/perm-requests/<slug>.json` the instant Claude creates a
  // tool-approval prompt. Injectable for tests; the default reads that file. Absent stateDir (narrow
  // test fixtures) → always undefined, so the pane-sniff regex fallback covers exactly as before.
  readPermMarker?: (slug: string) => PermMarker | undefined
}

// The durable "blocked on <tool>" marker written by the worker's PermissionRequest hook. `at` is the
// ISO time the request was created; the tailer treats the marker as an ACTIVE block only while `at` is
// newer than the last transcript activity (a resolved request always advances the transcript past it).
export interface PermMarker {
  slug: string
  tool: string | null
  promptId: string | null
  permissionMode: string | null
  at: string
}

function isPermMarker(v: unknown): v is PermMarker {
  if (!v || typeof v !== "object") return false
  const m = v as Partial<PermMarker>
  return typeof m.slug === "string" && typeof m.at === "string"
}

// A sub-agent transcript's mtime in epoch-ms, or undefined if it can't be stat'd (not yet created,
// unreadable). Telemetry-grade: a stat failure degrades to "can't assess staleness", never throws.
function defaultMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

// The Claude Code per-project transcript dir: ~/.claude/projects/<cwdSlug>/. Exported so the
// composition layer can construct the matching ClaudeBackend (its transcriptPath appends the id).
export function defaultLogDir(project: Project): string {
  return join(homedir(), ".claude", "projects", project.cwdSlug)
}

// Reads the worker's PermissionRequest marker from the per-project stateDir. Telemetry-grade: a missing
// stateDir (narrow test fixtures), an absent/half-written/corrupt file all degrade to undefined — the
// pane-sniff fallback then covers exactly as before. Never throws.
function defaultReadPermMarker(project: Project): (slug: string) => PermMarker | undefined {
  if (!project.stateDir) return () => undefined
  return (slug) => {
    try {
      const parsed = JSON.parse(readFileSync(permMarkerPath(project, slug), "utf8"))
      return isPermMarker(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
}

// The slice of AgentBackend the tailer drives: locate a session's transcript, fold a raw line into
// the accumulator, and (registered sessions only) sniff the pane for a permission prompt.
type TailBackend = Pick<AgentBackend, "transcriptPath" | "foldLine" | "matchesPermPrompt" | "detectNativeInput">

export function createTailer(deps: TailerDeps): Tailer {
  const now = deps.now ?? Date.now
  // Cached (batched list-panes): the 1s tick asks per session row — uncached that was one
  // subprocess per row per second, a standing event-loop tax that grew with thread count.
  const paneDead = deps.paneDead ?? tmux.paneDeadCached
  const capturePane = deps.capturePane ?? tmux.capturePane
  const findExpectedAdoptionPane = deps.findExpectedAdoptionPane ?? tmux.findExpectedAdoptionPane
  const captureExpectedAdoptionPane = deps.captureExpectedAdoptionPane ?? tmux.captureExpectedAdoptionPane
  const logDir = deps.sessionLogDir ?? defaultLogDir(deps.project)
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs
  const readPermMarker = deps.readPermMarker ?? defaultReadPermMarker(deps.project)

  function adoptionBinding(row: SessionRow) {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    return binding
  }

  function paneDeadForRow(row: SessionRow): boolean {
    const binding = adoptionBinding(row)
    if (binding.kind === "unbound") return paneDead(row.slug)
    if (binding.kind === "conflict") return true
    const current = findExpectedAdoptionPane(binding.claim)
    return current.kind !== "found" || current.pane.dead
  }

  function capturePaneForRow(row: SessionRow): string {
    const binding = adoptionBinding(row)
    if (binding.kind === "unbound") return capturePane(row.slug)
    if (binding.kind === "conflict") return ""
    const captured = captureExpectedAdoptionPane(binding.claim)
    return captured.kind === "captured" ? captured.text : ""
  }
  // Default backend = this file's own corpus-verified Claude fold (identical to the injected
  // ClaudeBackend, which reuses the same applyRecord/parseLine/matchesPermPrompt). Tests never inject
  // a backend, so this default is the regression-proof path.
  const defaultBackend: TailBackend = {
    transcriptPath: (sessionId) => join(logDir, `${sessionId}.jsonl`),
    foldLine: (state, line) => {
      const rec = parseLine(line)
      // The tailer only ever hands foldLine the concrete TailState it constructs; applyRecord needs
      // Claude's full accumulator (sub-agent/ask tracking, lastKind/lastStopReason) the neutral
      // FoldState doesn't carry, so narrow back to it. Byte-identical to the pre-refactor fold.
      if (rec) applyRecord(state as TailState, rec)
    },
    matchesPermPrompt,
  }
  // Resolve the backend for a row by its `backend` column. Prod injects `backendFor` (claude|codex);
  // a single injected `backend` or the local default covers every row otherwise. For claude (and every
  // foreign maintainer terminal) this is the corpus-verified Claude fold — byte-identical to before.
  function resolveBackend(kind?: string): TailBackend {
    return deps.backendFor?.(kind) ?? deps.backend ?? defaultBackend
  }

  function persistCodexAutoTitle(row: SessionRow, state: TailState, runtimeGeneration: number): boolean {
    if (row.backend !== "codex" || !state.aiTitle?.trim()) return false
    try {
      return deps.storage.setAutoTitleIfCurrent(row.slug, state.aiTitle.trim(), {
        sessionId: row.session_id,
        nativeSessionId: row.agent_session_id ?? null,
        runtimeGeneration,
      })
    } catch {
      // Telemetry still carries the transcript-backed title for this process. A transient registry
      // write failure must not break tailing; the full replay on restart safely retries the same CAS.
      return false
    }
  }

  // Derive the surfaced view of a session's live sub-agents (insertion = dispatch order). A tracked
  // entry whose transcript file hasn't been touched in SUBAGENT_STALE_MS is reported "stale" — a
  // liveness fallback for a completion record we missed; one still being appended to is "running".
  // A tracked child is "stale" once we've resolved its transcript path and that file has gone
  // SUBAGENT_STALE_MS without an append (or no longer stats) — a liveness fallback for a completion we
  // missed. Before the path resolves (fresh dispatch) it stays "running" — it's just starting up.
  function entryStale(e: SubAgentEntry, nowMs: number): boolean {
    if (!e.outputFile) return false
    const m = mtimeMs(e.outputFile)
    return m === undefined || nowMs - m > SUBAGENT_STALE_MS
  }

  // Derive the surfaced view of a session's live SUB-AGENTS (kind "agent"; insertion = dispatch order).
  function subAgentViews(state: TailState, nowMs: number): SubAgentView[] {
    if (state.subAgents.size === 0) return []
    const out: SubAgentView[] = []
    for (const e of state.subAgents.values()) {
      if (e.kind !== "agent") continue
      out.push({ label: e.label, startedAt: e.startedAt, state: entryStale(e, nowMs) ? "stale" : "running", subagentType: e.subagentType, id: e.toolUseId })
    }
    return out
  }

  // Derive the surfaced view of a session's live background SHELLS (kind "shell"; display-only).
  // A background Bash/Monitor is a CHILD of the agent process inside this session's tmux pane — it
  // cannot outlive it. So a dead pane (the agent exited/crashed WITHOUT emitting each shell's terminal
  // <task-notification>) means every tracked shell died with it: report none rather than leaving them
  // to read as live (the UI would otherwise show them "alive", quietly breathing, forever). The normal
  // path — a shell exiting while the agent lives — still clears via its terminal notification.
  function bgShellViews(state: TailState, nowMs: number): BgShellView[] {
    if (state.subAgents.size === 0 || state.paneDead) return []
    const out: BgShellView[] = []
    for (const e of state.subAgents.values()) {
      if (e.kind !== "shell") continue
      out.push({ label: e.label, startedAt: e.startedAt, state: entryStale(e, nowMs) ? "stale" : "running" })
    }
    return out
  }

  // A compact change-key over ALL derived background state — sub-agents + shells + the pending ask —
  // so the tick marks the board dirty on any add/removal, running→stale flip (purely time-based, no new
  // record), or an ask appearing/clearing. Without it those changes would linger to the next reconcile.
  function derivedSignature(state: TailState, nowMs: number): string {
    const agents = subAgentViews(state, nowMs).map((v) => `A:${v.label}|${v.state}|${v.startedAt}`).join("")
    const shells = bgShellViews(state, nowMs).map((v) => `S:${v.label}|${v.state}|${v.startedAt}`).join("")
    const ask = state.pendingAsk ? `Q:${state.pendingAsk.id}:${state.pendingAsk.questions.length}` : ""
    return `${agents}\n${shells}\n${ask}`
  }

  // Resolve a tracked sub-agent (thread slug + dispatch tool_use id) to its transcript path + state —
  // the drill-in drawer's server-side lookup. Checks the LIVE map first (running/stale), then the
  // RETAINED ring (a completed child kept for review → "done"). Undefined only when the id is unknown
  // to both (never dispatched, or aged out of the ring) → the router maps that to "gone".
  function subAgentLookup(slug: string, id: string): { outputFile?: string; state: "running" | "stale" | "done" } | undefined {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return undefined
    const live = state.subAgents.get(id)
    if (live) return { outputFile: live.outputFile, state: entryStale(live, now()) ? "stale" : "running" }
    const dead = state.retiredSubAgents.get(id)
    if (dead) return { outputFile: dead.outputFile, state: "done" }
    return undefined
  }

  interface PaneSniff {
    permPrompt: boolean
    nativeInputRequired?: NativeInputRequiredData
  }

  function sameNativeInput(a: NativeInputRequiredData | undefined, b: NativeInputRequiredData | undefined): boolean {
    return a?.kind === b?.kind && a?.title === b?.title
  }

  // A live PermissionRequest marker (Claude workers with the fray plugin) is an ACTIVE block iff its
  // timestamp is newer than the last transcript activity — a resolved request always advances the
  // transcript past it. The caller gates this on turn === "in-flight" (a real block is always mid
  // tool_use) and on the row being non-codex, which both bounds the per-tick file read to actively-
  // working Claude sessions and means a stale marker on a crashed/exited pane is inert (deriveRuntime
  // returns "exited" before it ever consults permPrompt).
  function permMarkerBlocks(state: TailState, row: SessionRow): boolean {
    const marker = readPermMarker(row.slug)
    if (!marker) return false
    const at = Date.parse(marker.at)
    if (!Number.isFinite(at)) return false
    // Stale-generation guard: a marker written BEFORE this process generation's spawn belongs to an
    // already-ended block — e.g. a worker killed while parked on a prompt, then resumed. spawned_at is
    // bumped to the current generation on every (re)spawn (storage.beginRuntimeGeneration), so on prime
    // the replayed old transcript (lastActivityAt < at) would otherwise flash "Needs you" until the
    // resume record lands. An unparseable spawned_at skips this guard (never suppress a live block).
    const spawnedMs = Date.parse(row.spawned_at)
    if (Number.isFinite(spawnedMs) && at < spawnedMs) return false
    const last = state.lastActivityAt ? Date.parse(state.lastActivityAt) : Number.NEGATIVE_INFINITY
    return at > last
  }

  // Perm-blocked verdict for a session. PRIMARY: the structured PermissionRequest marker — precise (it
  // fires exactly when Claude created the prompt), so it surfaces immediately with no quiet-gate delay
  // and cannot false-trip on transcript text that merely LOOKS like a prompt. FALLBACK (unchanged): a
  // pane-sniff of a quiet in-flight turn, for the screens that emit no PermissionRequest (pre-boot
  // workspace-trust, /login and other selectors) and for plugin-less foreign sessions. The native
  // structured detector (Codex) still rides the same single capture.
  //
  // KNOWN EDGE (accepted): a background sub-agent completing WHILE the parent is blocked appends a
  // system user-record that advances lastActivityAt past the marker, so permMarkerBlocks briefly reads
  // false. This is not a regression — it degrades to the regex fallback, which re-detects the real
  // modal after PERM_SNIFF_MS of quiet (the same latency the pre-marker path always had).
  function sniffPane(
    state: TailState,
    row: SessionRow,
    turn: TurnState,
    nowMs: number,
    backend: TailBackend,
  ): PaneSniff {
    if (state.foreign) return { permPrompt: false } // structural: foreign threads never touch tmux
    if (turn === "in-flight" && row.backend !== "codex" && permMarkerBlocks(state, row)) {
      return { permPrompt: true }
    }
    if (!state.nativeInputRequired) {
      if (turn !== "in-flight" || !state.lastActivityAt) return { permPrompt: false }
      const at = Date.parse(state.lastActivityAt)
      if (!Number.isFinite(at) || nowMs - at < PERM_SNIFF_MS) return { permPrompt: false }
    }

    const pane = capturePaneForRow(row)
    const detected = backend.detectNativeInput?.(pane)
    return {
      permPrompt: backend.matchesPermPrompt?.(pane) ?? false,
      nativeInputRequired: detected,
    }
  }
  const states = new Map<string, TailState>()
  // FOREIGN thread tails, keyed by session id (separate map so a session-id key can never collide
  // with or shadow a registered slug's TailState in `states`). Entries persist once discovered — a
  // file that ages out of the fresh set keeps its cached tail here but stops being reported.
  const foreignStates = new Map<string, TailState>()
  // The current fresh foreign set (mtime-desc, capped), refreshed on scan ticks and reused between.
  let foreignFresh: { id: string; path: string }[] = []
  let foreignScanTick = 0
  let timer: NodeJS.Timeout | null = null

  // Discover FOREIGN sessions: *.jsonl in the log dir whose stem is not any registered row's
  // session_id, touched within FOREIGN_FRESH_MS, most-recent-first, capped at FOREIGN_MAX. Registered
  // rows always win. Defensive: any fs error (dir/file) is skipped silently — discovery degrades to
  // "no foreign threads", never throws.
  function scanForeign(nowMs: number): { id: string; path: string }[] {
    let names: string[]
    try {
      names = readdirSync(logDir)
    } catch {
      return []
    }
    const registered = new Set<string>()
    for (const r of deps.storage.allSessions()) {
      registered.add(r.session_id)
      // A DISCOVERED (drifted) transcript is owned by its row — exclude its id too, or the re-linked
      // file would resurface as a duplicate read-only "foreign" thread (split-brain).
      if (r.transcript_id) registered.add(r.transcript_id)
    }
    // Graveyard: a transcript whose row was hard-deleted via forgetSession must STAY gone — never let a
    // dismissed phantom's *.jsonl re-surface as a read-only foreign thread on a later rescan.
    for (const id of deps.storage.forgottenIds()) registered.add(id)
    const found: { id: string; path: string; mtime: number }[] = []
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".jsonl")) continue
      const id = name.slice(0, -".jsonl".length)
      if (!id || registered.has(id)) continue // registered rows win — never also foreign
      const path = join(logDir, name)
      let mtime: number
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (nowMs - mtime > FOREIGN_FRESH_MS) continue // aged out of the freshness window
      found.push({ id, path, mtime })
    }
    found.sort((a, b) => b.mtime - a.mtime)
    return found.slice(0, FOREIGN_MAX).map(({ id, path }) => ({ id, path }))
  }

  // Tail one FOREIGN state: same fold/derivation as a registered session (consume → computeTurn →
  // derivedSignature, priming the first sighting silently) but with NO pane sniff, NO pane-death
  // check, and NO notify / storage write — a foreign thread has no tmux session and no registry row.
  // Returns whether its derived telemetry changed (→ board dirty). Pushes to transcriptDirty on bytes.
  function tailForeign(state: TailState, nowMs: number, transcriptDirty: string[], backend: TailBackend): boolean {
    if (!state.primed) {
      const primeOffset = state.offset
      consume(state, backend)
      if (state.offset !== primeOffset) transcriptDirty.push(state.slug)
      state.turn = computeTurn(state, nowMs)
      state.subAgentsSig = derivedSignature(state, nowMs)
      state.primed = true
      return true // surface the newly-discovered thread
    }
    const prevActivity = state.lastActivityAt
    const prevAssistant = state.lastAssistant
    const prevModel = state.model
    const prevEffort = state.effort
    const prevPermissionMode = state.permissionMode
    const prevOffset = state.offset
    consume(state, backend)
    if (state.offset !== prevOffset) transcriptDirty.push(state.slug)
    let dirty = false
    const nextTurn = computeTurn(state, nowMs)
    if (state.turn !== nextTurn) {
      state.turn = nextTurn // foreign: a turn transition NEVER notifies or writes storage
      dirty = true
    }
    const sig = derivedSignature(state, nowMs)
    if (sig !== state.subAgentsSig) {
      state.subAgentsSig = sig
      dirty = true
    }
    if (
      state.lastActivityAt !== prevActivity ||
      state.lastAssistant !== prevAssistant ||
      state.model !== prevModel ||
      state.effort !== prevEffort ||
      state.permissionMode !== prevPermissionMode
    ) dirty = true
    return dirty
  }

  // Read whatever has been appended since our last offset, folding each complete line into the
  // derivation. Handles: file-not-yet-created (ENOENT → skip), truncation/rotation (size < offset
  // → re-read from 0), and a trailing partial line (buffered until its newline arrives).
  function consume(state: TailState, backend: TailBackend): void {
    let size: number
    try {
      size = statSync(state.path).size
    } catch {
      return // file not written yet (agent still booting) or transiently unreadable
    }
    if (size < state.offset) {
      // truncated/rotated — restart the derivation from the top of the new file
      state.offset = 0
      state.partial = ""
    }
    if (size <= state.offset) return
    let chunk = ""
    try {
      const fd = openSync(state.path, "r")
      try {
        const buf = Buffer.allocUnsafe(size - state.offset)
        const read = readSync(fd, buf, 0, buf.length, state.offset)
        chunk = buf.toString("utf8", 0, read)
        state.offset += read
      } finally {
        closeSync(fd)
      }
    } catch {
      return // read raced with a write/unlink — try again next tick
    }
    const lines = (state.partial + chunk).split("\n")
    state.partial = lines.pop() ?? "" // last element is the (possibly empty) trailing partial
    for (const line of lines) backend.foldLine(state, line)
  }

  // Every OTHER row's pinned + discovered id — the exclude set so discovery never steals a transcript
  // already claimed by a different thread. (Only called on a real discovery attempt, which is rare.)
  function claimedIds(exceptSlug: string): Set<string> {
    const ids = new Set<string>()
    for (const r of deps.storage.allSessions()) {
      if (r.slug === exceptSlug) continue
      ids.add(r.session_id)
      if (r.transcript_id) ids.add(r.transcript_id)
    }
    return ids
  }

  // Capture a stalled worker's (remain-on-exit) pane ONCE, so claude's own boot-failure output survives
  // to the server console + a per-session sink before the pane is ever killed. Best-effort — the whole
  // point is root-causing the missing transcript, but a capture failure must never break the tick.
  function captureStall(state: TailState, row: SessionRow): void {
    if (state.stallLogged) return
    state.stallLogged = true
    let pane = ""
    try {
      pane = capturePaneForRow(row)
    } catch {
      pane = ""
    }
    // Boot-failure auth classifier (claude-auth plan): a worker that dies before writing a transcript
    // with the 401/login text on its pane is a rejected credential, not a generic stall. Only the
    // typed category persists — the raw pane (which may carry OAuth URLs/codes from a login attempt)
    // is REDACTED from the console line and the stall sink in this case.
    const authFailure = row.backend !== "codex" && isClaudeAuthErrorText(pane)
    if (authFailure) state.authFault = "authentication_rejected"
    const detail = authFailure
      ? "(claude authentication failure — pane content redacted; sign in and retry)"
      : pane.trim() || "(pane empty / unavailable)"
    console.error(
      `[fray-ui] thread ${row.slug} (session ${row.session_id}): no transcript ${DISCOVERY_GRACE_MS / 1000}s after dispatch — likely a boot failure. Pane:\n${detail.slice(0, 4000)}`,
    )
    try {
      mkdirSync(STALL_LOG_DIR, { recursive: true })
      writeFileSync(join(STALL_LOG_DIR, `${row.slug}.stall.log`), `session_id: ${row.session_id}\ncaptured_at: ${new Date(now()).toISOString()}\n\n${detail}\n`)
    } catch {
      // best-effort — a missing sink is inert
    }
  }

  // READ-SIDE TRANSCRIPT DISCOVERY for a registered row whose bound file hasn't produced bytes yet.
  // Byte-identical for the healthy path: once a file binds (offset > 0) this is a no-op, and a
  // within-grace missing file is left to the ordinary spinning-up spinner. ONLY a past-grace missing
  // file engages discovery (throttled); on a hit it re-links + caches the drifted transcript and replays
  // it silently (primed=false → the next prime adopts it with no notify), on a miss it flags the row
  // no-transcript (a boot failure) so the board shows a degraded state, not an eternal spinner.
  function resolveTranscript(state: TailState, row: SessionRow, nowMs: number): boolean {
    if (state.offset > 0) return true // already bound to a real transcript — the normal path, untouched
    // Presence alone isn't enough: a worker that creates `<id>.jsonl` then crashes before writing a
    // single record leaves a permanent 0-byte file. Treat empty-or-missing alike so a touched-but-never-
    // written transcript can't silently defeat the crash-net (found in review). A stat failure → size 0.
    let size = 0
    try {
      size = statSync(state.path).size
    } catch {
      size = 0
    }
    if (size > 0) {
      // Real content present (or just appeared) — clear any prior degraded state and let consume bind it.
      state.noTranscript = false
      state.stallLogged = false
      return true
    }
    // Empty/missing but still within the grace window → an ordinary just-spawned session (spinner). Wait.
    const spawnedMs = Date.parse(row.spawned_at)
    if (Number.isFinite(spawnedMs) && nowMs - spawnedMs < DISCOVERY_GRACE_MS) return true
    // Past grace, still missing: attempt discovery (throttled), else declare the transcript missing.
    if (nowMs < state.nextDiscoverMs) return true
    state.nextDiscoverMs = nowMs + DISCOVER_RETRY_MS
    const found = discoverTranscriptId(logDir, row.session_id, { nowMs, exclude: claimedIds(row.slug) })
    if (found && found !== row.session_id) {
      // Commit ownership before touching the in-memory path. A stale A snapshot must never bind A's
      // discovered transcript under a same-slug replacement B, even transiently between tail ticks.
      let committed = false
      try {
        committed = deps.storage.setTranscriptIdIfCurrent(
          row.slug,
          row.session_id,
          row.runtime_generation ?? 0,
          found,
        )
      } catch {
        committed = false
      }
      if (!committed) return false
      // Re-link to the drifted transcript: rebind the read path, cache it (survives restart + dedupes
      // foreign discovery), and replay it as a fresh prime so no historical turn-done fires spuriously.
      state.path = join(logDir, `${found}.jsonl`)
      state.offset = 0
      state.partial = ""
      state.primed = false
      state.noTranscript = false
      state.stallLogged = false
      return true
    }
    // Nothing to bind: the worker never wrote a transcript → degraded/stalled, captured once for triage.
    state.noTranscript = true
    captureStall(state, row)
    return true
  }

  function tick(): void {
    // Discover sessions from the registry so dispatch/resume/restart all "just work" — a new row
    // starts being tailed on the next tick; a finished row keeps its final derived state.
    let dirty = false
    // Slugs whose JSONL advanced this tick (offset moved) → their transcript may have changed. Fed to the
    // /ws transcript producer at the end so it pushes only for genuinely-changed threads.
    const transcriptDirty: string[] = []
    const nowMs = now()
    for (const row of deps.storage.allSessions()) {
      // Per-row backend + the DISCOVERED transcript stem. Both backends decouple the transcript id from
      // the pinned session_id, via DIFFERENT columns (only one is ever set): codex pins its rollout id on
      // `agent_session_id` (post-dispatch discovery); claude caches a drifted stem on `transcript_id`
      // (read-side discovery). So `agent_session_id ?? transcript_id ?? session_id` is the effective stem
      // for either — a claude row (agent_session_id NULL) falls to transcript_id ?? session_id (its old
      // deterministic path); a codex row (transcript_id NULL) falls to agent_session_id ?? session_id.
      const backend = resolveBackend(row.backend)
      const nativeId = row.agent_session_id ?? row.transcript_id ?? row.session_id
      let state = states.get(row.slug)
      const runtimeGeneration = row.runtime_generation ?? 0
      if (
        !state ||
        state.sessionId !== row.session_id ||
        state.nativeSessionId !== nativeId ||
        state.runtimeGeneration !== runtimeGeneration
      ) {
        // claude.transcriptPath always returns the logDir join; codex.transcriptPath resolves the
        // date-sharded rollout by id (or undefined before its id is pinned → the join is a harmless
        // placeholder until discovery pins it).
        const path = backend.transcriptPath(nativeId) ?? join(logDir, `${nativeId}.jsonl`)
        state = newTailState(row.slug, row.session_id, path, false, nativeId, runtimeGeneration)
        states.set(row.slug, state)
      }

      // Read-side discovery: rebind a drifted transcript / flag a boot-failure stall. A no-op for a
      // healthy bound session (offset > 0). May rebind + reset primed → the prime branch below replays
      // the discovered file silently. Track noTranscript flips so the degraded runtime surfaces promptly.
      // CLAUDE-ONLY: the discovery scan targets the claude log dir + scratchpad sentinel; a codex row
      // locates its rollout by the agent_session_id pinned at dispatch, so running claude discovery on it
      // would wrongly flag noTranscript (a codex discovery-miss is a separate follow-up).
      const prevNoTranscript = state.noTranscript
      if (row.backend !== "codex" && !resolveTranscript(state, row, nowMs)) continue

      // First sighting of a session (fresh dispatch OR restored after a server restart): read the
      // whole transcript to date and adopt its state as the baseline WITHOUT firing turn-done /
      // exited notifies — those pre-restart events are history, not new activity.
      if (!state.primed) {
        const primeOffset = state.offset
        consume(state, backend)
        persistCodexAutoTitle(row, state, runtimeGeneration)
        if (state.offset !== primeOffset) transcriptDirty.push(row.slug)
        state.turn = computeTurn(state, nowMs)
        const pane = sniffPane(
          state,
          row,
          state.turn,
          nowMs,
          backend,
        )
        state.permPrompt = pane.permPrompt
        state.nativeInputRequired = pane.nativeInputRequired
        state.paneDead = paneDeadForRow(row)
        state.subAgentsSig = derivedSignature(state, nowMs)
        state.primed = true
        if (state.permissionMode) {
          const saved = PermissionMode.safeParse(row.permission_mode)
          const observedAt = state.permissionModeAt ? Date.parse(state.permissionModeAt) : NaN
          const spawnedAt = Date.parse(row.spawned_at)
          // An idle reattach is not guaranteed to append a new profile sidecar before the next turn
          // (verified on both standalone TUIs). Preserve a valid exact launch mode across restart;
          // backfill only unknown legacy rows, or accept a timestamped Codex event from this process
          // generation. Incremental sidecars below still persist genuine live transitions.
          const observedIsCurrent = !saved.success || (row.backend === "codex" && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt)
          if (observedIsCurrent && (!saved.success || saved.data !== state.permissionMode)) {
            deps.storage.setObservedPermissionIfCurrent(
              row.slug,
              row.session_id,
              runtimeGeneration,
              state.permissionMode,
            )
          }
        }
        dirty = true // surface the restored overlay
        continue
      }

      const prevActivity = state.lastActivityAt
      const prevAssistant = state.lastAssistant
      const prevAiTitle = state.aiTitle
      const prevModel = state.model
      const prevEffort = state.effort
      const prevProfileRevision = state.profileRevision ?? 0
      const prevPermissionMode = state.permissionMode
      const prevPermissionRevision = state.permissionModeRevision ?? 0
      const prevOffset = state.offset
      // Snapshot the turn BEFORE the fold. A codex fold (applyEvent) writes state.turn INLINE on
      // task_started/task_complete, so by the time we diff below state.turn already holds the new value
      // — comparing against it would miss the transition (no turn-done notify). Claude's applyRecord
      // never touches state.turn (computeTurn derives it), so prevTurn === state.turn for claude here:
      // byte-identical. This makes the transition edge backend-agnostic.
      const prevTurn = state.turn
      consume(state, backend)
      const profileRecordLanded = (state.profileRevision ?? 0) !== prevProfileRevision
      if (profileRecordLanded && state.model && state.profileAt) {
        const observedAt = Date.parse(state.profileAt)
        const spawnedAt = Date.parse(row.spawned_at)
        const model = normalizeObservedThreadModel(row.backend ?? "claude", state.model)
        const effort = state.effort?.trim() || row.effort?.trim()
        if (model && effort && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt) {
          try {
            validateThreadProfile(row.backend ?? "claude", model, effort)
            deps.storage.setObservedProfileIfCurrent(
              row.slug,
              { sessionId: row.session_id, generation: runtimeGeneration },
              { model, effort },
            )
          } catch {
            // Unknown/incomplete provider telemetry is visible but never becomes a future launch target.
          }
        }
      }
      if (state.aiTitle !== prevAiTitle) persistCodexAutoTitle(row, state, runtimeGeneration)
      if (state.offset !== prevOffset) transcriptDirty.push(row.slug)

      // turn transition (in-flight → idle): a completed turn. Mark unread + notify, gated on
      // last_read_at so a turn the user has already scrolled past doesn't re-badge.
      const nextTurn = computeTurn(state, nowMs)
      if (prevTurn !== nextTurn) {
        if (prevTurn === "in-flight" && nextTurn === "idle") {
          onTurnDone(row, state)
          dirty = true
        } else {
          dirty = true // idle → in-flight (a new turn started): refresh the overlay badge
        }
        state.turn = nextTurn
      }

      // interactive permission prompt: no jsonl signal, so pane-sniff a quiet in-flight turn.
      // Cleared automatically once jsonl activity resumes (turn no longer quiet) or the pane stops
      // matching. Rides the board snapshot only — no notify, no unread (it's not a completed turn).
      const pane = sniffPane(
        state,
        row,
        nextTurn,
        nowMs,
        backend,
      )
      if (pane.permPrompt !== state.permPrompt) dirty = true
      if (!sameNativeInput(pane.nativeInputRequired, state.nativeInputRequired)) dirty = true
      state.permPrompt = pane.permPrompt
      state.nativeInputRequired = pane.nativeInputRequired

      // pane death (tmux remain-on-exit pane went dead) — the agent process exited.
      const dead = paneDeadForRow(row)
      if (dead && !state.paneDead) {
        onPaneDeath(row)
        dirty = true
      }
      state.paneDead = dead

      // live background ops + pending ask: a dispatch/completion/launch changes the set, a running→stale
      // flip is purely time-based (no new record), and an ask appears/clears — recompute every tick.
      const sig = derivedSignature(state, nowMs)
      if (sig !== state.subAgentsSig) {
        state.subAgentsSig = sig
        dirty = true
      }

      if (state.lastActivityAt !== prevActivity || state.lastAssistant !== prevAssistant || state.aiTitle !== prevAiTitle) dirty = true
      const permissionRecordLanded = (state.permissionModeRevision ?? 0) !== prevPermissionRevision
      if (permissionRecordLanded && state.permissionMode) {
        if (row.backend === "codex") {
          deps.storage.setObservedPermissionIfCurrent(row.slug, row.session_id, runtimeGeneration, state.permissionMode)
        } else {
          state.unconfirmedPermissionMode = state.permissionMode
          state.unconfirmedPermissionPolls = 0
        }
      }
      if (row.backend !== "codex" && state.unconfirmedPermissionMode) {
        const candidateMode = state.unconfirmedPermissionMode
        const confirmationPoll = (state.unconfirmedPermissionPolls ?? 0) + 1
        state.unconfirmedPermissionPolls = confirmationPoll
        const saved = PermissionMode.safeParse(row.permission_mode)
        const paneMode = detectClaudePermissionMode(capturePaneForRow(row))
        if (paneMode) {
          // A footer can redraw one or more polls after its sidecar. Keep a mismatched candidate:
          // the still-visible old footer remains authoritative for this tick, but must not consume
          // the revision edge that makes us retry once the matching footer appears.
          state.permissionMode = paneMode
          if (!saved.success || saved.data !== paneMode) {
            deps.storage.setObservedPermissionIfCurrent(row.slug, row.session_id, runtimeGeneration, paneMode)
          }
          if (paneMode === candidateMode || confirmationPoll >= CLAUDE_PERMISSION_CONFIRM_POLLS) {
            state.unconfirmedPermissionMode = undefined
            state.unconfirmedPermissionPolls = undefined
          }
        } else {
          if (saved.success) state.permissionMode = saved.data
          if (confirmationPoll >= CLAUDE_PERMISSION_CONFIRM_POLLS) {
            state.unconfirmedPermissionMode = undefined
            state.unconfirmedPermissionPolls = undefined
          }
        }
      }
      if (state.model !== prevModel || state.effort !== prevEffort || state.permissionMode !== prevPermissionMode) dirty = true
      // A no-transcript flip (grace expired with no file / a re-link cleared it) changes the derived
      // runtime but touches no activity/turn — mark dirty so the board rebuilds without waiting for the
      // periodic reconcile.
      if (state.noTranscript !== prevNoTranscript) dirty = true
    }

    // FOREIGN threads: refresh the fresh set on a scan tick (a change in membership/order is itself
    // dirty), then tail every fresh one (reusing the cached set between scans).
    if (foreignScanTick % FOREIGN_SCAN_EVERY === 0) {
      const next = scanForeign(nowMs)
      if (!sameForeign(next, foreignFresh)) dirty = true
      foreignFresh = next
    }
    foreignScanTick++
    // Foreign threads are Claude maintainer terminals discovered in the Claude log dir — always the
    // Claude fold (resolveBackend("claude") returns the injected ClaudeBackend, or the default).
    const foreignBackend = resolveBackend("claude")
    for (const f of foreignFresh) {
      let state = foreignStates.get(f.id)
      if (!state) {
        state = newTailState(f.id, f.id, f.path, true) // slug = session id = thread id for a foreign thread
        foreignStates.set(f.id, state)
      }
      if (tailForeign(state, nowMs, transcriptDirty, foreignBackend)) dirty = true
    }

    if (dirty) deps.onChange()
    if (transcriptDirty.length) deps.onTranscriptChange?.(transcriptDirty)
  }

  // in-flight → idle: the turn finished. Badge unread if this completion post-dates the last read,
  // and fire a one-shot turn-done notify (the transition itself is the dedupe).
  function onTurnDone(row: SessionRow, state: TailState): void {
    const generation = row.runtime_generation ?? 0
    const eventAt = state.lastActivityAt ?? new Date(now()).toISOString()
    // The rest moment drives the nav's most-recently-rested-first order. A DISCRETE event (once
    // per turn end), so rows move rarely and meaningfully — unlike continuous activity sorting.
    if (!deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, generation, eventAt)) return
    if (landsAfterRead(eventAt, row.last_read_at)) {
      deps.storage.setUnreadIfCurrent(row.slug, row.session_id, generation, true)
    }
    deps.bus.publish({
      type: "notify",
      slug: row.slug,
      kind: "turn-done",
      title: row.slug,
      body: state.lastAssistant,
    })
  }

  // pane death: stamp exited (keeps the stored column honest for the overlay) + badge unread +
  // one-shot exited notify.
  function onPaneDeath(row: SessionRow): void {
    const generation = row.runtime_generation ?? 0
    const eventAt = new Date(now()).toISOString()
    if (!deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, generation, eventAt)) return
    if (row.exited !== 1) {
      deps.storage.setExitedIfCurrent(row.slug, row.session_id, generation, true)
    }
    if (landsAfterRead(eventAt, row.last_read_at)) {
      deps.storage.setUnreadIfCurrent(row.slug, row.session_id, generation, true)
    }
    deps.bus.publish({ type: "notify", slug: row.slug, kind: "exited", title: row.slug, body: "Agent session ended" })
  }

  function registeredStateIsCurrent(state: TailState): boolean {
    const current = deps.storage.getSession(state.slug)
    return Boolean(
      current &&
      current.session_id === state.sessionId &&
      (current.runtime_generation ?? 0) === state.runtimeGeneration,
    )
  }

  return {
    get(slug) {
      // Registered states win the key; a foreign thread resolves by its session id (its thread id).
      const registered = states.get(slug)
      const s = registered && registeredStateIsCurrent(registered)
        ? registered
        : registered ? undefined : foreignStates.get(slug)
      if (!s) return undefined
      // pendingQuestion is DERIVED: the turn is at rest AND the latest assistant message still carries
      // an unanswered ```question fence (a user reply clears the flag and flips the turn in-flight).
      const pendingQuestion = s.turn === "idle" && s.lastAssistantHasQuestion
      const nowMs = now()
      return { turn: s.turn, permPrompt: s.permPrompt, nativeInputRequired: s.nativeInputRequired, model: s.model, effort: s.effort, profileAt: s.profileAt, profileRevision: s.profileRevision, permissionMode: s.permissionMode, permissionModeAt: s.permissionModeAt, permissionModeRevision: s.permissionModeRevision, lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant, aiTitle: s.aiTitle, customTitle: s.customTitle, customTitleRevision: s.customTitleRevision, subAgents: subAgentViews(s, nowMs), bgShells: bgShellViews(s, nowMs), pendingAsk: s.pendingAsk, pendingQuestion, lastUserAt: s.lastUserAt, lastUserText: s.lastUserText, lastFence: s.lastFence, noTranscript: s.noTranscript, authFault: s.authFault }
    },
    // The CURRENT fresh foreign session ids (mtime within FOREIGN_FRESH_MS, capped), mtime-desc. Kept
    // as the last scan's result — recomputed at most every FOREIGN_SCAN_EVERY ticks.
    foreignIds: () => foreignFresh.map((f) => f.id),
    subAgent: subAgentLookup,
    forget(slug) {
      states.delete(slug)
      foreignStates.delete(slug)
    },
    notePermissionMode(slug, permissionMode) {
      const state = states.get(slug)
      if (state) {
        state.permissionMode = permissionMode
        state.unconfirmedPermissionMode = undefined
        state.unconfirmedPermissionPolls = undefined
      }
    },
    start() {
      if (timer) return
      tick() // derive current state immediately (also restores state after a server restart)
      timer = setInterval(tick, POLL_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}

// An event "lands after last_read_at" when there is no prior read, or the event's timestamp is
// strictly newer than it. Bad/absent timestamps fail safe to marking unread.
function landsAfterRead(eventAt: string, lastReadAt: string | null): boolean {
  if (!lastReadAt) return true
  const e = Date.parse(eventAt)
  const r = Date.parse(lastReadAt)
  if (!Number.isFinite(e) || !Number.isFinite(r)) return true
  return e > r
}
