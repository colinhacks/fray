import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { needsAction, queued, sectionOf, sectionThreads, isAwaitingExternal, titleIsProvisional, displayTitle, SPINNING_UP_TITLE } from "./groups.ts"

// Minimal ThreadView fixture — the same shape board-delta.test.ts uses, defaulting to a live/active
// thread; each case overrides only the fields under test.
function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "t",
    title: "t",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    pendingQuestion: false,
    spawnedAt: "2026-07-08T00:00:00.000Z",
    ...over,
  }
}

// ---- needsAction: the queue definition ----

test("needsAction: needs-human AT REST cards — but only with a SESSION (humanBlocked derived from status)", () => {
  // humanBlocked is re-derived server-side as status === "needs-human"; the client sees the flag.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "turn-idle" })), true)
  // exited still cards: that agent RAN and asked here — the ask is in its transcript.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "exited" })), true)
})

test("needsAction: SESSION-LESS needs-human NEVER cards (the queue is agent work paused on the human)", () => {
  // A thread worked outside fray-ui (fray classic / hand edits): no session, no transcript to card.
  // It surfaces in the SIDEBAR (yellow awaiting-you dot); its click-through composite (doc +
  // kick-off composer) is where it gets read and acted on.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "none", spawnedAt: undefined })), false)
  // Even with a spawnedAt on the row, `none` + needs-human stays out of the queue (the crash net
  // only covers active/planning — verified below — so the two clauses never fight).
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "none" })), false)
})

test("needsAction: needs-human MID-TURN does NOT card (the ask text hasn't landed yet)", () => {
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "running" })), false)
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "spawning" })), false)
})

test("needsAction: perm-prompt always cards (a frozen worker can't declare anything)", () => {
  assert.equal(needsAction(thread({ runtime: "perm-prompt" })), true)
})

test("needsAction: a chat question at rest cards; mid-turn it does not", () => {
  assert.equal(needsAction(thread({ pendingQuestion: true, runtime: "turn-idle" })), true)
  assert.equal(needsAction(thread({ pendingQuestion: true, runtime: "running" })), false)
})

test("needsAction: `unread` no longer drives carding (unread is dead)", () => {
  // A completed turn on a still-live thread badged unread — pure progress, never a card.
  assert.equal(needsAction(thread({ unread: true, runtime: "turn-idle" })), false)
  assert.equal(needsAction(thread({ unread: true, runtime: "running" })), false)
})

test("needsAction: crash net — a spawned agent gone while IN-FLIGHT (active/planning) cards", () => {
  assert.equal(needsAction(thread({ status: "active", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), true)
  assert.equal(needsAction(thread({ status: "planning", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), true)
})

test("needsAction: crash net does NOT card a `blocked` MACHINE-wait whose session was cleaned up", () => {
  // blocked = waiting on revalidate_at / blocking_threads. killAgent / reboot kills the tmux session
  // (runtime exited/none, spawnedAt set) — but the agent is LEGITIMATELY absent, not crashed. It must
  // NOT card and must NOT steal the blue dot from its timer/threads glyph (Nav short-circuits on this).
  assert.equal(needsAction(thread({ status: "blocked", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z", mechanism: "timer" })), false)
  assert.equal(needsAction(thread({ status: "blocked", runtime: "none", spawnedAt: "2026-07-08T00:00:00.000Z", mechanism: "threads" })), false)
})

test("needsAction: crash net does NOT flood never-spawned roadmap items", () => {
  // runtime none + no spawnedAt = a planned/planning item no agent ever touched → not a crash.
  assert.equal(needsAction(thread({ status: "planned", runtime: "none", spawnedAt: undefined })), false)
  assert.equal(needsAction(thread({ status: "planning", runtime: "none", spawnedAt: undefined })), false)
  // A spawned `planned` (backlog) thread whose agent exited is NOT mid-work → does not card.
  assert.equal(needsAction(thread({ status: "planned", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
})

test("needsAction: an ARCHIVED thread never crash-cards (even if its archive→done write raced)", () => {
  assert.equal(needsAction(thread({ status: "active", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z", archived: true })), false)
})

test("needsAction: terminal threads NEVER card, even exited-with-spawn (crash net can't win)", () => {
  assert.equal(needsAction(thread({ status: "done", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
  assert.equal(needsAction(thread({ status: "dismissed", runtime: "exited", unread: true })), false)
})

// ---- queued: the session-first queue definition (server-derived t.needsYou) ----

test("queued: a session thread with needsYou cards; without it, it does not", () => {
  assert.equal(queued(thread({ kind: "session", needsYou: true, state: "open" })), true)
  assert.equal(queued(thread({ kind: "session", needsYou: false, state: "open" })), false)
})

test("queued: legacy rows NEVER card (only session threads enter the queue)", () => {
  // kind absent = legacy; even a would-be-actionable legacy row stays out of the queue.
  assert.equal(queued(thread({ needsYou: true, status: "needs-human", humanBlocked: true })), false)
  assert.equal(queued(thread({ kind: "legacy", needsYou: true })), false)
})

test("queued: an archived session thread stays out of the queue even if needsYou lingers", () => {
  assert.equal(queued(thread({ kind: "session", needsYou: true, state: "archived" })), false)
})

test("queued: pre-restart snapshot (no kind/needsYou) degrades to an empty queue", () => {
  assert.equal(queued(thread({})), false)
})

// ---- sidebar sections: session-first partition ----

test("sectionOf v2: ONE Active section — running, needs-you, awaiting all together; archive wins; legacy/foreign never row", () => {
  // Legacy / absent-kind rows are HIDDEN entirely (null), any status.
  assert.equal(sectionOf(thread({ status: "active" })), null)
  assert.equal(sectionOf(thread({ kind: "legacy", status: "done" })), null)
  // Everything open is simply Active: running, at-rest bare, needs-you, done-fenced, awaiting-fenced.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "done", body: "shipped", hints: [] } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), "active")
  // Archive wins over a lingering needsYou.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived" })), "inactive")
  assert.equal(sectionOf(thread({ kind: "session", needsYou: true, state: "archived" })), "inactive")
  // Foreign sessions section as active by sectionOf — but sectionThreads EXCLUDES them from rows.
  assert.equal(sectionOf(thread({ kind: "session", foreign: true, runtime: "running" })), "active")
})

test("sectionOf: an ARCHIVED thread that's ACTIVELY RUNNING goes to Active (never a spinner under Inactive)", () => {
  // Idle-archived stays Inactive — the user hid it and it's at rest.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle" })), "inactive")
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "exited" })), "inactive")
  // Running / spawning archived → Active (a live, in-flight session must NEVER sit in Inactive; maintainer hit 3×).
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "spawning" })), "active")
  // turn-idle but a dispatched sub-agent is still going (the sidebar shows a spinner) → Active too.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", subAgents: [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running", id: "a1" }] })), "active")
})

test("sectionThreads v2: partitions Active/Archive; foreign + legacy excluded; interactionAt orders", () => {
  const s = sectionThreads([
    thread({ id: "older", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "newer", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T01:00:00.000Z" }),
    thread({ id: "queued", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "arch", kind: "session", state: "archived" }),
    thread({ id: "old", status: "done" }),
    thread({ id: "term", kind: "session", foreign: true, runtime: "running" }),
  ])
  assert.deepEqual(s.active.map((t) => t.id), ["queued", "newer", "older"])
  assert.deepEqual(s.inactive.map((t) => t.id), ["arch"])
  assert.equal("legacy" in s, false)
})

// ---- isAwaitingExternal: the pr/ci/timer-at-rest signal that drives the dimmed Awaiting-external band ----

const awaitingPr = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr" as const, value: "owner/repo#12" }] }
const liveSub = [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const, id: "a1" }]

test("isAwaitingExternal: true for a pr/ci/timer awaiting fence AT REST with no live sub-agents", () => {
  const ci = { kind: "awaiting" as const, body: "", hints: [{ kind: "ci" as const, value: "build #4821" }] }
  const timer = { kind: "awaiting" as const, body: "", hints: [{ kind: "timer" as const, value: "5m" }] }
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: awaitingPr })), true)
  assert.equal(isAwaitingExternal(thread({ runtime: "exited", lastFence: awaitingPr })), true)
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: ci })), true)
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: timer })), true)
})

test("isAwaitingExternal: INTERNAL waits are NOT external — live sub-agents, session hint, bare rest, mid-turn", () => {
  // Awaiting its OWN sub-agents (a live child) is internal work → Active, never the dimmed band.
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: awaitingPr, subAgents: liveSub })), false)
  // A `session` hint (waiting on another fray session) reads as internal/ambiguous → Active.
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [{ kind: "session", value: "s1" }] } })), false)
  // A hintless awaiting fence → not scheduler-actionable → Active.
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), false)
  // Mid-turn (still working) never awaits externally, even with a stale pr fence.
  assert.equal(isAwaitingExternal(thread({ runtime: "running", lastFence: awaitingPr })), false)
  // A done fence or a bare rest is NOT awaiting-external (those read as done/idle).
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle", lastFence: { kind: "done", body: "x", hints: [] } })), false)
  assert.equal(isAwaitingExternal(thread({ runtime: "turn-idle" })), false)
})

test("sectionOf: a pr/ci/timer awaiting thread bands as awaitingExternal; live-sub / session / bare stay Active", () => {
  // External waiter → the dimmed band.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr })), "awaitingExternal")
  // Same fence but a LIVE sub-agent → still Active (internal work, maintainer's differentiator).
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr, subAgents: liveSub })), "active")
  // Session-hint / hintless / bare rest → Active.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [{ kind: "session", value: "s1" }] } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  // Archive wins over an external wait.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", lastFence: awaitingPr })), "inactive")
})

test("sectionThreads: external waiters split into the awaitingExternal band; live-subs stay Active", () => {
  const s = sectionThreads([
    thread({ id: "pr-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "pr-old", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr, lastUserAt: "2026-07-08T05:00:00.000Z" }),
    thread({ id: "sub-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr, subAgents: liveSub, lastUserAt: "2026-07-09T01:00:00.000Z" }),
  ])
  // Active holds the live-running row AND the sub-agent-waiting row (internal); recency orders them.
  assert.deepEqual(s.active.map((t) => t.id), ["sub-wait", "live-old"])
  // The two pr-awaiting rows land in the dimmed band, recency within it.
  assert.deepEqual(s.awaitingExternal.map((t) => t.id), ["pr-new", "pr-old"])
})

test("orderActive: a session/hintless declared-wait that stayed in Active sinks below in-play rows", () => {
  const sessWait = { kind: "awaiting" as const, body: "", hints: [{ kind: "session" as const, value: "s1" }] }
  const s = sectionThreads([
    thread({ id: "wait-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: sessWait, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
  ])
  // wait-new has the newer interaction but sinks below the in-play live row (it declared a machine wait).
  assert.deepEqual(s.active.map((t) => t.id), ["live-old", "wait-new"])
})

// ---- title placeholder: never show the machine-guessed dispatch title ----

test("titleIsProvisional / displayTitle: 'Spinning up' shows briefly, then falls back to the dispatch title", () => {
  const fresh = new Date().toISOString()
  // Fresh dispatch, guessed title, no aiTitle yet → the placeholder.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: fresh })), true)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: fresh })), SPINNING_UP_TITLE)
  // aiTitle landed → not provisional; the real name wins.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, aiTitle: "Parser fix", spawnedAt: fresh })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, aiTitle: "Parser fix", spawnedAt: fresh })), "Parser fix")
  // STALE spawn, still no aiTitle (e.g. a compacted session whose transcript fray lost track of) → NOT
  // provisional: fall back to the dispatch title, never stick on "Spinning up…" forever.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: "2026-07-08T00:00:00.000Z" })), "fix the parser bug")
  // A user-supplied title (titleAuto false) is real — shown as-is, never provisional.
  assert.equal(titleIsProvisional(thread({ titleAuto: false, title: "My thread", spawnedAt: fresh })), false)
  assert.equal(displayTitle(thread({ titleAuto: false, title: "My thread" })), "My thread")
  // Absent titleAuto (legacy/slim/foreign row) ⇒ never provisional.
  assert.equal(titleIsProvisional(thread({ title: "legacy" })), false)
})
