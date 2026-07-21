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
    { kind: "fence", fenceKind: "done", body: "Merged PR and cleaned up the branch." },
    { kind: "prose", text: "\n\nAnything else?" },
  ])
})

test("an awaiting fence parses one review hint with its prose", () => {
  const text = "```awaiting\ngithub-review: owner/repo#12\nAlice must review the PR.\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    {
      kind: "fence",
      fenceKind: "awaiting",
      body: "Alice must review the PR.",
      hint: { kind: "github-review", value: "owner/repo#12" },
    },
  ])
})

test("awaiting hint kind is case-insensitive", () => {
  const { hint, body } = parseFenceBody("Timer: 2026-07-15T17:00:00Z\nprose tail", "awaiting")
  assert.deepEqual(hint, { kind: "timer", value: "2026-07-15T17:00:00Z" })
  assert.equal(body, "prose tail")
})

test("a done fence never carries a hint — hint-looking lines stay in the body", () => {
  const { hint, body } = parseFenceBody("all set\ntimer: 2026-07-15T17:00:00Z", "done")
  assert.equal(hint, undefined)
  assert.equal(body, "all set\ntimer: 2026-07-15T17:00:00Z")
})

test("multiple supported hints are visible prose and non-signaling", () => {
  const raw = "github-review: owner/repo#7\ntimer: 2026-07-15T17:00:00Z\nChoose one."
  const parsed = parseFenceBody(raw, "awaiting")
  assert.equal(parsed.hint, undefined)
  assert.equal(parsed.body, raw)
})

test("a malformed supported hint is visible prose and non-signaling", () => {
  const raw = "timer: 10m\nUse a real ISO instant."
  const parsed = parseFenceBody(raw, "awaiting")
  assert.equal(parsed.hint, undefined)
  assert.equal(parsed.body, raw)

  const impossible = "timer: 2099-02-31T08:45:00Z\nThis date does not exist."
  const invalidCalendar = parseFenceBody(impossible, "awaiting")
  assert.equal(invalidCalendar.hint, undefined)
  assert.equal(invalidCalendar.body, impossible)
})

test("removed hint names remain visible prose", () => {
  const raw = "human: Alice\npr: owner/repo#7\nci: build\nsession: sub-123"
  const { hint, body } = parseFenceBody(raw, "awaiting")
  assert.equal(hint, undefined)
  assert.equal(body, raw)
})

test("an awaiting fence with no hint keeps its whole body as prose", () => {
  const segs = splitFenceBlocks("```awaiting\nJust waiting a bit.\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "Just waiting a bit." }])
})

test("multiple fences in order", () => {
  const text = "```awaiting\nhold\ntimer: 10m\n```\nlater\n```done\nfinished\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "fence", fenceKind: "awaiting", body: "hold\ntimer: 10m" },
    { kind: "prose", text: "\nlater\n" },
    { kind: "fence", fenceKind: "done", body: "finished" },
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
  const segs = splitFenceBlocks("```awaiting\r\nhold on\r\ngithub-review: owner/repo#9\r\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "hold on", hint: { kind: "github-review", value: "owner/repo#9" } }])
})

test("hasFence detects done and awaiting, ignores question/plain", () => {
  assert.equal(hasFence("```done\nx\n```"), true)
  assert.equal(hasFence("```awaiting\nx\n```"), true)
  assert.equal(hasFence("```question\nx\n```"), false)
  assert.equal(hasFence("no fences here"), false)
})

test("an empty done body is allowed (body may be '')", () => {
  const segs = splitFenceBlocks("```done\n\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "done", body: "" }])
})
