import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InteractionRequest, type BoardSnapshot } from "@fray-ui/shared"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

const noopTailer: Tailer = {
  get: () => undefined,
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

function session(): SessionRow {
  return {
    slug: "owned-thread",
    session_id: "owned-session",
    tmux_name: "fray-owned-thread",
    spawned_at: "2026-07-13T12:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 1,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: "Owned thread",
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
  }
}

function interaction(projectId = "project-owned") {
  return InteractionRequest.parse({
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "claude", version: "2.1.207" },
    source: { kind: "agent", id: "agent-1", label: "Claude" },
    owner: {
      projectId,
      threadSlug: "owned-thread",
      sessionId: "owned-session",
      turnId: "turn-1",
      itemId: `item-${projectId}`,
      sessionEpoch: 1,
      capabilityRevision: 4,
    },
    providerRequestId: `request-${projectId}`,
    allowedDecisions: [
      { id: "approve", semantic: "approve", label: "Approve" },
      { id: "deny", semantic: "deny", label: "Deny" },
    ],
    payload: {
      kind: "permission-approval",
      title: "Network permission",
      permission: "network",
      resourceLabel: "api.example.test",
    },
    expiresAt: null,
  })
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "fray-interaction-router-"))
  const project: Project = { dir, id: "project-owned", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(session())
  const snapshot: BoardSnapshot = {
    projectDir: dir,
    projectName: "test",
    projectLabel: "test",
    frayActive: false,
    threads: [],
    errors: [],
    warnings: [],
  }
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => snapshot,
    start: async () => {},
    stop: async () => {},
  }
  const ctx = {
    project,
    storage,
    interactions: storage.interactions,
    board,
    tailer: noopTailer,
  } as AppContext
  return { ctx, storage, router: createRouter(ctx) }
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let failure: unknown
  try {
    await promise
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error, "operation should reject with an Error")
  return failure.message
}

test("interaction RPC reads only the current registered project session", async () => {
  const h = harness()
  const owned = h.storage.interactions.create(interaction()).interaction
  const hostileOtherProject = h.storage.interactions.create(interaction("other-project")).interaction

  const listed = await h.router.pendingInteractions.handler({ input: { slug: "owned-thread", sessionId: "owned-session" } })
  assert.deepEqual(listed.interactions.map((candidate) => candidate.id), [owned.id])
  assert.equal(listed.interactions.some((candidate) => candidate.id === hostileOtherProject.id), false)

  const found = await h.router.interactionGet.handler({
    input: { slug: "owned-thread", sessionId: "owned-session", interactionId: owned.id },
  })
  assert.equal(found.interaction.id, owned.id)
  await assert.rejects(
    h.router.interactionGet.handler({ input: { slug: "owned-thread", sessionId: "owned-session", interactionId: hostileOtherProject.id } }),
    /not available/,
  )
  await assert.rejects(
    h.router.pendingInteractions.handler({ input: { slug: "foreign-thread", sessionId: "foreign-session" } }),
    /not available/,
  )
  await assert.rejects(
    h.router.pendingInteractions.handler({ input: { slug: "owned-thread", sessionId: "replaced-session" } }),
    /not available/,
  )
  h.storage.close()
})

test("interaction creation is not part of the public RPC router", () => {
  const h = harness()
  assert.equal("interactionCreate" in h.router, false)
  assert.equal("createInteraction" in h.router, false)
  h.storage.close()
})

test("persisted provider interactions cannot fall through when their bridge is disabled", async () => {
  const h = harness()
  const pending = h.storage.interactions.createProviderRequest(interaction(), {
    provider: "codex-app-server",
    logicalRequestId: "logical-provider-request",
    method: "item/permissions/requestApproval",
    connectionEpoch: 3,
    rpcRequestId: "provider-rpc-request",
    providerContext: { fingerprint: "a".repeat(64) },
  }).interaction
  const input = {
    slug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
  }
  await assert.rejects(h.router.interactionResolve.handler({ input: {
    ...input,
    responseId: "provider-response",
    decisionId: "approve",
  } }), /provider bridge reconnects/)
  await assert.rejects(h.router.interactionCancel.handler({ input }), /advertised cancel decision/)
  const reconnectRequired = await h.router.pendingInteractions.handler({
    input: { slug: pending.owner.threadSlug, sessionId: pending.owner.sessionId },
  })
  assert.equal(reconnectRequired.interactions[0]?.delivery?.effect, "reconnect-required")
  assert.equal(h.storage.interactions.get({
    projectId: pending.owner.projectId,
    threadSlug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
  }, pending.id)?.lifecycle, "pending")
  h.storage.close()
})

test("scoped reads project durable provider delivery without leaking outbox data", async () => {
  const h = harness()
  const pending = h.storage.interactions.createProviderRequest(interaction(), {
    provider: "codex-app-server",
    logicalRequestId: "logical-projection-request",
    method: "item/permissions/requestApproval",
    connectionEpoch: 9,
    rpcRequestId: "projection-rpc-request",
    providerContext: { fingerprint: "c".repeat(64), hidden: "provider-context-secret" },
  }).interaction
  const scope = {
    projectId: pending.owner.projectId,
    threadSlug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
  }
  const input = {
    slug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
    responseId: "projection-response",
    decisionId: "approve",
  }

  // A configured owner may safely accept the first response into the durable outbox even before a
  // transport is live. The same persisted row is fail-closed when that bridge is absent.
  h.ctx.codexAppServer = {
    ownsInteraction: () => true,
  } as unknown as NonNullable<AppContext["codexAppServer"]>
  assert.equal((await h.router.interactionGet.handler({ input: {
    slug: input.slug,
    sessionId: input.sessionId,
    interactionId: input.interactionId,
  } })).interaction.delivery?.effect, "awaiting-user")
  h.ctx.codexAppServer = undefined
  assert.equal((await h.router.interactionGet.handler({ input: {
    slug: input.slug,
    sessionId: input.sessionId,
    interactionId: input.interactionId,
  } })).interaction.delivery?.effect, "reconnect-required")

  h.storage.interactions.queueProviderResponse(scope, input, {
    decision: "approve",
    hidden: "provider-response-secret",
  })
  const queued = await h.router.pendingInteractions.handler({ input: { slug: input.slug, sessionId: input.sessionId } })
  assert.equal(queued.interactions[0]?.delivery?.effect, "sending")
  assert.equal(JSON.stringify(queued).includes("provider-context-secret"), false)
  assert.equal(JSON.stringify(queued).includes("provider-response-secret"), false)

  h.storage.interactions.claimProviderResponseForSend(pending.id, 9, "projection-rpc-request")
  const sent = await h.router.interactionGet.handler({ input: {
    slug: input.slug,
    sessionId: input.sessionId,
    interactionId: input.interactionId,
  } })
  assert.equal(sent.interaction.delivery?.effect, "sending", "ambiguous send remains noninteractive")

  h.storage.interactions.acknowledgeProviderResponse(
    "codex-app-server",
    9,
    "projection-rpc-request",
    scope,
  )
  assert.deepEqual(
    (await h.router.pendingInteractions.handler({ input: { slug: input.slug, sessionId: input.sessionId } })).interactions,
    [],
  )
  const terminal = await h.router.interactionGet.handler({ input: {
    slug: input.slug,
    sessionId: input.sessionId,
    interactionId: input.interactionId,
  } })
  assert.equal(terminal.interaction.lifecycle, "resolved")
  assert.equal(terminal.interaction.delivery, undefined)
  h.storage.close()
})

test("provider acknowledgement winning the resolve race returns the terminal journal", async () => {
  const h = harness()
  const pending = h.storage.interactions.createProviderRequest(interaction(), {
    provider: "codex-app-server",
    logicalRequestId: "logical-concurrent-ack",
    method: "item/permissions/requestApproval",
    connectionEpoch: 11,
    rpcRequestId: "concurrent-ack-rpc",
    providerContext: { fingerprint: "d".repeat(64) },
  }).interaction
  const scope = {
    projectId: pending.owner.projectId,
    threadSlug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
  }
  h.ctx.codexAppServer = {
    ownsInteraction: () => true,
    resolveInteraction: async (_scope: typeof scope, input: Parameters<typeof h.storage.interactions.queueProviderResponse>[1]) => {
      const queued = h.storage.interactions.queueProviderResponse(scope, input, { permissions: {}, scope: "turn" })
      h.storage.interactions.claimProviderResponseForSend(pending.id, 11, "concurrent-ack-rpc")
      h.storage.interactions.acknowledgeProviderResponse(
        "codex-app-server",
        11,
        "concurrent-ack-rpc",
        scope,
      )
      return queued
    },
  } as unknown as NonNullable<AppContext["codexAppServer"]>

  const result = await h.router.interactionResolve.handler({ input: {
    slug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
    responseId: "concurrent-ack-response",
    decisionId: "approve",
  } })
  assert.equal(result.effect, "resolved")
  assert.equal(result.interaction.lifecycle, "resolved")
  assert.equal(result.interaction.delivery, undefined)
  assert.deepEqual((await h.router.pendingInteractions.handler({ input: {
    slug: pending.owner.threadSlug,
    sessionId: pending.owner.sessionId,
  } })).interactions, [])
  h.storage.close()
})

test("foreign interaction ids are indistinguishable from absent ids on terminal RPCs", async () => {
  const h = harness()
  const hostileOtherProject = h.storage.interactions.create(interaction("other-project")).interaction
  const base = {
    slug: "owned-thread",
    sessionId: "owned-session",
    sessionEpoch: 1,
    capabilityRevision: 4,
    expectedRecordRevision: 0,
  }

  const foreignResolve = await rejectionMessage(h.router.interactionResolve.handler({ input: {
    ...base,
    interactionId: hostileOtherProject.id,
    responseId: "foreign-response",
    decisionId: "approve",
  } }))
  const absentResolve = await rejectionMessage(h.router.interactionResolve.handler({ input: {
    ...base,
    interactionId: "absent-interaction",
    responseId: "absent-response",
    decisionId: "approve",
  } }))
  assert.equal(foreignResolve, absentResolve)

  const foreignCancel = await rejectionMessage(h.router.interactionCancel.handler({ input: {
    ...base,
    interactionId: hostileOtherProject.id,
  } }))
  const absentCancel = await rejectionMessage(h.router.interactionCancel.handler({ input: {
    ...base,
    interactionId: "absent-interaction",
  } }))
  assert.equal(foreignCancel, absentCancel)
  assert.equal(
    h.storage.interactions.get({ projectId: "other-project", threadSlug: "owned-thread", sessionId: "owned-session" }, hostileOtherProject.id)?.lifecycle,
    "pending",
  )
  h.storage.close()
})

test("interaction RPC resolution validates advertised decisions and returns only journal-safe state", async () => {
  const h = harness()
  const pending = h.storage.interactions.create(interaction()).interaction
  const base = {
    slug: "owned-thread",
    sessionId: "owned-session",
    interactionId: pending.id,
    sessionEpoch: 1,
    capabilityRevision: 4,
    expectedRecordRevision: 0,
    responseId: "browser-response-1",
    decisionId: "approve",
  }
  await assert.rejects(
    h.router.interactionResolve.handler({ input: { ...base, decisionId: "unadvertised" } }),
    /not advertised/,
  )
  await assert.rejects(
    h.router.interactionResolve.handler({ input: { ...base, sessionId: "old-session" } }),
    /not available/,
  )

  const resolved = await h.router.interactionResolve.handler({ input: base })
  assert.equal(resolved.effect, "resolved")
  assert.equal(resolved.interaction.lifecycle, "resolved")
  assert.equal(resolved.interaction.resolution?.decisionId, "approve")
  assert.equal((resolved.interaction.resolution as unknown as { values?: unknown }).values, undefined)
  assert.equal((await h.router.interactionResolve.handler({ input: base })).effect, "already-resolved")
  h.storage.close()
})

test("interaction RPC cancellation is scoped, CAS-bound, and idempotent", async () => {
  const h = harness()
  const pending = h.storage.interactions.create(interaction()).interaction
  const input = {
    slug: "owned-thread",
    sessionId: "owned-session",
    interactionId: pending.id,
    sessionEpoch: 1,
    capabilityRevision: 4,
    expectedRecordRevision: 0,
  }
  const cancelled = await h.router.interactionCancel.handler({ input })
  assert.equal(cancelled.effect, "cancelled")
  assert.equal(cancelled.interaction.cancellationReason, "user-cancelled")
  assert.equal((await h.router.interactionCancel.handler({ input })).effect, "already-cancelled")
  h.storage.close()
})
