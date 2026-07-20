import { z } from "zod"
import { ThreadSlug } from "./thread-slug.ts"

// Runtime-neutral typed interaction protocol. Provider-controlled strings in this module are
// presentation-safe PLAIN TEXT only: consumers must render them as textContent/React text, never as
// HTML or Markdown. Every leaf and aggregate is capped before it can reach SQLite or a future card.

export const INTERACTION_PROTOCOL_VERSION = 1 as const
export const INTERACTION_REQUEST_MAX_BYTES = 64 * 1024
export const INTERACTION_RESPONSE_MAX_BYTES = 24 * 1024
export const INTERACTION_LIST_MAX = 128

const encoder = new TextEncoder()
const INTERACTION_NUMBER_LIMIT = 1_000_000_000_000_000
// Reject every Unicode formatting/surrogate/line-separator class, not just the handful of common
// bidi controls. Adapters may turn these code points into visible ASCII markers before parsing, but
// no raw invisible directionality or ill-formed UTF-16 is permitted in the durable/UI contract.
const UNSAFE_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

function byteLength(value: unknown): number {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength
}

function plainText(maxChars: number, maxBytes: number, multiline = false) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => !UNSAFE_TEXT.test(value), "contains unsafe control or bidirectional text")
    .refine((value) => multiline || (!value.includes("\n") && !value.includes("\r")), "must be a single line")
    .refine((value) => byteLength(value) <= maxBytes, `must be at most ${maxBytes} UTF-8 bytes`)
}

function plainValue(maxChars: number, maxBytes: number, multiline = false) {
  return z.string()
    .max(maxChars)
    .refine((value) => !UNSAFE_TEXT.test(value), "contains unsafe control or bidirectional text")
    .refine((value) => multiline || (!value.includes("\n") && !value.includes("\r")), "must be a single line")
    .refine((value) => byteLength(value) <= maxBytes, `must be at most ${maxBytes} UTF-8 bytes`)
}

export const InteractionOpaqueId = plainText(256, 512)
// Back-compatible protocol name; the value itself is the canonical thread identifier schema.
export const InteractionThreadSlug = ThreadSlug
export const InteractionRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const InteractionTimestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString())
export const InteractionLabel = plainText(160, 512)
export const InteractionDescription = plainText(4_000, 8_000, true)
export const InteractionPreview = plainText(16_000, 24_000, true)
  .refine((value) => value.split(/\r?\n/u).length <= 256, "must be at most 256 lines")
export const InteractionFieldId = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value), "reserved field id")
export const InteractionDecisionId = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const InteractionProvider = z.object({
  kind: z.enum(["claude", "codex", "fray"]),
  name: InteractionLabel.optional(),
  version: InteractionOpaqueId.optional(),
}).strict()
export type InteractionProvider = z.infer<typeof InteractionProvider>

export const InteractionSource = z.object({
  kind: z.enum(["runtime", "agent", "tool", "mcp-server", "fray"]),
  id: InteractionOpaqueId,
  label: InteractionLabel.optional(),
}).strict()
export type InteractionSource = z.infer<typeof InteractionSource>

export const InteractionOwner = z.object({
  projectId: InteractionOpaqueId,
  threadSlug: InteractionThreadSlug,
  sessionId: InteractionOpaqueId,
  turnId: InteractionOpaqueId,
  itemId: InteractionOpaqueId,
  sessionEpoch: InteractionRevision,
  capabilityRevision: InteractionRevision,
}).strict()
export type InteractionOwner = z.infer<typeof InteractionOwner>

export const InteractionDecisionSemantic = z.enum(["approve", "deny", "cancel", "accept", "decline", "answer"])
export type InteractionDecisionSemantic = z.infer<typeof InteractionDecisionSemantic>

export const InteractionDecision = z.object({
  id: InteractionDecisionId,
  semantic: InteractionDecisionSemantic,
  // Provider context only. Authorization UIs must make `semantic` visible with a canonical verb and
  // must never infer the security effect from this provider-controlled label.
  label: InteractionLabel,
  description: InteractionDescription.optional(),
}).strict()
export type InteractionDecision = z.infer<typeof InteractionDecision>

const InteractionNumber = z.number().finite().min(-INTERACTION_NUMBER_LIMIT).max(INTERACTION_NUMBER_LIMIT)

const InteractionScalar = z.union([
  plainValue(4_000, 8_000, true),
  InteractionNumber,
  z.boolean(),
])
export type InteractionScalar = z.infer<typeof InteractionScalar>

export const InteractionValue = z.union([
  InteractionScalar,
  z.array(plainValue(1_000, 2_000, true)).max(32),
])
export type InteractionValue = z.infer<typeof InteractionValue>

const FieldBase = {
  id: InteractionFieldId,
  label: InteractionLabel,
  description: InteractionDescription.optional(),
  required: z.boolean(),
  secret: z.boolean().default(false),
}

const InteractionChoice = z.object({
  value: InteractionScalar,
  label: InteractionLabel,
}).strict()

const InteractionMultiChoice = z.object({
  value: plainValue(1_000, 2_000, true),
  label: InteractionLabel,
}).strict()

const InteractionFieldShapeSchema = z.discriminatedUnion("input", [
  z.object({
    ...FieldBase,
    input: z.enum(["text", "multiline"]),
    minLength: z.number().int().nonnegative().max(4_000).optional(),
    maxLength: z.number().int().nonnegative().max(4_000).optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    default: plainValue(4_000, 8_000, true).optional(),
  }).strict(),
  z.object({
    ...FieldBase,
    input: z.enum(["number", "integer"]),
    minimum: InteractionNumber.optional(),
    maximum: InteractionNumber.optional(),
    default: InteractionNumber.optional(),
  }).strict(),
  z.object({
    ...FieldBase,
    input: z.literal("boolean"),
    default: z.boolean().optional(),
  }).strict(),
  z.object({
    ...FieldBase,
    input: z.literal("select"),
    options: z.array(InteractionChoice).min(1).max(64),
    default: InteractionScalar.optional(),
  }).strict(),
  z.object({
    ...FieldBase,
    input: z.literal("multi-select"),
    options: z.array(InteractionMultiChoice).min(1).max(64),
    minItems: z.number().int().nonnegative().max(32).optional(),
    maxItems: z.number().int().nonnegative().max(32).optional(),
    default: z.array(plainValue(1_000, 2_000, true)).max(32).optional(),
  }).strict(),
])
type InteractionFieldShape = z.infer<typeof InteractionFieldShapeSchema>

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// One validator shared by defaults, live submissions, and durable-record integrity checks. Keeping
// these rules at the protocol layer prevents a provider from advertising a default the user can never
// submit and prevents a corrupted/migrated journal from reintroducing a value the live store rejected.
export function validateInteractionFieldValue(field: InteractionFieldShape, value: InteractionValue): string | undefined {
  if (field.input === "text" || field.input === "multiline") {
    if (typeof value !== "string") return "must be text"
    if (field.input === "text" && (value.includes("\n") || value.includes("\r"))) return "must be a single line"
    if (field.minLength !== undefined && value.length < field.minLength) return "is shorter than minLength"
    if (field.maxLength !== undefined && value.length > field.maxLength) return "is longer than maxLength"
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "must be an email address"
    if (field.format === "uri") {
      try {
        new URL(value)
      } catch {
        return "must be a URL"
      }
    }
    if (field.format === "date" && !validCalendarDate(value)) return "must be a date"
    if (field.format === "date-time" && !InteractionTimestamp.safeParse(value).success) return "must be a date-time"
    return undefined
  }
  if (field.input === "number" || field.input === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number"
    if (field.input === "integer" && !Number.isInteger(value)) return "must be an integer"
    if (field.minimum !== undefined && value < field.minimum) return "is below minimum"
    if (field.maximum !== undefined && value > field.maximum) return "is above maximum"
    return undefined
  }
  if (field.input === "boolean") return typeof value === "boolean" ? undefined : "must be a boolean"
  if (field.input === "select") {
    if (Array.isArray(value)) return "must be one option"
    return field.options.some((option) => JSON.stringify(option.value) === JSON.stringify(value))
      ? undefined
      : "is not an advertised option"
  }
  if (field.input === "multi-select") {
    if (!Array.isArray(value)) return "must be a list of options"
    if (new Set(value).size !== value.length) return "contains duplicate options"
    if (field.minItems !== undefined && value.length < field.minItems) return "contains fewer than minItems"
    if (field.maxItems !== undefined && value.length > field.maxItems) return "contains more than maxItems"
    return value.every((candidate) => field.options.some((option) => option.value === candidate))
      ? undefined
      : "contains an unadvertised option"
  }
  return "has an unsupported input type"
}

export const InteractionField = InteractionFieldShapeSchema.superRefine((field, ctx) => {
  if (field.secret && field.default !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret fields cannot advertise defaults", path: ["default"] })
  }
  if (field.input === "text" || field.input === "multiline") {
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minLength exceeds maxLength" })
    }
  }
  if (field.input === "number" || field.input === "integer") {
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minimum exceeds maximum" })
    }
  }
  if (field.input === "select" || field.input === "multi-select") {
    const seen = new Set<string>()
    for (const [index, option] of field.options.entries()) {
      const key = JSON.stringify(option.value)
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate option value", path: ["options", index, "value"] })
      seen.add(key)
    }
    if (field.input === "multi-select" && field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minItems exceeds maxItems" })
    }
  }
  if (field.default !== undefined) {
    const error = validateInteractionFieldValue(field, field.default)
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid default: ${error}`, path: ["default"] })
  }
})
export type InteractionField = z.infer<typeof InteractionField>

const CommonPayload = {
  title: InteractionLabel,
  message: InteractionDescription.optional(),
}

// Authorization displays keep security-relevant structure separate from provider prose. Adapters
// construct these values from provider protocols after redaction and bounding; React renders every
// string as text, never as HTML or Markdown.
export const InteractionCommandAction = z.object({
  kind: z.enum(["read", "list-files", "search", "unknown"]),
  commandPreview: InteractionPreview,
  resourceLabel: plainText(2_048, 4_096).optional(),
  queryLabel: plainText(1_024, 2_048).optional(),
}).strict()
export type InteractionCommandAction = z.infer<typeof InteractionCommandAction>

const InteractionResourceLabel = plainText(2_048, 4_096)
export const InteractionCapability = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("network"),
    enabled: z.boolean().nullable(),
    hosts: z.array(InteractionResourceLabel).max(24),
  }).strict(),
  z.object({
    kind: z.literal("filesystem"),
    access: z.enum(["read", "write", "deny"]),
    resources: z.array(InteractionResourceLabel).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal("glob-scan"),
    depth: z.number().int().nonnegative().max(256),
  }).strict(),
  z.object({
    kind: z.literal("exec-policy"),
    prefixes: z.array(InteractionResourceLabel).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal("network-policy"),
    access: z.enum(["allow", "deny"]),
    hosts: z.array(InteractionResourceLabel).min(1).max(24),
  }).strict(),
])
export type InteractionCapability = z.infer<typeof InteractionCapability>

export const InteractionFileChangeDisplay = z.object({
  operation: z.enum(["create", "write", "move", "delete"]),
  pathLabel: plainText(2_048, 4_096),
  destinationLabel: plainText(2_048, 4_096).optional(),
  // Display-only, bounded plain text. This value is never parsed or applied as a patch by Fray.
  diffPreview: InteractionPreview.optional(),
}).strict()
export type InteractionFileChangeDisplay = z.infer<typeof InteractionFileChangeDisplay>

export const InteractionPayload = z.discriminatedUnion("kind", [
  z.object({
    ...CommonPayload,
    kind: z.literal("command-approval"),
    command: z.object({
      summary: InteractionLabel,
      // Adapters must redact credentials/environment/stdin before constructing this preview. The
      // literal makes accidentally passing an unreviewed raw command shape a schema error.
      preview: InteractionPreview,
      redacted: z.literal(true),
      workingDirectoryLabel: plainText(1_024, 2_048).optional(),
      actions: z.array(InteractionCommandAction).max(16).optional(),
    }).strict(),
    capabilities: z.array(InteractionCapability).max(32).optional(),
  }).strict(),
  z.object({
    ...CommonPayload,
    kind: z.literal("file-approval"),
    operation: z.enum(["read", "create", "write", "move", "delete", "execute", "other"]),
    pathLabel: plainText(1_024, 2_048),
    destinationLabel: plainText(1_024, 2_048).optional(),
    // `grantRoot` in the pinned Codex protocol is broader than an affected path: accepting for the
    // session authorizes writes below this root for the rest of that session. Keep it separately
    // labeled so the affected-file summary cannot disguise the durable scope.
    grantRootLabel: plainText(2_048, 4_096).optional(),
    scopeLabel: InteractionDescription.optional(),
    // Plain-text, bounded preview only. It is never a trusted patch and must never be applied by Fray.
    diffPreview: InteractionPreview.optional(),
    changes: z.array(InteractionFileChangeDisplay).min(1).max(16).optional(),
  }).strict(),
  z.object({
    ...CommonPayload,
    kind: z.literal("permission-approval"),
    permission: InteractionOpaqueId,
    resourceLabel: plainText(1_024, 2_048).optional(),
    workingDirectoryLabel: plainText(1_024, 2_048).optional(),
    scopeLabel: InteractionDescription.optional(),
    capabilities: z.array(InteractionCapability).min(1).max(32).optional(),
  }).strict(),
  z.object({
    kind: z.literal("mcp-elicitation-form"),
    title: InteractionLabel,
    message: InteractionDescription,
    protocolVersion: InteractionOpaqueId,
    fields: z.array(InteractionField).max(32),
  }).strict(),
  z.object({
    kind: z.literal("mcp-elicitation-url"),
    title: InteractionLabel,
    message: InteractionDescription,
    protocolVersion: InteractionOpaqueId,
    elicitationId: InteractionOpaqueId,
    // URL-mode consent is explicit. Consumers must display the complete URL and must not prefetch it.
    url: z.string().min(1).max(2_048).url().superRefine((value, ctx) => {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return
      }
      const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      if (url.protocol !== "https:" && !localHttp) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL elicitation requires HTTPS (except localhost development)" })
      }
      if (url.username || url.password) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL elicitation must not contain userinfo credentials" })
      }
    }),
  }).strict(),
  z.object({
    kind: z.literal("agent-question"),
    title: InteractionLabel,
    message: InteractionDescription.optional(),
    fields: z.array(InteractionField).min(1).max(32),
  }).strict(),
])
export type InteractionPayload = z.infer<typeof InteractionPayload>

const InteractionRequestObject = z.object({
  protocolVersion: z.literal(INTERACTION_PROTOCOL_VERSION),
  contentFormat: z.literal("plain-text"),
  provider: InteractionProvider,
  source: InteractionSource,
  owner: InteractionOwner,
  providerRequestId: InteractionOpaqueId,
  allowedDecisions: z.array(InteractionDecision).min(1).max(8),
  payload: InteractionPayload,
  expiresAt: InteractionTimestamp.nullable(),
}).strict()

const semanticsForKind: Record<InteractionPayload["kind"], ReadonlySet<InteractionDecisionSemantic>> = {
  "command-approval": new Set(["approve", "deny", "cancel"]),
  "file-approval": new Set(["approve", "deny", "cancel"]),
  "permission-approval": new Set(["approve", "deny", "cancel"]),
  "mcp-elicitation-form": new Set(["accept", "decline", "cancel"]),
  "mcp-elicitation-url": new Set(["accept", "decline", "cancel"]),
  "agent-question": new Set(["answer", "decline", "cancel"]),
}

function validateInteractionRequest(value: z.infer<typeof InteractionRequestObject>, ctx: z.RefinementCtx): void {
  const allowedSemantics = semanticsForKind[value.payload.kind]
  const decisionIds = new Set<string>()
  for (const [index, decision] of value.allowedDecisions.entries()) {
    if (decisionIds.has(decision.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate decision id", path: ["allowedDecisions", index, "id"] })
    }
    decisionIds.add(decision.id)
    if (!allowedSemantics.has(decision.semantic)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `decision is invalid for ${value.payload.kind}`, path: ["allowedDecisions", index, "semantic"] })
    }
  }

  const fields = value.payload.kind === "mcp-elicitation-form" || value.payload.kind === "agent-question"
    ? value.payload.fields
    : []
  const fieldIds = new Set<string>()
  for (const [index, field] of fields.entries()) {
    if (fieldIds.has(field.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate field id", path: ["payload", "fields", index, "id"] })
    fieldIds.add(field.id)
    // MCP form mode is explicitly non-secret; sensitive flows belong in URL mode. Agent questions may
    // mark an input secret, in which case the store validates it transiently and persists only a marker.
    if (value.payload.kind === "mcp-elicitation-form" && field.secret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "MCP form elicitation cannot request secret fields; use URL mode", path: ["payload", "fields", index, "secret"] })
    }
  }

  // This validator is also reused by InteractionRecord. Measure only the wire request so durable
  // lifecycle metadata does not make a request valid at create time but unreadable after journaling.
  const requestOnly = {
    protocolVersion: value.protocolVersion,
    contentFormat: value.contentFormat,
    provider: value.provider,
    source: value.source,
    owner: value.owner,
    providerRequestId: value.providerRequestId,
    allowedDecisions: value.allowedDecisions,
    payload: value.payload,
    expiresAt: value.expiresAt,
  }
  if (byteLength(requestOnly) > INTERACTION_REQUEST_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `interaction request exceeds ${INTERACTION_REQUEST_MAX_BYTES} bytes` })
  }
}

export const InteractionRequest = InteractionRequestObject.superRefine(validateInteractionRequest)
export type InteractionRequest = z.infer<typeof InteractionRequest>

export const InteractionLifecycle = z.enum(["pending", "resolved", "cancelled", "expired"])
export type InteractionLifecycle = z.infer<typeof InteractionLifecycle>

// Provider-neutral delivery authority projected by scoped server reads. This is deliberately an
// effect rather than a provider transport state: React must not learn provider ids, RPC request ids,
// response payloads, or adapter-specific labels in order to decide whether an action is safe.
//
// Absence means the interaction is journal-owned and follows its lifecycle. For provider-backed
// requests, only `awaiting-user` permits a decision submission. `sending` means an answer is already
// durably queued or has crossed the ambiguous write boundary; `reconnect-required` is fail-closed
// until the owning bridge can safely accept the first response.
export const InteractionDeliveryEffect = z.enum(["awaiting-user", "sending", "reconnect-required"])
export type InteractionDeliveryEffect = z.infer<typeof InteractionDeliveryEffect>

export const InteractionDelivery = z.object({
  effect: InteractionDeliveryEffect,
}).strict()
export type InteractionDelivery = z.infer<typeof InteractionDelivery>

export const InteractionCancellationReason = z.enum([
  "user-cancelled",
  "provider-cancelled",
  "turn-ended",
  "session-replaced",
  "session-deleted",
  "capabilities-changed",
  "expired",
])
export type InteractionCancellationReason = z.infer<typeof InteractionCancellationReason>

export const InteractionValues = z.record(InteractionFieldId, InteractionValue).superRefine((values, ctx) => {
  if (Object.keys(values).length > 32) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "too many response fields" })
  if (byteLength(values) > INTERACTION_RESPONSE_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `interaction response exceeds ${INTERACTION_RESPONSE_MAX_BYTES} bytes` })
  }
})
export type InteractionValues = z.infer<typeof InteractionValues>

export const InteractionResolution = z.object({
  responseId: InteractionOpaqueId,
  decisionId: InteractionDecisionId,
  values: InteractionValues.optional(),
  // Secret response values are absent from `values`; only their field ids survive persistence.
  redactedFieldIds: z.array(InteractionFieldId).max(32),
  resolvedAt: InteractionTimestamp,
}).strict()
export type InteractionResolution = z.infer<typeof InteractionResolution>

export const InteractionRecord = InteractionRequestObject.extend({
  id: InteractionOpaqueId,
  lifecycle: InteractionLifecycle,
  delivery: InteractionDelivery.optional(),
  recordRevision: InteractionRevision,
  createdAt: InteractionTimestamp,
  updatedAt: InteractionTimestamp,
  completedAt: InteractionTimestamp.nullable(),
  resolution: InteractionResolution.nullable(),
  cancellationReason: InteractionCancellationReason.nullable(),
}).strict().superRefine((value, ctx) => {
  validateInteractionRequest(value, ctx)
  if (value.delivery && value.lifecycle !== "pending") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "terminal interaction cannot advertise a delivery effect" })
  }
  if (value.lifecycle === "pending") {
    if (value.completedAt || value.resolution || value.cancellationReason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pending interaction has terminal data" })
    if (value.recordRevision !== 0 || value.updatedAt !== value.createdAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pending interaction has invalid revision or timestamps" })
    }
  } else if (!value.completedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "terminal interaction is missing completedAt" })
  } else {
    if (value.recordRevision < 1 || value.updatedAt !== value.completedAt || value.updatedAt < value.createdAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "terminal interaction has invalid revision or timestamps" })
    }
  }
  if (value.lifecycle === "resolved") {
    if (!value.resolution || value.cancellationReason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolved interaction has invalid terminal data" })
  } else if (value.resolution) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "non-resolved interaction contains a resolution" })
  }
  if (value.lifecycle === "cancelled" && (!value.cancellationReason || value.cancellationReason === "expired")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cancelled interaction has invalid reason" })
  }
  if (value.lifecycle === "expired" && value.cancellationReason !== "expired") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expired interaction has invalid reason" })
  }
  if (value.resolution) {
    if (value.resolution.resolvedAt !== value.completedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolution timestamp does not match its terminal record" })
    }
    const decision = value.allowedDecisions.find((candidate) => candidate.id === value.resolution!.decisionId)
    if (!decision) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolution names an unadvertised decision", path: ["resolution", "decisionId"] })
    }
    const fields = value.payload.kind === "mcp-elicitation-form" || value.payload.kind === "agent-question"
      ? value.payload.fields
      : []
    const byId = new Map(fields.map((field) => [field.id, field]))
    const redactedIds = new Set(value.resolution.redactedFieldIds)
    if (redactedIds.size !== value.resolution.redactedFieldIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolution contains duplicate redaction markers", path: ["resolution", "redactedFieldIds"] })
    }
    for (const id of value.resolution.redactedFieldIds) {
      if (!byId.get(id)?.secret) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "redaction marker does not name a secret field", path: ["resolution", "redactedFieldIds"] })
    }
    for (const [id, responseValue] of Object.entries(value.resolution.values ?? {})) {
      const field = byId.get(id)
      if (!field) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolution contains an unadvertised field", path: ["resolution", "values", id] })
      } else if (field.secret) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret value persisted in resolution", path: ["resolution", "values", id] })
      } else if (validateInteractionFieldValue(field, responseValue)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "persisted response failed advertised validation", path: ["resolution", "values", id] })
      }
    }
    if (decision) {
      const expectsValues = (value.payload.kind === "mcp-elicitation-form" && decision.semantic === "accept") ||
        (value.payload.kind === "agent-question" && decision.semantic === "answer")
      if (!expectsValues) {
        if (value.resolution.values !== undefined || value.resolution.redactedFieldIds.length > 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolution decision cannot contain response fields", path: ["resolution"] })
        }
      } else {
        for (const field of fields) {
          const supplied = field.secret
            ? redactedIds.has(field.id)
            : Object.prototype.hasOwnProperty.call(value.resolution.values ?? {}, field.id)
          if (field.required && !supplied) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resolution is missing a required field", path: ["resolution", "values", field.id] })
          }
        }
      }
    }
  }
})
export type InteractionRecord = z.infer<typeof InteractionRecord>

export const ListInteractionsInput = z.object({
  slug: InteractionThreadSlug,
  sessionId: InteractionOpaqueId,
}).strict()
export type ListInteractionsInput = z.infer<typeof ListInteractionsInput>

export const ListInteractionsResult = z.object({ interactions: z.array(InteractionRecord).max(INTERACTION_LIST_MAX) }).strict()
export type ListInteractionsResult = z.infer<typeof ListInteractionsResult>

export const GetInteractionInput = ListInteractionsInput.extend({ interactionId: InteractionOpaqueId }).strict()
export type GetInteractionInput = z.infer<typeof GetInteractionInput>

export const GetInteractionResult = z.object({ interaction: InteractionRecord }).strict()
export type GetInteractionResult = z.infer<typeof GetInteractionResult>

export const ResolveInteractionInput = GetInteractionInput.extend({
  sessionEpoch: InteractionRevision,
  capabilityRevision: InteractionRevision,
  expectedRecordRevision: InteractionRevision,
  responseId: InteractionOpaqueId,
  decisionId: InteractionDecisionId,
  values: InteractionValues.optional(),
}).strict()
export type ResolveInteractionInput = z.infer<typeof ResolveInteractionInput>

export const ResolveInteractionResult = z.object({
  // Provider-backed interactions remain pending until the provider acknowledges the delivered
  // response. `queued` is therefore a truthful intermediate result, not an optimistic resolution.
  effect: z.enum(["resolved", "already-resolved", "queued", "already-queued"]),
  interaction: InteractionRecord,
}).strict()
export type ResolveInteractionResult = z.infer<typeof ResolveInteractionResult>

export const CancelInteractionInput = GetInteractionInput.extend({
  sessionEpoch: InteractionRevision,
  capabilityRevision: InteractionRevision,
  expectedRecordRevision: InteractionRevision,
}).strict()
export type CancelInteractionInput = z.infer<typeof CancelInteractionInput>

export const CancelInteractionResult = z.object({
  effect: z.enum(["cancelled", "already-cancelled"]),
  interaction: InteractionRecord,
}).strict()
export type CancelInteractionResult = z.infer<typeof CancelInteractionResult>
