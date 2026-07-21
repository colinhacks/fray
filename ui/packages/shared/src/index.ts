import { z } from "zod"
import { InteractionLifecycle, InteractionOpaqueId, InteractionRevision, InteractionThreadSlug } from "./interactions.ts"
import { THREAD_SLUG_MAX_CHARS, ThreadSlug } from "./thread-slug.ts"

// A Codex submit key is deliberately never replayed after Fray persists it: the process may have
// accepted the key even if its transcript confirmation was lost. After this bounded observation
// window the queue becomes explicitly recoverable by the human instead of blocking forever.
export const CODEX_INPUT_CONFIRMATION_TIMEOUT_MS = 30_000

// ---- Attachment intake (drag/drop, paste, file picker) ----
// The "safe tier": formats an agent's Read/file tool consumes with NO conversion step, so a dropped
// file lands on disk and its absolute path — inserted as plain text into the message — is read directly
// by both backends. Images render inline in chat AND are seen visually by Claude/Codex; the doc/text/
// code set is read as text (or, for PDF, natively rendered by Claude's Read). Office formats
// (docx/xlsx/pptx) are DELIBERATELY excluded — they'd reach the agent as opaque zip/XML garbage.
// Inline-renderable raster images: served back to the chat via the gated /local-image proxy and seen
// visually by the agent. SVG is DELIBERATELY not here — it is an XSS vector when served as an image
// (which is why the server's /local-image content-type map omits it), so an attached .svg is treated
// as a document (an openable chip + the agent reads its XML), never rendered inline.
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const
export const ATTACHMENT_DOC_EXTENSIONS = [
  "pdf", "svg", "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "jsonl",
  "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "sql",
  "sh", "bash", "zsh", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "cs", "php", "swift", "lua", "r",
] as const
export const ATTACHMENT_EXTENSIONS = [...ATTACHMENT_IMAGE_EXTENSIONS, ...ATTACHMENT_DOC_EXTENSIONS] as const

// Cap on the /attach base64 payload (~chars). A screenshot is small; a PDF can be larger, so the cap
// is generous but bounded — base64 is ~4/3 the byte size, so this is ~18MB of binary.
export const ATTACHMENT_MAX_BASE64_CHARS = 25_000_000
// The equivalent RAW-byte budget (base64 inflates ~4/3), for a client-side pre-check that rejects an
// oversized file with a clear message before it spends time encoding a doomed upload.
export const ATTACHMENT_MAX_BYTES = Math.floor(ATTACHMENT_MAX_BASE64_CHARS / 4) * 3

const ATTACHMENT_EXT_SET: ReadonlySet<string> = new Set(ATTACHMENT_EXTENSIONS)
// Lowercased extension (no dot) of a filename, or "" when it has none.
export function attachmentExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}
export function isAllowedAttachmentName(name: string): boolean {
  return ATTACHMENT_EXT_SET.has(attachmentExtension(name))
}
// The <input accept> value for the file picker: every allowed extension as `.ext`.
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")

// ---- Fray board vocabulary (mirrors cc/scripts/fray/config.mjs) ----

// Declaration order IS the lifecycle order (STATUS_ORDER = FrayStatus.options), consumed by the
// status pickers and the roadmap-count ordering. `needs-human` is a FIRST-CLASS status — the declared
// "awaiting a human" state and THE queue definition — and sits at the human gate between `active`
// (work in flight) and `blocked` (now narrowed to machine-waits only: blocking_threads / revalidate_at).
export const FrayStatus = z.enum(["planning", "planned", "active", "needs-human", "blocked", "done", "dismissed"])
export type FrayStatus = z.infer<typeof FrayStatus>

// How a blocked thread unblocks. `human` = the awaiting-you queue.
export const BlockMechanism = z.enum(["human", "threads", "timer"])
export type BlockMechanism = z.infer<typeof BlockMechanism>

// ---- Runtime state of the Claude process bound to a thread ----

export const RuntimeState = z.enum([
  "none", // no session ever spawned for this thread
  "spawning",
  "running", // process alive, turn in flight
  "perm-prompt", // process alive, paused on an interactive permission prompt (answer in the terminal)
  "turn-idle", // process alive, waiting at the prompt
  "exited", // tmux session gone or pane dead
])
export type RuntimeState = z.infer<typeof RuntimeState>

// Which agent CLI a dispatch/thread runs on (Codex-support epic, Phase 3). Mirrors BackendKind in
// server/backend/types.ts (the wire can't import it — it lives behind the server boundary). A model
// selection drives this: a Claude model ⇒ "claude", an OpenAI/GPT model ⇒ "codex".
export const Backend = z.enum(["claude", "codex"])
export type Backend = z.infer<typeof Backend>

// One selectable Codex model, derived server-side from the AUTHORITATIVE ~/.codex/models_cache.json
// (the codexModels RPC) rather than a hand-maintained list — the source of two live breakages (a bare
// `gpt-5.6` that codex 400s, and a single hardcoded effort set that's wrong per-model). `slug` is the
// `codex -m` id; `efforts` is exactly that model's supported reasoning levels (5.6 → …/max/ultra, 5.5 →
// …/xhigh), so the effort dropdown offers only what the chosen model actually accepts. Ordered by the
// cache's `priority` (index 0 = the codex default). See .fray/codex-model-cache.md.
export const CodexModel = z.object({
  slug: z.string(),
  displayName: z.string(),
  defaultEffort: z.string(),
  efforts: z.array(z.string()),
})
export type CodexModel = z.infer<typeof CodexModel>

// A provider-scoped launch profile. The server is the catalogue authority for existing threads:
// callers receive only models that belong to the row's exact backend and each model carries its
// complete supported effort set. The intentionally generic shape also lets a future backend expose
// its own native ids without teaching the browser how to classify model names.
export const ThreadProfileOption = z.object({
  model: z.string().min(1),
  label: z.string().min(1),
  defaultEffort: z.string().min(1),
  efforts: z.array(z.string().min(1)).min(1),
})
export type ThreadProfileOption = z.infer<typeof ThreadProfileOption>

export const ThreadAgent = z.object({
  id: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
})

// A LIVE background sub-agent the thread's worker dispatched and is now resting against — derived by
// the JSONL tailer from Agent-tool dispatches + their task-notifications, NOT the .fray file. This is
// what makes a "dispatched a sub-agent, then came to rest" worker read as in-motion rather than idle.
// `running` = the child's transcript is still being appended to; `stale` = no output for a while (a
// completion record we likely missed). Distinct from `ThreadAgent`/`agents` (fray frontmatter).
export const SubAgentView = z.object({
  label: z.string(), // the dispatch's `description` (e.g. "Investigate nubjs/nub GitHub issue 376")
  startedAt: z.string(), // ISO8601 of the dispatch record
  state: z.enum(["running", "stale"]),
  // The worker-profile cell (model+effort) from the dispatch's `subagent_type`, shown verbatim as a
  // "[fray:fray-opus-high]" tag. Optional — absent on dispatches without it → no tag rendered.
  subagentType: z.string().optional(),
  // The dispatch tool_use id (the stable correlation key: same id on the Agent tool_use block, the
  // completion <task-notification>, and the transcript AgentBlock). Optional — absent on a pre-restart
  // server that doesn't emit it yet → the drill-in drawer's entry point is simply not offered. Present
  // → the banner row / AgentBlock is clickable and resolves this exact child's transcript.
  id: z.string().optional(),
})
export type SubAgentView = z.infer<typeof SubAgentView>

// A LIVE background SHELL the worker launched (Bash run_in_background:true) — same tailer tracking as a
// sub-agent (dispatch → launch output path → task-notification clear + mtime staleness), but
// display-only (no drill-in). Foreground-blocking waits keep the turn in-flight, so the spinner already
// covers them; this is for ops that PERSIST across a rest (a CI watcher, a long build). No id/drawer.
export const BgShellView = z.object({
  label: z.string(), // the command's `description`, else its first-line summary
  startedAt: z.string(), // ISO8601 of the launch record
  state: z.enum(["running", "stale"]),
})
export type BgShellView = z.infer<typeof BgShellView>

// A PENDING native AskUserQuestion — the worker (or any session) called Claude Code's AskUserQuestion
// tool and is frozen at its TUI dialog, no tool_result yet. Safety net for pre-contract / adopted
// sessions that bypass the thread-file ask channel: we surface the REAL question(s) so the human knows
// what's being asked, and route them to answer in the terminal (a deny-hook enforces the contract
// channel for compliant workers; answering here is deliberately NOT wired — too fragile). Structured
// input is capped defensively (never trust a foreign tool's payload shape).
export const AskOption = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export const AskQuestion = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(AskOption),
})
export const PendingAsk = z.object({
  questions: z.array(AskQuestion),
})
export type PendingAsk = z.infer<typeof PendingAsk>

// A backend-native terminal modal that has paused the session outside the transcript. Deliberately
// carries no option values or tool payload: those may contain commands, repository data, or secrets;
// Fray only needs a safe family/title to route the human to the terminal without auto-answering.
export const NativeInputRequired = z.object({
  kind: z.enum(["tool-approval", "permission", "confirmation", "selection"]),
  title: z.string().max(120),
})
export type NativeInputRequired = z.infer<typeof NativeInputRequired>

// ---- Session-first signal model (2026-07-09) ----
// Threads ARE sessions now (the user-facing word stays THREAD — maintainer-settled): the primary
// listing entity is a claude session discovered from the project's JSONL dir, registered (fray-
// spawned, tmux-attached) or FOREIGN (a maintainer terminal — no registry row, read-only, no tmux
// verbs). Legacy .fray/<slug>.md rows survive read-only in a collapsed Legacy shelf. The queue
// inversion: a thread at rest is awaiting the human UNLESS it excused itself with a signal fence.

// A parked-wait hint parsed from `<kind>: <value>` lines in an ```awaiting fence body. `human`,
// `github-review`, and `timer` are current; pr/ci/session remain readable for legacy transcripts and
// wakers. A github-review hint is paired with `human:`: the latter names the exact external gate while
// the former gives the durable scheduler a machine-readable PR cursor to watch for NEW non-bot human
// review activity.
export const AwaitingHint = z.object({
  kind: z.enum(["human", "github-review", "timer", "pr", "ci", "session"]),
  value: z.string(),
})
export type AwaitingHint = z.infer<typeof AwaitingHint>

// One timer grammar shared by the scheduler and the web presentation. Date.parse alone admits locale
// dates (and the web previously hourglassed even completely invalid strings), while the worker contract
// promises an ISO-8601 INSTANT. Accept seconds with optional fractional precision and either Z or an
// explicit numeric offset, then let Date.parse reject impossible dates/offsets.
const AWAITING_TIMER_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
export function isValidAwaitingTimer(value: string): boolean {
  const s = value.trim()
  return AWAITING_TIMER_RE.test(s) && Number.isFinite(Date.parse(s))
}

// A user-chosen snooze is UI lifecycle state, not agent-authored transcript state. The browser
// serializes local date/time input with Date#toISOString, so the wire/storage representation is one
// unambiguous UTC instant. Keeping this stricter than the legacy awaiting-timer grammar avoids locale
// strings and offset-normalization surprises at the RPC boundary.
export const SnoozeUntil = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "Snooze time must be an ISO-8601 UTC instant",
).refine((value) => {
  const instant = Date.parse(value)
  // Date.parse normalizes impossible calendar dates in some runtimes (for example February 31).
  // Round-trip the canonical UTC serialization so the durable deadline is a real exact instant.
  return Number.isFinite(instant) && new Date(instant).toISOString() === value
}, "Snooze time must be valid")
export type SnoozeUntil = z.infer<typeof SnoozeUntil>

// The signal fence on a thread's FINAL assistant message — the fence language IS the state, the
// body is the message. `done` = checked success card in the queue until the human Archives it (the
// fence itself MUTATES NOTHING — maintainer-settled); `awaiting` = a parked human/timer wait.
// Only excuses WHILE it is the final message — any newer activity clears it. ```question fences
// keep their own machinery (pendingQuestion / questionBlocks) and are NOT an excusal.
export const ThreadFence = z.object({
  kind: z.enum(["done", "awaiting"]),
  body: z.string(), // fence body minus hint lines, capped server-side; may be ""
  hints: z.array(AwaitingHint).default([]),
})
export type ThreadFence = z.infer<typeof ThreadFence>

// A plan artifact: .fray/plans/*.md — no schema, no validation; prompted into existence. A plan
// with no live thread is backlog; a plan's threads are its history (associated via plan_path).
export const PlanView = z.object({
  path: z.string(), // project-relative, e.g. ".fray/plans/standalone-ui.md"
  title: z.string(), // first markdown heading, else the filename stem
  updatedAt: z.string().optional(), // ISO8601 file mtime
  threadIds: z.array(ThreadSlug).default([]), // threads dispatched from this plan
})
export type PlanView = z.infer<typeof PlanView>

// One sidebar row: fray board thread + runtime overlay.
export const ThreadView = z.object({
  id: ThreadSlug, // slug; filename is <slug>.md
  title: z.string(),
  status: FrayStatus,
  statusText: z.string().optional(),
  // Form-constrained gerund label (≤100 chars, e.g. "Awaiting CI on PR #391") the worker maintains;
  // the listing row's at-a-glance gloss. Optional → absent on old threads renders nothing. Distinct
  // from statusText, which keeps its own surfaces (queue cards / board gloss).
  activity: z.string().optional(),
  next: z.string().optional(),
  // DERIVED (board shell-out, from the body): the thread keeps a `## Plan` section, i.e. it carries a
  // plan document → the sidebar renders a quiet PLAN badge. NOT a status and NOT a frontmatter flag
  // (that was deliberately rejected); orthogonal to the Plans section, which keys on status. Defaults
  // false so an old snapshot / pre-restart server (which omits it) parses.
  hasPlan: z.boolean().default(false),
  mechanism: BlockMechanism.nullable(), // set only when status=blocked
  humanBlocked: z.boolean(),
  ready: z.boolean(), // deps cleared, auto-fire candidate
  dependsOn: z.array(ThreadSlug),
  externalDeps: z.array(z.string()),
  owner: z.string().optional(),
  revalidate: z.string().optional(), // ISO8601
  agents: z.array(ThreadAgent),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // runtime overlay (from the UI server, not the .fray file)
  runtime: RuntimeState,
  sessionId: z.string().optional(),
  tmuxName: z.string().optional(),
  unread: z.boolean(),
  archived: z.boolean(), // user hid the row from the nav; respawn/resume un-archives
  lastAssistant: z.string().optional(), // trimmed preview of last assistant text
  spawnedAt: z.string().optional(), // ISO8601
  lastActivityAt: z.string().optional(), // ISO8601, from jsonl tail — ANY record (incl. sub-agent/system)
  // ISO8601 of the agent's OWN last output (Claude: last assistant record; Codex: turn-end/final text).
  // This is the "rest time" — when the thread's own turn last came to rest — and UNLIKE lastActivityAt
  // it is NOT bumped by a background sub-agent's completion notification (a promptSource:system record).
  // The queue/rested-band order key and the at-rest "Last active" label both key off this. Optional so
  // old snapshots parse; the client falls back to lastActivityAt/spawnedAt when absent.
  lastAssistantAt: z.string().optional(),
  aiTitle: z.string().optional(), // Claude's own auto-generated session title (latest ai-title record)
  // True when `title` is a machine-guessed dispatch slug (title_auto=1), NOT a real name — the display
  // then shows a "Spinning up a thread…" placeholder instead of the guess until aiTitle lands. Optional
  // (absent ⇒ legacy/slim row) so old snapshots parse; absent is treated as "not provisional".
  titleAuto: z.boolean().optional(),
  // Live background sub-agents the worker dispatched (tailer-derived). Defaults to [] so an old
  // snapshot/row (or a pre-restart server that doesn't emit the field yet) parses without breaking.
  subAgents: z.array(SubAgentView).default([]),
  // Live background SHELLS the worker launched (tailer-derived). Same default-[] discipline. Rendered
  // in the anchored background-ops strip alongside sub-agents; display-only.
  bgShells: z.array(BgShellView).default([]),
  // A pending native AskUserQuestion the session is frozen on (tailer-derived). Optional — absent
  // when there's no unanswered ask. Feeds needsAction + the read-only question render + "Answer in Terminal".
  pendingAsk: PendingAsk.optional(),
  // A verified backend-native terminal modal (Codex tool approval / permission / confirmation /
  // selection) that is blocking transcript progress. The title is fixed/sanitized server-side and
  // options/tool payloads are never exposed. Registered sessions only; foreign rows remain read-only.
  nativeInputRequired: NativeInputRequired.optional(),
  // Derived safety net (tailer): at rest with an unanswered ```question the worker asked in chat but
  // never encoded as blocked. Defaults false so old snapshots/rows parse. Feeds needsAction.
  pendingQuestion: z.boolean().default(false),
  // ISO8601 of the newest REAL user interaction (answer/steer/dispatch) — the chronological listing
  // sort key. Optional; the listing falls back to spawnedAt when absent (a dispatch IS an interaction).
  lastUserAt: z.string().optional(),
  // Runtime provider-auth rejection (claude-auth plan): the session's provider positively rejected
  // its credential (Claude: synthetic isApiErrorMessage 401 record, or the 401/login text on a
  // boot-failed pane). Bounded by design — only the typed category travels, never raw provider/pane
  // text. Drives the trusted sign-in recovery card. Optional so old snapshots/servers parse.
  providerFault: z.object({
    backend: z.enum(["claude", "codex"]),
    category: z.enum(["authentication_required", "authentication_rejected"]),
  }).optional(),

  // ---- Session-first fields (ALL optional: absent ⇒ a legacy .fray-file row / pre-restart server;
  // the client treats such rows as Legacy-shelf material). Deliberately not zod-defaulted so server
  // constructors that predate the model still typecheck and old snapshots parse unchanged. ----
  // "session" = a session-backed thread (the working rail's unit); "legacy" (or absent) = a .fray
  // file row, rendered read-only in the collapsed Legacy shelf.
  kind: z.enum(["session", "legacy"]).optional(),
  // No registry row (a maintainer terminal discovered from the JSONL dir): read-only transcript,
  // no tmux verbs (no composer / kill / resume), never in Needs-you, no archive/seen state.
  foreign: z.boolean().optional(),
  // ui.db lifecycle for session threads (open|archived) — written ONLY by explicit Archive/Reopen.
  state: z.enum(["open", "archived"]).optional(),
  // Exact durable user snooze. While this instant is in the future, an otherwise-resting thread is
  // suppressed from Queue and shown dimmed in Held. Hard interactive gates (question, permission,
  // native approval, crash) deliberately break through it. Expired values are cleared server-side.
  snoozedUntil: SnoozeUntil.optional(),
  // The signal fence on the final assistant message, present only while the thread is excused by it.
  lastFence: ThreadFence.optional(),
  // SERVER-DERIVED queue membership: explicit questions, checked/done handoffs, plus the process-level
  // blocks (perm-prompt / pendingAsk / crash) that a view can't clear. The client renders the
  // queue off this bit alone for session threads (legacy rows keep needsAction()).
  needsYou: z.boolean().optional(),
  // True only for the crash/stall branch (pane exited while the transcript still says in-flight).
  // Once every ordinary rest also queues, runtime=exited + needsYou is no longer enough for clients
  // to distinguish a failed worker from a clean completed process.
  crashed: z.boolean().optional(),
  // Exact typed-interaction presence for this CURRENT registered session. The board already derives
  // this from the scoped durable journal to compute needsYou; exposing the reason lets React avoid a
  // pendingInteractions RPC for every unrelated question/completion card. Optional preserves rolling
  // compatibility: a client paired with an older server treats absence as "unknown" and keeps the
  // previous query behavior, while a current server always emits true/false for owned session rows.
  pendingInteraction: z.boolean().optional(),
  // True only while a durable typed interaction still needs a USER decision. This is deliberately
  // distinct from pendingInteraction: after the human answers, provider delivery can remain queued or
  // sent (and therefore pending/readable) without remaining a hard gate that disables Snooze.
  // Optional keeps rolling client/server reloads compatible; current servers always emit the bit.
  actionableInteraction: z.boolean().optional(),
  // ISO8601 read/seen telemetry (threadSeen RPC — recorded when the human opens the thread). Kept for
  // compatibility and analytics only; viewing never acknowledges or removes a queue handoff.
  seenAt: z.string().optional(),
  // Project-relative scratchpad path (.fray/threads/<session-id>/scratch.md) once provisioned — the worker's
  // compaction-proof working memory, rendered as the thread's doc tab.
  scratchpadPath: z.string().optional(),
  // Project-relative plan artifact this thread was dispatched from (.fray/plans/*.md), if any.
  planPath: z.string().optional(),
  // Which agent backend runs this thread (Codex-support epic, Phase 3) — drives the subtle per-row
  // rail badge. Optional so a legacy/foreign/pre-restart row parses; absent OR "claude" ⇒ no badge
  // (Claude is the unmarked default), "codex" ⇒ the small Codex badge.
  backend: Backend.optional(),
  // The backend-native permission/sandbox profile this session was launched (or explicitly
  // re-attached) with. Persisted per thread: never inferred from mutable Settings. Optional for
  // migrated/foreign sessions whose actual process mode is unknown.
  permissionMode: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // A durable requested mode that has not yet appeared in backend telemetry. The UI renders this as
  // pending beside permissionMode; it never replaces the observed value optimistically.
  permissionPending: z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  // Raw durable barrier bit. Unlike permissionPending this remains true for a future/corrupt value,
  // so rolling clients fail closed instead of enabling another composer while ownership is unknown.
  permissionChangePending: z.boolean().optional(),
  // Atomic model+effort handoff state. The displayed model/effort remain the last committed launch
  // target until both pending values are attached and readiness-proven for a new generation.
  profilePendingModel: z.string().optional(),
  profilePendingEffort: z.string().optional(),
  profileChangePending: z.boolean().optional(),
  // One durable runtime-control owner serializes reattach/resume/native-composer mutations. Unknown
  // future owner values still disable the composer rather than being treated as idle.
  runtimeControlPending: z.boolean().optional(),
  // The one narrow exception to the generic runtime-control fence: Codex's durable input controller
  // owns its queue while it is delivering a prior follow-up, and can atomically append another one.
  // This is a capability, not the raw control kind, so clients cannot infer that other owners are safe.
  followUpQueueAvailable: z.boolean().optional(),
  // Durable Codex terminal-control state. A queued input is waiting to be echoed/submitted/observed;
  // controlError is an actionable reason the controller failed closed (for example an existing draft).
  queuedInputCount: z.number().int().nonnegative().optional(),
  codexInputAmbiguous: z.boolean().optional(),
  controlError: z.string().optional(),
  // The session's concrete model + reasoning effort: pinned launch metadata for new dispatches,
  // refined/backfilled from backend transcript telemetry where available (Claude records model;
  // Codex records both). Never derived from current Settings. Strings keep future backend-native
  // values forward-compatible; absent when neither durable source knows → the UI renders no guess.
  model: z.string().optional(),
  effort: z.string().optional(),
})
export type ThreadView = z.infer<typeof ThreadView>

// STRUCTURED board error — a machine-readable companion to the legacy `errors: string[]` so the
// client can tell a REPAIRABLE error from an inert one and which file it names. `no-frontmatter` is
// the one-click-repairable case (a thread .md written with no YAML frontmatter, invisible to the
// queue/status system until healed); everything else is `other` (a dangling dep, a bad status, a
// board-read failure) and renders as today with no repair affordance. Additive: the legacy string
// array is untouched, this is a PARALLEL field. `file` is the .md basename (or "" for a board-level
// failure with no single file).
export const BoardErrorItem = z.object({
  file: z.string(),
  kind: z.enum(["no-frontmatter", "other"]),
  message: z.string(),
})
export type BoardErrorItem = z.infer<typeof BoardErrorItem>

export const BoardSnapshot = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(), // "owner/repo" from the git origin remote; falls back to projectName
  frayActive: z.boolean(), // .fray/ exists
  threads: z.array(ThreadView),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem). Optional so a pre-restart server / old
  // snapshot that omits it still parses; the client treats absent as "no structured errors" and
  // falls back to rendering the plain `errors` strings.
  errorItems: z.array(BoardErrorItem).optional(),
  // Plan artifacts (.fray/plans/*.md) — the Plans rail section. Optional for the same pre-restart
  // back-compat reason (absent ⇒ old server ⇒ no Plans section data).
  plans: z.array(PlanView).optional(),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshot>

// ---- Provider quota (subscription rate-limit windows) ----
// A single usage window for a provider's plan — the 5-hour rolling window or the weekly window that
// Claude/Codex subscriptions meter against. `usedPercent` is 0..100 (how much of the window is spent,
// so remaining = 100 - usedPercent); `resetsAt` is a unix-seconds instant the window rolls over.
export const QuotaWindow = z.object({
  key: z.string(), // stable id: "5h" | "weekly" (provider-neutral)
  label: z.string(), // short human label for the chip ("5h", "Weekly")
  usedPercent: z.number(), // 0..100
  resetsAt: z.number().optional(), // unix seconds; absent when the source doesn't report it
})
export type QuotaWindow = z.infer<typeof QuotaWindow>

// One provider's quota. `status: "ok"` carries live windows; "unavailable" means we could not read it
// (no recent session, endpoint unreachable, not logged in) and the UI shows a neutral dash + `detail`.
export const ProviderQuota = z.object({
  status: z.enum(["ok", "unavailable"]),
  planType: z.string().optional(), // "pro" / "max" / etc. when the source reports it
  windows: z.array(QuotaWindow),
  detail: z.string().optional(), // why unavailable, or an extra note
})
export type ProviderQuota = z.infer<typeof ProviderQuota>

// The polled quota snapshot the sidebar status bar renders — one entry per agent backend.
export const QuotaSnapshot = z.object({
  claude: ProviderQuota,
  codex: ProviderQuota,
})
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>

// ---- Provider auth (local credential presence) ----
// Whether a provider's LOCAL credential exists — the signal the new-thread dispatch gate keys on.
// DISTINCT from quota's "unavailable": that is overloaded with transient endpoint failures, whereas
// this reports credential presence only. "signed-out" = we positively found no credential; "unknown" =
// we couldn't determine it (read error). The gate BLOCKS on "signed-out" and FAILS OPEN on "unknown".
export const ProviderAuth = z.enum(["authed", "signed-out", "unknown"])
export type ProviderAuth = z.infer<typeof ProviderAuth>

// The per-provider auth snapshot the new-thread gate reads — one entry per agent backend.
export const AuthSnapshot = z.object({
  claude: ProviderAuth,
  codex: ProviderAuth,
})
export const AccountLogoutInput = z.object({ backend: z.enum(["claude", "codex"]) }).strict()
export type AccountLogoutInput = z.infer<typeof AccountLogoutInput>
// Result of the typed provider logout action. "blocked" = refused because the provider had live
// turns (account state is process-global; changing it mid-request produces ambiguous failures);
// "failed" = the CLI errored AND the credential still reads present. `auth` is the post-attempt
// credential state so the client can refresh its snapshot without another round-trip.
export const AccountLogoutResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  auth: ProviderAuth,
  activeThreads: z.number().int().positive().optional(),
  detail: z.string().max(200).optional(),
})
export type AccountLogoutResult = z.infer<typeof AccountLogoutResult>
export type AuthSnapshot = z.infer<typeof AuthSnapshot>

// ---- Settings ----

export const PermissionMode = z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = z.infer<typeof PermissionMode>

// Where a vetted local artifact link opens. This is intentionally a server-owned setting: the
// browser never gets permission to navigate to file:// or choose an arbitrary executable.
export const LocalFileOpener = z.enum(["system", "cursor", "vscode", "finder", "copy"])
export type LocalFileOpener = z.infer<typeof LocalFileOpener>

export const Settings = z.object({
  // Injected verbatim into every dispatch prompt. All orchestration wisdom lives here.
  dispatchPreamble: z.string(),
  permissionMode: PermissionMode,
  model: z.string().optional(), // the agent's --model value; undefined = CLI default
  // The agent backend the selected model runs on (Codex-support epic, Phase 3). Persisted ALONGSIDE
  // `model` — a Claude model pins "claude", a GPT/Codex model pins "codex" — so the dependent controls
  // (permission-mode vs sandbox, the effort set) know which axis to present. Optional so an old blob
  // parses; absent ⇒ "claude" (derivable from `model` too, via backendForModel in web/lib/options).
  backend: Backend.optional(),
  // Reasoning effort. The ladder spans BOTH backends' universes: Claude's (low..max) and codex's
  // (adds "ultra" — a 5.6-sol/terra level above max). Which subset is OFFERED is backend/model-gated
  // in the UI (Claude models stop at max; a codex model exposes exactly its cache `efforts`), and the
  // server passes the chosen value through per backend — so the wire enum is simply the union.
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  notifications: z.boolean(),
  // UI type family. `mono` (default) is the mono-forward system; `sans` swaps prose/UI chrome to a
  // sans stack while code / tool lines / the terminal stay mono. Optional so an old settings blob
  // parses; defaultSettings pins "mono".
  font: z.enum(["mono", "sans"]).optional(),
  // Default action for a vetted non-image local path in agent markdown. Image clicks always use the
  // OS default viewer so screenshots retain their expected behavior.
  localFileOpener: LocalFileOpener.optional(),
  // Whether dispatched workers receive the RUNTIME RELEASE GATE block in their system prompt — the
  // instruction to drive UI/runtime changes in a real browser, screenshot the result into the handoff,
  // and run an independent review before claiming done. ON by default (fray's screenshot-in-the-UI loop
  // is the differentiator); a project that doesn't want that opinionation flips it off in one click.
  // Optional so an old settings blob parses; absent ⇒ on (defaultSettings pins true).
  runtimeGate: z.boolean().optional(),
  // GitHub batch-dispatch prompt templates (the picker's per-item worker prompt). Optional: when
  // unset OR blank the server falls back to its exported DEFAULT_ISSUE_PROMPT / DEFAULT_PR_PROMPT.
  // Substitution tokens the server fills: {repo} {n} {title} {url} {labels} {body}. The leading
  // `THREAD: <slug>` tag is prepended by the server (not part of the editable template) so a custom
  // prompt can never break the thread↔.fray-file binding. Optional so old settings blobs parse.
  githubIssuePrompt: z.string().optional(),
  githubPrPrompt: z.string().optional(),
})
export type Settings = z.infer<typeof Settings>

// The new-thread composer's durable, workspace-scoped choices. Keep one profile per runtime so
// moving between Claude and Codex never overwrites the other runtime's model, effort, or permission
// selection. Fields stay optional for the first-run/default case: a displayed fallback is not stored
// as user intent until the human actually chooses it.
export const DispatchProviderPreferences = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: Settings.shape.effort,
  permissionMode: PermissionMode.optional(),
})
export type DispatchProviderPreferences = z.infer<typeof DispatchProviderPreferences>

export const DispatchPreferences = z.object({
  backend: Backend,
  claude: DispatchProviderPreferences,
  codex: DispatchProviderPreferences,
})
export type DispatchPreferences = z.infer<typeof DispatchPreferences>

// One immutable launch profile captured from a prompt box. GitHub batch dispatch carries this
// complete tuple through its picker instead of consulting Settings again: backend owns the model,
// effort is part of the same atomic profile cell, and permission belongs to that backend profile.
export const DispatchProfileSnapshot = z.object({
  backend: Backend,
  model: z.string().trim().min(1).max(200),
  effort: Settings.shape.effort.unwrap(),
  // IGNORED: dispatch permission is fixed server-side (WORKER_DISPATCH_PERMISSION) — every created
  // worker launches maximally non-interactive. Optional so old clients that still send it parse.
  permissionMode: PermissionMode.optional(),
}).strict()
export type DispatchProfileSnapshot = z.infer<typeof DispatchProfileSnapshot>

// Atomic updates avoid read/modify/write races between the sidebar form and the anywhere composer.
// A matrix-cell selection is one complete model+effort profile mutation; permission remains an
// independent axis. Every provider-owned update names its runtime so a delayed request can never
// contaminate the other profile.
export const SetDispatchPreferenceInput = z.discriminatedUnion("field", [
  z.object({ field: z.literal("backend"), value: Backend }),
  z.object({
    field: z.literal("profile"),
    backend: Backend,
    model: z.string().trim().min(1).max(200),
    effort: Settings.shape.effort.unwrap(),
  }),
  z.object({ field: z.literal("model"), backend: Backend, value: z.string().trim().min(1).max(200) }),
  z.object({ field: z.literal("effort"), backend: Backend, value: Settings.shape.effort.unwrap() }),
])
export type SetDispatchPreferenceInput = z.infer<typeof SetDispatchPreferenceInput>

// ---- RPC inputs ----

export const DispatchInput = z.object({
  // Optional: when omitted, dispatch derives a fallback title from the prompt (Claude later renames
  // the session via ai-title, which the UI prefers for display). The thread FILE always gets a
  // concrete title regardless — fray requires one.
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  slug: ThreadSlug.optional(), // derived from title if omitted
  // IGNORED: dispatch permission is fixed server-side (WORKER_DISPATCH_PERMISSION) — every created
  // worker launches maximally non-interactive. Accepted-but-ignored so old clients still parse.
  permissionMode: PermissionMode.optional(),
  model: z.string().optional(),
  // The agent backend for THIS dispatch (Codex-support epic, Phase 3). Omitted ⇒ the dispatcher
  // defaults to "claude", keeping the legacy RPC path byte-identical. The router forwards it into
  // `dispatch(input, { backend })`; the model picker sets it from the chosen model's family.
  backend: Backend.optional(),
  effort: Settings.shape.effort,
  // Project-relative plan artifact this dispatch works from (.fray/plans/*.md): stored as the
  // thread's plan_path association and named to the worker in its system-prompt orientation.
  planPath: z.string().optional(),
})
export type DispatchInput = z.infer<typeof DispatchInput>

export const ADOPT_THREAD_MESSAGE_MAX_CHARS = 64 * 1024
export const AdoptThreadInput = z.object({
  slug: ThreadSlug,
  message: z.string().max(ADOPT_THREAD_MESSAGE_MAX_CHARS).optional(),
}).strict()
export type AdoptThreadInput = z.infer<typeof AdoptThreadInput>
export const AdoptThreadResult = z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict()
export type AdoptThreadResult = z.infer<typeof AdoptThreadResult>

export const FollowUpInput = z.object({
  slug: ThreadSlug,
  message: z.string().min(1),
  // Generated once before the optimistic clear so a transport replay can be idempotent.
  deliveryId: z.string().min(1).max(200).optional(),
})
export type FollowUpInput = z.infer<typeof FollowUpInput>

export const SetThreadSnoozeInput = z.object({
  slug: ThreadSlug,
  // null is the explicit "wake now"/cancel operation; presets and custom local input send UTC.
  until: SnoozeUntil.nullable(),
}).strict()
export type SetThreadSnoozeInput = z.infer<typeof SetThreadSnoozeInput>

// A human-authored display title for a registered session. Trimming happens at the RPC boundary so
// storage never has to distinguish whitespace-only names from real intent; the web input mirrors the
// same cap. This is metadata-only and therefore works identically for Claude and Codex sessions.
export const RenameThreadInput = z.object({
  slug: ThreadSlug,
  title: z.string().trim().min(1).max(200),
})
export type RenameThreadInput = z.infer<typeof RenameThreadInput>

// Claude-only native title generation. The server submits Claude Code's exact `/rename` command,
// observes the resulting custom-title transcript record, and returns the title it durably saved.
// Codex intentionally has no analog: its thread header exposes the manual metadata rename only.
export const AiRenameThreadInput = z.object({ slug: ThreadSlug })
export type AiRenameThreadInput = z.infer<typeof AiRenameThreadInput>
export const AiRenameThreadResult = z.object({ title: z.string().min(1).max(200) })
export type AiRenameThreadResult = z.infer<typeof AiRenameThreadResult>

export const SetThreadPermissionInput = z.object({
  slug: ThreadSlug,
  permissionMode: PermissionMode,
})
export type SetThreadPermissionInput = z.infer<typeof SetThreadPermissionInput>

export const SetThreadPermissionResult = z.object({
  effect: z.enum(["applied", "next-resume"]),
})
export type SetThreadPermissionResult = z.infer<typeof SetThreadPermissionResult>

export const ThreadProfileOptionsInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadProfileOptionsInput = z.infer<typeof ThreadProfileOptionsInput>
export const ThreadProfileOptionsResult = z.object({
  backend: Backend,
  options: z.array(ThreadProfileOption),
})
export type ThreadProfileOptionsResult = z.infer<typeof ThreadProfileOptionsResult>

export const SetThreadProfileInput = z.object({
  slug: ThreadSlug,
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(100),
}).strict()
export type SetThreadProfileInput = z.infer<typeof SetThreadProfileInput>
export const SetThreadProfileResult = z.object({
  effect: z.enum(["applied", "next-resume"]),
})
export type SetThreadProfileResult = z.infer<typeof SetThreadProfileResult>

export const SubmitCodexDraftInput = z.object({ slug: ThreadSlug })
export type SubmitCodexDraftInput = z.infer<typeof SubmitCodexDraftInput>
export const SubmitCodexDraftResult = z.object({ effect: z.literal("submitted") })
export type SubmitCodexDraftResult = z.infer<typeof SubmitCodexDraftResult>

// A deliberately non-destructive recovery helper. Fray can verify the live terminal draft and
// disclose the queued follow-up, but tmux cannot atomically compare and rewrite a TUI composer.
// The browser copies this text and the operator performs the replacement in Codex's terminal.
export const PrepareCodexDraftReplacementInput = z.object({ slug: ThreadSlug })
export type PrepareCodexDraftReplacementInput = z.infer<typeof PrepareCodexDraftReplacementInput>
export const PrepareCodexDraftReplacementResult = z.object({ queuedMessage: z.string().min(1) })
export type PrepareCodexDraftReplacementResult = z.infer<typeof PrepareCodexDraftReplacementResult>

export const ClearAmbiguousCodexInputInput = z.object({ slug: ThreadSlug })
export type ClearAmbiguousCodexInputInput = z.infer<typeof ClearAmbiguousCodexInputInput>
export const ClearAmbiguousCodexInputResult = z.object({ effect: z.literal("cleared") })
export type ClearAmbiguousCodexInputResult = z.infer<typeof ClearAmbiguousCodexInputResult>

// ---- GitHub-first batch dispatch (server ↔ web mirror; wrapper in server/github.ts) ----

// Exact, versioned presentation boundary in a GitHub batch-dispatch prompt. The worker receives the
// whole prompt; transcript normalization exposes only the generated lead above this line as
// `displayText`. Namespacing + versioning make an ordinary HTML comment or markdown example inert.
export const GITHUB_DISPATCH_UI_BOUNDARY = "<!-- fray-ui:github-dispatch-ui-boundary:v1 -->"

// The server's gh-CLI availability signal. `installed`/`inRepo`/`nameWithOwner` are STABLE for the
// process lifetime (resolved once at boot); `authed` can flip mid-session (the user runs
// `gh auth login`) so it is re-checked live on each githubStatus query.
export const GithubStatus = z.object({
  installed: z.boolean(),
  inRepo: z.boolean(),
  nameWithOwner: z.string().nullable(),
  authed: z.boolean(),
})
export type GithubStatus = z.infer<typeof GithubStatus>

// One row in the picker list. `reactions` is summed server-side across reactionGroups (the list ORDER
// already reflects the sort; this is a display badge). `comments` is optional (present for issues).
export const GithubItem = z.object({
  kind: z.enum(["issue", "pr"]),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  reactions: z.number().int().nonnegative(),
  updatedAt: z.string(),
  comments: z.number().int().nonnegative().optional(),
  // GitHub-mirror row fields — all optional/defaulted so a pre-restart snapshot still parses.
  createdAt: z.string().optional(), // for "opened <when>"
  author: z.string().optional(), // login
  labels: z.array(z.object({ name: z.string(), color: z.string() })).default([]),
  state: z.string().optional(), // OPEN | CLOSED | MERGED
  isDraft: z.boolean().optional(), // PRs only
})
export type GithubItem = z.infer<typeof GithubItem>

export const GithubListInput = z.object({
  kind: z.enum(["issues", "prs"]),
  sort: z.enum(["recent", "reactions"]),
  limit: z.number().int().min(1).max(100).default(30),
})
export type GithubListInput = z.infer<typeof GithubListInput>

// Minimal batch payload — the server re-hydrates title/body/url fresh from gh at dispatch (always
// current, small wire payload). Capped at 20 items (a burst of tmux spawns; see risk 5).
export const GithubBatchInput = DispatchProfileSnapshot.extend({
  items: z.array(z.object({ kind: z.enum(["issue", "pr"]), number: z.number().int().positive() })).min(1).max(20),
}).strict()
export type GithubBatchInput = z.infer<typeof GithubBatchInput>

export const GithubBatchResult = z.object({
  dispatched: z.array(z.object({ number: z.number(), kind: z.string(), slug: ThreadSlug })),
  failed: z.array(z.object({ number: z.number(), kind: z.string(), error: z.string() })),
})
export type GithubBatchResult = z.infer<typeof GithubBatchResult>

// ---- SSE events on the global /events channel ----
// The channel is DELTA-based (see delta.ts): a full "board" frame is the connect keyframe and the
// resync frame; steady-state changes ship as "board-delta" (only the threads that actually changed).
// A one-thread status change ships one ThreadView, not the whole ~310KB board — that is the byte win.

// Board-level (non-thread) fields, diffed as a unit and shipped only when they change (BoardDelta.meta).
export const BoardMeta = z.object({
  projectDir: z.string(),
  projectName: z.string(),
  projectLabel: z.string(),
  frayActive: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  // Structured mirror of `errors` (see BoardErrorItem), diffed + shipped with the rest of the board
  // meta so the repair affordance survives a delta (not just the connect keyframe). Optional for the
  // same pre-restart back-compat reason as on BoardSnapshot.
  errorItems: z.array(BoardErrorItem).optional(),
  // Plan artifacts, diffed + shipped with the board meta so the Plans section survives deltas.
  plans: z.array(PlanView).optional(),
})
export type BoardMeta = z.infer<typeof BoardMeta>

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("board"),
    board: BoardSnapshot,
    // Monotonic publish counter this keyframe corresponds to (the client adopts it, then applies
    // deltas seq+1, seq+2 …). `bootId` is the server's per-process id. BOTH optional so a pre-restart
    // server's frame (which omits them) still parses; a new client treats absent seq as "no delta
    // tracking yet" and absent bootId as "unknown — no reload check".
    seq: z.number().optional(),
    bootId: z.string().optional(),
  }),
  z.object({
    // Keyed per-thread delta. `upserts` are COMPLETE ThreadViews for threads whose serialization
    // changed (or are new); `removed` are ids gone from the board; `meta` is present only when a
    // board-level field changed. Emitted only by a post-restart server → seq/bootId are required here.
    type: z.literal("board-delta"),
    seq: z.number(),
    bootId: z.string(),
    upserts: z.array(ThreadView),
    removed: z.array(ThreadSlug),
    meta: BoardMeta.optional(),
  }),
  z.object({
    type: z.literal("notify"),
    slug: ThreadSlug,
    kind: z.enum(["needs-decision", "turn-done", "exited"]),
    title: z.string(),
    body: z.string().optional(),
  }),
  z.object({
    // Payload-free invalidation for future interaction cards. Provider-controlled command/diff/form
    // metadata never rides the global event bus; clients re-read the authorization-scoped RPC instead.
    type: z.literal("interactions-invalidated"),
    slug: InteractionThreadSlug,
    sessionId: InteractionOpaqueId,
    interactionId: InteractionOpaqueId,
    lifecycle: InteractionLifecycle,
    recordRevision: InteractionRevision,
  }).strict(),
])
export type ServerEvent = z.infer<typeof ServerEvent>
export type BoardEvent = Extract<ServerEvent, { type: "board" }>
export type BoardDelta = Extract<ServerEvent, { type: "board-delta" }>

// Pure delta engine + client apply/decision helpers (kept in a sibling module, re-exported here so
// `@fray-ui/shared` stays the single entry point).
export * from "./delta.ts"
export * from "./interactions.ts"
export * from "./thread-slug.ts"

// ---- Rendered conversation (parsed mechanically from the session JSONL — no AI) ----

// Structured file-edit payload for Edit/Write/MultiEdit tool calls, so the client can render a
// syntax-highlighted diff instead of an opaque "edited file.ts" line. Write → old: "" (whole file
// is new); MultiEdit → one TranscriptToolCall per sub-edit. Both strings are capped (see
// transcript.ts EDIT_CAP) so transcripts stay light.
export const TranscriptEdit = z.object({
  file: z.string(),
  old: z.string(),
  new: z.string(),
})
export type TranscriptEdit = z.infer<typeof TranscriptEdit>

export const TranscriptToolCall = z.object({
  name: z.string(),
  detail: z.string().optional(), // file path / command / description — whatever the input reveals
  edit: TranscriptEdit.optional(), // set only for Edit/Write/MultiEdit blocks
  // The model-authored one-line description of a Bash command (Claude Code's `description` input
  // field) — the collapsed block's title.
  desc: z.string().optional(),
  // Raw (multi-line) command, set only for a Bash call whose command spans multiple lines or runs
  // long — the client renders it as its own code block instead of the flattened one-line `detail`.
  command: z.string().optional(),
  // Capped human-readable input/source for any tool that has useful payload beyond its one-line
  // detail. Generic cards expand this exactly like Bash expands `command`; specialized cards may
  // retain it as failure context (for example a wrapped apply_patch that did not apply).
  input: z.string().optional(),
  // A capped excerpt of a Read call's tool_result (the file content it returned) — set only for Read
  // calls whose result shipped as text. The client renders it as a collapsed, bordered card (same
  // family as Bash/Edit) that expands to the excerpt. Absent for older transcripts / pre-restart
  // servers, in which case the client falls back to the compact one-line Read summary.
  read: z.string().optional(),
  // A capped excerpt of a tool's captured result. Codex records results for shell calls and for its
  // unified custom-tool wrapper; the client renders this as a second pane below either the Bash body
  // or a generic input body. Absent for Claude calls whose result isn't present in the transcript.
  output: z.string().optional(),
  // Absolute path to an IMAGE the tool returned in its result — e.g. a `take_screenshot` (chrome-devtools
  // MCP) or any tool whose tool_result carries a base64 image block. The server decodes the image once to
  // a content-hashed file under the OS temp dir and records the path here; the client renders it inline in
  // the tool card via the gated /local-image route (tmpdir is a trusted root). Absent for text-only results.
  outputImage: z.string().optional(),
  // Tool lifecycle inferred from call/result pairs. A just-appended call is `pending`; the matching
  // result promotes it to completed/failed/cancelled. Background launches deliberately remain pending
  // after their launch acknowledgement: a later provider-native completion is the only terminal fact.
  // Kept optional for pre-restart transcript data.
  // `exitCode` is present for shell-like results that expose it.
  status: z.enum(["pending", "completed", "failed", "cancelled"]).optional(),
  // A non-terminal shell has a durable, provider-neutral lifecycle identity. `background` means the
  // provider confirmed a live child/session; `unknown` means we saw a poll for an unpaired session.
  // Neither is rendered as done merely because the wrapper call returned.
  backgroundState: z.enum(["background", "unknown"]).optional(),
  exitCode: z.number().int().optional(),
  // Execution context/result metadata that is useful in a compact card header without dumping a
  // backend envelope. `cwd` comes from exec_command's workdir/cwd, `sessionId` identifies a yielded
  // PTY process (and later write_stdin polls), and `durationMs` is result wall time when recorded.
  cwd: z.string().optional(),
  sessionId: z.union([z.string(), z.number()]).optional(),
  durationMs: z.number().nonnegative().optional(),
  // ---- Agent (sub-agent dispatch) block ----
  // Set only for an `Agent` tool_use that carried a `prompt`. The client promotes such a call into an
  // AgentBlock (same collapsed-card family as Bash/Read): the `detail` is the dispatch description,
  // `subagentType` the model+effort cell, and expanding reveals the (capped) dispatch `prompt`. All
  // optional so a pre-restart server / older transcript falls back to the plain `Agent(detail)` line.
  prompt: z.string().optional(), // the capped dispatch prompt (the AgentBlock's expanded body)
  subagentType: z.string().optional(), // the dispatch's subagent_type verbatim (e.g. "fray:fray-opus-high")
  agentId: z.string().optional(), // the Agent tool_use id — the correlation key to the live tracked sub-agent
  // Terminal outcome of the dispatched sub-agent, back-filled when a matching completion
  // <task-notification> appears LATER in the transcript. Drives the AgentBlock header's finished state
  // ("finished 35m" / "failed 12m"). Absent while the child is still live (or its completion was
  // missed) — in which case the live tracked-sub-agent overlay supplies "running Nm" instead.
  agentStatus: z.enum(["completed", "failed", "killed"]).optional(),
  agentElapsedMs: z.number().optional(), // dispatch → completion elapsed, for the finished-state label
  // ---- SendMessage (peer / agent-to-agent messaging) block ----
  // Set only for a `SendMessage` tool_use (an orchestrator steering a sub-agent, or a teammate note).
  // The client promotes such a call into a SendMessageCard (same quiet card family as Bash/Read/Agent):
  // `sendTo` is the recipient agent name (rendered prominently as "→ <name>"), `sendSummary` the short
  // one-line recap shown in the header, `sendBody` the (capped) message body rendered as markdown in the
  // expandable card body, and `sendType` the message type when it is NOT a plain "message" (e.g.
  // "shutdown_request"). All optional so a pre-restart server / older transcript falls back to the plain
  // generic `SendMessage(detail)` card.
  sendTo: z.string().optional(), // recipient agent id/name (the SendMessage `to`)
  sendSummary: z.string().optional(), // the short recap (the SendMessage `summary`)
  sendBody: z.string().optional(), // the capped message body (the SendMessage `message`/`content`)
  sendType: z.string().optional(), // the message type when not a plain "message" (e.g. "shutdown_request")
  // ---- SendUserFile (Claude Code file delivery) block ----
  // Set only for a `SendUserFile` tool_use — the worker surfacing files (screenshots, artifacts) to the
  // human. The client promotes such a call into a SentFilesCard that renders the delivered files inline
  // instead of a generic tool block: `sentImages` are absolute paths the server COPIED into its servable
  // screenshot cache (the sources are often scratchpad paths /local-image won't serve), each rendered
  // inline via the gated /local-image route; `sentFiles` are the basenames of any NON-image files
  // (rendered as openable chips); `caption` is the model's one-line caption, shown below. All optional so
  // a pre-restart server / older transcript falls back to the generic tool card.
  sentImages: z.array(z.string()).optional(),
  sentFiles: z.array(z.string()).optional(),
  caption: z.string().optional(),
})
export type TranscriptToolCall = z.infer<typeof TranscriptToolCall>

// One block-ordered PART of an assistant turn — the fidelity fix. A turn's content interleaves text
// and tool_use blocks in a meaningful order (a "Let me draft the notes:" lead-in sits DIRECTLY above
// the call it introduces). The legacy split text/tools fields discarded that order (all tools rendered
// before all prose); `parts` preserves it. Contiguous same-kind blocks coalesce into one part.
export const TranscriptPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tools"), tools: z.array(TranscriptToolCall) }),
])
export type TranscriptPart = z.infer<typeof TranscriptPart>

export const TranscriptMessage = z.object({
  // Stable identity of this PROVIDER-NEUTRAL projected message. The server derives it from the
  // transcript incarnation plus the source record that opened the rendered unit; clients use it only
  // for overlap reconciliation, keyed rendering, and scroll anchoring. Optional for rolling upgrades.
  sourceId: z.string().min(1).max(768).optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string(), // markdown; empty when the message was tool-calls only
  // Optional presentation-only projection of `text`. The full text remains available to persistence,
  // search, and transcript logic; shared chat surfaces use this compact form for generated prompts
  // whose machine-facing tail would otherwise dominate the first user bubble.
  displayText: z.string().optional(),
  tools: z.array(TranscriptToolCall),
  at: z.string().optional(), // ISO8601
  // Additive message variant. "event" is transcript PUNCTUATION emitted inline at the position a
  // sub-agent completion <task-notification> was seen (text like `Agent "…" finished — 35m`).
  // "reasoning" is a Codex model-reasoning SUMMARY (the plaintext `summary[]` of a rollout reasoning
  // record — Claude's thinking is redacted at every seam, so this is Codex-only); `text` holds the
  // summary markdown, rendered as a collapsed-by-default expandable block. Absent (undefined) → an
  // ordinary user/assistant message. Old clients that don't know a `kind` render it as a plain
  // assistant line, which is a graceful (if unstyled) degrade.
  kind: z.enum(["event", "reasoning"]).optional(),
  // Wall-clock the model spent THINKING, in ms — set only on a `kind:"reasoning"` message. Derived from
  // the rollout's per-step reasoning timestamps (Σ of each reasoning step's gap from the event before it,
  // which excludes tool-execution time). Drives the "Thought for N seconds" label. Optional: absent on
  // non-reasoning messages and on any reasoning block whose timing couldn't be derived.
  durationMs: z.number().nonnegative().optional(),
  // A turn-BOUNDARY marker: this `kind:"event"` line was emitted at the position an EXTERNAL wake — a
  // background task/shell completion `<task-notification>` — re-invoked the agent and started a fresh
  // turn. The client renders it as a centered divider rule carrying the cause label, so two consecutive
  // assistant turns (each with its own trailing signal) no longer paint as one seamless bubble. Additive
  // + optional: an old client ignores it and shows the plain quiet event line (graceful degrade).
  boundary: z.boolean().optional(),
  // Block-ordered content for an assistant turn (see TranscriptPart). Defaults to [] so a pre-restart
  // server (which ships only text/tools) parses; the client renders `parts` when non-empty and falls
  // back to the legacy tools-then-text layout when it's empty. `text`/`tools` stay populated for that
  // fallback window and for consumers (useLiveAnswering, previews) that read the flat fields.
  parts: z.array(TranscriptPart).default([]),
  // A human follow-up SENT to a mid-turn worker that Claude Code has QUEUED but not yet delivered into
  // the agent's context (an `enqueue` queue-operation with no matching delivery record yet). Rendered as
  // a grayed user bubble — the SAME affordance the client uses for its own optimistic send. Flips to
  // undefined/false once the delivery (a `queued_command` attachment) materializes the message. Additive
  // + optional: a pre-restart client ignores it; an old server simply never sets it. NB: the client ALSO
  // sets this transiently on an optimistic local send (see web hooks.ts) — same meaning, same styling.
  queued: z.boolean().optional(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessage>

// Backward transcript pagination is cursor-based rather than an arbitrary message-count offset. A
// cursor is opaque to the browser and binds one projected boundary to its exact session/transcript
// incarnation. `reachedTurnBoundary:false` is the explicit continuation-within-turn contract used
// only when one pathological turn crosses the bounded page ceiling.
export const TranscriptPageCursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/)
export type TranscriptPageCursor = z.infer<typeof TranscriptPageCursor>

export const TranscriptPage = z.object({
  messages: z.array(TranscriptMessage),
  beforeCursor: TranscriptPageCursor.nullable(),
  hasEarlier: z.boolean(),
  reachedTurnBoundary: z.boolean(),
  transcriptKey: z.string().min(1).max(256),
}).strict()
export type TranscriptPage = z.infer<typeof TranscriptPage>

export const TranscriptEarlierInput = z.object({
  slug: ThreadSlug,
  cursor: TranscriptPageCursor,
}).strict()
export type TranscriptEarlierInput = z.infer<typeof TranscriptEarlierInput>

// ---- Terminal WebSocket protocol (ws://host/term/:slug) ----
// client -> server: {t:"input", d:string} | {t:"resize", cols:number, rows:number}
// server -> client: raw utf8 terminal output frames
export type TermClientMsg = { t: "input"; d: string } | { t: "resize"; cols: number; rows: number }

// ---- /ws multiplex protocol (ws://host/ws) — stage 2: ONE socket for board + transcript + notify ----
// The board & notify frames REUSE the stage-1 ServerEvent shapes verbatim (wrapped in {t:"event"}), so the
// client feeds them through the exact same delta/seq/boot handler as SSE (see web/api/board-stream.ts).
// Transcript frames replace the 1.5s threadTranscript poll with server PUSH for subscribed slugs. Terminals
// keep their own /term/:slug socket. Coexists with /events as a graceful fallback (a pre-restart server has
// no /ws route → the client degrades to SSE + polling).

// Client -> server (zod-validated server-side): subscribe / unsubscribe a thread's transcript push.
// Keep the wire identifier aligned with every server-owned thread slug. Besides bounding retained
// subscription state, the shape excludes path separators/control text before it can reach transcript
// lookup code. Foreign session ids are UUID-shaped and remain valid under this grammar.
export const SOCKET_TRANSCRIPT_SLUG_MAX_CHARS = THREAD_SLUG_MAX_CHARS
export const SocketTranscriptSlug = ThreadSlug
export const SocketClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
  z.object({ t: z.literal("unsub"), topic: z.literal("transcript"), slug: SocketTranscriptSlug }).strict(),
])
export type SocketClientMsg = z.infer<typeof SocketClientMsg>

// server -> client (hand-built by the server, parsed defensively by the client — a plain union, no zod):
//   - {t:"event"}      wraps a ServerEvent (board keyframe / board-delta / notify)
//   - {t:"transcript"} the pushed transcript for a subscribed slug (replaces the poll response)
//   - {t:"payload-too-large"} is a stable, typed transport downgrade. A board overflow moves the client
//     to SSE once; a transcript overflow pauses only that subscription and leaves explicit HTTP refresh.
//   - {t:"resource-limited"} rejects one transcript subscription when the process/origin read budget is
//     exhausted. The board socket stays healthy and the client exposes an explicit retry instead of churn.
//   - {t:"hb"}         10s heartbeat so the client's staleness watchdog works as it did over SSE
export type SocketServerMsg =
  | { t: "event"; event: ServerEvent }
  | { t: "transcript"; slug: ThreadSlug; messages: TranscriptMessage[] }
  | { t: "payload-too-large"; channel: "board"; actualBytes: number; maxBytes: number }
  | { t: "payload-too-large"; channel: "transcript"; slug: ThreadSlug; actualBytes: number; maxBytes: number }
  | {
      t: "resource-limited"
      resource: "transcript-read"
      scope: "origin" | "global"
      slug: ThreadSlug
      retryAfterMs: number
    }
  | { t: "hb" }

export const DEFAULT_PORT = 4917
// The tmux socket name is NOT a shared constant: it is derived PER-PROJECT at server init (see
// server/tmux.ts deriveSocket/setSocket/socketName) so two fray-ui instances never share one tmux
// server and collide on fray-<slug> session names. Route all `tmux -L <socket>` calls through
// tmux.socketName(); never re-introduce a literal socket constant here.
export const tmuxSessionName = (slug: string) => `fray-${ThreadSlug.parse(slug)}`
