import { createHash, randomUUID } from "node:crypto"
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type { Readable, Writable } from "node:stream"
import Database from "better-sqlite3"
import { z } from "zod"
import {
  INTERACTION_PROTOCOL_VERSION,
  InteractionRequest,
  ThreadSlug,
  type InteractionCapability,
  type InteractionCommandAction,
  type InteractionField,
  type InteractionFileChangeDisplay,
  type InteractionRecord,
  type InteractionRequest as InteractionRequestType,
  type ResolveInteractionInput,
} from "@fray-ui/shared"
import {
  InteractionStoreError,
  type InteractionSessionScope,
  type InteractionStore,
  type ProviderDelivery,
  type QueueProviderResponseResult,
} from "../interaction-store.ts"
import { redactCredentialSyntax } from "../credential-redaction.ts"

// Foundation-only bridge. It is deliberately not an AgentBackend: no current/default Codex TUI
// session can accidentally cross this boundary. Context exposes it only behind the explicit env flag.
export const CODEX_APP_SERVER_FEATURE_FLAG = "FRAY_CODEX_APP_SERVER_BRIDGE"
export const CODEX_APP_SERVER_PROVIDER = "codex-app-server"
export const CODEX_APP_SERVER_SUPPORTED_VERSION = "0.144.1"
// Upgrade policy: this is an exact protocol pin, never a semver range. Changing it requires a fresh
// generated-protocol audit plus a source audit at the matching immutable Rust tag/commit, then a new
// fingerprint and contract fixtures. These coordinates are intentionally runtime-visible diagnostics,
// but contain no host paths or credentials.
export const CODEX_APP_SERVER_PROTOCOL_REVISION = Object.freeze({
  packageVersion: CODEX_APP_SERVER_SUPPORTED_VERSION,
  sourceTag: "rust-v0.144.1",
  sourceCommit: "44918ea10c0f99151c6710411b4322c2f5c96bea",
})
const PROTOCOL_FINGERPRINT = [
  CODEX_APP_SERVER_PROTOCOL_REVISION.sourceTag,
  CODEX_APP_SERVER_PROTOCOL_REVISION.sourceCommit,
  "experimental:user-input-answer-only:permissions-grant-or-deny:mcp-standard",
].join(":")
const MAX_JSONL_BYTES = 256 * 1024
const MAX_INBOUND_RECORDS = 256
const MAX_INBOUND_QUEUED_BYTES = MAX_JSONL_BYTES * 2
const MAX_OUTBOUND_REQUESTS = 128
const MAX_STDERR_BYTES = 16 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const BRIDGE_DB_SCHEMA_VERSION = 1

// Deliberately do not forward process.env wholesale. The app-server is a trusted local Codex binary,
// but its tool subprocesses inherit its environment; forwarding Fray/GitHub/Anthropic or arbitrary
// host secrets would therefore broaden agent authority. This exact list preserves executable/runtime,
// home, locale, transport, and the auth/provider variables read by the audited 0.144.1 source.
export const CODEX_APP_SERVER_ENV_KEYS = Object.freeze([
  "HOME", "USERPROFILE", "CODEX_HOME",
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "SHELL", "USER", "USERNAME", "LOGNAME",
  "TMPDIR", "TMP", "TEMP", "TZ",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
  "OPENAI_ORGANIZATION", "OPENAI_PROJECT",
  "CODEX_AUTHAPI_BASE_URL", "CODEX_OSS_BASE_URL", "CODEX_OSS_PORT",
  "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const)

export function codexAppServerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of CODEX_APP_SERVER_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

type RpcId = string | number
type JsonObject = Record<string, unknown>

const RpcIdSchema = z.union([z.string().min(1).max(256), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
const Opaque = z.string().min(1).max(256)
const SafeTimestampMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const NullableString = z.string().max(16_000).nullable()

const CommandAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), command: z.string().max(16_000), name: z.string().max(2_048), path: z.string().max(8_192) }).strict(),
  z.object({ type: z.literal("listFiles"), command: z.string().max(16_000), path: z.string().max(8_192).nullable() }).strict(),
  z.object({
    type: z.literal("search"),
    command: z.string().max(16_000),
    query: z.string().max(8_192).nullable(),
    path: z.string().max(8_192).nullable(),
  }).strict(),
  z.object({ type: z.literal("unknown"), command: z.string().max(16_000) }).strict(),
])
const NetworkApprovalContext = z.object({
  host: z.string().min(1).max(8_192),
  protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
}).strict()
const FileSystemSpecialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("minimal") }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: z.string().max(8_192).nullable() }).strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(),
  z.object({ kind: z.literal("slash_tmp") }).strict(),
  z.object({ kind: z.literal("unknown"), path: z.string().max(8_192), subpath: z.string().max(8_192).nullable() }).strict(),
])
const FileSystemPath = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: z.string().max(8_192) }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string().max(8_192) }).strict(),
  z.object({ type: z.literal("special"), value: FileSystemSpecialPath }).strict(),
])
const FileSystemSandboxEntry = z.object({
  path: FileSystemPath,
  access: z.enum(["read", "write", "deny"]),
}).strict()
const NetworkPermissions = z.object({ enabled: z.boolean().nullable() }).strict()
const FileSystemPermissions = z.object({
  read: z.array(z.string().max(8_192)).max(256).nullable(),
  write: z.array(z.string().max(8_192)).max(256).nullable(),
  globScanMaxDepth: z.number().int().nonnegative().max(256).optional(),
  entries: z.array(FileSystemSandboxEntry).max(256).optional(),
}).strict()
const RequestedPermissions = z.object({
  network: NetworkPermissions.nullable(),
  fileSystem: FileSystemPermissions.nullable(),
}).strict()
const NetworkPolicyAmendment = z.object({
  host: z.string().min(1).max(8_192),
  action: z.enum(["allow", "deny"]),
}).strict()

const CommandApprovalParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  startedAtMs: SafeTimestampMs,
  approvalId: Opaque.nullable().optional(),
  environmentId: Opaque.nullable(),
  reason: NullableString.optional(),
  networkApprovalContext: NetworkApprovalContext.nullable().optional(),
  command: NullableString.optional(),
  cwd: z.string().max(8_192).nullable().optional(),
  commandActions: z.array(CommandAction).max(128).nullable().optional(),
  additionalPermissions: RequestedPermissions.nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string().max(8_192)).max(128).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(NetworkPolicyAmendment).max(128).nullable().optional(),
  availableDecisions: z.array(z.enum(["accept", "acceptForSession", "decline", "cancel"])).max(16).nullable().optional(),
}).strict()

const FileApprovalParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  startedAtMs: SafeTimestampMs,
  reason: NullableString.optional(),
  grantRoot: z.string().max(8_192).nullable().optional(),
}).strict()

const PatchChangeKind = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }).strict(),
  z.object({ type: z.literal("delete") }).strict(),
  z.object({ type: z.literal("update"), move_path: z.string().max(8_192).nullable() }).strict(),
])
const FileUpdateChange = z.object({
  path: z.string().max(8_192),
  kind: PatchChangeKind,
  diff: z.string().max(MAX_JSONL_BYTES),
}).strict()
const FileChangeItem = z.object({
  type: z.literal("fileChange"),
  id: Opaque,
  changes: z.array(FileUpdateChange).max(128),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
}).strict()
const ItemStartedNotification = z.object({
  item: z.unknown(),
  threadId: Opaque,
  turnId: Opaque,
  startedAtMs: SafeTimestampMs,
}).strict()
const ItemCompletedNotification = z.object({
  item: z.unknown(),
  threadId: Opaque,
  turnId: Opaque,
  completedAtMs: SafeTimestampMs,
}).strict()
const FileChangePatchUpdatedNotification = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  changes: z.array(FileUpdateChange).max(128),
}).strict()

const PermissionsApprovalParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  environmentId: Opaque.nullable(),
  startedAtMs: SafeTimestampMs,
  cwd: z.string().max(8_192),
  reason: NullableString,
  permissions: RequestedPermissions,
}).strict()

const UserInputQuestion = z.object({
  id: z.string().min(1).max(128),
  header: z.string().min(1).max(160),
  question: z.string().min(1).max(4_000),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(z.object({
    label: z.string().min(1).max(1_000),
    description: z.string().max(2_000),
  }).strict()).max(64).nullable(),
}).strict()
const UserInputParams = z.object({
  threadId: Opaque,
  turnId: Opaque,
  itemId: Opaque,
  questions: z.array(UserInputQuestion).min(1).max(32),
  autoResolutionMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000).nullable(),
}).strict()

const McpBase = {
  threadId: Opaque,
  turnId: Opaque.nullable(),
  serverName: z.string().min(1).max(160),
}
const McpElicitationParams = z.discriminatedUnion("mode", [
  z.object({
    ...McpBase,
    mode: z.literal("form"),
    _meta: z.unknown().nullable(),
    message: z.string().min(1).max(4_000),
    requestedSchema: z.unknown(),
  }).strict(),
  z.object({
    ...McpBase,
    mode: z.literal("openai/form"),
    _meta: z.unknown().nullable(),
    message: z.string().min(1).max(4_000),
    requestedSchema: z.unknown(),
  }).strict(),
  z.object({
    ...McpBase,
    mode: z.literal("url"),
    _meta: z.unknown().nullable(),
    message: z.string().min(1).max(4_000),
    url: z.string().min(1).max(2_048),
    elicitationId: Opaque,
  }).strict(),
])

const ResolvedNotification = z.object({ threadId: Opaque, requestId: RpcIdSchema }).strict()

export interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export type CodexAppServerSpawn = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => CodexAppServerProcess

export type CodexAppServerDiagnostic =
  | { event: "connected"; version: string; connectionEpoch: number }
  | { event: "disconnected"; connectionEpoch: number; reason: "exit" | "error" | "closed" | "protocol" }
  | { event: "version-rejected"; expected: string; received: string }
  | { event: "stderr"; bytes: number; truncated: boolean }
  | { event: "request-rejected"; method: string; code: number }

class RpcProtocolError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class JsonlRpcConnection {
  private readonly pending = new Map<number, PendingRpc>()
  private readonly decoder = new StringDecoder("utf8")
  private nextId = 1
  private buffer = ""
  private closed = false
  private stderrBytes = 0
  private stderrReported = false
  private stderrTruncationReported = false
  private readonly inboundQueue: Array<{ message: unknown; bytes: number }> = []
  private inboundQueuedBytes = 0
  private draining = false
  private readonly idleWaiters = new Set<() => void>()
  private readonly child: CodexAppServerProcess
  private readonly timeoutMs: number
  private readonly onRequest: (method: string, id: RpcId, params: unknown) => Promise<void>
  private readonly onNotification: (method: string, params: unknown) => Promise<void>
  private readonly onClosed: (reason: "exit" | "error" | "protocol") => void
  private readonly diagnostic?: (event: CodexAppServerDiagnostic) => void

  constructor(
    child: CodexAppServerProcess,
    timeoutMs: number,
    onRequest: (method: string, id: RpcId, params: unknown) => Promise<void>,
    onNotification: (method: string, params: unknown) => Promise<void>,
    onClosed: (reason: "exit" | "error" | "protocol") => void,
    diagnostic?: (event: CodexAppServerDiagnostic) => void,
  ) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.onRequest = onRequest
    this.onNotification = onNotification
    this.onClosed = onClosed
    this.diagnostic = diagnostic
    child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk))
    child.stdout.on("end", () => this.fail("protocol", new Error("Codex app-server stdout ended")))
    child.stdout.on("error", () => this.fail("protocol", new Error("Codex app-server stdout failed")))
    child.stdin.on("error", () => this.fail("error", new Error("Codex app-server stdin failed")))
    child.stderr.on("data", (chunk: Buffer | string) => {
      const size = Buffer.byteLength(chunk)
      this.stderrBytes = Math.min(MAX_STDERR_BYTES + 1, this.stderrBytes + size)
      if (!this.stderrReported) {
        this.stderrReported = true
        this.diagnostic?.({ event: "stderr", bytes: Math.min(this.stderrBytes, MAX_STDERR_BYTES), truncated: false })
      }
      if (this.stderrBytes > MAX_STDERR_BYTES && !this.stderrTruncationReported) {
        this.stderrTruncationReported = true
        this.diagnostic?.({ event: "stderr", bytes: MAX_STDERR_BYTES, truncated: true })
      }
    })
    child.on("exit", () => this.fail("exit", new Error("Codex app-server exited")))
    child.on("error", () => this.fail("error", new Error("Codex app-server process failed")))
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("Codex app-server connection is closed")
    if (this.pending.size >= MAX_OUTBOUND_REQUESTS) throw new Error("Codex app-server outbound request queue is full")
    if (!Number.isSafeInteger(this.nextId)) throw new Error("Codex app-server request id space is exhausted")
    const id = this.nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      await this.write({ id, method, params })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error("Codex app-server write failed"))
      }
    }
    return result
  }

  notification(method: string, params?: unknown): Promise<void> {
    return this.write(params === undefined ? { method } : { method, params })
  }

  response(id: RpcId, result: unknown): Promise<void> {
    return this.write({ id, result })
  }

  errorResponse(id: RpcId, code: number, message: string): Promise<void> {
    return this.write({ id, error: { code, message } })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Codex app-server connection closed"))
    }
    this.pending.clear()
    this.inboundQueue.length = 0
    this.inboundQueuedBytes = 0
    this.child.kill("SIGTERM")
  }

  whenIdle(): Promise<void> {
    if (!this.draining) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private consume(chunk: Buffer | string): void {
    if (this.closed) return
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSONL_BYTES * 2) {
      this.fail("protocol", new Error("Codex app-server JSONL buffer exceeded its limit"))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_BYTES) {
        this.fail("protocol", new Error("Codex app-server JSONL message exceeded its limit"))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.fail("protocol", new Error("Codex app-server emitted invalid JSONL"))
        return
      }
      const bytes = Buffer.byteLength(line, "utf8")
      if (
        this.inboundQueue.length >= MAX_INBOUND_RECORDS ||
        this.inboundQueuedBytes + bytes > MAX_INBOUND_QUEUED_BYTES
      ) {
        this.fail("protocol", new Error("Codex app-server inbound queue exceeded its limit"))
        return
      }
      this.inboundQueue.push({ message, bytes })
      this.inboundQueuedBytes += bytes
      if (!this.draining) {
        this.draining = true
        queueMicrotask(() => void this.drain())
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        const next = this.inboundQueue.shift()
        if (!next) return
        this.inboundQueuedBytes -= next.bytes
        await this.dispatch(next.message)
      }
    } catch {
      this.fail("protocol", new Error("Codex app-server inbound dispatch failed"))
    } finally {
      this.draining = false
      if (this.closed) {
        this.inboundQueue.length = 0
        this.inboundQueuedBytes = 0
      } else if (this.inboundQueue.length > 0) {
        this.draining = true
        queueMicrotask(() => void this.drain())
      }
      if (!this.draining) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  private async dispatch(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      this.fail("protocol", new Error("Codex app-server emitted a non-object message"))
      return
    }
    const message = raw as JsonObject
    if ("jsonrpc" in message) {
      this.fail("protocol", new Error("Codex app-server emitted a JSON-RPC version envelope on the unversioned wire"))
      return
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      if (typeof message.method === "string" || ("result" in message && "error" in message)) {
        this.fail("protocol", new Error("Codex app-server emitted an ambiguous response envelope"))
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if ("error" in message) pending.reject(new Error("Codex app-server rejected a client request"))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method !== "string") {
      this.fail("protocol", new Error("Codex app-server message has no method"))
      return
    }
    if ("id" in message) {
      const parsedId = RpcIdSchema.safeParse(message.id)
      if (!parsedId.success) {
        this.fail("protocol", new Error("Codex app-server request id is invalid"))
        return
      }
      try {
        await this.onRequest(message.method, parsedId.data, message.params)
      } catch (error) {
        const rpcError = error instanceof RpcProtocolError ? error : new RpcProtocolError(-32603, "Fray could not stage the provider request")
        await this.errorResponse(parsedId.data, rpcError.code, rpcError.message).catch(() => undefined)
      }
      return
    }
    await this.onNotification(message.method, message.params).catch(() => undefined)
  }

  private write(value: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed"))
    let line: string
    try {
      line = `${JSON.stringify(value)}\n`
    } catch {
      return Promise.reject(new Error("Codex app-server message is not JSON serializable"))
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_BYTES) {
      return Promise.reject(new Error("Codex app-server outbound message exceeded its limit"))
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error?: Error | null) => error ? reject(error) : resolve())
    })
  }

  private fail(reason: "exit" | "error" | "protocol", error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.inboundQueue.length = 0
    this.inboundQueuedBytes = 0
    this.onClosed(reason)
    this.child.kill("SIGTERM")
  }
}

interface BindingRow {
  fray_session_id: string
  thread_slug: string
  codex_thread_id: string
  codex_session_id: string
  session_epoch: number
  capability_revision: number
  connection_epoch: number
  current_turn_id: string | null
  cwd: string
  ephemeral: number
  state: "active" | "detached"
  created_at: string
  updated_at: string
}

const BindingRowSchema = z.object({
  fray_session_id: Opaque,
  thread_slug: ThreadSlug,
  codex_thread_id: Opaque,
  codex_session_id: Opaque,
  session_epoch: z.number().int().min(1),
  capability_revision: z.number().int().min(1),
  connection_epoch: z.number().int().min(1),
  current_turn_id: Opaque.nullable(),
  cwd: z.string().min(1).max(8_192),
  ephemeral: z.union([z.literal(0), z.literal(1)]),
  state: z.enum(["active", "detached"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict()
const BridgeMetaRowSchema = z.object({
  singleton: z.literal(1),
  connection_epoch: z.number().int().nonnegative(),
  capability_revision: z.number().int().nonnegative(),
  protocol_fingerprint: z.string().max(1_024),
}).strict()

function checkedBindingRow(raw: unknown): BindingRow {
  const parsed = BindingRowSchema.safeParse(raw)
  if (!parsed.success) throw new InteractionStoreError("corrupt-journal", "Codex app-server session binding is corrupt")
  return parsed.data
}

function turnKey(row: Pick<BindingRow, "thread_slug" | "fray_session_id" | "connection_epoch">): string {
  return `${row.thread_slug}\u0000${row.fray_session_id}\u0000${row.connection_epoch}`
}

export interface CodexAppServerSessionBinding {
  threadSlug: string
  sessionId: string
  codexThreadId: string
  codexSessionId: string
  sessionEpoch: number
  capabilityRevision: number
  connectionEpoch: number
  currentTurnId: string | null
  cwd: string
  ephemeral: boolean
  state: "active" | "detached"
}

export interface StartCodexAppServerSessionInput {
  threadSlug: string
  sessionId: string
  cwd: string
  model?: string
  approvalPolicy?: "untrusted" | "on-request" | "never"
  sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  permissions?: string
  // The foundation defaults to disposable sessions. A later opt-in UI may explicitly request a
  // persisted bridge-owned session; existing TUI sessions are never imported into this table.
  ephemeral?: boolean
}

export interface StartCodexAppServerTurnInput {
  threadSlug: string
  sessionId: string
  text: string
  model?: string
  effort?: string
}

export interface CodexAppServerBridgeOptions {
  projectId: string
  projectDir: string
  dbPath: string
  interactions: InteractionStore
  codexBin?: string
  spawn?: CodexAppServerSpawn
  now?: () => Date
  id?: () => string
  requestTimeoutMs?: number
  diagnostic?: (event: CodexAppServerDiagnostic) => void
}

function bindingFromRow(row: BindingRow): CodexAppServerSessionBinding {
  return {
    threadSlug: row.thread_slug,
    sessionId: row.fray_session_id,
    codexThreadId: row.codex_thread_id,
    codexSessionId: row.codex_session_id,
    sessionEpoch: row.session_epoch,
    capabilityRevision: row.capability_revision,
    connectionEpoch: row.connection_epoch,
    currentTurnId: row.current_turn_id,
    cwd: row.cwd,
    ephemeral: row.ephemeral === 1,
    state: row.state,
  }
}

function cleanText(raw: string | null | undefined, maxChars: number, fallback: string): string {
  if (!raw) return fallback
  const cleaned = redactDisplaySecrets(
    raw.replace(/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " "),
  )
    .slice(0, maxChars)
    .trim()
  return cleaned || fallback
}

const DISPLAY_REDACTION = "[REDACTED]"
const UNSAFE_DISPLAY_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const SECRET_NAME = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|private[_-]?key)/iu

interface DisplayTextLimits {
  maxChars: number
  maxBytes: number
  maxLines: number
  fallback: string
}

function visibleControls(raw: string): string {
  return raw
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_DISPLAY_TEXT, (value) => `[U+${value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`)
}

function redactedSecretValue(raw: string): string {
  const quote = raw.length >= 2 && (raw[0] === "\"" || raw[0] === "'") && raw.at(-1) === raw[0]
    ? raw[0]
    : ""
  const content = quote ? raw.slice(1, -1) : raw
  // A credential-shaped value may itself contain executable shell substitution. Keep that authority
  // visible while replacing the opaque credential material.
  const executable = content.match(/\$\([^\r\n)]{0,4096}\)|`[^`\r\n]{0,4096}`|[<>]\([^\r\n)]{0,4096}\)/gu) ?? []
  const replacement = executable.length === 0
    ? DISPLAY_REDACTION
    : `${DISPLAY_REDACTION} [embedded executable shell syntax: ${executable.join(" ")}]`
  return replacement
}

function redactDisplaySecrets(raw: string): string {
  let value = redactCredentialSyntax(raw, { replacement: redactedSecretValue })
  value = value.replace(
    /-----BEGIN [^-\r\n]{0,80}PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{0,80}PRIVATE KEY-----/giu,
    DISPLAY_REDACTION,
  )
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, `$1${DISPLAY_REDACTION}@`)
  value = value.replace(
    /\b(authorization|proxy-authorization)(\s*[:=]\s*)(bearer|basic)(\s+)([^\s'";|]+)/giu,
    (_whole, name: string, separator: string, scheme: string, whitespace: string, secret: string) =>
      `${name}${separator}${scheme}${whitespace}${redactedSecretValue(secret)}`,
  )
  value = value.replace(/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/giu, `$1$2${DISPLAY_REDACTION}`)
  value = value.replace(
    /(^|[\s;&|([{])((?:--?|\/)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd|credential|private[-_]?key)(?:\s*=\s*|\s+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gimu,
    (_whole, boundary: string, flag: string, secret: string) => `${boundary}${flag}${redactedSecretValue(secret)}`,
  )
  value = value.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gu,
    (whole, name: string, separator: string, secret: string) => SECRET_NAME.test(name)
      ? `${name}${separator}${redactedSecretValue(secret)}`
      : whole,
  )
  value = value.replace(
    /(^|[\s;&|([{])((?:--?|\/)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd|credential|private[-_]?key)(?:\s*=\s*|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gimu,
    `$1$2${DISPLAY_REDACTION}`,
  )
  value = value.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gu,
    (whole, name: string, separator: string) => SECRET_NAME.test(name) ? `${name}${separator}${DISPLAY_REDACTION}` : whole,
  )
  value = value.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,127})\1(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gu,
    (whole, quote: string, name: string, separator: string) => SECRET_NAME.test(name)
      ? `${quote}${name}${quote}${separator}"${DISPLAY_REDACTION}"`
      : whole,
  )
  value = value.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;|}\]]+)/gu,
    (whole, name: string, separator: string) => SECRET_NAME.test(name)
      ? `${name}${separator}${DISPLAY_REDACTION}`
      : whole,
  )
  value = value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, DISPLAY_REDACTION)
  value = value.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, DISPLAY_REDACTION)
  value = value.replace(
    /(?<![A-Za-z0-9_-])(?:AIza[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9_-]{12,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,})(?![A-Za-z0-9_-])/gu,
    DISPLAY_REDACTION,
  )
  value = value.replace(
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gu,
    DISPLAY_REDACTION,
  )
  return value
}

function completeDisplayText(
  raw: string | null | undefined,
  limits: DisplayTextLimits,
  field: string,
): string {
  if (raw === null || raw === undefined || raw.length === 0) return limits.fallback
  const value = redactDisplaySecrets(visibleControls(raw))
  if (
    value.split("\n").length > limits.maxLines ||
    value.length > limits.maxChars ||
    Buffer.byteLength(value, "utf8") > limits.maxBytes
  ) {
    // Approval text is authority-bearing. A visible truncation marker still asks the user to approve
    // unseen content, so reject the provider request instead of staging a partial consent card.
    throw new RpcProtocolError(-32602, `Codex ${field} cannot be completely represented for approval`)
  }
  return value.trim().length === 0 ? limits.fallback : value
}

function displayLabel(
  raw: string | null | undefined,
  fallback: string,
  maxChars = 1_024,
  maxBytes = 2_048,
  field = "label",
): string {
  return completeDisplayText(
    raw?.replace(/\r\n?|\n/gu, " ⏎ "),
    { maxChars, maxBytes, maxLines: 1, fallback },
    field,
  )
}

function displayDescription(raw: string | null | undefined, fallback: string): string {
  return completeDisplayText(raw, { maxChars: 4_000, maxBytes: 8_000, maxLines: 256, fallback }, "approval reason")
}

function displayPreview(raw: string | null | undefined, fallback: string): string {
  return completeDisplayText(raw, { maxChars: 16_000, maxBytes: 24_000, maxLines: 256, fallback }, "command")
}

function displayActionPreview(raw: string): string {
  return completeDisplayText(
    raw,
    { maxChars: 16_000, maxBytes: 24_000, maxLines: 256, fallback: "Command detail unavailable" },
    "parsed command action",
  )
}

function displayDiff(raw: string): string | undefined {
  if (!raw) return undefined
  return completeDisplayText(
    raw,
    { maxChars: 16_000, maxBytes: 24_000, maxLines: 256, fallback: "Diff detail unavailable" },
    "file diff",
  )
}

type RequestedPermissionsType = z.infer<typeof RequestedPermissions>
type FileSystemPathType = z.infer<typeof FileSystemPath>

function fileSystemPathLabel(path: FileSystemPathType): string {
  if (path.type === "path") return displayLabel(path.path, "Filesystem path unavailable", 2_048, 4_096)
  if (path.type === "glob_pattern") return displayLabel(`Glob pattern: ${path.pattern}`, "Glob pattern unavailable", 2_048, 4_096)
  if (path.value.kind === "root") return "Filesystem root (/)"
  if (path.value.kind === "minimal") return "Minimal filesystem set"
  if (path.value.kind === "tmpdir") return "System temporary directory"
  if (path.value.kind === "slash_tmp") return "/tmp"
  if (path.value.kind === "project_roots") {
    return path.value.subpath
      ? displayLabel(`Project roots, subpath: ${path.value.subpath}`, "Project roots", 2_048, 4_096)
      : "Project roots"
  }
  return displayLabel(
    path.value.subpath ? `${path.value.path}, subpath: ${path.value.subpath}` : path.value.path,
    "Provider-defined filesystem path",
    2_048,
    4_096,
  )
}

function permissionCapabilities(permissions: RequestedPermissionsType | null | undefined): InteractionCapability[] {
  if (!permissions) return []
  const capabilities: InteractionCapability[] = []
  if (permissions.network) capabilities.push({ kind: "network", enabled: permissions.network.enabled, hosts: [] })
  if (permissions.fileSystem) {
    const byAccess: Record<"read" | "write" | "deny", string[]> = { read: [], write: [], deny: [] }
    for (const path of permissions.fileSystem.read ?? []) byAccess.read.push(displayLabel(path, "Read path unavailable", 2_048, 4_096))
    for (const path of permissions.fileSystem.write ?? []) byAccess.write.push(displayLabel(path, "Write path unavailable", 2_048, 4_096))
    for (const entry of permissions.fileSystem.entries ?? []) byAccess[entry.access].push(fileSystemPathLabel(entry.path))
    for (const access of ["read", "write", "deny"] as const) {
      const resources = byAccess[access]
      if (resources.length > 32) {
        throw new RpcProtocolError(-32602, `Codex filesystem ${access} scope has too many resources to display completely`)
      }
      if (resources.length > 0) capabilities.push({ kind: "filesystem", access, resources })
    }
    if (permissions.fileSystem.globScanMaxDepth !== undefined) {
      capabilities.push({ kind: "glob-scan", depth: permissions.fileSystem.globScanMaxDepth })
    }
  }
  return capabilities
}

function commandActions(actions: z.infer<typeof CommandAction>[] | null | undefined): InteractionCommandAction[] | undefined {
  if (!actions?.length) return undefined
  if (actions.length > 16) {
    throw new RpcProtocolError(-32602, "Codex command approval has too many parsed actions to display completely")
  }
  return actions.map((action) => {
    if (action.type === "read") {
      return {
        kind: "read",
        commandPreview: displayActionPreview(action.command),
        resourceLabel: displayLabel(`${action.path} (${action.name})`, "Read target unavailable", 2_048, 4_096),
      }
    }
    if (action.type === "listFiles") {
      return {
        kind: "list-files",
        commandPreview: displayActionPreview(action.command),
        resourceLabel: action.path !== null
          ? displayLabel(action.path, "List target unavailable", 2_048, 4_096)
          : "Current working directory",
      }
    }
    if (action.type === "search") {
      return {
        kind: "search",
        commandPreview: displayActionPreview(action.command),
        ...(action.path !== null ? { resourceLabel: displayLabel(action.path, "Search target unavailable", 2_048, 4_096) } : {}),
        ...(action.query !== null ? { queryLabel: displayLabel(action.query, "Search query unavailable") } : {}),
      }
    }
    return { kind: "unknown", commandPreview: displayActionPreview(action.command) }
  })
}

function commandCapabilities(params: z.infer<typeof CommandApprovalParams>): InteractionCapability[] | undefined {
  const capabilities = permissionCapabilities(params.additionalPermissions)
  if (params.networkApprovalContext) {
    const host = displayLabel(
      `${params.networkApprovalContext.protocol}: ${params.networkApprovalContext.host}`,
      "Network host unavailable",
      2_048,
      4_096,
    )
    const network = capabilities.find((capability): capability is Extract<InteractionCapability, { kind: "network" }> => capability.kind === "network")
    if (network) network.hosts = [...network.hosts, host]
    else capabilities.unshift({ kind: "network", enabled: null, hosts: [host] })
  }
  if (params.proposedExecpolicyAmendment?.length) {
    if (params.proposedExecpolicyAmendment.length > 32) {
      throw new RpcProtocolError(-32602, "Codex execution policy amendment has too many prefix tokens to display completely")
    }
    capabilities.push({
      kind: "exec-policy",
      prefixes: params.proposedExecpolicyAmendment.map((part) =>
        displayLabel(part, "Command prefix token unavailable", 2_048, 4_096, "execution policy prefix")),
    })
  }
  for (const action of ["allow", "deny"] as const) {
    const matching = (params.proposedNetworkPolicyAmendments ?? []).filter((amendment) => amendment.action === action)
    if (matching.length > 24) {
      throw new RpcProtocolError(-32602, `Codex ${action} network policy has too many hosts to display completely`)
    }
    const hosts = matching.map((amendment) =>
      displayLabel(amendment.host, "Network host unavailable", 2_048, 4_096, "network policy host"))
    if (hosts.length) capabilities.push({ kind: "network-policy", access: action, hosts })
  }
  return capabilities.length ? capabilities : undefined
}

interface FileChangeDisplaySnapshot {
  changes: InteractionFileChangeDisplay[]
  totalChanges: number
}

function fileChangeDisplays(changes: z.infer<typeof FileUpdateChange>[]): FileChangeDisplaySnapshot {
  if (changes.length > 16) {
    throw new RpcProtocolError(-32602, "Codex file approval has too many changes to display completely")
  }
  return {
    totalChanges: changes.length,
    changes: changes.map((change) => {
      const diffPreview = displayDiff(change.diff)
      const base = {
        pathLabel: displayLabel(change.path, "Affected path unavailable", 2_048, 4_096),
        ...(diffPreview ? { diffPreview } : {}),
      }
      if (change.kind.type === "add") return { ...base, operation: "create" as const }
      if (change.kind.type === "delete") return { ...base, operation: "delete" as const }
      if (change.kind.move_path !== null) {
        return {
          ...base,
          operation: "move" as const,
          destinationLabel: displayLabel(change.kind.move_path, "Destination path unavailable", 2_048, 4_096),
        }
      }
      return { ...base, operation: "write" as const }
    }),
  }
}

function canonicalJson(value: unknown): string {
  const visiting = new WeakSet<object>()
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("non-finite JSON number")
      return candidate
    }
    if (typeof candidate !== "object") throw new Error("non-JSON value")
    if (visiting.has(candidate)) throw new Error("cyclic JSON value")
    visiting.add(candidate)
    try {
      if (Array.isArray(candidate)) return candidate.map((item) => item === undefined ? null : normalize(item))
      const object = candidate as JsonObject
      return Object.fromEntries(Object.keys(object).sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, normalize(object[key])]))
    } finally {
      visiting.delete(candidate)
    }
  }
  return JSON.stringify(normalize(value))
}

function logicalRequestId(method: string, parts: readonly (string | null | undefined)[]): string {
  const digest = createHash("sha256").update(JSON.stringify([method, ...parts])).digest("hex")
  return `codex-${digest}`
}

function requestFingerprint(value: unknown): string {
  const normalized = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : value
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    // Delivery timing is not part of the requested authority and may be recomputed when app-server
    // reissues a still-pending request after reconnect.
    const record = normalized as JsonObject
    delete record.startedAtMs
    delete record.autoResolutionMs
  }
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex")
}

function decision(
  id: string,
  semantic: "approve" | "deny" | "cancel" | "accept" | "decline" | "answer",
  label: string,
) {
  return { id, semantic, label }
}

const commandDecisionMap = {
  accept: decision("accept", "approve", "Approve once"),
  acceptForSession: decision("acceptForSession", "approve", "Approve for this session"),
  decline: decision("decline", "deny", "Deny"),
  cancel: decision("cancel", "cancel", "Cancel"),
} as const

function commandDecisions(raw: unknown[] | null | undefined) {
  // The pinned 0.144.1 app-server always emits its computed, context-sensitive decision set. A
  // missing list is therefore a malformed authority request, not permission to synthesize a broader
  // legacy menu (for example, additional-permission requests intentionally omit session approval).
  if (!raw) throw new RpcProtocolError(-32602, "Codex command approval omitted its available decisions")
  const advertised = raw
  if (advertised.some((value) => typeof value !== "string" || !(value in commandDecisionMap))) {
    throw new RpcProtocolError(-32602, "Codex advertised an unsupported structured command decision")
  }
  const result = advertised.map((value) => commandDecisionMap[value as keyof typeof commandDecisionMap])
  if (result.length === 0) throw new RpcProtocolError(-32602, "Codex advertised no supported command decisions")
  return result
}

function fileDecisions() {
  return [
    decision("accept", "approve", "Approve once"),
    decision("acceptForSession", "approve", "Approve for this session"),
    decision("decline", "deny", "Deny"),
    decision("cancel", "cancel", "Cancel"),
  ]
}

function permissionDecisions() {
  return [
    decision("grant-turn", "approve", "Grant for this turn"),
    decision("grant-session", "approve", "Grant for this session"),
    decision("deny", "deny", "Deny"),
  ]
}

function elicitationDecisions() {
  return [
    decision("accept", "accept", "Accept"),
    decision("decline", "decline", "Decline"),
    decision("cancel", "cancel", "Cancel"),
  ]
}

function questionDecisions() {
  return [decision("answer", "answer", "Answer")]
}

function mcpField(id: string, raw: unknown, required: boolean): InteractionField {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcProtocolError(-32602, "MCP elicitation contains an invalid field schema")
  }
  const schema = raw as JsonObject
  const label = cleanText(typeof schema.title === "string" ? schema.title : id, 160, id)
  const description = typeof schema.description === "string" ? cleanText(schema.description, 4_000, "Field requested by MCP") : undefined
  const base = { id, label, description, required, secret: false }

  if (schema.type === "array") {
    if (schema.items === null || typeof schema.items !== "object" || Array.isArray(schema.items)) {
      throw new RpcProtocolError(-32602, "MCP multi-select field has invalid items")
    }
    const items = schema.items as JsonObject
    const values = Array.isArray(items.enum)
      ? items.enum
      : Array.isArray(items.anyOf)
        ? items.anyOf.map((candidate) => candidate && typeof candidate === "object" ? (candidate as JsonObject).const : undefined)
        : null
    if (!values || values.length === 0 || values.length > 64 || values.some((value) => typeof value !== "string")) {
      throw new RpcProtocolError(-32602, "MCP multi-select field has unsupported options")
    }
    const labels = Array.isArray(items.enumNames) ? items.enumNames : null
    const anyOf = Array.isArray(items.anyOf) ? items.anyOf : null
    const itemBound = (value: unknown): number | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 32) {
        throw new RpcProtocolError(-32602, "MCP multi-select bounds exceed the supported interaction contract")
      }
      return value
    }
    const minItems = itemBound(schema.minItems)
    const maxItems = itemBound(schema.maxItems)
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw new RpcProtocolError(-32602, "MCP multi-select minimum exceeds its maximum")
    }
    return {
      ...base,
      input: "multi-select",
      options: values.map((value, index) => ({
        value: value as string,
        label: cleanText(
          typeof labels?.[index] === "string"
            ? labels[index]
            : anyOf?.[index] && typeof anyOf[index] === "object" && typeof (anyOf[index] as JsonObject).title === "string"
              ? (anyOf[index] as JsonObject).title as string
              : value as string,
          160,
          value as string,
        ),
      })),
      minItems,
      maxItems,
      default: Array.isArray(schema.default) ? schema.default.filter((value): value is string => typeof value === "string").slice(0, 32) : undefined,
    }
  }

  if (schema.type === "string" && (Array.isArray(schema.enum) || Array.isArray(schema.oneOf))) {
    const values = Array.isArray(schema.enum)
      ? schema.enum
      : (schema.oneOf as unknown[]).map((candidate) => candidate && typeof candidate === "object" ? (candidate as JsonObject).const : undefined)
    if (values.length === 0 || values.length > 64 || values.some((value) => typeof value !== "string")) {
      throw new RpcProtocolError(-32602, "MCP select field has unsupported options")
    }
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : null
    const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : null
    return {
      ...base,
      input: "select",
      options: values.map((value, index) => ({
        value: value as string,
        label: cleanText(
          typeof names?.[index] === "string"
            ? names[index]
            : oneOf?.[index] && typeof oneOf[index] === "object" && typeof (oneOf[index] as JsonObject).title === "string"
              ? (oneOf[index] as JsonObject).title as string
              : value as string,
          160,
          value as string,
        ),
      })),
      default: typeof schema.default === "string" ? schema.default : undefined,
    }
  }

  if (schema.type === "string") {
    const format = ["email", "uri", "date", "date-time"].includes(String(schema.format))
      ? schema.format as "email" | "uri" | "date" | "date-time"
      : undefined
    return {
      ...base,
      input: "text",
      minLength: typeof schema.minLength === "number" ? Math.max(0, Math.min(4_000, Math.trunc(schema.minLength))) : undefined,
      maxLength: typeof schema.maxLength === "number" ? Math.max(0, Math.min(4_000, Math.trunc(schema.maxLength))) : undefined,
      format,
      default: typeof schema.default === "string" ? schema.default.slice(0, 4_000) : undefined,
    }
  }
  if (schema.type === "number" || schema.type === "integer") {
    return {
      ...base,
      input: schema.type,
      minimum: typeof schema.minimum === "number" && Number.isFinite(schema.minimum) ? schema.minimum : undefined,
      maximum: typeof schema.maximum === "number" && Number.isFinite(schema.maximum) ? schema.maximum : undefined,
      default: typeof schema.default === "number" && Number.isFinite(schema.default) ? schema.default : undefined,
    }
  }
  if (schema.type === "boolean") {
    return { ...base, input: "boolean", default: typeof schema.default === "boolean" ? schema.default : undefined }
  }
  throw new RpcProtocolError(-32602, "MCP elicitation contains an unsupported field type")
}

function mcpFields(raw: unknown): InteractionField[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcProtocolError(-32602, "MCP elicitation schema must be an object")
  }
  const schema = raw as JsonObject
  if (schema.type !== "object" || schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new RpcProtocolError(-32602, "MCP elicitation schema must describe object properties")
  }
  const entries = Object.entries(schema.properties as JsonObject)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  if (entries.length > 32) throw new RpcProtocolError(-32602, "MCP elicitation has too many fields")
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [])
  return entries.map(([id, field]) => mcpField(id, field, required.has(id)))
}

function userInputFields(questions: z.infer<typeof UserInputQuestion>[]): InteractionField[] {
  return questions.map((question) => {
    const base = {
      id: question.id,
      label: cleanText(question.header, 160, "Question"),
      description: cleanText(
        question.isOther && question.options
          ? `${question.question}\nSuggested answers: ${question.options.map((option) => option.label).join(", ")}`
          : question.question,
        4_000,
        "Codex requested input",
      ),
      required: true,
      secret: question.isSecret,
    }
    if (question.options && !question.isOther) {
      return {
        ...base,
        input: "select" as const,
        options: question.options.map((option) => ({ value: option.label, label: option.label })),
      }
    }
    return { ...base, input: "multiline" as const, maxLength: 4_000 }
  })
}

const InitializeResponse = z.object({
  userAgent: z.string().min(1).max(2_048),
  codexHome: z.string().min(1).max(8_192),
  platformFamily: z.string().min(1).max(128),
  platformOs: z.string().min(1).max(128),
}).strict()
const ThreadResponse = z.object({
  thread: z.object({
    id: Opaque,
    sessionId: Opaque,
    ephemeral: z.boolean(),
  }).passthrough(),
}).passthrough()
const TurnResponse = z.object({ turn: z.object({ id: Opaque }).passthrough() }).strict()
const TurnStarted = z.object({ threadId: Opaque, turn: z.object({ id: Opaque }).passthrough() }).strict()
const TurnCompleted = z.object({ threadId: Opaque, turn: z.object({ id: Opaque }).passthrough() }).strict()
const MAX_CORRELATED_FILE_ITEMS = 128

interface CorrelatedFileItem extends FileChangeDisplaySnapshot {
  threadId: string
  turnId: string
  itemId: string
  connectionEpoch: number
  snapshotFingerprint: string
  interactionId?: string
  rpcRequestId?: RpcId
}

function correlatedFileItemKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}\u0000${turnId}\u0000${itemId}`
}

export class CodexAppServerBridge {
  private readonly db: Database.Database
  private readonly now: () => Date
  private readonly makeId: () => string
  private readonly spawn: CodexAppServerSpawn
  private readonly codexBin: string
  private readonly timeoutMs: number
  private connection: JsonlRpcConnection | null = null
  private openingConnection: JsonlRpcConnection | null = null
  private connecting: Promise<JsonlRpcConnection> | null = null
  private connectionEpoch = 0
  private capabilityRevision = 0
  private closed = false
  private dbClosed = false
  private readonly options: CodexAppServerBridgeOptions
  private readonly startingSessions = new Set<string>()
  private readonly startingTurns = new Set<string>()
  private readonly pendingTurnStarts = new Set<string>()
  private readonly correlatedFileItems = new Map<string, CorrelatedFileItem>()
  private activeOperations = 0
  private readonly operationWaiters = new Set<() => void>()
  private shutdownPromise: Promise<void> | null = null

  constructor(options: CodexAppServerBridgeOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.makeId = options.id ?? randomUUID
    this.codexBin = options.codexBin ?? "codex"
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.spawn = options.spawn ?? ((binary, args, spawnOptions) => spawnChild(binary, [...args], {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams)
    this.db = new Database(options.dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("busy_timeout = 5000")
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS codex_app_server_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version   INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO codex_app_server_schema (singleton, version)
          VALUES (1, ${BRIDGE_DB_SCHEMA_VERSION});
      `)
    } catch {
      this.db.close()
      throw new InteractionStoreError("schema-version", "Codex app-server bridge schema marker is invalid")
    }
    const schemaVersion = this.db.prepare<[], { version: number }>(
      "SELECT version FROM codex_app_server_schema WHERE singleton = 1",
    ).get()?.version
    if (schemaVersion !== BRIDGE_DB_SCHEMA_VERSION) {
      this.db.close()
      throw new InteractionStoreError("schema-version", `unsupported Codex app-server bridge schema ${String(schemaVersion)}`)
    }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS codex_app_server_meta (
          singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
          connection_epoch      INTEGER NOT NULL CHECK (connection_epoch >= 0),
          capability_revision   INTEGER NOT NULL CHECK (capability_revision >= 0),
          protocol_fingerprint  TEXT NOT NULL
        );
        INSERT OR IGNORE INTO codex_app_server_meta (
          singleton, connection_epoch, capability_revision, protocol_fingerprint
        ) VALUES (1, 0, 0, '');

        CREATE TABLE IF NOT EXISTS codex_app_server_session (
          fray_session_id       TEXT PRIMARY KEY,
          thread_slug           TEXT NOT NULL UNIQUE,
          codex_thread_id       TEXT NOT NULL UNIQUE,
          codex_session_id      TEXT NOT NULL,
          session_epoch         INTEGER NOT NULL CHECK (session_epoch >= 1),
          capability_revision   INTEGER NOT NULL CHECK (capability_revision >= 1),
          connection_epoch      INTEGER NOT NULL CHECK (connection_epoch >= 1),
          current_turn_id       TEXT,
          cwd                   TEXT NOT NULL,
          ephemeral             INTEGER NOT NULL CHECK (ephemeral IN (0, 1)),
          state                 TEXT NOT NULL CHECK (state IN ('active', 'detached')),
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS codex_app_server_session_thread
          ON codex_app_server_session (codex_thread_id, state);
      `)
    } catch {
      this.db.close()
      throw new InteractionStoreError("schema-version", "Codex app-server bridge schema could not be migrated safely")
    }
    const columns = (table: "codex_app_server_meta" | "codex_app_server_session") => new Set(
      this.db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((column) => column.name),
    )
    const requiredMeta = ["singleton", "connection_epoch", "capability_revision", "protocol_fingerprint"]
    const requiredSession = [
      "fray_session_id", "thread_slug", "codex_thread_id", "codex_session_id", "session_epoch",
      "capability_revision", "connection_epoch", "current_turn_id", "cwd", "ephemeral", "state",
      "created_at", "updated_at",
    ]
    if (requiredMeta.some((column) => !columns("codex_app_server_meta").has(column)) ||
      requiredSession.some((column) => !columns("codex_app_server_session").has(column))) {
      this.db.close()
      throw new InteractionStoreError("schema-version", "Codex app-server bridge schema is missing required columns")
    }
    try {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS codex_app_server_session_slug_unique
          ON codex_app_server_session (thread_slug);
        CREATE UNIQUE INDEX IF NOT EXISTS codex_app_server_session_thread_unique
          ON codex_app_server_session (codex_thread_id);
      `)
    } catch {
      this.db.close()
      throw new InteractionStoreError("corrupt-journal", "Codex app-server bridge ownership bindings are not unique")
    }
  }

  async startDisposableSession(input: StartCodexAppServerSessionInput): Promise<CodexAppServerSessionBinding> {
    if (!ThreadSlug.safeParse(input.threadSlug).success) throw new Error("invalid Fray thread slug")
    if (!input.sessionId || input.sessionId.length > 256) throw new Error("invalid Fray session id")
    if (!input.cwd.startsWith("/") || input.cwd.length > 8_192) throw new Error("Codex app-server cwd must be an absolute bounded path")
    if (input.permissions && input.sandbox) throw new Error("Codex app-server permissions and sandbox are mutually exclusive")
    const startKeys = [`slug:${input.threadSlug}`, `session:${input.sessionId}`]
    if (startKeys.some((key) => this.startingSessions.has(key))) {
      throw new Error("Codex app-server session start is already in progress")
    }
    const releaseOperation = this.beginOperation()
    for (const key of startKeys) this.startingSessions.add(key)
    try {
      if (this.bindingForScope(input.threadSlug, input.sessionId)) {
        throw new Error("Codex app-server session is already owned by this bridge")
      }
      if (this.db.prepare("SELECT 1 FROM codex_app_server_session WHERE thread_slug = ? OR fray_session_id = ?").get(input.threadSlug, input.sessionId)) {
        throw new Error("Codex app-server thread slug or session id is already bound")
      }

      const connection = await this.ensureConnected()
      const ephemeral = input.ephemeral ?? true
      const response = ThreadResponse.parse(await connection.request("thread/start", {
        cwd: input.cwd,
        model: input.model ?? null,
        approvalPolicy: input.approvalPolicy ?? "on-request",
        approvalsReviewer: "user",
        ...(input.permissions
          ? { permissions: input.permissions }
          : { sandbox: input.sandbox ?? "read-only" }),
        ephemeral,
      }))
      if (response.thread.ephemeral !== ephemeral) throw new Error("Codex app-server returned an incompatible persistence mode")
      const at = this.now().toISOString()
      this.db.prepare(`
        INSERT INTO codex_app_server_session (
          fray_session_id, thread_slug, codex_thread_id, codex_session_id,
          session_epoch, capability_revision, connection_epoch, current_turn_id,
          cwd, ephemeral, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, 'active', ?, ?)
      `).run(
        input.sessionId,
        input.threadSlug,
        response.thread.id,
        response.thread.sessionId,
        this.capabilityRevision,
        this.connectionEpoch,
        input.cwd,
        ephemeral ? 1 : 0,
        at,
        at,
      )
      return bindingFromRow(this.bindingForScope(input.threadSlug, input.sessionId)!)
    } finally {
      for (const key of startKeys) this.startingSessions.delete(key)
      releaseOperation()
    }
  }

  async resumeOwnedSession(threadSlug: string, sessionId: string): Promise<CodexAppServerSessionBinding> {
    const releaseOperation = this.beginOperation()
    try {
      let binding = this.bindingForScope(threadSlug, sessionId)
      if (!binding) throw new Error("Codex app-server resume requires a bridge-owned session; TUI/default sessions are not migrated")
      const connection = await this.ensureConnected()
      binding = this.bindingForScope(threadSlug, sessionId)!
      if (binding.ephemeral === 1 && (binding.state !== "active" || binding.connection_epoch !== this.connectionEpoch)) {
        throw new Error("disposable Codex app-server sessions cannot be resumed after their owning process disconnects")
      }
      if (binding.state === "active" && binding.connection_epoch === this.connectionEpoch) return bindingFromRow(binding)
      if (binding.ephemeral === 1) throw new Error("disposable Codex app-server session is detached")

      const response = ThreadResponse.parse(await connection.request("thread/resume", {
        threadId: binding.codex_thread_id,
        excludeTurns: true,
        approvalsReviewer: "user",
      }))
      if (response.thread.id !== binding.codex_thread_id || response.thread.ephemeral) {
        throw new Error("Codex app-server resumed a different or disposable thread")
      }
      this.updateResumedBinding(binding, response.thread.sessionId)
      return bindingFromRow(this.bindingForScope(threadSlug, sessionId)!)
    } finally {
      releaseOperation()
    }
  }

  async startTurn(input: StartCodexAppServerTurnInput): Promise<{ turnId: string }> {
    if (!input.text || Buffer.byteLength(input.text, "utf8") > 64 * 1024) throw new Error("Codex app-server turn text is empty or too large")
    const startKey = `${input.threadSlug}\u0000${input.sessionId}`
    if (this.startingTurns.has(startKey)) throw new Error("Codex app-server turn start is already in progress")
    const releaseOperation = this.beginOperation()
    this.startingTurns.add(startKey)
    try {
      const connection = await this.ensureConnected()
      let binding = this.bindingForScope(input.threadSlug, input.sessionId)
      if (!binding) throw new Error("Codex app-server turn requires a bridge-owned session")
      if (binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") {
        await this.resumeOwnedSession(input.threadSlug, input.sessionId)
        binding = this.bindingForScope(input.threadSlug, input.sessionId)!
      }
      if (binding.current_turn_id !== null) throw new Error("Codex app-server session already has an active turn")
      const pendingKey = turnKey(binding)
      this.pendingTurnStarts.add(pendingKey)
      try {
        const response = TurnResponse.parse(await connection.request("turn/start", {
          threadId: binding.codex_thread_id,
          clientUserMessageId: this.makeId(),
          input: [{ type: "text", text: input.text, text_elements: [] }],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }))
        const witnessed = this.bindingForScope(input.threadSlug, input.sessionId)
        if (!witnessed || witnessed.connection_epoch !== this.connectionEpoch || witnessed.state !== "active") {
          throw new Error("Codex app-server session detached during turn start")
        }
        if (witnessed.current_turn_id !== null && witnessed.current_turn_id !== response.turn.id) {
          throw new Error("Codex app-server turn/start response disagreed with the witnessed turn")
        }
        const changed = this.db.prepare(`
          UPDATE codex_app_server_session SET current_turn_id = ?, updated_at = ?
          WHERE fray_session_id = ? AND thread_slug = ? AND connection_epoch = ? AND state = 'active'
            AND (current_turn_id IS NULL OR current_turn_id = ?)
        `).run(response.turn.id, this.now().toISOString(), input.sessionId, input.threadSlug, this.connectionEpoch, response.turn.id).changes
        if (changed !== 1) throw new Error("Codex app-server turn ownership changed during start")
        return { turnId: response.turn.id }
      } finally {
        this.pendingTurnStarts.delete(pendingKey)
      }
    } finally {
      this.startingTurns.delete(startKey)
      releaseOperation()
    }
  }

  binding(threadSlug: string, sessionId: string): CodexAppServerSessionBinding | undefined {
    if (this.dbClosed) return undefined
    const row = this.bindingForScope(threadSlug, sessionId)
    return row ? bindingFromRow(row) : undefined
  }

  ownsInteraction(scope: InteractionSessionScope, interactionId: string): boolean {
    if (this.closed || this.dbClosed || !this.connection) return false
    const delivery = this.options.interactions.providerDelivery(scope, interactionId)
    if (
      !delivery ||
      delivery.provider !== CODEX_APP_SERVER_PROVIDER ||
      delivery.connectionEpoch !== this.connectionEpoch
    ) return false
    const binding = this.bindingForScope(scope.threadSlug, scope.sessionId)
    return binding?.state === "active" && binding.connection_epoch === this.connectionEpoch
  }

  // Called only from the registry's exact old-session lifecycle event. It is intentionally scoped by
  // both slug and Fray session id, so replacing/deleting a TUI session cannot touch this bridge. The
  // registry transaction has already terminalized delivery rows and detached any matching binding;
  // this hook removes that binding and terminates the shared child so no native server request can
  // remain waiting in a process Fray no longer owns.
  releaseSession(
    threadSlug: string,
    sessionId: string,
    reason: "session-replaced" | "session-deleted",
  ): boolean {
    if (this.closed || this.dbClosed) return false
    const row = this.bindingForScope(threadSlug, sessionId)
    if (!row) return false
    const ownsCurrentProcess = row.connection_epoch === this.connectionEpoch || this.openingConnection !== null
    try {
      this.forgetCorrelatedFileItems(row.codex_thread_id)
      this.options.interactions.cancelForSession(threadSlug, sessionId, reason)
      this.db.prepare(`
        DELETE FROM codex_app_server_session
        WHERE thread_slug = ? AND fray_session_id = ?
      `).run(threadSlug, sessionId)
    } finally {
      if (ownsCurrentProcess) this.disconnectOwnedProcess()
    }
    return true
  }

  async resolveInteraction(
    scope: InteractionSessionScope,
    input: ResolveInteractionInput,
  ): Promise<QueueProviderResponseResult | undefined> {
    const releaseOperation = this.beginOperation()
    try {
      const record = this.options.interactions.get(scope, input.interactionId)
      if (!record) return undefined
      const delivery = this.options.interactions.providerDelivery(scope, input.interactionId)
      if (!delivery || delivery.provider !== CODEX_APP_SERVER_PROVIDER) return undefined
      const providerResponse = this.providerResponse(record, delivery, input)
      const result = this.options.interactions.queueProviderResponse(scope, input, providerResponse)
      await this.flushDelivery(result.delivery)
      return result
    } finally {
      releaseOperation()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.forgetCorrelatedFileItems()
    let detachError: unknown
    try {
      if (!this.dbClosed) {
        // A clean Fray shutdown may later resume a persisted native session, but no binding may stay
        // active against the process being killed. Preserve current_turn_id for witnessed replay/rebind.
        this.db.prepare(`
          UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
          WHERE state = 'active'
        `).run(this.now().toISOString())
      }
    } catch (error) {
      detachError = error
    }
    const drainingConnections = new Set<JsonlRpcConnection>()
    if (this.connection) {
      const epoch = this.connectionEpoch
      drainingConnections.add(this.connection)
      this.connection.close()
      this.connection = null
      this.options.diagnostic?.({ event: "disconnected", connectionEpoch: epoch, reason: "closed" })
    }
    if (this.openingConnection) drainingConnections.add(this.openingConnection)
    this.openingConnection?.close()
    this.openingConnection = null
    const connecting = this.connecting
    this.shutdownPromise = (async () => {
      await Promise.allSettled([
        ...[...drainingConnections].map((connection) => connection.whenIdle()),
        ...(connecting ? [connecting.then(() => undefined, () => undefined)] : []),
        this.whenOperationsIdle(),
      ])
      // A public operation that had already crossed its RPC await can finish a binding write after
      // the eager detach above. Reassert the closed-state invariant only after every operation and
      // inbound dispatch is idle, then close the bridge connection. This is the authoritative edge.
      let finalDetachError: unknown
      try {
        if (!this.dbClosed) {
          this.db.prepare(`
            UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
            WHERE state = 'active'
          `).run(this.now().toISOString())
        }
      } catch (error) {
        finalDetachError = error
      }
      this.closeDatabase()
      if (detachError ?? finalDetachError) throw detachError ?? finalDetachError
    })()
    // Legacy callers use close() synchronously. Observe the async drain here; lifecycle shutdown calls
    // shutdown() below to receive the authoritative result.
    void this.shutdownPromise.catch(() => undefined)
    if (detachError) throw detachError
  }

  async shutdown(): Promise<void> {
    if (!this.closed) this.close()
    await this.shutdownPromise
  }

  private beginOperation(): () => void {
    if (this.closed || this.dbClosed) throw new Error("Codex app-server bridge is closed")
    this.activeOperations++
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeOperations--
      if (this.activeOperations === 0) {
        for (const resolve of this.operationWaiters) resolve()
        this.operationWaiters.clear()
      }
    }
  }

  private whenOperationsIdle(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.operationWaiters.add(resolve))
  }

  private closeDatabase(): void {
    if (this.dbClosed) return
    this.dbClosed = true
    this.db.close()
  }

  private disconnectOwnedProcess(): void {
    if (this.dbClosed) return
    const epoch = this.connectionEpoch
    this.forgetCorrelatedFileItems()
    try {
      this.db.prepare(`
        UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
        WHERE state = 'active'
      `).run(this.now().toISOString())
    } finally {
      if (this.connection) {
        const connection = this.connection
        this.connection = null
        connection.close()
        this.options.diagnostic?.({ event: "disconnected", connectionEpoch: epoch, reason: "closed" })
      }
      if (this.openingConnection) {
        this.openingConnection.close()
        this.openingConnection = null
      }
    }
  }

  private bindingForScope(threadSlug: string, sessionId: string): BindingRow | undefined {
    const row = this.db.prepare<[string, string], BindingRow>(`
      SELECT * FROM codex_app_server_session WHERE thread_slug = ? AND fray_session_id = ?
    `).get(threadSlug, sessionId)
    return row ? checkedBindingRow(row) : undefined
  }

  private bindingForCodexThread(threadId: string): BindingRow | undefined {
    const row = this.db.prepare<[string], BindingRow>(`
      SELECT * FROM codex_app_server_session WHERE codex_thread_id = ?
    `).get(threadId)
    return row ? checkedBindingRow(row) : undefined
  }

  private async ensureConnected(): Promise<JsonlRpcConnection> {
    if (this.closed) throw new Error("Codex app-server bridge is closed")
    if (this.connection) return this.connection
    if (this.connecting) return this.connecting
    this.connecting = this.connect()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async connect(): Promise<JsonlRpcConnection> {
    const child = this.spawn(this.codexBin, ["app-server", "--stdio"], {
      cwd: this.options.projectDir,
      // Preserve only the audited Codex runtime/auth surface. Values stay in the child environment;
      // no value is copied into argv, SQLite, diagnostics, or logs.
      env: codexAppServerEnvironment(),
    })
    let connection!: JsonlRpcConnection
    connection = new JsonlRpcConnection(
      child,
      this.timeoutMs,
      (method, id, params) => this.handleServerRequest(connection, method, id, params),
      (method, params) => this.handleNotification(connection, method, params),
      (reason) => this.handleDisconnect(connection, reason),
      this.options.diagnostic,
    )
    this.openingConnection = connection
    try {
      const initialized = InitializeResponse.parse(await connection.request("initialize", {
        clientInfo: { name: "fray", title: "Fray", version: "0.0.1" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      }))
      // Exact 0.144.1 source sets our initialized client name as the originator, yielding
      // `fray/<package-version> ...`. Do not accept an expected-looking version buried elsewhere in
      // an incompatible user agent.
      const version = initialized.userAgent.match(/^fray\/(\d+\.\d+\.\d+)(?:\s|\()/u)?.[1]
      if (version !== CODEX_APP_SERVER_SUPPORTED_VERSION) {
        this.options.diagnostic?.({
          event: "version-rejected",
          expected: CODEX_APP_SERVER_SUPPORTED_VERSION,
          received: version ?? "unparseable",
        })
        throw new Error(`unsupported Codex app-server version ${version ?? "unknown"}; expected ${CODEX_APP_SERVER_SUPPORTED_VERSION}`)
      }
      const negotiated = this.db.transaction(() => {
        const rawMeta = this.db.prepare<[], unknown>(
          "SELECT * FROM codex_app_server_meta WHERE singleton = 1",
        ).get()
        const parsedMeta = BridgeMetaRowSchema.safeParse(rawMeta)
        if (!parsedMeta.success) throw new InteractionStoreError("corrupt-journal", "Codex app-server bridge metadata is corrupt")
        const meta = parsedMeta.data
        const capabilityRevision = meta.protocol_fingerprint === PROTOCOL_FINGERPRINT
          ? Math.max(1, meta.capability_revision)
          : meta.capability_revision + 1
        const connectionEpoch = meta.connection_epoch + 1
        this.db.prepare(`
          UPDATE codex_app_server_meta SET connection_epoch = ?, capability_revision = ?, protocol_fingerprint = ?
          WHERE singleton = 1
        `).run(connectionEpoch, capabilityRevision, PROTOCOL_FINGERPRINT)
        return { connectionEpoch, capabilityRevision }
      })()
      this.connectionEpoch = negotiated.connectionEpoch
      this.capabilityRevision = negotiated.capabilityRevision
      if (this.closed) throw new Error("Codex app-server bridge closed during negotiation")
      this.connection = connection
      this.openingConnection = null
      await connection.notification("initialized")
      this.options.diagnostic?.({ event: "connected", version, connectionEpoch: this.connectionEpoch })
      await this.reconcileOwnedSessions(connection)
      if (this.connection !== connection) throw new Error("Codex app-server disconnected during session reconciliation")
      return connection
    } catch (error) {
      connection.close()
      if (this.openingConnection === connection) this.openingConnection = null
      if (this.connection === connection) this.connection = null
      throw error
    }
  }

  private handleDisconnect(connection: JsonlRpcConnection, reason: "exit" | "error" | "protocol"): void {
    if (this.connection !== connection) return
    const epoch = this.connectionEpoch
    this.connection = null
    this.forgetCorrelatedFileItems()
    if (this.closed || this.dbClosed) return
    this.db.prepare(`
      UPDATE codex_app_server_session SET state = 'detached', updated_at = ?
      WHERE connection_epoch = ? AND state = 'active'
    `).run(this.now().toISOString(), epoch)
    this.options.diagnostic?.({ event: "disconnected", connectionEpoch: epoch, reason })
  }

  private async reconcileOwnedSessions(connection: JsonlRpcConnection): Promise<void> {
    const rows = this.db.prepare<[], BindingRow>("SELECT * FROM codex_app_server_session WHERE state = 'active'").all().map(checkedBindingRow)
    for (const row of rows) {
      if (row.ephemeral === 1) {
        this.db.prepare("UPDATE codex_app_server_session SET state = 'detached', updated_at = ? WHERE fray_session_id = ?")
          .run(this.now().toISOString(), row.fray_session_id)
        continue
      }
      try {
        const response = ThreadResponse.parse(await connection.request("thread/resume", {
          threadId: row.codex_thread_id,
          excludeTurns: true,
          approvalsReviewer: "user",
        }))
        if (response.thread.id !== row.codex_thread_id || response.thread.ephemeral) throw new Error("resume ownership mismatch")
        this.updateResumedBinding(row, response.thread.sessionId)
      } catch {
        this.db.prepare("UPDATE codex_app_server_session SET state = 'detached', updated_at = ? WHERE fray_session_id = ?")
          .run(this.now().toISOString(), row.fray_session_id)
      }
    }
  }

  private updateResumedBinding(row: BindingRow, codexSessionId: string): void {
    if (row.capability_revision !== this.capabilityRevision) {
      this.options.interactions.cancelForSession(row.thread_slug, row.fray_session_id, "capabilities-changed")
    }
    this.db.prepare(`
      UPDATE codex_app_server_session SET
        codex_session_id = ?, capability_revision = ?, connection_epoch = ?, state = 'active', updated_at = ?
      WHERE fray_session_id = ? AND thread_slug = ? AND codex_thread_id = ?
    `).run(
      codexSessionId,
      this.capabilityRevision,
      this.connectionEpoch,
      this.now().toISOString(),
      row.fray_session_id,
      row.thread_slug,
      row.codex_thread_id,
    )
  }

  private ownedBinding(threadId: string, turnId: string | null): BindingRow {
    const row = this.bindingForCodexThread(threadId)
    if (!row || row.state !== "active" || row.connection_epoch !== this.connectionEpoch) {
      throw new RpcProtocolError(-32602, "Codex request is not owned by this Fray bridge connection")
    }
    if (turnId !== null) {
      if (row.current_turn_id !== null && row.current_turn_id !== turnId) {
        throw new RpcProtocolError(-32602, "Codex request belongs to a stale or different turn")
      }
      if (row.current_turn_id === null) {
        if (!this.pendingTurnStarts.has(turnKey(row))) {
          throw new RpcProtocolError(-32602, "Codex request has no witnessed locally-started turn")
        }
        // A server request may race the turn/start response. The provider-issued turn id is the
        // authority; pin it before journaling rather than inventing a client-side id.
        this.db.prepare(`
          UPDATE codex_app_server_session SET current_turn_id = ?, updated_at = ?
          WHERE fray_session_id = ? AND connection_epoch = ? AND current_turn_id IS NULL
        `).run(turnId, this.now().toISOString(), row.fray_session_id, this.connectionEpoch)
        return this.bindingForCodexThread(threadId)!
      }
    }
    return row
  }

  private notificationOwnsTurn(threadId: string, turnId: string): boolean {
    const row = this.bindingForCodexThread(threadId)
    if (!row || row.state !== "active" || row.connection_epoch !== this.connectionEpoch) return false
    if (row.current_turn_id === turnId) return true
    return row.current_turn_id === null && this.pendingTurnStarts.has(turnKey(row))
  }

  private rememberFileItem(threadId: string, turnId: string, itemId: string, changes: z.infer<typeof FileUpdateChange>[]): void {
    if (!this.notificationOwnsTurn(threadId, turnId)) return
    const key = correlatedFileItemKey(threadId, turnId, itemId)
    this.correlatedFileItems.delete(key)
    this.correlatedFileItems.set(key, {
      threadId,
      turnId,
      itemId,
      connectionEpoch: this.connectionEpoch,
      snapshotFingerprint: requestFingerprint(changes),
      ...fileChangeDisplays(changes),
    })
    while (this.correlatedFileItems.size > MAX_CORRELATED_FILE_ITEMS) {
      const oldest = this.correlatedFileItems.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.correlatedFileItems.delete(oldest)
    }
  }

  private correlatedFileItem(threadId: string, turnId: string, itemId: string): CorrelatedFileItem | undefined {
    const item = this.correlatedFileItems.get(correlatedFileItemKey(threadId, turnId, itemId))
    if (!item || item.connectionEpoch !== this.connectionEpoch || item.changes.length === 0) return undefined
    if (!this.notificationOwnsTurn(threadId, turnId)) return undefined
    return item
  }

  private forgetCorrelatedFileItems(threadId?: string, turnId?: string): void {
    if (threadId === undefined) {
      this.correlatedFileItems.clear()
      return
    }
    for (const [key, item] of this.correlatedFileItems) {
      if (item.threadId === threadId && (turnId === undefined || item.turnId === turnId)) {
        this.correlatedFileItems.delete(key)
      }
    }
  }

  private async invalidateCorrelatedFileApproval(
    connection: JsonlRpcConnection,
    item: CorrelatedFileItem,
    reason: "provider-cancelled" | "turn-ended",
    message: string,
  ): Promise<boolean> {
    if (!item.interactionId || item.rpcRequestId === undefined) return true
    const binding = this.bindingForCodexThread(item.threadId)
    if (!binding || binding.connection_epoch !== item.connectionEpoch || binding.state !== "active") return false
    const result = this.options.interactions.invalidateProviderRequest(
      { projectId: this.options.projectId, threadSlug: binding.thread_slug, sessionId: binding.fray_session_id },
      item.interactionId,
      reason,
    )
    if (result.effect === "cancelled") {
      try {
        await connection.errorResponse(item.rpcRequestId, -32602, message)
      } catch {
        connection.close()
        this.handleDisconnect(connection, "protocol")
        return false
      }
      return true
    }
    if (result.effect === "response-in-flight") {
      // The provider may already have observed the old decision. Killing the exact shared pipe is the
      // only available fail-closed action; every binding on that process is detached before resume.
      connection.close()
      this.handleDisconnect(connection, "protocol")
      return false
    }
    return true
  }

  private interactionRequest(
    row: BindingRow,
    providerRequestId: string,
    turnId: string,
    itemId: string,
    source: InteractionRequestType["source"],
    allowedDecisions: InteractionRequestType["allowedDecisions"],
    payload: InteractionRequestType["payload"],
    expiresAt: string | null = null,
  ): InteractionRequestType {
    const parsed = InteractionRequest.safeParse({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      contentFormat: "plain-text",
      provider: { kind: "codex", name: "Codex app-server", version: CODEX_APP_SERVER_SUPPORTED_VERSION },
      source,
      owner: {
        projectId: this.options.projectId,
        threadSlug: row.thread_slug,
        sessionId: row.fray_session_id,
        turnId,
        itemId,
        sessionEpoch: row.session_epoch,
        capabilityRevision: row.capability_revision,
      },
      providerRequestId,
      allowedDecisions,
      payload,
      expiresAt,
    })
    if (!parsed.success) throw new RpcProtocolError(-32602, "Codex request cannot be represented by the Fray interaction protocol")
    return parsed.data
  }

  private async handleServerRequest(
    connection: JsonlRpcConnection,
    method: string,
    id: RpcId,
    rawParams: unknown,
  ): Promise<void> {
    let request: InteractionRequestType
    let logicalId: string
    let providerContext: unknown | undefined
    let fileCorrelation: CorrelatedFileItem | undefined

    if (method === "item/commandExecution/requestApproval") {
      const parsed = CommandApprovalParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex command approval request")
      const params = parsed.data
      providerContext = { fingerprint: requestFingerprint(params) }
      const row = this.ownedBinding(params.threadId, params.turnId)
      const actions = commandActions(params.commandActions)
      const capabilities = commandCapabilities(params)
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId, params.approvalId ?? null])
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "tool", id: "codex-command-execution", label: "Codex command execution" },
        commandDecisions(params.availableDecisions),
        {
          kind: "command-approval",
          title: "Command approval",
          message: displayDescription(params.reason, "Codex requested permission to run a command."),
          command: {
            summary: "Run a command requested by Codex",
            preview: displayPreview(params.command, "Command text was not provided by Codex."),
            redacted: true,
            ...(params.cwd !== null && params.cwd !== undefined
              ? { workingDirectoryLabel: displayLabel(params.cwd, "Working directory unavailable") }
              : {}),
            ...(actions ? { actions } : {}),
          },
          ...(capabilities ? { capabilities } : {}),
        },
      )
    } else if (method === "item/fileChange/requestApproval") {
      const parsed = FileApprovalParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex file approval request")
      const params = parsed.data
      const row = this.ownedBinding(params.threadId, params.turnId)
      const correlated = this.correlatedFileItem(params.threadId, params.turnId, params.itemId)
      if (!correlated) {
        throw new RpcProtocolError(-32602, "Codex file approval has no active correlated file-change item")
      }
      fileCorrelation = correlated
      providerContext = {
        fingerprint: requestFingerprint(params),
        fileSnapshotFingerprint: correlated.snapshotFingerprint,
      }
      // The item id alone is not a stable authority identity: patchUpdated may replace its paths,
      // operations, or diff before Codex asks again. Bind dedupe/reconnect to the exact raw snapshot
      // fingerprint without persisting the raw (potentially secret-bearing) patch in provider context.
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId, correlated.snapshotFingerprint])
      const scope = { projectId: this.options.projectId, threadSlug: row.thread_slug, sessionId: row.fray_session_id }
      for (const stale of this.options.interactions.listPending(scope)) {
        if (
          stale.provider.kind !== "codex" ||
          stale.payload.kind !== "file-approval" ||
          stale.owner.turnId !== params.turnId ||
          stale.owner.itemId !== params.itemId ||
          stale.providerRequestId === logicalId
        ) continue
        const staleDelivery = this.options.interactions.providerDelivery(scope, stale.id)
        const invalidated = this.options.interactions.invalidateProviderRequest(scope, stale.id, "provider-cancelled")
        if (invalidated.effect === "response-in-flight" && staleDelivery?.connectionEpoch === this.connectionEpoch) {
          connection.close()
          this.handleDisconnect(connection, "protocol")
          throw new RpcProtocolError(-32603, "A previous file approval response raced a changed patch")
        }
      }
      const onlyChange = correlated.totalChanges === 1 ? correlated.changes[0] : undefined
      const grantRootLabel = params.grantRoot !== null && params.grantRoot !== undefined
        ? displayLabel(params.grantRoot, "Requested workspace root unavailable", 2_048, 4_096, "session write root")
        : undefined
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "tool", id: "codex-file-change", label: "Codex file change" },
        fileDecisions(),
        {
          kind: "file-approval",
          title: "File change approval",
          message: displayDescription(params.reason, "Codex requested permission to change workspace files."),
          operation: onlyChange?.operation ?? "write",
          pathLabel: onlyChange?.pathLabel ?? `${correlated.totalChanges} affected paths`,
          ...(onlyChange?.destinationLabel ? { destinationLabel: onlyChange.destinationLabel } : {}),
          ...(grantRootLabel ? {
            grantRootLabel,
            scopeLabel: "Approving for this session authorizes writes below this root for the remainder of the current Codex session.",
          } : {}),
          changes: correlated.changes,
        },
      )
    } else if (method === "item/permissions/requestApproval") {
      const parsed = PermissionsApprovalParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex permissions approval request")
      const params = parsed.data
      const row = this.ownedBinding(params.threadId, params.turnId)
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId])
      const permissionKinds = [params.permissions.network ? "network" : null, params.permissions.fileSystem ? "filesystem" : null]
        .filter(Boolean)
        .join("+") || "additional"
      const capabilities = permissionCapabilities(params.permissions)
      if (capabilities.length === 0) {
        throw new RpcProtocolError(-32602, "Codex permission approval contains no displayable requested capability")
      }
      providerContext = { fingerprint: requestFingerprint(params), permissions: params.permissions }
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "runtime", id: "codex-permissions", label: "Codex permissions" },
        permissionDecisions(),
        {
          kind: "permission-approval",
          title: "Additional permission request",
          message: displayDescription(params.reason, "Codex requested additional runtime permissions."),
          permission: permissionKinds,
          workingDirectoryLabel: displayLabel(params.cwd, "Working directory unavailable"),
          scopeLabel: "Approval can be granted for this turn or for the current Codex session.",
          capabilities,
        },
      )
    } else if (method === "item/tool/requestUserInput") {
      const parsed = UserInputParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex user-input request")
      const params = parsed.data
      if (params.questions.some((question) => question.isSecret)) {
        // The exact protocol can carry secret answers, but Fray's durable provider outbox cannot do
        // so without retaining plaintext. Keep this capability unavailable until transient encrypted
        // delivery exists; do not render an action that will inevitably fail. Turn interruption is a
        // separate `turn/interrupt` client request, never a fabricated user-input response.
        this.options.diagnostic?.({ event: "request-rejected", method, code: -32601 })
        throw new RpcProtocolError(-32601, "Secret Codex user input requires unavailable transient delivery")
      }
      providerContext = { fingerprint: requestFingerprint(params) }
      const row = this.ownedBinding(params.threadId, params.turnId)
      logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.itemId])
      request = this.interactionRequest(
        row,
        logicalId,
        params.turnId,
        params.itemId,
        { kind: "agent", id: "codex-request-user-input", label: "Codex" },
        questionDecisions(),
        {
          kind: "agent-question",
          title: params.questions.length === 1
            ? cleanText(params.questions[0]!.header, 160, "Codex question")
            : "Codex questions",
          fields: userInputFields(params.questions),
        },
        // Codex owns this relative timer and will emit serverRequest/resolved on auto-resolution.
        // Persisting a locally recomputed absolute deadline would make reconnect dedupe unstable.
        null,
      )
    } else if (method === "mcpServer/elicitation/request") {
      const parsed = McpElicitationParams.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex MCP elicitation request")
      const params = parsed.data
      providerContext = { fingerprint: requestFingerprint(params) }
      if (params.mode === "openai/form") {
        // The initialize capability explicitly disables this opaque, vendor-extended form contract.
        throw new RpcProtocolError(-32601, "OpenAI extended MCP forms are not supported by this Fray bridge")
      }
      const row = this.ownedBinding(params.threadId, params.turnId)
      const ownerTurnId = params.turnId ?? `mcp-unscoped-${params.threadId}`
      if (params.mode === "url") {
        logicalId = logicalRequestId(method, [params.threadId, params.turnId, params.serverName, params.elicitationId])
        request = this.interactionRequest(
          row,
          logicalId,
          ownerTurnId,
          `mcp-${logicalId.slice(-32)}`,
          { kind: "mcp-server", id: cleanText(params.serverName, 256, "mcp-server"), label: cleanText(params.serverName, 160, "MCP server") },
          elicitationDecisions(),
          {
            kind: "mcp-elicitation-url",
            title: cleanText(params.serverName, 160, "MCP authorization"),
            message: cleanText(params.message, 4_000, "The MCP server requested authorization."),
            protocolVersion: "2025-11-25",
            elicitationId: params.elicitationId,
            url: params.url,
          },
        )
      } else {
        // Standard MCP form requests currently lack a protocol-stable elicitation id. Include the
        // witnessed connection/request ids so repeated identical forms are never conflated. This is
        // intentionally not replayable across reconnect unless Codex provides a new request.
        logicalId = logicalRequestId(method, [
          params.threadId,
          params.turnId,
          params.serverName,
          String(this.connectionEpoch),
          `${typeof id}:${String(id)}`,
        ])
        request = this.interactionRequest(
          row,
          logicalId,
          ownerTurnId,
          `mcp-${logicalId.slice(-32)}`,
          { kind: "mcp-server", id: cleanText(params.serverName, 256, "mcp-server"), label: cleanText(params.serverName, 160, "MCP server") },
          elicitationDecisions(),
          {
            kind: "mcp-elicitation-form",
            title: cleanText(params.serverName, 160, "MCP form"),
            message: cleanText(params.message, 4_000, "The MCP server requested information."),
            protocolVersion: "2025-11-25",
            fields: mcpFields(params.requestedSchema),
          },
        )
      }
    } else {
      this.options.diagnostic?.({ event: "request-rejected", method: cleanText(method, 128, "unknown"), code: -32601 })
      throw new RpcProtocolError(-32601, "Unsupported Codex app-server request method")
    }

    const created = this.options.interactions.createProviderRequest(request, {
      provider: CODEX_APP_SERVER_PROVIDER,
      logicalRequestId: logicalId,
      method,
      connectionEpoch: this.connectionEpoch,
      rpcRequestId: id,
      providerContext,
    })
    if (fileCorrelation) {
      // Dispatch is serialized per connection, so the exact snapshot cannot be replaced between the
      // correlation check, durable create, and this attachment.
      fileCorrelation.interactionId = created.interaction.id
      fileCorrelation.rpcRequestId = id
    }
    await this.flushDelivery(created.delivery, connection)
  }

  private async handleNotification(connection: JsonlRpcConnection, method: string, rawParams: unknown): Promise<void> {
    if (method === "item/started") {
      const envelope = ItemStartedNotification.safeParse(rawParams)
      if (!envelope.success) return
      const item = FileChangeItem.safeParse(envelope.data.item)
      if (!item.success || item.data.status !== "inProgress") return
      const key = correlatedFileItemKey(envelope.data.threadId, envelope.data.turnId, item.data.id)
      const current = this.correlatedFileItems.get(key)
      const nextFingerprint = requestFingerprint(item.data.changes)
      if (current?.snapshotFingerprint === nextFingerprint) return
      if (current) {
        const active = await this.invalidateCorrelatedFileApproval(
          connection,
          current,
          "provider-cancelled",
          "Codex file approval was invalidated because its item snapshot changed",
        )
        this.correlatedFileItems.delete(key)
        if (!active) return
      }
      this.rememberFileItem(envelope.data.threadId, envelope.data.turnId, item.data.id, item.data.changes)
      return
    }
    if (method === "item/fileChange/patchUpdated") {
      const parsed = FileChangePatchUpdatedNotification.safeParse(rawParams)
      if (!parsed.success) return
      const key = correlatedFileItemKey(parsed.data.threadId, parsed.data.turnId, parsed.data.itemId)
      const current = this.correlatedFileItems.get(key)
      if (!current) return
      if (current.snapshotFingerprint === requestFingerprint(parsed.data.changes)) return
      const active = await this.invalidateCorrelatedFileApproval(
        connection,
        current,
        "provider-cancelled",
        "Codex file approval was invalidated because its patch changed",
      )
      this.correlatedFileItems.delete(key)
      if (!active) return
      this.rememberFileItem(parsed.data.threadId, parsed.data.turnId, parsed.data.itemId, parsed.data.changes)
      return
    }
    if (method === "item/completed") {
      const envelope = ItemCompletedNotification.safeParse(rawParams)
      if (!envelope.success) return
      const item = FileChangeItem.safeParse(envelope.data.item)
      if (!item.success) return
      const key = correlatedFileItemKey(envelope.data.threadId, envelope.data.turnId, item.data.id)
      const current = this.correlatedFileItems.get(key)
      if (current) {
        await this.invalidateCorrelatedFileApproval(
          connection,
          current,
          "provider-cancelled",
          "Codex file approval was invalidated because its file-change item completed",
        )
      }
      this.correlatedFileItems.delete(key)
      return
    }
    if (method === "serverRequest/resolved") {
      const parsed = ResolvedNotification.safeParse(rawParams)
      if (!parsed.success) throw new RpcProtocolError(-32602, "Invalid Codex request-resolved notification")
      const binding = this.bindingForCodexThread(parsed.data.threadId)
      if (!binding || binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") return
      const result = this.options.interactions.acknowledgeProviderResponse(
        CODEX_APP_SERVER_PROVIDER,
        this.connectionEpoch,
        parsed.data.requestId,
        { projectId: this.options.projectId, threadSlug: binding.thread_slug, sessionId: binding.fray_session_id },
      )
      if (result && (
        result.interaction.owner.threadSlug !== binding.thread_slug ||
        result.interaction.owner.sessionId !== binding.fray_session_id
      )) {
        throw new Error("Codex request acknowledgement crossed an owned session boundary")
      }
      return
    }
    if (method === "turn/started") {
      const parsed = TurnStarted.safeParse(rawParams)
      if (!parsed.success) return
      const binding = this.bindingForCodexThread(parsed.data.threadId)
      if (!binding || binding.connection_epoch !== this.connectionEpoch || binding.state !== "active") return
      if (binding.current_turn_id !== null) {
        // Duplicate notification for the witnessed turn is harmless. A different id must never
        // overwrite the authority already pinned to this Fray-owned session.
        return
      }
      if (!this.pendingTurnStarts.has(turnKey(binding))) return
      this.db.prepare(`
        UPDATE codex_app_server_session SET current_turn_id = ?, updated_at = ?
        WHERE codex_thread_id = ? AND connection_epoch = ? AND current_turn_id IS NULL
      `).run(parsed.data.turn.id, this.now().toISOString(), parsed.data.threadId, this.connectionEpoch)
      return
    }
    if (method === "turn/completed") {
      const parsed = TurnCompleted.safeParse(rawParams)
      if (!parsed.success) return
      for (const item of [...this.correlatedFileItems.values()]) {
        if (item.threadId !== parsed.data.threadId || item.turnId !== parsed.data.turn.id) continue
        const active = await this.invalidateCorrelatedFileApproval(
          connection,
          item,
          "turn-ended",
          "Codex file approval was invalidated because its turn completed",
        )
        if (!active) break
      }
      this.forgetCorrelatedFileItems(parsed.data.threadId, parsed.data.turn.id)
      this.db.prepare(`
        UPDATE codex_app_server_session SET current_turn_id = NULL, updated_at = ?
        WHERE codex_thread_id = ? AND connection_epoch = ? AND current_turn_id = ?
      `).run(this.now().toISOString(), parsed.data.threadId, this.connectionEpoch, parsed.data.turn.id)
    }
  }

  private providerResponse(
    record: InteractionRecord,
    delivery: ProviderDelivery,
    input: ResolveInteractionInput,
  ): JsonObject {
    if (delivery.method === "item/commandExecution/requestApproval" || delivery.method === "item/fileChange/requestApproval") {
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(input.decisionId)) {
        throw new InteractionStoreError("invalid-decision", "unsupported Codex approval decision")
      }
      return { decision: input.decisionId }
    }
    if (delivery.method === "item/permissions/requestApproval") {
      const context = z.object({ fingerprint: z.string().length(64), permissions: RequestedPermissions }).strict().safeParse(delivery.providerContext)
      if (!context.success) throw new InteractionStoreError("corrupt-journal", "Codex permission delivery lost its requested profile")
      const permissions = input.decisionId === "grant-turn" || input.decisionId === "grant-session"
        ? {
            ...(context.data.permissions.network === null ? {} : { network: context.data.permissions.network }),
            ...(context.data.permissions.fileSystem === null ? {} : { fileSystem: context.data.permissions.fileSystem }),
          }
        : {}
      if (!["grant-turn", "grant-session", "deny"].includes(input.decisionId)) {
        throw new InteractionStoreError("invalid-decision", "unsupported Codex permission decision")
      }
      return { permissions, scope: input.decisionId === "grant-session" ? "session" : "turn" }
    }
    if (delivery.method === "mcpServer/elicitation/request") {
      if (!["accept", "decline", "cancel"].includes(input.decisionId)) {
        throw new InteractionStoreError("invalid-decision", "unsupported MCP elicitation decision")
      }
      return {
        action: input.decisionId,
        content: input.decisionId === "accept" && record.payload.kind === "mcp-elicitation-form"
          ? input.values ?? {}
          : null,
        _meta: null,
      }
    }
    if (delivery.method === "item/tool/requestUserInput") {
      if (input.decisionId !== "answer") {
        throw new InteractionStoreError("invalid-decision", "unsupported Codex user-input decision")
      }
      const answers: Record<string, { answers: string[] }> = {}
      for (const [id, value] of Object.entries(input.values ?? {})) {
        if (typeof value === "string") answers[id] = { answers: [value] }
        else if (Array.isArray(value)) answers[id] = { answers: value }
        else throw new InteractionStoreError("invalid-response", "Codex user-input answers must be text")
      }
      return { answers }
    }
    throw new InteractionStoreError("invalid-response", "interaction is not owned by a supported Codex request method")
  }

  private async flushDelivery(delivery: ProviderDelivery, explicitConnection?: JsonlRpcConnection): Promise<void> {
    if (delivery.state !== "queued" || delivery.connectionEpoch !== this.connectionEpoch) return
    const connection = explicitConnection ?? this.connection
    if (!connection || connection !== this.connection) return
    let claimed: ProviderDelivery
    try {
      // Claim before writing. A crash after this point leaves SENT/unknown and is never blindly
      // replayed; only a newly witnessed provider request can rebind it to QUEUED.
      claimed = this.options.interactions.claimProviderResponseForSend(
        delivery.interactionId,
        delivery.connectionEpoch,
        delivery.rpcRequestId,
      )
    } catch (error) {
      if (error instanceof InteractionStoreError && (error.code === "not-pending" || error.code === "stale-revision")) return
      throw error
    }
    try {
      await connection.response(claimed.rpcRequestId, claimed.providerResponse)
    } catch (error) {
      connection.close()
      this.handleDisconnect(connection, "error")
      throw error
    }
  }
}

export function createCodexAppServerBridge(options: CodexAppServerBridgeOptions): CodexAppServerBridge {
  return new CodexAppServerBridge(options)
}

export function codexAppServerBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CODEX_APP_SERVER_FEATURE_FLAG] === "1"
}
