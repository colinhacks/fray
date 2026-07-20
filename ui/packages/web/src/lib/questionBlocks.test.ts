import { test } from "node:test"
import assert from "node:assert/strict"
import { splitQuestionBlocks, parseQuestionBlock, composeBlockAnswer, optionId, recommendedIndex } from "./questionBlocks.ts"

// ---- splitQuestionBlocks ----

test("no fences → a single prose segment", () => {
  assert.deepEqual(splitQuestionBlocks("just some prose\n\nmore prose"), [
    { kind: "prose", text: "just some prose\n\nmore prose" },
  ])
})

test("empty / whitespace-only text → no segments", () => {
  assert.deepEqual(splitQuestionBlocks(""), [])
  assert.deepEqual(splitQuestionBlocks("   \n  "), [])
})

test("a single question block with surrounding prose (default kind)", () => {
  const text = "Here is my status.\n\n```question\nWhich default?\n\nA. Plain\nB. JSON\n```\n\nThanks!"
  assert.deepEqual(splitQuestionBlocks(text), [
    { kind: "prose", text: "Here is my status.\n\n" },
    { kind: "question", text: "Which default?\n\nA. Plain\nB. JSON", questionKind: "question", danger: false },
    { kind: "prose", text: "\n\nThanks!" },
  ])
})

test("info-string kinds: ```question approval → approval, bare/other → question", () => {
  const approval = splitQuestionBlocks("```question approval\nShip it?\n```")
  assert.deepEqual(approval, [{ kind: "question", text: "Ship it?", questionKind: "approval", danger: false }])
  const bare = splitQuestionBlocks("```question\nShip it?\n```")
  assert.equal(bare[0].kind === "question" && bare[0].questionKind, "question")
  const explicit = splitQuestionBlocks("```question question\nShip it?\n```")
  assert.equal(explicit[0].kind === "question" && explicit[0].questionKind, "question")
})

test("multiple question blocks in order", () => {
  const text = "```question\nQ1?\nA. a\nB. b\n```\nbetween\n```question approval\nQ2?\n```"
  assert.deepEqual(splitQuestionBlocks(text), [
    { kind: "question", text: "Q1?\nA. a\nB. b", questionKind: "question", danger: false },
    { kind: "prose", text: "\nbetween\n" },
    { kind: "question", text: "Q2?", questionKind: "approval", danger: false },
  ])
})

// ---- new info-string kinds: multi, approval danger, multi-token degradation ----

test("```question multi → kind multi, no danger", () => {
  const segs = splitQuestionBlocks("```question multi\nWhich to fix?\n- A. one\n- B. two\n```")
  assert.deepEqual(segs, [{ kind: "question", text: "Which to fix?\n- A. one\n- B. two", questionKind: "multi", danger: false }])
})

test("```question approval danger → approval + danger (order-independent)", () => {
  const a = splitQuestionBlocks("```question approval danger\nForce-merge?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Force-merge?", questionKind: "approval", danger: true }])
  // The two tokens are recognized in any order.
  const b = splitQuestionBlocks("```question danger approval\nForce-merge?\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "approval")
  assert.equal(b[0].kind === "question" && b[0].danger, true)
})

test("single-token back-compat: plain `approval` carries no danger, extra spaces tolerated", () => {
  const a = splitQuestionBlocks("```question approval\nShip it?\n```")
  assert.equal(a[0].kind === "question" && a[0].danger, false)
  // Trailing / internal whitespace in the info-string is stripped, not parsed as tokens.
  const b = splitQuestionBlocks("```question   approval   \nShip it?\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "approval")
  assert.equal(b[0].kind === "question" && b[0].danger, false)
})

test("unknown / extra tokens degrade to kind question without breaking parsing", () => {
  // No recognized base token → question; the block still parses (never a hard fail).
  const a = splitQuestionBlocks("```question wat\nStill a question?\n```")
  assert.deepEqual(a, [{ kind: "question", text: "Still a question?", questionKind: "question", danger: false }])
  // A recognized kind survives an unknown neighbor token; danger still detected alongside noise.
  const b = splitQuestionBlocks("```question multi frobnicate danger\nPick some\n- A. x\n```")
  assert.equal(b[0].kind === "question" && b[0].questionKind, "multi")
  assert.equal(b[0].kind === "question" && b[0].danger, true)
})

test("unterminated fence degrades to plain prose (no question segment)", () => {
  const text = "prose\n\n```question\nnever closed...\nstill going"
  const segs = splitQuestionBlocks(text)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, "prose")
  assert.equal(segs[0].text, text)
})

test("a normal (non-question) code fence is left in prose", () => {
  const text = "run this:\n\n```bash\nnpm test\n```"
  assert.deepEqual(splitQuestionBlocks(text), [{ kind: "prose", text }])
})

// ---- parseQuestionBlock: choice detection ----

test("lettered options (markdown list form) → chips, stripped from context", () => {
  const body = "Which store?\n\n- A. SQLite — transactional\n- B. JSON — zero deps\n\nRecommendation: A, for consistency."
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Which store?")
  assert.deepEqual(p.options, ["A. SQLite — transactional", "B. JSON — zero deps"])
  assert.equal(p.recommendation, "Recommendation: A, for consistency.")
})

test("options FOLLOWED by a trailing Note paragraph → chips STILL detected, note → trailingMd (the nub#440 bug)", () => {
  // The worker put a footnote after the choices; the old "options must be trailing" rule then found no
  // run and dropped every chip. Inline markdown (backticks, **bold**, em-dash) must not confuse it either.
  const body =
    "How do you want to proceed?\n\n" +
    "- A. Merge as-is (`--admin`) — my recommendation\n" +
    "- B. Switch to **pnpm-owned** first\n" +
    "- C. Hold — review it yourself\n\n" +
    "Note: the invalid-URL warn-drop is in the PR body as recommend-only."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, ["A. Merge as-is (`--admin`) — my recommendation", "B. Switch to **pnpm-owned** first", "C. Hold — review it yourself"])
  assert.equal(p.contextMd, "How do you want to proceed?")
  assert.equal(p.trailingMd, "Note: the invalid-URL warn-drop is in the PR body as recommend-only.")
})

test("lettered options (bare form, no list marker)", () => {
  const body = "Pick one:\nA. Tabs\nB. Spaces"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "Pick one:")
  assert.deepEqual(p.options, ["A. Tabs", "B. Spaces"])
  assert.equal(p.recommendation, undefined)
})

test("numbered options → chips", () => {
  const body = "How many retries?\n\n1. Zero\n2. Three\n3. Ten"
  const p = parseQuestionBlock(body, "question")
  assert.equal(p.contextMd, "How many retries?")
  assert.deepEqual(p.options, ["1. Zero", "2. Three", "3. Ten"])
})

test("no trailing option run → freetext-only (empty options), whole body is context", () => {
  const body = "What should I name the flag? Give me a short kebab-case string."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, body)
})

test("a lone Recommendation line without options stays in context (not special)", () => {
  const body = "Some prose.\n\nRecommendation: do the thing."
  const p = parseQuestionBlock(body, "question")
  assert.deepEqual(p.options, [])
  assert.equal(p.contextMd, body)
})

test("approval kind carries through parse", () => {
  const p = parseQuestionBlock("Ready to ship?\nA. Ship it\nB. Hold", "approval")
  assert.equal(p.kind, "approval")
  assert.deepEqual(p.options, ["A. Ship it", "B. Hold"])
})

test("CRLF line endings are handled in both split and parse", () => {
  const segs = splitQuestionBlocks("```question\r\nWhich?\r\nA. one\r\nB. two\r\n```")
  assert.equal(segs[0].kind, "question")
  const p = parseQuestionBlock(segs[0].kind === "question" ? segs[0].text : "", "question")
  assert.equal(p.contextMd, "Which?")
  assert.deepEqual(p.options, ["A. one", "B. two"])
})

test("parse defaults danger to false and threads a passed danger flag through", () => {
  const noFlag = parseQuestionBlock("Ready?\nA. Yes", "approval")
  assert.equal(noFlag.danger, false)
  const flagged = parseQuestionBlock("Ready?\nA. Yes", "approval", true)
  assert.equal(flagged.kind, "approval")
  assert.equal(flagged.danger, true)
  // danger threads through the freetext-only (no trailing options) return path too.
  const freetext = parseQuestionBlock("Type a reason.", "approval", true)
  assert.deepEqual(freetext.options, [])
  assert.equal(freetext.danger, true)
})

test("multi kind carries through parse with options detected", () => {
  const body = "Which findings should I fix?\n\n- A. Null deref in parse()\n- B. Off-by-one in slice()\n- C. Flaky timeout test"
  const p = parseQuestionBlock(body, "multi")
  assert.equal(p.kind, "multi")
  assert.equal(p.contextMd, "Which findings should I fix?")
  assert.deepEqual(p.options, ["A. Null deref in parse()", "B. Off-by-one in slice()", "C. Flaky timeout test"])
})

// ---- optionId ----

test("optionId extracts the leading letter/number identifier, uppercased", () => {
  assert.equal(optionId("A. SQLite — transactional"), "A")
  assert.equal(optionId("b) lowercase becomes upper"), "B")
  assert.equal(optionId("3. Ten"), "3")
  // No lettered/numbered prefix → the trimmed text (defensive fallback).
  assert.equal(optionId("  just prose  "), "just prose")
})

// ---- composeBlockAnswer ----

test("compose single-select: freetext overrides the chosen chip, else the chosen option text", () => {
  const blk = parseQuestionBlock("Pick one\nA. SQLite\nB. JSON", "question")
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "" }), "A. SQLite")
  assert.equal(composeBlockAnswer(blk, { chosen: 0, text: "actually neither" }), "actually neither")
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "" }), "")
})

test("compose approval: same single-select semantics as question", () => {
  const blk = parseQuestionBlock("Ship it?\nA. Approve\nB. Hold", "approval", true)
  assert.equal(composeBlockAnswer(blk, { chosen: 1, text: "" }), "B. Hold")
})

test("compose multi: selected letters in option order, freetext appends color", () => {
  const blk = parseQuestionBlock("Which to fix?\n- A. one\n- B. two\n- C. three\n- D. four", "multi")
  // Selected letters render in OPTION order regardless of click order.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "", chosenSet: [2, 0, 3] }), "A, C, D")
  // Freetext appends as color after the letters.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "and skip the flaky one", chosenSet: [0, 2] }), "A, C — and skip the flaky one")
  // Selecting none + text-only stays valid (freetext alone).
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "none of these — do X instead", chosenSet: [] }), "none of these — do X instead")
  // Nothing selected and no text → unanswered.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "", chosenSet: [] }), "")
  // A multi block with an absent chosenSet is treated as an empty selection.
  assert.equal(composeBlockAnswer(blk, { chosen: null, text: "" }), "")
})

// ---- recommendedIndex ----

const OPTS = ["A. Implement all three", "B. Just the primary fix", "C. Diagnosis only"]

test("recommendedIndex: plain letter matches its option", () => {
  assert.equal(recommendedIndex("Recommendation: B — tightest fix", OPTS), 1)
  assert.equal(recommendedIndex("Recommendation: A.", OPTS), 0)
})

test("recommendedIndex: markdown-bolded letter still resolves (the **B** regression)", () => {
  // Real-world break: `Recommendation: **B** — …` used to return null and fall back to a muted caption.
  assert.equal(recommendedIndex("Recommendation: **B** — it's the tightest fix", OPTS), 1)
  assert.equal(recommendedIndex("Recommendation: _C_ for now", OPTS), 2)
  assert.equal(recommendedIndex("Recommendation: `A`", OPTS), 0)
})

test("recommendedIndex: also tolerates a bolded option identifier", () => {
  assert.equal(recommendedIndex("Recommendation: B", ["**A.** one", "**B.** two"]), 1)
})

test("recommendedIndex: numeric identifiers", () => {
  assert.equal(recommendedIndex("Recommendation: 2 — cheaper", ["1. one", "2. two", "3. three"]), 1)
})

test("recommendedIndex: no match → null (keeps the muted caption fallback)", () => {
  assert.equal(recommendedIndex(undefined, OPTS), null)
  assert.equal(recommendedIndex("Recommendation: whichever you prefer", OPTS), null)
  assert.equal(recommendedIndex("Recommendation: Z — off the list", OPTS), null)
  // Guard the `(?![A-Za-z0-9])` boundary: an English lead word must NOT read as its first-letter option
  // ("Approve" must not chip option A). Dropping the lookahead would silently regress this to 0.
  assert.equal(recommendedIndex("Recommendation: Approve as-is", OPTS), null)
})

// ---- inline "recommended" marker (the primary mechanism) ----

test("inline (recommended) marker → flags the option, strips the marker, no leftover text", () => {
  const p = parseQuestionBlock("How to proceed?\n\n- A. SQLite — transactional (recommended)\n- B. JSON — zero deps", "question")
  assert.equal(p.recommendedIdx, 0)
  assert.deepEqual(p.options, ["A. SQLite — transactional", "B. JSON — zero deps"])
  assert.equal(p.recommendedNote, undefined)
})

test("inline (recommended: why) → rationale captured as the note", () => {
  const p = parseQuestionBlock("Pick one:\n\n- A. one\n- B. two (recommended: cheaper and simpler)", "question")
  assert.equal(p.recommendedIdx, 1)
  assert.deepEqual(p.options, ["A. one", "B. two"])
  assert.equal(p.recommendedNote, "cheaper and simpler")
})

test("inline marker variants: **Recommended** — lead, trailing — recommended, no dangling separators", () => {
  const lead = parseQuestionBlock("Q?\n\n- A. keep it\n- B. **Recommended** — switch to pnpm", "question")
  assert.equal(lead.recommendedIdx, 1)
  assert.deepEqual(lead.options, ["A. keep it", "B. switch to pnpm"])
  const trail = parseQuestionBlock("Q?\n\n- A. Hold — recommended\n- B. Ship now", "question")
  assert.equal(trail.recommendedIdx, 0)
  assert.deepEqual(trail.options, ["A. Hold", "B. Ship now"])
})

test("inline marker preserves the option's own backticks/emphasis when stripping", () => {
  const p = parseQuestionBlock("Flag?\n\n- A. Use `--strict` (recommended)\n- B. Use `--safe`", "question")
  assert.deepEqual(p.options, ["A. Use `--strict`", "B. Use `--safe`"])
  assert.equal(p.recommendedIdx, 0)
})

test("'recommendation' (the noun) in option prose does NOT flag it — only the word 'recommended'", () => {
  const p = parseQuestionBlock("Q?\n\n- A. Merge as-is — my recommendation stands\n- B. Hold", "question")
  assert.equal(p.recommendedIdx, null)
  assert.deepEqual(p.options, ["A. Merge as-is — my recommendation stands", "B. Hold"])
})

test("first flagged option wins when several carry the marker", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one\n- B. two (recommended)\n- C. three (recommended)", "question")
  assert.equal(p.recommendedIdx, 1)
})

test("no marker + no rec line → recommendedIdx null, no caption", () => {
  const p = parseQuestionBlock("Q?\n\n- A. one\n- B. two", "question")
  assert.equal(p.recommendedIdx, null)
  assert.equal(p.recommendation, undefined)
})

// ---- legacy "Recommendation: X" line still works as a fallback ----

test("legacy rec line: matches an option by letter → recommendedIdx + note, chip (no inline marker)", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one\n- B. two\n\nRecommendation: B — cheaper", "question")
  assert.equal(p.recommendedIdx, 1)
  assert.equal(p.recommendedNote, "Recommendation: B — cheaper")
  assert.equal(p.recommendation, "Recommendation: B — cheaper")
})

test("legacy rec line that names no option → recommendedIdx null but recommendation kept (muted caption)", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one\n- B. two\n\nRecommendation: whichever you like", "question")
  assert.equal(p.recommendedIdx, null)
  assert.equal(p.recommendation, "Recommendation: whichever you like")
})

test("inline marker WINS over a legacy rec line if both are present", () => {
  const p = parseQuestionBlock("Pick:\n\n- A. one (recommended)\n- B. two\n\nRecommendation: B", "question")
  assert.equal(p.recommendedIdx, 0)
})

// ---- inline marker: rationale separators + content-vs-marker (round-2 review fixes) ----

test("inline note accepts comma/semicolon separators, not just colon/dash", () => {
  const comma = parseQuestionBlock("Q?\n\n- A. Foo (recommended, because it's faster)\n- B. Bar", "question")
  assert.deepEqual(comma.options, ["A. Foo", "B. Bar"])
  assert.equal(comma.recommendedIdx, 0)
  assert.equal(comma.recommendedNote, "because it's faster")
  const semi = parseQuestionBlock("Q?\n\n- A. Foo (recommended; also cheapest)\n- B. Bar", "question")
  assert.equal(semi.recommendedNote, "also cheapest")
})

test("a bare interior 'recommended' is CONTENT, not a marker — never flagged, never rewritten", () => {
  const p = parseQuestionBlock("Q?\n\n- A. Use the recommended settings\n- B. Use custom settings", "question")
  assert.equal(p.recommendedIdx, null)
  assert.deepEqual(p.options, ["A. Use the recommended settings", "B. Use custom settings"])
  // A hyphenated neighbor ("recommended-only") is likewise left as content.
  const q = parseQuestionBlock("Q?\n\n- A. Enable recommended-only mode\n- B. Enable all", "question")
  assert.equal(q.recommendedIdx, null)
  assert.deepEqual(q.options, ["A. Enable recommended-only mode", "B. Enable all"])
})

test("inline marker with no space before the paren, preserving the label's own backticks", () => {
  const p = parseQuestionBlock("Flag?\n\n- A. Use `--strict`(recommended)\n- B. Use `--safe`", "question")
  assert.deepEqual(p.options, ["A. Use `--strict`", "B. Use `--safe`"])
  assert.equal(p.recommendedIdx, 0)
})
