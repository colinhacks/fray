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
  onSubmit: () => void // ⌘-Enter from any block input, or this message's Send button, composes + sends
  anyAnswered: boolean // at least one of THIS message's blocks is filled → its Send button is enabled
  sending: boolean // a send is in flight → disable this message's Send button
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
// removed), the detected answer options as clickable choices, and which option (if any) is recommended.
export interface ParsedQuestion {
  kind: QuestionKind
  danger: boolean
  contextMd: string
  // Option labels with any inline "recommended" marker stripped out (the badge conveys it instead).
  options: string[]
  // The recommended option's index, or null if none. Primary signal: the word "recommended" ON an
  // option line (`recommendedIdx` points at it). Legacy fallback: a "Recommendation: X" line whose
  // leading letter matches an option. Null → no chip; the free-form `recommendation` line (if any)
  // renders as a muted caption instead.
  recommendedIdx: number | null
  // The rationale shown on the recommended chip's tooltip — the inline marker's `(recommended: why)`
  // text, or the legacy "Recommendation: …" line when we fell back to letter-matching.
  recommendedNote?: string
  // A legacy "Recommendation: …" line, kept ONLY to drive the muted-caption fallback when it names no
  // matching option. New-style questions mark the option inline and carry no such line.
  recommendation?: string
  // Prose that follows the option run (a worker often adds a "Note: …" footnote AFTER the choices).
  // Rendered BELOW the chips so the options stay answerable instead of the trailing prose swallowing them.
  trailingMd?: string
}

// An option line: an optional markdown list marker (workers write options as `- A. …`), then a single
// uppercase letter or a number, then `.`/`)`, then a space. Matches the fray worker convention.
const OPTION_RE = /^\s*(?:[-*+]\s+)?([A-Z]|\d+)[.)]\s+\S/
const REC_RE = /^\s*recommendation\b/i

// Strip a leading markdown list marker so the chip shows "A. …" rather than "- A. …".
function optionText(line: string): string {
  return line.trim().replace(/^[-*+]\s+/, "")
}

// The inline "recommended" marker — the PRIMARY, single-source-of-truth way a worker flags the
// recommended option: the word "recommended" appearing ON that option's line (no separate letter-matched
// line to drift out of sync). Detection is intentionally permissive (just the word, case-insensitive,
// ignoring surrounding markdown emphasis). Given a match, we (1) mark the option, (2) STRIP the marker so
// the badge — not literal "(recommended)" text — is what shows, and (3) lift any `(recommended: <why>)`
// rationale into a note for the chip tooltip. The documented worker form is a trailing `(recommended)` /
// `(recommended: why)`; the leading/trailing/bare variants below are tolerated so the rule "just write
// recommended" holds. Returns the cleaned label + whether it was flagged + the optional rationale.
const REC_WORD = /(^|[^a-z])recommended([^a-z]|$)/i
// Collapse the doubled space an excision can leave; NON-destructive otherwise (must not eat a label's own
// trailing backtick/emphasis — each marker regex below consumes its own joining separator instead).
function tidyLabel(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim()
}
export function stripRecommendedMarker(label: string): { label: string; recommended: boolean; note?: string } {
  if (!REC_WORD.test(label)) return { label, recommended: false }
  // We only treat the word as a MARKER when it sits in a tag position — parenthesized, emphasized, or a
  // leading/trailing tag. A bare interior "recommended" (e.g. "Use the recommended settings") is genuine
  // option CONTENT: leave it untouched (case 5). This keeps the "just write recommended" rule while
  // refusing to silently rewrite a sentence that merely contains the word.
  //
  // 1) The documented form: a parenthesized/bracketed marker anywhere, with an optional rationale after a
  //    `:`/`,`/`;`/dash — "(recommended)", "(recommended: why)", "(recommended, why)". Consume an optional
  //    preceding separator so no dangling " —" is left.
  const paren = label.match(/\s*[—–-]?\s*[([]\s*[*_`~]*recommended\b(?:\s*[:：,;—–-]\s*([^)\]]*?))?\s*[*_`~]*\s*[)\]]/i)
  if (paren) {
    const note = paren[1]?.trim() || undefined
    return { label: tidyLabel(label.slice(0, paren.index!) + label.slice(paren.index! + paren[0].length)), recommended: true, note }
  }
  // 2) An EMPHASIZED tag anywhere — the **…**/_…_/`…` wrapper marks it as a label, e.g.
  //    "B. **Recommended** — switch to pnpm". Consume an adjacent separator on either side.
  const emph = label.match(/\s*[—–:-]?\s*[*_`~]+recommended\b[*_`~]+\s*[—–:-]?\s*/i)
  if (emph) {
    return { label: tidyLabel(label.slice(0, emph.index!) + " " + label.slice(emph.index! + emph[0].length)), recommended: true }
  }
  // 3) A TRAILING tag — the word at the very END, optionally set off by a separator: "Hold — recommended".
  const trail = label.match(/\s*[—–:-]?\s*recommended\b\s*$/i)
  if (trail && trail.index! > 0) return { label: tidyLabel(label.slice(0, trail.index!)), recommended: true }
  // 4) A LEADING tag SET OFF by a separator (so a "Recommended settings …" sentence is NOT mis-stripped):
  //    "Recommended: use JSON", after any "A." / "1)" id prefix (which we keep).
  const lead = label.match(/^(\s*(?:[A-Za-z]|\d+)[.)]\s*)?[*_`~]*recommended\b[*_`~]*\s*[:：—–-]\s*/i)
  if (lead) {
    const rest = tidyLabel((lead[1] ?? "") + label.slice(lead[0].length))
    if (rest) return { label: rest, recommended: true }
  }
  // 5) The word appears only as interior sentence content — not a marker. Leave the label intact.
  return { label, recommended: false }
}

// Detect the option RUN — a maximal block of lettered/numbered choice lines (`- A. …`), wherever it
// sits in the block: NOT required to be trailing. Workers often follow the choices with a "Note: …"
// footnote (or lead with context), and the old "options must be the last thing" rule then found no run
// and dropped every chip. Now: context = prose BEFORE the run; the run = the chips; prose AFTER the run
// = `trailingMd` (rendered below the chips); a "Recommendation: …" line anywhere after the run is the
// muted rec note. Blank lines WITHIN the run are tolerated. No option run → a freetext-only question.
export function parseQuestionBlock(body: string, kind: QuestionKind, danger = false): ParsedQuestion {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""))

  // First maximal run of option lines (consecutive OPTION_RE lines; interspersed blanks don't break it).
  let runStart = -1
  let runEnd = -1
  for (let i = 0; i < lines.length; i++) {
    if (OPTION_RE.test(lines[i])) {
      if (runStart === -1) runStart = i
      runEnd = i
    } else if (runStart !== -1 && lines[i].trim() !== "") {
      break // a non-blank, non-option line ends the run
    }
  }
  if (runStart === -1) return { kind, danger, contextMd: body, options: [], recommendedIdx: null }

  // PRIMARY recommendation signal: the word "recommended" on an option line. Strip the marker from each
  // label (the badge conveys it) and remember the FIRST flagged option + its inline rationale.
  const options: string[] = []
  let recommendedIdx: number | null = null
  let recommendedNote: string | undefined
  for (let i = runStart; i <= runEnd; i++) {
    if (!OPTION_RE.test(lines[i])) continue
    const { label, recommended, note } = stripRecommendedMarker(optionText(lines[i]))
    if (recommended && recommendedIdx === null) {
      recommendedIdx = options.length
      recommendedNote = note
    }
    options.push(label)
  }

  const trim = (arr: string[]) => {
    let a = 0
    let b = arr.length - 1
    while (a <= b && arr[a].trim() === "") a++
    while (b >= a && arr[b].trim() === "") b--
    return arr.slice(a, b + 1)
  }

  const contextMd = trim(lines.slice(0, runStart)).join("\n")
  // After the run: peel a single legacy "Recommendation: …" line out; the rest is trailing prose.
  let recommendation: string | undefined
  const trailing: string[] = []
  for (const l of lines.slice(runEnd + 1)) {
    if (recommendation === undefined && REC_RE.test(l)) recommendation = l.trim()
    else trailing.push(l)
  }
  const trailingMd = trim(trailing).join("\n") || undefined

  // LEGACY FALLBACK: no inline marker but an old-style "Recommendation: X" line → match it to an option
  // by leading letter. If it names no option, `recommendedIdx` stays null and the line renders as the
  // muted caption. New-style questions never reach this branch.
  if (recommendedIdx === null && recommendation) {
    recommendedIdx = recommendedIndex(recommendation, options)
    if (recommendedIdx !== null) recommendedNote = recommendation
  }

  return { kind, danger, contextMd, options, recommendedIdx, recommendedNote, recommendation, trailingMd }
}

// Leading markdown emphasis/backticks a worker may wrap an identifier in (`**B**`, `_B_`, `` `B` ``).
// Stripped before we read the letter so the bolded-letter form still resolves to its option.
const EMPHASIS_PREFIX = /^[*_`~\s]+/

// Match a "Recommendation: B — …" line to its option INDEX by the recommendation's leading identifier
// ("B." / "B)" / "2." / a bare "B"), tolerating markdown emphasis the worker wraps the letter in
// (`**B**` was the real-world break: the `*` blocked the letter match and the rec fell back to a muted
// caption instead of chipping option B). Returns null when nothing matches — the caller then keeps the
// free-form recommendation as a muted caption below the chips instead of marking an option.
export function recommendedIndex(recommendation: string | undefined, options: string[]): number | null {
  if (!recommendation) return null
  const m = recommendation
    .replace(/^\s*recommendation\s*:?\s*/i, "") // drop the "Recommendation:" label
    .replace(EMPHASIS_PREFIX, "") // then any emphasis/backticks around the identifier
    // A single letter/number NOT immediately followed by another alphanumeric — so a lone "B" (or "B.",
    // "**B**", "_C_") resolves, but "Approve" does not read as option A. `_` is a word char, so `\b`
    // can't be used here (it would reject "_C_"); the lookahead is the correct boundary.
    .match(/^([A-Za-z]|\d+)(?![A-Za-z0-9])/)
  if (!m) return null
  const id = m[1].toUpperCase()
  const idx = options.findIndex((o) => {
    const om = o.replace(EMPHASIS_PREFIX, "").match(/^([A-Za-z]|\d+)[.)]/)
    return om ? om[1].toUpperCase() === id : false
  })
  return idx === -1 ? null : idx
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
