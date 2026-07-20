// Provider-local protocol for the disabled Claude Agent SDK foundation. Nothing in this file imports
// the Anthropic SDK: callers depend on these bounded, versioned shapes rather than on an expansive
// provider type union. The adapter is the sole translation boundary.

export const CLAUDE_AGENT_SDK_PROTOCOL_VERSION = 1 as const
export const CLAUDE_AGENT_SDK_MAX_INPUT_BYTES = 64 * 1024
export const CLAUDE_AGENT_SDK_MAX_JSON_BYTES = 64 * 1024
export const CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES = 128 * 1024
export const CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES = 4 * 1024
export const CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS = 64
export const CLAUDE_AGENT_SDK_MAX_QUEUED_EVENTS = 256

const encoder = new TextEncoder()
// Keep ordinary tab/newline/CR available to message bodies, but reject the rest of the Unicode
// control/format/surrogate/line-separator families. Enumerating only the familiar bidi controls
// misses newer/deprecated format controls, tag characters, and lone surrogates.
const UNSAFE_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

export type ClaudeJsonScalar = string | number | boolean | null
export type ClaudeJson = ClaudeJsonScalar | ClaudeJson[] | { [key: string]: ClaudeJson }
export type ClaudeJsonObject = { [key: string]: ClaudeJson }

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"

export interface ClaudeInputMessage {
  id: string
  text: string
}

export interface ClaudeCommandCapability {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
}

export interface ClaudeModelCapability {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort: boolean
  supportedEffortLevels: string[]
  supportsAdaptiveThinking: boolean
  supportsFastMode: boolean
}

export interface ClaudeAgentCapability {
  name: string
  description: string
  model?: string
}

export interface ClaudeControlInitialization {
  commands: ClaudeCommandCapability[]
  agents: ClaudeAgentCapability[]
  outputStyle: string
  availableOutputStyles: string[]
  models: ClaudeModelCapability[]
}

export interface ClaudeSessionInitEvent {
  kind: "init"
  protocolVersion: typeof CLAUDE_AGENT_SDK_PROTOCOL_VERSION
  sessionId: string
  messageId: string
  claudeCodeVersion: string
  cwd: string
  model: string
  permissionMode: ClaudePermissionMode
  tools: string[]
  mcpServers: Array<{ name: string; status: string }>
  slashCommands: string[]
  skills: string[]
  plugins: Array<{ name: string; path: string }>
  capabilities: string[]
}

export interface ClaudeAssistantEvent {
  kind: "assistant"
  sessionId: string
  messageId: string
  parentToolUseId?: string
  text: string[]
  toolUses: Array<{ id: string; name: string; input: ClaudeJsonObject }>
  supersedes: string[]
}

export interface ClaudeUserEvent {
  kind: "user"
  sessionId?: string
  messageId?: string
  parentToolUseId?: string
  text: string[]
  toolResultIds: string[]
  synthetic: boolean
}

export interface ClaudeResultEvent {
  kind: "result"
  sessionId: string
  messageId: string
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
  isError: boolean
  stopReason?: string
  result?: string
  errors: string[]
}

export interface ClaudePromptSuggestionEvent {
  kind: "prompt-suggestion"
  sessionId: string
  messageId: string
  suggestion: string
}

export interface ClaudeOtherEvent {
  kind: "other"
  type: string
  subtype?: string
  sessionId?: string
  messageId?: string
}

export type ClaudeQueryEvent =
  | ClaudeSessionInitEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudePromptSuggestionEvent
  | ClaudeOtherEvent

export interface ClaudePermissionRequest {
  requestId: string
  toolUseId: string
  agentId?: string
  toolName: string
  input: ClaudeJsonObject
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  description?: string
  suggestions: ClaudeJsonObject[]
}

export type ClaudePermissionDecision =
  | { behavior: "allow"; updatedInput?: ClaudeJsonObject; updatedPermissions?: ClaudeJsonObject[] }
  | { behavior: "deny"; message: string; interrupt?: boolean }

export interface ClaudeElicitationRequest {
  serverName: string
  message: string
  mode?: "form" | "url"
  url?: string
  elicitationId?: string
  requestedSchema?: ClaudeJsonObject
  title?: string
  displayName?: string
  description?: string
}

export type ClaudeElicitationResult =
  | { action: "accept"; content?: ClaudeJsonObject }
  | { action: "decline" | "cancel" }

export interface ClaudeInterruptReceipt {
  stillQueued: string[]
}

export type ClaudeDiagnostic =
  | { kind: "stderr"; message: string; truncated: boolean }
  | { kind: "lifecycle"; phase: "started" | "closed" | "crashed"; message?: string }

export type ClaudeCanUseTool = (
  request: ClaudePermissionRequest,
  context: { signal: AbortSignal },
) => Promise<ClaudePermissionDecision>

export type ClaudeOnElicitation = (
  request: ClaudeElicitationRequest,
  context: { signal: AbortSignal },
) => Promise<ClaudeElicitationResult>

export class ClaudeAgentSdkProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaudeAgentSdkProtocolError"
  }
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

export function safeText(value: unknown, label: string, maxBytes = CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES): string {
  if (typeof value !== "string") throw new ClaudeAgentSdkProtocolError(`${label} must be text`)
  const cleaned = value.replace(UNSAFE_TEXT, "�")
  if (utf8Bytes(cleaned) <= maxBytes) return cleaned
  let low = 0
  let high = cleaned.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8Bytes(cleaned.slice(0, middle)) <= maxBytes - utf8Bytes("…")) low = middle
    else high = middle - 1
  }
  return `${cleaned.slice(0, low)}…`
}

export function boundedId(value: unknown, label: string): string {
  const id = safeText(value, label, 512)
  if (id.length > 256 || !ID_PATTERN.test(id)) throw new ClaudeAgentSdkProtocolError(`${label} is not a valid opaque id`)
  return id
}

export function boundedOptionalId(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : boundedId(value, label)
}

export function boundedStringArray(value: unknown, label: string, maxItems = 128, itemBytes = 512): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ClaudeAgentSdkProtocolError(`${label} must be a bounded list`)
  return value.map((entry, index) => safeText(entry, `${label}[${index}]`, itemBytes))
}

export function boundedJsonObject(value: unknown, label: string, maxBytes = CLAUDE_AGENT_SDK_MAX_JSON_BYTES): ClaudeJsonObject {
  const state = { nodes: 0 }
  const clone = boundedJson(value, label, state, 0)
  if (clone === null || Array.isArray(clone) || typeof clone !== "object") {
    throw new ClaudeAgentSdkProtocolError(`${label} must be a JSON object`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(clone)
  } catch {
    throw new ClaudeAgentSdkProtocolError(`${label} is not JSON serializable`)
  }
  if (utf8Bytes(encoded) > maxBytes) throw new ClaudeAgentSdkProtocolError(`${label} exceeds ${maxBytes} bytes`)
  return clone
}

function boundedJson(value: unknown, label: string, state: { nodes: number }, depth: number): ClaudeJson {
  state.nodes += 1
  if (state.nodes > 2_048 || depth > 12) throw new ClaudeAgentSdkProtocolError(`${label} is too complex`)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ClaudeAgentSdkProtocolError(`${label} contains a non-finite number`)
    return value
  }
  if (typeof value === "string") {
    if (utf8Bytes(value) > 16 * 1024) throw new ClaudeAgentSdkProtocolError(`${label} contains oversized text`)
    if (UNSAFE_TEXT.test(value)) {
      UNSAFE_TEXT.lastIndex = 0
      throw new ClaudeAgentSdkProtocolError(`${label} contains unsafe text`)
    }
    UNSAFE_TEXT.lastIndex = 0
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new ClaudeAgentSdkProtocolError(`${label} contains too many array items`)
    return value.map((entry, index) => boundedJson(entry, `${label}[${index}]`, state, depth + 1))
  }
  if (!value || typeof value !== "object") throw new ClaudeAgentSdkProtocolError(`${label} contains a non-JSON value`)
  const entries = Object.entries(value)
  if (entries.length > 256) throw new ClaudeAgentSdkProtocolError(`${label} contains too many object fields`)
  const output: ClaudeJsonObject = {}
  for (const [key, entry] of entries) {
    if (RESERVED_KEYS.has(key) || utf8Bytes(key) > 256 || UNSAFE_TEXT.test(key)) {
      UNSAFE_TEXT.lastIndex = 0
      throw new ClaudeAgentSdkProtocolError(`${label} contains an invalid object key`)
    }
    UNSAFE_TEXT.lastIndex = 0
    output[key] = boundedJson(entry, `${label}.${key}`, state, depth + 1)
  }
  return output
}

export function validateInputMessage(value: ClaudeInputMessage): ClaudeInputMessage {
  const id = boundedId(value.id, "input.id")
  if (typeof value.text !== "string") throw new ClaudeAgentSdkProtocolError("input.text must be text")
  if (utf8Bytes(value.text) > CLAUDE_AGENT_SDK_MAX_INPUT_BYTES) {
    throw new ClaudeAgentSdkProtocolError(`input.text exceeds ${CLAUDE_AGENT_SDK_MAX_INPUT_BYTES} bytes`)
  }
  const text = safeText(value.text, "input.text", CLAUDE_AGENT_SDK_MAX_INPUT_BYTES)
  // User input is an authority-bearing provider instruction, not presentation metadata. Never
  // silently replace controls or truncate after replacement expansion: the accepted bytes must be
  // exactly the bytes the caller supplied.
  if (text !== value.text) throw new ClaudeAgentSdkProtocolError("input.text contains unsafe text")
  return { id, text }
}

export function validatePermissionMode(value: unknown): ClaudePermissionMode {
  if (typeof value === "string" && ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(value)) {
    return value as ClaudePermissionMode
  }
  throw new ClaudeAgentSdkProtocolError("permission mode is unsupported")
}

export function validatePermissionDecision(value: ClaudePermissionDecision): ClaudePermissionDecision {
  if (!value || typeof value !== "object") throw new ClaudeAgentSdkProtocolError("permission decision must be an object")
  if (value.behavior === "allow") {
    if (value.updatedPermissions !== undefined && (!Array.isArray(value.updatedPermissions) || value.updatedPermissions.length > 32)) {
      throw new ClaudeAgentSdkProtocolError("permission.updatedPermissions must be a bounded list")
    }
    return {
      behavior: "allow",
      ...(value.updatedInput === undefined ? {} : { updatedInput: boundedJsonObject(value.updatedInput, "permission.updatedInput") }),
      ...(value.updatedPermissions === undefined ? {} : {
        updatedPermissions: value.updatedPermissions.map((entry, index) => boundedJsonObject(entry, `permission.updatedPermissions[${index}]`, 16 * 1024)),
      }),
    }
  }
  if (value.behavior === "deny") {
    if (value.interrupt !== undefined && typeof value.interrupt !== "boolean") {
      throw new ClaudeAgentSdkProtocolError("permission.interrupt must be boolean")
    }
    return {
      behavior: "deny",
      message: safeText(value.message, "permission.message", 8 * 1024),
      ...(value.interrupt === undefined ? {} : { interrupt: value.interrupt }),
    }
  }
  throw new ClaudeAgentSdkProtocolError("permission decision behavior is unsupported")
}

export function validateElicitationResult(value: ClaudeElicitationResult): ClaudeElicitationResult {
  if (!value || typeof value !== "object") throw new ClaudeAgentSdkProtocolError("elicitation result must be an object")
  if (value.action === "accept") {
    return value.content === undefined
      ? { action: "accept" }
      : { action: "accept", content: boundedJsonObject(value.content, "elicitation.content") }
  }
  if (value.action === "decline" || value.action === "cancel") {
    if ("content" in value && value.content !== undefined) {
      throw new ClaudeAgentSdkProtocolError("declined or cancelled elicitation must not contain form content")
    }
    return { action: value.action }
  }
  throw new ClaudeAgentSdkProtocolError("elicitation action is unsupported")
}
