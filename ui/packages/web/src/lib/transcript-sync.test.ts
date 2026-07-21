import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeOptimistic, isTranscriptStale, newestRenderedAt, type QueuedMessage } from "./transcript-sync.ts"

const user = (text: string, opts: { queued?: boolean; at?: string; sourceId?: string } = {}): QueuedMessage => ({
  role: "user",
  text,
  tools: [],
  parts: [],
  ...(opts.queued ? { queued: true } : {}),
  ...(opts.at ? { at: opts.at } : {}),
  ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
})

// ---- mergeOptimistic (S1: preserve unconsumed optimistic sends across a cache overwrite) ----
test("mergeOptimistic: an optimistic bubble not yet in server truth is preserved (re-appended)", () => {
  const old = user("old", { sourceId: "old-turn" })
  const out = mergeOptimistic([old, user("pending send", { queued: true })], [old])
  assert.equal(out.length, 2)
  assert.equal(out[1].text, "pending send")
})

test("mergeOptimistic: an optimistic bubble now present in server truth is dropped (no duplicate)", () => {
  const old = user("old", { sourceId: "old-turn" })
  const out = mergeOptimistic(
    [old, user("landed", { queued: true })],
    [old, user("landed", { sourceId: "landed-turn" })],
  )
  assert.equal(out.length, 2)
  assert.equal(out.filter((m) => m.text === "landed").length, 1)
})

test("mergeOptimistic: the server's OWN queued copy also consumes the optimistic bubble", () => {
  const out = mergeOptimistic(
    [user("landed", { queued: true })],
    [user("landed", { queued: true, sourceId: "server-queued-turn" })],
  )
  assert.equal(out.length, 1)
})

test("mergeOptimistic: an unchanged server queued copy is not appended beside itself", () => {
  const serverQueued = user("landed", { queued: true, sourceId: "server-queued-turn" })
  const incoming = [serverQueued]
  assert.equal(mergeOptimistic([serverQueued], incoming), incoming)
})

test("mergeOptimistic: one landed turn consumes consecutive optimistic messages it coalesces", () => {
  const first = '"Add inter-thread spawning and internal linking"'
  const second = "The agent received both messages, but they still look enqueued."
  const landed = `${first}\n\n${second}`
  const out = mergeOptimistic(
    [user("old", { sourceId: "old-turn" }), user(first, { queued: true }), user(second, { queued: true })],
    [user("old", { sourceId: "old-turn" }), user(landed, { sourceId: "landed-turn" })],
  )
  assert.deepEqual(out.map((message) => message.text), ["old", landed])
})

test("mergeOptimistic: a historical coalesced turn is not fresh delivery evidence", () => {
  const first = "repeat first"
  const second = "repeat second"
  const landed = `${first}\n\n${second}`
  const old = user(landed, { sourceId: "old-turn" })
  const out = mergeOptimistic(
    [old, user(first, { queued: true }), user(second, { queued: true })],
    [old],
  )
  assert.deepEqual(out.map((message) => message.text), [landed, first, second])
})

test("mergeOptimistic: a repeated coalesced turn with a new source id consumes the new sends", () => {
  const first = "repeat first"
  const second = "repeat second"
  const landed = `${first}\n\n${second}`
  const old = user(landed, { sourceId: "old-turn" })
  const fresh = user(landed, { sourceId: "new-turn" })
  const out = mergeOptimistic(
    [old, user(first, { queued: true }), user(second, { queued: true })],
    [old, fresh],
  )
  assert.deepEqual(out, [old, fresh])
})

test("mergeOptimistic: one coalesced turn consumes only the first of two repeated queued runs", () => {
  const landed = user("a\n\nb", { sourceId: "landed-turn" })
  const out = mergeOptimistic(
    [user("a", { queued: true }), user("b", { queued: true }), user("a", { queued: true }), user("b", { queued: true })],
    [landed],
  )
  assert.deepEqual(out.map((message) => message.text), [landed.text, "a", "b"])
})

test("mergeOptimistic: two fresh coalesced turns consume two repeated queued runs", () => {
  const first = user("a\n\nb", { sourceId: "landed-turn-1" })
  const second = user("a\n\nb", { sourceId: "landed-turn-2" })
  const out = mergeOptimistic(
    [user("a", { queued: true }), user("b", { queued: true }), user("a", { queued: true }), user("b", { queued: true })],
    [first, second],
  )
  assert.deepEqual(out, [first, second])
})

test("mergeOptimistic: one overlapping coalesced turn cannot consume the same evidence twice", () => {
  const landed = user("a\n\na", { sourceId: "landed-turn" })
  const out = mergeOptimistic(
    [user("a", { queued: true }), user("a", { queued: true }), user("a", { queued: true })],
    [landed],
  )
  assert.deepEqual(out.map((message) => message.text), [landed.text, "a"])
})

test("mergeOptimistic: a single optimistic paragraph is not consumed by incidental landed prose", () => {
  const pending = user("shared paragraph", { queued: true })
  const landed = user("An unrelated introduction.\n\nshared paragraph", { sourceId: "landed-turn" })
  const out = mergeOptimistic([pending], [landed])
  assert.deepEqual(out.map((message) => message.text), [landed.text, pending.text])
})

test("mergeOptimistic: id-less input is not accepted as fresh delivery evidence", () => {
  const pending = user("landed", { queued: true })
  const out = mergeOptimistic([pending], [user("landed")])
  assert.deepEqual(out.map((message) => message.text), ["landed", "landed"])
  assert.equal(out[1].queued, true)
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
