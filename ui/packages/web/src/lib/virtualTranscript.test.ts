import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChatMessage } from "../hooks.ts"
import { buildVirtualTranscriptMessageRows, earlierLoadGate } from "./virtualTranscript.ts"

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    role: "assistant",
    text: "message",
    tools: [],
    sourceId: "message",
    ...over,
  } as ChatMessage
}

test("virtual transcript rows omit queued and empty messages while preserving source keys", () => {
  const rows = buildVirtualTranscriptMessageRows(
    [
      message({ sourceId: "first" }),
      message({ sourceId: "empty", text: "" }),
      message({ sourceId: "queued", queued: true }),
      message({ sourceId: "last" }),
    ],
    (candidate) => candidate.text === "",
    () => false,
    () => false,
    14,
  )
  assert.deepEqual(rows.map(({ key, messageIndex, gap }) => ({ key, messageIndex, gap })), [
    { key: "first", messageIndex: 0, gap: 0 },
    { key: "last", messageIndex: 3, gap: 14 },
  ])
})

test("virtual transcript rows keep the tight rhythm between adjacent meta rows", () => {
  const rows = buildVirtualTranscriptMessageRows(
    [message({ sourceId: "a" }), message({ sourceId: "b" }), message({ sourceId: "c" })],
    () => false,
    (candidate) => candidate.sourceId !== "c",
    (candidate) => candidate.sourceId !== "b",
    14,
  )
  assert.deepEqual(rows.map((row) => row.gap), [0, 6, 14])
})

test("legacy duplicate rows still receive unique render keys", () => {
  const duplicate = message({ sourceId: undefined })
  const rows = buildVirtualTranscriptMessageRows([duplicate, duplicate], () => false, () => false, () => false, 14)
  assert.notEqual(rows[0]?.key, rows[1]?.key)
})

test("earlier-page loading fires once at the top until the reader leaves or explicitly rearms", () => {
  const first = earlierLoadGate({ armed: true, scrollTop: 0, readerMoved: true, hasEarlier: true, loading: false })
  assert.deepEqual(first, { armed: false, shouldLoad: true })
  assert.deepEqual(
    earlierLoadGate({ armed: first.armed, scrollTop: 0, readerMoved: true, hasEarlier: true, loading: false }),
    { armed: false, shouldLoad: false },
  )
  const leftTop = earlierLoadGate({ armed: false, scrollTop: 700, readerMoved: true, hasEarlier: true, loading: false })
  assert.deepEqual(leftTop, { armed: true, shouldLoad: false })
  assert.equal(
    earlierLoadGate({ armed: leftTop.armed, scrollTop: 400, readerMoved: true, hasEarlier: true, loading: false }).shouldLoad,
    true,
  )
})
