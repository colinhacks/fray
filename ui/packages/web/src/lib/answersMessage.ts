import { splitQuestionBlocks, parseQuestionBlock } from "./questionBlocks.ts"

// Detect + parse OUR OWN composed-answer format, so a user message that is a multi-block answer renders
// as a structured card (echoing the question component) instead of a flat run-on bubble. The format is
// produced by useLiveAnswering.sendAnswers for a message with >1 question block:
//
//   Answers:
//   1. <answer one>
//   2. <answer two>
//   …
//
// (A single-block answer is sent as the bare answer text with NO "Answers:" header — it stays a plain
// bubble, which is correct.) Detection is deliberately strict: the FIRST non-empty line must be exactly
// "Answers:", and the body must be numbered "N. …" lines. Anything else returns null and the caller
// falls back to the plain bubble — degrade safely, never lose text.

export interface ParsedAnswer {
  n: number
  answer: string
}

// A ParsedAnswer PAIRED with the question it answers — `question` is the originating ```question
// block's context prose (options/recommendation stripped), or undefined when pairing wasn't possible
// (no question message found / count mismatch), in which case the card falls back to numbered rows.
export interface PairedAnswer extends ParsedAnswer {
  question?: string
}

const MARKER = /^(\d+)\.\s+(.*)$/

export function parseAnswersMessage(text: string): ParsedAnswer[] | null {
  if (!text) return null
  // CR/CRLF → LF first: a terminal-injected follow-up arrives carriage-return-separated, which would
  // otherwise leave the whole message on one "line" and defeat detection (see the server's normalizer).
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  // First NON-empty line must be exactly the "Answers:" header.
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length || lines[i].trim() !== "Answers:") return null
  i++

  const out: ParsedAnswer[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(MARKER)
    if (m) {
      out.push({ n: Number(m[1]), answer: m[2] })
    } else if (out.length > 0) {
      // A continuation line of the current answer (an answer that itself spans lines) — keep the break.
      const last = out[out.length - 1]
      last.answer = last.answer ? `${last.answer}\n${line}` : line
    } else if (line.trim()) {
      // Non-empty, non-numbered content before ANY numbered answer → not our clean format; bail.
      return null
    }
  }

  if (out.length === 0) return null
  for (const a of out) a.answer = a.answer.replace(/\s+$/, "") // trim trailing blank continuation lines
  return out
}

// The minimal structural slice of a transcript message the pairing needs — role/kind/text only, so the
// function stays pure and testable without the shared schema (TranscriptMessage satisfies it).
export interface MsgLike {
  role: string
  kind?: string
  text: string
}

// Pair an answers-message with the questions it answers. The composed reply targets the ```question
// blocks of the NEAREST EARLIER question-bearing assistant message (usually the immediately-preceding
// one), so: look backward from `index`, skipping kind:"event" punctuation and text-less (tool-only)
// turns — the same skip discipline as useLiveAnswering — until either
//   · an assistant message CARRYING question blocks → pair each answer by ITS OWN NUMBER: answer `n`
//     ↔ block n (sendAnswers numbers by ORIGINAL block position and filters unanswered blocks, so a
//     PARTIAL answer set — "Answers:\n1. A" against a five-block ask — still maps faithfully). An
//     out-of-range or non-increasing number means the correlation is unreliable → unpaired rows
//     (never mislabel an answer with the wrong question);
//   · a text-bearing USER message → stop unpaired (an earlier human turn claims anything before it —
//     those questions were already answered);
//   · the list start → unpaired.
// A prose-only assistant message WITHOUT blocks is scanned PAST (a worker often follows its ask with a
// note before the human answers). Returns null when messages[index] isn't an answers-message at all —
// callers fall back to the plain bubble. Unpaired rows keep question undefined → the numbered fallback.
export function pairAnswersMessage(messages: readonly MsgLike[], index: number): PairedAnswer[] | null {
  const msg = messages[index]
  if (!msg || msg.role !== "user" || msg.kind === "event") return null
  const answers = parseAnswersMessage(msg.text)
  if (!answers) return null

  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event") continue // punctuation, not a conversation turn
    if (!m.text.trim()) continue // tool-only turn — no narrative to pair with
    if (m.role === "user") break // an earlier human turn — don't pair across it
    const blocks = splitQuestionBlocks(m.text).filter((s) => s.kind === "question")
    if (blocks.length === 0) continue // interstitial assistant prose — keep looking for the ask
    // Sanity: numbers must be strictly increasing and within the block range (sendAnswers guarantees
    // both; hand-typed text that violates them gets the safe numbered fallback).
    const sane = answers.every((a, j) => Number.isInteger(a.n) && a.n >= 1 && a.n <= blocks.length && (j === 0 || a.n > answers[j - 1].n))
    if (!sane) break
    return answers.map((a) => {
      const b = blocks[a.n - 1]
      const q = b.kind === "question" ? parseQuestionBlock(b.text, b.questionKind, b.danger).contextMd.trim() : ""
      return q ? { ...a, question: q } : { ...a }
    })
  }
  return answers
}

// Convenience for the list-map call sites: the pairing for EVERY index in one pass, null at non-answers
// positions. Precomputed where the message list is mapped (a useMemo on the messages identity) so the
// memoized Message's `paired` prop is null — a stable primitive — for every ordinary message, and only
// the (few) answers-messages get a fresh array when the list changes.
export function pairAllAnswers(messages: readonly MsgLike[]): (PairedAnswer[] | null)[] {
  return messages.map((_, i) => pairAnswersMessage(messages, i))
}
