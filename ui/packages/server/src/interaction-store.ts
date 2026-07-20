import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import {
  INTERACTION_LIST_MAX,
  CancelInteractionInput,
  InteractionCancellationReason,
  InteractionOpaqueId,
  InteractionRecord,
  InteractionRequest,
  InteractionRevision,
  InteractionResolution,
  InteractionTimestamp,
  ResolveInteractionInput,
  validateInteractionFieldValue,
  type InteractionCancellationReason as InteractionCancellationReasonType,
  type InteractionField,
  type InteractionLifecycle,
  type InteractionRecord as InteractionRecordType,
  type InteractionRequest as InteractionRequestType,
  type InteractionResolution as InteractionResolutionType,
  type InteractionValues,
  type ResolveInteractionInput as ResolveInteractionInputType,
  type CancelInteractionInput as CancelInteractionInputType,
} from "@fray-ui/shared"

export const INTERACTION_DB_SCHEMA_VERSION = 2
const INTERACTION_RECORD_SCHEMA_VERSION = 1
export const INTERACTION_DIAGNOSTIC_MAX_BYTES = 2_048

export type InteractionStoreErrorCode =
  | "not-found"
  | "owner-mismatch"
  | "provider-id-conflict"
  | "id-conflict"
  | "response-id-conflict"
  | "stale-session"
  | "stale-capability"
  | "stale-revision"
  | "invalid-decision"
  | "invalid-response"
  | "not-pending"
  | "expired"
  | "capacity"
  | "corrupt-journal"
  | "schema-version"

export class InteractionStoreError extends Error {
  readonly code: InteractionStoreErrorCode

  constructor(code: InteractionStoreErrorCode, message: string) {
    super(message)
    this.name = "InteractionStoreError"
    this.code = code
  }
}

export interface InteractionSessionScope {
  projectId: string
  threadSlug: string
  sessionId: string
}

export interface InteractionChange extends InteractionSessionScope {
  interactionId: string
  lifecycle: InteractionLifecycle
  recordRevision: number
}

export interface CreateInteractionResult {
  effect: "created" | "deduplicated"
  interaction: InteractionRecordType
}

export interface ResolveStoredInteractionResult {
  effect: "resolved" | "already-resolved"
  interaction: InteractionRecordType
}

export interface CancelStoredInteractionResult {
  effect: "cancelled" | "already-cancelled"
  interaction: InteractionRecordType
}

export type ProviderDeliveryState = "awaiting-user" | "queued" | "sent" | "acknowledged" | "cancelled"

export interface ProviderRequestBinding {
  provider: string
  logicalRequestId: string
  method: string
  connectionEpoch: number
  rpcRequestId: string | number
  // Bounded adapter-owned JSON needed to construct a later protocol response. It is never rendered
  // or logged; adapters should keep it to the minimum authority-bearing provider fields.
  providerContext?: unknown
}

export interface ProviderDelivery {
  interactionId: string
  projectId: string
  provider: string
  logicalRequestId: string
  method: string
  connectionEpoch: number
  rpcRequestId: string | number
  state: ProviderDeliveryState
  responseId: string | null
  providerResponse: unknown | null
  providerContext: unknown | null
  attempts: number
}

export interface CreateProviderInteractionResult extends CreateInteractionResult {
  delivery: ProviderDelivery
}

export interface QueueProviderResponseResult {
  effect: "queued" | "already-queued" | "already-sent"
  interaction: InteractionRecordType
  delivery: ProviderDelivery
}

export interface AcknowledgeProviderResponseResult {
  effect: "resolved" | "cancelled" | "already-terminal"
  interaction: InteractionRecordType
}

export interface InvalidateProviderRequestResult {
  // `response-in-flight` means authority may already have crossed the process pipe. The caller must
  // terminate that exact provider connection after the durable record is cancelled.
  effect: "cancelled" | "already-terminal" | "response-in-flight"
  interaction: InteractionRecordType
  delivery: ProviderDelivery
}

export interface InteractionStore {
  create(request: InteractionRequestType): CreateInteractionResult
  createProviderRequest(request: InteractionRequestType, binding: ProviderRequestBinding): CreateProviderInteractionResult
  get(scope: InteractionSessionScope, interactionId: string): InteractionRecordType | undefined
  listPending(scope: InteractionSessionScope): InteractionRecordType[]
  resolve(scope: InteractionSessionScope, input: ResolveInteractionInputType): ResolveStoredInteractionResult
  providerDelivery(scope: InteractionSessionScope, interactionId: string): ProviderDelivery | undefined
  queueProviderResponse(
    scope: InteractionSessionScope,
    input: ResolveInteractionInputType,
    providerResponse: unknown,
  ): QueueProviderResponseResult
  listQueuedProviderResponses(provider: string, connectionEpoch: number): ProviderDelivery[]
  claimProviderResponseForSend(interactionId: string, connectionEpoch: number, rpcRequestId: string | number): ProviderDelivery
  acknowledgeProviderResponse(
    provider: string,
    connectionEpoch: number,
    rpcRequestId: string | number,
    scope: InteractionSessionScope,
  ): AcknowledgeProviderResponseResult | undefined
  invalidateProviderRequest(
    scope: InteractionSessionScope,
    interactionId: string,
    reason: "provider-cancelled" | "turn-ended",
  ): InvalidateProviderRequestResult
  cancel(scope: InteractionSessionScope, input: CancelInteractionInputType): CancelStoredInteractionResult
  cancelForSession(threadSlug: string, sessionId: string, reason: Exclude<InteractionCancellationReasonType, "expired">): InteractionRecordType[]
  expireDue(at?: string): InteractionRecordType[]
  subscribe(listener: (change: InteractionChange) => void): () => void
  dispose(): void
}

interface InteractionRow {
  id: string
  schema_version: number
  project_id: string
  thread_slug: string
  session_id: string
  session_epoch: number
  capability_revision: number
  provider: string
  provider_request_id: string
  kind: string
  request_json: string
  lifecycle: InteractionLifecycle
  record_revision: number
  response_id: string | null
  response_json: string | null
  cancellation_reason: InteractionCancellationReasonType | null
  created_at: string
  updated_at: string
  expires_at: string | null
  completed_at: string | null
}

interface ProviderDeliveryRow {
  interaction_id: string
  project_id: string
  provider: string
  logical_request_id: string
  request_method: string
  connection_epoch: number
  rpc_request_id_json: string
  state: ProviderDeliveryState
  response_id: string | null
  provider_response_json: string | null
  provider_context_json: string | null
  resolution_json: string | null
  attempts: number
  created_at: string
  updated_at: string
  sent_at: string | null
  acknowledged_at: string | null
}

interface InteractionStoreOptions {
  now?: () => Date
  id?: () => string
}

function iso(now: () => Date): string {
  return now().toISOString()
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new InteractionStoreError("corrupt-journal", "interaction journal contains invalid JSON")
  }
}

function rowToRecord(row: InteractionRow): InteractionRecordType {
  const request = InteractionRequest.safeParse(parseJson(row.request_json))
  if (!request.success) throw new InteractionStoreError("corrupt-journal", "interaction journal request failed validation")
  if (
    row.schema_version !== INTERACTION_RECORD_SCHEMA_VERSION ||
    row.project_id !== request.data.owner.projectId ||
    row.thread_slug !== request.data.owner.threadSlug ||
    row.session_id !== request.data.owner.sessionId ||
    row.session_epoch !== request.data.owner.sessionEpoch ||
    row.capability_revision !== request.data.owner.capabilityRevision ||
    row.provider !== request.data.provider.kind ||
    row.provider_request_id !== request.data.providerRequestId ||
    row.kind !== request.data.payload.kind ||
    row.expires_at !== request.data.expiresAt
  ) {
    throw new InteractionStoreError("corrupt-journal", "interaction journal columns do not match its request")
  }
  let resolution: InteractionResolutionType | null = null
  if (row.response_json !== null) {
    const parsed = InteractionResolution.safeParse(parseJson(row.response_json))
    if (!parsed.success) throw new InteractionStoreError("corrupt-journal", "interaction journal response failed validation")
    resolution = parsed.data
  }
  if (row.response_id !== (resolution?.responseId ?? null)) {
    throw new InteractionStoreError("corrupt-journal", "interaction journal response id does not match its response")
  }
  const record = InteractionRecord.safeParse({
    ...request.data,
    id: row.id,
    lifecycle: row.lifecycle,
    recordRevision: row.record_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    resolution,
    cancellationReason: row.cancellation_reason,
  })
  if (!record.success) throw new InteractionStoreError("corrupt-journal", "interaction journal row failed validation")
  return record.data
}

function rpcRequestIdJson(value: string | number): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new InteractionStoreError("invalid-response", "provider request id must be a non-negative safe integer or string")
  }
  if (typeof value === "string") InteractionOpaqueId.parse(value)
  return JSON.stringify(value)
}

function canonicalJson(value: unknown): string {
  const visiting = new WeakSet<object>()
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new InteractionStoreError("invalid-response", "provider JSON contains a non-finite number")
      return candidate
    }
    if (typeof candidate !== "object") {
      throw new InteractionStoreError("invalid-response", "provider JSON contains a non-JSON value")
    }
    if (visiting.has(candidate)) throw new InteractionStoreError("invalid-response", "provider JSON contains a cycle")
    visiting.add(candidate)
    try {
      if (Array.isArray(candidate)) return candidate.map((item) => item === undefined ? null : normalize(item))
      const object = candidate as Record<string, unknown>
      return Object.fromEntries(Object.keys(object).sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, normalize(object[key])]))
    } finally {
      visiting.delete(candidate)
    }
  }
  return JSON.stringify(normalize(value))
}

function boundedProviderJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionStoreError("invalid-response", "provider response must be a JSON object")
  }
  let encoded: string | undefined
  try {
    encoded = canonicalJson(value)
  } catch {
    throw new InteractionStoreError("invalid-response", "provider response is not JSON serializable")
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 24 * 1024) {
    throw new InteractionStoreError("invalid-response", "provider response exceeds its durable delivery limit")
  }
  return encoded
}

function parseRpcRequestId(raw: string): string | number {
  const parsed = parseJson(raw)
  if (typeof parsed === "string") return InteractionOpaqueId.parse(parsed)
  if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  throw new InteractionStoreError("corrupt-journal", "provider delivery has an invalid request id")
}

function rowToProviderDelivery(row: ProviderDeliveryRow): ProviderDelivery {
  const parseObject = (raw: string | null, label: string): Record<string, unknown> | null => {
    if (raw === null) return null
    const parsed = parseJson(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InteractionStoreError("corrupt-journal", `provider delivery ${label} is not a JSON object`)
    }
    return parsed as Record<string, unknown>
  }
  const providerResponse = parseObject(row.provider_response_json, "response")
  const providerContext = parseObject(row.provider_context_json, "context")
  if (!(["awaiting-user", "queued", "sent", "acknowledged", "cancelled"] as const).includes(row.state)) {
    throw new InteractionStoreError("corrupt-journal", "provider delivery has an invalid state")
  }
  const responseId = row.response_id === null ? null : InteractionOpaqueId.parse(row.response_id)
  const resolution = row.resolution_json === null
    ? null
    : InteractionResolution.safeParse(parseJson(row.resolution_json))
  if (resolution !== null && (!resolution.success || resolution.data.redactedFieldIds.length > 0)) {
    throw new InteractionStoreError("corrupt-journal", "provider delivery has an invalid durable resolution")
  }
  if ((resolution?.data.responseId ?? null) !== responseId) {
    throw new InteractionStoreError("corrupt-journal", "provider delivery response id does not match its resolution")
  }
  for (const timestamp of [row.created_at, row.updated_at, row.sent_at, row.acknowledged_at]) {
    if (timestamp !== null && !InteractionTimestamp.safeParse(timestamp).success) {
      throw new InteractionStoreError("corrupt-journal", "provider delivery has an invalid timestamp")
    }
  }
  const hasResponse = responseId !== null && providerResponse !== null && resolution !== null
  const hasNoResponse = responseId === null && providerResponse === null && resolution === null
  if (!hasResponse && !hasNoResponse) {
    throw new InteractionStoreError("corrupt-journal", "provider delivery has a partial durable response")
  }
  if (row.state === "awaiting-user" && (!hasNoResponse || row.attempts !== 0 || row.sent_at !== null || row.acknowledged_at !== null)) {
    throw new InteractionStoreError("corrupt-journal", "awaiting provider delivery has terminal response metadata")
  }
  if (row.state === "queued" && (!hasResponse || row.sent_at !== null || row.acknowledged_at !== null)) {
    throw new InteractionStoreError("corrupt-journal", "queued provider delivery has invalid send metadata")
  }
  if (row.state === "sent" && (!hasResponse || row.attempts < 1 || row.sent_at === null || row.acknowledged_at !== null)) {
    throw new InteractionStoreError("corrupt-journal", "sent provider delivery has invalid acknowledgement metadata")
  }
  if (row.state === "acknowledged" && (!hasResponse || row.attempts < 1 || row.sent_at === null || row.acknowledged_at === null)) {
    throw new InteractionStoreError("corrupt-journal", "acknowledged provider delivery has invalid response metadata")
  }
  if (row.state === "cancelled" && row.acknowledged_at === null) {
    throw new InteractionStoreError("corrupt-journal", "cancelled provider delivery has no terminal timestamp")
  }
  return {
    interactionId: InteractionOpaqueId.parse(row.interaction_id),
    projectId: InteractionOpaqueId.parse(row.project_id),
    provider: InteractionOpaqueId.parse(row.provider),
    logicalRequestId: InteractionOpaqueId.parse(row.logical_request_id),
    method: InteractionOpaqueId.parse(row.request_method),
    connectionEpoch: InteractionRevision.parse(row.connection_epoch),
    rpcRequestId: parseRpcRequestId(row.rpc_request_id_json),
    state: row.state,
    responseId,
    providerResponse,
    providerContext,
    attempts: InteractionRevision.parse(row.attempts),
  }
}

function interactionFields(record: InteractionRecordType): InteractionField[] {
  return record.payload.kind === "mcp-elicitation-form" || record.payload.kind === "agent-question"
    ? record.payload.fields
    : []
}

function sanitizedResolution(
  record: InteractionRecordType,
  input: ResolveInteractionInputType,
  resolvedAt: string,
): InteractionResolutionType {
  const decision = record.allowedDecisions.find((candidate) => candidate.id === input.decisionId)
  if (!decision) throw new InteractionStoreError("invalid-decision", "decision was not advertised for this interaction")

  const fields = interactionFields(record)
  const expectsValues = (record.payload.kind === "mcp-elicitation-form" && decision.semantic === "accept") ||
    (record.payload.kind === "agent-question" && decision.semantic === "answer")
  if (!expectsValues) {
    if (input.values !== undefined) throw new InteractionStoreError("invalid-response", "this decision does not accept response fields")
    return InteractionResolution.parse({
      responseId: input.responseId,
      decisionId: input.decisionId,
      redactedFieldIds: [],
      resolvedAt,
    })
  }

  const values = input.values ?? {}
  const byId = new Map(fields.map((field) => [field.id, field]))
  for (const key of Object.keys(values)) {
    if (!byId.has(key)) throw new InteractionStoreError("invalid-response", "response contains an unadvertised field")
  }
  for (const field of fields) {
    const value = values[field.id]
    if (value === undefined) {
      if (field.required) throw new InteractionStoreError("invalid-response", "response is missing a required field")
      continue
    }
    if (validateInteractionFieldValue(field, value)) {
      throw new InteractionStoreError("invalid-response", "response field failed advertised validation")
    }
  }

  const persistedValues: InteractionValues = {}
  const redactedFieldIds: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const field = byId.get(key)!
    if (field.secret) redactedFieldIds.push(key)
    else persistedValues[key] = value
  }
  return InteractionResolution.parse({
    responseId: input.responseId,
    decisionId: input.decisionId,
    values: Object.keys(persistedValues).length > 0 ? persistedValues : undefined,
    redactedFieldIds,
    resolvedAt,
  })
}

function comparableResolution(value: InteractionResolutionType): string {
  return JSON.stringify({
    responseId: value.responseId,
    decisionId: value.decisionId,
    values: value.values
      ? Object.entries(value.values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      : null,
    redactedFieldIds: [...value.redactedFieldIds].sort(),
  })
}

function assertEpochs(record: InteractionRecordType, input: { sessionEpoch: number; capabilityRevision: number }): void {
  if (record.owner.sessionEpoch !== input.sessionEpoch) throw new InteractionStoreError("stale-session", "interaction session epoch is stale")
  if (record.owner.capabilityRevision !== input.capabilityRevision) {
    throw new InteractionStoreError("stale-capability", "interaction capability revision is stale")
  }
}

function changeOf(record: InteractionRecordType): InteractionChange {
  return {
    projectId: record.owner.projectId,
    threadSlug: record.owner.threadSlug,
    sessionId: record.owner.sessionId,
    interactionId: record.id,
    lifecycle: record.lifecycle,
    recordRevision: record.recordRevision,
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end--
  return value.slice(0, end)
}

// Fixed-field diagnostics only: request payloads, command/diff previews, form values, and resolution
// values are intentionally absent. Invalid/hostile input produces a constant instead of verbose Zod
// errors that could echo attacker-controlled content into logs.
export function serializeInteractionDiagnostic(value: unknown): string {
  const parsed = InteractionRecord.safeParse(value)
  if (!parsed.success) return '{"interaction":"invalid"}'
  const record = parsed.data
  const diagnostic = JSON.stringify({
    interactionId: truncateUtf8(record.id, 128),
    provider: record.provider.kind,
    sourceKind: record.source.kind,
    sessionEpoch: record.owner.sessionEpoch,
    capabilityRevision: record.owner.capabilityRevision,
    kind: record.payload.kind,
    lifecycle: record.lifecycle,
    recordRevision: record.recordRevision,
    redactedFieldCount: record.resolution?.redactedFieldIds.length ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
  return Buffer.byteLength(diagnostic, "utf8") <= INTERACTION_DIAGNOSTIC_MAX_BYTES
    ? diagnostic
    : JSON.stringify({ interactionId: truncateUtf8(record.id, 128), lifecycle: record.lifecycle, diagnostic: "redacted" })
}

export function createInteractionStore(db: Database.Database, options: InteractionStoreOptions = {}): InteractionStore {
  const now = options.now ?? (() => new Date())
  const makeId = options.id ?? randomUUID
  const listeners = new Set<(change: InteractionChange) => void>()
  const deferredChanges = new Map<string, InteractionChange>()
  let deferredFlushScheduled = false
  let disposed = false

  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_journal_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version   INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO interaction_journal_schema (singleton, version) VALUES (1, ${INTERACTION_DB_SCHEMA_VERSION});
  `)

  const initialVersion = db.prepare<[], { version: number }>("SELECT version FROM interaction_journal_schema WHERE singleton = 1").get()?.version
  if (!Number.isInteger(initialVersion) || initialVersion! < 1 || initialVersion! > INTERACTION_DB_SCHEMA_VERSION) {
    throw new InteractionStoreError("schema-version", `unsupported interaction journal schema version ${String(initialVersion)}`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_journal (
      id                  TEXT PRIMARY KEY,
      schema_version      INTEGER NOT NULL CHECK (schema_version = 1),
      project_id          TEXT NOT NULL,
      thread_slug         TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      session_epoch       INTEGER NOT NULL CHECK (session_epoch >= 0),
      capability_revision INTEGER NOT NULL CHECK (capability_revision >= 0),
      provider            TEXT NOT NULL,
      provider_request_id TEXT NOT NULL,
      kind                TEXT NOT NULL,
      request_json        TEXT NOT NULL,
      lifecycle           TEXT NOT NULL CHECK (lifecycle IN ('pending', 'resolved', 'cancelled', 'expired')),
      record_revision     INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
      response_id         TEXT,
      response_json       TEXT,
      cancellation_reason TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      expires_at          TEXT,
      completed_at        TEXT,
      UNIQUE (project_id, thread_slug, session_id, session_epoch, provider, provider_request_id)
    );
    CREATE INDEX IF NOT EXISTS interaction_journal_pending_owner
      ON interaction_journal (project_id, thread_slug, session_id, lifecycle, created_at);
    CREATE INDEX IF NOT EXISTS interaction_journal_expiry
      ON interaction_journal (lifecycle, expires_at) WHERE lifecycle = 'pending' AND expires_at IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS interaction_journal_response_id
      ON interaction_journal (project_id, response_id) WHERE response_id IS NOT NULL;

    -- A provider response is a two-phase transition. SENT means Fray durably claimed exactly one
    -- write attempt; the interaction journal deliberately remains pending until the provider emits
    -- its explicit resolved notification. A process restart never rewinds SENT to QUEUED.
    CREATE TABLE IF NOT EXISTS interaction_provider_delivery (
      interaction_id         TEXT PRIMARY KEY REFERENCES interaction_journal(id) ON DELETE CASCADE,
      project_id             TEXT NOT NULL,
      provider               TEXT NOT NULL,
      logical_request_id     TEXT NOT NULL,
      request_method         TEXT NOT NULL,
      connection_epoch       INTEGER NOT NULL CHECK (connection_epoch >= 0),
      rpc_request_id_json    TEXT NOT NULL,
      state                  TEXT NOT NULL CHECK (state IN ('awaiting-user', 'queued', 'sent', 'acknowledged', 'cancelled')),
      response_id            TEXT,
      provider_response_json TEXT,
      provider_context_json  TEXT,
      resolution_json        TEXT,
      attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      sent_at                TEXT,
      acknowledged_at        TEXT,
      UNIQUE (provider, connection_epoch, rpc_request_id_json),
      UNIQUE (project_id, response_id)
    );
    CREATE INDEX IF NOT EXISTS interaction_provider_delivery_queue
      ON interaction_provider_delivery (provider, connection_epoch, state, created_at);
    CREATE INDEX IF NOT EXISTS interaction_provider_delivery_logical
      ON interaction_provider_delivery (project_id, provider, logical_request_id);
  `)

  const tableColumns = (table: "interaction_journal" | "interaction_provider_delivery") => new Set(
    db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  )
  let providerColumns = tableColumns("interaction_provider_delivery")
  if (!providerColumns.has("provider_context_json")) {
    db.exec("ALTER TABLE interaction_provider_delivery ADD COLUMN provider_context_json TEXT")
    providerColumns = tableColumns("interaction_provider_delivery")
  }
  const requiredJournalColumns = [
    "id", "schema_version", "project_id", "thread_slug", "session_id", "session_epoch",
    "capability_revision", "provider", "provider_request_id", "kind", "request_json", "lifecycle",
    "record_revision", "response_id", "response_json", "cancellation_reason", "created_at", "updated_at",
    "expires_at", "completed_at",
  ]
  const requiredProviderColumns = [
    "interaction_id", "project_id", "provider", "logical_request_id", "request_method", "connection_epoch",
    "rpc_request_id_json", "state", "response_id", "provider_response_json", "provider_context_json",
    "resolution_json", "attempts", "created_at", "updated_at", "sent_at", "acknowledged_at",
  ]
  const journalColumns = tableColumns("interaction_journal")
  if (requiredJournalColumns.some((column) => !journalColumns.has(column)) || requiredProviderColumns.some((column) => !providerColumns.has(column))) {
    throw new InteractionStoreError("schema-version", "interaction journal schema is missing required columns")
  }
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS interaction_provider_delivery_rpc_unique
        ON interaction_provider_delivery (provider, connection_epoch, rpc_request_id_json);
      CREATE UNIQUE INDEX IF NOT EXISTS interaction_provider_delivery_response_unique
        ON interaction_provider_delivery (project_id, response_id) WHERE response_id IS NOT NULL;
    `)
  } catch {
    throw new InteractionStoreError("corrupt-journal", "interaction provider delivery uniqueness is corrupt")
  }
  const foreignKeyViolation = db.prepare<[], Record<string, unknown>>(
    "PRAGMA foreign_key_check(interaction_provider_delivery)",
  ).get()
  if (foreignKeyViolation) {
    throw new InteractionStoreError("corrupt-journal", "interaction provider delivery has an orphaned journal row")
  }
  if (initialVersion! < INTERACTION_DB_SCHEMA_VERSION) {
    db.prepare("UPDATE interaction_journal_schema SET version = ? WHERE singleton = 1")
      .run(INTERACTION_DB_SCHEMA_VERSION)
  }

  const byId = db.prepare<[string], InteractionRow>("SELECT * FROM interaction_journal WHERE id = ?")
  const byScopedId = db.prepare<[string, string, string, string], InteractionRow>(`
    SELECT * FROM interaction_journal
    WHERE id = ? AND project_id = ? AND thread_slug = ? AND session_id = ?
  `)
  const byProviderRequest = db.prepare<[string, string, string, number, string, string], InteractionRow>(`
    SELECT * FROM interaction_journal
    WHERE project_id = ? AND thread_slug = ? AND session_id = ? AND session_epoch = ? AND provider = ? AND provider_request_id = ?
  `)
  const byResponseId = db.prepare<[string, string], InteractionRow>(
    "SELECT * FROM interaction_journal WHERE project_id = ? AND response_id = ?",
  )
  const deliveryByInteraction = db.prepare<[string], ProviderDeliveryRow>(
    "SELECT * FROM interaction_provider_delivery WHERE interaction_id = ?",
  )
  const deliveryByScopedInteraction = db.prepare<[string, string, string, string], ProviderDeliveryRow>(`
    SELECT d.* FROM interaction_provider_delivery d
    JOIN interaction_journal j ON j.id = d.interaction_id
    WHERE d.interaction_id = ? AND j.project_id = ? AND j.thread_slug = ? AND j.session_id = ?
      AND d.project_id = j.project_id
  `)
  const deliveryByRpc = db.prepare<[string, number, string], ProviderDeliveryRow>(`
    SELECT * FROM interaction_provider_delivery
    WHERE provider = ? AND connection_epoch = ? AND rpc_request_id_json = ?
  `)
  const deliveryByResponseId = db.prepare<[string, string], ProviderDeliveryRow>(
    "SELECT * FROM interaction_provider_delivery WHERE project_id = ? AND response_id = ?",
  )
  const queuedDeliveries = db.prepare<[string, number], ProviderDeliveryRow>(`
    SELECT d.* FROM interaction_provider_delivery d
    JOIN interaction_journal j ON j.id = d.interaction_id
    WHERE d.provider = ? AND d.connection_epoch = ? AND d.state = 'queued' AND j.lifecycle = 'pending'
    ORDER BY d.created_at ASC, d.interaction_id ASC
  `)
  const listPendingStmt = db.prepare<[string, string, string, number], InteractionRow>(`
    SELECT * FROM interaction_journal
    WHERE project_id = ? AND thread_slug = ? AND session_id = ? AND lifecycle = 'pending'
    ORDER BY created_at ASC, id ASC LIMIT ?
  `)
  const pendingCount = db.prepare<[string, string, string], { count: number }>(`
    SELECT COUNT(*) AS count FROM interaction_journal
    WHERE project_id = ? AND thread_slug = ? AND session_id = ? AND lifecycle = 'pending'
  `)
  const insert = db.prepare(`
    INSERT INTO interaction_journal (
      id, schema_version, project_id, thread_slug, session_id, session_epoch, capability_revision,
      provider, provider_request_id, kind, request_json, lifecycle, record_revision,
      created_at, updated_at, expires_at
    ) VALUES (
      @id, @schemaVersion, @projectId, @threadSlug, @sessionId, @sessionEpoch, @capabilityRevision,
      @provider, @providerRequestId, @kind, @requestJson, 'pending', 0,
      @createdAt, @createdAt, @expiresAt
    )
    ON CONFLICT (project_id, thread_slug, session_id, session_epoch, provider, provider_request_id)
    DO NOTHING
  `)
  const insertDelivery = db.prepare(`
    INSERT INTO interaction_provider_delivery (
      interaction_id, project_id, provider, logical_request_id, request_method,
      connection_epoch, rpc_request_id_json, provider_context_json, state, created_at, updated_at
    ) VALUES (
      @interactionId, @projectId, @provider, @logicalRequestId, @method,
      @connectionEpoch, @rpcRequestIdJson, @providerContextJson, 'awaiting-user', @at, @at
    )
  `)
  const rebindDelivery = db.prepare(`
    UPDATE interaction_provider_delivery SET
      connection_epoch = @connectionEpoch,
      rpc_request_id_json = @rpcRequestIdJson,
      state = CASE WHEN state = 'sent' AND response_id IS NOT NULL THEN 'queued' ELSE state END,
      updated_at = @at,
      sent_at = CASE WHEN state = 'sent' AND response_id IS NOT NULL THEN NULL ELSE sent_at END
    WHERE interaction_id = @interactionId
      AND state IN ('awaiting-user', 'queued', 'sent')
      AND connection_epoch <= @connectionEpoch
      AND NOT (connection_epoch = @connectionEpoch AND rpc_request_id_json = @rpcRequestIdJson)
  `)
  const queueDelivery = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'queued', response_id = @responseId,
      provider_response_json = @providerResponseJson, resolution_json = @resolutionJson,
      updated_at = @at
    WHERE interaction_id = @interactionId AND state = 'awaiting-user'
  `)
  const claimDelivery = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'sent', attempts = attempts + 1, updated_at = @at, sent_at = @at
    WHERE interaction_id = @interactionId AND state = 'queued'
      AND connection_epoch = @connectionEpoch AND rpc_request_id_json = @rpcRequestIdJson
  `)
  const resolveStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'resolved', record_revision = record_revision + 1,
      response_id = @responseId, response_json = @responseJson,
      cancellation_reason = NULL, updated_at = @resolvedAt, completed_at = @resolvedAt
    WHERE id = @id AND project_id = @projectId AND thread_slug = @threadSlug AND session_id = @sessionId
      AND lifecycle = 'pending' AND record_revision = @expectedRecordRevision
      AND session_epoch = @sessionEpoch AND capability_revision = @capabilityRevision
      AND (expires_at IS NULL OR expires_at > @resolvedAt)
  `)
  const providerResolveStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'resolved', record_revision = record_revision + 1,
      response_id = @responseId, response_json = @responseJson,
      cancellation_reason = NULL, updated_at = @resolvedAt, completed_at = @resolvedAt
    WHERE id = @id AND lifecycle = 'pending'
      AND session_epoch = @sessionEpoch AND capability_revision = @capabilityRevision
  `)
  const cancelStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'cancelled', record_revision = record_revision + 1,
      cancellation_reason = 'user-cancelled', updated_at = @cancelledAt, completed_at = @cancelledAt
    WHERE id = @id AND project_id = @projectId AND thread_slug = @threadSlug AND session_id = @sessionId
      AND lifecycle = 'pending' AND record_revision = @expectedRecordRevision
      AND session_epoch = @sessionEpoch AND capability_revision = @capabilityRevision
      AND (expires_at IS NULL OR expires_at > @cancelledAt)
  `)
  const providerCancelStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'cancelled', record_revision = record_revision + 1,
      cancellation_reason = 'provider-cancelled', updated_at = @at, completed_at = @at
    WHERE id = @id AND lifecycle = 'pending'
  `)
  const invalidateProviderStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'cancelled', record_revision = record_revision + 1,
      cancellation_reason = @reason, updated_at = @at, completed_at = @at
    WHERE id = @id AND project_id = @projectId AND thread_slug = @threadSlug
      AND session_id = @sessionId AND lifecycle = 'pending'
  `)
  const acknowledgeDeliveryStmt = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'acknowledged', updated_at = @at, acknowledged_at = @at
    WHERE interaction_id = @interactionId AND state = 'sent'
  `)
  const cancelDeliveryStmt = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'cancelled', updated_at = @at, acknowledged_at = @at
    WHERE interaction_id = @interactionId AND state IN ('awaiting-user', 'queued')
  `)
  const cancelActiveDeliveryStmt = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'cancelled', updated_at = @at, acknowledged_at = @at
    WHERE interaction_id = @interactionId AND state IN ('awaiting-user', 'queued', 'sent')
  `)
  const pendingForSession = db.prepare<[string, string], InteractionRow>(`
    SELECT * FROM interaction_journal WHERE thread_slug = ? AND session_id = ? AND lifecycle = 'pending'
  `)
  const cancelSessionStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'cancelled', record_revision = record_revision + 1,
      cancellation_reason = @reason, updated_at = @at, completed_at = @at
    WHERE thread_slug = @threadSlug AND session_id = @sessionId AND lifecycle = 'pending'
  `)
  const cancelSessionDeliveriesStmt = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'cancelled', updated_at = @at, acknowledged_at = @at
    WHERE state IN ('awaiting-user', 'queued', 'sent') AND interaction_id IN (
      SELECT id FROM interaction_journal
      WHERE thread_slug = @threadSlug AND session_id = @sessionId AND lifecycle = 'cancelled'
    )
  `)
  const dueStmt = db.prepare<[string], InteractionRow>(`
    SELECT j.* FROM interaction_journal j
    WHERE j.lifecycle = 'pending' AND j.expires_at IS NOT NULL AND j.expires_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM interaction_provider_delivery d
        WHERE d.interaction_id = j.id AND d.state IN ('queued', 'sent')
      )
  `)
  const expireStmt = db.prepare(`
    UPDATE interaction_journal SET
      lifecycle = 'expired', record_revision = record_revision + 1,
      cancellation_reason = 'expired', updated_at = @at, completed_at = @at
    WHERE lifecycle = 'pending' AND expires_at IS NOT NULL AND expires_at <= @at
      AND NOT EXISTS (
        SELECT 1 FROM interaction_provider_delivery d
        WHERE d.interaction_id = interaction_journal.id AND d.state IN ('queued', 'sent')
      )
  `)
  const expireDeliveriesStmt = db.prepare(`
    UPDATE interaction_provider_delivery SET
      state = 'cancelled', updated_at = @at, acknowledged_at = @at
    WHERE state = 'awaiting-user' AND interaction_id IN (
      SELECT id FROM interaction_journal WHERE lifecycle = 'expired'
    )
  `)

  function changeKey(change: InteractionChange): string {
    return [
      change.projectId,
      change.threadSlug,
      change.sessionId,
      change.interactionId,
      change.lifecycle,
      String(change.recordRevision),
    ].join("\u0000")
  }

  function publish(change: InteractionChange): void {
    for (const listener of listeners) {
      try {
        listener(change)
      } catch {
        // A broken observer must not roll back or hide a durable journal transition.
      }
    }
  }

  function flushDeferredChanges(): void {
    deferredFlushScheduled = false
    if (disposed) {
      deferredChanges.clear()
      return
    }
    const pending = [...deferredChanges.values()]
    deferredChanges.clear()
    for (const expected of pending) {
      try {
        const row = byId.get(expected.interactionId)
        if (!row) continue
        const current = changeOf(rowToRecord(row))
        if (changeKey(current) === changeKey(expected)) publish(current)
      } catch {
        // The enclosing transaction rolled back, the DB closed, or the row is corrupt. In every case
        // publishing the speculative transition would be less truthful than suppressing it.
      }
    }
  }

  function emit(records: InteractionRecordType[]): void {
    const changes = records.map(changeOf)
    if (!db.inTransaction) {
      for (const change of changes) {
        deferredChanges.delete(changeKey(change))
        publish(change)
      }
      return
    }
    // A store operation may be nested in Storage's session replacement/deletion transaction. SQLite
    // has no JS after-commit hook, so verify the authoritative row in the next microtask; a rollback or
    // a newer transition then cannot leak a false invalidation to clients.
    for (const change of changes) deferredChanges.set(changeKey(change), change)
    if (!deferredFlushScheduled) {
      deferredFlushScheduled = true
      queueMicrotask(flushDeferredChanges)
    }
  }

  const createTxn = db.transaction((raw: InteractionRequestType): CreateInteractionResult => {
    const request = InteractionRequest.parse(raw)
    const requestJson = canonicalJson(request)
    const existing = byProviderRequest.get(
      request.owner.projectId,
      request.owner.threadSlug,
      request.owner.sessionId,
      request.owner.sessionEpoch,
      request.provider.kind,
      request.providerRequestId,
    )
    if (existing) {
      if (existing.request_json !== requestJson) {
        throw new InteractionStoreError("provider-id-conflict", "provider request id was reused with different interaction data")
      }
      return { effect: "deduplicated", interaction: rowToRecord(existing) }
    }
    const createdAt = iso(now)
    if (request.expiresAt !== null && request.expiresAt <= createdAt) {
      throw new InteractionStoreError("expired", "interaction already expired before it was journaled")
    }
    const count = pendingCount.get(request.owner.projectId, request.owner.threadSlug, request.owner.sessionId)?.count ?? 0
    if (count >= INTERACTION_LIST_MAX) throw new InteractionStoreError("capacity", "too many pending interactions for this session")

    const id = InteractionOpaqueId.parse(makeId())
    let changes: number
    try {
      changes = insert.run({
        id,
        schemaVersion: INTERACTION_RECORD_SCHEMA_VERSION,
        projectId: request.owner.projectId,
        threadSlug: request.owner.threadSlug,
        sessionId: request.owner.sessionId,
        sessionEpoch: request.owner.sessionEpoch,
        capabilityRevision: request.owner.capabilityRevision,
        provider: request.provider.kind,
        providerRequestId: request.providerRequestId,
        kind: request.payload.kind,
        requestJson,
        createdAt,
        expiresAt: request.expiresAt,
      }).changes
    } catch (error) {
      if (byId.get(id)) throw new InteractionStoreError("id-conflict", "generated interaction id already exists")
      throw error
    }
    if (changes === 1) {
      const inserted = byId.get(id)
      if (!inserted) throw new InteractionStoreError("corrupt-journal", "created interaction disappeared from its journal")
      return { effect: "created", interaction: rowToRecord(inserted) }
    }

    // Another connection won the unique provider-request race after our initial read.
    const winner = byProviderRequest.get(
      request.owner.projectId,
      request.owner.threadSlug,
      request.owner.sessionId,
      request.owner.sessionEpoch,
      request.provider.kind,
      request.providerRequestId,
    )
    if (!winner || winner.request_json !== requestJson) {
      throw new InteractionStoreError("provider-id-conflict", "provider request id was reused with different interaction data")
    }
    return { effect: "deduplicated", interaction: rowToRecord(winner) }
  })

  const createProviderRequestTxn = db.transaction((
    raw: InteractionRequestType,
    rawBinding: ProviderRequestBinding,
  ): CreateProviderInteractionResult => {
    const binding = {
      provider: InteractionOpaqueId.parse(rawBinding.provider),
      logicalRequestId: InteractionOpaqueId.parse(rawBinding.logicalRequestId),
      method: InteractionOpaqueId.parse(rawBinding.method),
      connectionEpoch: InteractionRevision.parse(rawBinding.connectionEpoch),
      rpcRequestIdJson: rpcRequestIdJson(rawBinding.rpcRequestId),
      providerContextJson: rawBinding.providerContext === undefined ? null : boundedProviderJson(rawBinding.providerContext),
    }
    const result = createTxn(raw)
    const interaction = result.interaction
    if (interaction.lifecycle !== "pending") {
      throw new InteractionStoreError("not-pending", "provider request is already terminal")
    }
    const existing = deliveryByInteraction.get(interaction.id)
    const at = iso(now)
    if (!existing) {
      try {
        insertDelivery.run({
          interactionId: interaction.id,
          projectId: interaction.owner.projectId,
          ...binding,
          at,
        })
      } catch (error) {
        const collision = deliveryByRpc.get(binding.provider, binding.connectionEpoch, binding.rpcRequestIdJson)
        if (collision?.interaction_id !== interaction.id) {
          throw new InteractionStoreError("provider-id-conflict", "provider request id is already bound to another interaction")
        }
        throw error
      }
      return { ...result, delivery: rowToProviderDelivery(deliveryByInteraction.get(interaction.id)!) }
    }

    if (
      existing.project_id !== interaction.owner.projectId ||
      existing.provider !== binding.provider ||
      existing.logical_request_id !== binding.logicalRequestId ||
      existing.request_method !== binding.method ||
      existing.provider_context_json !== binding.providerContextJson
    ) {
      throw new InteractionStoreError("provider-id-conflict", "provider delivery binding conflicts with its journal request")
    }
    if (existing.connection_epoch > binding.connectionEpoch) {
      throw new InteractionStoreError("stale-session", "provider connection epoch is stale")
    }
    if (existing.state === "acknowledged" || existing.state === "cancelled") {
      throw new InteractionStoreError("not-pending", "provider request is already terminal")
    }
    if (
      existing.connection_epoch !== binding.connectionEpoch ||
      existing.rpc_request_id_json !== binding.rpcRequestIdJson
    ) {
      try {
        const changed = rebindDelivery.run({
          interactionId: interaction.id,
          connectionEpoch: binding.connectionEpoch,
          rpcRequestIdJson: binding.rpcRequestIdJson,
          at,
        }).changes
        if (changed !== 1) throw new InteractionStoreError("stale-session", "provider request could not be rebound")
      } catch (error) {
        if (error instanceof InteractionStoreError) throw error
        const collision = deliveryByRpc.get(binding.provider, binding.connectionEpoch, binding.rpcRequestIdJson)
        if (collision?.interaction_id !== interaction.id) {
          throw new InteractionStoreError("provider-id-conflict", "provider request id is already bound to another interaction")
        }
        throw error
      }
    }
    return { ...result, delivery: rowToProviderDelivery(deliveryByInteraction.get(interaction.id)!) }
  })

  const queueProviderResponseTxn = db.transaction((
    scope: InteractionSessionScope,
    raw: ResolveInteractionInputType,
    providerResponse: unknown,
  ): QueueProviderResponseResult => {
    const input = ResolveInteractionInput.parse(raw)
    if (input.slug !== scope.threadSlug || input.sessionId !== scope.sessionId) {
      throw new InteractionStoreError("owner-mismatch", "interaction does not belong to this project session")
    }
    const currentRow = byScopedId.get(input.interactionId, scope.projectId, scope.threadSlug, scope.sessionId)
    if (!currentRow) throw new InteractionStoreError("not-found", "interaction not found")
    const current = rowToRecord(currentRow)
    assertEpochs(current, input)
    if (current.lifecycle === "expired") throw new InteractionStoreError("expired", "interaction has expired")
    if (current.lifecycle !== "pending") throw new InteractionStoreError("not-pending", "interaction is no longer pending")
    if (current.recordRevision !== input.expectedRecordRevision) {
      throw new InteractionStoreError("stale-revision", "interaction record revision is stale")
    }
    const at = iso(now)
    if (current.expiresAt !== null && current.expiresAt <= at) {
      throw new InteractionStoreError("expired", "interaction has expired")
    }
    const resolution = sanitizedResolution(current, input, at)
    if (resolution.redactedFieldIds.length > 0) {
      // A durable outbox cannot safely carry raw secret answers. Until Fray has an encrypted,
      // process-bound escrow, refuse instead of persisting or losing a secret provider response.
      throw new InteractionStoreError("invalid-response", "secret provider answers require secure transient delivery")
    }
    const providerResponseJson = boundedProviderJson(providerResponse)
    const resolutionJson = canonicalJson(resolution)
    const deliveryRow = deliveryByInteraction.get(current.id)
    if (!deliveryRow) throw new InteractionStoreError("not-found", "interaction has no provider delivery binding")
    const delivery = rowToProviderDelivery(deliveryRow)

    if (delivery.responseId !== null) {
      const storedResolution = deliveryRow.resolution_json === null
        ? null
        : InteractionResolution.safeParse(parseJson(deliveryRow.resolution_json))
      const same = delivery.responseId === input.responseId &&
        deliveryRow.provider_response_json === providerResponseJson &&
        storedResolution !== null && storedResolution.success &&
        comparableResolution(storedResolution.data) === comparableResolution(resolution)
      if (!same) throw new InteractionStoreError("response-id-conflict", "provider response conflicts with an already queued response")
      return {
        effect: delivery.state === "sent" ? "already-sent" : "already-queued",
        interaction: current,
        delivery,
      }
    }

    const responseOwner = deliveryByResponseId.get(scope.projectId, input.responseId)
    if (responseOwner && responseOwner.interaction_id !== current.id) {
      throw new InteractionStoreError("response-id-conflict", "response id was reused for another interaction")
    }
    const journalResponseOwner = byResponseId.get(scope.projectId, input.responseId)
    if (journalResponseOwner && journalResponseOwner.id !== current.id) {
      throw new InteractionStoreError("response-id-conflict", "response id was reused for another interaction")
    }
    if (delivery.state !== "awaiting-user") throw new InteractionStoreError("not-pending", "provider delivery is no longer awaiting a response")
    try {
      const changed = queueDelivery.run({
        interactionId: current.id,
        responseId: input.responseId,
        providerResponseJson,
        resolutionJson,
        at,
      }).changes
      if (changed !== 1) throw new InteractionStoreError("stale-revision", "provider response queue changed concurrently")
    } catch (error) {
      if (error instanceof InteractionStoreError) throw error
      const owner = deliveryByResponseId.get(scope.projectId, input.responseId)
      if (owner?.interaction_id !== current.id) {
        throw new InteractionStoreError("response-id-conflict", "response id was reused for another interaction")
      }
      throw error
    }
    return {
      effect: "queued",
      interaction: current,
      delivery: rowToProviderDelivery(deliveryByInteraction.get(current.id)!),
    }
  })

  const claimProviderResponseTxn = db.transaction((
    interactionId: string,
    connectionEpoch: number,
    rawRpcRequestId: string | number,
  ): ProviderDelivery => {
    const id = InteractionOpaqueId.parse(interactionId)
    const epoch = InteractionRevision.parse(connectionEpoch)
    const requestId = rpcRequestIdJson(rawRpcRequestId)
    const row = deliveryByInteraction.get(id)
    if (!row) throw new InteractionStoreError("not-found", "provider delivery not found")
    const journal = byId.get(id)
    if (!journal || journal.lifecycle !== "pending") throw new InteractionStoreError("not-pending", "interaction is no longer pending")
    if (row.connection_epoch !== epoch || row.rpc_request_id_json !== requestId) {
      throw new InteractionStoreError("stale-session", "provider delivery binding is stale")
    }
    if (row.state === "sent") throw new InteractionStoreError("not-pending", "provider delivery was already claimed for send")
    if (row.state !== "queued") throw new InteractionStoreError("not-pending", "provider delivery is not queued")
    const changed = claimDelivery.run({
      interactionId: id,
      connectionEpoch: epoch,
      rpcRequestIdJson: requestId,
      at: iso(now),
    }).changes
    if (changed !== 1) throw new InteractionStoreError("stale-revision", "provider delivery changed concurrently")
    return rowToProviderDelivery(deliveryByInteraction.get(id)!)
  })

  const acknowledgeProviderResponseTxn = db.transaction((
    provider: string,
    connectionEpoch: number,
    rawRpcRequestId: string | number,
    scope: InteractionSessionScope,
  ): AcknowledgeProviderResponseResult | undefined => {
    const parsedProvider = InteractionOpaqueId.parse(provider)
    const epoch = InteractionRevision.parse(connectionEpoch)
    const requestId = rpcRequestIdJson(rawRpcRequestId)
    const delivery = deliveryByRpc.get(parsedProvider, epoch, requestId)
    if (!delivery) return undefined
    const decodedDelivery = rowToProviderDelivery(delivery)
    const currentRow = byId.get(delivery.interaction_id)
    if (!currentRow) throw new InteractionStoreError("corrupt-journal", "provider delivery lost its interaction")
    const current = rowToRecord(currentRow)
    if (decodedDelivery.projectId !== current.owner.projectId || decodedDelivery.interactionId !== current.id) {
      throw new InteractionStoreError("corrupt-journal", "provider delivery columns do not match their journal owner")
    }
    if (
      current.owner.projectId !== scope.projectId ||
      current.owner.threadSlug !== scope.threadSlug ||
      current.owner.sessionId !== scope.sessionId
    ) {
      throw new InteractionStoreError("owner-mismatch", "provider acknowledgement crossed an interaction owner boundary")
    }
    if (current.lifecycle !== "pending") {
      if (["awaiting-user", "queued", "sent"].includes(delivery.state)) {
        cancelActiveDeliveryStmt.run({ interactionId: current.id, at: iso(now) })
      }
      return { effect: "already-terminal", interaction: current }
    }
    const at = iso(now)

    if (delivery.state === "sent") {
      if (delivery.resolution_json === null || delivery.response_id === null) {
        throw new InteractionStoreError("corrupt-journal", "sent provider delivery is missing its response")
      }
      const staged = InteractionResolution.safeParse(parseJson(delivery.resolution_json))
      if (!staged.success || staged.data.redactedFieldIds.length > 0) {
        throw new InteractionStoreError("corrupt-journal", "sent provider delivery has an invalid durable resolution")
      }
      const resolution = InteractionResolution.parse({ ...staged.data, resolvedAt: at })
      try {
        const changed = providerResolveStmt.run({
          id: current.id,
          sessionEpoch: current.owner.sessionEpoch,
          capabilityRevision: current.owner.capabilityRevision,
          responseId: delivery.response_id,
          responseJson: canonicalJson(resolution),
          resolvedAt: at,
        }).changes
        if (changed !== 1) throw new InteractionStoreError("stale-revision", "interaction changed before provider acknowledgement")
      } catch (error) {
        if (error instanceof InteractionStoreError) throw error
        const owner = byResponseId.get(current.owner.projectId, delivery.response_id)
        if (owner?.id !== current.id) throw new InteractionStoreError("response-id-conflict", "response id was reused for another interaction")
        throw error
      }
      if (acknowledgeDeliveryStmt.run({ interactionId: current.id, at }).changes !== 1) {
        throw new InteractionStoreError("stale-revision", "provider delivery acknowledgement changed concurrently")
      }
      return { effect: "resolved", interaction: rowToRecord(byId.get(current.id)!) }
    }

    if (delivery.state === "awaiting-user" || delivery.state === "queued") {
      if (providerCancelStmt.run({ id: current.id, at }).changes !== 1) {
        throw new InteractionStoreError("stale-revision", "interaction changed before provider cancellation")
      }
      if (cancelDeliveryStmt.run({ interactionId: current.id, at }).changes !== 1) {
        throw new InteractionStoreError("stale-revision", "provider delivery cancellation changed concurrently")
      }
      return { effect: "cancelled", interaction: rowToRecord(byId.get(current.id)!) }
    }

    return { effect: "already-terminal", interaction: current }
  })

  const invalidateProviderRequestTxn = db.transaction((
    scope: InteractionSessionScope,
    rawInteractionId: string,
    reason: "provider-cancelled" | "turn-ended",
  ): InvalidateProviderRequestResult => {
    const interactionId = InteractionOpaqueId.parse(rawInteractionId)
    const projectId = InteractionOpaqueId.parse(scope.projectId)
    const threadSlug = InteractionOpaqueId.parse(scope.threadSlug)
    const sessionId = InteractionOpaqueId.parse(scope.sessionId)
    const currentRow = byScopedId.get(interactionId, projectId, threadSlug, sessionId)
    if (!currentRow) throw new InteractionStoreError("not-found", "provider interaction not found")
    const current = rowToRecord(currentRow)
    const deliveryRow = deliveryByInteraction.get(current.id)
    if (!deliveryRow) throw new InteractionStoreError("not-found", "interaction has no provider delivery binding")
    const delivery = rowToProviderDelivery(deliveryRow)
    if (delivery.projectId !== current.owner.projectId || delivery.interactionId !== current.id) {
      throw new InteractionStoreError("corrupt-journal", "provider delivery columns do not match their journal owner")
    }
    if (current.lifecycle !== "pending") {
      return { effect: "already-terminal", interaction: current, delivery }
    }
    if (!(["awaiting-user", "queued", "sent"] as ProviderDeliveryState[]).includes(delivery.state)) {
      throw new InteractionStoreError("corrupt-journal", "pending provider interaction has a terminal delivery")
    }
    const responseInFlight = delivery.state === "queued" || delivery.state === "sent"
    const at = iso(now)
    if (invalidateProviderStmt.run({
      id: current.id,
      projectId,
      threadSlug,
      sessionId,
      reason,
      at,
    }).changes !== 1) {
      throw new InteractionStoreError("stale-revision", "provider interaction changed during invalidation")
    }
    if (cancelActiveDeliveryStmt.run({ interactionId: current.id, at }).changes !== 1) {
      throw new InteractionStoreError("stale-revision", "provider delivery changed during invalidation")
    }
    return {
      effect: responseInFlight ? "response-in-flight" : "cancelled",
      interaction: rowToRecord(byId.get(current.id)!),
      delivery: rowToProviderDelivery(deliveryByInteraction.get(current.id)!),
    }
  })

  const resolveTxn = db.transaction((scope: InteractionSessionScope, raw: ResolveInteractionInputType): ResolveStoredInteractionResult => {
    const input = ResolveInteractionInput.parse(raw)
    if (input.slug !== scope.threadSlug || input.sessionId !== scope.sessionId) {
      throw new InteractionStoreError("owner-mismatch", "interaction does not belong to this project session")
    }
    const currentRow = byScopedId.get(input.interactionId, scope.projectId, scope.threadSlug, scope.sessionId)
    if (!currentRow) throw new InteractionStoreError("not-found", "interaction not found")
    const current = rowToRecord(currentRow)
    assertEpochs(current, input)
    if (deliveryByInteraction.get(current.id)) {
      throw new InteractionStoreError("invalid-response", "provider-backed interaction must use acknowledged delivery")
    }
    const at = iso(now)
    const resolution = sanitizedResolution(current, input, at)

    if (current.lifecycle === "resolved") {
      if (current.resolution?.responseId === input.responseId && comparableResolution(current.resolution) === comparableResolution(resolution)) {
        return { effect: "already-resolved", interaction: current }
      }
      throw new InteractionStoreError("response-id-conflict", "interaction was already resolved by another response")
    }
    if (current.lifecycle === "expired") throw new InteractionStoreError("expired", "interaction has expired")
    if (current.lifecycle !== "pending") throw new InteractionStoreError("not-pending", "interaction is no longer pending")
    if (current.recordRevision !== input.expectedRecordRevision) throw new InteractionStoreError("stale-revision", "interaction record revision is stale")

    const queuedResponseOwner = deliveryByResponseId.get(scope.projectId, input.responseId)
    if (queuedResponseOwner && queuedResponseOwner.interaction_id !== current.id) {
      throw new InteractionStoreError("response-id-conflict", "response id was reused for another interaction")
    }

    try {
      const changed = resolveStmt.run({
        id: input.interactionId,
        projectId: scope.projectId,
        threadSlug: scope.threadSlug,
        sessionId: scope.sessionId,
        sessionEpoch: input.sessionEpoch,
        capabilityRevision: input.capabilityRevision,
        expectedRecordRevision: input.expectedRecordRevision,
        responseId: input.responseId,
        responseJson: canonicalJson(resolution),
        resolvedAt: at,
      }).changes
      if (changed === 1) return { effect: "resolved", interaction: rowToRecord(byId.get(input.interactionId)!) }
    } catch (error) {
      const owner = byResponseId.get(scope.projectId, input.responseId)
      if (owner?.id !== input.interactionId) throw new InteractionStoreError("response-id-conflict", "response id was reused for another interaction")
      throw error
    }

    const after = rowToRecord(byId.get(input.interactionId)!)
    if (after.lifecycle === "resolved" && after.resolution?.responseId === input.responseId && comparableResolution(after.resolution) === comparableResolution(resolution)) {
      return { effect: "already-resolved", interaction: after }
    }
    if (after.lifecycle === "expired" || (after.expiresAt !== null && after.expiresAt <= at)) {
      throw new InteractionStoreError("expired", "interaction has expired")
    }
    if (after.recordRevision !== input.expectedRecordRevision) throw new InteractionStoreError("stale-revision", "interaction record revision is stale")
    throw new InteractionStoreError("not-pending", "interaction is no longer pending")
  })

  const cancelTxn = db.transaction((scope: InteractionSessionScope, raw: CancelInteractionInputType): CancelStoredInteractionResult => {
    const input = CancelInteractionInput.parse(raw)
    if (input.slug !== scope.threadSlug || input.sessionId !== scope.sessionId) {
      throw new InteractionStoreError("owner-mismatch", "interaction does not belong to this project session")
    }
    const currentRow = byScopedId.get(input.interactionId, scope.projectId, scope.threadSlug, scope.sessionId)
    if (!currentRow) throw new InteractionStoreError("not-found", "interaction not found")
    const current = rowToRecord(currentRow)
    assertEpochs(current, input)
    if (deliveryByInteraction.get(current.id)) {
      throw new InteractionStoreError("invalid-response", "provider-backed interaction must use its advertised provider decision")
    }
    if (current.lifecycle === "cancelled" && current.cancellationReason === "user-cancelled") {
      return { effect: "already-cancelled", interaction: current }
    }
    if (current.lifecycle === "expired") throw new InteractionStoreError("expired", "interaction has expired")
    if (current.lifecycle !== "pending") throw new InteractionStoreError("not-pending", "interaction is no longer pending")
    if (current.recordRevision !== input.expectedRecordRevision) throw new InteractionStoreError("stale-revision", "interaction record revision is stale")
    const at = iso(now)
    const changed = cancelStmt.run({
      id: input.interactionId,
      projectId: scope.projectId,
      threadSlug: scope.threadSlug,
      sessionId: scope.sessionId,
      sessionEpoch: input.sessionEpoch,
      capabilityRevision: input.capabilityRevision,
      expectedRecordRevision: input.expectedRecordRevision,
      cancelledAt: at,
    }).changes
    if (changed === 1) return { effect: "cancelled", interaction: rowToRecord(byId.get(input.interactionId)!) }
    const after = rowToRecord(byId.get(input.interactionId)!)
    if (after.lifecycle === "cancelled" && after.cancellationReason === "user-cancelled") {
      return { effect: "already-cancelled", interaction: after }
    }
    if (after.lifecycle === "expired" || (after.expiresAt !== null && after.expiresAt <= at)) {
      throw new InteractionStoreError("expired", "interaction has expired")
    }
    throw new InteractionStoreError("stale-revision", "interaction record revision is stale")
  })

  const cancelForSessionTxn = db.transaction((threadSlug: string, sessionId: string, reason: Exclude<InteractionCancellationReasonType, "expired">) => {
    const before = pendingForSession.all(threadSlug, sessionId)
    if (before.length === 0) return []
    const at = iso(now)
    cancelSessionStmt.run({ threadSlug, sessionId, reason, at })
    cancelSessionDeliveriesStmt.run({ threadSlug, sessionId, at })
    return before.map((row) => rowToRecord(byId.get(row.id)!))
  })

  const expireTxn = db.transaction((at: string) => {
    const before = dueStmt.all(at)
    if (before.length === 0) return []
    expireStmt.run({ at })
    expireDeliveriesStmt.run({ at })
    return before.map((row) => rowToRecord(byId.get(row.id)!))
  })

  return {
    create(request) {
      const expired = expireTxn(iso(now))
      emit(expired)
      // IMMEDIATE serializes the capacity check with insert across connections while preserving the
      // provider-request uniqueness constraint as the final dedupe authority.
      const result = createTxn.immediate(request)
      if (result.effect === "created") emit([result.interaction])
      return result
    },
    createProviderRequest(request, binding) {
      const expired = expireTxn(iso(now))
      emit(expired)
      const result = createProviderRequestTxn.immediate(request, binding)
      // A deduplicated provider request may have freshly rebound a previously SENT response to a new
      // witnessed RPC id. Its journal revision is unchanged, but scoped readers still need to refresh
      // their delivery effect, so provider requests always publish an invalidation after commit.
      emit([result.interaction])
      return result
    },
    get(scope, interactionId) {
      const expired = expireTxn(iso(now))
      emit(expired)
      const row = byScopedId.get(interactionId, scope.projectId, scope.threadSlug, scope.sessionId)
      if (!row) return undefined
      return rowToRecord(row)
    },
    listPending(scope) {
      const expired = expireTxn(iso(now))
      emit(expired)
      return listPendingStmt.all(scope.projectId, scope.threadSlug, scope.sessionId, INTERACTION_LIST_MAX).map(rowToRecord)
    },
    resolve(scope, input) {
      const expired = expireTxn(iso(now))
      emit(expired)
      const result = resolveTxn(scope, input)
      if (result.effect === "resolved") emit([result.interaction])
      return result
    },
    providerDelivery(scope, interactionId) {
      const row = deliveryByScopedInteraction.get(
        InteractionOpaqueId.parse(interactionId),
        InteractionOpaqueId.parse(scope.projectId),
        InteractionOpaqueId.parse(scope.threadSlug),
        InteractionOpaqueId.parse(scope.sessionId),
      )
      return row ? rowToProviderDelivery(row) : undefined
    },
    queueProviderResponse(scope, input, providerResponse) {
      const expired = expireTxn(iso(now))
      emit(expired)
      const result = queueProviderResponseTxn.immediate(scope, input, providerResponse)
      if (result.effect === "queued") emit([result.interaction])
      return result
    },
    listQueuedProviderResponses(provider, connectionEpoch) {
      const parsedProvider = InteractionOpaqueId.parse(provider)
      const epoch = InteractionRevision.parse(connectionEpoch)
      return queuedDeliveries.all(parsedProvider, epoch).map(rowToProviderDelivery)
    },
    claimProviderResponseForSend(interactionId, connectionEpoch, rpcRequestId) {
      const delivery = claimProviderResponseTxn.immediate(interactionId, connectionEpoch, rpcRequestId)
      const row = byId.get(delivery.interactionId)
      if (row) emit([rowToRecord(row)])
      return delivery
    },
    acknowledgeProviderResponse(provider, connectionEpoch, rpcRequestId, scope) {
      const result = acknowledgeProviderResponseTxn.immediate(provider, connectionEpoch, rpcRequestId, scope)
      if (result && result.effect !== "already-terminal") emit([result.interaction])
      return result
    },
    invalidateProviderRequest(scope, interactionId, reason) {
      if (reason !== "provider-cancelled" && reason !== "turn-ended") {
        throw new InteractionStoreError("invalid-response", "invalid provider invalidation reason")
      }
      const result = invalidateProviderRequestTxn.immediate(scope, interactionId, reason)
      if (result.effect !== "already-terminal") emit([result.interaction])
      return result
    },
    cancel(scope, input) {
      const expired = expireTxn(iso(now))
      emit(expired)
      const result = cancelTxn(scope, input)
      if (result.effect === "cancelled") emit([result.interaction])
      return result
    },
    cancelForSession(threadSlug, sessionId, reason) {
      const parsedReason = InteractionCancellationReason.safeParse(reason)
      if (!parsedReason.success || parsedReason.data === "expired") {
        throw new InteractionStoreError("invalid-response", "invalid session cancellation reason")
      }
      const records = cancelForSessionTxn(threadSlug, sessionId, parsedReason.data)
      emit(records)
      return records
    },
    expireDue(at = iso(now)) {
      const parsedAt = InteractionTimestamp.safeParse(at)
      if (!parsedAt.success) throw new InteractionStoreError("invalid-response", "invalid interaction expiry timestamp")
      const records = expireTxn(parsedAt.data)
      emit(records)
      return records
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      deferredChanges.clear()
      listeners.clear()
    },
  }
}
