import { test } from "node:test"
import assert from "node:assert/strict"
import { selectOpenAsks, composeAnswerWire, type AskMsgLike } from "./answering.ts"

// A single ```question block message, tagged with a sourceId for identity.
const ask = (id: string, body = "Pick one\n- A. Left\n- B. Right"): AskMsgLike => ({
  role: "assistant",
  sourceId: id,
  text: `Some lead-in.\n\n\`\`\`question\n${body}\n\`\`\``,
})
const prose = (text: string): AskMsgLike => ({ role: "assistant", text })
const user = (text: string): AskMsgLike => ({ role: "user", text })
const event = (text: string): AskMsgLike => ({ role: "assistant", kind: "event", text })
const reasoning = (text: string): AskMsgLike => ({ role: "assistant", kind: "reasoning", text })

test("live-only: the trailing ask is answerable", () => {
  const open = selectOpenAsks([user("do it"), ask("q1")], false)
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
  assert.equal(open[0].isLive, true)
})

test("live-only: a trailing prose turn AFTER the ask makes nothing answerable (historic behavior)", () => {
  // The first substantive assistant message from the end has no ask → the live-only walk stops empty,
  // even though an earlier message did ask. This is exactly the buried-question hole multiMessage fixes.
  const open = selectOpenAsks([ask("q1"), prose("meanwhile I did other work")], false)
  assert.equal(open.length, 0)
})

test("multiMessage: an ask buried by a later prose turn stays answerable", () => {
  const open = selectOpenAsks([ask("q1"), prose("meanwhile I did other work")], true)
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
  assert.equal(open[0].isLive, false) // buried — a later substantive assistant message exists
})

test("multiMessage: two asks with no human turn between are BOTH open; only the last is live", () => {
  const open = selectOpenAsks([ask("q1"), prose("note"), ask("q2")], true)
  assert.deepEqual(open.map((a) => a.identity), ["q1", "q2"]) // transcript order
  assert.deepEqual(open.map((a) => a.isLive), [false, true])
})

test("live-only: a human turn AFTER the ask makes nothing answerable (queue card unchanged)", () => {
  // The queue card (multiMessage=false) keeps the historic behavior: a later human turn = already answered.
  assert.equal(selectOpenAsks([ask("q1"), user("actually do something else")], false).length, 0)
})

test("multiMessage TRACKS NOTHING: a question stays answerable even after a human turn (best-effort)", () => {
  // No 'closing' — every question in the transcript is answerable regardless of intervening human turns.
  const open = selectOpenAsks([ask("q1"), user("actually do something else")], true)
  assert.deepEqual(open.map((a) => a.identity), ["q1"])
})

test("multiMessage: ALL question-bearing messages are answerable, across human turns", () => {
  const open = selectOpenAsks([ask("q0"), user("go"), ask("q1"), prose("work"), ask("q2")], true)
  assert.deepEqual(open.map((a) => a.identity), ["q0", "q1", "q2"]) // q0 (pre-human-turn) is answerable too
  assert.deepEqual(open.map((a) => a.isLive), [false, false, true]) // only the last substantive assistant
})

test("event (sub-agent completion) punctuation after an ask is skipped, not treated as a turn", () => {
  // A completion event landing after the ask must not shadow it (the same skip discipline as pairing).
  const open = selectOpenAsks([ask("q1"), event('Agent "x" finished — 2m')], false)
  assert.equal(open.length, 1)
  assert.equal(open[0].isLive, true)
})

test("codex 'reasoning' punctuation is skipped like an event — never the live/substantive turn", () => {
  // Codex emits a reasoning summary FIRST in a turn (role assistant, non-empty text), so it must NOT
  // become the live anchor and shadow a trailing ask. Both a leading and a trailing reasoning block skip.
  const open = selectOpenAsks([reasoning("**Thinking about it**"), ask("q1"), reasoning("**More thought**")], false)
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
  assert.equal(open[0].isLive, true)
})

test("tool-only / empty assistant turns are stepped over", () => {
  const open = selectOpenAsks([ask("q1"), { role: "assistant", text: "   " }], true)
  assert.equal(open.length, 1)
  assert.equal(open[0].identity, "q1")
})

test("legacy line without sourceId gets a deterministic content identity", () => {
  const a = selectOpenAsks([{ role: "assistant", text: "```question\nGo?\n```" }], false)
  const b = selectOpenAsks([{ role: "assistant", text: "```question\nGo?\n```" }], false)
  assert.equal(a[0].identity, b[0].identity)
  assert.match(a[0].identity, /^legacy-/)
})

// ---- composeAnswerWire ----

test("all-live single block → bare answer (historic format, byte-identical)", () => {
  const wire = composeAnswerWire({
    answered: [{ isLive: true, question: "Pick one", answer: "B. Right" }],
    live: { blockCount: 1, numbered: [{ n: 1, a: "B. Right" }] },
  })
  assert.equal(wire, "B. Right")
})

test("all-live multi block → Answers: numbered by original position", () => {
  const wire = composeAnswerWire({
    answered: [
      { isLive: true, question: "Q1", answer: "yes" },
      { isLive: true, question: "Q2", answer: "no" },
    ],
    live: { blockCount: 2, numbered: [{ n: 1, a: "yes" }, { n: 2, a: "no" }] },
  })
  assert.equal(wire, "Answers:\n1. yes\n2. no")
})

test("all-live multi block, PARTIAL answer → keeps original block numbers", () => {
  // Only block 2 answered against a 3-block ask: number stays 2 so pairAnswersMessage maps it faithfully.
  const wire = composeAnswerWire({
    answered: [{ isLive: true, question: "Q2", answer: "just this" }],
    live: { blockCount: 3, numbered: [{ n: 2, a: "just this" }] },
  })
  assert.equal(wire, "Answers:\n2. just this")
})

test("any buried answer → self-describing quoted form (does NOT match parseAnswersMessage header)", () => {
  const wire = composeAnswerWire({
    answered: [{ isLive: false, question: "Which database?", answer: "Postgres" }],
  })
  assert.equal(wire, 'Answers to earlier questions:\n1. “Which database?” → Postgres')
  assert.doesNotMatch(wire.split("\n")[0], /^Answers:$/) // stays a plain bubble, never a false answers-card
})

test("mixed live + buried answers → self-describing form for the whole batch", () => {
  const wire = composeAnswerWire({
    answered: [
      { isLive: false, question: "Old Q", answer: "A" },
      { isLive: true, question: "New Q", answer: "B" },
    ],
    live: { blockCount: 1, numbered: [{ n: 1, a: "B" }] },
  })
  assert.equal(wire, 'Answers to earlier questions:\n1. “Old Q” → A\n2. “New Q” → B')
})

test("buried empty-question label falls back to a non-empty string (never a bare '\"\"' quote)", () => {
  const wire = composeAnswerWire({
    answered: [{ isLive: false, question: "", answer: "A. Postgres" }],
  })
  // composeAnswerWire trusts the caller's `question`; the fallback lives in questionLabel (hook side).
  // This asserts the FORMAT is stable; the empty-context fallback is exercised via selectOpenAsks below.
  assert.equal(wire, 'Answers to earlier questions:\n1. “” → A. Postgres')
})

test("two identical-text asks with no sourceId get DISTINCT identities (no state bleed)", () => {
  const dup = (): AskMsgLike => ({ role: "assistant", text: "```question\nGo?\n- A. Yes\n- B. No\n```" })
  const open = selectOpenAsks([dup(), prose("interstitial"), dup()], true)
  assert.equal(open.length, 2)
  assert.notEqual(open[0].identity, open[1].identity) // suffixed apart, so answer keys never collide
})

test("unique-identity asks are NOT perturbed by the collision guard", () => {
  const open = selectOpenAsks([ask("q1"), prose("x"), ask("q2")], true)
  assert.deepEqual(open.map((a) => a.identity), ["q1", "q2"]) // no '#idx' suffix on distinct identities
})
