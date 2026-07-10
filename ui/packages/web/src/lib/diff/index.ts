// fray's diff renderer: turn (old, next, file) into structured, syntax-highlighted diff lines the
// chat view can render as React. Self-contained (no Shiki, no server round-trip) — see highlight.ts
// for the tokenizer rationale. The return is DATA, not HTML: the client owns the markup + theme, so
// there's nothing to sanitize and the shape is trivially unit-testable.

import { detectLang } from "./lang.ts"
import { highlightLines, type DiffToken, type TokenKind } from "./highlight.ts"
import { diffLines } from "./diff.ts"

export type { DiffToken, TokenKind } from "./highlight.ts"
export { detectLang } from "./lang.ts"

export type DiffLineType = "add" | "del" | "context"

export interface DiffLine {
  type: DiffLineType
  oldLine: number | null // 1-based line number in the old file (del/context)
  newLine: number | null // 1-based line number in the new file (add/context)
  tokens: DiffToken[]
}

export interface DiffHunk {
  // Count of unchanged lines collapsed immediately before this hunk (for a "N unchanged lines" rule).
  collapsedBefore: number
  lines: DiffLine[]
}

export interface RenderedDiff {
  file: string
  lang: string
  status: "added" | "deleted" | "modified"
  hunks: DiffHunk[]
  collapsedAfter: number // unchanged lines collapsed after the final hunk
  additions: number
  deletions: number
}

// Context lines kept around each change; runs longer than 2× this + 1 between changes get collapsed
// into separate hunks. Mirrors gent's renderer so the two surfaces read the same.
const CONTEXT_LINES = 3

const linesOf = (text: string): string[] => (text === "" ? [] : text.split("\n"))

function toLine(op: { type: "eq" | "del" | "add"; a: number | null; b: number | null }, before: DiffToken[][], after: DiffToken[][]): DiffLine {
  if (op.type === "del") {
    return { type: "del", oldLine: op.a! + 1, newLine: null, tokens: before[op.a!] ?? [] }
  }
  if (op.type === "add") {
    return { type: "add", oldLine: null, newLine: op.b! + 1, tokens: after[op.b!] ?? [] }
  }
  return { type: "context", oldLine: op.a! + 1, newLine: op.b! + 1, tokens: after[op.b!] ?? [] }
}

// Group the flat diff-line list into hunks: each change plus CONTEXT_LINES of surrounding context,
// merging changes that sit within 2× context of each other, and collapsing the unchanged runs
// between hunks. Adapted from gent's computeUnifiedDiff, operating on structured lines.
function toHunks(lines: DiffLine[]): { hunks: DiffHunk[]; collapsedAfter: number } {
  const changeIdx: number[] = []
  for (let i = 0; i < lines.length; i++) if (lines[i].type !== "context") changeIdx.push(i)
  if (changeIdx.length === 0) return { hunks: [], collapsedAfter: lines.length }

  const hunks: DiffHunk[] = []
  let hunkStart = Math.max(0, changeIdx[0] - CONTEXT_LINES)
  let hunkEnd = -1

  for (let ci = 0; ci < changeIdx.length; ci++) {
    const idx = changeIdx[ci]
    const next = changeIdx[ci + 1]
    hunkEnd = Math.min(lines.length - 1, idx + CONTEXT_LINES)
    if (next !== undefined && next - idx <= CONTEXT_LINES * 2 + 1) continue // merge into this hunk
    hunks.push({ collapsedBefore: hunkStart, lines: lines.slice(hunkStart, hunkEnd + 1) })
    if (next !== undefined) hunkStart = Math.max(hunkEnd + 1, next - CONTEXT_LINES)
  }

  const lastEnd = hunks.length ? hunks[hunks.length - 1].collapsedBefore + hunks[hunks.length - 1].lines.length : 0
  return { hunks, collapsedAfter: Math.max(0, lines.length - lastEnd) }
}

export function renderDiff(old: string, next: string, file: string): RenderedDiff {
  const lang = detectLang(file)
  const before = highlightLines(old, lang)
  const after = highlightLines(next, lang)
  const beforeLines = linesOf(old)
  const afterLines = linesOf(next)

  const status: RenderedDiff["status"] = old === "" ? "added" : next === "" ? "deleted" : "modified"

  // Added / deleted whole file: one hunk, every line, no context collapsing.
  if (status === "added") {
    const lines: DiffLine[] = afterLines.map((_, i) => ({ type: "add", oldLine: null, newLine: i + 1, tokens: after[i] ?? [] }))
    return { file, lang, status, hunks: [{ collapsedBefore: 0, lines }], collapsedAfter: 0, additions: lines.length, deletions: 0 }
  }
  if (status === "deleted") {
    const lines: DiffLine[] = beforeLines.map((_, i) => ({ type: "del", oldLine: i + 1, newLine: null, tokens: before[i] ?? [] }))
    return { file, lang, status, hunks: [{ collapsedBefore: 0, lines }], collapsedAfter: 0, additions: 0, deletions: lines.length }
  }

  const ops = diffLines(beforeLines, afterLines)
  const lines = ops.map((op) => toLine(op, before, after))
  const additions = lines.filter((l) => l.type === "add").length
  const deletions = lines.filter((l) => l.type === "del").length
  const { hunks, collapsedAfter } = toHunks(lines)
  return { file, lang, status, hunks, collapsedAfter, additions, deletions }
}
