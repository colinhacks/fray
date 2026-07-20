import type { BoardManager } from "./board.ts"
import type {
  ProfileChangeExpectation,
  ProfileHandoffBinding,
  ProfileHandoffJournal,
  SessionRow,
  Storage,
} from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import * as tmux from "./tmux.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import {
  inspectClaudeComposer,
  inspectCodexComposer,
  parseCodexInputQueue,
  type PermissionTerminal,
} from "./permission-controller.ts"
import { validateThreadProfile } from "./backend/thread-profiles.ts"
import { parseProfileHandoffJournal } from "./profile-handoff.ts"
import type { ProfileReattachCheckpoint } from "./resume.ts"

const POLL_MS = 750
const RECOVERY_GRACE_MS = 5_000

class PersistedProfileControlError extends Error {}

export interface ProfileRecoveryObservation {
  telemetry?: SessionTelemetry
  currentTargetObservation: boolean
}

export type ProfileRecoveryResult =
  | { outcome: "target-ready" }
  | { outcome: "rollback-ready"; error: string }
  | { outcome: "blocked"; error: string }

export interface ProfileController {
  request(slug: string, profile: { model: string; effort: string }): Promise<{ effect: "applied" | "next-resume" }>
  tick(): void
  start(): void
  stop(): void
}

interface ProfileControllerDeps {
  storage: Storage
  tailer: Tailer
  board: BoardManager
  terminal?: PermissionTerminal
  reattach?: (
    slug: string,
    current: { model: string; effort: string },
    requested: { model: string; effort: string },
    onGeneration?: (generation: number) => void,
    onCheckpoint?: (checkpoint: ProfileReattachCheckpoint) => void,
  ) => Promise<{ generation: number; outcome: "target-ready" | "rollback-ready"; error?: string }>
  recover?: (
    row: SessionRow,
    journal: ProfileHandoffJournal,
    observation: ProfileRecoveryObservation,
  ) => Promise<ProfileRecoveryResult>
  now?: () => number
}

export function createProfileController(deps: ProfileControllerDeps): ProfileController {
  const terminal: PermissionTerminal = deps.terminal ?? {
    isLive: tmux.isLive,
    paneIdentity: tmux.paneIdentity,
    capturePane: tmux.capturePane,
    capturePaneEscaped: tmux.capturePaneEscaped,
    sendLiteral: tmux.sendLiteral,
    sendKey: tmux.sendKey,
    findExpectedAdoptionPane: tmux.findExpectedAdoptionPane,
    captureExpectedAdoptionPane: tmux.captureExpectedAdoptionPane,
    sendTextToExpectedAdoptionPane: tmux.sendTextToExpectedAdoptionPane,
    sendKeyToExpectedAdoptionPane: tmux.sendKeyToExpectedAdoptionPane,
  }
  const now = deps.now ?? Date.now
  const active = new Set<string>()
  let timer: NodeJS.Timeout | null = null

  type RuntimeState = "live" | "absent" | "conflict" | "unavailable"

  function runtimeState(row: SessionRow): RuntimeState {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return "conflict"
    if (binding.kind === "unbound") return terminal.isLive(row.slug) ? "live" : "absent"
    const current = terminal.findExpectedAdoptionPane?.(binding.claim)
    if (!current || current.kind === "unknown") return "unavailable"
    return current.kind === "found" && !current.pane.dead ? "live" : "absent"
  }

  function captureOwned(row: SessionRow, escaped: boolean): string | undefined {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return undefined
    if (binding.kind === "unbound") {
      if (!terminal.isLive(row.slug)) return undefined
      return escaped ? terminal.capturePaneEscaped(row.slug) : terminal.capturePane(row.slug)
    }
    const captured = terminal.captureExpectedAdoptionPane?.(binding.claim, escaped)
    return captured?.kind === "captured" ? captured.text : undefined
  }

  function exactCurrentBinding(row: SessionRow): ProfileHandoffBinding | null {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return null
    if (binding.kind === "bound") {
      const found = terminal.findExpectedAdoptionPane?.(binding.claim)
      if (!found || found.kind !== "found" || found.pane.dead) return null
      return {
        kind: "adopted",
        paneId: found.pane.paneId,
        panePid: found.pane.panePid,
        sessionCreated: found.pane.sessionCreated,
        adoptionAttemptToken: binding.claim.attempt_token,
      }
    }
    const pane = terminal.paneIdentity?.(row.slug)
    if (!pane || !terminal.isLive(row.slug)) return null
    return { kind: "standalone", ...pane }
  }

  function expectation(
    row: SessionRow,
    profile: { model: string; effort: string },
    owned: { profileRevision: number; controlRevision: number; profileHandoff: string },
    generation = row.runtime_generation ?? 0,
  ): ProfileChangeExpectation {
    return {
      sessionId: row.session_id,
      nativeSessionId: row.agent_session_id ?? null,
      generation,
      profileRevision: owned.profileRevision,
      controlRevision: owned.controlRevision,
      model: profile.model,
      effort: profile.effort,
      profileHandoff: owned.profileHandoff,
    }
  }

  function expectedFromRow(row: SessionRow): ProfileChangeExpectation | null {
    const model = row.profile_pending_model?.trim()
    const effort = row.profile_pending_effort?.trim()
    const profileHandoff = row.profile_handoff
    if (!model || !effort || !profileHandoff) return null
    return {
      sessionId: row.session_id,
      nativeSessionId: row.agent_session_id ?? null,
      generation: row.runtime_generation ?? 0,
      profileRevision: row.profile_revision ?? 0,
      controlRevision: row.runtime_control_revision ?? 0,
      model,
      effort,
      profileHandoff,
    }
  }

  function block(row: SessionRow, message: string): void {
    const expected = expectedFromRow(row)
    if (expected) deps.storage.blockProfileChange(row.slug, expected, message.slice(0, 240))
    else deps.storage.setControlErrorIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, message.slice(0, 240))
    deps.board.refresh()
  }

  async function request(
    slug: string,
    requested: { model: string; effort: string },
  ): Promise<{ effect: "applied" | "next-resume" }> {
    let row = deps.storage.getSession(slug)
    if (!row) throw new Error(`no session registered for ${slug}`)
    validateThreadProfile(row.backend, requested.model, requested.effort)
    if (row.runtime_control !== null && row.runtime_control !== undefined ||
        row.profile_pending_model !== null && row.profile_pending_model !== undefined ||
        row.profile_pending_effort !== null && row.profile_pending_effort !== undefined) {
      throw new Error("Another runtime profile/control change is already in progress for this thread")
    }

    const initialRuntime = runtimeState(row)
    if (initialRuntime === "conflict" || initialRuntime === "unavailable") {
      throw new Error("This thread's exact runtime identity is unavailable; its profile was not changed")
    }
    if (initialRuntime === "absent") {
      const saved = deps.storage.setProfileTargetIfCurrent(slug, {
        sessionId: row.session_id,
        nativeSessionId: row.agent_session_id ?? null,
        generation: row.runtime_generation ?? 0,
      }, requested)
      if (!saved) throw new Error("This thread changed while its next-resume profile was being saved; retry")
      deps.board.refresh()
      return { effect: "next-resume" }
    }

    const current = { model: row.model?.trim() ?? "", effort: row.effort?.trim() ?? "" }
    validateThreadProfile(row.backend, current.model, current.effort)
    if (current.model === requested.model && current.effort === requested.effort) {
      deps.storage.setControlErrorIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, null)
      deps.board.refresh()
      return { effect: "applied" }
    }

    // All ordinary busy/draft checks happen before the durable handoff is armed. Once armed, no path
    // may clear ownership without exact runtime proof.
    deps.tailer.tick()
    row = deps.storage.getSession(slug)
    if (!row || runtimeState(row) !== "live") throw new Error("The worker changed while its profile was being prepared; nothing was changed")
    const tele = deps.tailer.get(slug)
    if (!tele) throw new Error("Runtime state is still loading; retry in a moment")
    if (tele.permPrompt || tele.pendingAsk || tele.nativeInputRequired) {
      throw new Error("Resolve the current terminal approval or question before changing model or effort")
    }
    if (tele.turn !== "idle") throw new Error("Model and effort changes require an idle thread; wait for the current turn to finish")
    const unresolved = [...tele.subAgents, ...tele.bgShells].filter((op) => op.state === "running" || op.state === "stale").length
    if (unresolved > 0) throw new Error(`Model and effort changes require no unresolved background work; wait for ${unresolved} operation${unresolved === 1 ? "" : "s"}`)
    const queue = parseCodexInputQueue(row.codex_input_queue)
    if (!queue.valid || queue.items.length > 0) throw new Error("Queued or ambiguous Codex input must finish before changing model or effort")
    const composer = row.backend === "codex"
      ? inspectCodexComposer(captureOwned(row, true) ?? "")
      : inspectClaudeComposer(captureOwned(row, false) ?? "")
    if (composer.kind === "typed") throw new Error(`Profile change blocked: submit or clear the existing ${row.backend === "codex" ? "Codex" : "Claude"} terminal draft`)
    if (composer.kind !== "empty") throw new Error("Profile change blocked by the current terminal screen; return it to the idle prompt")
    if (!deps.reattach) throw new Error("Live profile changes are unavailable in this Fray server; restart Fray and retry")
    const priorBinding = exactCurrentBinding(row)
    if (!priorBinding) throw new Error("The current worker's exact pane identity could not be journaled; nothing was changed")

    let journal: ProfileHandoffJournal = {
      version: 1,
      phase: "armed",
      nativeSessionId: row.agent_session_id ?? row.session_id,
      previous: { ...current, binding: priorBinding },
      requested: { ...requested },
    }
    const armed = deps.storage.armProfileChange(slug, {
      sessionId: row.session_id,
      nativeSessionId: row.agent_session_id ?? null,
      generation: row.runtime_generation ?? 0,
    }, requested, journal)
    if (!armed) throw new Error("This thread changed or another runtime control started; its profile was not changed")
    active.add(slug)
    let expected = expectation(row, requested, armed)
    deps.board.refresh()
    try {
      const result = await deps.reattach(
        slug,
        current,
        requested,
        (generation) => { expected = { ...expected, generation } },
        (checkpoint) => {
          const binding = checkpoint.identity ? {
            kind: checkpoint.adoptionAttemptToken ? "adopted" as const : "standalone" as const,
            ...checkpoint.identity,
            ...(checkpoint.adoptionAttemptToken ? { adoptionAttemptToken: checkpoint.adoptionAttemptToken } : {}),
            handoffToken: checkpoint.handoffToken,
          } : undefined
          const leg = { generation: checkpoint.generation, handoffToken: checkpoint.handoffToken, ...(binding ? { binding } : {}) }
          journal = checkpoint.phase.startsWith("target")
            ? { ...journal, phase: checkpoint.phase, target: leg }
            : { ...journal, phase: checkpoint.phase, rollback: leg }
          const serialized = deps.storage.checkpointProfileChange(slug, expected, journal)
          if (!serialized) throw new Error("Profile handoff journal ownership changed before its runtime checkpoint")
          expected = { ...expected, generation: checkpoint.generation, profileHandoff: serialized }
        },
      )
      const currentRow = deps.storage.getSession(slug)
      if (!currentRow) throw new Error("Profile change canceled because the thread was deleted")
      expected = expectedFromRow(currentRow) ?? expected
      if (result.outcome === "rollback-ready") {
        const message = result.error ?? "Profile change failed; the previous profile was restored"
        if (!deps.storage.restoreProfileChange(slug, expected, journal.previous, message.slice(0, 240))) {
          throw new Error("The previous profile returned, but its durable recovery commit lost ownership")
        }
        deps.board.refresh()
        throw new PersistedProfileControlError(message)
      }
      if (!deps.storage.commitProfileChange(slug, expected)) {
        throw new Error("Profile change canceled because this process generation no longer owns the thread")
      }
      deps.board.refresh()
      return { effect: "applied" }
    } catch (error) {
      if (error instanceof PersistedProfileControlError) throw error
      const message = error instanceof Error ? error.message : String(error)
      const currentRow = deps.storage.getSession(slug)
      if (currentRow?.runtime_control === "profile") block(currentRow, `Profile handoff is locked for exact restart recovery: ${message}`)
      throw new Error(message)
    } finally {
      active.delete(slug)
    }
  }

  async function recoverOne(row: SessionRow): Promise<void> {
    try {
      const journal = parseProfileHandoffJournal(row.profile_handoff)
      if (!journal || journal.nativeSessionId !== (row.agent_session_id ?? row.session_id)) {
        block(row, "Profile handoff journal is invalid; sends remain blocked. Restart Fray after preserving the state database for recovery")
        return
      }
      if (!deps.recover) {
        block(row, "Profile handoff recovery is unavailable; sends remain blocked until Fray is restarted with runtime recovery support")
        return
      }
      const tele = deps.tailer.get(row.slug)
      const observedAt = tele?.profileAt ? Date.parse(tele.profileAt) : NaN
      const spawnedAt = Date.parse(row.spawned_at)
      const currentTargetObservation = tele?.model === journal.requested.model && tele?.effort === journal.requested.effort &&
        Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt
      const result = await deps.recover(row, journal, { telemetry: tele, currentTargetObservation })
      const current = deps.storage.getSession(row.slug)
      if (!current || current.runtime_control !== "profile") return
      const currentJournal = parseProfileHandoffJournal(current.profile_handoff)
      const expected = expectedFromRow(current)
      if (!currentJournal || !expected) {
        block(current, "Profile recovery lost its durable journal; sends remain blocked")
        return
      }
      if (result.outcome === "target-ready") {
        if (currentJournal.phase !== "target-ready" || !deps.storage.commitProfileChange(current.slug, expected)) {
          block(current, "The exact target runtime was proven, but its atomic profile commit lost ownership; sends remain blocked")
          return
        }
        deps.board.refresh()
        return
      }
      if (result.outcome === "rollback-ready") {
        if (currentJournal.phase !== "rollback-ready" || !deps.storage.restoreProfileChange(
          current.slug,
          expected,
          currentJournal.previous,
          result.error.slice(0, 240),
        )) {
          block(current, "The prior runtime was proven, but its atomic restore commit lost ownership; sends remain blocked")
          return
        }
        deps.board.refresh()
        return
      }
      block(current, result.error)
    } catch (error) {
      const current = deps.storage.getSession(row.slug)
      if (current?.runtime_control === "profile") block(current, `Profile recovery remains locked: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      active.delete(row.slug)
    }
  }

  function tick(): void {
    for (const row of deps.storage.allSessions()) {
      if (row.runtime_control !== "profile" || active.has(row.slug)) continue
      const spawnedAt = Date.parse(row.spawned_at)
      if (Number.isFinite(spawnedAt) && now() - spawnedAt < RECOVERY_GRACE_MS) continue
      active.add(row.slug)
      void recoverOne(row)
    }
  }

  return {
    request,
    tick,
    start() {
      if (timer) return
      tick()
      timer = setInterval(tick, POLL_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
