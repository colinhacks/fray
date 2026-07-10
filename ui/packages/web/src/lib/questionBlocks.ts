// Parse an assistant message's markdown for ```question fenced blocks so the renderer can set each
// one off as an answerable card WITHIN the message's narrative flow (prose stays in place). Pure
// string logic, no DOM — unit-testable.

// The three answer MODES a ```question block can carry (the info-string picks one):
//   question — single-select (radio feel) OR freetext; the default.
//   approval — a go/no-go gate (same single-select semantics, gate styling).
//   multi    — multi-select: several options may be toggled on at once, freetext appends color.
// `danger` (a separate orthogonal flag, below) layers destructive styling on any of these.
export type QuestionKind = "question" | "approval" | "multi"

// Per-question-block answer state (one per ```question block in a message). Grows ADDITIVELY so the
// existing single-select semantics stay untouched: `chosen` is the selected chip index for
// question/approval (mutually exclusive with non-empty `text` — freetext overrides a chip). `chosenSet`
// is the toggled-on option indices for a `multi` block, where freetext COEXISTS with the selection
// (it appends color) rather than overriding it. Lives here (not in a component) so the shared answering
// controller, the queue card, and the thread view all agree.
export type BlockAnswer = { chosen: number | null; text: string; chosenSet?: number[] }

// The interactivity handed to the shared Message renderer so a LIVE message's ```question blocks become
// answerable (chips + a per-block freetext line). Absent → the blocks render read-only.
export type MessageAnswering = {
  answerFor: (blockIdx: number) => BlockAnswer
  onChip: (blockIdx: number, optIdx: number, optText: string) => void
  onText: (blockIdx: number, text: string) => void
  onSubmit: () => void // ⌘-Enter from any block input composes + sends
}

export type MessageSegment =
  | { kind: "prose"; text: string }
  | { kind: "question"; text: string; questionKind: QuestionKind; danger: boolean }

// Opening fence begins a line: ```question, an OPTIONAL info-string of one or more space-separated
// tokens (e.g. ```question approval, ```question multi, ```question approval danger), then a newline;
// the block runs non-greedily to the next line that is exactly ``` (optional trailing spaces). Group 1
// captures the WHOLE info-string run (letter-led, up to the newline) so multi-token combinations parse;
// parseInfoString below tokenizes it. The `m` flag anchors ^/$ to line boundaries; an unterminated
// opener simply never matches, so a half-written block degrades to ordinary prose (markdown renders it
// as a plain code block).
const QUESTION_BLOCK = /^```question(?:[ \t]+([A-Za-z][^\r\n]*?))?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm

// The tokens the info-string understands. Base kind is picked by the first recognized of multi >
// approval > question; `danger` is an orthogonal styling flag. GRACEFUL DEGRADATION: unknown/extra
// tokens are ignored, and an info-string with no recognized base token degrades to kind "question" —
// a never-break rule so a future or mistyped token can never turn a block into a parse failure.
function parseInfoString(info: string | undefined): { kind: QuestionKind; danger: boolean } {
  const tokens = (info ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const has = (t: string) => tokens.includes(t)
  const kind: QuestionKind = has("multi") ? "multi" : has("approval") ? "approval" : "question"
  return { kind, danger: has("danger") }
}

export function splitQuestionBlocks(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let lastIndex = 0
  QUESTION_BLOCK.lastIndex = 0
  for (let m = QUESTION_BLOCK.exec(text); m !== null; m = QUESTION_BLOCK.exec(text)) {
    const prose = text.slice(lastIndex, m.index)
    if (prose.trim()) segments.push({ kind: "prose", text: prose })
    const { kind, danger } = parseInfoString(m[1])
    segments.push({ kind: "question", text: m[2], questionKind: kind, danger })
    lastIndex = m.index + m[0].length
  }
  const rest = text.slice(lastIndex)
  if (rest.trim()) segments.push({ kind: "prose", text: rest })
  return segments
}

// The parsed innards of one ```question block: the context prose (options + trailing recommendation
// removed), the detected answer options as clickable choices, and the muted recommendation note.
export interface ParsedQuestion {
  kind: QuestionKind
  danger: boolean
  contextMd: string
  options: string[]
  recommendation?: string
}

// An option line: an optional markdown list marker (workers write options as `- A. …`), then a single
// uppercase letter or a number, then `.`/`)`, then a space. Matches the fray worker convention.
const OPTION_RE = /^\s*(?:[-*+]\s+)?([A-Z]|\d+)[.)]\s+\S/
const REC_RE = /^\s*recommendation\b/i

// Strip a leading markdown list marker so the chip shows "A. …" rather than "- A. …".
function optionText(line: string): string {
  return line.trim().replace(/^[-*+]\s+/, "")
}

// Detect a TRAILING run of option lines (the convention: the block ends with its lettered/numbered
// choices), optionally followed by one "Recommendation: …" line. Those lines become chips/a note and
// are removed from the rendered prose. No trailing option run → a freetext-only question (options: []).
export function parseQuestionBlock(body: string, kind: QuestionKind, danger = false): ParsedQuestion {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""))
  let end = lines.length - 1
  while (end >= 0 && lines[end].trim() === "") end--
  if (end < 0) return { kind, danger, contextMd: body, options: [] }

  let cursor = end
  let recIdx = -1
  if (REC_RE.test(lines[cursor])) {
    recIdx = cursor
    cursor--
    while (cursor >= 0 && lines[cursor].trim() === "") cursor--
  }

  const optIdxs: number[] = []
  while (cursor >= 0 && OPTION_RE.test(lines[cursor])) {
    optIdxs.push(cursor)
    cursor--
  }
  // No trailing options → the whole body is context (a lone "Recommendation:" isn't special here).
  if (optIdxs.length === 0) return { kind, danger, contextMd: body, options: [] }

  optIdxs.reverse()
  const options = optIdxs.map((i) => optionText(lines[i]))
  const recommendation = recIdx !== -1 ? lines[recIdx].trim() : undefined

  let ctxEnd = optIdxs[0] - 1
  while (ctxEnd >= 0 && lines[ctxEnd].trim() === "") ctxEnd--
  const contextMd = lines.slice(0, ctxEnd + 1).join("\n")
  return { kind, danger, contextMd, options, recommendation }
}

// An option's leading identifier ("A. SQLite …" → "A", "3) Ten" → "3"), used to compose a multi-select
// answer as a compact letter list. Falls back to the trimmed option text when there's no lettered/
// numbered prefix (a defensive path — multi options carry ids by convention).
export function optionId(opt: string): string {
  const m = opt.match(/^\s*([A-Za-z]|\d+)[.)]/)
  return m ? m[1].toUpperCase() : opt.trim()
}

// Compose ONE block's final answer string from its selection + freetext — the single source of truth
// shared by the send path and its tests. Single-select (question/approval): freetext OVERRIDES the
// chosen chip (else the chosen option's full text). Multi-select: the toggled options' letters in
// option order ("A, C"), with any freetext appended as color ("A, C — and skip the flaky one");
// selecting none but typing stays valid (freetext alone). Empty string ⇒ this block is unanswered.
export function composeBlockAnswer(block: ParsedQuestion, ans: BlockAnswer): string {
  const text = ans.text.trim()
  if (block.kind === "multi") {
    const joined = (ans.chosenSet ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((i) => optionId(block.options[i] ?? ""))
      .filter(Boolean)
      .join(", ")
    if (joined && text) return `${joined} — ${text}`
    return joined || text
  }
  return text || (ans.chosen != null ? block.options[ans.chosen] ?? "" : "")
}
