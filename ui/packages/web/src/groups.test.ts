import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { needsAction, queued, orderQueue, partitionActive, sectionOf, sectionThreads, isHeld, sessionIndicatorKind, titleIsProvisional, displayTitle, lastActiveLabelAt, SPINNING_UP_TITLE, UNTITLED_THREAD_TITLE } from "./groups.ts"

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

test("queued: a server-marked checked/done thread cards and keeps its active checked presentation", () => {
  const done = thread({
    kind: "session",
    needsYou: true,
    state: "open",
    lastFence: { kind: "done", body: "shipped" },
  })
  assert.equal(queued(done), true)
  assert.equal(sectionOf(done), "active")
  assert.equal(sessionIndicatorKind(done), "done")
})

test("sessionIndicatorKind: bare queued rest stays rest while concrete input states use question styling", () => {
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, runtime: "turn-idle" })), "rest")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, pendingQuestion: true, runtime: "exited" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, pendingAsk: { questions: [] }, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, nativeInputRequired: { kind: "permission", title: "Permission required" }, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, actionableInteraction: true, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, status: "needs-human", humanBlocked: true, runtime: "exited" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, crashed: true, runtime: "exited" })), "stalled")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, crashed: false, runtime: "exited" })), "rest")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, crashed: undefined, runtime: "exited" })), "stalled")
  assert.equal(sessionIndicatorKind(thread({ runtime: "turn-idle", bgShells: liveShell, lastFence: awaitingTimer })), "working")
  assert.equal(sessionIndicatorKind(thread({ state: "archived", needsYou: true, runtime: "exited" })), "archived")
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

test("orderQueue: NO priority band — one strict time order across attention + passive alike", () => {
  // The hidden hard-attention band is gone (maintainer 2026-07-21: "too confusing"). Order is
  // last-active alone; kind (crash/question vs done/rest) never lifts a card into a separate tier.
  // The timestamps deliberately INTERLEAVE attention and passive rows so BOTH directions differ from
  // the old banded order — proving band removal, not just re-proving FIFO:
  //   crash-newest 07-14 (hard) · done-newer 07-13 (passive) · question-older 07-11 (hard) · rest-oldest 07-10 (passive)
  // Old banded FIFO would be [question-older, crash-newest, rest-oldest, done-newer]; old banded LIFO
  // [crash-newest, question-older, done-newer, rest-oldest]. Both differ from the strict orders below.
  const rows = () => [
    thread({ id: "crash-newest", lastUserAt: "2026-07-14T12:00:00.000Z", crashed: true }),
    thread({ id: "done-newer", lastUserAt: "2026-07-13T12:00:00.000Z", lastFence: { kind: "done", body: "shipped" } }),
    thread({ id: "question-older", lastUserAt: "2026-07-11T12:00:00.000Z", pendingQuestion: true }),
    thread({ id: "rest-oldest", lastUserAt: "2026-07-10T12:00:00.000Z" }),
  ]
  // FIFO oldest-first: the fresh CRASH sinks to the BOTTOM under an older done card — the accepted tradeoff.
  assert.deepEqual(orderQueue(rows()).map((item) => item.id), ["rest-oldest", "question-older", "done-newer", "crash-newest"])
  // LIFO newest-first: a newer DONE card outranks an older question — impossible under the old band.
  assert.deepEqual(orderQueue(rows(), "lifo").map((item) => item.id), ["crash-newest", "done-newer", "question-older", "rest-oldest"])
})

test("orderQueue: AT-REST rows key on REST TIME (lastAssistantAt), not lastActivityAt; direction flips it", () => {
  // The row that came to REST later (later lastAssistantAt = its final assistant output) is more
  // recently active. Ordering keys on this, NOT lastActivityAt — even though a much-later lastActivityAt
  // (a background sub-agent's completion notification) is present, it must NOT move the row. FIFO
  // (default) leads with the longest-since-rested (earlier-rested) row.
  const rows = () => [
    thread({ id: "rested-later", lastUserAt: "2026-07-14T12:00:00.000Z", lastAssistantAt: "2026-07-14T12:05:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" }),
    thread({ id: "rested-earlier", lastUserAt: "2026-07-14T12:00:00.000Z", lastAssistantAt: "2026-07-14T12:01:00.000Z", lastActivityAt: "2026-07-14T13:30:00.000Z" }),
  ]
  assert.deepEqual(orderQueue(rows()).map((item) => item.id), ["rested-earlier", "rested-later"])
  // LIFO surfaces the most recently rested first.
  assert.deepEqual(orderQueue(rows(), "lifo").map((item) => item.id), ["rested-later", "rested-earlier"])
})

test("orderQueue: a background sub-agent completing (lastActivityAt bump) does NOT reorder an at-rest row", () => {
  // The exact regression: a completed sub-agent posts a promptSource:system record that bumps the
  // parent's lastActivityAt but NOT its lastAssistantAt (rest time). Since ordering keys on rest time,
  // the parent's position is invariant to that child motion. Equal rest times ⇒ id tiebreak holds
  // no matter how recent the child-driven lastActivityAt is.
  const rows = (childActivity: string) => [
    thread({ id: "bravo", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: childActivity }),
    thread({ id: "alpha", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: childActivity }),
  ]
  assert.deepEqual(orderQueue(rows("2026-07-14T12:00:01.000Z")).map((item) => item.id), ["alpha", "bravo"])
  assert.deepEqual(orderQueue(rows("2026-07-14T18:00:00.000Z")).map((item) => item.id), ["alpha", "bravo"])
})

test("orderQueue: high-frequency agent activity on a RUNNING row cannot oscillate order (churn guard)", () => {
  // A running row keys off its STABLE user-interaction time, never the churning lastActivityAt — so
  // tool_result motion the user didn't cause can never reorder it. Equal lastUserAt/spawnedAt ⇒ the
  // id tiebreak holds regardless of how fast lastActivityAt advances.
  const rows = (activity: string) => [
    thread({ id: "bravo", runtime: "running", lastUserAt: "2026-07-14T12:00:00.000Z", lastActivityAt: activity }),
    thread({ id: "alpha", runtime: "running", lastUserAt: "2026-07-14T12:00:00.000Z", lastActivityAt: activity }),
  ]
  assert.deepEqual(orderQueue(rows("2026-07-14T12:00:01.000Z")).map((item) => item.id), ["alpha", "bravo"])
  assert.deepEqual(orderQueue(rows("2026-07-14T12:09:00.000Z")).map((item) => item.id), ["alpha", "bravo"])
})

test("lastActiveLabelAt: at-rest shows REST time, running shows live activity, sub-agent bump ignored at rest", () => {
  // At rest → the agent's own rest time (lastAssistantAt), NOT the later lastActivityAt a completed
  // sub-agent bumped. So the label reads "when the agent rested", never a spurious "just now".
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "turn-idle", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" })),
    "2026-07-14T12:00:00.000Z",
  )
  // Running → live activity (a running row IS active now), matching the spinner.
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "running", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" })),
    "2026-07-14T13:00:00.000Z",
  )
  // At rest with no recorded rest instant → falls back to lastActivityAt, then spawn.
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "turn-idle", lastAssistantAt: undefined, lastActivityAt: "2026-07-14T11:00:00.000Z" })),
    "2026-07-14T11:00:00.000Z",
  )
})

// ---- sidebar sections: session-first partition ----

test("sectionOf: running/needs-you stay Active; only truthful human/future-timer waits are Held", () => {
  // Legacy / absent-kind rows are HIDDEN entirely (null), any status.
  assert.equal(sectionOf(thread({ status: "active" })), null)
  assert.equal(sectionOf(thread({ kind: "legacy", status: "done" })), null)
  // Open in-play work remains Active: running, at-rest bare, needs-you, done-fenced.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "done", body: "shipped" } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "" } })), "active")
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
  // A live background Bash/Monitor has the same ownership semantics as a live child.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", bgShells: [{ label: "watch CI", startedAt: "2026-07-10T00:00:00.000Z", state: "running" }] })), "active")
})

test("sectionThreads v2: Active bands running-on-top then rested (queue order); foreign + legacy excluded", () => {
  const s = sectionThreads([
    thread({ id: "older", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "newer", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T01:00:00.000Z" }),
    thread({ id: "queued", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "arch", kind: "session", state: "archived" }),
    thread({ id: "old", status: "done" }),
    thread({ id: "term", kind: "session", foreign: true, runtime: "running" }),
  ])
  // Running band on top by interaction recency (newer before older); the queued rest sits BELOW it.
  assert.deepEqual(s.active.map((t) => t.id), ["newer", "older", "queued"])
  assert.deepEqual(s.inactive.map((t) => t.id), ["arch"])
  assert.equal("legacy" in s, false)
})

test("partitionActive: splits an ordered Active list into running/rested; queued stays rested; FIFO within rested", () => {
  // A queued thread that ALSO reads as actively running (spinning-yet-needs-you) still files under
  // rested so its queue card maps to a rested-band row.
  const active = [
    thread({ id: "run-b", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T00:00:00.000Z" }),
    thread({ id: "run-a", kind: "session", state: "open", runtime: "spawning", lastUserAt: "2026-07-08T00:00:00.000Z" }),
    thread({ id: "rest-old", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-05T00:00:00.000Z" }),
    thread({ id: "rest-new", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-11T00:00:00.000Z" }),
    thread({ id: "spin-ask", kind: "session", state: "open", runtime: "running", needsYou: true, lastUserAt: "2026-07-06T00:00:00.000Z" }),
  ]
  // orderQueue over the rested set is FIFO (oldest first): rest-old (07-05) < spin-ask (07-06) < rest-new (07-11).
  const ordered = [
    active[0], active[1], // running band (already recency-ordered for this fixture)
    active[2], active[4], active[3], // rested band in FIFO order
  ]
  const { running, rested } = partitionActive(ordered)
  assert.deepEqual(running.map((t) => t.id), ["run-b", "run-a"])
  assert.deepEqual(rested.map((t) => t.id), ["rest-old", "spin-ask", "rest-new"])
})

// ---- isHeld: every rendered wait glyph belongs to the labeled dimmed Held band ----

const awaitingGithubReview = { kind: "awaiting" as const, body: "", hint: { kind: "github-review" as const, value: "owner/repo#12" } }
const awaitingTimer = { kind: "awaiting" as const, body: "", hint: { kind: "timer" as const, value: "2099-07-15T17:00:00Z" } }
const awaitingElapsedTimer = { kind: "awaiting" as const, body: "", hint: { kind: "timer" as const, value: "2020-07-15T17:00:00Z" } }
const awaitingBadTimer = { kind: "awaiting" as const, body: "", hint: { kind: "timer" as const, value: "tomorrow-ish" } }
const liveSub = [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const, id: "a1" }]
const liveShell = [{ label: "Watch CI", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const }]

test("isHeld: only confirmed current review/future-timer waits are held", () => {
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingTimer })), false, "proposal stays in Queue")
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingGithubReview })), false, "proposal stays in Queue")
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingTimer, awaitingWaitConfirmed: true })), true)
  assert.equal(isHeld(thread({ runtime: "exited", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true })), true)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingBadTimer, awaitingWaitConfirmed: true })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingElapsedTimer, awaitingWaitConfirmed: true })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: { kind: "awaiting", body: "" }, awaitingWaitConfirmed: true })), false)
})

test("manual snooze: every parked queue reason is Held until the exact deadline", () => {
  const future = "2099-07-15T17:00:00.000Z"
  const elapsed = "2020-07-15T17:00:00.000Z"
  const snoozed = thread({ kind: "session", state: "open", runtime: "turn-idle", snoozedUntil: future, needsYou: false })
  assert.equal(isHeld(snoozed), true)
  assert.equal(sectionOf(snoozed), "held")
  assert.equal(sessionIndicatorKind(snoozed), "held")
  assert.equal(isHeld(thread({ ...snoozed, snoozedUntil: elapsed })), false)
  assert.equal(sectionOf(thread({ ...snoozed, snoozedUntil: elapsed, needsYou: true })), "active")
  assert.equal(queued(thread({ ...snoozed, snoozedUntil: elapsed, needsYou: true })), true)
  assert.equal(isHeld(thread({ ...snoozed, needsYou: true, pendingQuestion: true })), true)
  assert.equal(sectionOf(thread({ ...snoozed, needsYou: true, pendingQuestion: true })), "held")
  assert.equal(isHeld(thread({ ...snoozed, runtime: "perm-prompt", pendingAsk: { questions: [] } })), true)
  assert.equal(isHeld(thread({ ...snoozed, runtime: "exited", crashed: true })), true)
  assert.equal(isHeld(thread({ ...snoozed, runtime: "running" })), false, "snooze never relabels a turn still producing output")
})

test("isHeld: live work, mid-turn, settled, bare, archived, and non-timer blocked states are not held", () => {
  // Awaiting its own child or background Bash/Monitor is live work, even with a stale wait fence.
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true, subAgents: liveSub })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingTimer, awaitingWaitConfirmed: true, bgShells: liveShell })), false)
  assert.equal(isHeld(thread({ runtime: "running", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true })), false)
  // A done fence or a bare rest is NOT awaiting-external (those read as done/idle).
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: { kind: "done", body: "x" } })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle" })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", state: "archived", lastFence: awaitingTimer })), false)
  assert.equal(isHeld(thread({ status: "blocked", mechanism: "threads", runtime: "turn-idle" })), false)
  assert.equal(isHeld(thread({ needsYou: true, runtime: "exited", lastFence: awaitingTimer })), false, "attention beats a stale wait fence")
  assert.equal(isHeld(thread({ pendingAsk: { questions: [] }, runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true })), false)
})

test("sectionOf: confirmed review/timer waits are Held; proposals stay Active", () => {
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true })), "held")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, awaitingWaitConfirmed: true })), "held")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingGithubReview })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true, runtime: "exited", lastFence: awaitingTimer, awaitingWaitConfirmed: true })), "active")
  // A live child/background watcher wins over a stale parked fence.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true, subAgents: liveSub })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, awaitingWaitConfirmed: true, bgShells: liveShell })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "" } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingElapsedTimer })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  // Archive wins over an external wait.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true })), "inactive")
})

test("sectionThreads: only confirmed waits partition into Held; live work and proposals stay Active", () => {
  const s = sectionThreads([
    thread({ id: "review-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "timer-old", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, awaitingWaitConfirmed: true, lastUserAt: "2026-07-08T05:00:00.000Z" }),
    thread({ id: "sub-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingGithubReview, awaitingWaitConfirmed: true, subAgents: liveSub, lastUserAt: "2026-07-09T01:00:00.000Z" }),
    thread({ id: "shell-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, awaitingWaitConfirmed: true, bgShells: liveShell, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "proposal", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingGithubReview, lastUserAt: "2026-07-09T03:00:00.000Z" }),
  ])
  assert.deepEqual(s.active.map((t) => t.id), ["shell-wait", "sub-wait", "live-old", "proposal"])
  assert.deepEqual(s.held.map((t) => t.id), ["review-new", "timer-old"])
})

test("displayTitle: an explicit human title wins over stale backend AI-title and slug fallbacks", () => {
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "Human-readable thread title", titleAuto: false, aiTitle: "generated-slug" })),
    "Human-readable thread title",
  )
})

test("displayTitle: a machine-generated session slug is never presented as a successful title", () => {
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "generated-slug", titleAuto: true, spawnedAt: "2026-07-01T00:00:00.000Z" })),
    "Untitled thread",
  )
  assert.equal(
    displayTitle(thread({ id: "internal-id", title: "internal-id", titleAuto: true, aiTitle: "conversation-summary-task" })),
    "Conversation summary task",
    "a native backend slug is humanized (sentence case) even when it differs from the Fray thread id",
  )
})

test("a hintless awaiting handoff remains Active", () => {
  const hintlessWait = { kind: "awaiting" as const, body: "Waiting without a supported registration." }
  const s = sectionThreads([
    thread({ id: "wait-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: hintlessWait, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
  ])
  // live-old is running → running band on top; the hintless-wait rest (wait-new) files below it.
  assert.deepEqual(s.active.map((t) => t.id), ["live-old", "wait-new"])
  assert.deepEqual(s.held.map((t) => t.id), [])
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

test("Codex automatic titles follow runtime and never expose the raw initial-prompt fallback", () => {
  const rawPrompt = "Please inspect this entire raw initial prompt and fix everything"
  const fresh = new Date().toISOString()
  const stale = new Date(Date.now() - 20_000).toISOString()
  const spawning = thread({ backend: "codex", runtime: "spawning", titleAuto: true, title: rawPrompt, spawnedAt: fresh })
  assert.equal(titleIsProvisional(spawning), true)
  assert.equal(displayTitle(spawning), SPINNING_UP_TITLE)

  const runningBeforeSignal = thread({ backend: "codex", runtime: "running", titleAuto: true, title: rawPrompt, spawnedAt: fresh })
  assert.equal(titleIsProvisional(runningBeforeSignal), true)
  assert.equal(displayTitle(runningBeforeSignal), SPINNING_UP_TITLE, "task_started cannot flash Untitled before first commentary")

  for (const runtime of ["running", "turn-idle", "exited"] as const) {
    const omitted = thread({ backend: "codex", runtime, titleAuto: true, title: rawPrompt, spawnedAt: stale })
    assert.equal(titleIsProvisional(omitted), false)
    assert.equal(displayTitle(omitted), UNTITLED_THREAD_TITLE)
  }

  assert.equal(
    displayTitle(thread({ backend: "codex", runtime: "turn-idle", titleAuto: true, title: "slug", aiTitle: "Fix queue focus" })),
    "Fix queue focus",
  )
  assert.equal(
    displayTitle(thread({ backend: "codex", runtime: "turn-idle", titleAuto: false, title: "Human rename" })),
    "Human rename",
  )
})
