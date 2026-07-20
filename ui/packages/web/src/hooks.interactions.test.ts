import { test } from "node:test"
import assert from "node:assert/strict"
import type { InteractionRecord, ThreadView } from "@fray-ui/shared"
import { nextInteractionExpiryDelay, ownedInteractionScope, pendingInteractionScope } from "./hooks.ts"

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "owned",
    title: "Owned",
    status: "active",
    hasPlan: false,
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    kind: "session",
    sessionId: "session-a",
    ...over,
  }
}

test("typed-interaction scope exists only for an owned registered session", () => {
  assert.deepEqual(ownedInteractionScope(thread()), { slug: "owned", sessionId: "session-a" })
  assert.equal(ownedInteractionScope(thread({ foreign: true })), undefined)
  assert.equal(ownedInteractionScope(thread({ kind: "legacy", sessionId: undefined })), undefined)
  assert.equal(ownedInteractionScope(undefined), undefined)
})

test("pending interaction queries fan out only for board-confirmed pending sessions", () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, index) => thread({
      id: `unrelated-${index}`,
      sessionId: `session-unrelated-${index}`,
      needsYou: true,
      pendingInteraction: false,
    })),
    thread({ id: "typed", sessionId: "session-typed", needsYou: true, pendingInteraction: true }),
  ]
  assert.deepEqual(rows.flatMap((candidate) => pendingInteractionScope(candidate) ?? []), [
    { slug: "typed", sessionId: "session-typed" },
  ])
})

test("an older board that omits pendingInteraction retains the safe pre-gate query behavior", () => {
  assert.deepEqual(pendingInteractionScope(thread({ pendingInteraction: undefined })), {
    slug: "owned",
    sessionId: "session-a",
  })
  assert.equal(pendingInteractionScope(thread({ pendingInteraction: false })), undefined)
})

test("pending interaction polling wakes once at the earliest advertised expiry", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z")
  const records = [
    { expiresAt: "2026-07-13T12:00:10.000Z" },
    { expiresAt: "2026-07-13T12:00:03.000Z" },
    { expiresAt: null },
  ] as InteractionRecord[]
  assert.equal(nextInteractionExpiryDelay(records, now), 3_050)
  assert.equal(nextInteractionExpiryDelay([{ expiresAt: null }] as InteractionRecord[], now), false)
  assert.equal(nextInteractionExpiryDelay([{ expiresAt: "2026-07-13T11:59:00.000Z" }] as InteractionRecord[], now), 250)
})
