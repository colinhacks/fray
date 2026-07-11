import type { ThreadView } from "@fray-ui/shared"

// Shared listing logic: the queue definition (needsAction), the sidebar's status-keyed sections
// (sectionThreads), and the interaction-recency ordering both surfaces use.

// The title to SHOW for a thread: prefer Claude's own auto-generated session name (aiTitle) once it
// exists, else the dispatch title. One place so every render site (sidebar, palette, header) agrees.
// Typed to just the two fields it reads so it accepts a valtio readonly snapshot as readily as a
// plain ThreadView.
export function displayTitle(t: Pick<ThreadView, "title" | "aiTitle" | "id" | "titleAuto" | "spawnedAt">): string {
  // A machine-guessed dispatch title (titleAuto) with no aiTitle yet is NOT a real name — show the
  // "Spinning up…" placeholder while the session is genuinely just spinning up (maintainer 2026-07-10:
  // "do not try to guess at the thread title"). But that's BOUNDED (see titleIsProvisional): a session
  // that never yields an aiTitle must fall back to the dispatch title, not stick on "Spinning up…".
  if (titleIsProvisional(t)) return SPINNING_UP_TITLE
  // aiTitle first, then the dispatch title; a session row can carry title "" with no aiTitle yet, so
  // fall back to the slug/id (a bare thread never renders as an empty row).
  return t.aiTitle || t.title || t.id
}

// The placeholder shown (dimmed) while a freshly-dispatched thread has only a machine-guessed title.
export const SPINNING_UP_TITLE = "Spinning up a thread…"

// "Spinning up…" is a BRIEF placeholder for the window between dispatch and Claude naming the session.
const SPIN_UP_MS = 60_000

// A title is PROVISIONAL when it's the auto-guessed dispatch slug, Claude hasn't named the session yet
// (titleAuto && no aiTitle), AND the dispatch is still WITHIN the spin-up window. The time bound is
// load-bearing: a long session that compacts gets a NEW transcript id, so fray (still tracking the
// pinned id) loses the transcript and never sees an aiTitle — without the bound the row would stick on
// "Spinning up…" forever (maintainer 2026-07-10). After the window it falls back to the dispatch title.
// Root cause of the lost transcript is tracked separately ([[session-transcript-drift]]).
export function titleIsProvisional(t: Pick<ThreadView, "aiTitle" | "titleAuto" | "spawnedAt">): boolean {
  if (!t.titleAuto || t.aiTitle) return false
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

// Chronological listing key (ms): the newest REAL USER INTERACTION on the thread — an answer, a
// steer, or the dispatch itself — falling back to spawn time when there's been no later interaction (a
// dispatch IS an interaction). This is the ONLY thing that reorders a row: the user's own actions bump
// it to the top, predictably. Crucially it does NOT key off `lastActivityAt` (which includes AGENT
// tool churn) — `lastUserAt` is server-derived to EXCLUDE tool_results, so a row never jumps from
// motion the user didn't cause. Neither timestamp present → 0 (sinks to the bottom, id-tiebroken).
function interactionAt(t: ThreadView): number {
  const u = Date.parse(t.lastUserAt ?? "")
  const s = Date.parse(t.spawnedAt ?? "")
  const max = Math.max(Number.isFinite(u) ? u : -Infinity, Number.isFinite(s) ? s : -Infinity)
  return Number.isFinite(max) ? max : 0
}

// Attention first (needsAction), then most-recent USER-INTERACTION first within each band (see
// interactionAt). id-tiebroken so equal-time rows hold a stable order. New array; input untouched.
export function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const aa = needsAction(a)
    const bb = needsAction(b)
    if (aa !== bb) return aa ? -1 : 1
    const d = interactionAt(b) - interactionAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// Order a thread set by most-recent USER-INTERACTION first (interactionAt), id-tiebroken. HISTORY:
// the listing was once STABLE SPAWN-ORDER, to stop it reshuffling under the (since-deleted) arrow-walk
// — but the reshuffle it guarded against was AGENT activity (lastActivityAt moving from tool churn the
// user didn't cause). This key keeps that guarantee (lastUserAt excludes tool_results, so agent motion
// never reorders) while ADDING the motion the maintainer wants: a row the user just acted on —
// answered, steered, dispatched — bumps to the top. Predictable, self-caused motion only. New array;
// input untouched.
export function orderByInteraction(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const d = interactionAt(b) - interactionAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// ── SESSION-FIRST QUEUE ──────────────────────────────────────────────────────────────────────────
// The Needs-you queue (the cards surface) is EXACTLY the session threads the SERVER derived as needing
// the human (t.needsYou — at rest + unexcused + activity newer than seen_at, plus the process-level
// blocks a view can't clear). Do NOT re-derive it client-side for session rows. Legacy .fray-file rows
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
//   • active           — open session work: running, needs-you, bare rest, done-fenced, OR awaiting its
//                        OWN sub-agents (internal work) / another session. Never dimmed as a band.
//   • awaitingExternal — open, AT REST behind an ```awaiting fence whose primary hint is pr/ci/timer AND
//                        no live sub-agents: genuinely blocked on an EXTERNAL event. Its own DIMMED band
//                        between Active and Inactive (maintainer 2026-07-10).
//   • inactive         — state === "archived" (the only archiver is an explicit Archive / done-card button).
//   • legacy           — kind !== "session": vestigial .fray-file rows, hidden entirely (null).
// A FOREIGN session row (a maintainer terminal — no registry row, so no state/needsYou) is dropped
// entirely (never rows). Order within a section is interaction recency.
export type SectionKey = "active" | "awaitingExternal" | "inactive"
// Thread-derived buckets, in render order. The Plans section (board.plans) is interleaved by the
// Sidebar after the thread buckets; it has no thread bucket here.
export const SECTION_ORDER: readonly SectionKey[] = ["active", "awaitingExternal", "inactive"]

// A session process is "at rest" (off-turn) when the pane is idle or the session has exited — the gate
// an awaiting excusal needs (a mid-turn worker is still working, never awaiting).
function atRest(t: ThreadView): boolean {
  return t.runtime === "turn-idle" || t.runtime === "exited"
}

// DECLARED MACHINE-WAIT: at rest behind an ```awaiting fence — the thread ITSELF declared it is parked
// on a machine (CI, a PR review/merge, a timer, another session), not on you and not still working. The
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

// AWAITING-EXTERNAL: the thread is genuinely blocked on an EXTERNAL, scheduler-actionable gate — a
// declared ```awaiting fence at rest whose PRIMARY hint is pr / ci / timer — AND it has no live
// sub-agents. This is the ONLY set that earns the dedicated DIMMED band between Active and Inactive
// (maintainer 2026-07-10: give the truly-external waiters their own band). Excluded on purpose, all
// staying in Active undimmed: a bare rest (no fence), a `session` hint (waiting on another fray session
// reads as internal/ambiguous → treat as Active), and anything with a live sub-agent (internal work —
// hasLiveSubAgents keeps it Active even with a stale awaiting fence).
export function isAwaitingExternal(t: ThreadView): boolean {
  if (!isDeclaredAwaiting(t) || hasLiveSubAgents(t)) return false
  const hk = t.lastFence?.hints[0]?.kind
  return hk === "pr" || hk === "ci" || hk === "timer"
}

// ACTIVELY RUNNING: a live session with work in flight — exactly the states the sidebar renders with a
// spinner (running/spawning, or turn-idle while a dispatched sub-agent is still going). A running thread
// must NEVER be filed under Inactive, even when its row is archived (maintainer 2026-07-10, hit 3×: a
// bumped-then-resumed archived thread showed a spinner under Inactive).
export function isActivelyRunning(t: ThreadView): boolean {
  if (t.runtime === "running" || t.runtime === "spawning") return true
  return t.runtime === "turn-idle" && hasLiveSubAgents(t)
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
  // The EXTERNAL waiters (pr/ci/timer awaiting, no live subs) split out into their own dimmed band.
  // Everything else open — running, needs-you, bare rest, done-fenced, awaiting-its-own-subs, or an
  // awaiting `session`/hintless wait — is Active.
  if (isAwaitingExternal(t)) return "awaitingExternal"
  return "active"
}

// The ACTIVE section's order: interaction-recency, EXCEPT a DECLARED machine-wait that stayed in Active
// (a `session`/hintless ```awaiting fence — the external pr/ci/timer waits live in their own band now)
// sinks to the bottom as a group (maintainer 2026-07-10: "waiting/blocked should always show up at the
// bottom of the active list"). Live work and live-sub-agent threads float on top; interaction recency
// holds within each group. New array; input untouched.
export function orderActive(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const aw = isDeclaredAwaiting(a) && !hasLiveSubAgents(a) ? 1 : 0
    const bw = isDeclaredAwaiting(b) && !hasLiveSubAgents(b) ? 1 : 0
    if (aw !== bw) return aw - bw // declared-waiting sinks below everything still in play
    const d = interactionAt(b) - interactionAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// Partition threads into the thread-derived sidebar sections. Active sinks its leftover declared-waiting
// rows to the bottom (orderActive); awaitingExternal (the dimmed band) and inactive/archived are plain
// interaction recency.
export type SectionedThreads = Record<SectionKey, ThreadView[]>
export function sectionThreads(threads: readonly ThreadView[]): SectionedThreads {
  const out: SectionedThreads = { active: [], awaitingExternal: [], inactive: [] }
  for (const t of threads) {
    if (t.kind === "session" && t.foreign === true) continue // foreign sessions never row (nor strip — dropped)
    const k = sectionOf(t)
    if (k) out[k].push(t)
  }
  out.active = orderActive(out.active)
  out.awaitingExternal = orderByInteraction(out.awaitingExternal)
  out.inactive = orderByInteraction(out.inactive)
  return out
}
