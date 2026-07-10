import { useCallback, useMemo, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { appendQueuedMessage, removeQueuedMessage, type ChatMessage } from "../hooks.ts"
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
  answering: MessageAnswering | undefined // undefined when there's nothing answerable
  answerable: boolean
  anyAnswered: boolean
  sendAnswers: () => void // compose the per-block answers into one eager reply
  sendMessage: (text: string) => void // freeform eager reply (same path as an answer)
}

// The ONE controller for answering the live trailing ```question block(s) of a thread — shared verbatim
// by the queue card and the thread chat view so their behavior can never drift. It finds the last
// substantive assistant message and, if it carries question blocks (and nothing since supersedes them —
// a later user message means you've already answered), exposes per-block chip/freetext state plus a
// composed eager send. Answers are numbered by ORIGINAL block position so the worker can map them back.
// `onSent` runs the caller's tail after a send (queue: optimistic exit + park focus; thread: nothing).
export function useLiveAnswering(slug: string, messages: ChatMessage[], onSent?: () => void): LiveAnswering {
  const qc = useQueryClient()
  const followUp = useMutation({ mutationFn: (m: string) => rpc.followUp({ slug, message: m }) })
  const [answers, setAnswers] = useState<Record<number, BlockAnswer>>({})

  const liveBlocks = useMemo<ParsedQuestion[]>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      // Event lines (sub-agent completion / thinking punctuation) are `role:"assistant"` with non-empty
      // text but are NOT a substantive turn — skip them so a completion notification that lands in the
      // JSONL AFTER a trailing ```question block doesn't shadow the real ask and silently disable answering.
      if (messages[i].kind === "event") continue
      if (messages[i].role === "user" && messages[i].text.trim()) return []
      if (messages[i].role !== "assistant" || !messages[i].text.trim()) continue
      const blocks = splitQuestionBlocks(messages[i].text).filter((s) => s.kind === "question")
      return blocks.map((s) => (s.kind === "question" ? parseQuestionBlock(s.text, s.questionKind, s.danger) : parseQuestionBlock("", "question")))
    }
    return []
  }, [messages])
  const liveMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "event") continue // punctuation, not the substantive assistant turn
      if (messages[i].role === "assistant" && messages[i].text.trim()) return messages[i]
    }
    return undefined
  }, [messages])
  const answerable = liveBlocks.length > 0

  // IDENTITY DISCIPLINE (the render-perf thread): everything the memoized Message receives through
  // `answering` is useCallback/useMemo-stabilized so its identity changes ONLY when the answer state or
  // the live blocks actually change — never merely because the owning card re-rendered (a board delta,
  // a composer keystroke). The caller's onSent tail rides a latest-ref for the same reason: QueueCard
  // passes a fresh closure every render, and routing it through a ref keeps the send functions stable
  // while always running the CURRENT tail.
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent

  const answerFor = useCallback((bi: number): BlockAnswer => answers[bi] ?? { chosen: null, text: "" }, [answers])
  // Chip click. MULTI: toggle this option in/out of the set (kept in option order); freetext COEXISTS,
  // so it's preserved. SINGLE (question/approval): picking a chip clears that block's freetext (the chip
  // becomes the answer); re-picking toggles off.
  const onChip = useCallback(
    (bi: number, optIdx: number) =>
      setAnswers((a) => {
        const cur = a[bi] ?? { chosen: null, text: "" }
        if (liveBlocks[bi]?.kind === "multi") {
          const set = new Set(cur.chosenSet ?? [])
          if (set.has(optIdx)) set.delete(optIdx)
          else set.add(optIdx)
          return { ...a, [bi]: { chosen: null, text: cur.text, chosenSet: [...set].sort((x, y) => x - y) } }
        }
        return { ...a, [bi]: { chosen: cur.chosen === optIdx ? null : optIdx, text: "" } }
      }),
    [liveBlocks],
  )
  // Typing. MULTI: freetext appends color on top of the toggled set — keep the set. SINGLE: typing
  // overrides any chosen chip for that block.
  const onText = useCallback(
    (bi: number, text: string) =>
      setAnswers((a) => {
        const cur = a[bi] ?? { chosen: null, text: "" }
        if (liveBlocks[bi]?.kind === "multi") return { ...a, [bi]: { chosen: null, text, chosenSet: cur.chosenSet ?? [] } }
        return { ...a, [bi]: { chosen: null, text } }
      }),
    [liveBlocks],
  )

  const anyAnswered = liveBlocks.some((blk, i) => composeBlockAnswer(blk, answerFor(i)) !== "")

  // Optimistic: immediately show the message as a queued bubble, mark read, and run the caller's tail
  // (the queue's optimistic card-exit) — responsiveness the send shouldn't wait for. But the TRUTH
  // is gated on the mutation: "Steered" flashes on SUCCESS only, and on FAILURE the optimistic bubble
  // is rolled back and an error toast explains (previously it flashed "Steered" unconditionally, so a
  // failed send — e.g. a dead session that can't be resumed — lied that it landed, and the phantom
  // bubble sat until a reload silently erased it). The card self-heals: an optimistic exit on a send
  // that failed reappears on the next board delta, since the thread is still needsYou.
  const followUpMutate = followUp.mutate
  const sendMessage = useCallback(
    (text: string) => {
      const m = text.trim()
      if (!m) return
      appendQueuedMessage(qc, slug, m)
      rpc.markRead({ slug }).catch(() => {})
      onSentRef.current?.()
      followUpMutate(m, {
        onSuccess: () => showToast("Steered"),
        onError: (e) => {
          removeQueuedMessage(qc, slug, m)
          showToast(`Send failed: ${(e as Error).message.slice(0, 80)}`)
        },
      })
    },
    [followUpMutate, qc, slug],
  )
  const sendAnswers = useCallback(() => {
    const numbered = liveBlocks
      .map((blk, i) => ({ n: i + 1, a: composeBlockAnswer(blk, answerFor(i)) }))
      .filter(({ a }) => a !== "")
    if (numbered.length === 0) return
    const composed =
      liveBlocks.length === 1 ? numbered[0].a : `Answers:\n${numbered.map(({ n, a }) => `${n}. ${a}`).join("\n")}`
    setAnswers({})
    sendMessage(composed)
  }, [liveBlocks, answerFor, sendMessage])
  const answering = useMemo<MessageAnswering | undefined>(
    () => (answerable ? { answerFor, onChip, onText, onSubmit: sendAnswers } : undefined),
    [answerable, answerFor, onChip, onText, sendAnswers],
  )
  return { liveMsg, answering, answerable, anyAnswered, sendAnswers, sendMessage }
}
