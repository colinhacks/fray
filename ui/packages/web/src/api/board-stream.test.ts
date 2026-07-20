import { test } from "node:test"
import assert from "node:assert/strict"
import type { ServerEvent } from "@fray-ui/shared"
import { BoardStream } from "./board-stream.ts"

test("BoardStream forwards typed-interaction invalidations without treating them as board deltas", () => {
  const seen: ServerEvent[] = []
  let resyncs = 0
  const stream = new BoardStream(() => resyncs++, (event) => seen.push(event))
  const event = {
    type: "interactions-invalidated",
    slug: "owned-thread",
    sessionId: "session-1",
    interactionId: "interaction-1",
    lifecycle: "pending",
    recordRevision: 0,
  } as const satisfies ServerEvent

  stream.handle(event)

  assert.deepEqual(seen, [event])
  assert.equal(resyncs, 0)
})
