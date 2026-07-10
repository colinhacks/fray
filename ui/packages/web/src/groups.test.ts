import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { needsAction, queued, sectionOf, sectionThreads, isMachineWaiting, titleIsProvisional, displayTitle, SPINNING_UP_TITLE } from "./groups.ts"

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

// ---- isMachineWaiting: the ```awaiting-at-rest signal that drives clock + dim + bottom-of-active ----

test("isMachineWaiting: true only for an awaiting fence AT REST", () => {
  const awaiting = { kind: "awaiting" as const, body: "", hints: [] }
  assert.equal(isMachineWaiting(thread({ runtime: "turn-idle", lastFence: awaiting })), true)
  assert.equal(isMachineWaiting(thread({ runtime: "exited", lastFence: awaiting })), true)
  // Mid-turn (still working) never machine-waits, even with a stale awaiting fence.
  assert.equal(isMachineWaiting(thread({ runtime: "running", lastFence: awaiting })), false)
  // A done fence or a bare rest is NOT machine-waiting (those read as done/idle → a ✓, not the clock).
  assert.equal(isMachineWaiting(thread({ runtime: "turn-idle", lastFence: { kind: "done", body: "x", hints: [] } })), false)
  assert.equal(isMachineWaiting(thread({ runtime: "turn-idle" })), false)
})

test("sectionThreads: machine-waiting rows sink to the BOTTOM of Active, recency within each group", () => {
  const awaiting = { kind: "awaiting" as const, body: "", hints: [] }
  const s = sectionThreads([
    thread({ id: "wait-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaiting, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "wait-old", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaiting, lastUserAt: "2026-07-08T05:00:00.000Z" }),
    thread({ id: "live-new", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T01:00:00.000Z" }),
  ])
  // In-play rows (recency) first, then the two awaiting rows (recency) at the bottom — even though
  // wait-new has the newest interaction of all, it stays below every non-waiting row.
  assert.deepEqual(s.active.map((t) => t.id), ["live-new", "live-old", "wait-new", "wait-old"])
})

// ---- title placeholder: never show the machine-guessed dispatch title ----

test("titleIsProvisional / displayTitle: guessed title shows the 'Spinning up' placeholder until aiTitle lands", () => {
  // titleAuto with no aiTitle = provisional → placeholder, not the guess.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug" })), true)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug" })), SPINNING_UP_TITLE)
  // Once Claude's ai-title lands, it wins and the row is no longer provisional.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, aiTitle: "Parser fix" })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, aiTitle: "Parser fix" })), "Parser fix")
  // A user-supplied title (titleAuto false) is real — shown as-is, never provisional.
  assert.equal(titleIsProvisional(thread({ titleAuto: false, title: "My thread" })), false)
  assert.equal(displayTitle(thread({ titleAuto: false, title: "My thread" })), "My thread")
  // Absent titleAuto (legacy/slim/foreign row) ⇒ never provisional.
  assert.equal(titleIsProvisional(thread({ title: "legacy" })), false)
})
