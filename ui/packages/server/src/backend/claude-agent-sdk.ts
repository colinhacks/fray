import { accessSync, constants as fsConstants } from "node:fs"
import { delimiter, isAbsolute } from "node:path"
import {
  query,
  type CanUseTool as SdkCanUseTool,
  type ElicitationRequest as SdkElicitationRequest,
  type ElicitationResult as SdkElicitationResult,
  type PermissionResult as SdkPermissionResult,
  type Query as SdkQuery,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@fray-ui/claude-agent-sdk-runtime"
import {
  CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES,
  CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES,
  CLAUDE_AGENT_SDK_MAX_QUEUED_EVENTS,
  CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS,
  CLAUDE_AGENT_SDK_PROTOCOL_VERSION,
  ClaudeAgentSdkProtocolError,
  boundedId,
  boundedJsonObject,
  boundedOptionalId,
  boundedStringArray,
  safeText,
  utf8Bytes,
  validateElicitationResult,
  validateInputMessage,
  validatePermissionDecision,
  validatePermissionMode,
  type ClaudeAgentCapability,
  type ClaudeCanUseTool,
  type ClaudeCommandCapability,
  type ClaudeControlInitialization,
  type ClaudeDiagnostic,
  type ClaudeElicitationRequest,
  type ClaudeInputMessage,
  type ClaudeInterruptReceipt,
  type ClaudeModelCapability,
  type ClaudeOnElicitation,
  type ClaudePermissionMode,
  type ClaudePermissionRequest,
  type ClaudeQueryEvent,
  type ClaudeSessionInitEvent,
} from "./claude-agent-sdk-protocol.ts"
import { redactCredentialSyntax } from "../credential-redaction.ts"

export const CLAUDE_AGENT_SDK_FOUNDATION_FLAG = "FRAY_CLAUDE_AGENT_SDK_FOUNDATION"
export const CLAUDE_AGENT_SDK_CLIENT_APP = "fray/claude-agent-sdk-foundation"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SENSITIVE_ENV_KEY = /(?:API_KEY|AUTH|BASE_URL|BEARER|COOKIE|CREDENTIAL|OAUTH|PASSWORD|PRIVATE|SECRET|TOKEN)/i
const INHERITED_RUNTIME_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const
const EXPLICIT_CLAUDE_ENV_KEYS = new Set<string>([
  ...INHERITED_RUNTIME_ENV_KEYS,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
const MAX_ENV_ENTRIES = 512
const MAX_ENV_VALUE_BYTES = 128 * 1024
const MAX_ENV_TOTAL_BYTES = 1024 * 1024
const MAX_PERMISSION_REQUESTS = 128
const MAX_ELICITATION_CALLBACKS = 128
const NUB_NODE_SHIM_PATH_SEGMENT = /(?:^|[\\/])nub-node-shim-[^\\/]+$/

export type ClaudeSessionSelection =
  | { kind: "new"; sessionId: string }
  | { kind: "resume"; sessionId: string }

export interface ClaudeQueryStartOptions {
  cwd: string
  session: ClaudeSessionSelection
  permissionMode?: ClaudePermissionMode
  env?: Readonly<Record<string, string | undefined>>
  canUseTool?: ClaudeCanUseTool
  onElicitation?: ClaudeOnElicitation
  onDiagnostic?: (event: ClaudeDiagnostic) => void
}

export interface ClaudeQueryHandle extends AsyncIterable<ClaudeQueryEvent> {
  readonly sessionId: string
  next(): Promise<IteratorResult<ClaudeQueryEvent>>
  ready(): Promise<ClaudeSessionInitEvent>
  send(message: ClaudeInputMessage): Promise<void>
  initializationResult(): Promise<ClaudeControlInitialization>
  reinitialize(): Promise<ClaudeControlInitialization>
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>
  setPermissionMode(mode: ClaudePermissionMode): Promise<void>
  close(): Promise<void>
}

export interface ClaudeQueryFactory {
  start(options: ClaudeQueryStartOptions): ClaudeQueryHandle
}

export interface CreateClaudeQueryFactoryOptions {
  // No composition layer enables this yet. Tests opt in explicitly while production callers must
  // pass the exact disabled-by-default flag verdict.
  enabled?: boolean
  executablePath: string
}

export function claudeAgentSdkFoundationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAUDE_AGENT_SDK_FOUNDATION_FLAG] === "1"
}

export function createClaudeQueryFactory(options: CreateClaudeQueryFactoryOptions): ClaudeQueryFactory {
  if (options.enabled !== true) {
    throw new ClaudeAgentSdkProtocolError("Claude Agent SDK foundation is disabled")
  }
  const executablePath = validateExecutablePath(options.executablePath)
  return {
    start(startOptions) {
      return startClaudeQuery(executablePath, startOptions)
    },
  }
}

class BoundedAsyncQueue<T> implements AsyncIterator<T>, AsyncIterable<T> {
  private readonly buffered: T[] = []
  private readonly waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = []
  private ended = false
  private failure: Error | undefined
  private readonly limit: number
  private readonly label: string

  constructor(limit: number, label: string) {
    this.limit = limit
    this.label = label
  }

  push(value: T): void {
    if (this.ended || this.failure) throw new ClaudeAgentSdkProtocolError(`${this.label} is closed`)
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value })
      return
    }
    if (this.buffered.length >= this.limit) throw new ClaudeAgentSdkProtocolError(`${this.label} exceeded its queue limit`)
    this.buffered.push(value)
  }

  end(): void {
    if (this.ended || this.failure) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return
    this.failure = error
    this.buffered.splice(0)
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.buffered.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.failure) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

class ClaudeInputQueue extends BoundedAsyncQueue<SDKUserMessage> {
  constructor() {
    super(CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS, "Claude input queue")
  }
}

class BoundedIdempotencyCache<T> {
  private readonly entries = new Map<string, { fingerprint: string; result: Promise<T> }>()
  private readonly limit: number
  private readonly label: string

  constructor(limit: number, label: string) {
    this.limit = limit
    this.label = label
  }

  resolve(id: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(id)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new ClaudeAgentSdkProtocolError(`${this.label} received a conflicting payload for request id ${id}`))
      }
      return existing.result
    }
    if (this.entries.size >= this.limit) {
      return Promise.reject(new ClaudeAgentSdkProtocolError(`${this.label} exceeded its request limit`))
    }
    const result = Promise.resolve().then(create)
    this.entries.set(id, { fingerprint, result })
    return result
  }
}

class BoundedCallbackGate {
  private active = 0
  private readonly limit: number
  private readonly label: string

  constructor(limit: number, label: string) {
    this.limit = limit
    this.label = label
  }

  run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      return Promise.reject(new ClaudeAgentSdkProtocolError(`${this.label} exceeded its callback limit`))
    }
    this.active += 1
    return Promise.resolve()
      .then(callback)
      .finally(() => { this.active -= 1 })
  }
}

class RealClaudeQueryHandle implements ClaudeQueryHandle {
  readonly sessionId: string
  private readonly output = new BoundedAsyncQueue<ClaudeQueryEvent>(CLAUDE_AGENT_SDK_MAX_QUEUED_EVENTS, "Claude event queue")
  private readonly redactor: (value: unknown) => { message: string; truncated: boolean }
  private readonly readyPromise: Promise<ClaudeSessionInitEvent>
  private resolveReady!: (event: ClaudeSessionInitEvent) => void
  private rejectReady!: (error: Error) => void
  private readonly pumpPromise: Promise<void>
  private closing = false
  private closed = false
  private initialized = false
  private readonly sdkQuery: SdkQuery
  private readonly input: ClaudeInputQueue
  private readonly diagnostic?: (event: ClaudeDiagnostic) => void
  private readonly lifecycleAbort: AbortController
  private readonly outstandingInputs = new Set<string>()
  private readonly outstandingInputOrder: string[] = []
  private providerProgressCovered = false
  private closePromise: Promise<void> | undefined

  constructor(
    sdkQuery: SdkQuery,
    input: ClaudeInputQueue,
    sessionId: string,
    lifecycleAbort: AbortController,
    redactor: (value: unknown) => { message: string; truncated: boolean },
    diagnostic?: (event: ClaudeDiagnostic) => void,
  ) {
    this.sdkQuery = sdkQuery
    this.input = input
    this.sessionId = sessionId
    this.lifecycleAbort = lifecycleAbort
    this.redactor = redactor
    this.diagnostic = diagnostic
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // The promise is also surfaced through ready(); suppress process-level unhandled-rejection noise
    // for callers that only consume the event iterator.
    void this.readyPromise.catch(() => undefined)
    this.diagnostic?.({ kind: "lifecycle", phase: "started" })
    this.pumpPromise = this.pump()
  }

  ready(): Promise<ClaudeSessionInitEvent> {
    return this.readyPromise
  }

  async send(message: ClaudeInputMessage): Promise<void> {
    this.assertOpen()
    const parsed = validateInputMessage(message)
    if (!UUID_PATTERN.test(parsed.id)) throw new ClaudeAgentSdkProtocolError("input.id must be a UUID")
    if (this.outstandingInputs.has(parsed.id)) throw new ClaudeAgentSdkProtocolError("input UUID is already outstanding")
    if (this.outstandingInputs.size >= CLAUDE_AGENT_SDK_MAX_QUEUED_INPUTS) {
      throw new ClaudeAgentSdkProtocolError("Claude outstanding input limit exceeded")
    }
    this.outstandingInputs.add(parsed.id)
    this.outstandingInputOrder.push(parsed.id)
    try {
      this.input.push({
        type: "user",
        message: { role: "user", content: parsed.text },
        parent_tool_use_id: null,
        uuid: parsed.id as `${string}-${string}-${string}-${string}-${string}`,
      })
    } catch (error) {
      this.outstandingInputs.delete(parsed.id)
      const orderIndex = this.outstandingInputOrder.indexOf(parsed.id)
      if (orderIndex >= 0) this.outstandingInputOrder.splice(orderIndex, 1)
      throw error
    }
  }

  async initializationResult(): Promise<ClaudeControlInitialization> {
    this.assertOpen()
    const providerResult = this.sdkQuery.initializationResult()
    await this.ready()
    this.assertOpen()
    const result = await this.awaitOpenControl(providerResult)
    return mapControlInitialization(result)
  }

  async reinitialize(): Promise<ClaudeControlInitialization> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    const result = await this.awaitOpenControl(this.sdkQuery.reinitialize())
    return mapControlInitialization(result)
  }

  async interrupt(): Promise<ClaudeInterruptReceipt | undefined> {
    this.assertOpen()
    await this.ready()
    this.assertOpen()
    const receipt = await this.awaitOpenControl(this.sdkQuery.interrupt())
    if (!receipt) return undefined
    return { stillQueued: boundedStringArray(receipt.still_queued, "interrupt.stillQueued", 256, 512).map((id, index) => boundedId(id, `interrupt.stillQueued[${index}]`)) }
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.assertOpen()
    const parsedMode = validatePermissionMode(mode)
    await this.ready()
    this.assertOpen()
    await this.awaitOpenControl(this.sdkQuery.setPermissionMode(parsedMode))
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose()
    return this.closePromise
  }

  private async performClose(): Promise<void> {
    this.closing = true
    this.lifecycleAbort.abort()
    this.input.end()
    this.clearOutstandingInputs()
    this.sdkQuery.close()
    try {
      await this.pumpPromise
    } catch {
      // pump() already normalized and published any failure.
    }
  }

  next(): Promise<IteratorResult<ClaudeQueryEvent>> {
    return this.output.next()
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeQueryEvent> {
    return this
  }

  private async pump(): Promise<void> {
    try {
      for await (const raw of this.sdkQuery) {
        const event = mapSdkMessage(raw)
        if (!this.initialized) {
          if (event.kind !== "init") throw new ClaudeAgentSdkProtocolError("Claude emitted a non-init event before session ownership")
          if (event.sessionId !== this.sessionId) throw new ClaudeAgentSdkProtocolError("Claude session ownership mismatch")
          this.initialized = true
          this.resolveReady(event)
        } else {
          if (event.kind === "init") throw new ClaudeAgentSdkProtocolError("Claude emitted a duplicate init event")
          if (event.sessionId === undefined) throw new ClaudeAgentSdkProtocolError("Claude event is missing session ownership")
          if (event.sessionId !== this.sessionId) throw new ClaudeAgentSdkProtocolError("Claude event crossed session ownership")
          this.observeProviderProgress(event)
        }
        this.output.push(event)
      }
      if (!this.initialized) throw new ClaudeAgentSdkProtocolError("Claude ended before session initialization")
      this.closed = true
      this.lifecycleAbort.abort()
      this.clearOutstandingInputs()
      this.output.end()
      this.diagnostic?.({ kind: "lifecycle", phase: "closed" })
    } catch (rawError) {
      const normalized = this.protocolError(rawError)
      this.rejectReady(normalized)
      this.closed = true
      this.lifecycleAbort.abort()
      this.input.end()
      this.clearOutstandingInputs()
      if (this.closing) {
        this.output.end()
        this.diagnostic?.({ kind: "lifecycle", phase: "closed" })
      } else {
        this.output.fail(normalized)
        this.diagnostic?.({ kind: "lifecycle", phase: "crashed", message: normalized.message })
        this.sdkQuery.close()
      }
    }
  }

  private protocolError(rawError: unknown): Error {
    if (rawError instanceof ClaudeAgentSdkProtocolError) return rawError
    const { message } = this.redactor(rawError)
    return new ClaudeAgentSdkProtocolError(`Claude SDK process failed: ${message}`)
  }

  private observeProviderProgress(event: ClaudeQueryEvent): void {
    // Synthetic user-role tool results are provider-generated and do not prove that a host input
    // UUID was consumed. Only a genuine user echo may release the exact outstanding UUID.
    if (
      event.kind === "user" &&
      !event.synthetic &&
      event.toolResultIds.length === 0 &&
      event.messageId &&
      this.outstandingInputs.delete(event.messageId)
    ) {
      const orderIndex = this.outstandingInputOrder.indexOf(event.messageId)
      if (orderIndex >= 0) this.outstandingInputOrder.splice(orderIndex, 1)
      this.providerProgressCovered = true
      return
    }
    // A subagent assistant frame can arrive independently of the main-thread input queue. Only
    // main-thread assistant/result progression is a safe fallback when an older provider omits the
    // exact user echo.
    const mainThreadProgress = (event.kind === "assistant" && event.parentToolUseId === undefined) || event.kind === "result"
    if (mainThreadProgress) {
      if (!this.providerProgressCovered && this.releaseOldestOutstandingInput()) this.providerProgressCovered = true
      if (event.kind === "result") this.providerProgressCovered = false
    }
  }

  private releaseOldestOutstandingInput(): boolean {
    while (this.outstandingInputOrder.length > 0) {
      const id = this.outstandingInputOrder.shift()!
      if (this.outstandingInputs.delete(id)) return true
    }
    return false
  }

  private clearOutstandingInputs(): void {
    this.outstandingInputs.clear()
    this.outstandingInputOrder.splice(0)
    this.providerProgressCovered = false
  }

  private async awaitOpenControl<T>(operation: Promise<T>): Promise<T> {
    try {
      const result = await operation
      this.assertOpen()
      return result
    } catch (error) {
      if (this.closing || this.closed) throw new ClaudeAgentSdkProtocolError("Claude query is closed")
      throw this.protocolError(error)
    }
  }

  private assertOpen(): void {
    if (this.closing || this.closed) throw new ClaudeAgentSdkProtocolError("Claude query is closed")
  }
}

function startClaudeQuery(executablePath: string, options: ClaudeQueryStartOptions): ClaudeQueryHandle {
  const cwd = validateAbsolutePath(options.cwd, "cwd")
  const sessionId = validateSessionId(options.session.sessionId)
  const environment = buildEnvironment(options.env)
  const redact = createClaudeDiagnosticRedactor(environment)
  const diagnostic = guardDiagnosticCallback(options.onDiagnostic)
  const permissionMode = validatePermissionMode(options.permissionMode ?? "default")
  const lifecycleAbort = new AbortController()
  const permissionRequests = new BoundedIdempotencyCache<SdkPermissionResult>(MAX_PERMISSION_REQUESTS, "Claude permission request cache")
  const elicitationCallbacks = new BoundedCallbackGate(MAX_ELICITATION_CALLBACKS, "Claude elicitation callbacks")

  const input = new ClaudeInputQueue()
  const canUseTool = options.canUseTool
    ? async (toolName: string, rawInput: Record<string, unknown>, context: Parameters<SdkCanUseTool>[2]): Promise<SdkPermissionResult> => {
      const request = mapPermissionRequest(toolName, rawInput, context)
      const fingerprint = canonicalFingerprint(request)
      return permissionRequests.resolve(request.requestId, fingerprint, async () => {
        const signal = AbortSignal.any([context.signal, lifecycleAbort.signal])
        try {
          const pending = Promise.resolve().then(() => options.canUseTool!(request, { signal }))
          return validatePermissionDecision(await abortableCallback(pending, signal, "Claude permission callback")) as SdkPermissionResult
        } catch (error) {
          if (error instanceof ClaudeAgentSdkProtocolError) throw error
          throw new ClaudeAgentSdkProtocolError("Claude permission callback failed")
        }
      })
    }
    : undefined

  const onElicitation = options.onElicitation
    ? async (rawRequest: SdkElicitationRequest, context: { signal: AbortSignal }): Promise<SdkElicitationResult> => {
      const request = mapElicitationRequest(rawRequest)
      try {
        const signal = AbortSignal.any([context.signal, lifecycleAbort.signal])
        return await elicitationCallbacks.run(async () => {
          const pending = Promise.resolve().then(() => options.onElicitation!(request, { signal }))
          const result = validateElicitationResult(await abortableCallback(pending, signal, "Claude elicitation callback"))
          validateElicitationResponse(request, result)
          return result as SdkElicitationResult
        })
      } catch (error) {
        if (error instanceof ClaudeAgentSdkProtocolError) throw error
        throw new ClaudeAgentSdkProtocolError("Claude elicitation callback failed")
      }
    }
    : undefined

  const raw = query({
    prompt: input,
    options: {
      cwd,
      env: sanitizeProviderChildEnvironment(environment),
      pathToClaudeCodeExecutable: executablePath,
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(options.session.kind === "new" ? { sessionId } : { resume: sessionId }),
      canUseTool,
      onElicitation,
      settingSources: [],
      persistSession: false,
      stderr(data) {
        const redacted = redact(data)
        diagnostic?.({ kind: "stderr", ...redacted })
      },
    },
  })

  return new RealClaudeQueryHandle(raw, input, sessionId, lifecycleAbort, redact, diagnostic)
}

function mapPermissionRequest(
  toolName: string,
  rawInput: Record<string, unknown>,
  context: {
    signal: AbortSignal
    suggestions?: unknown[]
    blockedPath?: string
    decisionReason?: string
    title?: string
    displayName?: string
    description?: string
    toolUseID: string
    agentID?: string
    requestId: string
  },
): ClaudePermissionRequest {
  return {
    requestId: boundedId(context.requestId, "permission.requestId"),
    toolUseId: boundedId(context.toolUseID, "permission.toolUseId"),
    agentId: boundedOptionalId(context.agentID, "permission.agentId"),
    // Callback inputs determine whether authority is granted. Reject ambiguous bytes instead of
    // showing the host a sanitized/truncated value while the provider acts on the original one.
    toolName: exactText(toolName, "permission.toolName", 512),
    input: boundedJsonObject(rawInput, "permission.input"),
    blockedPath: optionalExactText(context.blockedPath, "permission.blockedPath", 8 * 1024),
    decisionReason: optionalExactText(context.decisionReason, "permission.decisionReason", 8 * 1024),
    title: optionalExactText(context.title, "permission.title", 8 * 1024),
    displayName: optionalExactText(context.displayName, "permission.displayName", 2 * 1024),
    description: optionalExactText(context.description, "permission.description", 8 * 1024),
    suggestions: boundedArray(context.suggestions ?? [], "permission.suggestions", 32)
      .map((entry, index) => boundedJsonObject(entry, `permission.suggestions[${index}]`, 16 * 1024)),
  }
}

function mapElicitationRequest(request: SdkElicitationRequest): ClaudeElicitationRequest {
  const mode = request.mode === undefined ? undefined : request.mode
  if (mode !== undefined && mode !== "form" && mode !== "url") throw new ClaudeAgentSdkProtocolError("elicitation mode is unsupported")
  const url = request.url === undefined || request.url === null
    ? undefined
    : exactText(request.url, "elicitation.url", 2_048)
  if (url !== undefined) validateElicitationUrl(url)
  const elicitationId = boundedOptionalId(request.elicitationId, "elicitation.elicitationId")
  if (mode === "url" && (url === undefined || elicitationId === undefined)) {
    throw new ClaudeAgentSdkProtocolError("MCP URL elicitation requires a URL and elicitation id")
  }
  if (mode !== "url" && url !== undefined) throw new ClaudeAgentSdkProtocolError("MCP form elicitation must not carry a URL")
  const requestedSchema = request.requestedSchema === undefined
    ? undefined
    : boundedJsonObject(request.requestedSchema, "elicitation.requestedSchema")
  if (mode === "url" && requestedSchema !== undefined) {
    throw new ClaudeAgentSdkProtocolError("MCP URL elicitation must not carry a form schema")
  }
  if (mode !== "url" && elicitationId !== undefined) {
    throw new ClaudeAgentSdkProtocolError("MCP form elicitation must not carry a URL elicitation id")
  }
  if (mode !== "url") {
    if (requestedSchema === undefined) throw new ClaudeAgentSdkProtocolError("MCP form elicitation requires a requested schema")
    validateMcpFormSchema(requestedSchema)
  }
  const message = exactText(request.message, "elicitation.message", 8 * 1024)
  const title = optionalExactText(request.title, "elicitation.title", 8 * 1024)
  const displayName = optionalExactText(request.displayName, "elicitation.displayName", 2 * 1024)
  const description = optionalExactText(request.description, "elicitation.description", 8 * 1024)
  if (mode !== "url" && (
    [message, title, displayName, description].some((value) => value !== undefined && secretLikeLabel(value))
    || (requestedSchema !== undefined && schemaContainsSecretLikeField(requestedSchema))
  )) {
    throw new ClaudeAgentSdkProtocolError("Sensitive elicitation fields require MCP URL mode")
  }
  return {
    serverName: exactText(request.serverName, "elicitation.serverName", 512),
    message,
    mode,
    url,
    elicitationId,
    requestedSchema,
    title,
    displayName,
    description,
  }
}

function schemaContainsSecretLikeField(value: unknown): boolean {
  if (typeof value === "string") return secretLikeLabel(value)
  if (Array.isArray(value)) return value.some(schemaContainsSecretLikeField)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, entry]) => secretLikeLabel(key) || schemaContainsSecretLikeField(entry))
}

function validateMcpFormSchema(schema: Record<string, unknown>): void {
  assertOnlyKeys(schema, new Set(["$schema", "type", "properties", "required"]), "MCP form schema")
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") {
    throw new ClaudeAgentSdkProtocolError("MCP form schema $schema must be text")
  }
  if (schema.type !== "object") throw new ClaudeAgentSdkProtocolError("MCP form schema must be a flat object")
  const properties = strictObject(schema.properties, "MCP form schema properties")
  const propertyEntries = Object.entries(properties)
  if (propertyEntries.length > 32) throw new ClaudeAgentSdkProtocolError("MCP form schema has too many fields")
  for (const [, rawField] of propertyEntries) validateMcpPrimitiveSchema(strictObject(rawField, "MCP form field"))

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length > propertyEntries.length) {
      throw new ClaudeAgentSdkProtocolError("MCP form required fields are invalid")
    }
    const required = new Set<string>()
    for (const field of schema.required) {
      if (typeof field !== "string" || required.has(field) || !Object.hasOwn(properties, field)) {
        throw new ClaudeAgentSdkProtocolError("MCP form required fields are invalid")
      }
      required.add(field)
    }
  }
}

function validateMcpPrimitiveSchema(field: Record<string, unknown>): void {
  validateOptionalFieldText(field.title, "MCP form field title", 512)
  validateOptionalFieldText(field.description, "MCP form field description", 8 * 1024)
  if (field.type === "string") {
    if (field.enum !== undefined) {
      assertOnlyKeys(field, new Set(["type", "title", "description", "enum", "enumNames", "default"]), "MCP enum field")
      const values = nonEmptyUniqueStrings(field.enum, "MCP enum values")
      if (field.enumNames !== undefined) {
        const names = nonEmptyUniqueStrings(field.enumNames, "MCP enum names")
        if (names.length !== values.length) throw new ClaudeAgentSdkProtocolError("MCP enum names do not match its values")
      }
      if (field.default !== undefined && (typeof field.default !== "string" || !values.includes(field.default))) {
        throw new ClaudeAgentSdkProtocolError("MCP enum default is not advertised")
      }
      return
    }
    if (field.oneOf !== undefined) {
      assertOnlyKeys(field, new Set(["type", "title", "description", "oneOf", "default"]), "MCP titled enum field")
      const values = titledOptions(field.oneOf, "oneOf")
      if (field.default !== undefined && (typeof field.default !== "string" || !values.includes(field.default))) {
        throw new ClaudeAgentSdkProtocolError("MCP titled enum default is not advertised")
      }
      return
    }
    assertOnlyKeys(field, new Set(["type", "title", "description", "minLength", "maxLength", "format", "default"]), "MCP string field")
    const minimum = optionalBoundedInteger(field.minLength, "MCP string minLength", 4_000)
    const maximum = optionalBoundedInteger(field.maxLength, "MCP string maxLength", 4_000)
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ClaudeAgentSdkProtocolError("MCP string minLength exceeds maxLength")
    }
    if (field.format !== undefined && !["email", "uri", "date", "date-time"].includes(String(field.format))) {
      throw new ClaudeAgentSdkProtocolError("MCP string format is unsupported")
    }
    if (field.default !== undefined) validateMcpFieldValue(field, field.default)
    return
  }
  if (field.type === "number" || field.type === "integer") {
    assertOnlyKeys(field, new Set(["type", "title", "description", "minimum", "maximum", "default"]), "MCP number field")
    const minimum = optionalFiniteNumber(field.minimum, "MCP number minimum")
    const maximum = optionalFiniteNumber(field.maximum, "MCP number maximum")
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ClaudeAgentSdkProtocolError("MCP number minimum exceeds maximum")
    }
    if (field.default !== undefined) validateMcpFieldValue(field, field.default)
    return
  }
  if (field.type === "boolean") {
    assertOnlyKeys(field, new Set(["type", "title", "description", "default"]), "MCP boolean field")
    if (field.default !== undefined && typeof field.default !== "boolean") {
      throw new ClaudeAgentSdkProtocolError("MCP boolean default is invalid")
    }
    return
  }
  if (field.type === "array") {
    assertOnlyKeys(field, new Set(["type", "title", "description", "minItems", "maxItems", "items", "default"]), "MCP multi-select field")
    const minimum = optionalBoundedInteger(field.minItems, "MCP multi-select minItems", 32)
    const maximum = optionalBoundedInteger(field.maxItems, "MCP multi-select maxItems", 32)
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ClaudeAgentSdkProtocolError("MCP multi-select minItems exceeds maxItems")
    }
    const items = strictObject(field.items, "MCP multi-select items")
    let values: string[]
    if (items.enum !== undefined) {
      assertOnlyKeys(items, new Set(["type", "enum"]), "MCP multi-select items")
      if (items.type !== "string") throw new ClaudeAgentSdkProtocolError("MCP multi-select items must be strings")
      values = nonEmptyUniqueStrings(items.enum, "MCP multi-select values")
    } else {
      assertOnlyKeys(items, new Set(["anyOf"]), "MCP titled multi-select items")
      values = titledOptions(items.anyOf, "anyOf")
    }
    if (field.default !== undefined) validateMcpMultiSelect(field.default, values, minimum, maximum)
    return
  }
  throw new ClaudeAgentSdkProtocolError("MCP form field type is unsupported")
}

function validateElicitationResponse(request: ClaudeElicitationRequest, result: ReturnType<typeof validateElicitationResult>): void {
  if (request.mode === "url") {
    if (result.action === "accept" && result.content !== undefined) {
      throw new ClaudeAgentSdkProtocolError("MCP URL elicitation response must not contain form content")
    }
    return
  }
  if (result.action !== "accept") return
  if (result.content === undefined) throw new ClaudeAgentSdkProtocolError("accepted MCP form elicitation requires content")
  const schema = request.requestedSchema!
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : [])
  for (const key of Object.keys(result.content)) {
    if (!Object.hasOwn(properties, key)) throw new ClaudeAgentSdkProtocolError("MCP form response contains an unadvertised field")
  }
  for (const [key, field] of Object.entries(properties)) {
    const value = result.content[key]
    if (value === undefined) {
      if (required.has(key)) throw new ClaudeAgentSdkProtocolError("MCP form response is missing a required field")
      continue
    }
    validateMcpFieldValue(field, value)
  }
}

function validateMcpFieldValue(field: Record<string, unknown>, value: unknown): void {
  if (field.type === "string") {
    if (typeof value !== "string") throw new ClaudeAgentSdkProtocolError("MCP form response field must be text")
    if (Array.isArray(field.enum) && !(field.enum as unknown[]).includes(value)) {
      throw new ClaudeAgentSdkProtocolError("MCP form response contains an unadvertised option")
    }
    if (Array.isArray(field.oneOf) && !field.oneOf.some((entry) => strictObject(entry, "MCP titled option").const === value)) {
      throw new ClaudeAgentSdkProtocolError("MCP form response contains an unadvertised option")
    }
    if (typeof field.minLength === "number" && value.length < field.minLength) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is shorter than minLength")
    }
    if (typeof field.maxLength === "number" && value.length > field.maxLength) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is longer than maxLength")
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is not an email address")
    }
    if (field.format === "uri") {
      try { new URL(value) } catch { throw new ClaudeAgentSdkProtocolError("MCP form response is not a URI") }
    }
    if (field.format === "date" && !validIsoDate(value)) throw new ClaudeAgentSdkProtocolError("MCP form response is not a date")
    if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
      throw new ClaudeAgentSdkProtocolError("MCP form response is not a date-time")
    }
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
      throw new ClaudeAgentSdkProtocolError("MCP form response number is invalid")
    }
    if (typeof field.minimum === "number" && value < field.minimum) throw new ClaudeAgentSdkProtocolError("MCP form response is below minimum")
    if (typeof field.maximum === "number" && value > field.maximum) throw new ClaudeAgentSdkProtocolError("MCP form response is above maximum")
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new ClaudeAgentSdkProtocolError("MCP form response boolean is invalid")
    return
  }
  if (field.type === "array") {
    const items = field.items as Record<string, unknown>
    const values = Array.isArray(items.enum)
      ? items.enum as string[]
      : (items.anyOf as Array<Record<string, string>>).map((option) => option.const)
    validateMcpMultiSelect(value, values, field.minItems as number | undefined, field.maxItems as number | undefined)
    return
  }
  throw new ClaudeAgentSdkProtocolError("MCP form response field type is unsupported")
}

function validateMcpMultiSelect(value: unknown, advertised: string[], minimum?: number, maximum?: number): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ClaudeAgentSdkProtocolError("MCP form multi-select response is invalid")
  }
  const values = value as string[]
  if (new Set(values).size !== values.length || values.some((entry) => !advertised.includes(entry))) {
    throw new ClaudeAgentSdkProtocolError("MCP form multi-select response contains an unadvertised option")
  }
  if (minimum !== undefined && values.length < minimum) throw new ClaudeAgentSdkProtocolError("MCP form multi-select response has too few items")
  if (maximum !== undefined && values.length > maximum) throw new ClaudeAgentSdkProtocolError("MCP form multi-select response has too many items")
}

function strictObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeAgentSdkProtocolError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ClaudeAgentSdkProtocolError(`${label} contains unsupported fields`)
}

function validateOptionalFieldText(value: unknown, label: string, maxBytes: number): void {
  if (value !== undefined) exactText(value, label, maxBytes)
}

function optionalBoundedInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ClaudeAgentSdkProtocolError(`${label} is invalid`)
  }
  return value
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ClaudeAgentSdkProtocolError(`${label} is invalid`)
  return value
}

function nonEmptyUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || value.some((entry) => typeof entry !== "string")) {
    throw new ClaudeAgentSdkProtocolError(`${label} are invalid`)
  }
  const values = value as string[]
  if (new Set(values).size !== values.length) throw new ClaudeAgentSdkProtocolError(`${label} contain duplicates`)
  return values
}

function titledOptions(value: unknown, keyword: "oneOf" | "anyOf"): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new ClaudeAgentSdkProtocolError(`MCP ${keyword} options are invalid`)
  const values = value.map((raw) => {
    const option = strictObject(raw, `MCP ${keyword} option`)
    assertOnlyKeys(option, new Set(["const", "title"]), `MCP ${keyword} option`)
    if (typeof option.const !== "string") throw new ClaudeAgentSdkProtocolError(`MCP ${keyword} option value is invalid`)
    exactText(option.title, `MCP ${keyword} option title`, 512)
    return option.const
  })
  if (new Set(values).size !== values.length) throw new ClaudeAgentSdkProtocolError(`MCP ${keyword} options contain duplicates`)
  return values
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function secretLikeLabel(value: string): boolean {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const joined = words.join("")
  return words.some((word) => [
    "auth",
    "authorization",
    "authenticator",
    "bearer",
    "cookie",
    "credential",
    "cvv",
    "otp",
    "passphrase",
    "passwd",
    "password",
    "pin",
    "recovery",
    "secret",
    "sensitive",
    "ssn",
    "token",
  ].includes(word))
    || ["apikey", "privatekey", "accesskey", "clientsecret", "securitycode", "onetimepassword", "writeonly"].some((marker) => joined.includes(marker))
}

function mapSdkMessage(message: SDKMessage): ClaudeQueryEvent {
  const raw = message as unknown as Record<string, unknown>
  const type = safeText(raw.type, "event.type", 256)
  if (type === "system" && raw.subtype === "init") return mapSessionInit(raw)
  if (type === "assistant") return mapAssistant(raw)
  if (type === "user") return mapUser(raw)
  if (type === "result") return mapResult(raw)
  if (type === "prompt_suggestion") {
    return {
      kind: "prompt-suggestion",
      sessionId: boundedId(raw.session_id, "promptSuggestion.sessionId"),
      messageId: boundedId(raw.uuid, "promptSuggestion.messageId"),
      suggestion: safeText(raw.suggestion, "promptSuggestion.suggestion"),
    }
  }
  return {
    kind: "other",
    type,
    subtype: optionalText(raw.subtype, "event.subtype", 256),
    sessionId: boundedOptionalId(raw.session_id, "event.sessionId"),
    messageId: boundedOptionalId(raw.uuid, "event.messageId"),
  }
}

function mapSessionInit(raw: Record<string, unknown>): ClaudeSessionInitEvent {
  const mcpServers = boundedArray(raw.mcp_servers, "init.mcpServers", 128).map((entry, index) => {
    const object = objectValue(entry, `init.mcpServers[${index}]`)
    return {
      name: safeText(object.name, `init.mcpServers[${index}].name`, 512),
      status: safeText(object.status, `init.mcpServers[${index}].status`, 512),
    }
  })
  const plugins = boundedArray(raw.plugins, "init.plugins", 128).map((entry, index) => {
    const object = objectValue(entry, `init.plugins[${index}]`)
    return {
      name: safeText(object.name, `init.plugins[${index}].name`, 512),
      path: safeText(object.path, `init.plugins[${index}].path`, 8 * 1024),
    }
  })
  return {
    kind: "init",
    protocolVersion: CLAUDE_AGENT_SDK_PROTOCOL_VERSION,
    sessionId: boundedId(raw.session_id, "init.sessionId"),
    messageId: boundedId(raw.uuid, "init.messageId"),
    claudeCodeVersion: safeText(raw.claude_code_version, "init.claudeCodeVersion", 512),
    cwd: safeText(raw.cwd, "init.cwd", 8 * 1024),
    model: safeText(raw.model, "init.model", 512),
    permissionMode: validatePermissionMode(raw.permissionMode),
    tools: boundedStringArray(raw.tools, "init.tools"),
    mcpServers,
    slashCommands: boundedStringArray(raw.slash_commands, "init.slashCommands", 256),
    skills: boundedStringArray(raw.skills, "init.skills", 256),
    plugins,
    capabilities: raw.capabilities === undefined ? [] : boundedStringArray(raw.capabilities, "init.capabilities", 256),
  }
}

function mapAssistant(raw: Record<string, unknown>): ClaudeQueryEvent {
  const apiMessage = objectValue(raw.message, "assistant.message")
  const blocks = boundedArray(apiMessage.content, "assistant.content", 64)
  const text: string[] = []
  const toolUses: Array<{ id: string; name: string; input: ReturnType<typeof boundedJsonObject> }> = []
  let textBytes = 0
  for (const [index, entry] of blocks.entries()) {
    const block = objectValue(entry, `assistant.content[${index}]`)
    if (block.type === "text") {
      const value = safeText(block.text, `assistant.content[${index}].text`)
      textBytes += utf8Bytes(value)
      if (textBytes > CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES) throw new ClaudeAgentSdkProtocolError("assistant text exceeds its aggregate limit")
      text.push(value)
    } else if (block.type === "tool_use") {
      toolUses.push({
        id: boundedId(block.id, `assistant.content[${index}].id`),
        name: safeText(block.name, `assistant.content[${index}].name`, 512),
        input: boundedJsonObject(block.input, `assistant.content[${index}].input`),
      })
    }
  }
  return {
    kind: "assistant",
    sessionId: boundedId(raw.session_id, "assistant.sessionId"),
    messageId: boundedId(raw.uuid, "assistant.messageId"),
    parentToolUseId: boundedOptionalId(raw.parent_tool_use_id, "assistant.parentToolUseId"),
    text,
    toolUses,
    supersedes: raw.supersedes === undefined ? [] : boundedStringArray(raw.supersedes, "assistant.supersedes", 128).map((id, index) => boundedId(id, `assistant.supersedes[${index}]`)),
  }
}

function mapUser(raw: Record<string, unknown>): ClaudeQueryEvent {
  const apiMessage = objectValue(raw.message, "user.message")
  const content = apiMessage.content
  const text: string[] = []
  const toolResultIds: string[] = []
  let textBytes = 0
  if (typeof content === "string") {
    const value = safeText(content, "user.content")
    textBytes = utf8Bytes(value)
    text.push(value)
  }
  else {
    for (const [index, entry] of boundedArray(content, "user.content", 64).entries()) {
      const block = objectValue(entry, `user.content[${index}]`)
      if (block.type === "text") {
        const value = safeText(block.text, `user.content[${index}].text`)
        textBytes += utf8Bytes(value)
        if (textBytes > CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES) {
          throw new ClaudeAgentSdkProtocolError("user text exceeds its aggregate limit")
        }
        text.push(value)
      }
      if (block.type === "tool_result") toolResultIds.push(boundedId(block.tool_use_id, `user.content[${index}].toolUseId`))
    }
  }
  return {
    kind: "user",
    sessionId: boundedOptionalId(raw.session_id, "user.sessionId"),
    messageId: boundedOptionalId(raw.uuid, "user.messageId"),
    parentToolUseId: boundedOptionalId(raw.parent_tool_use_id, "user.parentToolUseId"),
    text,
    toolResultIds,
    synthetic: raw.isSynthetic === true,
  }
}

function mapResult(raw: Record<string, unknown>): ClaudeQueryEvent {
  const subtype = safeText(raw.subtype, "result.subtype", 256)
  if (!["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(subtype)) {
    throw new ClaudeAgentSdkProtocolError("result subtype is unsupported")
  }
  return {
    kind: "result",
    sessionId: boundedId(raw.session_id, "result.sessionId"),
    messageId: boundedId(raw.uuid, "result.messageId"),
    subtype: subtype as "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries",
    isError: raw.is_error === true,
    stopReason: optionalText(raw.stop_reason, "result.stopReason", 512),
    result: optionalText(raw.result, "result.result", CLAUDE_AGENT_SDK_MAX_EVENT_TEXT_BYTES),
    errors: raw.errors === undefined ? [] : boundedStringArray(raw.errors, "result.errors", 32, 8 * 1024),
  }
}

function mapControlInitialization(raw: SDKControlInitializeResponse): ClaudeControlInitialization {
  const commands: ClaudeCommandCapability[] = boundedArray(raw.commands, "initialization.commands", 256).map((entry, index) => {
    const command = objectValue(entry, `initialization.commands[${index}]`)
    return {
      name: safeText(command.name, `initialization.commands[${index}].name`, 512),
      description: safeText(command.description, `initialization.commands[${index}].description`, 4 * 1024),
      argumentHint: safeText(command.argumentHint, `initialization.commands[${index}].argumentHint`, 2 * 1024),
      aliases: command.aliases === undefined ? [] : boundedStringArray(command.aliases, `initialization.commands[${index}].aliases`, 32),
    }
  })
  const agents: ClaudeAgentCapability[] = boundedArray(raw.agents, "initialization.agents", 128).map((entry, index) => {
    const agent = objectValue(entry, `initialization.agents[${index}]`)
    return {
      name: safeText(agent.name, `initialization.agents[${index}].name`, 512),
      description: safeText(agent.description, `initialization.agents[${index}].description`, 4 * 1024),
      model: optionalText(agent.model, `initialization.agents[${index}].model`, 512),
    }
  })
  const models: ClaudeModelCapability[] = boundedArray(raw.models, "initialization.models", 128).map((entry, index) => {
    const model = objectValue(entry, `initialization.models[${index}]`)
    return {
      value: safeText(model.value, `initialization.models[${index}].value`, 512),
      resolvedModel: optionalText(model.resolvedModel, `initialization.models[${index}].resolvedModel`, 512),
      displayName: safeText(model.displayName, `initialization.models[${index}].displayName`, 512),
      description: safeText(model.description, `initialization.models[${index}].description`, 4 * 1024),
      supportsEffort: model.supportsEffort === true,
      supportedEffortLevels: model.supportedEffortLevels === undefined ? [] : boundedStringArray(model.supportedEffortLevels, `initialization.models[${index}].supportedEffortLevels`, 8),
      supportsAdaptiveThinking: model.supportsAdaptiveThinking === true,
      supportsFastMode: model.supportsFastMode === true,
    }
  })
  return {
    commands,
    agents,
    outputStyle: safeText(raw.output_style, "initialization.outputStyle", 512),
    availableOutputStyles: boundedStringArray(raw.available_output_styles, "initialization.availableOutputStyles", 64),
    models,
  }
}

function buildEnvironment(overrides: Readonly<Record<string, string | undefined>> | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of INHERITED_RUNTIME_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      if (utf8Bytes(value) > MAX_ENV_VALUE_BYTES) throw new ClaudeAgentSdkProtocolError("Claude inherited environment value is too large")
      env[key] = value
    }
  }
  const overrideEntries = Object.entries(overrides ?? {})
  if (overrideEntries.length > MAX_ENV_ENTRIES) throw new ClaudeAgentSdkProtocolError("Claude environment has too many overrides")
  for (const [key, value] of overrideEntries) {
    if (!ENV_KEY_PATTERN.test(key)) throw new ClaudeAgentSdkProtocolError("Claude environment contains an invalid key")
    if (!EXPLICIT_CLAUDE_ENV_KEYS.has(key)) throw new ClaudeAgentSdkProtocolError(`Claude environment key ${key} is not allowlisted`)
    if (value === undefined) delete env[key]
    else {
      if (typeof value !== "string") throw new ClaudeAgentSdkProtocolError("Claude environment value must be text")
      if (utf8Bytes(value) > MAX_ENV_VALUE_BYTES) throw new ClaudeAgentSdkProtocolError("Claude environment value is too large")
      // Very short credential values are invalid in practice and cannot be safely substituted in
      // diagnostics without turning common one-character strings into an amplification vector.
      if (SENSITIVE_ENV_KEY.test(key) && value.length > 0 && value.length < 4) {
        throw new ClaudeAgentSdkProtocolError("Claude sensitive environment value is too short")
      }
      env[key] = value
    }
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLAUDE_AGENT_SDK_CLIENT_APP
  const entries = Object.entries(env)
  if (entries.length > MAX_ENV_ENTRIES) throw new ClaudeAgentSdkProtocolError("Claude environment has too many entries")
  const total = entries.reduce((sum, [key, value]) => sum + utf8Bytes(key) + utf8Bytes(value ?? ""), 0)
  if (total > MAX_ENV_TOTAL_BYTES) throw new ClaudeAgentSdkProtocolError("Claude environment is too large")
  return env
}

// The SDK strips NODE_OPTIONS before it spawns Claude, but Nub's temporary `node` shim can
// reconstruct its loader flags when a provider executable uses `#!/usr/bin/env node`. Provider
// children must not receive either form of host runtime injection.
function sanitizeProviderChildEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const sanitized = { ...environment }
  delete sanitized.NODE_OPTIONS
  if (sanitized.PATH !== undefined) {
    sanitized.PATH = sanitized.PATH
      .split(delimiter)
      .filter((entry) => !NUB_NODE_SHIM_PATH_SEGMENT.test(entry))
      .join(delimiter)
  }
  return sanitized
}

export function createClaudeDiagnosticRedactor(
  env: Record<string, string | undefined>,
): (value: unknown) => { message: string; truncated: boolean } {
  const secrets = Object.entries(env)
    .filter(([key, value]) => SENSITIVE_ENV_KEY.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length)
  return (value) => {
    let raw: string
    try {
      raw = value instanceof Error ? value.message : String(value)
    } catch {
      raw = "unprintable provider diagnostic"
    }
    // Bound provider-controlled diagnostics before applying replacement patterns so a single
    // pathological thrown value cannot turn error normalization into an unbounded CPU operation.
    const oversizedInput = utf8Bytes(raw) > CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES * 4
    let redacted = redactCredentialSyntax(
      safeText(raw, "diagnostic", CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES * 4),
      { replacement: "[REDACTED]" },
    )
    for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]")
    redacted = redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-ant-[A-Za-z0-9_-]+/gi, "[REDACTED]")
      .replace(/([?&](?:api[_-]?key|auth|password|secret|token)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/("(?:api[_-]?key|auth|password|secret|token)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
      .replace(/\b((?:api[_-]?key|auth|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    const truncated = oversizedInput || utf8Bytes(redacted) > CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES
    return { message: safeText(redacted, "diagnostic", CLAUDE_AGENT_SDK_MAX_DIAGNOSTIC_BYTES), truncated }
  }
}

function canonicalFingerprint(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFingerprint).join(",")}]`
  if (value && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFingerprint(entry)}`)
    return `{${fields.join(",")}}`
  }
  throw new ClaudeAgentSdkProtocolError("Claude request fingerprint contains a non-JSON value")
}

function abortableCallback<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new ClaudeAgentSdkProtocolError(`${label} aborted`))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ClaudeAgentSdkProtocolError(`${label} aborted`))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function guardDiagnosticCallback(
  callback: ((event: ClaudeDiagnostic) => void) | undefined,
): ((event: ClaudeDiagnostic) => void) | undefined {
  if (!callback) return undefined
  return (event) => {
    try {
      callback(event)
    } catch {
      // Diagnostics are observational and must never gain control over the provider lifecycle.
    }
  }
}

function validateExecutablePath(value: string): string {
  const path = validateAbsolutePath(value, "executablePath")
  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    throw new ClaudeAgentSdkProtocolError("Claude executable is not executable")
  }
  return path
}

function validateAbsolutePath(value: unknown, label: string): string {
  const path = exactText(value, label, 8 * 1024)
  if (!isAbsolute(path)) throw new ClaudeAgentSdkProtocolError(`${label} must be absolute`)
  return path
}

function validateSessionId(value: unknown): string {
  const id = boundedId(value, "sessionId")
  if (!UUID_PATTERN.test(id)) throw new ClaudeAgentSdkProtocolError("sessionId must be a UUID")
  return id
}

function validateElicitationUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ClaudeAgentSdkProtocolError("elicitation URL is invalid")
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
  if (parsed.protocol !== "https:" && !localHttp) throw new ClaudeAgentSdkProtocolError("elicitation URL must use HTTPS")
  if (parsed.username || parsed.password) throw new ClaudeAgentSdkProtocolError("elicitation URL must not contain credentials")
}

function optionalText(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined || value === null ? undefined : safeText(value, label, maxBytes)
}

function optionalExactText(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined || value === null ? undefined : exactText(value, label, maxBytes)
}

function exactText(value: unknown, label: string, maxBytes: number): string {
  const text = safeText(value, label, maxBytes)
  if (text !== value) throw new ClaudeAgentSdkProtocolError(`${label} contains unsafe or oversized text`)
  return text
}

function boundedArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ClaudeAgentSdkProtocolError(`${label} must be a bounded list`)
  return value
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeAgentSdkProtocolError(`${label} must be an object`)
  return value as Record<string, unknown>
}
