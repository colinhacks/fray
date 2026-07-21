import { test } from "node:test"
import assert from "node:assert/strict"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { InteractionRequest } from "@fray-ui/shared"
import { codexInputIsAmbiguous, createBoard, deriveNeedsYou, degradeIfNoTranscript, queuedInputCount, resolveSessionPermission, resolveSessionProfile, resolveSessionTitle } from "./board.ts"
import { Bus } from "./bus.ts"
import { createStorage } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

// The QUEUE DEFINITION is deriveNeedsYou — the single server-side source of truth for "this thread
// needs the human, put it on the stack." These tests pin every queue-worthy state, because a hole
// here means a thread that needs input silently never surfaces (2026-07-09: pendingQuestion was
// omitted, so a chat ```question the human had glanced at dropped off the stack — the exact failure
// the whole product exists to prevent).

const T0 = "2026-07-09T10:00:00.000Z"
const LATER = "2026-07-09T11:00:00.000Z"

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", tmux_name: "fray-t", spawned_at: T0, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null, ...over,
  }
}
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...over }
}

test("resolveSessionProfile: only post-spawn telemetry can supersede a pinned launch profile", () => {
  // Claude: transcript gives the actual resolved model, while persisted launch metadata supplies the
  // effort Claude does not record.
  assert.deepEqual(
    resolveSessionProfile(row({ model: "opus", effort: "high" }), tele({ model: "claude-opus-4-6", profileAt: LATER })),
    { model: "opus", effort: "high" },
  )
  // Codex turn_context carries both, allowing a fully trustworthy pre-migration backfill.
  assert.deepEqual(
    resolveSessionProfile(row({ model: null, effort: null }), tele({ model: "gpt-5.5", effort: "xhigh" })),
    { model: "gpt-5.5", effort: "xhigh" },
  )
  assert.deepEqual(resolveSessionProfile(row(), undefined), { model: undefined, effort: undefined })
  assert.deepEqual(
    resolveSessionProfile(
      row({ model: "opus", effort: "high", spawned_at: LATER }),
      tele({ model: "claude-sonnet-4-6", profileAt: T0 }),
    ),
    { model: "opus", effort: "high" },
    "replayed telemetry from the previous generation cannot snap the target back",
  )
})

test("resolveSessionPermission: exposes only a persisted valid per-thread mode; legacy/unknown stays unknown", () => {
  assert.equal(resolveSessionPermission(row({ permission_mode: "bypassPermissions" })), "bypassPermissions")
  assert.equal(resolveSessionPermission(row({ permission_mode: null })), undefined)
  assert.equal(resolveSessionPermission(row({ permission_mode: "future-mode" })), undefined)
  assert.equal(
    resolveSessionPermission(row({ backend: "codex", permission_mode: "acceptEdits" })),
    "default",
    "legacy Codex workspace-write aliases are normalized at the backend boundary",
  )
  assert.equal(
    resolveSessionPermission(row({ backend: "claude", permission_mode: "bypassPermissions" }), tele({ permissionMode: "auto" })),
    "bypassPermissions",
    "a pre-reattach in-memory fold cannot relabel the newly launched Claude process",
  )
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: LATER, permission_mode: "bypassPermissions" }),
      tele({ permissionMode: "default", permissionModeAt: T0 }),
    ),
    "bypassPermissions",
    "an old Codex turn_context cannot overwrite the new -s launch mode",
  )
  assert.equal(
    resolveSessionPermission(
      row({ backend: "codex", spawned_at: T0, permission_mode: "default" }),
      tele({ permissionMode: "bypassPermissions", permissionModeAt: LATER }),
    ),
    "bypassPermissions",
    "a later backend-observed Codex transition wins",
  )
})

test("queuedInputCount: valid durable arrays count; malformed state degrades to zero", () => {
  assert.equal(queuedInputCount('[{"text":"a"},{"text":"b"}]'), 2)
  assert.equal(queuedInputCount("not json"), 0)
  assert.equal(queuedInputCount(null), 0)
})

test("codexInputIsAmbiguous: only a timed-out submitted head exposes recovery", () => {
  const submitted = JSON.stringify([{ state: "submitted", submittedAt: "1970-01-01T00:00:01.000Z" }])
  assert.equal(codexInputIsAmbiguous(submitted, 30_999), false)
  assert.equal(codexInputIsAmbiguous(submitted, 31_000), true)
  assert.equal(codexInputIsAmbiguous(JSON.stringify([{ state: "pending", submittedAt: "1970-01-01T00:00:01.000Z" }]), 31_000), false)
  assert.equal(codexInputIsAmbiguous("not json", 31_000), false)
})

test("board exposes only the safe Codex queued-follow-up capability, never a raw runtime owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-codex-queue-"))
  const project: Project = { dir, id: "board-codex-queue", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(row({
    slug: "codex-queue",
    tmux_name: "fray-codex-queue",
    backend: "codex",
    runtime_control: "codex-input",
    codex_input_queue: JSON.stringify([{ text: "first", enqueuedAt: T0, state: "pending" }]),
  }))
  storage.setBackend("codex-queue", "codex")
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "codex-queue-boot")
  try {
    const thread = (await board.snapshot()).threads.find((candidate) => candidate.id === "codex-queue")!
    assert.equal(thread.runtimeControlPending, true)
    assert.equal(thread.followUpQueueAvailable, true)
    assert.equal(thread.queuedInputCount, 1)
  } finally {
    board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveSessionTitle: a human title suppresses stale transcript names; generated fallbacks may use them", () => {
  assert.deepEqual(
    resolveSessionTitle(row({ title: "Human-readable thread title", title_auto: 0 }), tele({ aiTitle: "generated-slug" })),
    { title: "Human-readable thread title", titleAuto: false, aiTitle: undefined },
  )
  assert.deepEqual(
    resolveSessionTitle(row({ title: "generated-slug", title_auto: 1 }), tele({ aiTitle: "Useful backend title" })),
    { title: "generated-slug", titleAuto: true, aiTitle: "Useful backend title" },
  )
  assert.deepEqual(
    resolveSessionTitle(
      row({ title: "Original fallback", title_auto: 1 }),
      tele({ customTitle: "rejected-native-slug", customTitleRevision: 1 }),
    ),
    { title: "Original fallback", titleAuto: true, aiTitle: undefined },
    "an unconfirmed custom-title cannot reach board display/notification or paired-file sync",
  )
})

test("deriveNeedsYou: a perm-prompt process block always queues (a view can't clear it)", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ lastActivityAt: T0 }), "perm-prompt"), true)
})

test("deriveNeedsYou: a native pendingAsk always queues, even if seen", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingAsk: { id: "x", questions: [] }, lastActivityAt: T0 }), "turn-idle"), true)
})

test("deriveNeedsYou: a verified native terminal modal queues even while the rollout remains running", () => {
  const blocked = tele({
    turn: "in-flight",
    nativeInputRequired: { kind: "tool-approval", title: "GitHub tool approval required" },
    lastActivityAt: T0,
  })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), blocked, "running"), true)
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), blocked, "spawning"), true)
})

test("deriveNeedsYou: a scoped typed interaction queues immediately, independent of turn state", () => {
  assert.equal(deriveNeedsYou(row(), tele({ turn: "in-flight" }), "running", true), true)
  assert.equal(deriveNeedsYou(row(), tele({ turn: "idle" }), "turn-idle", true), true)
  assert.equal(deriveNeedsYou(row(), tele({ turn: "idle" }), "exited", true), true)
  assert.equal(deriveNeedsYou(row(), tele({ turn: "in-flight" }), "running", false), false)
})

test("board interaction presence cache follows the exact session and rechecks after terminal edges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-interactions-"))
  const project: Project = {
    dir,
    id: "project-board",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(row({ slug: "typed", session_id: "session-a", tmux_name: "fray-typed" }))
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "test-boot")
  const unsubscribe = storage.interactions.subscribe((change) => board.interactionChanged?.(change))
  const request = (providerRequestId: string, sessionId = "session-a"): InteractionRequest => ({
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "fray" },
    source: { kind: "fray", id: "board-test" },
    owner: {
      projectId: project.id,
      threadSlug: "typed",
      sessionId,
      turnId: "turn",
      itemId: providerRequestId,
      sessionEpoch: 1,
      capabilityRevision: 1,
    },
    providerRequestId,
    allowedDecisions: [{ id: "accept", semantic: "approve", label: "provider label" }],
    payload: {
      kind: "command-approval",
      title: "Command",
      command: { summary: "Test", preview: "pnpm test", redacted: true },
    },
    expiresAt: null,
  })
  const current = () => board.refresh().threads.find((thread) => thread.id === "typed")!

  try {
    assert.equal(current().pendingInteraction, false)
    assert.equal(current().actionableInteraction, false)
    const first = storage.interactions.create(request("first")).interaction
    const second = storage.interactions.create(request("second")).interaction
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, true)
    assert.equal(current().needsYou, true)

    const scope = { projectId: project.id, threadSlug: "typed", sessionId: "session-a" }
    storage.interactions.resolve(scope, {
      slug: "typed",
      sessionId: "session-a",
      interactionId: first.id,
      sessionEpoch: 1,
      capabilityRevision: 1,
      expectedRecordRevision: 0,
      responseId: "response-first",
      decisionId: "accept",
    })
    assert.equal(current().pendingInteraction, true, "one terminal edge must recheck for a sibling request")
    assert.equal(current().actionableInteraction, true)
    storage.interactions.resolve(scope, {
      slug: "typed",
      sessionId: "session-a",
      interactionId: second.id,
      sessionEpoch: 1,
      capabilityRevision: 1,
      expectedRecordRevision: 0,
      responseId: "response-second",
      decisionId: "accept",
    })
    assert.equal(current().pendingInteraction, false)
    assert.equal(current().actionableInteraction, false)

    storage.interactions.create(request("old-session-request")).interaction
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, true)
    storage.upsertSession(row({ slug: "typed", session_id: "session-b", tmux_name: "fray-typed" }))
    assert.equal(current().pendingInteraction, false, "a replacement session cannot inherit the old journal scope")
    assert.equal(current().actionableInteraction, false, "a replacement session cannot inherit the old actionability bit")
  } finally {
    unsubscribe()
    await Promise.resolve()
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board keeps provider delivery visible while ordinary resting-thread queue membership survives response delivery and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-provider-delivery-"))
  const project: Project = {
    dir,
    id: "project-provider-board",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath)
  storage.upsertSession(row({ slug: "provider", session_id: "provider-session", tmux_name: "fray-provider" }))
  let board = createBoard(project, storage, new Bus(), tailer, "provider-boot-1")
  let unsubscribe = storage.interactions.subscribe((change) => board.interactionChanged?.(change))
  const request: InteractionRequest = {
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex" },
    source: { kind: "runtime", id: "provider-runtime" },
    owner: {
      projectId: project.id,
      threadSlug: "provider",
      sessionId: "provider-session",
      turnId: "turn",
      itemId: "item",
      sessionEpoch: 1,
      capabilityRevision: 1,
    },
    providerRequestId: "provider-board-request",
    allowedDecisions: [{ id: "accept", semantic: "approve", label: "provider label" }],
    payload: {
      kind: "command-approval",
      title: "Command",
      command: { summary: "Test", preview: "pnpm test", redacted: true },
    },
    expiresAt: null,
  }
  const scope = { projectId: project.id, threadSlug: "provider", sessionId: "provider-session" }
  const current = () => board.refresh().threads.find((thread) => thread.id === "provider")!

  try {
    const pending = storage.interactions.createProviderRequest(request, {
      provider: "codex-app-server",
      logicalRequestId: "provider-board-logical",
      method: "item/commandExecution/requestApproval",
      connectionEpoch: 1,
      rpcRequestId: "provider-board-rpc",
    }).interaction
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, true)
    assert.equal(current().needsYou, true)

    storage.interactions.queueProviderResponse(scope, {
      slug: "provider",
      sessionId: "provider-session",
      interactionId: pending.id,
      sessionEpoch: 1,
      capabilityRevision: 1,
      expectedRecordRevision: 0,
      responseId: "provider-board-response",
      decisionId: "accept",
    }, { decision: "accept" })
    assert.equal(current().pendingInteraction, true, "queued delivery stays readable in the thread")
    assert.equal(current().actionableInteraction, false, "the human already answered; only provider delivery remains")
    assert.equal(current().needsYou, true, "delivery is no longer a hard interaction, but the owned worker is still at rest")

    storage.interactions.claimProviderResponseForSend(pending.id, 1, "provider-board-rpc")
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, false, "sent-but-unacknowledged provider delivery is not actionable")
    assert.equal(current().needsYou, true, "the ambiguous send boundary does not hide an otherwise-resting thread")

    unsubscribe()
    await board.stop()
    storage.close()
    storage = createStorage(dbPath)
    board = createBoard(project, storage, new Bus(), tailer, "provider-boot-2")
    unsubscribe = storage.interactions.subscribe((change) => board.interactionChanged?.(change))
    assert.equal(current().pendingInteraction, true)
    assert.equal(current().actionableInteraction, false, "restart re-derives provider delivery separately from actionability")
    assert.equal(current().needsYou, true, "a fresh process re-derives ordinary rest from durable session ownership")

    storage.interactions.acknowledgeProviderResponse(
      "codex-app-server",
      1,
      "provider-board-rpc",
      scope,
    )
    assert.equal(current().pendingInteraction, false)
    assert.equal(current().actionableInteraction, false)
    assert.equal(current().needsYou, true)
  } finally {
    unsubscribe()
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("deriveNeedsYou: an unanswered ```question at rest queues EVEN IF SEEN (viewing ≠ answering)", () => {
  // THE regression: seen_at newer than the last activity must NOT drop a pending question off the stack.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingQuestion: true, lastActivityAt: T0 }), "turn-idle"), true)
  // Also queues on an exited (crashed/ended) pane that left a question, seen or not.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ pendingQuestion: true, lastActivityAt: T0 }), "exited"), true)
})

test("deriveNeedsYou: a ```question MID-TURN does not queue (ask text hasn't landed)", () => {
  assert.equal(deriveNeedsYou(row(), tele({ pendingQuestion: true, lastActivityAt: LATER }), "running"), false)
  assert.equal(deriveNeedsYou(row(), tele({ pendingQuestion: true }), "spawning"), false)
})

test("deriveNeedsYou: a checked ```done fence at rest queues until archived, even if seen", () => {
  const done = tele({ lastFence: { kind: "done", body: "shipped", hints: [] }, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), done, "turn-idle"), true)
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), done, "exited"), true)
  // A stale final fence never queues during a newer in-flight turn.
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), done, "running"), false)
})

test("deriveNeedsYou: a parked human/timestamp awaiting fence stays out of the operator queue", () => {
  const human = tele({ lastFence: { kind: "awaiting", body: "", hints: [{ kind: "human", value: "Alice must approve" }] }, lastActivityAt: LATER })
  const timer = tele({ lastFence: { kind: "awaiting", body: "", hints: [{ kind: "timer", value: "2099-07-15T17:00:00Z" }] }, lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), human, "turn-idle"), false)
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), timer, "turn-idle"), false)
  // ...but a pending QUESTION overrides a parked fence (a specific ask beats the park).
  const both = tele({ pendingQuestion: true, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "human", value: "Alice must approve" }] } })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), both, "turn-idle"), true)
})

test("deriveNeedsYou: every owned bare rest queues; live child/Monitor work remains in flight", () => {
  assert.equal(deriveNeedsYou(row({ seen_at: null, last_read_at: null }), tele({ lastActivityAt: LATER }), "turn-idle"), true)
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), tele({ lastActivityAt: LATER }), "turn-idle"), true, "viewing cannot clear rest")
  assert.equal(deriveNeedsYou(row({ seen_at: null }), tele({ turn: "idle", lastActivityAt: LATER }), "exited"), true)
  assert.equal(deriveNeedsYou(row({ seen_at: null }), tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER }), "turn-idle"), false)
  assert.equal(deriveNeedsYou(row(), tele({ bgShells: [{ label: "watch", startedAt: T0, state: "running" }] }), "turn-idle"), false)
})

test("deriveNeedsYou: mid-turn never queues; once runtime reports rest the session is presented", () => {
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: LATER }), "running"), false)
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: LATER }), "spawning"), false)
  assert.equal(deriveNeedsYou(row(), tele({ lastActivityAt: undefined }), "turn-idle"), true)
})

test("deriveNeedsYou: crash net — pane EXITED while the turn was in-flight queues, even after a glance", () => {
  // Agent died mid tool_use (turn still in-flight) then the pane exited; you'd already viewed it
  // (seen_at newer than its last activity). Interaction-clearance must NOT bury a dead-mid-work agent.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight", lastActivityAt: T0 }), "exited"), true)
  // A cleanly-ended exited thread also queues, but without the crash presentation bit on ThreadView.
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "idle", lastActivityAt: T0 }), "exited"), true)
})

test("deriveNeedsYou: an EXITED parent surfaces even when a SUB-AGENT still reads 'running' (crash mid-background-work)", () => {
  // A sub-agent cannot outlive its parent pane. A crashed/slept worker that rested on a sub-agent leaves
  // it "running" in telemetry (subAgentViews has no paneDead guard, unlike bgShellViews) until it goes
  // stale — or forever if its output file never resolved. The dead parent MUST still surface. This once
  // silently dangled: hasLiveBackgroundWork buried the exited row instead of queuing it (found 2026-07-21).
  const childRunning = tele({ subAgents: [{ label: "c", startedAt: T0, state: "running", id: "a1" }], lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), childRunning, "exited"), true, "dead parent w/ 'running' sub-agent surfaces")
  // Regression guard for the live case: a LIVE parent (turn-idle) resting on a running child stays held.
  assert.equal(deriveNeedsYou(row({ seen_at: T0 }), childRunning, "turn-idle"), false)
  // A dead parent whose child has already gone STALE also surfaces — via bare rest, not the bgwork arm
  // (stale ≠ "running", so hasLiveBackgroundWork never buries it and it is not counted as live work).
  const childStale = tele({ subAgents: [{ label: "c", startedAt: T0, state: "stale", id: "a1" }], lastActivityAt: LATER })
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), childStale, "exited"), true, "dead parent w/ stale child surfaces via bare rest")
})

test("board: an EXITED parent resting on a 'running' sub-agent surfaces as a stalled crash, not buried", async () => {
  // End-to-end through board assembly: a dead pane (no tmux → runtime 'exited') whose telemetry still
  // reports a running sub-agent must enter Queue (needsYou) AND card as a crash/stall (crashed), so the
  // human sees it instead of it silently dangling under stale child liveness.
  const dir = mkdtempSync(join(tmpdir(), "fray-board-crash-bgwork-"))
  const project: Project = { dir, id: "board-crash-bgwork", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(row({ slug: "dead-parent", tmux_name: "fray-dead-parent", seen_at: LATER }))
  // Sibling with an already-STALE child: it must still surface, but as a bare rest, NOT a stalled crash.
  storage.upsertSession(row({ slug: "dead-parent-stale", tmux_name: "fray-dead-parent-stale", seen_at: LATER }))
  const tailer = {
    get: (slug: string) => tele({
      turn: "idle",
      subAgents: [{ label: "child", startedAt: T0, state: slug === "dead-parent-stale" ? "stale" : "running", id: "a1" }],
      lastActivityAt: LATER,
    }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "crash-bgwork-boot")
  try {
    const snap = await board.snapshot()
    const running = snap.threads.find((candidate) => candidate.id === "dead-parent")!
    assert.equal(running.runtime, "exited", "no live pane derives to exited")
    assert.equal(running.needsYou, true, "the dead parent surfaces instead of being buried by stale child liveness")
    assert.equal(running.crashed, true, "a running sub-agent on a dead pane cards as a stall, not a bare rest")
    const stale = snap.threads.find((candidate) => candidate.id === "dead-parent-stale")!
    assert.equal(stale.needsYou, true, "a dead parent whose child went stale still surfaces")
    assert.equal(stale.crashed, false, "but a stale child is not live work, so it cards as bare rest")
  } finally {
    board.stop()
  }
})

test("deriveNeedsYou: manual snooze suppresses every queue reason until its exact deadline", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z")
  const snoozed = row({ snoozed_until: "2026-07-14T12:00:00.000Z" })
  assert.equal(deriveNeedsYou(snoozed, tele(), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ lastFence: { kind: "done", body: "done", hints: [] } }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ pendingQuestion: true }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ pendingAsk: { id: "ask", questions: [] } }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ nativeInputRequired: { kind: "permission", title: "Permission required" } }), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele({ turn: "in-flight" }), "exited", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele(), "turn-idle", true, now), false, "typed interaction is parked too")
  assert.equal(deriveNeedsYou(snoozed, tele(), "perm-prompt", false, now), false)
  assert.equal(deriveNeedsYou(snoozed, tele(), "turn-idle", false, Date.parse("2026-07-14T12:00:00.001Z")), true, "due snooze requeues")
})

test("deriveNeedsYou: only truthful human/future-timer waits excuse rest; machine and elapsed waits queue", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z")
  const waiting = (kind: "human" | "github-review" | "timer" | "pr" | "ci" | "session", value: string) =>
    tele({ lastFence: { kind: "awaiting", body: "", hints: [{ kind, value }] } })
  assert.equal(deriveNeedsYou(row(), waiting("human", "Alice review"), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(row(), waiting("github-review", "owner/repo#1"), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(row(), waiting("timer", "2026-07-14T12:00:00Z"), "turn-idle", false, now), false)
  assert.equal(deriveNeedsYou(row(), waiting("timer", "2026-07-12T12:00:00Z"), "turn-idle", false, now), true)
  assert.equal(deriveNeedsYou(row(), waiting("ci", "build"), "turn-idle", false, now), true)
  assert.equal(deriveNeedsYou(row(), tele({ lastFence: { kind: "awaiting", body: "", hints: [] } }), "turn-idle", false, now), true)
})

test("board arms the exact durable snooze deadline, clears it, and requeues ordinary rest without browser activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-snooze-wake-"))
  const project: Project = {
    dir,
    id: "project-snooze-wake",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"))
  const until = new Date(Date.now() + 120).toISOString()
  storage.upsertSession(row({
    slug: "snooze-wake",
    session_id: "snooze-session",
    tmux_name: "fray-snooze-wake",
    snoozed_until: until,
  }))
  const tailer = {
    get: () => tele({ turn: "idle", lastActivityAt: new Date().toISOString() }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "snooze-wake-boot")
  try {
    await board.start()
    const first = (await board.snapshot()).threads.find((thread) => thread.id === "snooze-wake")!
    assert.equal(first.needsYou, false)
    assert.equal(first.snoozedUntil, until)
    const deadline = Date.now() + 1_500
    let woke = first
    while (Date.now() < deadline && !woke.needsYou) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      woke = (await board.snapshot()).threads.find((thread) => thread.id === "snooze-wake")!
    }
    assert.equal(woke.needsYou, true, "the otherwise-resting thread re-enters Queue at its deadline")
    assert.equal(woke.snoozedUntil, undefined)
    assert.equal(storage.getSession("snooze-wake")?.snoozed_until, null)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board immediately expires a snooze whose deadline passes between assembly and timer scheduling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-snooze-race-"))
  const base = Date.parse("2026-07-13T12:00:00.000Z")
  const until = new Date(base + 10).toISOString()
  let clockReads = 0
  const project: Project = {
    dir,
    id: "project-snooze-race",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(row({
    slug: "snooze-race",
    session_id: "snooze-race-session",
    tmux_name: "fray-snooze-race",
    snoozed_until: until,
  }))
  const tailer = {
    get: () => tele({ turn: "idle", lastActivityAt: new Date(base).toISOString() }),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  // First read is the coherent assembly instant (deadline still future); the scheduler read crosses
  // it. Every later rebuild sees the crossed instant. No real timer or 15s reconcile is involved.
  const board = createBoard(project, storage, new Bus(), tailer, "snooze-race-boot", {
    now: () => clockReads++ === 0 ? base : base + 20,
  })
  try {
    await board.start()
    await Promise.resolve()
    const woke = (await board.snapshot()).threads.find((thread) => thread.id === "snooze-race")!
    assert.ok(clockReads >= 3, "deadline crossing queues a second assembly immediately")
    assert.equal(woke.needsYou, true)
    assert.equal(woke.snoozedUntil, undefined)
    assert.equal(storage.getSession("snooze-race")?.snoozed_until, null)
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- missing-transcript degraded runtime (session-transcript-drift) ----

test("degradeIfNoTranscript: only a live-pane spinner (running) downgrades to the stalled 'exited' affordance", () => {
  // The eternal-spinner case: a boot-failed worker whose pane still reads live → deriveRuntime = running.
  assert.equal(degradeIfNoTranscript("running", true), "exited")
  // A present transcript (noTranscript false/undefined) is NEVER downgraded — the normal path is untouched.
  assert.equal(degradeIfNoTranscript("running", false), "running")
  assert.equal(degradeIfNoTranscript("running", undefined), "running")
  // Every other runtime is left exactly as-is (a dead pane is already exited; idle/perm/none are real).
  for (const r of ["none", "turn-idle", "perm-prompt", "exited", "spawning"] as const) {
    assert.equal(degradeIfNoTranscript(r, true), r)
  }
})

test("deriveNeedsYou: a missing-transcript row cards — degraded to exited, its turn stays in-flight (crash-net)", () => {
  // The tailer keeps a transcript-less session's turn "in-flight" (no records → in-flight); the board
  // degrades its runtime to "exited" (degradeIfNoTranscript). That pair trips the crash-net → it queues,
  // so a boot-failed worker surfaces to the human instead of spinning silently forever.
  const runtime = degradeIfNoTranscript("running", true)
  assert.equal(runtime, "exited")
  assert.equal(deriveNeedsYou(row({ seen_at: LATER }), tele({ turn: "in-flight", noTranscript: true, lastActivityAt: T0 }), runtime), true)
})

test("registered auto-titles stay in SQLite/transcript and never sync into a planted legacy file", async () => {
  // Structural guard: the board must not regain the legacy updater as an auto-title side channel.
  const boardSource = readFileSync(new URL("./board.ts", import.meta.url), "utf8")
  assert.doesNotMatch(boardSource, /\brunThreadUpdate\b/)

  const dir = mkdtempSync(join(tmpdir(), "fray-board-auto-title-"))
  mkdirSync(join(dir, ".fray"))
  const regular = join(dir, ".fray", "auto-regular.md")
  const external = join(dir, "outside.md")
  const linked = join(dir, ".fray", "auto-linked.md")
  // A terminal-looking planted file would archive this state=NULL row if the legacy reader opened it.
  writeFileSync(regular, "---\ntitle: Planted\nstatus: done\n---\nregular sentinel\n")
  writeFileSync(external, "external sentinel\n")
  symlinkSync(external, linked)
  const project: Project = {
    dir,
    id: "project-auto-title",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"))
  for (const slug of ["auto-regular", "auto-linked"]) {
    storage.upsertSession(row({
      slug,
      session_id: `session-${slug}`,
      tmux_name: `fray-${slug}`,
      title: "Stored fallback",
      title_auto: 1,
      state: null,
    }))
  }
  const tailer = {
    get: (slug: string) => slug.startsWith("auto-") ? tele({ aiTitle: `Transcript title for ${slug}` }) : undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "auto-title-boot")

  try {
    const snapshot = await board.snapshot()
    assert.deepEqual(
      snapshot.threads
        .map((thread) => ({ id: thread.id, aiTitle: thread.aiTitle }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "auto-linked", aiTitle: "Transcript title for auto-linked" },
        { id: "auto-regular", aiTitle: "Transcript title for auto-regular" },
      ],
    )
    assert.equal(storage.getSession("auto-regular")?.title, "Stored fallback")
    assert.equal(storage.getSession("auto-linked")?.title, "Stored fallback")
    assert.equal(snapshot.threads.find((thread) => thread.id === "auto-regular")?.state, "open")
    assert.equal(snapshot.threads.find((thread) => thread.id === "auto-linked")?.state, "open")
    assert.equal(
      readFileSync(regular, "utf8"),
      "---\ntitle: Planted\nstatus: done\n---\nregular sentinel\n",
    )
    assert.equal(lstatSync(linked).isSymbolicLink(), true)
    assert.equal(readFileSync(external, "utf8"), "external sentinel\n")
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board provenance excludes legacy files and foreign transcripts while registered sessions survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-provenance-"))
  mkdirSync(join(dir, ".fray", "plans"), { recursive: true })
  const reportedInvalidFiles = [
    "nubx-dashdash-A-conformance",
    "bun-1.4-lockfile-v2-research",
    "coffeescript-bench-v0.2.9",
    "deno-2.9-steal",
    "pnpm-11.9-audit",
    "release-v0.1.10",
  ]
  for (const slug of [...reportedInvalidFiles, "valid-external-legacy"]) {
    // Deliberately malformed: if the legacy parser sees any of these, the snapshot gains an error.
    writeFileSync(join(dir, ".fray", `${slug}.md`), "not frontmatter\n")
  }
  writeFileSync(
    join(dir, ".fray", "migrated-ui-done.md"),
    "---\ntitle: Migrated UI thread\nstatus: done\n---\n",
  )
  writeFileSync(join(dir, ".fray", "plans", "Owned plan.md"), "# Owned plan\n")
  writeFileSync(join(dir, "outside-plan.md"), "# Outside plan\n")
  symlinkSync(join(dir, "outside-plan.md"), join(dir, ".fray", "plans", "Linked plan.md"))
  const project: Project = {
    dir,
    id: "project-board-provenance",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const dbPath = join(dir, "ui.db")
  let storage = createStorage(dbPath)
  storage.upsertSession(row({
    slug: "ui-claude",
    session_id: "claude-session",
    tmux_name: "fray-ui-claude",
    title: "Claude UI thread",
    title_auto: 0,
    state: null,
    plan_path: ".fray/plans/Owned plan.md",
  }))
  storage.upsertSession(row({
    slug: "ui-codex",
    session_id: "codex-session",
    tmux_name: "fray-ui-codex",
    title: "Codex UI thread",
    backend: "codex",
    state: "archived",
    archived: 1,
  }))
  storage.upsertSession(row({
    slug: "migrated-ui-done",
    session_id: "migrated-session",
    tmux_name: "fray-migrated-ui-done",
    title: "Migrated UI thread",
    state: null,
    archived: 0,
  }))
  // The normal upsert deliberately leaves backend ownership untouched; dispatch/adoption pins it
  // separately. Exercise the durable values the board projection actually receives.
  storage.setBackend("ui-codex", "codex")
  storage.setBackend("migrated-ui-done", "future-provider")
  const telemetry = new Map<string, SessionTelemetry>([
    ["ui-claude", tele({ lastFence: { kind: "done", body: "complete", hints: [] } })],
    ["foreign-terminal-origin", tele({ lastFence: { kind: "done", body: "foreign", hints: [] } })],
  ])
  const tailer = {
    get: (slug: string) => telemetry.get(slug),
    foreignIds: () => ["foreign-terminal-origin"],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let board = createBoard(project, storage, new Bus(), tailer, "provenance-boot-1")

  try {
    let snapshot = await board.snapshot()
    assert.deepEqual(snapshot.threads.map((thread) => thread.id).sort(), ["migrated-ui-done", "ui-claude", "ui-codex"])
    assert.equal(snapshot.threads.some((thread) => thread.foreign || thread.kind === "legacy"), false)
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-claude")?.needsYou, true)
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-claude")?.backend, "claude")
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-codex")?.backend, "codex")
    assert.equal(snapshot.threads.find((thread) => thread.id === "migrated-ui-done")?.backend, undefined)
    assert.equal(snapshot.threads.find((thread) => thread.id === "migrated-ui-done")?.state, "archived")
    assert.deepEqual(snapshot.errors, [])
    assert.deepEqual(snapshot.warnings, [])
    assert.deepEqual(snapshot.errorItems, [])
    assert.deepEqual((snapshot.plans ?? []).map((plan) => ({ title: plan.title, threadIds: plan.threadIds })), [
      { title: "Owned plan", threadIds: ["ui-claude"] },
    ])

    // Finalized adoption writes the same durable session row as dispatch. Once that explicit boundary
    // exists, a formerly external legacy file is represented as an owned session—not as a legacy row.
    writeFileSync(join(dir, ".fray", "adopted-through-ui.md"), "still not parsed\n")
    storage.upsertSession(row({
      slug: "adopted-through-ui",
      session_id: "adopted-session",
      tmux_name: "fray-adopted-through-ui",
      title: "Adopted through UI",
      state: "open",
    }))
    snapshot = board.refresh()
    assert.equal(snapshot.threads.find((thread) => thread.id === "adopted-through-ui")?.kind, "session")

    storage.setState("ui-codex", "open")
    assert.equal(board.refresh().threads.find((thread) => thread.id === "ui-codex")?.state, "open")

    // Reopening the exact database is the migration/restart boundary: no new provenance column is
    // required, and older state=NULL session rows remain owned and open.
    await board.stop()
    storage.close()
    storage = createStorage(dbPath)
    board = createBoard(project, storage, new Bus(), tailer, "provenance-boot-2")
    snapshot = await board.snapshot()
    assert.deepEqual(snapshot.threads.map((thread) => thread.id).sort(), [
      "adopted-through-ui",
      "migrated-ui-done",
      "ui-claude",
      "ui-codex",
    ])
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-claude")?.state, "open")
    assert.equal(snapshot.threads.find((thread) => thread.id === "ui-codex")?.state, "open")
    assert.equal(snapshot.threads.find((thread) => thread.id === "migrated-ui-done")?.state, "archived")
    assert.deepEqual(snapshot.errorItems, [])
  } finally {
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board stop drains a watcher setup that races shutdown and immediately unsubscribes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-watch-shutdown-"))
  mkdirSync(join(dir, ".fray"))
  const project: Project = {
    dir,
    id: "project-board-watch-shutdown",
    name: "fixture",
    label: "fixture",
    stateDir: dir,
    cwdSlug: "fixture",
  }
  const storage = createStorage(join(dir, "ui.db"))
  const tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  let markSubscribeStarted!: () => void
  const subscribeStarted = new Promise<void>((resolve) => { markSubscribeStarted = resolve })
  let releaseSubscribe!: () => void
  const subscribeGate = new Promise<void>((resolve) => { releaseSubscribe = resolve })
  let unsubscribes = 0
  const board = createBoard(project, storage, new Bus(), tailer, "watch-shutdown-boot", {
    subscribe: async () => {
      markSubscribeStarted()
      await subscribeGate
      return { unsubscribe: async () => { unsubscribes++ } }
    },
  })
  const starting = board.start()
  await subscribeStarted
  let stopSettled = false
  const stopping = board.stop().then(() => { stopSettled = true })

  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(stopSettled, false)
    releaseSubscribe()
    await Promise.all([starting, stopping])
    assert.equal(unsubscribes, 1, "a watcher acquired after the stop gate is torn down before drain completes")
  } finally {
    releaseSubscribe()
    await board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("board exposes a typed providerFault from tailer auth telemetry — category only, no raw text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-auth-fault-"))
  const project: Project = { dir, id: "board-auth-fault", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(row({ slug: "auth-fault", tmux_name: "fray-auth-fault", backend: "claude" }))
  const tailer = {
    get: (slug: string) => (slug === "auth-fault" ? tele({ authFault: "authentication_rejected" }) : undefined),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "auth-fault-boot")
  try {
    const thread = (await board.snapshot()).threads.find((candidate) => candidate.id === "auth-fault")!
    assert.deepEqual(thread.providerFault, { backend: "claude", category: "authentication_rejected" })
    const clean = (await board.snapshot()).threads.find((candidate) => candidate.id === "auth-fault")!
    assert.equal(JSON.stringify(clean).includes("401"), false, "no raw provider text rides the snapshot")
  } finally {
    board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
