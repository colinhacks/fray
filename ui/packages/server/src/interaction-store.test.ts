import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import {
  INTERACTION_REQUEST_MAX_BYTES,
  InteractionRequest,
  ServerEvent,
  type InteractionPayload,
  type InteractionRecord,
  type InteractionRequest as InteractionRequestType,
} from "@fray-ui/shared"
import {
  INTERACTION_DB_SCHEMA_VERSION,
  InteractionStoreError,
  createInteractionStore,
  serializeInteractionDiagnostic,
  type InteractionSessionScope,
} from "./interaction-store.ts"
import { createStorage, type SessionRow } from "./storage.ts"

const T0 = "2026-07-13T12:00:00.000Z"

function decisions(kind: InteractionPayload["kind"]) {
  if (kind === "command-approval" || kind === "file-approval" || kind === "permission-approval") {
    return [
      { id: "approve-once", semantic: "approve" as const, label: "Approve once" },
      { id: "deny", semantic: "deny" as const, label: "Deny" },
      { id: "cancel", semantic: "cancel" as const, label: "Cancel" },
    ]
  }
  if (kind === "agent-question") {
    return [
      { id: "answer", semantic: "answer" as const, label: "Answer" },
      { id: "decline", semantic: "decline" as const, label: "Decline" },
      { id: "cancel", semantic: "cancel" as const, label: "Cancel" },
    ]
  }
  return [
    { id: "accept", semantic: "accept" as const, label: "Accept" },
    { id: "decline", semantic: "decline" as const, label: "Decline" },
    { id: "cancel", semantic: "cancel" as const, label: "Cancel" },
  ]
}

function request(
  payload: InteractionPayload = {
    kind: "command-approval",
    title: "Command approval",
    command: { summary: "Run tests", preview: "pnpm test --filter safe", redacted: true },
  },
  over: Partial<InteractionRequestType> = {},
): InteractionRequestType {
  return InteractionRequest.parse({
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex", version: "0.144.1" },
    source: { kind: "runtime", id: "runtime-1", label: "Codex" },
    owner: {
      projectId: "project-1",
      threadSlug: "thread-1",
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      sessionEpoch: 3,
      capabilityRevision: 7,
    },
    providerRequestId: "provider-request-1",
    allowedDecisions: decisions(payload.kind),
    payload,
    expiresAt: null,
    ...over,
  })
}

function scope(record: InteractionRecord): InteractionSessionScope {
  return {
    projectId: record.owner.projectId,
    threadSlug: record.owner.threadSlug,
    sessionId: record.owner.sessionId,
  }
}

function resolutionInput(record: InteractionRecord, over: Record<string, unknown> = {}) {
  return {
    slug: record.owner.threadSlug,
    sessionId: record.owner.sessionId,
    interactionId: record.id,
    sessionEpoch: record.owner.sessionEpoch,
    capabilityRevision: record.owner.capabilityRevision,
    expectedRecordRevision: record.recordRevision,
    responseId: `response-${record.id}`,
    decisionId: record.allowedDecisions[0].id,
    ...over,
  }
}

function cancelInput(record: InteractionRecord, over: Record<string, unknown> = {}) {
  return {
    slug: record.owner.threadSlug,
    sessionId: record.owner.sessionId,
    interactionId: record.id,
    sessionEpoch: record.owner.sessionEpoch,
    capabilityRevision: record.owner.capabilityRevision,
    expectedRecordRevision: record.recordRevision,
    ...over,
  }
}

function providerBinding(over: Record<string, unknown> = {}) {
  return {
    provider: "codex-app-server",
    logicalRequestId: "logical-request-1",
    method: "item/commandExecution/requestApproval",
    connectionEpoch: 1,
    rpcRequestId: "rpc-request-1",
    providerContext: { fingerprint: "a".repeat(64) },
    ...over,
  }
}

function dbHarness() {
  const path = join(mkdtempSync(join(tmpdir(), "fray-interactions-")), "ui.db")
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  let current = new Date(T0)
  let ids = 0
  const store = createInteractionStore(db, { now: () => current, id: () => `interaction-${++ids}` })
  return {
    path,
    db,
    store,
    setNow(value: string) { current = new Date(value) },
    close() { store.dispose(); db.close() },
  }
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof InteractionStoreError && error.code === code)
}

test("shared protocol covers approvals, MCP form/URL elicitation, and agent questions with strict safe metadata", () => {
  const payloads: InteractionPayload[] = [
    {
      kind: "command-approval",
      title: "Command",
      command: {
        summary: "Build",
        preview: "pnpm build",
        redacted: true,
        workingDirectoryLabel: "/workspace",
        actions: [{ kind: "read", commandPreview: "cat package.json", resourceLabel: "package.json" }],
      },
      capabilities: [{ kind: "network", enabled: true, hosts: ["https: registry.example.test"] }],
    },
    {
      kind: "file-approval",
      title: "File",
      operation: "write",
      pathLabel: "src/a.ts",
      diffPreview: "- old\n+ new",
      changes: [{ operation: "move", pathLabel: "src/a.ts", destinationLabel: "src/b.ts", diffPreview: "- old\n+ new" }],
    },
    {
      kind: "permission-approval",
      title: "Permission",
      permission: "network+filesystem",
      resourceLabel: "api.example.test",
      workingDirectoryLabel: "/workspace",
      scopeLabel: "Turn or session",
      capabilities: [
        { kind: "filesystem", access: "write", resources: ["/workspace"] },
        { kind: "glob-scan", depth: 0 },
      ],
    },
    {
      kind: "mcp-elicitation-form",
      title: "MCP form",
      message: "Choose a repository",
      protocolVersion: "2025-11-25",
      fields: [{ id: "repo", label: "Repository", input: "text", required: true, secret: false }],
    },
    {
      kind: "mcp-elicitation-url",
      title: "MCP URL",
      message: "Authorize at the server",
      protocolVersion: "2025-11-25",
      elicitationId: "elicit-1",
      url: "https://mcp.example.test/authorize?state=opaque",
    },
    {
      kind: "agent-question",
      title: "Question",
      fields: [{ id: "choice", label: "Choose", input: "select", required: true, secret: false, options: [{ value: "a", label: "A" }] }],
    },
  ]
  for (const [index, payload] of payloads.entries()) {
    assert.equal(request(payload, { providerRequestId: `request-${index}` }).payload.kind, payload.kind)
  }

  const base = request()
  assert.equal(InteractionRequest.safeParse({
    ...base,
    payload: { ...base.payload, markdown: "<script>not a protocol field</script>" },
  }).success, false, "unknown markup-bearing fields are rejected rather than stored")
  assert.equal(InteractionRequest.safeParse({
    ...base,
    allowedDecisions: [{ id: "accept", semantic: "accept", label: "Wrong semantic" }],
  }).success, false)
  assert.equal(InteractionRequest.safeParse({
    ...base,
    payload: { ...base.payload, title: "safe\u202Espoofed" },
  }).success, false, "bidirectional override controls are rejected")
  for (const id of ["__proto__", "constructor", "prototype"]) {
    const question = {
      kind: "agent-question" as const,
      title: "Prototype pollution",
      fields: [{ id, label: "Unsafe key", input: "text" as const, required: false, secret: false }],
    }
    assert.equal(InteractionRequest.safeParse({
      ...base,
      payload: question,
      allowedDecisions: decisions(question.kind),
    }).success, false, `${id} is never accepted as a response field id`)
  }
  const duplicateFields = {
    kind: "agent-question" as const,
    title: "Duplicate fields",
    fields: [
      { id: "answer", label: "First", input: "text" as const, required: false, secret: false },
      { id: "answer", label: "Second", input: "text" as const, required: false, secret: false },
    ],
  }
  assert.equal(InteractionRequest.safeParse({
    ...base,
    payload: duplicateFields,
    allowedDecisions: decisions(duplicateFields.kind),
  }).success, false, "duplicate field ids cannot create duplicate form controls")
  assert.equal(InteractionRequest.safeParse({
    ...base,
    allowedDecisions: [
      { id: "accept", semantic: "approve", label: "First" },
      { id: "accept", semantic: "approve", label: "Second" },
    ],
  }).success, false, "duplicate decision ids cannot create ambiguous actions")
  assert.equal(InteractionRequest.safeParse({
    ...base,
    payload: {
      kind: "command-approval",
      title: "Too many lines",
      command: { summary: "Bounded", preview: Array.from({ length: 257 }, () => "line").join("\n"), redacted: true },
    },
  }).success, false, "approval previews have a strict line cap")
  assert.equal(InteractionRequest.safeParse({
    ...base,
    payload: {
      kind: "file-approval",
      title: "Too many changes",
      operation: "write",
      pathLabel: "workspace",
      changes: Array.from({ length: 17 }, (_, index) => ({ operation: "write", pathLabel: `file-${index}` })),
    },
  }).success, false, "approval change aggregates are capped")

  assert.equal(ServerEvent.safeParse({
    type: "interactions-invalidated",
    slug: "thread-1",
    sessionId: "session-1",
    interactionId: "interaction-1",
    lifecycle: "pending",
    recordRevision: 0,
    payload: { command: "secret raw provider payload" },
  }).success, false, "global invalidations reject provider payloads instead of carrying them over SSE")
})

test("MCP form rejects secrets while URL mode enforces explicit secure navigation metadata", () => {
  const secretForm = {
    kind: "mcp-elicitation-form" as const,
    title: "Credentials",
    message: "Enter a token",
    protocolVersion: "2025-11-25",
    fields: [{ id: "token", label: "Token", input: "text" as const, required: true, secret: true }],
  }
  assert.equal(InteractionRequest.safeParse({
    ...request(),
    payload: secretForm,
    allowedDecisions: decisions(secretForm.kind),
  }).success, false)

  const urlPayload = {
    kind: "mcp-elicitation-url" as const,
    title: "Authorize",
    message: "Open the provider",
    protocolVersion: "2025-11-25",
    elicitationId: "url-1",
  }
  for (const url of ["http://evil.example.test/auth", "https://user:password@example.test/auth", "file:///tmp/secret"]) {
    assert.equal(InteractionRequest.safeParse({
      ...request(),
      payload: { ...urlPayload, url },
      allowedDecisions: decisions(urlPayload.kind),
    }).success, false, url)
  }
  assert.equal(request({ ...urlPayload, url: "http://localhost:4917/dev" }).payload.kind, "mcp-elicitation-url")
  assert.equal(request({ ...urlPayload, url: "http://[::1]:4917/dev" }).payload.kind, "mcp-elicitation-url")
})

test("atomic create deduplicates identical provider requests and rejects conflicting reuse", () => {
  const h = dbHarness()
  const changes: string[] = []
  h.store.subscribe((change) => changes.push(`${change.interactionId}:${change.lifecycle}`))
  const first = h.store.create(request())
  const duplicate = h.store.create(request())
  assert.equal(first.effect, "created")
  assert.equal(duplicate.effect, "deduplicated")
  assert.equal(duplicate.interaction.id, first.interaction.id)
  assert.deepEqual(changes, [`${first.interaction.id}:pending`], "dedupe is not a second transition")

  const changed = request({
    kind: "command-approval",
    title: "Changed command",
    command: { summary: "Changed", preview: "pnpm changed", redacted: true },
  })
  expectCode(() => h.store.create(changed), "provider-id-conflict")

  const otherSession = request(undefined, {
    owner: { ...request().owner, sessionId: "session-2", turnId: "turn-2", itemId: "item-2" },
  })
  assert.equal(h.store.create(otherSession).effect, "created", "provider ids are scoped to their session")
  h.close()
})

test("provider outbox canonicalizes JSON and scopes delivery ownership before disclosure", () => {
  const h = dbHarness()
  const first = h.store.createProviderRequest(request(), providerBinding({
    providerContext: { fingerprint: "a".repeat(64), nested: { first: 1, second: 2 } },
  }))
  const created = first.interaction
  const duplicate = h.store.createProviderRequest(request(), providerBinding({
    providerContext: { nested: { second: 2, first: 1 }, fingerprint: "a".repeat(64) },
  }))
  assert.equal(duplicate.effect, "deduplicated")
  const input = resolutionInput(created, { responseId: "provider-response-1" })
  assert.equal(h.store.queueProviderResponse(scope(created), input, {
    decision: "accept",
    metadata: { first: 1, second: 2 },
  }).effect, "queued")
  assert.equal(h.store.queueProviderResponse(scope(created), input, {
    metadata: { second: 2, first: 1 },
    decision: "accept",
  }).effect, "already-queued")
  assert.equal(h.store.providerDelivery({ ...scope(created), projectId: "other-project" }, created.id), undefined)
  assert.equal(h.store.providerDelivery(scope(created), created.id)?.state, "queued")
  h.close()
})

test("delivery-only queue, send, and witnessed rebind transitions invalidate scoped readers", () => {
  const h = dbHarness()
  const created = h.store.createProviderRequest(request(), providerBinding()).interaction
  const states: string[] = []
  h.store.subscribe((change) => {
    if (change.interactionId !== created.id) return
    states.push(h.store.providerDelivery(scope(created), created.id)?.state ?? "missing")
  })

  h.store.queueProviderResponse(scope(created), resolutionInput(created), { decision: "accept" })
  h.store.claimProviderResponseForSend(created.id, 1, "rpc-request-1")
  h.store.createProviderRequest(request(), providerBinding({
    connectionEpoch: 2,
    rpcRequestId: "rpc-request-2",
  }))

  assert.deepEqual(states, ["queued", "sent", "queued"])
  assert.equal(h.store.providerDelivery(scope(created), created.id)?.responseId, `response-${created.id}`)
  h.close()
})

test("session cancellation and expiry terminalize provider deliveries atomically", () => {
  const h = dbHarness()
  const makeProvider = (suffix: string) => h.store.createProviderRequest(
    request(undefined, {
      providerRequestId: `provider-request-${suffix}`,
      owner: { ...request().owner, itemId: `item-${suffix}` },
    }),
    providerBinding({
      logicalRequestId: `logical-${suffix}`,
      rpcRequestId: `rpc-${suffix}`,
    }),
  ).interaction
  const awaiting = makeProvider("awaiting")
  const queued = makeProvider("queued")
  const sent = makeProvider("sent")
  h.store.queueProviderResponse(scope(queued), resolutionInput(queued), { decision: "accept" })
  h.store.queueProviderResponse(scope(sent), resolutionInput(sent), { decision: "accept" })
  h.store.claimProviderResponseForSend(sent.id, 1, "rpc-sent")

  const cancelled = h.store.cancelForSession("thread-1", "session-1", "session-replaced")
  assert.deepEqual(cancelled.map((record) => record.id).sort(), [awaiting.id, queued.id, sent.id].sort())
  for (const record of [awaiting, queued, sent]) {
    assert.equal(h.store.get(scope(record), record.id)?.lifecycle, "cancelled")
    assert.equal(h.store.providerDelivery(scope(record), record.id)?.state, "cancelled")
  }
  assert.equal(h.store.listQueuedProviderResponses("codex-app-server", 1).length, 0)
  assert.equal(
    h.store.acknowledgeProviderResponse("codex-app-server", 1, "rpc-sent", scope(sent))?.effect,
    "already-terminal",
  )

  const expiring = h.store.createProviderRequest(request(undefined, {
    providerRequestId: "provider-expiring",
    owner: { ...request().owner, sessionId: "session-2", itemId: "item-expiring" },
    expiresAt: "2026-07-13T12:01:00.000Z",
  }), providerBinding({ logicalRequestId: "logical-expiring", rpcRequestId: "rpc-expiring" })).interaction
  h.setNow("2026-07-13T12:02:00.000Z")
  assert.deepEqual(h.store.expireDue().map((record) => record.id), [expiring.id])
  assert.equal(h.store.providerDelivery(scope(expiring), expiring.id)?.state, "cancelled")
  h.close()
})

test("exact provider invalidation atomically cancels awaiting and in-flight authority", () => {
  const h = dbHarness()
  const awaiting = h.store.createProviderRequest(request(), providerBinding()).interaction
  const cancelled = h.store.invalidateProviderRequest(scope(awaiting), awaiting.id, "provider-cancelled")
  assert.equal(cancelled.effect, "cancelled")
  assert.equal(cancelled.interaction.lifecycle, "cancelled")
  assert.equal(cancelled.interaction.cancellationReason, "provider-cancelled")
  assert.equal(cancelled.delivery.state, "cancelled")
  assert.equal(h.store.invalidateProviderRequest(scope(awaiting), awaiting.id, "provider-cancelled").effect, "already-terminal")

  const queued = h.store.createProviderRequest(request(undefined, {
    providerRequestId: "provider-request-in-flight",
    owner: { ...request().owner, itemId: "item-in-flight" },
  }), providerBinding({ logicalRequestId: "logical-in-flight", rpcRequestId: "rpc-in-flight" })).interaction
  h.store.queueProviderResponse(scope(queued), resolutionInput(queued), { decision: "accept" })
  const inFlight = h.store.invalidateProviderRequest(scope(queued), queued.id, "turn-ended")
  assert.equal(inFlight.effect, "response-in-flight")
  assert.equal(inFlight.interaction.lifecycle, "cancelled")
  assert.equal(inFlight.interaction.cancellationReason, "turn-ended")
  assert.equal(inFlight.delivery.state, "cancelled")
  assert.throws(
    () => h.store.invalidateProviderRequest({ ...scope(queued), sessionId: "wrong-session" }, queued.id, "turn-ended"),
    (error: unknown) => error instanceof InteractionStoreError && error.code === "not-found",
  )
  h.close()
})

test("provider delivery decoding rejects partial or contradictory durable state", () => {
  const h = dbHarness()
  const created = h.store.createProviderRequest(request(), providerBinding()).interaction
  h.db.prepare(`
    UPDATE interaction_provider_delivery SET state = 'sent', attempts = 1, sent_at = ?
    WHERE interaction_id = ?
  `).run(T0, created.id)
  expectCode(() => h.store.providerDelivery(scope(created), created.id), "corrupt-journal")
  h.close()
})

test("provider RPC ids and send claims remain single-owner across SQLite connections", () => {
  const h = dbHarness()
  const secondDb = new Database(h.path)
  secondDb.pragma("journal_mode = WAL")
  const second = createInteractionStore(secondDb)
  const first = h.store.createProviderRequest(request(), providerBinding()).interaction
  const collidingRequest = request(undefined, {
    providerRequestId: "provider-request-collision",
    owner: { ...request().owner, itemId: "item-collision" },
  })
  expectCode(() => second.createProviderRequest(collidingRequest, providerBinding({
    logicalRequestId: "logical-collision",
  })), "provider-id-conflict")
  assert.equal(h.db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM interaction_journal").get()?.count, 1)

  h.store.queueProviderResponse(scope(first), resolutionInput(first), { decision: "accept" })
  assert.equal(h.store.claimProviderResponseForSend(first.id, 1, "rpc-request-1").state, "sent")
  expectCode(() => second.claimProviderResponseForSend(first.id, 1, "rpc-request-1"), "not-pending")
  second.dispose()
  secondDb.close()
  h.close()
})

test("generated interaction id collisions never masquerade as successful creates", () => {
  const path = join(mkdtempSync(join(tmpdir(), "fray-interaction-id-collision-")), "ui.db")
  const db = new Database(path)
  const store = createInteractionStore(db, { now: () => new Date(T0), id: () => "fixed-interaction-id" })
  const changes: string[] = []
  store.subscribe((change) => changes.push(`${change.interactionId}:${change.lifecycle}`))
  const first = store.create(request()).interaction
  const second = request(undefined, {
    providerRequestId: "provider-request-2",
    owner: { ...request().owner, itemId: "item-2" },
  })
  expectCode(() => store.create(second), "id-conflict")
  assert.equal(db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM interaction_journal").get()?.count, 1)
  assert.equal(store.get(scope(first), first.id)?.providerRequestId, "provider-request-1")
  assert.deepEqual(changes, [`${first.id}:pending`], "a collided create never emits another interaction")
  store.dispose()
  db.close()
})

test("resolve is CAS-safe and idempotent exactly once across two SQLite connections", () => {
  const h = dbHarness()
  const secondDb = new Database(h.path)
  secondDb.pragma("journal_mode = WAL")
  const second = createInteractionStore(secondDb, { now: () => new Date(T0), id: () => "unused-id" })
  const created = h.store.create(request()).interaction
  const firstInput = resolutionInput(created, { responseId: "response-winner" })
  const losingInput = resolutionInput(created, { responseId: "response-loser", decisionId: "deny" })

  assert.equal(h.store.resolve(scope(created), firstInput).effect, "resolved")
  expectCode(() => second.resolve(scope(created), losingInput), "response-id-conflict")
  const replay = second.resolve(scope(created), firstInput)
  assert.equal(replay.effect, "already-resolved")
  assert.equal(replay.interaction.recordRevision, 1)
  assert.equal(replay.interaction.resolution?.decisionId, "approve-once")

  second.dispose()
  secondDb.close()
  h.close()
})

test("idempotent response replay is independent of response field insertion order", () => {
  const h = dbHarness()
  const prompt = request({
    kind: "agent-question",
    title: "Two answers",
    fields: [
      { id: "first", label: "First", input: "text", required: true, secret: false },
      { id: "second", label: "Second", input: "text", required: true, secret: false },
    ],
  })
  const created = h.store.create(prompt).interaction
  const input = resolutionInput(created, {
    responseId: "stable-response-id",
    decisionId: "answer",
    values: { first: "one", second: "two" },
  })
  assert.equal(h.store.resolve(scope(created), input).effect, "resolved")
  assert.equal(h.store.resolve(scope(created), {
    ...input,
    values: { second: "two", first: "one" },
  }).effect, "already-resolved")
  h.close()
})

test("resolve rejects invalid decisions, unexpected values, stale epochs/capabilities, and stale revisions", () => {
  const h = dbHarness()
  const created = h.store.create(request()).interaction
  expectCode(() => h.store.resolve(scope(created), resolutionInput(created, { decisionId: "not-advertised" })), "invalid-decision")
  expectCode(() => h.store.resolve(scope(created), resolutionInput(created, { values: { extra: "no" } })), "invalid-response")
  expectCode(() => h.store.resolve(scope(created), resolutionInput(created, { sessionEpoch: 2 })), "stale-session")
  expectCode(() => h.store.resolve(scope(created), resolutionInput(created, { capabilityRevision: 8 })), "stale-capability")
  expectCode(() => h.store.resolve(scope(created), resolutionInput(created, { expectedRecordRevision: 1 })), "stale-revision")
  assert.equal(h.store.get(scope(created), created.id)?.lifecycle, "pending")
  h.close()
})

test("field validation rejects non-canonical date-times", () => {
  const h = dbHarness()
  const prompt = request({
    kind: "agent-question",
    title: "Schedule",
    fields: [{
      id: "when",
      label: "When",
      input: "text",
      format: "date-time",
      required: true,
      secret: false,
    }],
  })
  const created = h.store.create(prompt).interaction
  expectCode(() => h.store.resolve(scope(created), resolutionInput(created, {
    decisionId: "answer",
    values: { when: "2026-02-30T12:00:00Z" },
  })), "invalid-response")
  h.close()
})

test("response ids cannot be reused across interactions", () => {
  const h = dbHarness()
  const first = h.store.create(request()).interaction
  const secondRequest = request(undefined, { providerRequestId: "provider-request-2", owner: { ...request().owner, itemId: "item-2" } })
  const second = h.store.create(secondRequest).interaction
  h.store.resolve(scope(first), resolutionInput(first, { responseId: "one-response-id" }))
  expectCode(() => h.store.resolve(scope(second), resolutionInput(second, { responseId: "one-response-id" })), "response-id-conflict")
  h.close()
})

test("pending interactions recover after restart and expired interactions transition durably", () => {
  const h = dbHarness()
  const pending = h.store.create(request(undefined, { providerRequestId: "restart-request" })).interaction
  h.close()

  const reopenedDb = new Database(h.path)
  let current = new Date(T0)
  const reopened = createInteractionStore(reopenedDb, { now: () => current })
  assert.deepEqual(reopened.listPending(scope(pending)).map((record) => record.id), [pending.id])

  const expiring = reopened.create(request(undefined, {
    providerRequestId: "expiring-request",
    owner: { ...request().owner, itemId: "expiring-item" },
    expiresAt: "2026-07-13T12:01:00.000Z",
  })).interaction
  current = new Date("2026-07-13T12:02:00.000Z")
  assert.deepEqual(reopened.listPending(scope(expiring)).map((record) => record.id), [pending.id])
  const expired = reopened.get(scope(expiring), expiring.id)!
  assert.equal(expired.lifecycle, "expired")
  assert.equal(expired.cancellationReason, "expired")
  assert.equal(expired.recordRevision, 1)
  expectCode(() => reopened.resolve(scope(expiring), resolutionInput(expiring)), "expired")

  reopened.dispose()
  reopenedDb.close()
})

test("creating a new interaction expires due rows before enforcing pending capacity", () => {
  const h = dbHarness()
  const expiring = h.store.create(request(undefined, {
    providerRequestId: "expiring-before-create",
    expiresAt: "2026-07-13T12:01:00.000Z",
  })).interaction
  const changes: string[] = []
  h.store.subscribe((change) => changes.push(`${change.interactionId}:${change.lifecycle}`))
  h.setNow("2026-07-13T12:02:00.000Z")
  const next = h.store.create(request(undefined, {
    providerRequestId: "created-after-expiry",
    owner: { ...request().owner, itemId: "item-after-expiry" },
  })).interaction
  assert.equal(h.store.get(scope(expiring), expiring.id)?.lifecycle, "expired")
  assert.deepEqual(changes, [`${expiring.id}:expired`, `${next.id}:pending`])
  h.close()
})

test("secret question answers are validated transiently and never persisted or echoed", () => {
  const h = dbHarness()
  const secretValue = "super-secret-token-value"
  const prompt = request({
    kind: "agent-question",
    title: "Credentials and region",
    fields: [
      { id: "token", label: "Token", input: "text", required: true, secret: true },
      { id: "region", label: "Region", input: "select", required: true, secret: false, options: [{ value: "us-west", label: "US West" }] },
    ],
  })
  const created = h.store.create(prompt).interaction
  const result = h.store.resolve(scope(created), resolutionInput(created, {
    decisionId: "answer",
    values: { token: secretValue, region: "us-west" },
  }))
  assert.equal(result.interaction.resolution?.values?.region, "us-west")
  assert.equal(result.interaction.resolution?.values?.token, undefined)
  assert.deepEqual(result.interaction.resolution?.redactedFieldIds, ["token"])

  const raw = h.db.prepare<[string], { request_json: string; response_json: string }>(
    "SELECT request_json, response_json FROM interaction_journal WHERE id = ?",
  ).get(created.id)!
  assert.equal(raw.request_json.includes(secretValue), false)
  assert.equal(raw.response_json.includes(secretValue), false)
  assert.equal(JSON.stringify(result).includes(secretValue), false)
  const diagnostic = serializeInteractionDiagnostic(result.interaction)
  assert.equal(diagnostic.includes(secretValue), false)
  assert.equal(diagnostic.includes("us-west"), false, "diagnostics omit even non-secret response values")
  assert.ok(Buffer.byteLength(diagnostic, "utf8") <= 2_048)
  assert.doesNotThrow(() => JSON.parse(diagnostic), "bounded diagnostics remain valid JSON")
  h.close()
})

test("diagnostics never include provider-controlled identifiers, labels, prompts, or decisions", () => {
  const h = dbHarness()
  const secrets = [
    "secret-provider-name",
    "secret-provider-version",
    "secret-source-id",
    "secret-source-label",
    "secret-project-id",
    "secret-thread-slug",
    "secret-session-id",
    "secret-turn-id",
    "secret-item-id",
    "secret-provider-request-id",
    "secret-prompt-title",
    "secret-command-summary",
    "secret-command-preview",
    "secret-decision-id",
    "secret-decision-label",
  ]
  const hostileMetadata = request({
    kind: "command-approval",
    title: secrets[10],
    command: { summary: secrets[11], preview: secrets[12], redacted: true },
  }, {
    provider: { kind: "codex", name: secrets[0], version: secrets[1] },
    source: { kind: "runtime", id: secrets[2], label: secrets[3] },
    owner: {
      projectId: secrets[4],
      threadSlug: secrets[5],
      sessionId: secrets[6],
      turnId: secrets[7],
      itemId: secrets[8],
      sessionEpoch: 3,
      capabilityRevision: 7,
    },
    providerRequestId: secrets[9],
    allowedDecisions: [{ id: secrets[13], semantic: "approve", label: secrets[14] }],
  })
  const created = h.store.create(hostileMetadata).interaction
  const result = h.store.resolve(scope(created), resolutionInput(created, {
    decisionId: secrets[13],
    responseId: "server-safe-response-id",
  }))
  const diagnostic = serializeInteractionDiagnostic(result.interaction)
  for (const secret of secrets) assert.equal(diagnostic.includes(secret), false, secret)
  const parsed = JSON.parse(diagnostic) as Record<string, unknown>
  for (const key of ["projectId", "threadSlug", "sessionId", "turnId", "itemId", "decisionId"]) {
    assert.equal(Object.hasOwn(parsed, key), false, `${key} is provider-controlled and must not be logged`)
  }
  h.close()
})

test("hostile huge/unicode metadata is byte-capped while ordinary international text remains valid", () => {
  const good = request({
    kind: "command-approval",
    title: "許可を確認 🔒",
    command: { summary: "テストを実行", preview: "printf '安全'", redacted: true },
  })
  assert.equal(good.payload.title, "許可を確認 🔒")

  const hugePreview = "😀".repeat(7_000) // 14k UTF-16 chars, but 28k UTF-8 bytes.
  assert.equal(InteractionRequest.safeParse({
    ...good,
    payload: {
      kind: "command-approval",
      title: "Huge preview",
      command: { summary: "Bound me", preview: hugePreview, redacted: true },
    },
  }).success, false)

  const hugeFields = Array.from({ length: 32 }, (_, index) => ({
    id: `field-${index}`,
    label: `Field ${index}`,
    description: "界".repeat(2_500),
    input: "text" as const,
    required: false,
    secret: false,
  }))
  const payload = { kind: "agent-question" as const, title: "Huge aggregate", fields: hugeFields }
  assert.equal(InteractionRequest.safeParse({
    ...good,
    payload,
    allowedDecisions: decisions(payload.kind),
  }).success, false, "aggregate byte cap prevents many individually-bounded fields from bloating SQLite")
})

test("advertised defaults are themselves valid submit-ready field values", () => {
  const base = request()
  const invalidFields = [
    { id: "short", label: "Short", input: "text" as const, minLength: 3, required: false, secret: false, default: "x" },
    { id: "line", label: "Line", input: "text" as const, required: false, secret: false, default: "one\ntwo" },
    { id: "when", label: "When", input: "text" as const, format: "date-time" as const, required: false, secret: false, default: "2026-02-30T12:00:00Z" },
    {
      id: "many",
      label: "Many",
      input: "multi-select" as const,
      required: false,
      secret: false,
      options: [{ value: "a", label: "A" }],
      default: ["a", "a"],
    },
  ]
  for (const [index, field] of invalidFields.entries()) {
    const payload = { kind: "agent-question" as const, title: "Invalid default", fields: [field] }
    assert.equal(InteractionRequest.safeParse({
      ...base,
      providerRequestId: `invalid-default-${index}`,
      payload,
      allowedDecisions: decisions(payload.kind),
    }).success, false, field.id)
  }
})

test("a request just below the aggregate cap remains readable after lifecycle metadata is added", () => {
  const h = dbHarness()
  const base = request()
  let nearLimit: InteractionRequestType | undefined
  for (let chars = 2_666; chars > 2_400; chars--) {
    const fields = Array.from({ length: 8 }, (_, index) => ({
      id: `field-${index}`,
      label: `Field ${index}`,
      description: "界".repeat(chars),
      input: "text" as const,
      required: false,
      secret: false,
    }))
    const payload = { kind: "agent-question" as const, title: "Near aggregate limit", fields }
    const parsed = InteractionRequest.safeParse({
      ...base,
      providerRequestId: "near-limit-request",
      payload,
      allowedDecisions: decisions(payload.kind),
    })
    if (parsed.success) {
      nearLimit = parsed.data
      break
    }
  }
  assert.ok(nearLimit)
  assert.ok(
    Buffer.byteLength(JSON.stringify(nearLimit), "utf8") > INTERACTION_REQUEST_MAX_BYTES - 512,
    "fixture should exercise the boundary where record metadata previously broke reads",
  )
  const created = h.store.create(nearLimit).interaction
  assert.equal(h.store.get(scope(created), created.id)?.id, created.id)
  h.close()
})

test("redundant journal columns are verified before records cross the store boundary", () => {
  const h = dbHarness()
  const created = h.store.create(request()).interaction
  h.db.prepare("UPDATE interaction_journal SET kind = 'file-approval' WHERE id = ?").run(created.id)
  expectCode(() => h.store.get(scope(created), created.id), "corrupt-journal")
  h.close()
})

test("journal parsing rejects a resolution that names an unadvertised decision", () => {
  const h = dbHarness()
  const created = h.store.create(request()).interaction
  h.store.resolve(scope(created), resolutionInput(created, { responseId: "tamper-target" }))
  const raw = h.db.prepare<[string], { response_json: string }>(
    "SELECT response_json FROM interaction_journal WHERE id = ?",
  ).get(created.id)!
  const resolution = JSON.parse(raw.response_json) as Record<string, unknown>
  resolution.decisionId = "not-advertised"
  h.db.prepare("UPDATE interaction_journal SET response_json = ? WHERE id = ?")
    .run(JSON.stringify(resolution), created.id)
  expectCode(() => h.store.get(scope(created), created.id), "corrupt-journal")
  h.close()
})

test("observers never receive transitions rolled back by an enclosing transaction", async () => {
  const h = dbHarness()
  const created = h.store.create(request()).interaction
  const changes: string[] = []
  h.store.subscribe((change) => changes.push(`${change.interactionId}:${change.lifecycle}:${change.recordRevision}`))

  const rollback = h.db.transaction(() => {
    h.store.cancelForSession(created.owner.threadSlug, created.owner.sessionId, "session-replaced")
    throw new Error("force outer rollback")
  })
  assert.throws(() => rollback(), /force outer rollback/)
  assert.equal(h.store.get(scope(created), created.id)?.lifecycle, "pending")
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(changes, [])

  const commit = h.db.transaction(() => {
    h.store.cancelForSession(created.owner.threadSlug, created.owner.sessionId, "session-replaced")
  })
  commit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(changes, [`${created.id}:cancelled:1`])
  h.close()
})

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "thread-1",
    session_id: "session-1",
    tmux_name: "fray-thread-1",
    spawned_at: T0,
    last_read_at: null,
    unread: 0,
    exited: 1,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: "Thread",
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    ...over,
  }
}

test("session replacement and deletion cancel the old session's pending interactions atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-interaction-session-"))
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(sessionRow())
  const oldScope = { projectId: "project-1", threadSlug: "thread-1", sessionId: "session-1" }
  const replacementTarget = storage.interactions.create(request()).interaction
  storage.upsertSession(sessionRow({ session_id: "session-2" }))
  const replaced = storage.interactions.get(oldScope, replacementTarget.id)!
  assert.equal(replaced.lifecycle, "cancelled")
  assert.equal(replaced.cancellationReason, "session-replaced")

  const currentRequest = request(undefined, {
    providerRequestId: "current-request",
    owner: { ...request().owner, sessionId: "session-2", turnId: "turn-2", itemId: "item-2" },
  })
  const current = storage.interactions.create(currentRequest).interaction
  storage.forgetSession("thread-1")
  const deleted = storage.interactions.get({ ...oldScope, sessionId: "session-2" }, current.id)!
  assert.equal(deleted.lifecycle, "cancelled")
  assert.equal(deleted.cancellationReason, "session-deleted")
  assert.equal(storage.getSession("thread-1"), undefined)
  storage.close()
})

test("interaction schema migration is additive/idempotent and refuses a newer incompatible journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-interaction-migrate-"))
  const path = join(dir, "ui.db")
  const storage = createStorage(path)
  const version = storage.db.prepare<[], { version: number }>(
    "SELECT version FROM interaction_journal_schema WHERE singleton = 1",
  ).get()?.version
  assert.equal(version, INTERACTION_DB_SCHEMA_VERSION)
  storage.close()
  const reopened = createStorage(path)
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM interaction_journal").get() !== undefined, true)
  reopened.close()

  const legacyPath = join(dir, "legacy.db")
  const legacy = new Database(legacyPath)
  legacy.exec("CREATE TABLE interaction_journal_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO interaction_journal_schema VALUES (1, 1)")
  const migrated = createInteractionStore(legacy)
  assert.equal(legacy.prepare<[], { version: number }>(
    "SELECT version FROM interaction_journal_schema WHERE singleton = 1",
  ).get()?.version, INTERACTION_DB_SCHEMA_VERSION)
  assert.ok(legacy.prepare("SELECT provider_context_json FROM interaction_provider_delivery LIMIT 1"))
  migrated.dispose()
  legacy.close()

  const futurePath = join(dir, "future.db")
  const future = new Database(futurePath)
  future.exec(`CREATE TABLE interaction_journal_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO interaction_journal_schema VALUES (1, ${INTERACTION_DB_SCHEMA_VERSION + 1})`)
  expectCode(() => createInteractionStore(future), "schema-version")
  future.close()
})

test("user cancellation is CAS-safe, idempotent, and cannot overwrite a resolution", () => {
  const h = dbHarness()
  const pending = h.store.create(request()).interaction
  const cancelled = h.store.cancel(scope(pending), cancelInput(pending))
  assert.equal(cancelled.effect, "cancelled")
  assert.equal(cancelled.interaction.cancellationReason, "user-cancelled")
  assert.equal(h.store.cancel(scope(pending), cancelInput(pending)).effect, "already-cancelled")
  expectCode(() => h.store.resolve(scope(pending), resolutionInput(pending)), "not-pending")
  expectCode(
    () => h.store.cancelForSession(pending.owner.threadSlug, pending.owner.sessionId, "expired" as never),
    "invalid-response",
  )
  expectCode(() => h.store.expireDue("not-a-timestamp"), "invalid-response")
  h.close()
})
