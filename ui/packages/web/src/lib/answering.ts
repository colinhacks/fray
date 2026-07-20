import { useCallback, useMemo, useRef, useState } from "react"
import { type ChatMessage } from "../hooks.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir, useThreadSessionId } from "./drafts.ts"
import { useEagerFollowUp, type EagerFollowUpCallbacks } from "./eagerComposerSubmission.ts"
import {
  splitQuestionBlocks,
  parseQuestionBlock,
  composeBlockAnswer,
  type ParsedQuestion,
  type BlockAnswer,
  type MessageAnswering,
} from "./questionBlocks.ts"

export interface LiveAnswering {
  liveMsg: ChatMessage | undefined // the LAST substantive assistant message (its blocks get chips)
  answering: MessageAnswering | undefined // undefined when there's nothing answerable (bound to liveMsg)
  // Per-message answering view — the open-tail generalization. Returns the interactive controller for
  // ANY message that still carries unanswered question blocks (in `multiMessage` mode, that's every ask
  // in the tail after the last human turn, not just the live one), or undefined for a closed/ordinary
  // message. undefined is a stable primitive, so a memoized Message bails out unchanged for closed rows.
  answeringForMessage: (m: ChatMessage) => MessageAnswering | undefined
  answerable: boolean
  anyAnswered: boolean
  sending: boolean
  // Compose the filled per-block answers into one eager reply. With no argument every open ask is
  // gathered (the queue card, which only ever has the single live ask). Pass a message identity to
  // scope the send to JUST that message's blocks — the thread view's per-message Send button, which
  // deliberately answers one message at a time so its state never bleeds into another open ask.
  sendAnswers: (scopeIdentity?: string) => void
  sendMessage: (text: string, callbacks?: EagerFollowUpCallbacks) => void // freeform eager reply (same path as an answer)
}

// One question-bearing assistant message that is still OPEN (unanswered) — its parsed blocks, its stable
// identity (for draft/answer keys), and whether it is the LIVE (last substantive assistant) message. A
// buried ask (something the agent said after it, without a human turn in between) has isLive=false.
export interface OpenAsk {
  idx: number
  identity: string
  blocks: ParsedQuestion[]
  isLive: boolean
}

// The minimal message shape the open-ask walk needs — role/kind/text plus the stable server sourceId.
// Kept structural (not ChatMessage) so selectOpenAsks stays pure and unit-testable without the schema.
export interface AskMsgLike {
  role: string
  kind?: string
  text: string
  sourceId?: string
}

// A question block's identity, mirrored from the draft layer: the transcript's stable server sourceId,
// or a deterministic content identity for legacy lines without one (never a list index, so a
// prepend/reorder can't attach text to another question).
function messageIdentityOf(m: AskMsgLike): string {
  return m.sourceId ?? `legacy-${stableTextIdentity(m.text)}`
}

// The answerable asks, in transcript order — the pure core of the controller. Two DELIBERATELY different
// scopes, and NEITHER tracks whether a question was answered:
//   · multiMessage (thread): EVERY question-bearing assistant message is answerable, wherever it sits.
//     This is the whole "answer a buried question by scrolling back" feature — best-effort by design.
//     There is no "closing": an already-answered question stays clickable (its AnswersCard renders below
//     it, so nobody re-answers by accident), and Send only gathers the blocks the human actually filled,
//     so untouched questions contribute nothing. No answered/unanswered bookkeeping anywhere.
//   · live-only (queue card, multiMessage=false): the FIRST substantive assistant message from the end
//     decides — its blocks (possibly none) are the only answerable ones, and a later human turn means
//     nothing is answerable. Byte-for-byte the historic liveBlocks behavior; the queue card is untouched.
// `isLive` marks the last substantive assistant message so composeAnswerWire can keep the historic wire
// format for the trailing ask and switch to the self-describing (question-quoting) form for an earlier
// one — a purely POSITIONAL check, not answered-tracking.
export function selectOpenAsks(messages: readonly AskMsgLike[], multiMessage: boolean): OpenAsk[] {
  // Last substantive assistant message (skipping event punctuation) — the positional `isLive` anchor.
  let lastSubstantiveAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning") continue // punctuation (completion / codex reasoning)
    if (m.role === "assistant" && m.text.trim()) { lastSubstantiveAssistant = i; break }
  }

  const parseBlocks = (text: string): ParsedQuestion[] =>
    splitQuestionBlocks(text)
      .filter((s) => s.kind === "question")
      .map((s) => (s.kind === "question" ? parseQuestionBlock(s.text, s.questionKind, s.danger) : parseQuestionBlock("", "question")))

  // Two identical-text asks with NO sourceId (legacy transcripts only) hash to the same identity; suffix
  // the collided one with its index so their answer state / draft keys never bleed together. Unique
  // identities (the norm — sourceId is populated post-upgrade) are untouched.
  const seen = new Set<string>()
  const identityOf = (m: AskMsgLike, i: number): string => {
    let id = messageIdentityOf(m)
    if (seen.has(id)) id = `${id}#${i}`
    seen.add(id)
    return id
  }

  if (!multiMessage) {
    // live-only (queue card): the first substantive assistant from the end decides; a later human turn
    // (text-bearing user message) → nothing answerable. Same skip discipline as the historic liveBlocks.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.kind === "event" || m.kind === "reasoning") continue // punctuation (completion / codex reasoning)
      if (m.role === "user" && m.text.trim()) break
      if (m.role !== "assistant" || !m.text.trim()) continue
      const blocks = parseBlocks(m.text)
      const found = blocks.length > 0 ? [{ idx: i, identity: identityOf(m, i), blocks, isLive: i === lastSubstantiveAssistant }] : []
      return found
    }
    return []
  }

  // multiMessage (thread): collect EVERY question-bearing assistant message, in transcript order. No
  // human-turn break, no tail restriction — nothing closes, nothing is tracked.
  const found: OpenAsk[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning" || m.role !== "assistant" || !m.text.trim()) continue
    const blocks = parseBlocks(m.text)
    if (blocks.length > 0) found.push({ idx: i, identity: identityOf(m, i), blocks, isLive: i === lastSubstantiveAssistant })
  }
  return found
}

// Choose the wire form for a batch of answers. When every answer belongs to the LIVE ask, emit the
// historic format verbatim (a single-block ask → the bare answer; a multi-block ask → "Answers:\n1. …"
// numbered by ORIGINAL block position) so the queue card, the answer-pairing card, and the worker-side
// mapping are all unchanged. If ANY answer targets a BURIED ask, the bare/numbered form is ambiguous
// (which turn's question?), so emit a self-describing form that quotes each question — readable to both
// the human and the resuming worker, whose recent context is no longer the ask.
export function composeAnswerWire(input: {
  answered: readonly { isLive: boolean; question: string; answer: string }[] // all answered, transcript order
  live?: { blockCount: number; numbered: readonly { n: number; a: string }[] } // the live ask's answered blocks
}): string {
  const { answered, live } = input
  if (answered.length > 0 && answered.every((x) => x.isLive) && live) {
    return live.blockCount === 1 ? live.numbered[0].a : `Answers:\n${live.numbered.map(({ n, a }) => `${n}. ${a}`).join("\n")}`
  }
  return `Answers to earlier questions:\n${answered.map((x, k) => `${k + 1}. “${x.question}” → ${x.answer}`).join("\n")}`
}

// The ONE controller for answering ```question blocks — shared by the queue card and the thread chat
// view so their behavior can never drift. By default (`multiMessage` off — the queue card) it targets
// ONLY the live trailing ask, exactly as before. In `multiMessage` mode (the drawer thread view) EVERY
// question in the transcript stays answerable, wherever it sits — so a question buried by a sub-agent
// return / the agent's own continuation can be answered in place by scrolling back to it. This is
// deliberately best-effort and TRACKS NOTHING: no answered/unanswered bookkeeping, no "closing" of asks.
// An already-answered question stays clickable (its AnswersCard renders right below it), and Send only
// gathers the blocks the human actually filled, so untouched questions contribute nothing. `onSent` runs
// the caller's tail after a send (queue: optimistic exit + park focus; thread: nothing).
export function useLiveAnswering(
  slug: string,
  messages: ChatMessage[],
  onSent?: () => void,
  opts: { scrollToBottom?: boolean; multiMessage?: boolean } = {},
): LiveAnswering {
  const multiMessage = opts.multiMessage === true
  const followUp = useEagerFollowUp(slug)
  const [answers, setAnswers] = useState<Record<string, BlockAnswer>>({})

  // The OPEN asks, in transcript order (pure walk extracted to selectOpenAsks for unit tests).
  const openAsks = useMemo(() => selectOpenAsks(messages, multiMessage), [messages, multiMessage])

  const liveMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "event" || messages[i].kind === "reasoning") continue // punctuation, not the substantive assistant turn
      if (messages[i].role === "assistant" && messages[i].text.trim()) return messages[i]
    }
    return undefined
  }, [messages])

  const answerable = openAsks.length > 0
  const projectDir = useProjectDir()
  const sessionId = useThreadSessionId(slug)
  const keyFor = useCallback(
    (identity: string, block: number) => draftKey.answer(projectDir, slug, sessionId, identity, block),
    [projectDir, slug, sessionId],
  )
  // Every open block's freetext draft key, across ALL open asks — so a buried ask's answer text persists
  // exactly like the live one's. Legacy lines get a deterministic content identity (see messageIdentityOf).
  const textKeys = useMemo(
    () => openAsks.flatMap((a) => a.blocks.map((_, block) => keyFor(a.identity, block))),
    [openAsks, keyFor],
  )
  const persistedText = useDraftValues(textKeys)

  // IDENTITY DISCIPLINE (the render-perf thread): the closed/ordinary messages get a stable `undefined`
  // from answeringForMessage, so the memoized Message bails out unchanged; only the (few) open asks build
  // a controller, and only they re-render on a chip click / keystroke. The caller's onSent tail rides a
  // latest-ref because QueueCard passes a fresh closure every render.
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent

  const answerFor = useCallback(
    (identity: string, bi: number): BlockAnswer => {
      const local = answers[`${identity}::${bi}`] ?? { chosen: null, text: "" }
      return { ...local, text: persistedText.get(keyFor(identity, bi)) ?? "" }
    },
    [answers, persistedText, keyFor],
  )
  // A stable lookup of an open ask by message identity, so onChip/onText can read the block's kind.
  const openByIdentity = useMemo(() => {
    const map = new Map<string, OpenAsk>()
    for (const a of openAsks) map.set(a.identity, a)
    return map
  }, [openAsks])
  // Chip click. MULTI: toggle this option in/out of the set (kept in option order); freetext COEXISTS,
  // so it's preserved. SINGLE (question/approval): picking a chip clears that block's freetext (the chip
  // becomes the answer); re-picking toggles off.
  const onChip = useCallback(
    (identity: string, bi: number, optIdx: number) => {
      const blk = openByIdentity.get(identity)?.blocks[bi]
      const stateKey = `${identity}::${bi}`
      if (blk?.kind !== "multi") draftStore.clear(keyFor(identity, bi))
      setAnswers((a) => {
        const cur = a[stateKey] ?? { chosen: null, text: "" }
        if (blk?.kind === "multi") {
          const set = new Set(cur.chosenSet ?? [])
          if (set.has(optIdx)) set.delete(optIdx)
          else set.add(optIdx)
          return { ...a, [stateKey]: { chosen: null, text: cur.text, chosenSet: [...set].sort((x, y) => x - y) } }
        }
        return { ...a, [stateKey]: { chosen: cur.chosen === optIdx ? null : optIdx, text: "" } }
      })
    },
    [openByIdentity, keyFor],
  )
  // Typing. MULTI: freetext appends color on top of the toggled set — keep the set. SINGLE: typing
  // overrides any chosen chip for that block.
  const onText = useCallback(
    (identity: string, bi: number, text: string) => {
      const blk = openByIdentity.get(identity)?.blocks[bi]
      draftStore.set(keyFor(identity, bi), text)
      setAnswers((a) => {
        const stateKey = `${identity}::${bi}`
        const cur = a[stateKey] ?? { chosen: null, text: "" }
        if (blk?.kind === "multi") return { ...a, [stateKey]: { chosen: null, text, chosenSet: cur.chosenSet ?? [] } }
        return { ...a, [stateKey]: { chosen: null, text } }
      })
    },
    [openByIdentity, keyFor],
  )

  const anyAnswered = openAsks.some((a) => a.blocks.some((blk, i) => composeBlockAnswer(blk, answerFor(a.identity, i)) !== ""))

  const scrollToBottom = opts.scrollToBottom !== false
  const sendMessage = useCallback(
    (text: string, callbacks: EagerFollowUpCallbacks = {}) => {
      if (followUp.submit(text, { ...callbacks, scrollToBottom })) onSentRef.current?.()
    },
    [followUp, scrollToBottom],
  )
  const sendAnswers = useCallback((scopeIdentity?: string) => {
    // `scopeIdentity` is a message identity when the thread's per-message Send button (or a ⌘-Enter from
    // one of its blocks) fires; guard `typeof` because the queue card wires its button as onClick={sendAnswers}
    // and React would otherwise hand us a MouseEvent. Non-string → gather every open ask (queue path).
    const scope = typeof scopeIdentity === "string" ? scopeIdentity : undefined
    const scopedAsks = scope ? openAsks.filter((a) => a.identity === scope) : openAsks
    // Only the scoped asks' draft keys are cleared/rolled back — a sibling open ask keeps its draft.
    const scopedKeys = scope ? scopedAsks.flatMap((a) => a.blocks.map((_, block) => keyFor(a.identity, block))) : textKeys
    const scopedStateKeys = scopedAsks.flatMap((a) => a.blocks.map((_, bi) => `${a.identity}::${bi}`))

    // Collect every answered block across the scoped asks, in transcript order.
    const answered = scopedAsks.flatMap((a) =>
      a.blocks
        .map((blk, bi) => ({ ask: a, bi, question: questionLabel(blk), answer: composeBlockAnswer(blk, answerFor(a.identity, bi)) }))
        .filter((x) => x.answer !== ""),
    )
    if (answered.length === 0) return

    // The live ask's answered blocks, numbered by ORIGINAL block position (composeAnswerWire picks the
    // historic bare/"Answers:" form when every answer is live, else a self-describing quoted form).
    const live = scopedAsks.find((a) => a.isLive)
    const composed = composeAnswerWire({
      answered: answered.map((x) => ({ isLive: x.ask.isLive, question: x.question, answer: x.answer })),
      live: live && {
        blockCount: live.blocks.length,
        numbered: live.blocks
          .map((blk, i) => ({ n: i + 1, a: composeBlockAnswer(blk, answerFor(live.identity, i)) }))
          .filter(({ a }) => a !== ""),
      },
    })

    const answerSnapshot = answers
    const draftSnapshot = scopedKeys.map((key) => [key, draftStore.get(key)] as const)
    // Keep answers intact until the RPC actually lands. A rejected request must leave the visible
    // question draft available for retry rather than silently discarding the user's work.
    sendMessage(composed, {
      onOptimistic: () => {
        scopedKeys.forEach((key) => draftStore.clear(key))
        // Drop only the scoped message's answer state; a sibling open ask's in-progress selections stay.
        setAnswers((prev) => {
          const next = { ...prev }
          for (const key of scopedStateKeys) delete next[key]
          return next
        })
      },
      onRollback: () => {
        // Restore the scoped keys from the pre-send snapshot without clobbering edits to other asks.
        setAnswers((prev) => {
          const next = { ...prev }
          for (const key of scopedStateKeys) {
            if (answerSnapshot[key]) next[key] = answerSnapshot[key]
            else delete next[key]
          }
          return next
        })
        draftSnapshot.forEach(([key, value]) => {
          if (value && !draftStore.get(key)) draftStore.set(key, value)
        })
      },
    })
  }, [answers, openAsks, answerFor, sendMessage, textKeys, keyFor])

  const answeringForMessage = useCallback(
    (m: ChatMessage): MessageAnswering | undefined => {
      const ask = openByIdentity.get(messageIdentityOf(m))
      if (!ask) return undefined
      return {
        answerFor: (bi: number) => answerFor(ask.identity, bi),
        onChip: (bi: number, optIdx: number) => onChip(ask.identity, bi, optIdx),
        onText: (bi: number, text: string) => onText(ask.identity, bi, text),
        // ⌘-Enter / the per-message Send button submits ONLY this message's blocks (scoped identity).
        onSubmit: () => sendAnswers(ask.identity),
        anyAnswered: ask.blocks.some((blk, i) => composeBlockAnswer(blk, answerFor(ask.identity, i)) !== ""),
        sending: followUp.pending,
      }
    },
    [openByIdentity, answerFor, onChip, onText, sendAnswers, followUp.pending],
  )
  const answering = useMemo<MessageAnswering | undefined>(
    () => (liveMsg ? answeringForMessage(liveMsg) : undefined),
    [liveMsg, answeringForMessage],
  )
  return { liveMsg, answering, answeringForMessage, answerable, anyAnswered, sending: followUp.pending, sendAnswers, sendMessage }
}

// The first non-empty line of a question's context prose, trimmed + length-capped — a compact label for
// the self-describing buried-answer form (never the whole multi-paragraph block).
function firstLine(contextMd: string): string {
  const line = contextMd.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? ""
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

// A compact question label for the buried-answer form. Prefer the context prose; but a block that leads
// straight into its option run has an EMPTY contextMd — fall back to the options so the resuming worker
// still sees which question this answers (never an empty '""' quote).
function questionLabel(blk: ParsedQuestion): string {
  return firstLine(blk.contextMd) || firstLine(blk.options.join(" / ")) || "earlier question"
}

function stableTextIdentity(text: string): string {
  // FNV-1a is sufficient only to make legacy transcript identities deterministic; it is not a
  // security boundary and no server/private payload is persisted.
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(36)
}
