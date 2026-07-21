import { isValidAwaitingTimer, type AwaitingHint, type ThreadView } from "@fray-ui/shared"

// Shared listing logic: the queue definition (needsAction), the sidebar's status-keyed sections
// (sectionThreads), and the interaction-recency ordering both surfaces use.

// The title to SHOW for a thread: prefer trustworthy backend title telemetry once it exists, else the
// provenance-aware stored title. One place so every render site (sidebar, palette, header) agrees.
// The narrow Pick accepts a valtio readonly snapshot as readily as a plain ThreadView.
export function displayTitle(t: Pick<ThreadView, "title" | "aiTitle" | "id" | "titleAuto" | "spawnedAt" | "backend" | "runtime">): string {
  // A machine-guessed dispatch title (titleAuto) with no aiTitle yet is NOT a real name — show the
  // "Spinning up…" placeholder while the session is genuinely just spinning up (maintainer 2026-07-10:
  // "do not try to guess at the thread title"). But that's BOUNDED (see titleIsProvisional): a session
  // Claude that never yields an aiTitle falls back after its bounded window; Codex uses live runtime
  // state and the neutral fallback below.
  if (titleIsProvisional(t)) return SPINNING_UP_TITLE
  // Codex's TUI has no native automatic naming event. Fray asks the first finalized response for a
  // hidden title signal; omission or malformed syntax must stay neutral rather than exposing either
  // the stored legacy prompt heuristic or a provider-recorded raw initial prompt.
  if (t.backend === "codex" && t.titleAuto === true && !t.aiTitle?.trim()) return UNTITLED_THREAD_TITLE
  // `titleAuto === false` means the stored title came from a human (dispatch title or explicit rename),
  // so it wins even if a later/stale transcript record carries an aiTitle equal to the slug. Unknown
  // legacy rows retain the historical aiTitle-first fallback because their provenance is unavailable.
  if (t.titleAuto === false && t.title.trim()) return t.title
  // For machine-titled rows, an internal slug is not a display title. This is especially important
  // around native `/rename`: if Claude fails to emit a custom title, the header must keep a neutral
  // name rather than presenting the session identifier as though rename succeeded. Legacy rows
  // (unknown titleAuto) retain the historical id fallback.
  if (t.aiTitle?.trim()) return readableMachineTitle(t.aiTitle)
  if (t.title.trim() && !(t.titleAuto === true && t.title.trim() === t.id)) {
    return t.titleAuto === true ? readableMachineTitle(t.title) : t.title.trim()
  }
  return t.titleAuto === true ? UNTITLED_THREAD_TITLE : t.id
}

// Backend-generated titles are not human metadata. Claude's native auto-rename currently reports a
// semantic kebab slug; humanize that immediately so even the short generate→confirm interval can
// never paint an internal identifier. Explicit/manual titles bypass this helper above and stay exact.
// SENTENCE case (capitalize only the first word) — thread titles follow the repo copy rule (see
// AGENTS.md), never Title Case; mirrors the server's humanizeClaudeTitle so the generate→confirm
// interval and the persisted rename read identically.
export function readableMachineTitle(raw: string): string {
  const title = raw.trim()
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(title)) return title
  const words = title.split(/[-_]+/).filter(Boolean)
  if (words.length === 0) return title
  const joined = words.join(" ").toLowerCase()
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

// The placeholder shown (dimmed) while a freshly-dispatched thread has only a machine-guessed title.
export const SPINNING_UP_TITLE = "Spinning up a thread…"
export const UNTITLED_THREAD_TITLE = "Untitled thread"

// Claude uses a brief time window; Codex uses its concrete spawning runtime state.
const SPIN_UP_MS = 60_000
const CODEX_TITLE_SIGNAL_GRACE_MS = 15_000

// A title is PROVISIONAL when it's the auto-guessed dispatch slug, Claude hasn't named the session yet
// (titleAuto && no aiTitle), AND the dispatch is still WITHIN the spin-up window. The time bound is
// load-bearing: a long session that compacts gets a NEW transcript id, so fray (still tracking the
// pinned id) loses the transcript and never sees an aiTitle — without the bound the row would stick on
// "Spinning up…" forever (maintainer 2026-07-10). After the window it falls back to the dispatch title.
// Root cause of the lost transcript is tracked separately ([[session-transcript-drift]]).
export function titleIsProvisional(t: Pick<ThreadView, "aiTitle" | "titleAuto" | "spawnedAt" | "backend" | "runtime">): boolean {
  if (!t.titleAuto || t.aiTitle) return false
  // Codex now emits its title in the first assistant commentary, normally a couple seconds after the
  // rollout starts. Keep the neutral startup label through that short, bounded title-signal grace so
  // the row never flashes "Untitled thread" between task_started and the comment. A noncompliant or
  // failed worker still degrades to the neutral fallback after the grace; it can never stick here.
  if (t.backend === "codex") {
    if (t.runtime === "spawning") return true
    const spawned = Date.parse(t.spawnedAt ?? "")
    return Number.isFinite(spawned) && Date.now() - spawned < CODEX_TITLE_SIGNAL_GRACE_MS
  }
  const spawned = Date.parse(t.spawnedAt ?? "")
  return Number.isFinite(spawned) && Date.now() - spawned < SPIN_UP_MS
}

// A thread "needs action" when it is genuinely waiting on the human — and ONLY once the agent has
// actually come to rest on that wait. A mid-turn thread is still working; surfacing it as a card
// gives an empty "no ask" card because the ask text lands only when the turn ends. These sort to top.
export function needsAction(t: ThreadView): boolean {
  // A TERMINAL thread (done/dismissed) NEVER cards — no exceptions. The thread file is the source
  // of truth, and a thread whose own status says the work is over has by definition nothing waiting
  // on the human. (An earlier "done-but-unread = card until acknowledged" rule violated this and
  // was explicitly overruled by the maintainer: a done thread must never appear in the queue.)
  if (t.status === "done" || t.status === "dismissed") return false
  // Paused on an interactive permission prompt: the process is parked waiting on the human's answer.
  if (t.runtime === "perm-prompt") return true
  // Frozen at a native AskUserQuestion TUI dialog (safety net for pre-contract / adopted sessions that
  // bypass the thread-file ask channel). Unlike the chat/needs-human nets below, NO rest-gate: the ask
  // text lives in the tool_use input (tailer-captured) and is available even while the turn reads
  // "running" (the session is blocked mid-tool_use), so it should card the moment it appears.
  if (t.pendingAsk) return true
  // The DECLARED awaiting-you channel: humanBlocked is re-derived server-side from `status:
  // needs-human` — the first-class "awaiting a human" state and THE queue definition. TWO gates:
  //   • NOT mid-turn (running/spawning): the worker writes needs-human MID-TURN (~150ms after the
  //     file hits disk), but the visible ask text lands with the final message only when the turn
  //     comes to rest — counting it early yields a card with no visible ask.
  //   • A SESSION EXISTS (runtime !== "none"): the queue is strictly "agent work paused on the
  //     human" (maintainer, 2026-07-09: with no agent it makes no sense for a thread to ever show
  //     up inside the queue). A needs-human thread worked OUTSIDE fray-ui (fray classic, hand
  //     edits) has no transcript to card — it stays visible in the SIDEBAR (yellow awaiting-you
  //     dot), and its click-through composite (doc + kick-off composer) is where it gets read and
  //     acted on. `exited` still cards: that agent RAN and asked here — the ask is in its transcript.
  if (t.humanBlocked && t.runtime !== "none" && t.runtime !== "running" && t.runtime !== "spawning") return true
  // DERIVED safety net behind the declared needs-human channel: a worker that asked the human a
  // question IN CHAT (a ```question block in its final message) but never flipped its thread file to
  // needs-human — the board would otherwise see {active, humanBlocked:false, turn-idle} and show
  // nothing. Same rest-gate: only once the agent is off-turn (else the ask text hasn't landed).
  if (t.pendingQuestion && t.runtime !== "running" && t.runtime !== "spawning") return true
  // CRASH / STALL net (replaces the old `unread`-gated clause — `unread` no longer drives anything).
  // A thread whose status still claims WORK IN FLIGHT (active or planning) but whose backing agent
  // PROCESS is gone — `exited` (session row present, tmux pane dead) or `none` (registry lost the row)
  // — is a crash/stall the human must see. Deliberately SCOPED to the in-flight work statuses, because
  // "an agent died MID-WORK" is exactly active/planning:
  //   • `blocked` is a MACHINE-wait — its agent is LEGITIMATELY absent (waiting on revalidate_at /
  //     blocking_threads), and a killed/rebooted session (tmux dies → every spawned thread goes
  //     exited/none) must NOT card it or steal its timer/threads glyph (Nav short-circuits on
  //     needsAction before those glyphs). blocked never cards — that's the spec.
  //   • `needs-human` with a session already cards via the humanBlocked clause above (session-less
  //     needs-human deliberately does NOT card — see that clause); `done`/`dismissed` are excluded
  //     by the terminal guard; `planned` is not-yet-started backlog.
  // No fight with the humanBlocked clause: this net requires status active/planning, which
  // needs-human never is; and its `none` case requires spawnedAt (a session RAN then vanished from
  // the registry — a real crash), which a never-spawned thread lacks.
  // Also gated on `spawnedAt` (a NEVER-spawned item never "died mid-work") and `!archived` (a hidden
  // thread never cards, even if its archive→done write lost a race).
  if (
    (t.status === "active" || t.status === "planning") &&
    (t.runtime === "exited" || t.runtime === "none") &&
    t.spawnedAt &&
    !t.archived
  )
    return true
  return false
}

// USER-INTERACTION key (ms): the newest REAL USER INTERACTION on the thread — an answer, a steer, or
// the dispatch itself — falling back to spawn time when there's been no later interaction (a dispatch
// IS an interaction). `lastUserAt` is server-derived to EXCLUDE tool_results, so it never moves from
// AGENT motion. This is the stable base folded into `lastActiveAt` below (and the churn-free fallback
// a still-running row uses). Neither timestamp present → 0 (sinks to the bottom, id-tiebroken).
function interactionAt(t: ThreadView): number {
  const u = Date.parse(t.lastUserAt ?? "")
  const s = Date.parse(t.spawnedAt ?? "")
  const max = Math.max(Number.isFinite(u) ? u : -Infinity, Number.isFinite(s) ? s : -Infinity)
  return Number.isFinite(max) ? max : 0
}

// THE at-rest listing sort key: "last active" = when the thread's OWN agent last came to REST — its
// `lastAssistantAt` (last assistant output). NOT `lastActivityAt`: that is bumped by a background
// sub-agent's completion notification (a promptSource:system record) and by tool_results, so keying on
// it let a CHILD finishing reshuffle the parent (maintainer 2026-07-16: "it should just be based on
// when the agent rested … user turns don't actually factor in"). User turns don't factor in either:
// a steer flips the thread to running, and only its next REST re-times it. A RUNNING row is not in the
// queue/rested band — it belongs to the active rail, ordered by user recency — so it keeps
// `interactionAt` (max lastUserAt/spawnedAt), which also guards against mid-turn churn. Missing rest
// time (never produced output yet) → `interactionAt` (spawn/last-user). `isActivelyRunning` is hoisted.
function lastActiveAt(t: ThreadView): number {
  if (isActivelyRunning(t)) return interactionAt(t)
  const rest = Date.parse(t.lastAssistantAt ?? "")
  return Number.isFinite(rest) ? rest : interactionAt(t)
}

// The timestamp the "Last active" label should DISPLAY, kept in lockstep with the order key so the
// queue's labels read monotonically and never lie. A RUNNING row shows its live activity
// (`lastActivityAt` — "just now" while it works); an AT-REST row shows its rest time (`lastAssistantAt`),
// so a background sub-agent completing can never flip a rested row's label to "just now". Falls back to
// lastActivityAt then spawn when a backend never recorded the rest instant (legacy/foreign rows).
export function lastActiveLabelAt(t: Pick<ThreadView, "runtime" | "lastActivityAt" | "lastAssistantAt" | "spawnedAt" | "subAgents" | "bgShells">): string | undefined {
  if (isActivelyRunning(t as ThreadView)) return t.lastActivityAt ?? t.spawnedAt
  return t.lastAssistantAt ?? t.lastActivityAt ?? t.spawnedAt
}

// The listing DIRECTION the queue/rested band orders by (a per-browser view preference — see
// lib/prefs.ts). FIFO (default) surfaces the longest-waiting item first so the human cycles through
// all work; LIFO surfaces the most-recently-active first.
export type QueueDirection = "fifo" | "lifo"

// Attention first (needsAction), then most-recent LAST-ACTIVE first within each band (see
// lastActiveAt). id-tiebroken so equal-time rows hold a stable order. New array; input untouched.
export function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const aa = needsAction(a)
    const bb = needsAction(b)
    if (aa !== bb) return aa ? -1 : 1
    const d = lastActiveAt(b) - lastActiveAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// Order a thread set by most-recent LAST-ACTIVE first (lastActiveAt), id-tiebroken. Used for the
// running band and the Held/Inactive sections — surfaces where newest-on-top is always wanted (the
// FIFO/LIFO preference governs only the queue/rested band via orderQueue). A running row keys off its
// stable user-interaction time (lastActiveAt's churn guard), so live agent motion never reshuffles it;
// an at-rest row keys off when it came to rest, matching its "Last active" label. New array; input
// untouched.
export function orderByInteraction(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const d = lastActiveAt(b) - lastActiveAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// Queue cards have two deliberately small priority bands. A concrete unresolved request or failure
// comes before an ordinary bare-rest/done handoff, even when that passive handoff was touched more
// recently. Within a band, the queue orders FIFO (see orderQueue) so the human cycles through all
// waiting work instead of re-triaging whatever rested most recently.
// `pendingInteraction` is intentionally absent: a response still awaiting provider acknowledgement
// remains readable, but only `actionableInteraction` means the human still owes a decision.
export type QueuePriority = 0 | 1

export function queuePriority(t: ThreadView): QueuePriority {
  const hardAttention = Boolean(
    t.actionableInteraction ||
      t.pendingAsk ||
      t.nativeInputRequired ||
      t.pendingQuestion ||
      t.runtime === "perm-prompt" ||
      t.crashed ||
      t.humanBlocked ||
      t.status === "needs-human",
  )
  return hardAttention ? 0 : 1
}

// Within each priority band, order by DIRECTION (a per-browser view preference — see lib/prefs.ts):
//   • FIFO (default): the thread gone LONGEST without activity surfaces first (oldest lastActiveAt =
//     ascending), so answering it sends it to the BACK of the line and the next-oldest rises — the
//     human cycles through every waiting item instead of endlessly re-triaging whatever rested most
//     recently (maintainer 2026-07-15: "first in first out is a better system… you are not constantly
//     cycling through all of the tasks").
//   • LIFO: the most-recently-active first (descending) — the older last-in-first-out feel.
// The hard-attention band always leads regardless. lastActiveAt keys off when an AT-REST thread came
// to rest (matching its "Last active" label) and off the stable user-interaction time for a running
// row, so agent tool churn never reorders a card. id-tiebroken for a stable order among equal-age rows.
export function orderQueue(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  const dir = direction === "lifo" ? -1 : 1
  return [...threads].sort((a, b) => {
    const priority = queuePriority(a) - queuePriority(b)
    if (priority !== 0) return priority
    const age = (lastActiveAt(a) - lastActiveAt(b)) * dir
    return age !== 0 ? age : a.id.localeCompare(b.id)
  })
}

// ── SESSION-FIRST QUEUE ──────────────────────────────────────────────────────────────────────────
// The Needs-you queue (the cards surface) is EXACTLY the session threads the SERVER derived as needing
// the human (t.needsYou — explicit questions, checked/done handoffs, and process-level blocks a view
// can't clear). Do NOT re-derive it client-side for session rows. Legacy .fray-file rows
// never card anymore. An archived thread is out of the queue regardless (belt-and-suspenders — the
// server already drops needsYou when archived). Pre-restart snapshots carry no kind/needsYou → false →
// an empty queue, the accepted degrade.
export function queued(t: ThreadView): boolean {
  // Foreign (terminal-originated) sessions never queue: their interaction surface is the terminal
  // the human is already sitting in — fray can't be "awaiting" them here.
  return t.kind === "session" && t.foreign !== true && t.needsYou === true && t.state !== "archived"
}

// Foreign sessions — Claude Code sessions discovered in the project's JSONL dir that fray did NOT
// originate (the maintainer's own terminals). NOT rail rows (maintainer 2026-07-09: only
// fray-originated threads belong in the rail) — the Sidebar renders them as a one-line ambient
// presence strip, preserving the earlier "detect active Claude Code sessions" ask without the noise.
export function foreignThreads(threads: readonly ThreadView[]): ThreadView[] {
  return threads.filter((t) => t.kind === "session" && t.foreign === true)
}

// ── SIDEBAR SECTIONS (session-first) ───────────────────────────────────────────────────────────────
// The rail's THREAD-derived sections, keyed on the session-first model (NOT fray status). Every thread
// row lands in exactly one of these; the Plans section is separate (from board.plans, not threads).
//   • active           — open session work: running, needs-you, bare rest, done-fenced, OR owning a
//                        live sub-agent/background shell/Monitor. Never dimmed as a band.
//   • held             — open, AT REST behind ANY declared ```awaiting fence (or the canonical
//                        blocked+timer status) AND no live background op. Its own DIMMED band between
//                        Active and Inactive. The glyph and section share isHeld(), so a row can never
//                        show a clock/hourglass while remaining in Active.
//   • inactive         — state === "archived" (the only archiver is an explicit Archive / done-card button).
//   • legacy           — kind !== "session": vestigial .fray-file rows, hidden entirely (null).
// A FOREIGN session row (a maintainer terminal — no registry row, so no state/needsYou) is dropped
// entirely (never rows). Order within a section is interaction recency.
export type SectionKey = "active" | "held" | "inactive"
// Thread-derived buckets, in render order. The Plans section (board.plans) is interleaved by the
// Sidebar after the thread buckets; it has no thread bucket here.
export const SECTION_ORDER: readonly SectionKey[] = ["active", "held", "inactive"]

// A session process is "at rest" (off-turn) when the pane is idle or the session has exited — the gate
// an awaiting excusal needs (a mid-turn worker is still working, never awaiting).
function atRest(t: ThreadView): boolean {
  return t.runtime === "turn-idle" || t.runtime === "exited"
}

// DECLARED PARK: at rest behind an ```awaiting fence — the thread ITSELF declared it is parked, not
// still working. The current contract reserves this for a human gate/timer; legacy hints remain readable. The
// RAW signal; the banding below refines it into external-vs-internal. NB: this requires the worker to
// actually emit the fence — a thread that rests bare (prose only) reads as idle/waiting, not declared.
function isDeclaredAwaiting(t: ThreadView): boolean {
  return atRest(t) && t.lastFence?.kind === "awaiting"
}

// INTERNAL WORK: a thread with a LIVE sub-agent is awaiting its OWN dispatched child — not an external
// event — so it is a fully ACTIVE thread and must never be dimmed (maintainer 2026-07-10: "when an
// agent is merely awaiting its own sub-agents, we should NOT dim it — that's the differentiator").
function hasLiveSubAgents(t: ThreadView): boolean {
  return (t.subAgents ?? []).some((s) => s.state === "running")
}

// A background Bash/Monitor is work the top-level worker still OWNS. It is surfaced separately from
// drill-in sub-agents, but has the same section consequence: keep the parent Active and spinning.
function hasLiveBackgroundOps(t: ThreadView): boolean {
  return (t.bgShells ?? []).some((s) => s.state === "running")
}

function hasLiveOps(t: ThreadView): boolean {
  return hasLiveSubAgents(t) || hasLiveBackgroundOps(t)
}

// The wait kinds that truthfully earn the parked/hourglass presentation. A timer is only a park while
// its valid scheduler instant is still in the future; malformed or elapsed timer prose must not
// advertise a durable future wake. github-review is an external HUMAN gate with a durable GitHub
// activity cursor. Legacy machine waits (pr/ci/session) intentionally do not qualify.
export function parkedAwaitingHint(hints: readonly AwaitingHint[], nowMs = Date.now()): AwaitingHint | undefined {
  return (
    hints.find((h) => h.kind === "human") ??
    hints.find((h) => h.kind === "github-review") ??
    hints.find((h) => h.kind === "timer" && isValidAwaitingTimer(h.value) && Date.parse(h.value) > nowMs)
  )
}

export function futureSnoozedUntil(
  t: Pick<ThreadView, "snoozedUntil">,
  nowMs = Date.now(),
): string | undefined {
  const at = Date.parse(t.snoozedUntil ?? "")
  return Number.isFinite(at) && at > nowMs ? t.snoozedUntil : undefined
}

// HELD: one semantic predicate owns both classification and presentation. Only a specific external
// human/review gate or a valid FUTURE timestamp belongs in the dimmed Held band. Legacy automated
// waits (pr/ci/session), malformed/elapsed timers, and hintless fences stay Active so they cannot hide
// work an agent should own through an in-band watcher. A canonical blocked+timer status remains a
// compatibility path only when it carries the same explicit future ISO instant. A live child/Monitor
// wins, and archived rows remain Inactive/done.
export function isHeld(t: ThreadView, nowMs = Date.now()): boolean {
  const userSnooze = futureSnoozedUntil(t, nowMs) !== undefined
  if (t.state === "archived" || hasLiveOps(t)) return false
  // A user-owned snooze deliberately wins over a concrete ask, permission prompt, or crash. Those
  // states still exist in the transcript/runtime and re-enter Queue at the exact wake deadline; the
  // snooze merely parks their presentation until then. Mid-turn work keeps running in Active, while
  // a provider permission prompt is itself parked and may therefore move to Held.
  if (userSnooze) return t.runtime !== "running" && t.runtime !== "spawning"
  // Without an explicit user snooze, higher-priority attention states render ?, !, or a native
  // prompt—not a wait glyph—so a stale awaiting fence cannot demote them out of Queue.
  if (t.needsYou || t.pendingAsk || t.runtime === "perm-prompt") return false
  if (!atRest(t)) return false
  const declaredWait = t.lastFence?.kind === "awaiting" && parkedAwaitingHint(t.lastFence.hints, nowMs) !== undefined
  const timedStatus =
    t.status === "blocked" &&
    t.mechanism === "timer" &&
    typeof t.revalidate === "string" &&
    isValidAwaitingTimer(t.revalidate) &&
    Date.parse(t.revalidate) > nowMs
  return userSnooze || declaredWait || timedStatus
}

// ACTIVELY RUNNING: a live session with work in flight — exactly the states the sidebar renders with a
// spinner (running/spawning, or turn-idle while a dispatched sub-agent is still going). A running thread
// must NEVER be filed under Inactive, even when its row is archived (maintainer 2026-07-10, hit 3×: a
// bumped-then-resumed archived thread showed a spinner under Inactive).
export function isActivelyRunning(t: ThreadView): boolean {
  if (t.runtime === "running" || t.runtime === "spawning") return true
  return t.runtime === "turn-idle" && hasLiveOps(t)
}

// One status-priority decision shared by the sidebar renderer and its tests. The order is important:
// an archived row at rest stays archived even if stale attention metadata lingers; a real human ask
// stays a question after the worker exits; live work stays working; and a completed handoff stays a
// check instead of being mislabelled as a crash merely because `needsYou` also puts it in the queue.
export type SessionIndicatorKind = "archived" | "needs-input" | "working" | "done" | "stalled" | "held" | "rest"

export function sessionIndicatorKind(t: ThreadView): SessionIndicatorKind {
  const activelyRunning = isActivelyRunning(t)
  if (t.state === "archived" && !activelyRunning) return "archived"

  const explicitlyNeedsInput = Boolean(
    t.actionableInteraction ||
      t.pendingAsk ||
      t.pendingQuestion ||
      t.nativeInputRequired ||
      t.runtime === "perm-prompt" ||
      t.humanBlocked ||
      t.status === "needs-human",
  )
  if (explicitlyNeedsInput) return "needs-input"
  if (activelyRunning) return "working"

  if (isHeld(t)) return "held"
  if (t.lastFence?.kind === "done" && atRest(t)) return "done"
  // `crashed` is explicit on current snapshots. During a rolling client/server reload an older
  // snapshot may omit it; retain the old exited+needsYou crash rendering only for that undefined
  // compatibility case. Crucially, Queue membership alone says only "this turn came to rest"—a
  // clean bare rest keeps the ordinary ellipsis instead of falsely advertising a question.
  if (t.crashed === true || (t.crashed === undefined && t.needsYou && t.runtime === "exited")) return "stalled"
  return "rest"
}

export function sectionOf(t: ThreadView): SectionKey | null {
  // MAINTAINER 2026-07-09 (v2 sections): ONE Active section — anything running, awaiting the human,
  // or machine-awaiting is simply ACTIVE (the split sections made seen-clearance visibly shuffle rows
  // between Needs-you and Working on click, which read as an unread feature). The needs-you/awaiting
  // distinction still renders — as the row INDICATOR and the queue cards — just not as sections.
  // Legacy (.fray-file) rows are HIDDEN entirely (null; not even a shelf). Foreign never rows.
  if (t.kind !== "session") return null
  // Archived → Inactive, UNLESS it's actively running: a live, in-flight session must never sit in
  // Inactive (maintainer, hit 3×). It shows in Active with its spinner while it works, and drops back
  // to Inactive only once it comes to rest still-archived. (A user BUMP un-archives it for good via
  // resume; this is the display safety net for a running-yet-archived session.)
  if (t.state === "archived" && !isActivelyRunning(t)) return "inactive"
  // Only truthful human/future-timer waiters split into the labeled, dimmed Held band.
  // Everything else open — running, needs-you, bare rest, done-fenced, awaiting-its-own-subs, or an
  // awaiting `session`/hintless wait — is Active.
  if (isHeld(t)) return "held"
  return "active"
}

// The Active section is TWO rule-separated bands (the Sidebar draws the rule): actively-running work
// on top, then everything at rest BELOW — and the rested band is ordered by the EXACT queue comparator
// (orderQueue), so the sidebar's rested rows and the Needs-you queue cards share ONE order. That shared
// order is what makes the scroll-position marker monotonic: scrolling the queue down walks the marker
// straight down the rail instead of hopping around (maintainer 2026-07-15: the queue/sidebar mismatch
// "totally defeats the purpose of the scroll position indicator"; running agents "should not render in
// the queue at all"). Running threads have no queue card, so their interaction-recency order never
// affects the marker — grouping them on top just keeps live work glanceable and out of the rested run.
export function orderActive(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  const running = threads.filter(inActiveRunningBand)
  const rested = threads.filter((t) => !inActiveRunningBand(t))
  return [...orderByInteraction(running), ...orderQueue(rested, direction)]
}

// The running band is strictly live work that ISN'T waiting on the human: a queued thread ALWAYS
// belongs to the rested band so its queue card maps to a rested-band row and the marker stays
// monotonic even in the rare spinning-yet-needs-you state. (Its rail indicator may still be a spinner
// via sessionIndicatorKind — cosmetic; what matters here is that it never leaves the rested band.)
function inActiveRunningBand(t: ThreadView): boolean {
  return isActivelyRunning(t) && t.needsYou !== true
}

// Split an ALREADY-ordered Active list (see orderActive) into its running/rested bands WITHOUT
// re-sorting — filter() preserves orderActive's order — so the Sidebar can render the separating rule.
export function partitionActive(active: readonly ThreadView[]): { running: ThreadView[]; rested: ThreadView[] } {
  return {
    running: active.filter(inActiveRunningBand),
    rested: active.filter((t) => !inActiveRunningBand(t)),
  }
}

// Partition threads into the thread-derived sidebar sections. Active sinks its leftover declared-waiting
// Held and inactive/archived are plain interaction recency.
export type SectionedThreads = Record<SectionKey, ThreadView[]>
export function sectionThreads(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): SectionedThreads {
  const out: SectionedThreads = { active: [], held: [], inactive: [] }
  for (const t of threads) {
    if (t.kind === "session" && t.foreign === true) continue // foreign sessions never row (nor strip — dropped)
    const k = sectionOf(t)
    if (k) out[k].push(t)
  }
  out.active = orderActive(out.active, direction)
  out.held = orderByInteraction(out.held)
  out.inactive = orderByInteraction(out.inactive)
  return out
}
