// Parse an assistant message's markdown for ```done / ```awaiting SIGNAL fences so the renderer can
// set each one off as a CARD in place of the raw block (mirrors questionBlocks.ts). Transcripts arrive
// as raw markdown, so the client parses fences itself — the grammar is identical to the fence spec the
// worker writes and the server's lastFence parser: an opening line exactly ```done or ```awaiting, the
// body, then a closing ``` line. Pure string logic, no DOM — unit-testable.
//
// The signal fence LANGUAGE is the state: `done` = a success card (+ an Archive button on the final
// message of a non-archived session thread), `awaiting` = a machine-wait card with hint chips. Distinct
// from ```question blocks (their own machinery in questionBlocks.ts) — those never match here.

import type { AwaitingHint } from "@fray-ui/shared"

export type FenceKind = "done" | "awaiting"

export type FenceSegment =
  | { kind: "prose"; text: string }
  | { kind: "fence"; fenceKind: FenceKind; body: string; hints: AwaitingHint[] }

// Opening fence begins a line: ```done or ```awaiting (NO info-string — the language alone is the
// state), a newline, then the body non-greedily to the next line that is exactly ``` (optional trailing
// spaces). The `m` flag anchors ^/$ to line boundaries; an unterminated opener never matches, so a
// half-written fence degrades to ordinary prose (markdown renders it as a plain code block). ```question
// can't match the (done|awaiting) alternation, so question blocks are left entirely to questionBlocks.ts.
const FENCE_BLOCK = /^```(done|awaiting)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm

// A machine-wait hint line inside an ```awaiting body: `<kind>: <value>` where kind ∈ pr|ci|timer|session
// (case-insensitive). Everything else is prose. Matches the ThreadFence hint grammar in shared.
const HINT_RE = /^(pr|ci|timer|session):\s*(.+)$/i

// Split the body of a fence into its prose (hint lines removed) and its parsed hints. `done` fences
// carry no hints — the whole body is prose.
// Defensive caps matching the server's lastFence parser (tailer.ts): 8 hints, 200-char values — so a
// pathological body can't render a divergent chip row between the sidebar gloss (server-parsed) and
// the in-chat card (client-parsed).
const HINT_MAX = 8
const HINT_VALUE_MAX = 200

export function parseFenceBody(raw: string, kind: FenceKind): { body: string; hints: AwaitingHint[] } {
  if (kind === "done") return { body: raw.trim(), hints: [] }
  const hints: AwaitingHint[] = []
  const prose: string[] = []
  for (const line of raw.split("\n")) {
    const l = line.replace(/\r$/, "")
    const m = l.match(HINT_RE)
    if (m) hints.push({ kind: m[1].toLowerCase() as AwaitingHint["kind"], value: m[2].trim().slice(0, HINT_VALUE_MAX) })
    else prose.push(l)
  }
  return { body: prose.join("\n").trim(), hints: hints.slice(0, HINT_MAX) }
}

// Split an assistant message's markdown into prose runs and signal-fence blocks, in document order.
// Prose runs that are whitespace-only are dropped (a fence never leads/trails with an empty prose slot).
export function splitFenceBlocks(text: string): FenceSegment[] {
  const segments: FenceSegment[] = []
  let lastIndex = 0
  FENCE_BLOCK.lastIndex = 0
  for (let m = FENCE_BLOCK.exec(text); m !== null; m = FENCE_BLOCK.exec(text)) {
    const prose = text.slice(lastIndex, m.index)
    if (prose.trim()) segments.push({ kind: "prose", text: prose })
    const fenceKind = m[1] as FenceKind
    const { body, hints } = parseFenceBody(m[2], fenceKind)
    segments.push({ kind: "fence", fenceKind, body, hints })
    lastIndex = m.index + m[0].length
  }
  const rest = text.slice(lastIndex)
  if (rest.trim()) segments.push({ kind: "prose", text: rest })
  return segments
}

// True when a message carries at least one signal fence — the cheap check ChatView uses to decide a
// message renders a fence card rather than the raw block.
export function hasFence(text: string): boolean {
  FENCE_BLOCK.lastIndex = 0
  return FENCE_BLOCK.test(text)
}
