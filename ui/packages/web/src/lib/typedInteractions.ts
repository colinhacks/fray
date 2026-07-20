import {
  InteractionValues,
  validateInteractionFieldValue,
  type InteractionDecision,
  type InteractionDecisionSemantic,
  type InteractionDeliveryEffect,
  type InteractionField,
  type InteractionPayload,
  type InteractionProvider,
  type InteractionRecord,
  type InteractionSource,
  type InteractionValue,
  type InteractionValues as InteractionValuesType,
} from "@fray-ui/shared"

export interface InteractionDeliveryPresentation {
  actionsEnabled: boolean
  eyebrow: "Needs you" | "Sending" | "Runtime unavailable"
  status?: string
}

// One provider-neutral decision gate shared by every typed card render. In particular, a remount has
// no local mutation state to lean on: the durable delivery effect alone must keep ambiguous responses
// from becoming clickable again.
export function interactionDeliveryPresentation(
  effect: InteractionDeliveryEffect | undefined,
): InteractionDeliveryPresentation {
  if (effect === "sending") {
    return { actionsEnabled: false, eyebrow: "Sending", status: "Sending to runtime…" }
  }
  if (effect === "reconnect-required") {
    return {
      actionsEnabled: false,
      eyebrow: "Runtime unavailable",
      status: "Runtime reconnect required before this request can be answered.",
    }
  }
  return { actionsEnabled: true, eyebrow: "Needs you" }
}

export type DecisionTone = "primary" | "danger" | "neutral"

export interface CanonicalInteractionDecision {
  id: string
  semantic: InteractionDecisionSemantic
  label: string
  order: number
  tone: DecisionTone
  durable: boolean
  scope: string
  requiresValues: boolean
}

interface DecisionSpec extends Omit<CanonicalInteractionDecision, "id" | "semantic" | "requiresValues"> {
  semantic: InteractionDecisionSemantic
}

const ONCE_APPROVE: DecisionSpec = {
  semantic: "approve",
  label: "Approve once",
  order: 10,
  tone: "primary",
  durable: false,
  scope: "Applies only to this request.",
}
const SESSION_APPROVE: DecisionSpec = {
  semantic: "approve",
  label: "Approve for session",
  order: 20,
  tone: "primary",
  durable: true,
  scope: "Persists for later matching requests in this thread session.",
}
const TURN_GRANT: DecisionSpec = {
  semantic: "approve",
  label: "Grant for turn",
  order: 10,
  tone: "primary",
  durable: false,
  scope: "Applies to this turn only.",
}
const SESSION_GRANT: DecisionSpec = {
  semantic: "approve",
  label: "Grant for session",
  order: 20,
  tone: "primary",
  durable: true,
  scope: "Persists until this thread session ends.",
}
const DENY: DecisionSpec = {
  semantic: "deny",
  label: "Deny",
  order: 70,
  tone: "danger",
  durable: false,
  scope: "Rejects this request.",
}
const DECLINE: DecisionSpec = {
  semantic: "decline",
  label: "Decline",
  order: 70,
  tone: "danger",
  durable: false,
  scope: "Declines this request.",
}
const CANCEL: DecisionSpec = {
  semantic: "cancel",
  label: "Cancel request",
  order: 80,
  tone: "neutral",
  durable: false,
  scope: "Cancels this pending request.",
}

function specFor(payload: InteractionPayload, decision: InteractionDecision): DecisionSpec | undefined {
  const { id, semantic } = decision
  if (payload.kind === "command-approval" || payload.kind === "file-approval") {
    if ((id === "accept" || id === "approve-once") && semantic === "approve") return ONCE_APPROVE
    if (id === "acceptForSession" && semantic === "approve") return SESSION_APPROVE
    if ((id === "decline" || id === "deny") && semantic === "deny") return DENY
    if (id === "cancel" && semantic === "cancel") return CANCEL
    return undefined
  }
  if (payload.kind === "permission-approval") {
    if (id === "grant-turn" && semantic === "approve") return TURN_GRANT
    if (id === "grant-session" && semantic === "approve") return SESSION_GRANT
    if ((id === "deny" || id === "decline") && semantic === "deny") return DENY
    if (id === "cancel" && semantic === "cancel") return CANCEL
    return undefined
  }
  if (payload.kind === "mcp-elicitation-form" || payload.kind === "mcp-elicitation-url") {
    if (id === "accept" && semantic === "accept") {
      return {
        semantic: "accept",
        label: payload.kind === "mcp-elicitation-form" ? "Submit" : "Continue",
        order: 10,
        tone: "primary",
        durable: false,
        scope: "Applies only to this request.",
      }
    }
    if (id === "decline" && semantic === "decline") return DECLINE
    if (id === "cancel" && semantic === "cancel") return CANCEL
    return undefined
  }
  if (id === "answer" && semantic === "answer") {
    return {
      semantic: "answer",
      label: "Send answer",
      order: 10,
      tone: "primary",
      durable: false,
      scope: "Sends these answers to this request only.",
    }
  }
  if (id === "decline" && semantic === "decline") return DECLINE
  if (id === "cancel" && semantic === "cancel") return CANCEL
  return undefined
}

export function canonicalInteractionDecisions(record: Pick<InteractionRecord, "payload" | "allowedDecisions">): CanonicalInteractionDecision[] {
  const requiresValues = (semantic: InteractionDecisionSemantic) =>
    (record.payload.kind === "mcp-elicitation-form" && semantic === "accept") ||
    (record.payload.kind === "agent-question" && semantic === "answer")
  return record.allowedDecisions
    .flatMap((decision) => {
      const spec = specFor(record.payload, decision)
      return spec ? [{ ...spec, id: decision.id, semantic: decision.semantic, requiresValues: requiresValues(decision.semantic) }] : []
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

export function interactionKindLabel(kind: InteractionPayload["kind"]): string {
  switch (kind) {
    case "command-approval": return "Command approval"
    case "file-approval": return "File approval"
    case "permission-approval": return "Permission approval"
    case "mcp-elicitation-form": return "MCP request"
    case "mcp-elicitation-url": return "MCP authorization"
    case "agent-question": return "Agent question"
  }
}

export function interactionProviderLabel(kind: InteractionProvider["kind"]): string {
  switch (kind) {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "fray": return "Fray"
  }
}

export function interactionSourceLabel(kind: InteractionSource["kind"]): string {
  switch (kind) {
    case "runtime": return "Runtime"
    case "agent": return "Agent"
    case "tool": return "Tool"
    case "mcp-server": return "MCP server"
    case "fray": return "Fray"
  }
}

export type InteractionDraftValue = string | boolean | string[]
export type InteractionDraft = Record<string, InteractionDraftValue>

function choiceIndex(field: Extract<InteractionField, { input: "select" }>, value: InteractionValue): string {
  const index = field.options.findIndex((option) => JSON.stringify(option.value) === JSON.stringify(value))
  return index < 0 ? "" : String(index)
}

export function initialInteractionDraft(fields: readonly InteractionField[]): InteractionDraft {
  const draft: InteractionDraft = Object.create(null) as InteractionDraft
  for (const field of fields) {
    if (field.input === "text" || field.input === "multiline") draft[field.id] = field.default ?? ""
    else if (field.input === "number" || field.input === "integer") draft[field.id] = field.default === undefined ? "" : String(field.default)
    else if (field.input === "boolean") draft[field.id] = field.default ?? false
    else if (field.input === "select") draft[field.id] = field.default === undefined ? "" : choiceIndex(field, field.default)
    else if (field.input === "multi-select") {
      const defaults = new Set(field.default ?? [])
      draft[field.id] = field.options.flatMap((option, index) => defaults.has(option.value) ? [String(index)] : [])
    }
  }
  return draft
}

export function updateInteractionDraft(
  draft: InteractionDraft,
  id: string,
  value: InteractionDraftValue,
): InteractionDraft {
  const next: InteractionDraft = Object.create(null) as InteractionDraft
  for (const key of Object.keys(draft)) next[key] = draft[key]
  next[id] = value
  return next
}

export interface ParsedInteractionDraft {
  values?: InteractionValuesType
  errors: Record<string, string>
  formError?: string
}

export function parseInteractionDraft(fields: readonly InteractionField[], draft: InteractionDraft): ParsedInteractionDraft {
  if (fields.some((field) => field.secret)) {
    return {
      errors: {},
      formError: "Secret responses cannot be sent through this Fray connection.",
    }
  }
  const values: Record<string, InteractionValue> = Object.create(null) as Record<string, InteractionValue>
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const raw = draft[field.id]
    let value: InteractionValue | undefined
    if (field.input === "text" || field.input === "multiline") {
      const text = typeof raw === "string" ? raw : ""
      if (!field.required && text === "") continue
      if (field.required && text === "") errors[field.id] = "This field is required."
      else value = text
    } else if (field.input === "number" || field.input === "integer") {
      const text = typeof raw === "string" ? raw.trim() : ""
      if (!field.required && text === "") continue
      if (text === "") errors[field.id] = "This field is required."
      else {
        const number = Number(text)
        if (!Number.isFinite(number)) errors[field.id] = "Enter a valid number."
        else value = number
      }
    } else if (field.input === "boolean") {
      value = raw === true
    } else if (field.input === "select") {
      const index = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : -1
      if (index < 0 || index >= field.options.length) {
        if (field.required) errors[field.id] = "Choose an option."
        else continue
      } else value = field.options[index].value
    } else if (field.input === "multi-select") {
      const tokens = Array.isArray(raw) ? raw : []
      const indexes = tokens.flatMap((token) => /^\d+$/.test(token) ? [Number(token)] : [])
      if (indexes.some((index) => index < 0 || index >= field.options.length)) {
        errors[field.id] = "Choose only advertised options."
      } else if (field.required && indexes.length === 0) {
        errors[field.id] = "Choose at least one option."
      } else if (indexes.length > 0) {
        value = indexes.map((index) => field.options[index].value)
      } else continue
    }
    if (value !== undefined && !errors[field.id]) {
      const validationError = validateInteractionFieldValue(field, value)
      if (validationError) errors[field.id] = `Value ${validationError}.`
      else values[field.id] = value
    }
  }
  if (Object.keys(errors).length > 0) return { errors }
  const parsed = InteractionValues.safeParse(values)
  if (!parsed.success) return { errors, formError: "The response is too large or contains invalid values." }
  return { errors, values: parsed.data }
}

export function interactionDecisionSignature(decisionId: string, values?: InteractionValuesType): string {
  return JSON.stringify([decisionId, values ?? null])
}
