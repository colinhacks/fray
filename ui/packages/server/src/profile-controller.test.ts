import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProfileController } from "./profile-controller.ts"
import { createStorage, type ProfileHandoffJournal, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import type { BoardManager } from "./board.ts"
import type { PermissionTerminal } from "./permission-controller.ts"

const SPAWNED = "2026-07-13T10:00:00.000Z"
const EMPTY_CLAUDE = "❯\u00a0\n────────────\n  project · branch\n"
const PANE = { paneId: "%1", panePid: 101, sessionCreated: 1_750_000_000 }

function journal(
  slug: string,
  previous: { model: string; effort: string } = { model: "opus", effort: "high" },
  requested: { model: string; effort: string } = { model: "sonnet", effort: "max" },
): ProfileHandoffJournal {
  return {
    version: 1,
    phase: "armed",
    nativeSessionId: `session-${slug}`,
    previous: { ...previous, binding: { kind: "standalone", ...PANE } },
    requested,
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function session(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `session-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: SPAWNED,
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    backend: "claude",
    model: "opus",
    effort: "high",
    permission_mode: "default",
    ...over,
  }
}

function telemetry(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...over }
}

function harness(options: { live?: boolean; tele?: SessionTelemetry; now?: number } = {}) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-profile-controller-")), "ui.db"))
  const currentTelemetry = { value: options.tele ?? telemetry() }
  let refreshes = 0
  const tailer = {
    get: () => currentTelemetry.value,
    tick: () => undefined,
  } as unknown as Tailer
  const board = { refresh: () => { refreshes++ } } as unknown as BoardManager
  const terminal: PermissionTerminal = {
    isLive: () => options.live ?? true,
    paneIdentity: () => PANE,
    capturePane: () => EMPTY_CLAUDE,
    capturePaneEscaped: () => EMPTY_CLAUDE,
    sendLiteral: () => undefined,
    sendKey: () => undefined,
  }
  return { storage, tailer, board, terminal, currentTelemetry, refreshes: () => refreshes, now: () => options.now ?? Date.parse("2026-07-13T12:00:00.000Z") }
}

test("exited profile changes persist one validated pair for the next resume", async () => {
  const h = harness({ live: false })
  h.storage.upsertSession(session("exited", { exited: 1 }))
  const controller = createProfileController(h)
  assert.deepEqual(await controller.request("exited", { model: "sonnet", effort: "max" }), { effect: "next-resume" })
  assert.equal(h.storage.getSession("exited")?.model, "sonnet")
  assert.equal(h.storage.getSession("exited")?.effort, "max")
  await assert.rejects(controller.request("exited", { model: "unknown", effort: "high" }), /Unsupported claude model\/effort pair/)

  h.storage.upsertSession(session("legacy-exited", { exited: 1, model: "retired-model", effort: "retired-effort" }))
  assert.deepEqual(await controller.request("legacy-exited", { model: "haiku", effort: "low" }), { effect: "next-resume" })
  assert.deepEqual(
    { model: h.storage.getSession("legacy-exited")?.model, effort: h.storage.getSession("legacy-exited")?.effort },
    { model: "haiku", effort: "low" },
  )
  h.storage.close()
})

test("an idle live profile change owns one generation and commits only after readiness", async () => {
  const h = harness()
  h.storage.upsertSession(session("live"))
  const calls: unknown[][] = []
  const controller = createProfileController({
    ...h,
    reattach: async (slug, current, requested, onGeneration, onCheckpoint) => {
      calls.push([slug, current, requested])
      const row = h.storage.getSession(slug)!
      const generation = h.storage.beginRuntimeGeneration(slug, {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")
      assert.equal(generation, 1)
      onGeneration?.(generation!)
      const handoffToken = randomUUID()
      onCheckpoint?.({ phase: "target-starting", generation: generation!, handoffToken })
      onCheckpoint?.({ phase: "target-spawned", generation: generation!, handoffToken, identity: PANE })
      onCheckpoint?.({ phase: "target-ready", generation: generation!, handoffToken, identity: PANE })
      return { generation: generation!, outcome: "target-ready" }
    },
  })
  assert.deepEqual(await controller.request("live", { model: "sonnet", effort: "xhigh" }), { effect: "applied" })
  assert.deepEqual(calls, [["live", { model: "opus", effort: "high" }, { model: "sonnet", effort: "xhigh" }]])
  const saved = h.storage.getSession("live")!
  assert.equal(saved.runtime_generation, 1)
  assert.equal(saved.model, "sonnet")
  assert.equal(saved.effort, "xhigh")
  assert.equal(saved.runtime_control, null)
  assert.equal(saved.profile_pending_model, null)
  h.storage.close()
})

test("active work does not arm, while an unproven provider failure stays durably locked", async () => {
  const active = harness({ tele: telemetry({ turn: "in-flight" }) })
  active.storage.upsertSession(session("active"))
  const activeController = createProfileController(active)
  await assert.rejects(activeController.request("active", { model: "sonnet", effort: "high" }), /require an idle thread/)
  assert.equal(active.storage.getSession("active")?.model, "opus")
  assert.equal(active.storage.getSession("active")?.profile_pending_model, null)
  assert.equal(active.storage.getSession("active")?.runtime_control, null)
  active.storage.close()

  const failed = harness()
  failed.storage.upsertSession(session("failed"))
  const failedController = createProfileController({
    ...failed,
    reattach: async (_slug, _current, _requested, onGeneration) => {
      const row = failed.storage.getSession("failed")!
      const generation = failed.storage.beginRuntimeGeneration("failed", {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")!
      onGeneration?.(generation)
      throw new Error("target and rollback failed")
    },
  })
  await assert.rejects(failedController.request("failed", { model: "sonnet", effort: "max" }), /target and rollback failed/)
  assert.equal(failed.storage.getSession("failed")?.model, "opus")
  assert.equal(failed.storage.getSession("failed")?.runtime_control, "profile")
  assert.equal(failed.storage.getSession("failed")?.profile_pending_model, "sonnet")
  assert.ok(failed.storage.getSession("failed")?.profile_handoff)
  assert.match(failed.storage.getSession("failed")?.control_error ?? "", /target and rollback failed/)
  failed.storage.close()
})

test("restart recovery commits only after the exact recovery seam journals target readiness", async () => {
  const good = harness({ now: Date.parse("2026-07-13T12:00:00.000Z"), tele: telemetry() })
  good.storage.upsertSession(session("recover-good"))
  const armed = good.storage.armProfileChange("recover-good", {
    sessionId: "session-recover-good",
    nativeSessionId: null,
    generation: 0,
  }, { model: "sonnet", effort: "max" }, journal("recover-good"))!
  assert.equal(good.storage.beginRuntimeGeneration("recover-good", {
    sessionId: "session-recover-good",
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-13T11:00:00.000Z"), 1)
  const targetToken = randomUUID()
  createProfileController({
    ...good,
    recover: async (row, recovered, observation) => {
      assert.equal(observation.currentTargetObservation, false, "absent telemetry is not proof and does not prevent exact recovery")
      const checkpoint: ProfileHandoffJournal = {
        ...recovered,
        phase: "target-ready",
        target: { generation: 1, handoffToken: targetToken, binding: { kind: "standalone", ...PANE, handoffToken: targetToken } },
      }
      const serialized = good.storage.checkpointProfileChange(row.slug, {
        sessionId: row.session_id,
        nativeSessionId: null,
        generation: 1,
        profileRevision: armed.profileRevision,
        controlRevision: armed.controlRevision,
        model: "sonnet",
        effort: "max",
        profileHandoff: row.profile_handoff!,
      }, checkpoint)
      assert.ok(serialized)
      return { outcome: "target-ready" }
    },
  }).tick()
  await settle()
  assert.equal(good.storage.getSession("recover-good")?.model, "sonnet")
  assert.equal(good.storage.getSession("recover-good")?.runtime_control, null)
  assert.ok(armed.profileRevision > 0)
  good.storage.close()

  const stale = harness({ now: Date.parse("2026-07-13T12:00:00.000Z"), tele: telemetry({ model: "sonnet", effort: "max", profileAt: "2026-07-13T10:59:59.000Z" }) })
  stale.storage.upsertSession(session("recover-stale"))
  const staleArmed = stale.storage.armProfileChange("recover-stale", {
    sessionId: "session-recover-stale",
    nativeSessionId: null,
    generation: 0,
  }, { model: "sonnet", effort: "max" }, journal("recover-stale"))!
  stale.storage.beginRuntimeGeneration("recover-stale", {
    sessionId: "session-recover-stale",
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-13T11:00:00.000Z")
  createProfileController({
    ...stale,
    recover: async (row, recovered, observation) => {
      assert.equal(observation.currentTargetObservation, false)
      const rollbackToken = randomUUID()
      const checkpoint: ProfileHandoffJournal = {
        ...recovered,
        phase: "rollback-ready",
        rollback: { generation: 1, handoffToken: rollbackToken, binding: { ...recovered.previous.binding, handoffToken: rollbackToken } },
      }
      const serialized = stale.storage.checkpointProfileChange(row.slug, {
        sessionId: row.session_id,
        nativeSessionId: null,
        generation: 1,
        profileRevision: staleArmed.profileRevision,
        controlRevision: staleArmed.controlRevision,
        model: "sonnet",
        effort: "max",
        profileHandoff: row.profile_handoff!,
      }, checkpoint)
      assert.ok(serialized)
      return { outcome: "rollback-ready", error: "exact prior runtime restored" }
    },
  }).tick()
  await settle()
  assert.equal(stale.storage.getSession("recover-stale")?.model, "opus")
  assert.equal(stale.storage.getSession("recover-stale")?.runtime_control, null)
  assert.match(stale.storage.getSession("recover-stale")?.control_error ?? "", /exact prior runtime restored/)
  stale.storage.close()
})

test("fresh matching telemetry cannot release a handoff when exact recovery is blocked", async () => {
  const h = harness({ now: Date.parse("2026-07-13T12:00:00.000Z"), tele: telemetry({ model: "sonnet", effort: "max", profileAt: "2026-07-13T11:00:01.000Z" }) })
  h.storage.upsertSession(session("recover-blocked"))
  h.storage.armProfileChange("recover-blocked", {
    sessionId: "session-recover-blocked",
    nativeSessionId: null,
    generation: 0,
  }, { model: "sonnet", effort: "max" }, journal("recover-blocked"))
  h.storage.beginRuntimeGeneration("recover-blocked", {
    sessionId: "session-recover-blocked",
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-13T11:00:00.000Z")
  createProfileController({
    ...h,
    recover: async (_row, _journal, observation) => {
      assert.equal(observation.currentTargetObservation, true)
      return { outcome: "blocked", error: "exact target pane was replaced" }
    },
  }).tick()
  await settle()
  const row = h.storage.getSession("recover-blocked")!
  assert.equal(row.model, "opus")
  assert.equal(row.runtime_control, "profile")
  assert.equal(row.profile_pending_model, "sonnet")
  assert.match(row.control_error ?? "", /exact target pane was replaced/)
  h.storage.close()
})
