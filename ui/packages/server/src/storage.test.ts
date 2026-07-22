import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStorage, type ProfileHandoffJournal, type Storage, type SessionRow } from "./storage.ts"

function profileHandoff(
  nativeSessionId: string,
  previous: { model: string; effort: string },
  requested: { model: string; effort: string },
): ProfileHandoffJournal {
  return {
    version: 1,
    phase: "armed",
    nativeSessionId,
    previous: {
      ...previous,
      binding: { kind: "standalone", paneId: "%1", panePid: 101, sessionCreated: 1_750_000_000 },
    },
    requested,
  }
}

function store(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "fray-storage-")), "ui.db"))
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  const result = {
    slug: "t",
    session_id: "sid",
    tmux_name: "fray-t",
    spawned_at: "2026-07-01T00:00:00.000Z",
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
    ...over,
  }
  if (over.slug !== undefined && over.tmux_name === undefined) result.tmux_name = `fray-${result.slug}`
  return result
}

test("storage close is idempotent", () => {
  const s = store()
  s.upsertSession(row())
  assert.doesNotThrow(() => s.close())
  assert.doesNotThrow(() => s.close(), "competing shutdown paths cannot close SQLite twice")
})

test("insertSessionIfAbsent atomically preserves the winner and writes backend identity in one claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-storage-claim-"))
  const path = join(dir, "ui.db")
  const first = createStorage(path)
  const second = createStorage(path)

  assert.equal(first.insertSessionIfAbsent(row({
    slug: "claimed",
    session_id: "codex-owner",
    backend: "codex",
    agent_session_id: "codex-native-id",
    exited: 1,
    archived: 1,
    state: "archived",
  })), true)

  // A second connection simulates another server/process winning or losing the same registry CAS.
  // It must not partially convert a Codex owner into Claude or clear its native-session identity.
  assert.equal(second.insertSessionIfAbsent(row({
    slug: "claimed",
    session_id: "claude-loser",
    backend: "claude",
    agent_session_id: null,
    exited: 0,
    archived: 0,
    state: "open",
  })), false)
  assert.deepEqual(
    {
      sessionId: second.getSession("claimed")?.session_id,
      backend: second.getSession("claimed")?.backend,
      agentSessionId: second.getSession("claimed")?.agent_session_id,
      exited: second.getSession("claimed")?.exited,
      archived: second.getSession("claimed")?.archived,
      state: second.getSession("claimed")?.state,
    },
    {
      sessionId: "codex-owner",
      backend: "codex",
      agentSessionId: "codex-native-id",
      exited: 1,
      archived: 1,
      state: "archived",
    },
  )

  // A genuinely fresh Claude claim writes both identity fields explicitly in the same statement.
  assert.equal(second.insertSessionIfAbsent(row({ slug: "fresh-claude", session_id: "claude-owner" })), true)
  assert.equal(first.getSession("fresh-claude")?.backend, "claude")
  assert.equal(first.getSession("fresh-claude")?.agent_session_id, null)

  second.close()
  first.close()
})

test("adoption finalization atomically publishes the session and exact binding; replacement retires it", () => {
  const s = store()
  const slug = "atomic-adoption"
  const sessionId = randomUUID()
  const token = randomUUID()
  assert.equal(s.reserveAdoptionClaim({
    slug,
    attemptToken: token,
    sessionId,
    reservedAtMs: 100,
    leaseExpiresAtMs: 200,
  }), true)
  assert.equal(s.getSession(slug), undefined)
  assert.equal(s.recordAdoptionPane(slug, token, { paneId: "%7", panePid: 700, sessionCreated: 7000 }, 200), true)
  assert.equal(s.finalizeAdoptionClaim(slug, token, row({ slug, session_id: sessionId }), 150), true)
  assert.equal(s.getSession(slug)?.session_id, sessionId)
  assert.deepEqual(
    {
      state: s.getAdoptionClaim(slug)?.state,
      paneId: s.getAdoptionClaim(slug)?.pane_id,
      panePid: s.getAdoptionClaim(slug)?.pane_pid,
      sessionCreated: s.getAdoptionClaim(slug)?.session_created,
    },
    { state: "finalized", paneId: "%7", panePid: 700, sessionCreated: 7000 },
  )

  s.upsertSession(row({ slug, session_id: "replacement" }))
  assert.equal(s.getAdoptionClaim(slug), undefined)
  assert.equal(s.getSession(slug)?.session_id, "replacement")
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === token))
})

test("forgetSession removes only the matching finalized adoption binding", () => {
  const s = store()
  const slug = "forget-adoption"
  const sessionId = randomUUID()
  const token = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: token, sessionId, reservedAtMs: 100, leaseExpiresAtMs: 200 }), true)
  assert.equal(s.recordAdoptionPane(slug, token, { paneId: "%8", panePid: 800, sessionCreated: 8000 }, 200), true)
  assert.equal(s.finalizeAdoptionClaim(slug, token, row({ slug, session_id: sessionId }), 150), true)
  assert.ok(s.forgetSession(slug))
  assert.equal(s.getSession(slug), undefined)
  assert.equal(s.getAdoptionClaim(slug), undefined)
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === token))
})

test("adopted respawn rotates its claim without an unbound window and failed setup restores a bound no-pane marker", () => {
  const s = store()
  const slug = "adoption-respawn"
  const sessionId = randomUUID()
  const original = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: original, sessionId, reservedAtMs: 100, leaseExpiresAtMs: 200 }), true)
  assert.equal(s.recordAdoptionPane(slug, original, { paneId: "%9", panePid: 900, sessionCreated: 9000 }, 200), true)
  assert.equal(s.finalizeAdoptionClaim(slug, original, row({ slug, session_id: sessionId }), 150), true)

  const failed = randomUUID()
  assert.equal(s.rearmFinalizedAdoptionClaim({
    slug,
    attemptToken: failed,
    sessionId,
    reservedAtMs: 300,
    leaseExpiresAtMs: 400,
  }, original), true)
  assert.equal(s.getAdoptionClaim(slug)?.state, "reserved")
  assert.equal(s.getSession(slug)?.session_id, sessionId, "the registry owner remains present while readers fail closed")
  assert.equal(s.abandonAdoptionClaim(slug, failed), true)
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === original))
  assert.ok(s.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === failed))
  assert.deepEqual(
    {
      state: s.getAdoptionClaim(slug)?.state,
      token: s.getAdoptionClaim(slug)?.attempt_token,
      pane: s.getAdoptionClaim(slug)?.pane_id,
    },
    { state: "finalized", token: failed, pane: null },
  )

  const successful = randomUUID()
  assert.equal(s.rearmFinalizedAdoptionClaim({
    slug,
    attemptToken: successful,
    sessionId,
    reservedAtMs: 500,
    leaseExpiresAtMs: 600,
  }, failed), true)
  assert.equal(s.recordAdoptionPane(slug, successful, { paneId: "%10", panePid: 1000, sessionCreated: 10000 }, 600), true)
  assert.equal(s.finalizeAdoptionRespawnClaim(slug, successful, sessionId, 550), true)
  assert.deepEqual(
    {
      state: s.getAdoptionClaim(slug)?.state,
      token: s.getAdoptionClaim(slug)?.attempt_token,
      pane: s.getAdoptionClaim(slug)?.pane_id,
    },
    { state: "finalized", token: successful, pane: "%10" },
  )
})

test("adoption spawn fence revalidates and binds under one SQLite writer lock; retired tokens cannot spawn", () => {
  const s = store()
  const slug = "spawn-fence"
  const sessionId = randomUUID()
  const token = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: token, sessionId, reservedAtMs: 10, leaseExpiresAtMs: 20 }), true)
  let spawns = 0
  const fenced = s.withAdoptionSpawnFence(slug, token, 100, (bindPane) => {
    spawns++
    const identity = { paneId: "%70", panePid: 7000, sessionCreated: 70000 }
    assert.equal(bindPane(identity, 100), true)
    return identity
  })
  assert.deepEqual(fenced, {
    acquired: true,
    value: { paneId: "%70", panePid: 7000, sessionCreated: 70000 },
  })
  assert.equal(s.abandonAdoptionClaim(slug, token), true)
  assert.equal(s.withAdoptionSpawnFence(slug, token, 200, () => void spawns++).acquired, false)
  assert.equal(spawns, 1, "a retired stale actor never reaches external new-session")
})

test("forgetSessionIfCurrent loses safely to an adoption-token rotation and preserves the successor", () => {
  const s = store()
  const slug = "forget-rotation"
  const sessionId = randomUUID()
  const oldToken = randomUUID()
  assert.equal(s.reserveAdoptionClaim({ slug, attemptToken: oldToken, sessionId, reservedAtMs: 10, leaseExpiresAtMs: 20 }), true)
  assert.equal(s.recordAdoptionPane(slug, oldToken, { paneId: "%71", panePid: 7100, sessionCreated: 71000 }, 20), true)
  assert.equal(s.finalizeAdoptionClaim(slug, oldToken, row({ slug, session_id: sessionId, runtime_generation: 4 }), 15), true)

  const newToken = randomUUID()
  assert.equal(s.rearmFinalizedAdoptionClaim({
    slug,
    attemptToken: newToken,
    sessionId,
    reservedAtMs: 30,
    leaseExpiresAtMs: 40,
  }, oldToken), true)
  assert.equal(s.recordAdoptionPane(slug, newToken, { paneId: "%72", panePid: 7200, sessionCreated: 72000 }, 40), true)
  assert.equal(s.finalizeAdoptionRespawnClaim(slug, newToken, sessionId, 35), true)

  assert.equal(s.forgetSessionIfCurrent(slug, {
    sessionId,
    runtimeGeneration: 4,
    adoptionAttemptToken: oldToken,
  }), undefined)
  assert.equal(s.getSession(slug)?.session_id, sessionId)
  assert.equal(s.getAdoptionClaim(slug)?.attempt_token, newToken)
})

test("session profile: model/effort round-trip and survive a resume-style upsert", () => {
  const s = store()
  s.upsertSession(row({ slug: "profiled", model: "gpt-5.6-sol", effort: "ultra" }))
  let saved = s.getSession("profiled")!
  assert.equal(saved.model, "gpt-5.6-sol")
  assert.equal(saved.effort, "ultra")

  // resumeThread spreads the existing row through upsertSession; the original launch profile must
  // survive instead of being replaced by whatever Settings say at resume time.
  s.upsertSession({ ...saved, spawned_at: "2026-07-01T01:00:00.000Z", exited: 0 })
  saved = s.getSession("profiled")!
  assert.equal(saved.model, "gpt-5.6-sol")
  assert.equal(saved.effort, "ultra")
})

test("profile target/pending/revision and runtime control commit as one exact-owned CAS", () => {
  const s = store()
  s.upsertSession(row({
    slug: "profile-control",
    model: "gpt-5.5",
    effort: "high",
  }))
  s.setBackend("profile-control", "codex")
  s.setAgentSession("profile-control", "native-a")
  const initial = s.getSession("profile-control")!
  const armed = s.armProfileChange("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 0,
  }, { model: "gpt-5.6-sol", effort: "ultra" }, profileHandoff(
    "native-a",
    { model: "gpt-5.5", effort: "high" },
    { model: "gpt-5.6-sol", effort: "ultra" },
  ))
  assert.ok(armed)
  assert.deepEqual(
    {
      model: s.getSession("profile-control")?.model,
      effort: s.getSession("profile-control")?.effort,
      pendingModel: s.getSession("profile-control")?.profile_pending_model,
      pendingEffort: s.getSession("profile-control")?.profile_pending_effort,
      control: s.getSession("profile-control")?.runtime_control,
    },
    { model: "gpt-5.5", effort: "high", pendingModel: "gpt-5.6-sol", pendingEffort: "ultra", control: "profile" },
  )
  assert.equal(s.beginRuntimeControl("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 0,
  }, "ai-rename"), null, "every competing runtime controller loses while the profile claim is armed")

  const generation = s.beginRuntimeGeneration("profile-control", {
    sessionId: initial.session_id,
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-01T00:01:00.000Z")
  assert.equal(generation, 1)
  assert.equal(s.commitProfileChange("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 0,
    profileRevision: armed!.profileRevision,
    controlRevision: armed!.controlRevision,
    model: "gpt-5.6-sol",
    effort: "ultra",
    profileHandoff: armed!.profileHandoff,
  }), false, "an old generation cannot commit after the replacement spawn")
  assert.equal(s.commitProfileChange("profile-control", {
    sessionId: initial.session_id,
    nativeSessionId: "native-a",
    generation: 1,
    profileRevision: armed!.profileRevision,
    controlRevision: armed!.controlRevision,
    model: "gpt-5.6-sol",
    effort: "ultra",
    profileHandoff: armed!.profileHandoff,
  }), true)
  const committed = s.getSession("profile-control")!
  assert.equal(committed.model, "gpt-5.6-sol")
  assert.equal(committed.effort, "ultra")
  assert.equal(committed.profile_pending_model, null)
  assert.equal(committed.runtime_control, null)
  s.close()
})

test("observed runtime profiles persist only for the current generation outside a control handoff", () => {
  const s = store()
  s.upsertSession(row({ slug: "observed-profile", model: "opus", effort: "high" }))
  assert.equal(s.beginRuntimeGeneration("observed-profile", {
    sessionId: "sid",
    generation: 0,
    permissionPending: null,
    runtimeControl: null,
  }, "2026-07-01T00:01:00.000Z"), 1)
  assert.equal(s.setObservedProfileIfCurrent("observed-profile", {
    sessionId: "sid",
    generation: 0,
  }, { model: "sonnet", effort: "max" }), false)
  assert.equal(s.setObservedProfileIfCurrent("observed-profile", {
    sessionId: "sid",
    generation: 1,
  }, { model: "sonnet", effort: "max" }), true)
  const current = s.getSession("observed-profile")!
  const armed = s.armProfileChange("observed-profile", {
    sessionId: current.session_id,
    nativeSessionId: current.agent_session_id ?? null,
    generation: 1,
  }, { model: "haiku", effort: "low" }, profileHandoff(
    current.agent_session_id ?? current.session_id,
    { model: "sonnet", effort: "max" },
    { model: "haiku", effort: "low" },
  ))
  assert.ok(armed)
  assert.equal(s.setObservedProfileIfCurrent("observed-profile", {
    sessionId: "sid",
    generation: 1,
  }, { model: "opus", effort: "high" }), false)
  s.close()
})

test("session permission actual/pending values round-trip independently and survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-storage-permission-"))
  const path = join(dir, "ui.db")
  const s = createStorage(path)
  s.upsertSession(row({ slug: "permissioned", permission_mode: "auto" }))
  assert.equal(s.getSession("permissioned")?.permission_mode, "auto")
  s.setPermissionMode("permissioned", "bypassPermissions")
  assert.equal(s.getSession("permissioned")?.permission_mode, "bypassPermissions")
  s.setPermissionPending("permissioned", "default")
  assert.equal(s.getSession("permissioned")?.permission_pending, "default")
  s.setCodexInputQueue("permissioned", '[{"text":"hello"}]')
  s.setControlError("permissioned", "existing draft")
  s.close()

  const reopened = createStorage(path)
  assert.equal(reopened.getSession("permissioned")?.permission_mode, "bypassPermissions")
  assert.equal(reopened.getSession("permissioned")?.permission_pending, "default")
  assert.equal(reopened.getSession("permissioned")?.codex_input_queue, '[{"text":"hello"}]')
  assert.equal(reopened.getSession("permissioned")?.control_error, "existing draft")
  reopened.setPermissionPending("permissioned", null)
  assert.equal(reopened.getSession("permissioned")?.permission_pending, null)
  reopened.close()
})

test("manual snooze persists exactly across restart, expires atomically, and Archive clears it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-storage-snooze-"))
  const path = join(dir, "ui.db")
  const exact = "2026-07-14T08:45:12.345Z"
  let s = createStorage(path)
  s.upsertSession(row({ slug: "snoozed", state: "open" }))
  s.setSnoozedUntil("snoozed", exact)
  assert.equal(s.getSession("snoozed")?.snoozed_until, exact)
  s.close()

  s = createStorage(path)
  assert.equal(s.getSession("snoozed")?.snoozed_until, exact, "migration-backed value survives server restart byte-for-byte")
  assert.equal(s.clearExpiredSnoozes("2026-07-14T08:45:12.344Z"), 0)
  assert.equal(s.clearExpiredSnoozes(exact), 1, "the exact deadline is due, not one tick later")
  assert.equal(s.getSession("snoozed")?.snoozed_until, null)

  s.setSnoozedUntil("snoozed", exact)
  s.setState("snoozed", "archived")
  assert.equal(s.getSession("snoozed")?.snoozed_until, null, "Archive is terminal lifecycle state and drops stale snooze")
  s.setState("snoozed", "open")
  assert.equal(s.getSession("snoozed")?.snoozed_until, null, "Reopen never resurrects an old wake deadline")
  s.close()
})

test("awaiting confirmation is atomic, generation-fenced, durable, and cleared by lifecycle changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-storage-awaiting-"))
  const path = join(dir, "ui.db")
  const timer = "2099-07-14T08:45:12.345Z"
  let s = createStorage(path)
  s.upsertSession(row({ slug: "awaiting", session_id: "session-a", state: "open" }))
  const confirmedAt = "2026-07-14T08:00:00.000Z"
  const reconfirmedAt = "2026-07-14T09:00:00.000Z"
  assert.equal(s.confirmAwaitingWait("awaiting", "wrong-session", 0, "fence-a", confirmedAt, timer), false)
  assert.equal(s.confirmAwaitingWait("awaiting", "session-a", 99, "fence-a", confirmedAt, timer), false)
  assert.equal(s.confirmAwaitingWait("awaiting", "session-a", 0, "fence-a", confirmedAt, timer), true)
  assert.deepEqual(
    (({ awaiting_fence_id, awaiting_confirmed_at, snoozed_until }) => ({ awaiting_fence_id, awaiting_confirmed_at, snoozed_until }))(s.getSession("awaiting")!),
    { awaiting_fence_id: "fence-a", awaiting_confirmed_at: confirmedAt, snoozed_until: timer },
  )
  s.close()

  s = createStorage(path)
  assert.equal(s.getSession("awaiting")?.awaiting_fence_id, "fence-a", "confirmation survives restart")
  assert.equal(s.clearAwaitingWaitIfCurrent("awaiting", "session-a", "other-fence"), false)
  assert.equal(s.getSession("awaiting")?.awaiting_fence_id, "fence-a", "a stale scheduler cannot clear the current wait")
  assert.equal(s.clearAwaitingWaitIfCurrent("awaiting", "session-a", "fence-a"), true)
  assert.deepEqual(
    (({ awaiting_fence_id, awaiting_confirmed_at, snoozed_until }) => ({ awaiting_fence_id, awaiting_confirmed_at, snoozed_until }))(s.getSession("awaiting")!),
    { awaiting_fence_id: null, awaiting_confirmed_at: null, snoozed_until: null },
  )

  assert.equal(s.confirmAwaitingWait("awaiting", "session-a", 0, "fence-b", reconfirmedAt, null), true)
  assert.equal(s.setSnoozedUntilIfCurrent("awaiting", "session-a", 99, timer), false)
  assert.equal(s.setSnoozedUntilIfCurrent("awaiting", "session-a", 0, timer), true)
  assert.equal(s.clearAwaitingWaitIfSession("awaiting", "session-a", 99), false)
  assert.equal(s.clearAwaitingWaitIfSession("awaiting", "session-a", 0), true)
  assert.equal(s.confirmAwaitingWait("awaiting", "session-a", 0, "fence-b", reconfirmedAt, null), true)
  s.setState("awaiting", "archived")
  assert.equal(s.getSession("awaiting")?.awaiting_fence_id, null, "archiving cancels the watcher")
  s.setState("awaiting", "open")
  assert.equal(s.confirmAwaitingWait("awaiting", "session-a", 0, "fence-c", reconfirmedAt, null), true)
  assert.equal(s.beginRuntimeGeneration("awaiting", {
    sessionId: "session-a", generation: 0, permissionPending: null, runtimeControl: null,
  }, "2026-07-14T10:00:00.000Z"), 1)
  assert.equal(s.getSession("awaiting")?.awaiting_fence_id, null, "resuming the owner cancels its parked wait")
  assert.equal(s.confirmAwaitingWait("awaiting", "session-a", 1, "fence-d", reconfirmedAt, null), true)
  s.upsertSession(row({ slug: "awaiting", session_id: "session-b", state: "open" }))
  assert.equal(s.getSession("awaiting")?.awaiting_fence_id, null, "a replacement session cannot inherit a prior watcher")
  s.close()
  rmSync(dir, { recursive: true, force: true })
})

test("runtime generations make permission and queue commits compare-and-swap safe", () => {
  const s = store()
  s.upsertSession(row({
    slug: "generation",
    permission_mode: "default",
    permission_pending: "bypassPermissions",
    codex_input_queue: '[{"text":"queued"}]',
  }))

  const initial = s.getSession("generation")!
  assert.equal(initial.runtime_generation, 0)
  const generation = s.beginRuntimeGeneration(
    "generation",
    { sessionId: initial.session_id, generation: 0, permissionPending: "bypassPermissions" },
    "2026-07-01T03:00:00.000Z",
  )
  assert.equal(generation, 1)
  assert.equal(s.getSession("generation")?.spawned_at, "2026-07-01T03:00:00.000Z")

  assert.equal(
    s.setPermissionStateIfCurrent(
      "generation",
      { sessionId: initial.session_id, generation: 0, permissionPending: "bypassPermissions" },
      { permissionMode: "bypassPermissions", permissionPending: null, controlError: null, exited: false },
    ),
    false,
  )
  assert.equal(
    s.setPermissionStateIfCurrent(
      "generation",
      { sessionId: initial.session_id, generation, permissionPending: "bypassPermissions" },
      { permissionMode: "bypassPermissions", permissionPending: null, controlError: null, exited: false },
    ),
    true,
  )
  assert.equal(
    s.setObservedPermissionIfCurrent("generation", initial.session_id, generation, "bypassPermissions"),
    false,
    "an identical observation is a no-op instead of a WAL write",
  )
  assert.equal(
    s.setObservedPermissionIfCurrent("generation", initial.session_id, generation, "default"),
    true,
  )
  assert.equal(s.getSession("generation")?.permission_mode, "default")

  const queue = s.getSession("generation")!.codex_input_queue ?? null
  assert.equal(
    s.setCodexInputQueueIfCurrent(
      "generation",
      { sessionId: initial.session_id, generation: 0, queue },
      null,
    ),
    false,
  )
  assert.equal(s.getSession("generation")?.codex_input_queue, queue)

  const replacement = row({
    slug: "generation",
    session_id: "replacement-owner",
    runtime_generation: 0,
    unread: 0,
    exited: 0,
    rested_at: null,
    transcript_id: null,
    state: "archived",
    archived: 1,
  })
  s.upsertSession(replacement)
  s.setState("generation", "archived")
  assert.equal(s.setUnreadIfCurrent("generation", initial.session_id, generation, true), false)
  assert.equal(s.setExitedIfCurrent("generation", initial.session_id, generation, true), false)
  assert.equal(s.setRestedAtIfCurrent(
    "generation", initial.session_id, generation, "2026-07-01T04:00:00.000Z",
  ), false)
  assert.equal(s.setTranscriptIdIfCurrent("generation", initial.session_id, generation, "stale-transcript"), false)
  assert.equal(s.setStateIfCurrent("generation", initial.session_id, generation, "open"), false)
  assert.deepEqual(
    (({ session_id, unread, exited, rested_at, transcript_id, state, archived }) => ({
      session_id, unread, exited, rested_at, transcript_id, state, archived,
    }))(s.getSession("generation")!),
    {
      session_id: "replacement-owner",
      unread: 0,
      exited: 0,
      rested_at: null,
      transcript_id: null,
      state: "archived",
      archived: 1,
    },
  )
})

test("completeIfCurrent atomically settles one exact runtime generation", () => {
  const s = store()
  try {
    s.upsertSession(row({
      slug: "complete",
      session_id: "complete-owner",
      runtime_generation: 4,
      unread: 1,
      exited: 0,
      state: "open",
      archived: 0,
      snoozed_until: "2026-07-15T09:00:00.000Z",
    }))

    assert.equal(s.completeIfCurrent("complete", "stale-owner", 4), false)
    assert.deepEqual(
      (({ exited, state, archived, unread, snoozed_until }) => ({ exited, state, archived, unread, snoozed_until }))(s.getSession("complete")!),
      { exited: 0, state: "open", archived: 0, unread: 1, snoozed_until: "2026-07-15T09:00:00.000Z" },
      "a CAS miss leaves every lifecycle field untouched",
    )

    assert.equal(s.completeIfCurrent("complete", "complete-owner", 4), true)
    assert.deepEqual(
      (({ exited, state, archived, unread, snoozed_until }) => ({ exited, state, archived, unread, snoozed_until }))(s.getSession("complete")!),
      { exited: 1, state: "archived", archived: 1, unread: 0, snoozed_until: null },
      "one statement makes the terminal lifecycle state internally consistent",
    )
  } finally {
    s.close()
  }
})

test("explicit thread title: replaces the generated fallback, clears title_auto, and survives reopen/resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-storage-title-"))
  const path = join(dir, "ui.db")
  const s = createStorage(path)
  s.upsertSession(row({ slug: "generated-slug", title: "generated-slug", title_auto: 1 }))

  s.setTitle("generated-slug", "Human-readable thread title")
  let saved = s.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0, "a committed human title must never remain eligible for AI-title replacement")

  // Resume paths spread the existing row through the shared upsert; the explicit-title bit must stick.
  s.upsertSession({ ...saved, exited: 0, spawned_at: "2026-07-01T02:00:00.000Z" })
  saved = s.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0)
  s.close()

  const reopened = createStorage(path)
  assert.equal(reopened.getSession("generated-slug")?.title, "Human-readable thread title")
  assert.equal(reopened.getSession("generated-slug")?.title_auto, 0)
  reopened.close()
})

test("conditional AI title commit cannot overwrite a manual rename or replacement session", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-storage-title-cas-"))
  const s = createStorage(join(dir, "ui.db"))
  s.upsertSession(row({ slug: "rename-race", session_id: "old-session", title: "Old title", title_auto: 1 }))
  const expected = { sessionId: "old-session", title: "Old title", titleAuto: 1 }

  s.setTitle("rename-race", "Manual title wins")
  assert.equal(s.setTitleIfCurrent("rename-race", "AI title", expected), false)
  assert.equal(s.getSession("rename-race")?.title, "Manual title wins")

  const manual = s.getSession("rename-race")!
  s.upsertSession({ ...manual, session_id: "replacement-session", title: "Replacement title", title_auto: 1 })
  assert.equal(s.setTitleIfCurrent("rename-race", "AI title", expected), false)
  assert.equal(s.getSession("rename-race")?.title, "Replacement title")
  s.close()
})

test("automatic title CAS persists provenance and rejects manual, native-session, generation, and replacement races", () => {
  const s = store()
  s.upsertSession(row({
    slug: "codex-title",
    session_id: "fray-session",
    runtime_generation: 3,
    title: "raw initial prompt",
    title_auto: 1,
  }))
  // Dispatch intentionally writes backend identity through dedicated setters after the shared upsert.
  s.setBackend("codex-title", "codex")
  s.setAgentSession("codex-title", "codex-native")
  const expected = { sessionId: "fray-session", nativeSessionId: "codex-native", runtimeGeneration: 3 }

  assert.equal(s.setAutoTitleIfCurrent("codex-title", "Useful generated title", expected), true)
  assert.equal(s.getSession("codex-title")?.title, "Useful generated title")
  assert.equal(s.getSession("codex-title")?.title_auto, 1, "automatic provenance stays eligible for a better native title")
  assert.equal(
    s.setAutoTitleIfCurrent("codex-title", "Wrong native", { ...expected, nativeSessionId: "other-native" }),
    false,
  )
  assert.equal(
    s.setAutoTitleIfCurrent("codex-title", "Old generation", { ...expected, runtimeGeneration: 2 }),
    false,
  )

  s.setTitle("codex-title", "Manual title wins")
  assert.equal(s.setAutoTitleIfCurrent("codex-title", "Late generated title", expected), false)
  assert.equal(s.getSession("codex-title")?.title, "Manual title wins")

  s.upsertSession(row({
    slug: "codex-title",
    session_id: "replacement-session",
    runtime_generation: 0,
    title: "Replacement fallback",
    title_auto: 1,
  }))
  s.setAgentSession("codex-title", "replacement-native")
  assert.equal(s.setAutoTitleIfCurrent("codex-title", "Old transcript title", expected), false)
  assert.equal(s.getSession("codex-title")?.title, "Replacement fallback")
  s.close()
})

test("forgetSession: DELETEs the row and returns it; the slug is gone", () => {
  const s = store()
  s.upsertSession(row({ slug: "phantom", session_id: "sid-1" }))
  assert.ok(s.getSession("phantom"), "row exists before forget")

  const forgotten = s.forgetSession("phantom")
  assert.equal(forgotten?.slug, "phantom")
  assert.equal(forgotten?.session_id, "sid-1")
  assert.equal(s.getSession("phantom"), undefined, "the row is hard-deleted")
  assert.equal(s.allSessions().length, 0)
})

test("forgetSession: tombstones session_id AND any discovered transcript_id", () => {
  const s = store()
  s.upsertSession(row({ slug: "drifted", session_id: "sid-2", transcript_id: "drifted-transcript" }))
  s.forgetSession("drifted")
  const tombs = s.forgottenIds()
  assert.ok(tombs.has("sid-2"), "the pinned session id is tombstoned")
  assert.ok(tombs.has("drifted-transcript"), "the discovered transcript id is tombstoned")
})

test("forgetSession: no transcript_id → only the session id is tombstoned", () => {
  const s = store()
  s.upsertSession(row({ slug: "plain", session_id: "sid-3" }))
  s.forgetSession("plain")
  assert.deepEqual([...s.forgottenIds()], ["sid-3"])
})

test("forgetSession: idempotent — forgetting an absent/already-forgotten slug is a no-op", () => {
  const s = store()
  assert.equal(s.forgetSession("never-existed"), undefined)
  s.upsertSession(row({ slug: "once", session_id: "sid-4" }))
  s.forgetSession("once")
  // A second forget finds no row and adds no new tombstone (the first one stays).
  assert.equal(s.forgetSession("once"), undefined)
  assert.deepEqual([...s.forgottenIds()], ["sid-4"])
})

test("forgetSession: a fresh re-dispatch of the same slug (NEW session_id) is unaffected by the tombstone", () => {
  const s = store()
  s.upsertSession(row({ slug: "reused", session_id: "old-sid" }))
  s.forgetSession("reused")
  // Re-dispatch reuses the freed slug with a brand-new session id — the row comes back, and the old
  // session id stays tombstoned (harmless: nothing points at it).
  s.upsertSession(row({ slug: "reused", session_id: "new-sid" }))
  assert.equal(s.getSession("reused")?.session_id, "new-sid")
  const tombs = s.forgottenIds()
  assert.ok(tombs.has("old-sid"))
  assert.ok(!tombs.has("new-sid"), "the live session's id is never tombstoned")
})
