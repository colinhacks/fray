import { test } from "node:test"
import assert from "node:assert/strict"
import { deriveNeedsYou } from "./board.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"

// The QUEUE DEFINITION is deriveNeedsYou — the single server-side source of truth for "this thread
// needs the human, put it on the stack." These tests pin every queue-worthy state, because a hole
// here means a thread that needs input silently never surfaces (2026-07-09: pendingQuestion was
// omitted, so a chat ```question the human had glanced at dropped off the stack — the exact failure
// the whole product exists to prevent).

const T0 = "2026-07-09T10:00:00.000Z"
const LATER = "2026-07-09T11:00:00.000Z"

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", tmux_name: "fray-t", spawned_at: T0, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, plan_path: null, ...over,
  }
}
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...over }
}

test("deriveNeedsYou: a perm-prompt process block always queues (a view can't clear it)", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ lastActivityAt: T0 }), "perm-prompt"), true)
})

test("deriveNeedsYou: a native pendingAsk always queues, even if seen", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingAsk: { id: "x", questions: [] }, lastActivityAt: T0 }), "turn-idle"), true)
})

test("deriveNeedsYou: an unanswered ```question at rest queues EVEN IF SEEN (viewing ≠ answering)", () => {
  // THE regression: seen_at newer than the last activity must NOT drop a pending question off the stack.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingQuestion: true, lastActivityAt: T0 }), "turn-idle"), true)
  // Also queues on an exited (crashed/ended) pane that left a question, seen or not.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingQuestion: true, lastActivityAt: T0 }), "exited"), true)
})

test("deriveNeedsYou: a ```question MID-TURN does not queue (ask text hasn't landed)", () => {
  assert.equal(deriveNeedsYou(row(), tele({ pendingQuestion: true, lastActivityAt: LATER }), "running"), false)
  assert.equal(deriveNeedsYou(row(), tele({ pendingQuestion: true }), "spawning"), false)
})

test("deriveNeedsYou: a done/awaiting fence at rest EXCUSES the thread (the agent excused itself)", () => {
  const done = tele({ lastFence: { kind: "done", body: "shipped", hints: [] }, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), done, "turn-idle"), false)
  const awaiting = tele({ lastFence: { kind: "awaiting", body: "", hints: [] }, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), awaiting, "turn-idle"), false)
  // ...but a pending QUESTION overrides an excusal fence (a specific ask beats an excusal).
  const both = tele({ pendingQuestion: true, lastFence: { kind: "awaiting", body: "", hints: [] } })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), both, "turn-idle"), true)
})

test("deriveNeedsYou: a BARE rest (end_turn, no ask, no fence) NEVER queues — the queue is explicit asks only", () => {
  // Unseen, fresh activity, at rest, NO question/ask/fence → NOT queued (was the noisy "your move" card).
  assert.equal(deriveNeedsYou(row({ seen_at: null, last_read_at: null }), tele({ lastActivityAt: LATER }), "turn-idle"), false)
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), tele({ lastActivityAt: LATER }), "turn-idle"), false)
  // An exited (finished, pane dead) thread that ended cleanly likewise doesn't queue.
  assert.equal(deriveNeedsYou(row({ seen_at: null }), tele({ turn: "idle", lastActivityAt: LATER }), "exited"), false)
  // A thread merely waiting on a running sub-agent doesn't queue either (no explicit ask).
  assert.equal(deriveNeedsYou(row({ seen_at: null }), tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER }), "turn-idle"), false)
})

test("deriveNeedsYou: mid-turn (running/spawning) never queues; no activity never queues", () => {
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: LATER }), "running"), false)
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: LATER }), "spawning"), false)
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: undefined }), "turn-idle"), false)
})

test("deriveNeedsYou: crash net — pane EXITED while the turn was in-flight queues, even after a glance", () => {
  // Agent died mid tool_use (turn still in-flight) then the pane exited; you'd already viewed it
  // (seen_at newer than its last activity). Interaction-clearance must NOT bury a dead-mid-work agent.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight", lastActivityAt: T0 }), "exited"), true)
  // A cleanly-ended (turn idle) exited thread is bare-rest — clears on view as normal.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "idle", lastActivityAt: T0 }), "exited"), false)
})
