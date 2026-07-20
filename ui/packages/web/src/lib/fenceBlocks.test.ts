import { test } from "node:test"
import assert from "node:assert/strict"
import { splitFenceBlocks, parseFenceBody, hasFence } from "./fenceBlocks.ts"

// ---- splitFenceBlocks ----

test("no fences → a single prose segment", () => {
  assert.deepEqual(splitFenceBlocks("just some prose\n\nmore prose"), [
    { kind: "prose", text: "just some prose\n\nmore prose" },
  ])
})

test("empty / whitespace-only text → no segments", () => {
  assert.deepEqual(splitFenceBlocks(""), [])
  assert.deepEqual(splitFenceBlocks("   \n  "), [])
})

test("a done fence with surrounding prose", () => {
  const text = "Shipped the fix.\n\n```done\nMerged PR and cleaned up the branch.\n```\n\nAnything else?"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "prose", text: "Shipped the fix.\n\n" },
    { kind: "fence", fenceKind: "done", body: "Merged PR and cleaned up the branch.", hints: [] },
    { kind: "prose", text: "\n\nAnything else?" },
  ])
})

test("an awaiting fence: current human/github-review/timer hint lines parse with the prose", () => {
  const text = "```awaiting\nWaiting on a named maintainer at a scheduled checkpoint.\nhuman: Alice must approve fork CI\ngithub-review: owner/repo#12\ntimer: 2026-07-15T17:00:00Z\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    {
      kind: "fence",
      fenceKind: "awaiting",
      body: "Waiting on a named maintainer at a scheduled checkpoint.",
      hints: [
        { kind: "human", value: "Alice must approve fork CI" },
        { kind: "github-review", value: "owner/repo#12" },
        { kind: "timer", value: "2026-07-15T17:00:00Z" },
      ],
    },
  ])
})

test("awaiting hint kinds are case-insensitive; current and legacy kinds remain readable", () => {
  const { hints, body } = parseFenceBody("Human: Alice approves\nTimer: 2026-07-15T17:00:00Z\nPR: p\nCI: c\nSession: sub-123\nprose tail", "awaiting")
  assert.deepEqual(hints, [
    { kind: "human", value: "Alice approves" },
    { kind: "timer", value: "2026-07-15T17:00:00Z" },
    { kind: "pr", value: "p" },
    { kind: "ci", value: "c" },
    { kind: "session", value: "sub-123" },
  ])
  assert.equal(body, "prose tail")
})

test("a done fence never carries hints — hint-looking lines stay in the body", () => {
  const { hints, body } = parseFenceBody("all set\npr: owner/repo#7", "done")
  assert.deepEqual(hints, [])
  assert.equal(body, "all set\npr: owner/repo#7")
})

test("an awaiting fence with no hints → empty hints, whole body prose", () => {
  const segs = splitFenceBlocks("```awaiting\nJust waiting a bit.\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "Just waiting a bit.", hints: [] }])
})

test("multiple fences in order", () => {
  const text = "```awaiting\nhold\ntimer: 10m\n```\nlater\n```done\nfinished\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "fence", fenceKind: "awaiting", body: "hold", hints: [{ kind: "timer", value: "10m" }] },
    { kind: "prose", text: "\nlater\n" },
    { kind: "fence", fenceKind: "done", body: "finished", hints: [] },
  ])
})

test("a ```question fence is NOT a signal fence — left in prose", () => {
  const text = "```question\nWhich default?\nA. one\nB. two\n```"
  assert.deepEqual(splitFenceBlocks(text), [{ kind: "prose", text }])
  assert.equal(hasFence(text), false)
})

test("a plain code fence is left in prose", () => {
  const text = "run this:\n\n```bash\nnpm test\n```"
  assert.deepEqual(splitFenceBlocks(text), [{ kind: "prose", text }])
})

test("unterminated fence degrades to plain prose (no fence segment)", () => {
  const text = "prose\n\n```done\nnever closed…\nstill going"
  const segs = splitFenceBlocks(text)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, "prose")
  assert.equal(segs[0].text, text)
})

test("CRLF line endings are handled", () => {
  const segs = splitFenceBlocks("```awaiting\r\nhold on\r\nci: build 9\r\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "hold on", hints: [{ kind: "ci", value: "build 9" }] }])
})

test("hasFence detects done and awaiting, ignores question/plain", () => {
  assert.equal(hasFence("```done\nx\n```"), true)
  assert.equal(hasFence("```awaiting\nx\n```"), true)
  assert.equal(hasFence("```question\nx\n```"), false)
  assert.equal(hasFence("no fences here"), false)
})

test("an empty done body is allowed (body may be '')", () => {
  const segs = splitFenceBlocks("```done\n\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "done", body: "", hints: [] }])
})
