import { z } from "zod"

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

// ---- Session-first signal model (2026-07-09) ----
// Threads ARE sessions now (the user-facing word stays THREAD — maintainer-settled): the primary
// listing entity is a claude session discovered from the project's JSONL dir, registered (fray-
// spawned, tmux-attached) or FOREIGN (a maintainer terminal — no registry row, read-only, no tmux
// verbs). Legacy .fray/<slug>.md rows survive read-only in a collapsed Legacy shelf. The queue
// inversion: a thread at rest is awaiting the human UNLESS it excused itself with a signal fence.

// A machine-wait hint parsed from `<kind>: <value>` lines in an ```awaiting fence body.
export const AwaitingHint = z.object({
  kind: z.enum(["pr", "ci", "timer", "session"]),
  value: z.string(),
})
export type AwaitingHint = z.infer<typeof AwaitingHint>

// The signal fence on a thread's FINAL assistant message — the fence language IS the state, the
// body is the message. `done` = success card (Archive button; the fence itself MUTATES NOTHING —
// maintainer-settled) and excusal from the queue; `awaiting` = machine-wait excusal (hints above).
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
  threadIds: z.array(z.string()).default([]), // threads dispatched from this plan
})
export type PlanView = z.infer<typeof PlanView>

// One sidebar row: fray board thread + runtime overlay.
export const ThreadView = z.object({
  id: z.string(), // slug; filename is <slug>.md
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
  dependsOn: z.array(z.string()),
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
  lastActivityAt: z.string().optional(), // ISO8601, from jsonl tail
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
  // Derived safety net (tailer): at rest with an unanswered ```question the worker asked in chat but
  // never encoded as blocked. Defaults false so old snapshots/rows parse. Feeds needsAction.
  pendingQuestion: z.boolean().default(false),
  // ISO8601 of the newest REAL user interaction (answer/steer/dispatch) — the chronological listing
  // sort key. Optional; the listing falls back to spawnedAt when absent (a dispatch IS an interaction).
  lastUserAt: z.string().optional(),

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
  // The signal fence on the final assistant message, present only while the thread is excused by it.
  lastFence: ThreadFence.optional(),
  // SERVER-DERIVED queue membership: at rest + unexcused + activity newer than seen_at, plus the
  // process-level blocks (perm-prompt / pendingAsk) that a view can't clear. The client renders the
  // queue off this bit alone for session threads (legacy rows keep needsAction()).
  needsYou: z.boolean().optional(),
  // ISO8601 of the last interaction clearance (threadSeen RPC — recorded when the human opens the
  // thread). Queue mechanics only — never a badge on done/archived work.
  seenAt: z.string().optional(),
  // Project-relative scratchpad path (.fray/scratch/<session-id>.md) once provisioned — the worker's
  // compaction-proof working memory, rendered as the thread's doc tab.
  scratchpadPath: z.string().optional(),
  // Project-relative plan artifact this thread was dispatched from (.fray/plans/*.md), if any.
  planPath: z.string().optional(),
  // Which agent backend runs this thread (Codex-support epic, Phase 3) — drives the subtle per-row
  // rail badge. Optional so a legacy/foreign/pre-restart row parses; absent OR "claude" ⇒ no badge
  // (Claude is the unmarked default), "codex" ⇒ the small Codex badge.
  backend: Backend.optional(),
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

// ---- Settings ----

export const PermissionMode = z.enum(["auto", "default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = z.infer<typeof PermissionMode>

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
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  notifications: z.boolean(),
  // UI type family. `mono` (default) is the mono-forward system; `sans` swaps prose/UI chrome to a
  // sans stack while code / tool lines / the terminal stay mono. Optional so an old settings blob
  // parses; defaultSettings pins "mono".
  font: z.enum(["mono", "sans"]).optional(),
  // GitHub batch-dispatch prompt templates (the picker's per-item worker prompt). Optional: when
  // unset OR blank the server falls back to its exported DEFAULT_ISSUE_PROMPT / DEFAULT_PR_PROMPT.
  // Substitution tokens the server fills: {repo} {n} {title} {url} {labels} {body}. The leading
  // `THREAD: <slug>` tag is prepended by the server (not part of the editable template) so a custom
  // prompt can never break the thread↔.fray-file binding. Optional so old settings blobs parse.
  githubIssuePrompt: z.string().optional(),
  githubPrPrompt: z.string().optional(),
})
export type Settings = z.infer<typeof Settings>

// ---- RPC inputs ----

export const DispatchInput = z.object({
  // Optional: when omitted, dispatch derives a fallback title from the prompt (Claude later renames
  // the session via ai-title, which the UI prefers for display). The thread FILE always gets a
  // concrete title regardless — fray requires one.
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(), // derived from title if omitted
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

export const FollowUpInput = z.object({
  slug: z.string(),
  message: z.string().min(1),
})
export type FollowUpInput = z.infer<typeof FollowUpInput>

// ---- GitHub-first batch dispatch (server ↔ web mirror; wrapper in server/github.ts) ----

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
export const GithubBatchInput = z.object({
  items: z.array(z.object({ kind: z.enum(["issue", "pr"]), number: z.number().int().positive() })).min(1).max(20),
  model: z.string().optional(),
  effort: Settings.shape.effort,
  permissionMode: PermissionMode.optional(),
})
export type GithubBatchInput = z.infer<typeof GithubBatchInput>

export const GithubBatchResult = z.object({
  dispatched: z.array(z.object({ number: z.number(), kind: z.string(), slug: z.string() })),
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
    removed: z.array(z.string()),
    meta: BoardMeta.optional(),
  }),
  z.object({
    type: z.literal("notify"),
    slug: z.string(),
    kind: z.enum(["needs-decision", "turn-done", "exited"]),
    title: z.string(),
    body: z.string().optional(),
  }),
])
export type ServerEvent = z.infer<typeof ServerEvent>
export type BoardEvent = Extract<ServerEvent, { type: "board" }>
export type BoardDelta = Extract<ServerEvent, { type: "board-delta" }>

// Pure delta engine + client apply/decision helpers (kept in a sibling module, re-exported here so
// `@fray-ui/shared` stays the single entry point).
export * from "./delta.ts"

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
  // A capped excerpt of a Read call's tool_result (the file content it returned) — set only for Read
  // calls whose result shipped as text. The client renders it as a collapsed, bordered card (same
  // family as Bash/Edit) that expands to the excerpt. Absent for older transcripts / pre-restart
  // servers, in which case the client falls back to the compact one-line Read summary.
  read: z.string().optional(),
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
  role: z.enum(["user", "assistant"]),
  text: z.string(), // markdown; empty when the message was tool-calls only
  tools: z.array(TranscriptToolCall),
  at: z.string().optional(), // ISO8601
  // Additive message variant: a "event" is transcript PUNCTUATION emitted inline at the position a
  // sub-agent completion <task-notification> was seen (text like `Agent "…" finished — 35m`). Absent
  // (undefined) → an ordinary user/assistant message. Old clients that don't know `kind` render it as
  // a plain assistant line, which is a graceful (if unstyled) degrade.
  kind: z.literal("event").optional(),
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

// client -> server (zod-validated server-side): subscribe / unsubscribe a thread's transcript push.
export const SocketClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: z.literal("transcript"), slug: z.string() }),
  z.object({ t: z.literal("unsub"), topic: z.literal("transcript"), slug: z.string() }),
])
export type SocketClientMsg = z.infer<typeof SocketClientMsg>

// server -> client (hand-built by the server, parsed defensively by the client — a plain union, no zod):
//   - {t:"event"}      wraps a ServerEvent (board keyframe / board-delta / notify)
//   - {t:"transcript"} the pushed transcript for a subscribed slug (replaces the poll response)
//   - {t:"hb"}         10s heartbeat so the client's staleness watchdog works as it did over SSE
export type SocketServerMsg =
  | { t: "event"; event: ServerEvent }
  | { t: "transcript"; slug: string; messages: TranscriptMessage[] }
  | { t: "hb" }

export const DEFAULT_PORT = 4917
// The tmux socket name is NOT a shared constant: it is derived PER-PROJECT at server init (see
// server/tmux.ts deriveSocket/setSocket/socketName) so two fray-ui instances never share one tmux
// server and collide on fray-<slug> session names. Route all `tmux -L <socket>` calls through
// tmux.socketName(); never re-introduce a literal socket constant here.
export const tmuxSessionName = (slug: string) => `fray-${slug}`
