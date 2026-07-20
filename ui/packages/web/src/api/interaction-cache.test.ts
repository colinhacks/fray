import { test } from "node:test"
import assert from "node:assert/strict"
import { QueryClient } from "@tanstack/react-query"
import type { InteractionRecord } from "@fray-ui/shared"
import {
  failClosedAmbiguousInteraction,
  interactionRecordKey,
  invalidateInteractionQueries,
  pendingInteractionsKey,
  reconcileCachedInteraction,
} from "./interaction-cache.ts"

function interaction(): InteractionRecord {
  return {
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex" },
    source: { kind: "runtime", id: "runtime" },
    owner: {
      projectId: "project",
      threadSlug: "thread",
      sessionId: "session-a",
      turnId: "turn",
      itemId: "item",
      sessionEpoch: 1,
      capabilityRevision: 1,
    },
    providerRequestId: "provider-request",
    allowedDecisions: [{ id: "accept", semantic: "approve", label: "Accept" }],
    payload: {
      kind: "command-approval",
      title: "Command",
      command: { summary: "Test", preview: "pnpm test", redacted: true },
    },
    expiresAt: null,
    id: "request-a",
    lifecycle: "pending",
    recordRevision: 0,
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    completedAt: null,
    resolution: null,
    cancellationReason: null,
  }
}

test("interaction invalidation is exact to one owned session and record", async () => {
  const qc = new QueryClient()
  const ownedList = pendingInteractionsKey("thread", "session-a")
  const foreignList = pendingInteractionsKey("thread", "session-b")
  const ownedRecord = interactionRecordKey("thread", "session-a", "request-a")
  qc.setQueryData(ownedList, { interactions: [] })
  qc.setQueryData(foreignList, { interactions: [] })
  qc.setQueryData(ownedRecord, { interaction: null })

  await invalidateInteractionQueries(qc, {
    type: "interactions-invalidated",
    slug: "thread",
    sessionId: "session-a",
    interactionId: "request-a",
    lifecycle: "resolved",
    recordRevision: 1,
  })

  assert.equal(qc.getQueryState(ownedList)?.isInvalidated, true)
  assert.equal(qc.getQueryState(ownedRecord)?.isInvalidated, true)
  assert.equal(qc.getQueryState(foreignList)?.isInvalidated, false)
})

test("an ambiguous mutation fails every remounted card closed until a scoped read proves retry safe", () => {
  const qc = new QueryClient()
  const pending = interaction()
  const key = pendingInteractionsKey("thread", "session-a")
  qc.setQueryData(key, { interactions: [pending] })

  failClosedAmbiguousInteraction(qc, pending)
  assert.equal(
    qc.getQueryData<{ interactions: InteractionRecord[] }>(key)?.interactions[0]?.delivery?.effect,
    "reconnect-required",
  )

  reconcileCachedInteraction(qc, { ...pending, delivery: { effect: "sending" } })
  assert.equal(
    qc.getQueryData<{ interactions: InteractionRecord[] }>(key)?.interactions[0]?.delivery?.effect,
    "sending",
  )

  reconcileCachedInteraction(qc, pending)
  assert.equal(
    qc.getQueryData<{ interactions: InteractionRecord[] }>(key)?.interactions[0]?.delivery,
    undefined,
    "only a successful read of an awaiting journal row re-enables its original actions",
  )
})
