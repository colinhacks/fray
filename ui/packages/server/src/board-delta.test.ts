import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { BoardDiffer, applyBoardDelta, deltaAction, bootReloadDecision } from "@fray-ui/shared"

// ---- fixtures ----

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    title: id,
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "running",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    ...over,
  }
}

function board(threads: ThreadView[], over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return { projectDir: "/p", projectName: "p", projectLabel: "o/p", frayActive: true, threads, errors: [], warnings: [], ...over }
}

// Per-thread content equivalence, ORDER-INDEPENDENT (the client re-sorts every render, so array
// position is immaterial — the contract is "same thread content by id + same board meta").
function assertBoardEquiv(actual: BoardSnapshot, expected: BoardSnapshot) {
  const byId = (b: BoardSnapshot) => new Map(b.threads.map((t) => [t.id, JSON.stringify(t)]))
  assert.deepEqual(byId(actual), byId(expected), "per-thread content diverged")
  assert.equal(actual.projectDir, expected.projectDir)
  assert.equal(actual.projectName, expected.projectName)
  assert.equal(actual.projectLabel, expected.projectLabel)
  assert.equal(actual.frayActive, expected.frayActive)
  assert.deepEqual(actual.errors, expected.errors)
  assert.deepEqual(actual.warnings, expected.warnings)
}

// ---- BoardDiffer.diff ----

test("differ: first snapshot upserts every thread and starts seq at 1", () => {
  const d = new BoardDiffer()
  assert.equal(d.currentSeq(), 0)
  const out = d.diff(board([thread("a"), thread("b")]))
  assert.ok(out)
  assert.equal(out!.seq, 1)
  assert.equal(d.currentSeq(), 1)
  assert.deepEqual(out!.upserts.map((t) => t.id).sort(), ["a", "b"])
  assert.deepEqual(out!.removed, [])
  assert.ok(out!.meta, "first diff carries meta")
})

test("differ: an unchanged snapshot dedupes to null (no publish, no seq bump)", () => {
  const d = new BoardDiffer()
  const snap = board([thread("a"), thread("b")])
  d.diff(snap)
  assert.equal(d.diff(board([thread("a"), thread("b")])), null)
  assert.equal(d.currentSeq(), 1, "seq did not advance on a no-op")
})

test("differ: a single-thread field change emits ONLY that thread", () => {
  const d = new BoardDiffer()
  d.diff(board([thread("a"), thread("b"), thread("c")]))
  const out = d.diff(board([thread("a"), thread("b", { status: "blocked", humanBlocked: true }), thread("c")]))
  assert.ok(out)
  assert.equal(out!.seq, 2)
  assert.deepEqual(out!.upserts.map((t) => t.id), ["b"])
  assert.deepEqual(out!.removed, [])
  assert.equal(out!.meta, undefined, "board meta unchanged → no meta on the delta")
})

test("differ: reorder-only (same content, different array order) is a no-op", () => {
  const d = new BoardDiffer()
  d.diff(board([thread("a"), thread("b")]))
  assert.equal(d.diff(board([thread("b"), thread("a")])), null, "content-keyed diff ignores order")
})

test("differ: removed and added threads surface in removed/upserts", () => {
  const d = new BoardDiffer()
  d.diff(board([thread("a"), thread("b")]))
  const out = d.diff(board([thread("a"), thread("c")])) // b gone, c new
  assert.ok(out)
  assert.deepEqual(out!.upserts.map((t) => t.id), ["c"])
  assert.deepEqual(out!.removed, ["b"])
})

test("differ: a board-level (meta) change alone still emits a delta carrying meta", () => {
  const d = new BoardDiffer()
  d.diff(board([thread("a")]))
  const out = d.diff(board([thread("a")], { errors: ["boom"] }))
  assert.ok(out)
  assert.deepEqual(out!.upserts, [])
  assert.deepEqual(out!.removed, [])
  assert.deepEqual(out!.meta?.errors, ["boom"])
})

// ---- applyBoardDelta round-trip: a client that applies deltas in order matches the server exactly ----

test("round-trip: applying deltas reproduces server state across a sequence of changes", () => {
  const d = new BoardDiffer()
  let server = board([thread("a"), thread("b"), thread("c")])
  d.diff(server) // baseline (seq 1) — the state captured by the client's connect keyframe
  const client = structuredClone(server) // the keyframe

  const changes: BoardSnapshot[] = [
    // one field change
    board([thread("a", { statusText: "working" }), thread("b"), thread("c")]),
    // add a thread
    board([thread("a", { statusText: "working" }), thread("b"), thread("c"), thread("d")]),
    // remove a thread
    board([thread("a", { statusText: "working" }), thread("c"), thread("d")]),
    // CONCURRENT: change two threads, add one, remove one, all in one tick
    board([
      thread("a", { statusText: "working", runtime: "turn-idle" }),
      thread("c", { status: "done", runtime: "exited" }),
      thread("e"),
    ]),
    // board-level change (warnings) with no thread change
    board([
      thread("a", { statusText: "working", runtime: "turn-idle" }),
      thread("c", { status: "done", runtime: "exited" }),
      thread("e"),
    ], { warnings: ["heads up"] }),
  ]

  for (const next of changes) {
    const out = d.diff(next)
    if (out) applyBoardDelta(client, out)
    assertBoardEquiv(client, next)
    server = next
  }
})

test("applyBoardDelta: re-applying the same delta is idempotent (buffered-duplicate safety)", () => {
  const d = new BoardDiffer()
  d.diff(board([thread("a"), thread("b")]))
  const client = board([thread("a"), thread("b")])
  const out = d.diff(board([thread("a", { status: "blocked" }), thread("c")])) // b removed, c added, a changed
  assert.ok(out)
  applyBoardDelta(client, out!)
  const once = structuredClone(client)
  applyBoardDelta(client, out!) // apply again — must not corrupt
  assertBoardEquiv(client, once)
})

// ---- deltaAction (client seq-gap decision) ----

test("deltaAction: ignore ≤ current, apply exactly next, resync on gap or no-keyframe", () => {
  assert.equal(deltaAction(-1, 1), "resync") // no keyframe adopted yet
  assert.equal(deltaAction(5, 5), "ignore") // buffered duplicate the keyframe already covers
  assert.equal(deltaAction(5, 4), "ignore") // stale duplicate
  assert.equal(deltaAction(5, 6), "apply") // the exact next delta
  assert.equal(deltaAction(5, 7), "resync") // one dropped
  assert.equal(deltaAction(5, 99), "resync") // many dropped
})

// ---- bootReloadDecision (client restart detection) ----

test("bootReloadDecision: record first, adopt a new server without navigation, noop on match/absent id", () => {
  assert.equal(bootReloadDecision(null, "boot-1"), "record") // first sight
  assert.equal(bootReloadDecision("boot-1", "boot-1"), "noop") // unchanged
  assert.equal(bootReloadDecision("boot-1", "boot-2"), "adopt") // server restarted; preserve client drafts
  assert.equal(bootReloadDecision("boot-1", undefined), "noop") // pre-restart server / unknown
  assert.equal(bootReloadDecision("boot-1", null), "noop")
  assert.equal(bootReloadDecision(null, undefined), "noop") // nothing to record
  // The caller records the adopted id, so its next frame is stable.
  assert.equal(bootReloadDecision("boot-2", "boot-2"), "noop")
})
