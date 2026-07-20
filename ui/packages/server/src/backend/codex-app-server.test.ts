import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { createInteractionStore, InteractionStoreError } from "../interaction-store.ts"
import { createStorage, type SessionRow } from "../storage.ts"
import {
  CODEX_APP_SERVER_ENV_KEYS,
  CODEX_APP_SERVER_PROTOCOL_REVISION,
  CODEX_APP_SERVER_SUPPORTED_VERSION,
  CodexAppServerBridge,
  codexAppServerEnvironment,
  codexAppServerBridgeEnabled,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
} from "./codex-app-server.ts"

type Message = Record<string, unknown>

class FakeAppServerProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly inbound: Message[] = []
  readonly clientRequests: Message[] = []
  readonly clientResponses: Message[] = []
  private buffer = ""
  private nextThread = 0
  private nextTurn = 0
  killed = false
  readonly version: string
  afterInitializeResponse?: () => void
  afterThreadStartResponse?: () => void

  constructor(version = CODEX_APP_SERVER_SUPPORTED_VERSION) {
    super()
    this.version = version
    this.stdin.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")))
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    queueMicrotask(() => this.emit("exit", 0, "SIGTERM"))
    return true
  }

  disconnect(): void {
    if (this.killed) return
    this.killed = true
    this.emit("exit", 1, null)
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(value: string | Buffer): void {
    this.stdout.write(value)
  }

  sendBatch(messages: Message[]): void {
    this.sendRaw(messages.map((message) => JSON.stringify(message)).join("\n") + "\n")
  }

  request(id: string | number, method: string, params: unknown): void {
    this.send({ id, method, params })
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as Message
      this.inbound.push(message)
      if (typeof message.method === "string" && typeof message.id === "number") {
        this.clientRequests.push(message)
        this.answerClientRequest(message)
      } else if ("id" in message && ("result" in message || "error" in message)) {
        this.clientResponses.push(message)
      }
    }
  }

  private answerClientRequest(message: Message): void {
    const id = message.id as number
    if (message.method === "initialize") {
      this.send({
        id,
        result: {
          userAgent: `fray/${this.version} (test; bridge)`,
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      })
      this.afterInitializeResponse?.()
      return
    }
    if (message.method === "thread/start") {
      const params = message.params as { ephemeral?: boolean }
      const suffix = ++this.nextThread
      this.send({
        id,
        result: {
          thread: {
            id: `codex-thread-${suffix}`,
            sessionId: `codex-session-${suffix}`,
            ephemeral: params.ephemeral ?? false,
          },
          model: "gpt-5",
        },
      })
      this.afterThreadStartResponse?.()
      return
    }
    if (message.method === "thread/resume") {
      const params = message.params as { threadId: string }
      this.send({
        id,
        result: {
          thread: { id: params.threadId, sessionId: `resumed-${params.threadId}`, ephemeral: false },
          model: "gpt-5",
        },
      })
      return
    }
    if (message.method === "turn/start") {
      const params = message.params as { threadId: string }
      const turnId = `codex-turn-${++this.nextTurn}`
      this.notify("turn/started", { threadId: params.threadId, turn: { id: turnId } })
      this.send({ id, result: { turn: { id: turnId } } })
      return
    }
    this.send({ id, error: { code: -32601, message: "not implemented by fake" } })
  }
}

async function waitFor(predicate: () => boolean, message = "condition", attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
  assert.fail(`timed out waiting for ${message}`)
}

function harness(
  version = CODEX_APP_SERVER_SUPPORTED_VERSION,
  setupProcess?: (process: FakeAppServerProcess) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "fray-codex-app-server-"))
  const dbPath = join(dir, "ui.db")
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  const now = new Date("2026-07-13T12:00:00.000Z")
  let interactionId = 0
  let clientId = 0
  const diagnostics: unknown[] = []
  const interactions = createInteractionStore(db, {
    now: () => now,
    id: () => `interaction-${++interactionId}`,
  })
  const processes: FakeAppServerProcess[] = []
  const calls: Array<{ binary: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
  const spawn: CodexAppServerSpawn = (binary, args, options) => {
    const process = new FakeAppServerProcess(version)
    setupProcess?.(process)
    processes.push(process)
    calls.push({ binary, args, cwd: options.cwd, env: options.env })
    return process
  }
  const bridges: CodexAppServerBridge[] = []
  const newBridge = () => {
    const bridge = new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      dbPath,
      interactions,
      codexBin: "/opt/codex",
      spawn,
      now: () => now,
      id: () => `client-message-${++clientId}`,
      requestTimeoutMs: 1_000,
      diagnostic: (event) => diagnostics.push(event),
    })
    bridges.push(bridge)
    return bridge
  }
  const bridge = newBridge()
  return {
    dir,
    db,
    interactions,
    bridge,
    processes,
    calls,
    diagnostics,
    newBridge,
    close() {
      for (const activeBridge of bridges.reverse()) activeBridge.close()
      interactions.dispose()
      db.close()
    },
  }
}

function commandParams(threadId: string, turnId: string, over: Record<string, unknown> = {}) {
  return {
    threadId,
    turnId,
    itemId: "item-command-1",
    startedAtMs: Date.parse("2026-07-13T12:00:00.000Z"),
    environmentId: null,
    approvalId: null,
    reason: "Tests need to run",
    command: "pnpm test --token secret-that-must-not-be-journaled",
    cwd: "/tmp/project",
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    ...over,
  }
}

function sessionRow(slug: string, sessionId: string, backend = "claude"): SessionRow {
  return {
    slug,
    session_id: sessionId,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-13T12:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: null,
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    backend,
  }
}

test("bridge is disabled by default and negotiates exact installed protocol over stdio when explicitly used", async () => {
  assert.equal(codexAppServerBridgeEnabled({}), false)
  assert.equal(codexAppServerBridgeEnabled({ FRAY_CODEX_APP_SERVER_BRIDGE: "1" }), true)
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "bridge-thread",
    sessionId: "fray-session-1",
    cwd: h.dir,
  })
  assert.equal(binding.ephemeral, true)
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0]!.args, ["app-server", "--stdio"])
  assert.equal(h.calls[0]!.binary, "/opt/codex")
  assert.deepEqual(CODEX_APP_SERVER_PROTOCOL_REVISION, {
    packageVersion: "0.144.1",
    sourceTag: "rust-v0.144.1",
    sourceCommit: "44918ea10c0f99151c6710411b4322c2f5c96bea",
  })
  assert.notEqual(h.calls[0]!.env, process.env, "the child receives a point-in-time environment snapshot")
  for (const key of ["HOME", "PATH", "CODEX_HOME", "OPENAI_API_KEY"] as const) {
    assert.equal(h.calls[0]!.env[key], process.env[key], `${key} is preserved for first-party Codex auth/config`)
  }
  const initialize = h.processes[0]!.clientRequests.find((message) => message.method === "initialize")!
  assert.deepEqual((initialize.params as Message).capabilities, {
    experimentalApi: true,
    requestAttestation: false,
    mcpServerOpenaiFormElicitation: false,
  })
  assert.ok(h.processes[0]!.inbound.some((message) => message.method === "initialized"))
  assert.equal(h.processes[0]!.inbound.some((message) => "jsonrpc" in message), false)
  h.close()
})

test("child environment is an exact safe allowlist and drops unrelated host secrets", () => {
  const source: NodeJS.ProcessEnv = {
    HOME: "/Users/tester",
    PATH: "/opt/codex/bin:/usr/bin",
    LANG: "en_US.UTF-8",
    CODEX_HOME: "/Users/tester/.codex",
    OPENAI_API_KEY: "openai-secret",
    CODEX_ACCESS_TOKEN: "codex-secret",
    OPENAI_ORGANIZATION: "org-test",
    HTTPS_PROXY: "http://proxy-secret@example.test",
    FRAY_GITHUB_WEBHOOK_SECRET: "fray-secret",
    GH_TOKEN: "github-secret",
    GITHUB_TOKEN: "github-secret-two",
    ANTHROPIC_API_KEY: "anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NODE_OPTIONS: "--require=/tmp/injected.js",
    OPENAI_UNAUDITED_SECRET: "unknown-openai-secret",
    CODEX_UNAUDITED_SECRET: "unknown-codex-secret",
  }
  const environment = codexAppServerEnvironment(source)
  assert.notEqual(environment, source)
  assert.deepEqual(environment, {
    HOME: source.HOME,
    CODEX_HOME: source.CODEX_HOME,
    PATH: source.PATH,
    LANG: source.LANG,
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    CODEX_ACCESS_TOKEN: source.CODEX_ACCESS_TOKEN,
    OPENAI_ORGANIZATION: source.OPENAI_ORGANIZATION,
    HTTPS_PROXY: source.HTTPS_PROXY,
  })
  assert.deepEqual(Object.keys(environment).every((key) => CODEX_APP_SERVER_ENV_KEYS.includes(key as never)), true)
  const serialized = JSON.stringify(environment)
  for (const secret of ["fray-secret", "github-secret", "github-secret-two", "anthropic-secret", "aws-secret", "unknown-openai-secret", "unknown-codex-secret"]) {
    assert.equal(serialized.includes(secret), false)
  }
})

test("command response is written once and the journal resolves only after serverRequest/resolved", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "bridge-thread",
    sessionId: "fray-session-1",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Run the tests",
  })
  const process = h.processes[0]!
  process.request("approval-1", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "command interaction")
  const pending = h.interactions.listPending(scope)[0]!
  assert.equal(pending.payload.kind, "command-approval")
  assert.equal(JSON.stringify(pending).includes("secret-that-must-not-be-journaled"), false)
  const queued = await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
    responseId: "human-response-1",
    decisionId: "accept",
  })
  assert.equal(queued?.effect, "queued")
  await waitFor(() => process.clientResponses.some((message) => message.id === "approval-1"), "provider response")
  assert.deepEqual(process.clientResponses.filter((message) => message.id === "approval-1"), [
    { id: "approval-1", result: { decision: "accept" } },
  ])
  const duplicate = await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: pending.recordRevision,
    responseId: "human-response-1",
    decisionId: "accept",
  })
  assert.equal(duplicate?.effect, "already-sent")
  assert.equal(process.clientResponses.filter((message) => message.id === "approval-1").length, 1)
  assert.equal(h.interactions.get(scope, pending.id)?.lifecycle, "pending", "pipe acceptance is not provider acknowledgement")
  process.notify("serverRequest/resolved", { threadId: binding.codexThreadId, requestId: "approval-1" })
  await waitFor(() => h.interactions.get(scope, pending.id)?.lifecycle === "resolved", "provider acknowledgement")
  process.notify("serverRequest/resolved", { threadId: binding.codexThreadId, requestId: "approval-1" })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(process.clientResponses.filter((message) => message.id === "approval-1").length, 1)
  h.close()
})

test("command approval display preserves complete structural risk while redacting hostile exact protocol fields", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "display-command",
    sessionId: "display-command-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Show informed consent",
  })
  const process = h.processes[0]!
  const secrets = {
    api: "sk-proj-abcdefghijklmnopqrstuv",
    bearer: "bearerCredential1234567890",
    password: "command-password-123",
    urlPassword: "url-password-123",
    jwt: "abcdefgh.ijklmnop.qrstuvw-",
    pathToken: "path-token-secret-123",
    apiHeader: "header-api-key-secret-123",
    embedded: "embedded-credential-secret-123",
    curlUser: "fixture-curl-user-credential",
    equalsToken: "fixture-equals-token-credential",
    encodedUrl: "%66%69%78%74%75%72%65-url-credential",
  }
  const command = [
    `OPENAI_API_KEY=${secrets.api} rm -rf / --password ${secrets.password}`,
    `curl -H "Authorization: Bearer ${secrets.bearer}" https://alice:${secrets.urlPassword}@packages.example.test/private`,
    `curl -u alice:${secrets.curlUser} --token=${secrets.equalsToken} https://bob:${secrets.encodedUrl}@packages.example.test/encoded`,
    `curl -H "X-Api-Key: ${secrets.apiHeader}" https://packages.example.test && chmod -R 777 /`,
    `danger --password "${secrets.embedded}\$(rm -rf /credential-shadow)" && echo structure-visible`,
    `printf '%s' ${secrets.jwt} && echo '<script>alert(1)</script>' && git push --force`,
    ...Array.from({ length: 100 }, (_, index) => `echo line-${index}`),
  ].join("\n")
  process.request("hostile-command", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "hostile-command-item",
    reason: `Need a privileged operation; token=${secrets.pathToken}; callback=https://bob%3A${secrets.encodedUrl}@packages.example.test; **provider markdown** <img src=x onerror=alert(1)>`,
    command,
    cwd: `/tmp/<script>/workspace\u202E\u061C\u{E0001}\uD800/token=${secrets.pathToken}`,
    commandActions: [
      { type: "read", command: `cat --token ${secrets.pathToken} /etc/passwd`, name: "passwd", path: "/etc/passwd" },
      { type: "search", command: "rg --hidden credential", query: "credential", path: "/" },
      { type: "listFiles", command: "find / -maxdepth 2", path: null },
      { type: "unknown", command: "rm -rf /" },
    ],
    networkApprovalContext: { host: "packages.example.test", protocol: "https" },
    additionalPermissions: {
      network: { enabled: true },
      fileSystem: {
        read: ["/etc/passwd"],
        write: [`/tmp/token=${secrets.pathToken}/output`],
        globScanMaxDepth: 0,
        entries: [
          { access: "deny", path: { type: "special", value: { kind: "root" } } },
          { access: "read", path: { type: "glob_pattern", pattern: "/var/**/<script>" } },
        ],
      },
    },
    proposedExecpolicyAmendment: ["git", "push", "--force"],
    proposedNetworkPolicyAmendments: [
      { host: "packages.example.test", action: "allow" },
      { host: "metadata.internal", action: "deny" },
    ],
  }))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "hostile command display")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "command-approval")
  if (record.payload.kind !== "command-approval") assert.fail("expected command approval")
  const serialized = JSON.stringify(record)
  for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false, `redacts ${secret}`)
  assert.match(record.payload.command.preview, /rm -rf \/.*--password \[REDACTED\]/)
  assert.match(record.payload.command.preview, /curl -u alice:\[REDACTED\] --token=\[REDACTED\]/)
  assert.match(record.payload.command.preview, /https:\/\/\[REDACTED\]@packages\.example\.test\/encoded/)
  assert.match(record.payload.command.preview, /git push --force/)
  assert.match(record.payload.command.preview, /chmod -R 777 \//)
  assert.match(record.payload.command.preview, /embedded executable shell syntax: \$\(rm -rf \/credential-shadow\)/)
  assert.match(record.payload.command.preview, /<script>alert\(1\)<\/script>/)
  assert.match(record.payload.command.preview, /echo line-99/)
  assert.doesNotMatch(record.payload.command.preview, /truncated|omitted/)
  assert.match(record.payload.command.workingDirectoryLabel ?? "", /\[U\+202E\].*\[U\+061C\].*\[U\+E0001\].*\[U\+D800\]/)
  assert.deepEqual(record.payload.command.actions?.map((action) => action.kind), ["read", "search", "list-files", "unknown"])
  assert.match(record.payload.command.actions?.[3]?.commandPreview ?? "", /rm -rf \//)
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "network" && capability.hosts.includes("https: packages.example.test")))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "deny"))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "glob-scan" && capability.depth === 0))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "exec-policy" && capability.prefixes.includes("--force")))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "network-policy" && capability.access === "deny" && capability.hosts.includes("metadata.internal")))
  assert.match(record.payload.message ?? "", /\*\*provider markdown\*\* <img src=x onerror=alert\(1\)>/)
  h.close()
})

test("approval mapping rejects unseen authority instead of truncating commands, actions, policies, resources, or file changes", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "complete-authority",
    sessionId: "complete-authority-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Reject partial consent",
  })
  const process = h.processes[0]!
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  const rejects = async (id: string, method: string, params: unknown) => {
    process.request(id, method, params)
    await waitFor(() => process.clientResponses.some((message) => message.id === id && "error" in message), `${id} rejection`)
    assert.equal(h.interactions.listPending(scope).length, 0)
  }

  await rejects("oversized-command", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "oversized-command-item",
    command: "😀".repeat(8_000),
  }))
  await rejects("too-many-actions", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "too-many-actions-item",
    commandActions: Array.from({ length: 17 }, (_, index) => ({ type: "unknown" as const, command: `echo ${index}` })),
  }))
  await rejects("too-many-policy-prefixes", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    itemId: "too-many-policy-prefixes-item",
    proposedExecpolicyAmendment: Array.from({ length: 33 }, (_, index) => `prefix-${index}`),
  }))
  await rejects("too-many-filesystem-resources", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "too-many-filesystem-resources-item",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: h.dir,
    reason: "Request many paths",
    permissions: {
      network: null,
      fileSystem: {
        read: Array.from({ length: 33 }, (_, index) => `/tmp/read-${index}`),
        write: [],
        entries: [],
      },
    },
  })

  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "too-many-file-changes-item",
      status: "inProgress",
      changes: Array.from({ length: 17 }, (_, index) => ({
        path: `/tmp/file-${index}`,
        kind: { type: "add" as const },
        diff: `+${index}`,
      })),
    },
  })
  await rejects("too-many-file-changes", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "too-many-file-changes-item",
    startedAtMs: Date.now(),
    reason: "Apply all changes",
    grantRoot: null,
  })
  h.close()
})

test("file approval requires exact snapshots and invalidates stale cards across patch, completion, turn, disconnect, and restart", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "file-correlation",
    sessionId: "file-correlation-session",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Prepare a patch",
  })
  const process = h.processes[0]!
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  const approval = (id: string, itemId = "file-item") => process.request(id, "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId,
    startedAtMs: Date.now(),
    reason: "Apply the exact patch",
    grantRoot: h.dir,
  })

  approval("request-before-item")
  await waitFor(() => process.clientResponses.some((message) => message.id === "request-before-item" && "error" in message), "request-before-item rejection")
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "different-item",
      status: "inProgress",
      changes: [{ path: "/tmp/different", kind: { type: "add" }, diff: "+different" }],
    },
  })
  approval("wrong-item-correlation")
  await waitFor(() => process.clientResponses.some((message) => message.id === "wrong-item-correlation" && "error" in message), "wrong item rejection")
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId: "different-turn",
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "inProgress",
      changes: [{ path: "/tmp/different-turn", kind: { type: "add" }, diff: "+different turn" }],
    },
  })
  approval("wrong-turn-correlation")
  await waitFor(() => process.clientResponses.some((message) => message.id === "wrong-turn-correlation" && "error" in message), "wrong turn rejection")
  process.notify("item/fileChange/patchUpdated", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "file-item",
    changes: [{ path: "/tmp/uncorrelated", kind: { type: "add" }, diff: "+must not appear" }],
  })
  approval("patch-before-item")
  await waitFor(() => process.clientResponses.some((message) => message.id === "patch-before-item" && "error" in message), "patch-before-item rejection")

  const diffSecret = "file-diff-token-secret"
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "inProgress",
      changes: [{ path: "/tmp/original", kind: { type: "update", move_path: null }, diff: "+original" }],
    },
  })
  process.notify("item/fileChange/patchUpdated", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "file-item",
    changes: [
      {
        path: "/tmp/<script>/source\u202E.txt",
        kind: { type: "update", move_path: `/tmp/token=${diffSecret}/destination.txt` },
        diff: [`+API_TOKEN=${diffSecret}`, "+rm -rf /", ...Array.from({ length: 120 }, (_, index) => `+line ${index}`)].join("\n"),
      },
      ...Array.from({ length: 2 }, (_, index) => ({
        path: `/tmp/generated-${index}.txt`,
        kind: { type: index % 2 === 0 ? "add" as const : "delete" as const },
        diff: index % 2 === 0 ? "+created" : "-deleted",
      })),
    ],
  })
  approval("correlated-file")
  await waitFor(() => h.interactions.listPending(scope).length === 1, "correlated file interaction")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "file-approval")
  if (record.payload.kind !== "file-approval") assert.fail("expected file approval")
  assert.equal(record.payload.changes?.length, 3)
  assert.equal(record.payload.pathLabel, "3 affected paths")
  assert.equal(record.payload.grantRootLabel, h.dir)
  assert.match(record.payload.scopeLabel ?? "", /writes below this root.*current Codex session/)
  assert.equal(JSON.stringify(record).includes(diffSecret), false)
  assert.match(record.payload.changes?.[0]?.pathLabel ?? "", /<script>.*\[U\+202E\]/)
  assert.match(record.payload.changes?.[0]?.diffPreview ?? "", /rm -rf \//)
  assert.match(record.payload.changes?.[0]?.diffPreview ?? "", /\+line 119/)
  assert.doesNotMatch(record.payload.changes?.[0]?.diffPreview ?? "", /truncated|omitted/)

  process.notify("item/fileChange/patchUpdated", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "file-item",
    changes: [{ path: "/tmp/revised", kind: { type: "delete" }, diff: "-revised" }],
  })
  await waitFor(() => h.interactions.get(scope, record.id)?.lifecycle === "cancelled", "old patch cancellation")
  assert.equal(h.interactions.get(scope, record.id)?.cancellationReason, "provider-cancelled")
  await waitFor(() => process.clientResponses.some((message) => message.id === "correlated-file" && "error" in message), "old approval invalidation response")
  assert.equal(h.interactions.listPending(scope).length, 0)
  approval("revised-file")
  await waitFor(() => h.interactions.listPending(scope).length === 1, "revised file interaction")
  const revised = h.interactions.listPending(scope)[0]!
  assert.equal(revised.payload.kind, "file-approval")
  if (revised.payload.kind !== "file-approval") assert.fail("expected revised file approval")
  assert.equal(revised.payload.pathLabel, "/tmp/revised")
  assert.equal(revised.payload.operation, "delete")
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "inProgress",
      changes: [{ path: "/tmp/revised", kind: { type: "delete" }, diff: "-revised" }],
    },
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.get(scope, revised.id)?.lifecycle, "pending", "identical item replay preserves exact approval")
  assert.equal(process.clientResponses.some((message) => message.id === "revised-file"), false)

  process.notify("item/completed", {
    threadId: binding.codexThreadId,
    turnId,
    completedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "file-item",
      status: "completed",
      changes: [{ path: "/tmp/final", kind: { type: "add" }, diff: "+final" }],
    },
  })
  await waitFor(() => h.interactions.get(scope, revised.id)?.lifecycle === "cancelled", "completed item cancellation")
  await waitFor(() => process.clientResponses.some((message) => message.id === "revised-file" && "error" in message), "completed item invalidation response")
  approval("completed-item")
  await waitFor(() => process.clientResponses.some((message) => message.id === "completed-item" && "error" in message), "completed item rejection")

  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "restart-item",
      status: "inProgress",
      changes: [{ path: "/tmp/restart", kind: { type: "add" }, diff: "+restart" }],
    },
  })
  approval("restart-original", "restart-item")
  await waitFor(() => h.interactions.listPending(scope).some((item) => item.owner.itemId === "restart-item"), "pre-restart file interaction")
  const preRestart = h.interactions.listPending(scope).find((item) => item.owner.itemId === "restart-item")!
  h.bridge.close()
  const restarted = h.newBridge()
  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  const second = h.processes[1]!
  second.request("restart-without-replay", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "restart-item",
    startedAtMs: Date.now(),
    reason: "Fresh correlation required",
    grantRoot: null,
  })
  await waitFor(() => second.clientResponses.some((message) => message.id === "restart-without-replay" && "error" in message), "restart cache rejection")
  assert.equal(h.interactions.providerDelivery(scope, preRestart.id)?.state, "awaiting-user")
  assert.notEqual(h.interactions.providerDelivery(scope, preRestart.id)?.connectionEpoch, restarted.binding(binding.threadSlug, binding.sessionId)?.connectionEpoch)
  second.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "restart-item",
      status: "inProgress",
      changes: [{ path: "/tmp/replayed", kind: { type: "add" }, diff: "+replayed" }],
    },
  })
  second.request("restart-after-replay", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "restart-item",
    startedAtMs: Date.now(),
    reason: "Fresh correlation witnessed",
    grantRoot: null,
  })
  await waitFor(() => h.interactions.listPending(scope).some((item) => item.owner.itemId === "restart-item"), "restart replay interaction")
  await waitFor(() => h.interactions.get(scope, preRestart.id)?.lifecycle === "cancelled", "superseded restart snapshot cancellation")
  const postRestart = h.interactions.listPending(scope).find((item) => item.owner.itemId === "restart-item")!
  assert.notEqual(postRestart.id, preRestart.id)
  assert.equal(postRestart.payload.kind, "file-approval")
  if (postRestart.payload.kind !== "file-approval") assert.fail("expected post-restart file approval")
  assert.equal(postRestart.payload.pathLabel, "/tmp/replayed")

  second.notify("turn/completed", { threadId: binding.codexThreadId, turn: { id: turnId, status: "completed" } })
  await waitFor(() => h.interactions.get(scope, postRestart.id)?.lifecycle === "cancelled", "turn completion cancellation")
  assert.equal(h.interactions.get(scope, postRestart.id)?.cancellationReason, "turn-ended")
  await waitFor(() => second.clientResponses.some((message) => message.id === "restart-after-replay" && "error" in message), "turn completion invalidation response")
  h.close()
})

test("permissions approval displays exact filesystem and network capabilities without leaking secret path text", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "permission-display",
    sessionId: "permission-display-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Request capability" })
  const process = h.processes[0]!
  const pathSecret = "permission-path-secret"
  const requestedPermissions = {
    network: { enabled: true },
    fileSystem: {
      read: ["/etc/hosts"],
      write: [`${h.dir}/token=${pathSecret}/output`],
      globScanMaxDepth: 7,
      entries: [
        { access: "read" as const, path: { type: "special" as const, value: { kind: "project_roots" as const, subpath: "src/<script>" } } },
        { access: "write" as const, path: { type: "glob_pattern" as const, pattern: `${h.dir}/**/*.ts` } },
        { access: "deny" as const, path: { type: "special" as const, value: { kind: "root" as const } } },
        { access: "read" as const, path: { type: "special" as const, value: { kind: "unknown" as const, path: "/provider/root", subpath: "nested" } } },
      ],
    },
  }
  process.request("permission-display-request", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "permission-display-item",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: `${h.dir}/token=${pathSecret}`,
    reason: `Need exact roots, password=${pathSecret}`,
    permissions: requestedPermissions,
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "permission display")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "permission-approval")
  if (record.payload.kind !== "permission-approval") assert.fail("expected permission approval")
  assert.equal(JSON.stringify(record).includes(pathSecret), false)
  assert.equal(record.payload.permission, "network+filesystem")
  assert.match(record.payload.scopeLabel ?? "", /turn.*session/)
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "network" && capability.enabled === true))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "read" && capability.resources.some((path) => path.includes("/etc/hosts"))))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "write" && capability.resources.some((path) => path.includes("Glob pattern:"))))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "filesystem" && capability.access === "deny" && capability.resources.some((path) => path.includes("Filesystem root"))))
  assert.ok(record.payload.capabilities?.some((capability) => capability.kind === "glob-scan" && capability.depth === 7))
  assert.match(JSON.stringify(record.payload.capabilities), /src\/<script>/)
  await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: record.id,
    sessionEpoch: record.owner.sessionEpoch,
    capabilityRevision: record.owner.capabilityRevision,
    expectedRecordRevision: record.recordRevision,
    responseId: "permission-display-response",
    decisionId: "grant-turn",
  })
  await waitFor(() => process.clientResponses.some((message) => message.id === "permission-display-request"), "permission provider response")
  assert.deepEqual(process.clientResponses.find((message) => message.id === "permission-display-request"), {
    id: "permission-display-request",
    result: { permissions: requestedPermissions, scope: "turn" },
  })
  h.close()
})

test("duplicate provider requests deduplicate exactly while conflicting reuse fails closed", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "duplicate-thread", sessionId: "duplicate-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Check duplicates" })
  const process = h.processes[0]!
  const params = commandParams(binding.codexThreadId, turnId)
  process.request("duplicate-1", "item/commandExecution/requestApproval", params)
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  process.request("duplicate-1", "item/commandExecution/requestApproval", params)
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.listPending(scope).length, 1)

  process.request("duplicate-conflict", "item/commandExecution/requestApproval", {
    ...params,
    reason: "A materially different request reusing the same authority ids",
  })
  await waitFor(
    () => process.clientResponses.some((message) => message.id === "duplicate-conflict" && "error" in message),
    "conflicting provider request rejection",
  )
  assert.equal(h.interactions.listPending(scope).length, 1)
  h.close()
})

test("provider fingerprints and durable context ignore JSON object insertion order", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "ordered-thread", sessionId: "ordered-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Normalize requests" })
  const process = h.processes[0]!
  const base = commandParams(binding.codexThreadId, turnId, {
    additionalPermissions: { fileSystem: null, network: { enabled: true } },
  })
  process.request("ordered-request", "item/commandExecution/requestApproval", base)
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  process.request("ordered-request", "item/commandExecution/requestApproval", {
    ...base,
    additionalPermissions: { network: { enabled: true }, fileSystem: null },
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.listPending(scope).length, 1)
  assert.equal(process.clientResponses.some((message) => message.id === "ordered-request" && "error" in message), false)
  h.close()
})

test("only locally witnessed turn ids may own provider requests and notifications cannot replace them", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "turn-owner", sessionId: "turn-owner-session", cwd: h.dir })
  const process = h.processes[0]!
  process.request("unsolicited", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, "foreign-turn", {
    itemId: "unsolicited-item",
  }))
  await waitFor(() => process.clientResponses.some((message) => message.id === "unsolicited" && "error" in message), "unsolicited turn rejection")
  assert.equal(h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId, null)

  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Own one turn" })
  process.notify("turn/started", { threadId: binding.codexThreadId, turn: { id: "replacement-turn" } })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.bridge.binding(binding.threadSlug, binding.sessionId)?.currentTurnId, turnId)
  process.request("owned", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, { itemId: "owned-item" }))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "owned turn request")
  h.close()
})

test("unsupported structured command decisions fail closed instead of silently broadening approval", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "structured-decision", sessionId: "structured-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Ask for approval" })
  const process = h.processes[0]!
  process.request("structured-request", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
    availableDecisions: [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: [{ program: "git" }] } },
      "decline",
    ],
  }))
  await waitFor(() => process.clientResponses.some((message) => message.id === "structured-request" && "error" in message), "structured decision rejection")
  assert.equal(h.interactions.listPending({
    projectId: "project-1",
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
  }).length, 0)
  h.close()
})

test("missing command decisions fail closed instead of inventing a legacy approval menu", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "missing-decisions", sessionId: "missing-decisions-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Ask for approval" })
  const process = h.processes[0]!
  for (const [requestId, availableDecisions] of [["omitted-decisions", undefined], ["null-decisions", null]] as const) {
    process.request(requestId, "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId, {
      availableDecisions,
      itemId: `${requestId}-item`,
    }))
  }
  await waitFor(
    () => process.clientResponses.filter((message) => "error" in message).length === 2,
    "missing decision rejection",
  )
  assert.equal(h.interactions.listPending({
    projectId: "project-1",
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
  }).length, 0)
  h.close()
})

test("generated MCP titled multi-select shapes map exactly and enforce item bounds", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "mcp-anyof", sessionId: "mcp-anyof-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Map MCP schema" })
  h.processes[0]!.request("mcp-anyof-request", "mcpServer/elicitation/request", {
    threadId: binding.codexThreadId,
    turnId,
    serverName: "tickets",
    mode: "form",
    _meta: null,
    message: "Choose labels",
    requestedSchema: {
      type: "object",
      properties: {
        labels: {
          type: "array",
          title: "Labels",
          minItems: 1,
          maxItems: 2,
          items: { anyOf: [{ const: "bug", title: "Bug" }, { const: "urgent", title: "Urgent" }] },
          default: ["bug"],
        },
      },
      required: ["labels"],
    },
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "MCP titled multi-select")
  const record = h.interactions.listPending(scope)[0]!
  assert.equal(record.payload.kind, "mcp-elicitation-form")
  if (record.payload.kind !== "mcp-elicitation-form") assert.fail("unexpected interaction kind")
  assert.deepEqual(record.payload.fields, [{
    id: "labels",
    label: "Labels",
    required: true,
    secret: false,
    input: "multi-select",
    options: [{ value: "bug", label: "Bug" }, { value: "urgent", label: "Urgent" }],
    minItems: 1,
    maxItems: 2,
    default: ["bug"],
  }])
  h.close()
})

test("JSONL parsing preserves partial records and closes on malformed or flooded input", async () => {
  const partial = harness()
  await partial.bridge.startDisposableSession({ threadSlug: "partial-jsonl", sessionId: "partial-jsonl-session", cwd: partial.dir })
  const partialProcess = partial.processes[0]!
  partialProcess.sendRaw('{"method":"unknown/notification","params":')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(partialProcess.killed, false)
  partialProcess.sendRaw('{} }\n')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(partialProcess.killed, false)
  partialProcess.sendRaw("not-json\n")
  await waitFor(() => partialProcess.killed, "malformed JSONL disconnect")
  partial.close()

  const flooded = harness()
  await flooded.bridge.startDisposableSession({ threadSlug: "flood-jsonl", sessionId: "flood-jsonl-session", cwd: flooded.dir })
  const floodProcess = flooded.processes[0]!
  floodProcess.sendBatch(Array.from({ length: 257 }, (_, index) => ({
    method: "unknown/notification",
    params: { index },
  })))
  await waitFor(() => floodProcess.killed, "bounded inbound queue disconnect")
  flooded.close()

  const versioned = harness()
  await versioned.bridge.startDisposableSession({ threadSlug: "versioned-jsonl", sessionId: "versioned-jsonl-session", cwd: versioned.dir })
  const versionedProcess = versioned.processes[0]!
  versionedProcess.send({ jsonrpc: "2.0", method: "unknown/notification", params: {} })
  await waitFor(() => versionedProcess.killed, "versioned envelope disconnect")
  versioned.close()
})

test("stderr diagnostics are byte-only and never retain provider or token text", async () => {
  const h = harness()
  await h.bridge.startDisposableSession({ threadSlug: "stderr-safe", sessionId: "stderr-safe-session", cwd: h.dir })
  const secret = "stderr-secret-token-that-must-not-escape"
  h.processes[0]!.stderr.write(secret)
  h.processes[0]!.stderr.write("x".repeat(20_000))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const serialized = JSON.stringify(h.diagnostics)
  assert.equal(serialized.includes(secret), false)
  assert.ok(h.diagnostics.some((event) => (event as Message).event === "stderr" && (event as Message).truncated === true))
  h.close()
})

test("request acknowledgements cannot cross bridge-owned session boundaries", async () => {
  const h = harness()
  const left = await h.bridge.startDisposableSession({ threadSlug: "left-thread", sessionId: "left-session", cwd: h.dir })
  const right = await h.bridge.startDisposableSession({ threadSlug: "right-thread", sessionId: "right-session", cwd: h.dir })
  await h.bridge.startTurn({ threadSlug: left.threadSlug, sessionId: left.sessionId, text: "Left" })
  const { turnId } = await h.bridge.startTurn({ threadSlug: right.threadSlug, sessionId: right.sessionId, text: "Right" })
  const process = h.processes[0]!
  process.request("right-approval", "item/commandExecution/requestApproval", commandParams(right.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: right.threadSlug, sessionId: right.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  const pending = h.interactions.listPending(scope)[0]!
  await h.bridge.resolveInteraction(scope, {
    slug: right.threadSlug,
    sessionId: right.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: 0,
    responseId: "right-response",
    decisionId: "accept",
  })
  await waitFor(() => process.clientResponses.some((message) => message.id === "right-approval"))
  process.notify("serverRequest/resolved", { threadId: left.codexThreadId, requestId: "right-approval" })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.get(scope, pending.id)?.lifecycle, "pending")
  process.notify("serverRequest/resolved", { threadId: right.codexThreadId, requestId: "right-approval" })
  await waitFor(() => h.interactions.get(scope, pending.id)?.lifecycle === "resolved")
  h.close()
})

test("restart never blindly replays a sent response; a freshly witnessed matching request may rebind it", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "persisted-thread",
    sessionId: "fray-session-persisted",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Run the tests",
  })
  const first = h.processes[0]!
  const params = commandParams(binding.codexThreadId, turnId)
  first.request("approval-old", "item/commandExecution/requestApproval", params)
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1)
  const pending = h.interactions.listPending(scope)[0]!
  await h.bridge.resolveInteraction(scope, {
    slug: binding.threadSlug,
    sessionId: binding.sessionId,
    interactionId: pending.id,
    sessionEpoch: pending.owner.sessionEpoch,
    capabilityRevision: pending.owner.capabilityRevision,
    expectedRecordRevision: 0,
    responseId: "human-response-restart",
    decisionId: "accept",
  })
  await waitFor(() => first.clientResponses.some((message) => message.id === "approval-old"))
  first.disconnect()
  h.bridge.close()
  const restarted = h.newBridge()

  await restarted.resumeOwnedSession(binding.threadSlug, binding.sessionId)
  assert.equal(h.processes.length, 2)
  const second = h.processes[1]!
  assert.ok(second.clientRequests.some((message) => message.method === "thread/resume"))
  assert.equal(second.clientResponses.length, 0, "SENT/unknown response is not replayed during reconnect reconciliation")
  assert.equal(h.interactions.get(scope, pending.id)?.lifecycle, "pending")
  first.request("stale-old-connection", "item/commandExecution/requestApproval", {
    ...params,
    itemId: "item-from-stale-connection",
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.equal(h.interactions.listPending(scope).length, 1, "messages from the disconnected epoch are ignored")

  second.request("approval-new", "item/commandExecution/requestApproval", {
    ...params,
    startedAtMs: (params.startedAtMs as number) + 5_000,
  })
  await waitFor(() => second.clientResponses.some((message) => message.id === "approval-new"), "witnessed retry response")
  assert.deepEqual(second.clientResponses.filter((message) => message.id === "approval-new"), [
    { id: "approval-new", result: { decision: "accept" } },
  ])
  second.notify("serverRequest/resolved", { threadId: binding.codexThreadId, requestId: "approval-new" })
  await waitFor(() => h.interactions.get(scope, pending.id)?.lifecycle === "resolved")
  h.close()
})

test("typed request adapters cover file, permissions, standard MCP form/URL, and experimental user input", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "typed-thread",
    sessionId: "typed-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Exercise adapters" })
  const process = h.processes[0]!
  process.notify("item/started", {
    threadId: binding.codexThreadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "item-file",
      status: "inProgress",
      changes: [{
        path: join(h.dir, "generated.txt"),
        kind: { type: "add" },
        diff: "+generated output\n",
      }],
    },
  })
  process.request("file-1", "item/fileChange/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-file",
    startedAtMs: Date.now(),
    reason: "Write generated output",
    grantRoot: h.dir,
  })
  process.request("permissions-1", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-permissions",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: h.dir,
    reason: "Reach the package registry",
    permissions: { network: { enabled: true }, fileSystem: null },
  })
  process.request("mcp-form-1", "mcpServer/elicitation/request", {
    threadId: binding.codexThreadId,
    turnId,
    serverName: "github",
    mode: "form",
    _meta: null,
    message: "Choose a repository",
    requestedSchema: {
      type: "object",
      properties: { repo: { type: "string", title: "Repository", minLength: 1 } },
      required: ["repo"],
    },
  })
  process.request("mcp-url-1", "mcpServer/elicitation/request", {
    threadId: binding.codexThreadId,
    turnId,
    serverName: "github",
    mode: "url",
    _meta: null,
    message: "Authorize access",
    url: "https://example.test/authorize?state=opaque",
    elicitationId: "elicit-url-1",
  })
  process.request("question-1", "item/tool/requestUserInput", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-question",
    autoResolutionMs: 60_000,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Which option?",
      isOther: false,
      isSecret: false,
      options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }],
    }],
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 5, "all typed interactions")
  assert.deepEqual(
    h.interactions.listPending(scope).map((record) => record.payload.kind).sort(),
    ["agent-question", "file-approval", "mcp-elicitation-form", "mcp-elicitation-url", "permission-approval"].sort(),
  )
  const pendingByKind = new Map(h.interactions.listPending(scope).map((record) => [record.payload.kind, record]))
  const choices = [
    ["file-approval", "file-response", "acceptForSession", undefined],
    ["permission-approval", "permission-response", "grant-session", undefined],
    ["mcp-elicitation-form", "mcp-form-response", "accept", { repo: "openai/codex" }],
    ["mcp-elicitation-url", "mcp-url-response", "decline", undefined],
    ["agent-question", "question-response", "answer", { choice: "A" }],
  ] as const
  for (const [kind, responseId, decisionId, values] of choices) {
    const record = pendingByKind.get(kind)!
    await h.bridge.resolveInteraction(scope, {
      slug: binding.threadSlug,
      sessionId: binding.sessionId,
      interactionId: record.id,
      sessionEpoch: record.owner.sessionEpoch,
      capabilityRevision: record.owner.capabilityRevision,
      expectedRecordRevision: record.recordRevision,
      responseId,
      decisionId,
      ...(values === undefined ? {} : { values }),
    })
  }
  await waitFor(() => process.clientResponses.length === 5, "all typed provider responses")
  assert.deepEqual(process.clientResponses, [
    { id: "file-1", result: { decision: "acceptForSession" } },
    { id: "permissions-1", result: { permissions: { network: { enabled: true } }, scope: "session" } },
    { id: "mcp-form-1", result: { action: "accept", content: { repo: "openai/codex" }, _meta: null } },
    { id: "mcp-url-1", result: { action: "decline", content: null, _meta: null } },
    { id: "question-1", result: { answers: { choice: { answers: ["A"] } } } },
  ])
  h.close()
})

test("exact 0.144.1 permissions and user-input choices never advertise fabricated cancellation responses", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "response-contract-thread",
    sessionId: "response-contract-session",
    cwd: h.dir,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Exercise exact response contracts",
  })
  const process = h.processes[0]!
  process.request("permission-contract", "item/permissions/requestApproval", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "permission-contract-item",
    environmentId: null,
    startedAtMs: Date.now(),
    cwd: h.dir,
    reason: "Need network",
    permissions: { network: { enabled: true }, fileSystem: null },
  })
  process.request("question-contract", "item/tool/requestUserInput", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "question-contract-item",
    autoResolutionMs: null,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Which option?",
      isOther: false,
      isSecret: false,
      options: [{ label: "A", description: "Option A" }],
    }],
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 2, "exact response interactions")
  const byKind = new Map(h.interactions.listPending(scope).map((record) => [record.payload.kind, record]))
  const permission = byKind.get("permission-approval")!
  const question = byKind.get("agent-question")!
  assert.deepEqual(permission.allowedDecisions.map(({ id, semantic }) => ({ id, semantic })), [
    { id: "grant-turn", semantic: "approve" },
    { id: "grant-session", semantic: "approve" },
    { id: "deny", semantic: "deny" },
  ])
  assert.deepEqual(question.allowedDecisions.map(({ id, semantic }) => ({ id, semantic })), [
    { id: "answer", semantic: "answer" },
  ])
  for (const [record, decisionId] of [[permission, "cancel"], [question, "decline"], [question, "cancel"]] as const) {
    await assert.rejects(
      h.bridge.resolveInteraction(scope, {
        slug: scope.threadSlug,
        sessionId: scope.sessionId,
        interactionId: record.id,
        sessionEpoch: record.owner.sessionEpoch,
        capabilityRevision: record.owner.capabilityRevision,
        expectedRecordRevision: record.recordRevision,
        responseId: `unsupported-${decisionId}`,
        decisionId,
      }),
      (error: unknown) => error instanceof InteractionStoreError && error.code === "invalid-decision",
    )
  }
  await h.bridge.resolveInteraction(scope, {
    slug: scope.threadSlug,
    sessionId: scope.sessionId,
    interactionId: permission.id,
    sessionEpoch: permission.owner.sessionEpoch,
    capabilityRevision: permission.owner.capabilityRevision,
    expectedRecordRevision: permission.recordRevision,
    responseId: "deny-permissions",
    decisionId: "deny",
  })
  await h.bridge.resolveInteraction(scope, {
    slug: scope.threadSlug,
    sessionId: scope.sessionId,
    interactionId: question.id,
    sessionEpoch: question.owner.sessionEpoch,
    capabilityRevision: question.owner.capabilityRevision,
    expectedRecordRevision: question.recordRevision,
    responseId: "answer-question",
    decisionId: "answer",
    values: { choice: "A" },
  })
  await waitFor(() => process.clientResponses.length === 2, "exact response payloads")
  assert.deepEqual(process.clientResponses, [
    { id: "permission-contract", result: { permissions: {}, scope: "turn" } },
    { id: "question-contract", result: { answers: { choice: { answers: ["A"] } } } },
  ])
  h.close()
})

test("secret user-input capability is unavailable instead of rendering an unusable durable action", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({ threadSlug: "secret-thread", sessionId: "secret-session", cwd: h.dir })
  const { turnId } = await h.bridge.startTurn({ threadSlug: binding.threadSlug, sessionId: binding.sessionId, text: "Ask safely" })
  const process = h.processes[0]!
  process.request("secret-question", "item/tool/requestUserInput", {
    threadId: binding.codexThreadId,
    turnId,
    itemId: "item-secret",
    autoResolutionMs: null,
    questions: [{ id: "token", header: "Token", question: "Enter token", isOther: false, isSecret: true, options: null }],
  })
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(
    () => process.clientResponses.some((message) => message.id === "secret-question" && "error" in message),
    "secret capability rejection",
  )
  assert.equal(h.interactions.listPending(scope).length, 0)
  assert.ok(h.diagnostics.some((event) => (
    (event as Message).event === "request-rejected" &&
    (event as Message).method === "item/tool/requestUserInput"
  )))
  h.close()
})

test("unsupported Codex version fails negotiation before any thread is created", async () => {
  const h = harness("0.145.0")
  await assert.rejects(
    h.bridge.startDisposableSession({ threadSlug: "bad-version", sessionId: "bad-version-session", cwd: h.dir }),
    /unsupported Codex app-server version/,
  )
  assert.equal(h.processes[0]!.clientRequests.some((message) => message.method === "thread/start"), false)
  assert.deepEqual(h.diagnostics, [{
    event: "version-rejected",
    expected: CODEX_APP_SERVER_SUPPORTED_VERSION,
    received: "0.145.0",
  }])
  h.close()
})

test("closing during initialize keeps SQLite alive until negotiation unwinds", async () => {
  let bridge: CodexAppServerBridge
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, (process) => {
    process.afterInitializeResponse = () => queueMicrotask(() => bridge.close())
  })
  bridge = h.bridge
  await assert.rejects(
    bridge.startDisposableSession({ threadSlug: "closing-thread", sessionId: "closing-session", cwd: h.dir }),
    /closed during negotiation|connection is closed|connection closed/,
  )
  assert.equal(h.processes[0]?.killed, true)
  h.close()
})

test("shutdown re-detaches a binding written by an operation already past its RPC await", async () => {
  let bridge: CodexAppServerBridge
  const h = harness(CODEX_APP_SERVER_SUPPORTED_VERSION, (process) => {
    process.afterThreadStartResponse = () => queueMicrotask(() => bridge.close())
  })
  bridge = h.bridge

  await bridge.startDisposableSession({
    threadSlug: "closing-after-response",
    sessionId: "closing-after-response-session",
    cwd: h.dir,
  })
  await bridge.shutdown()
  const row = h.db.prepare<[], { state: string }>(`
    SELECT state FROM codex_app_server_session
    WHERE thread_slug = 'closing-after-response'
  `).get()
  assert.equal(row?.state, "detached", "no operation can leave live native authority after shutdown")
  h.close()
})

test("registry replacement releases only its exact native binding, process requests, and delivery authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-codex-lifecycle-"))
  const dbPath = join(dir, "ui.db")
  const storage = createStorage(dbPath)
  const processes: FakeAppServerProcess[] = []
  const bridge = new CodexAppServerBridge({
    projectId: "project-1",
    projectDir: dir,
    dbPath,
    interactions: storage.interactions,
    spawn: () => {
      const process = new FakeAppServerProcess()
      processes.push(process)
      return process
    },
    requestTimeoutMs: 1_000,
  })
  storage.subscribeSessionLifecycle((event) => {
    bridge.releaseSession(
      event.previous.slug,
      event.previous.session_id,
      event.type === "replaced" ? "session-replaced" : "session-deleted",
    )
  })
  storage.upsertSession(sessionRow("native-thread", "native-session", "codex-app-server"))
  storage.upsertSession(sessionRow("tui-thread", "tui-session", "codex"))
  const binding = await bridge.startDisposableSession({
    threadSlug: "native-thread",
    sessionId: "native-session",
    cwd: dir,
  })
  const { turnId } = await bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Wait for approval",
  })
  const process = processes[0]!
  process.request("lifecycle-approval", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => storage.interactions.listPending(scope).length === 1, "lifecycle interaction")
  const pending = storage.interactions.listPending(scope)[0]!

  // A normal Codex TUI registry replacement has no app-server binding and must not touch the child.
  storage.upsertSession(sessionRow("tui-thread", "tui-session-replacement", "codex"))
  assert.equal(process.killed, false)
  assert.equal(bridge.binding(binding.threadSlug, binding.sessionId)?.state, "active")

  storage.upsertSession(sessionRow("native-thread", "native-session-replacement", "codex-app-server"))
  await waitFor(() => process.killed, "native child termination")
  assert.equal(bridge.binding(binding.threadSlug, binding.sessionId), undefined)
  assert.equal(bridge.ownsInteraction(scope, pending.id), false)
  assert.equal(storage.interactions.get(scope, pending.id)?.lifecycle, "cancelled")
  assert.equal(storage.interactions.get(scope, pending.id)?.cancellationReason, "session-replaced")
  assert.equal(storage.interactions.providerDelivery(scope, pending.id)?.state, "cancelled")

  storage.upsertSession(sessionRow("delete-thread", "delete-session", "codex-app-server"))
  const deleteBinding = await bridge.startDisposableSession({
    threadSlug: "delete-thread",
    sessionId: "delete-session",
    cwd: dir,
  })
  const deleteTurn = await bridge.startTurn({
    threadSlug: deleteBinding.threadSlug,
    sessionId: deleteBinding.sessionId,
    text: "Wait for deletion",
  })
  const deleteProcess = processes[1]!
  deleteProcess.request(
    "delete-approval",
    "item/commandExecution/requestApproval",
    commandParams(deleteBinding.codexThreadId, deleteTurn.turnId),
  )
  const deleteScope = {
    projectId: "project-1",
    threadSlug: deleteBinding.threadSlug,
    sessionId: deleteBinding.sessionId,
  }
  await waitFor(() => storage.interactions.listPending(deleteScope).length === 1, "delete interaction")
  const deletePending = storage.interactions.listPending(deleteScope)[0]!
  storage.forgetSession(deleteBinding.threadSlug)
  await waitFor(() => deleteProcess.killed, "deleted native child termination")
  assert.equal(bridge.binding(deleteBinding.threadSlug, deleteBinding.sessionId), undefined)
  assert.equal(storage.interactions.get(deleteScope, deletePending.id)?.cancellationReason, "session-deleted")
  assert.equal(storage.interactions.providerDelivery(deleteScope, deletePending.id)?.state, "cancelled")
  bridge.close()
  storage.close()
})

test("bridge close detaches persisted bindings and makes pending delivery rows non-actionable", async () => {
  const h = harness()
  const binding = await h.bridge.startDisposableSession({
    threadSlug: "close-authority-thread",
    sessionId: "close-authority-session",
    cwd: h.dir,
    ephemeral: false,
  })
  const { turnId } = await h.bridge.startTurn({
    threadSlug: binding.threadSlug,
    sessionId: binding.sessionId,
    text: "Wait for close",
  })
  h.processes[0]!.request("close-approval", "item/commandExecution/requestApproval", commandParams(binding.codexThreadId, turnId))
  const scope = { projectId: "project-1", threadSlug: binding.threadSlug, sessionId: binding.sessionId }
  await waitFor(() => h.interactions.listPending(scope).length === 1, "close interaction")
  const pending = h.interactions.listPending(scope)[0]!
  assert.equal(h.bridge.ownsInteraction(scope, pending.id), true)
  h.bridge.close()
  assert.equal(h.processes[0]!.killed, true)
  assert.equal(h.bridge.ownsInteraction(scope, pending.id), false)
  const persisted = h.db.prepare<[string], { state: string; current_turn_id: string | null }>(`
    SELECT state, current_turn_id FROM codex_app_server_session WHERE fray_session_id = ?
  `).get(binding.sessionId)
  assert.deepEqual(persisted, { state: "detached", current_turn_id: turnId })
  assert.equal(h.interactions.providerDelivery(scope, pending.id)?.state, "awaiting-user")
  h.close()
})

test("bridge persistence refuses malformed or future authority schemas before spawning Codex", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-codex-app-server-corrupt-"))
  const dbPath = join(dir, "ui.db")
  const db = new Database(dbPath)
  const interactions = createInteractionStore(db)
  db.exec("CREATE TABLE codex_app_server_meta (singleton INTEGER PRIMARY KEY)")
  let spawned = false
  assert.throws(
    () => new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      dbPath,
      interactions,
      spawn: () => {
        spawned = true
        return new FakeAppServerProcess()
      },
    }),
    (error: unknown) => error instanceof InteractionStoreError && error.code === "schema-version",
  )
  assert.equal(spawned, false)
  interactions.dispose()
  db.close()

  const futurePath = join(dir, "future.db")
  const futureDb = new Database(futurePath)
  const futureInteractions = createInteractionStore(futureDb)
  futureDb.exec(`
    CREATE TABLE codex_app_server_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO codex_app_server_schema VALUES (1, 2);
  `)
  assert.throws(
    () => new CodexAppServerBridge({
      projectId: "project-1",
      projectDir: dir,
      dbPath: futurePath,
      interactions: futureInteractions,
      spawn: () => {
        spawned = true
        return new FakeAppServerProcess()
      },
    }),
    (error: unknown) => error instanceof InteractionStoreError && error.code === "schema-version",
  )
  assert.equal(futureDb.prepare<[], { count: number }>(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name IN ('codex_app_server_meta', 'codex_app_server_session')
  `).get()?.count, 0, "future schemas are refused before authority tables are mutated")
  futureInteractions.dispose()
  futureDb.close()
})
