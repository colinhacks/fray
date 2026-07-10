import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeOptimistic, isTranscriptStale, newestRenderedAt, type QueuedMessage } from "./transcript-sync.ts"

const user = (text: string, opts: { queued?: boolean; at?: string } = {}): QueuedMessage => ({
  role: "user",
  text,
  tools: [],
  parts: [],
  ...(opts.queued ? { queued: true } : {}),
  ...(opts.at ? { at: opts.at } : {}),
})

// ---- mergeOptimistic (S1: preserve unconsumed optimistic sends across a cache overwrite) ----
test("mergeOptimistic: an optimistic bubble not yet in server truth is preserved (re-appended)", () => {
  const out = mergeOptimistic([user("old"), user("pending send", { queued: true })], [user("old")])
  assert.equal(out.length, 2)
  assert.equal(out[1].text, "pending send")
})

test("mergeOptimistic: an optimistic bubble now present in server truth is dropped (no duplicate)", () => {
  const out = mergeOptimistic([user("old"), user("landed", { queued: true })], [user("old"), user("landed")])
  assert.equal(out.length, 2)
  assert.equal(out.filter((m) => m.text === "landed").length, 1)
})

test("mergeOptimistic: the server's OWN queued copy also consumes the optimistic bubble", () => {
  const out = mergeOptimistic([user("landed", { queued: true })], [user("landed", { queued: true })])
  assert.equal(out.length, 1)
})

test("mergeOptimistic: no optimistic entries → returns the incoming array unchanged (identity)", () => {
  const incoming = [user("a"), user("b")]
  assert.equal(mergeOptimistic([user("a")], incoming), incoming)
})

test("mergeOptimistic: empty/whitespace optimistic text is ignored", () => {
  const incoming = [user("real")]
  assert.equal(mergeOptimistic([user("  ", { queued: true })], incoming), incoming)
})

// ---- isTranscriptStale (level-triggered watchdog decision) ----
test("isTranscriptStale: activity leading the rendered tail by > threshold is stale", () => {
  assert.equal(isTranscriptStale("2026-07-01T00:00:10.000Z", "2026-07-01T00:00:00.000Z", 5000), true)
})
test("isTranscriptStale: within threshold is fresh", () => {
  assert.equal(isTranscriptStale("2026-07-01T00:00:03.000Z", "2026-07-01T00:00:00.000Z", 5000), false)
})
test("isTranscriptStale: no activity marker → never stale", () => {
  assert.equal(isTranscriptStale(undefined, "2026-07-01T00:00:00.000Z", 5000), false)
})
test("isTranscriptStale: activity present but nothing rendered yet → stale", () => {
  assert.equal(isTranscriptStale("2026-07-01T00:00:10.000Z", undefined, 5000), true)
})
test("isTranscriptStale: unparseable timestamps don't thrash", () => {
  assert.equal(isTranscriptStale("not-a-date", "2026-07-01T00:00:00.000Z", 5000), false)
  assert.equal(isTranscriptStale("2026-07-01T00:00:10.000Z", "not-a-date", 5000), false)
})

// ---- newestRenderedAt ----
test("newestRenderedAt: returns the last message carrying an `at`, scanning from the tail", () => {
  const msgs = [user("a", { at: "2026-07-01T00:00:00.000Z" }), user("b", { at: "2026-07-01T00:00:05.000Z" }), user("c")]
  assert.equal(newestRenderedAt(msgs), "2026-07-01T00:00:05.000Z") // trailing at-less message doesn't mask it
})
test("newestRenderedAt: undefined when nothing has a timestamp", () => {
  assert.equal(newestRenderedAt([user("a"), user("b")]), undefined)
  assert.equal(newestRenderedAt(undefined), undefined)
})
