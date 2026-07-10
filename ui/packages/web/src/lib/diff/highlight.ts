// A tiny, dependency-free syntax highlighter — the "custom highlighter" fray uses instead of a
// WASM grammar engine (Shiki) or a server round-trip (Pierre). It is deliberately approximate: a
// single stateful character scan driven by a per-language config (comments / strings / keywords),
// classifying each run into a coarse token kind. Not grammar-accurate, but O(n) over the text with
// no async, no bundle weight, and good-enough color for a diff preview.
//
// It returns one token array PER LINE (aligned 1:1 with text.split("\n")), because the diff aligner
// needs to pull the tokens for a specific old/new line number.

export type TokenKind = "kw" | "type" | "str" | "com" | "num" | "fn" | "punct" | "op" | "plain"

export interface DiffToken {
  text: string
  kind: TokenKind
}

interface LangConfig {
  line: string | null // line-comment marker, e.g. "//" or "#"
  block: [string, string] | null // block-comment delimiters, e.g. ["/*", "*/"]
  quotes: string[] // string delimiters; a backtick, when present, allows multi-line strings
  keywords: Set<string>
  types: Set<string>
}

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const C_FAMILY_KW = set(`
  break case catch class const continue debugger default delete do else enum export extends
  false finally for function if import in instanceof new null return super switch this throw
  true try typeof var void while with yield async await let static get set of as from
  interface type namespace declare readonly public private protected implements abstract
  package struct func go defer chan map fn impl trait mut pub use mod match loop where
  int long short float double char boolean byte final synchronized volatile transient native
`)

const C_FAMILY_TYPES = set(`
  string number boolean object symbol bigint unknown any never void undefined
  String Number Boolean Object Array Promise Map Set Record Partial
  i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 str Vec Option Result Box
  int8 int16 int32 int64 uint float32 float64 error rune
`)

const LANGS: Record<string, LangConfig> = {
  typescript: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  javascript: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  go: { line: "//", block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  rust: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  java: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  c: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  cpp: { line: "//", block: ["/*", "*/"], quotes: ['"', "'"], keywords: C_FAMILY_KW, types: C_FAMILY_TYPES },
  css: { line: null, block: ["/*", "*/"], quotes: ['"', "'"], keywords: set("important media supports keyframes import from to"), types: new Set() },
  json: { line: null, block: null, quotes: ['"'], keywords: set("true false null"), types: new Set() },
  python: {
    line: "#", block: null, quotes: ['"', "'"],
    keywords: set(`
      def class return if elif else for while break continue pass import from as with try except
      finally raise lambda yield global nonlocal del assert async await and or not in is None True
      False self lambda`),
    types: set("int float str bool list dict set tuple bytes object"),
  },
  shell: {
    line: "#", block: null, quotes: ['"', "'"],
    keywords: set("if then else elif fi for while do done case esac in function return export local echo cd exit set unset source"),
    types: new Set(),
  },
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c)
const isDigit = (c: string) => c >= "0" && c <= "9"
const PUNCT = new Set("{}()[];,.")
const OP = new Set("+-*/%=<>!&|^~?:@")

// Scan the whole text into a flat token stream (tokens may embed "\n" for multi-line comments,
// strings, and whitespace runs). splitLines then slices it back into per-line arrays.
function scan(text: string, cfg: LangConfig): DiffToken[] {
  const toks: DiffToken[] = []
  const n = text.length
  const push = (t: string, kind: TokenKind) => t && toks.push({ text: t, kind })
  let i = 0

  while (i < n) {
    const c = text[i]

    if (cfg.block && text.startsWith(cfg.block[0], i)) {
      const at = text.indexOf(cfg.block[1], i + cfg.block[0].length)
      const stop = at === -1 ? n : at + cfg.block[1].length
      push(text.slice(i, stop), "com")
      i = stop
      continue
    }

    if (cfg.line && text.startsWith(cfg.line, i)) {
      let end = text.indexOf("\n", i)
      if (end === -1) end = n
      push(text.slice(i, end), "com")
      i = end
      continue
    }

    if (cfg.quotes.includes(c)) {
      const multiline = c === "`"
      let j = i + 1
      while (j < n) {
        if (text[j] === "\\") {
          j += 2
          continue
        }
        if (text[j] === c) {
          j++
          break
        }
        if (text[j] === "\n" && !multiline) break // unterminated single/double string stops at EOL
        j++
      }
      push(text.slice(i, j), "str")
      i = j
      continue
    }

    if (isDigit(c)) {
      let j = i + 1
      while (j < n && /[0-9a-fA-FxXbBoO_.]/.test(text[j])) j++
      push(text.slice(i, j), "num")
      i = j
      continue
    }

    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdent(text[j])) j++
      const word = text.slice(i, j)
      const kind: TokenKind = cfg.keywords.has(word)
        ? "kw"
        : cfg.types.has(word)
          ? "type"
          : text[j] === "(" // an identifier immediately followed by "(" reads as a call/definition
            ? "fn"
            : "plain"
      push(word, kind)
      i = j
      continue
    }

    if (PUNCT.has(c)) {
      push(c, "punct")
      i++
      continue
    }

    if (OP.has(c)) {
      let j = i + 1
      while (j < n && OP.has(text[j])) j++
      push(text.slice(i, j), "op")
      i = j
      continue
    }

    // Everything else (whitespace, unknown chars) — group into a plain run, but never past a char a
    // real branch above would claim, so nothing gets mis-swallowed.
    let j = i + 1
    while (
      j < n &&
      !isIdentStart(text[j]) &&
      !isDigit(text[j]) &&
      !cfg.quotes.includes(text[j]) &&
      !PUNCT.has(text[j]) &&
      !OP.has(text[j]) &&
      !(cfg.line && text.startsWith(cfg.line, j))
    ) {
      j++
    }
    push(text.slice(i, j), "plain")
    i = j
  }

  return toks
}

// Slice a flat token stream (whose tokens may contain "\n") into one array per source line.
function splitLines(toks: DiffToken[]): DiffToken[][] {
  const lines: DiffToken[][] = [[]]
  for (const tok of toks) {
    const parts = tok.text.split("\n")
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) lines.push([])
      if (parts[p]) lines[lines.length - 1].push({ text: parts[p], kind: tok.kind })
    }
  }
  return lines
}

// Public: one DiffToken[] per line of `text`, length === text.split("\n").length. Empty text → [].
// Unknown language → each line is a single "plain" token (no highlighting, still line-aligned).
export function highlightLines(text: string, lang: string): DiffToken[][] {
  if (text === "") return []
  const cfg = LANGS[lang]
  if (!cfg) return text.split("\n").map((l) => (l ? [{ text: l, kind: "plain" as const }] : []))
  return splitLines(scan(text, cfg))
}
