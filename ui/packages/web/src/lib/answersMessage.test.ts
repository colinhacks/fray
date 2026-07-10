import { test } from "node:test"
import assert from "node:assert/strict"
import { parseAnswersMessage, pairAnswersMessage, pairAllAnswers, type MsgLike } from "./answersMessage.ts"

test("parses the multi-block composed-answer format into numbered rows", () => {
  const parsed = parseAnswersMessage("Answers:\n1. B. Hard-error with an install hint\n2. A. Preload it")
  assert.deepEqual(parsed, [
    { n: 1, answer: "B. Hard-error with an install hint" },
    { n: 2, answer: "A. Preload it" },
  ])
})

test("a multi-line answer folds its continuation lines in (newline preserved)", () => {
  const parsed = parseAnswersMessage("Answers:\n1. first line\ncontinued here\n2. second")
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].answer, "first line\ncontinued here")
  assert.equal(parsed?.[1].answer, "second")
})

test("CR-separated composed answer (terminal-injected) parses (the newline-collapse fix)", () => {
  // The real session 2cfe3c81 16:24:42 shape: a follow-up round-tripped through the tty is \r-separated.
  const parsed = parseAnswersMessage("Answers:\r1. B. Hard-error with an install hint\r2. A. Preload it")
  assert.deepEqual(parsed, [
    { n: 1, answer: "B. Hard-error with an install hint" },
    { n: 2, answer: "A. Preload it" },
  ])
})

test("tolerates leading blank lines before the header", () => {
  const parsed = parseAnswersMessage("\n\nAnswers:\n1. yes")
  assert.deepEqual(parsed, [{ n: 1, answer: "yes" }])
})

test("a plain (non-answers) user message returns null → falls back to the bubble", () => {
  assert.equal(parseAnswersMessage("Stop. Ask me the questions again."), null)
})

test("a single bare answer (no 'Answers:' header) returns null", () => {
  assert.equal(parseAnswersMessage("B. Hard-error with an install hint"), null)
})

test("header present but no numbered lines → null (degrade to bubble)", () => {
  assert.equal(parseAnswersMessage("Answers:\njust some prose"), null)
})

test("prose that merely contains the word Answers is not misdetected", () => {
  assert.equal(parseAnswersMessage("Answers: it depends\n1. maybe"), null) // first line isn't exactly "Answers:"
})

test("empty / whitespace input returns null", () => {
  assert.equal(parseAnswersMessage(""), null)
  assert.equal(parseAnswersMessage("   \n  "), null)
})

// ---- pairAnswersMessage (question↔answer correlation for the AnswersCard) ----
const user = (text: string): MsgLike => ({ role: "user", text })
const asst = (text: string): MsgLike => ({ role: "assistant", text })
const event = (text = "Agent finished"): MsgLike => ({ role: "assistant", kind: "event", text })
// An assistant message carrying one ```question block per body, in the fray worker convention
// (context prose, then trailing lettered options).
const qmsg = (...bodies: string[]): MsgLike => asst(bodies.map((b) => "```question\n" + b + "\n```").join("\n\n"))

test("pairs answer N with question-block N of the immediately-preceding assistant message", () => {
  const msgs = [qmsg("Q1 — install policy?\n- A. soft\n- B. hard", "Q2 — trigger?\n- A. schema\n- B. flag"), user("Answers:\n1. B. hard\n2. A. schema")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 2)
  assert.equal(paired?.[0].question, "Q1 — install policy?") // options stripped — context prose only
  assert.equal(paired?.[0].answer, "B. hard")
  assert.equal(paired?.[1].question, "Q2 — trigger?")
  assert.equal(paired?.[1].answer, "A. schema")
})

test("skips event punctuation and tool-only (text-less) turns during the lookback", () => {
  const msgs = [qmsg("Pick one?\n- A. x\n- B. y"), event(), asst(""), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 3)
  assert.equal(paired?.[0].question, "Pick one?")
})

test("scans past a prose-only assistant message to the nearest question-bearing one", () => {
  const msgs = [qmsg("Pick one?\n- A. x"), asst("One more note before you answer."), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 2)
  assert.equal(paired?.[0].question, "Pick one?")
})

test("an intervening user message stops the lookback → unpaired numbered fallback", () => {
  const msgs = [qmsg("Old ask?\n- A. x"), user("something unrelated"), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 2)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, undefined) // those questions were already claimed — never mislabel
})

test("an out-of-range answer number degrades to unpaired rows (never the wrong question)", () => {
  const msgs = [qmsg("Only one?\n- A. x"), user("Answers:\n1. A. x\n2. B. y")] // n=2 but only one block
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 2)
  assert.ok(paired?.every((p) => p.question === undefined))
})

test("a PARTIAL answer set pairs by the answer's own number (sendAnswers keeps original block numbers)", () => {
  // Three-block ask, only block 2 answered → "Answers:\n2. …" must pair with the SECOND question.
  const msgs = [qmsg("First?\n- A. x", "Second?\n- B. y", "Third?\n- C. z"), user("Answers:\n2. B. y")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].n, 2)
  assert.equal(paired?.[0].question, "Second?")
})

test("non-increasing answer numbers (hand-typed) degrade to unpaired rows", () => {
  const msgs = [qmsg("First?\n- A. x", "Second?\n- B. y"), user("Answers:\n2. B\n1. A")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.ok(paired?.every((p) => p.question === undefined))
})

test("no preceding question message at all → unpaired rows", () => {
  const paired = pairAnswersMessage([user("Answers:\n1. A. x")], 0)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, undefined)
})

test("a non-answers message returns null (the caller renders the plain bubble)", () => {
  assert.equal(pairAnswersMessage([qmsg("Q?"), user("plain follow-up")], 1), null)
  assert.equal(pairAnswersMessage([qmsg("Q?"), asst("Answers:\n1. A")], 1), null) // wrong role
})

test("a CR-separated answers message still pairs (normalization happens inside)", () => {
  const msgs = [qmsg("Pick?\n- A. x", "Also?\n- B. y"), user("Answers:\r1. A. x\r2. B. y")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.[0].question, "Pick?")
  assert.equal(paired?.[1].question, "Also?")
})

test("pairAllAnswers: null at ordinary indices, pairing at answers indices", () => {
  const msgs = [qmsg("Pick?\n- A. x"), asst("prose"), user("Answers:\n1. A. x")]
  const all = pairAllAnswers(msgs)
  assert.deepEqual([all[0], all[1]], [null, null])
  assert.equal(all[2]?.[0].question, "Pick?")
})
