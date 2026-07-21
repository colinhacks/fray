import { writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import {
  PermissionMode,
  type PermissionMode as PermissionModeValue,
  type Settings,
} from "@fray-ui/shared"
import { PERM_DIR_ENV, permRequestDir, type Project } from "./project.ts"
import type {
  ProfileChangeExpectation,
  ProfileHandoffBinding,
  ProfileHandoffJournal,
  SessionRow,
  Storage,
} from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { AgentBackend } from "./backend/types.ts"
import { ensureCwdTrusted } from "./backend/codex.ts"
import { inspectClaudeComposer, inspectCodexComposer, parseCodexInputQueue } from "./permission-controller.ts"
import {
  buildClaudeResumeCommand,
  claudeWorkerEnvironment,
  effectivePermissionMode,
  workerPluginDir,
  scratchpadOrientation,
  frayConfigBlock,
  loadWorkerPrompt,
} from "./dispatch.ts"
import * as tmux from "./tmux.ts"
import type { PaneIdentity } from "./tmux.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  abandonAdoptionAttempt,
  adoptionRuntimeBinding,
  type AdoptionRecoveryRuntime,
} from "./adoption-recovery.ts"
import type { ProfileRecoveryObservation, ProfileRecoveryResult } from "./profile-controller.ts"

/**
 * A follow-up/wake that cannot be delivered AND must not be retried. Raised when a live worker owns
 * this conversation on a legacy socket but its exact identity could not be confirmed for safe
 * injection, so spawning a duplicate is refused. The identity verdict is stable — retrying only defers
 * a silent exhaustion — so the wakers scheduler abandons the outbox item terminally (surfacing the
 * reason) rather than burning every delivery attempt. The `terminalDelivery` marker is duck-typed so
 * the scheduler need not import this module (it receives `resume` by injection).
 */
export class TerminalDeliveryError extends Error {
  readonly terminalDelivery = true
  constructor(message: string) {
    super(message)
    this.name = "TerminalDeliveryError"
  }
}

// The ONE resume/steer path, shared by the followUp RPC (a human steer) and the wakers scheduler (a
// fired machine-wait). Kept in its own module so the scheduler can reuse it without importing the RPC
// router. Live session → inject into the running claude (paste-buffer for multiline so newlines
// survive, literal send-keys for a single line). DEAD session → resume the pinned conversation
// (`claude -r <sessionId>`) in a fresh tmux session of the same name, killing the dead remain-on-exit
// pane first and re-carrying the scratchpad orientation at SYSTEM level (the resume rebuilds the system
// prompt from scratch, so without this the worker forgets its scratchpad). Throws if no row exists.

// The tmux surface resumeThread touches — injectable so tests exercise the un-archive/section logic
// without a real tmux server (mirrors dispatch.ts's `spawn?` injection). Defaults to the real module.
export interface ResumeTmux {
  isLive(slug: string): boolean
  // Checked only after the active socket reports dead and before any name-kill/spawn. It closes the
  // migration hole where a legacy socket still owns a live same-slug worker.
  crossSocketLiveOwner?(slug: string, project: { id: string; dir: string }): tmux.CrossSocketOwner
  findCompatibleLegacyWorker?(slug: string, project: { id: string; dir: string }, nativeSessionId: string, backend?: string): tmux.CompatibleLegacyWorkerLookup
  captureCompatibleLegacyWorker?(worker: tmux.CompatibleLegacyWorker, escaped?: boolean): tmux.ExactPaneCapture
  sendTextToCompatibleLegacyWorker?(worker: tmux.CompatibleLegacyWorker, text: string): boolean
  // Optional only for narrow test doubles. Production binds the full tmux identity; PID alone is
  // retained for older focused doubles but is never the production ownership proof.
  paneIdentity?(slug: string): PaneIdentity | null
  lookupAdoptionPane?(slug: string): tmux.AdoptionPaneLookup
  findAdoptionPane?(attemptToken: string): tmux.AdoptionPaneLookup
  findPaneIdentity?(identity: PaneIdentity): tmux.AdoptionPaneLookup
  findExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane): tmux.AdoptionPaneLookup
  findProfileHandoffPane?(handoffToken: string): tmux.AdoptionPaneLookup
  captureExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, escaped?: boolean): tmux.ExactPaneCapture
  captureExpectedProfileHandoffPane?(expected: tmux.ExpectedProfileHandoffPane, escaped?: boolean): tmux.ExactPaneCapture
  panePid?(slug: string): number | null
  capturePane?(slug: string): string
  capturePaneEscaped?(slug: string): string
  pasteText(slug: string, text: string): void
  sendKeys(slug: string, text: string): void
  sendTextToExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, text: string, submit: boolean): boolean
  killExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane): boolean
  killExpectedProfileHandoffPane?(expected: tmux.ExpectedProfileHandoffPane): boolean
  killPane?(identity: PaneIdentity): void
  killSession(slug: string): void
  ensureServer(): void
  spawn(
    slug: string,
    cmd: string[],
    cwd: string,
    env?: Record<string, string>,
    options?: tmux.TmuxSpawnOptions,
  ): PaneIdentity | void
}

export interface ResumeDeps {
  project: Project
  storage: Storage
  board: BoardManager
  getSettings: () => Settings
  tmux?: ResumeTmux // injectable for tests; defaults to the real tmux module
  // Per-session agent-backend resolver that builds the dead-session resume argv (Codex-support epic).
  // Injected by the composition layer; when absent (tests) resume falls back to the local Claude resume
  // builder. Resolved by the row's `backend` column so a codex row resumes via `codex resume`.
  backendFor?: (kind?: string) => AgentBackend
  // $CODEX_HOME override for the codex trust pre-arm (tests inject a tmp dir); unset → the codex default
  // (~/.codex), matching the CodexBackend the composition layer built.
  codexHome?: string
  // Tests can replace the bounded post-spawn liveness probe. Production waits across a short
  // stability window so a CLI that rejects its resume/auth arguments cannot masquerade as applied.
  permissionReady?: (slug: string) => Promise<boolean>
}

function permissionModeForRow(row: SessionRow, settings: Settings): PermissionModeValue {
  const pending = PermissionMode.safeParse(row.permission_pending)
  if (pending.success) return effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", pending.data)
  const saved = PermissionMode.safeParse(row.permission_mode)
  const requested = saved.success ? saved.data : settings.permissionMode
  return effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", requested)
}

export function hasUnconfirmedCodexSubmission(row: Pick<SessionRow, "backend" | "codex_input_queue">): boolean {
  if (row.backend !== "codex" || !row.codex_input_queue) return false
  const parsed = parseCodexInputQueue(row.codex_input_queue)
  return !parsed.valid || parsed.items.some((item) => item.state === "submitted")
}

// Build + spawn the backend-native resume invocation. `message` omitted means REATTACH ONLY: open the
// saved conversation at an idle prompt without fabricating a user message or starting an agent turn.
function spawnPinnedSession(
  deps: ResumeDeps,
  tx: ResumeTmux,
  row: SessionRow,
  permissionMode: PermissionModeValue,
  message?: string,
  options?: tmux.TmuxSpawnOptions,
  launchProfile?: { model: string; effort: string },
  profileHandoffToken?: string,
): PaneIdentity | void {
  const backend = deps.backendFor?.(row.backend)
  const nativeSessionId = row.agent_session_id ?? row.session_id
  const extraSystemPrompt = [scratchpadOrientation(row.session_id, row.plan_path, backend?.kind), frayConfigBlock(deps.project.dir)].filter(Boolean).join("\n\n")
  // The runtimeGate toggle must survive resume/wake/reattach: rebuild the SAME gated worker contract
  // dispatch produced and re-set the env the session-seed hook reads — otherwise an opted-out project
  // would silently get the RUNTIME RELEASE GATE forced back on the moment its worker respawns.
  const runtimeGate = deps.getSettings().runtimeGate !== false
  if (row.backend === "codex") ensureCwdTrusted(deps.project.dir, deps.codexHome)
  const built = backend
    ? backend.buildResume({
        sessionId: nativeSessionId,
        cwd: deps.project.dir,
        message,
        workerContract: loadWorkerPrompt(backend.kind, runtimeGate),
        extraSystemPrompt,
        permissionMode,
        model: launchProfile?.model ?? row.model ?? undefined,
        effort: launchProfile?.effort ?? row.effort ?? undefined,
      })
    : {
        argv: buildClaudeResumeCommand({
          sessionId: nativeSessionId,
          permissionMode,
          message,
          pluginDir: workerPluginDir(),
          extraSystemPrompt,
          model: launchProfile?.model ?? row.model ?? undefined,
          effort: launchProfile?.effort ?? row.effort ?? undefined,
          workerPrompt: loadWorkerPrompt("claude", runtimeGate),
        }),
        env: claudeWorkerEnvironment(),
        prewrite: [],
      }
  for (const f of built.prewrite) writeFileSync(f.path, f.contents)
  return tx.spawn(row.slug, built.argv, deps.project.dir, {
    ...built.env,
    FRAY_UI_THREAD: row.slug,
    [PERM_DIR_ENV]: permRequestDir(deps.project),
    ...(profileHandoffToken ? { [tmux.PROFILE_HANDOFF_ENV]: profileHandoffToken } : {}),
  }, options)
}

export type ProfileReattachPhase =
  | "target-starting" | "target-spawned" | "target-ready"
  | "rollback-starting" | "rollback-spawned" | "rollback-ready"

export interface ProfileReattachCheckpoint {
  phase: ProfileReattachPhase
  generation: number
  handoffToken: string
  identity?: PaneIdentity
  adoptionAttemptToken?: string
}

interface ProfileTransition {
  current: { model: string; effort: string }
  requested: { model: string; effort: string }
  onCheckpoint?: (checkpoint: ProfileReattachCheckpoint) => void
  rollbackOnFailure?: boolean
}

type PermissionProcessProbe = "ready" | "exited" | "replaced" | "unready"

function samePaneIdentity(a: PaneIdentity | undefined, b: PaneIdentity | null | undefined): boolean {
  if (!a || !b) return a === undefined && b === undefined
  return a.paneId === b.paneId && a.panePid === b.panePid && a.sessionCreated === b.sessionCreated
}

async function permissionProcessStayedLive(
  deps: ResumeDeps,
  tx: ResumeTmux,
  row: SessionRow,
  expectedIdentity: PaneIdentity | undefined,
  expectedPanePid: number | undefined,
  expectedAdoption?: tmux.ExpectedAdoptionPane,
): Promise<PermissionProcessProbe> {
  const adoptionState = (): PermissionProcessProbe | "live" => {
    if (!expectedAdoption) return "live"
    const found = tx.findExpectedAdoptionPane?.(expectedAdoption)
    if (!found || found.kind === "unknown") return "replaced"
    if (found.kind === "absent" || found.pane.dead) return "exited"
    return "live"
  }
  if (deps.permissionReady) {
    if (!(await deps.permissionReady(row.slug))) return "exited"
    const exact = adoptionState()
    if (exact !== "live") return exact
    if (!expectedAdoption && expectedIdentity && !samePaneIdentity(expectedIdentity, tx.paneIdentity?.(row.slug))) return "replaced"
    if (!expectedAdoption && !expectedIdentity && expectedPanePid !== undefined && tx.panePid?.(row.slug) !== expectedPanePid) return "replaced"
    return "ready"
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    await delay(250)
    const exact = adoptionState()
    if (exact !== "live") return exact
    if (!expectedAdoption) {
      if (!tx.isLive(row.slug)) return "exited"
      if (expectedIdentity && !samePaneIdentity(expectedIdentity, tx.paneIdentity?.(row.slug))) return "replaced"
      if (!expectedIdentity && expectedPanePid !== undefined && tx.panePid?.(row.slug) !== expectedPanePid) return "replaced"
    }
    const exactCapture = expectedAdoption
      ? tx.captureExpectedAdoptionPane?.(expectedAdoption, row.backend === "codex")
      : undefined
    if (expectedAdoption && exactCapture?.kind !== "captured") return "replaced"
    const paneText = exactCapture?.kind === "captured" ? exactCapture.text : undefined
    const composer = row.backend === "codex"
      ? inspectCodexComposer(expectedAdoption ? paneText! : tx.capturePaneEscaped?.(row.slug) ?? "")
      : inspectClaudeComposer(expectedAdoption ? paneText! : tx.capturePane?.(row.slug) ?? "")
    if (composer.kind === "empty") return "ready"
  }
  return "unready"
}

class PermissionHandoffAbortedError extends Error {}
class ProfileCheckpointAbortedError extends Error {}

function emitProfileCheckpoint(profiles: ProfileTransition | undefined, checkpoint: ProfileReattachCheckpoint): void {
  if (!profiles?.onCheckpoint) return
  try {
    profiles.onCheckpoint(checkpoint)
  } catch (error) {
    throw new ProfileCheckpointAbortedError(error instanceof Error ? error.message : String(error))
  }
}

function assertPermissionGenerationCurrent(
  deps: ResumeDeps,
  row: SessionRow,
  generation: number,
  pending: string | null,
  runtimeControl: string | null,
): SessionRow {
  const current = deps.storage.getSession(row.slug)
  if (
    !current ||
    current.session_id !== row.session_id ||
    (current.runtime_generation ?? 0) !== generation ||
    (current.permission_pending ?? null) !== pending ||
    (current.runtime_control ?? null) !== runtimeControl
  ) {
    throw new PermissionHandoffAbortedError("Permission change canceled because this thread or process generation was deleted or replaced during startup")
  }
  return current
}

function spawnedPaneIdentity(tx: ResumeTmux, slug: string): PaneIdentity | undefined {
  if (!tx.paneIdentity) return undefined
  const identity = tx.paneIdentity(slug)
  if (!identity) throw new PermissionHandoffAbortedError("Permission change canceled because the resumed worker pane identity was not available")
  return identity
}

function spawnedPanePid(tx: ResumeTmux, slug: string, identity: PaneIdentity | undefined): number | undefined {
  if (identity) return identity.panePid
  if (!tx.panePid) return undefined
  const pid = tx.panePid(slug)
  if (pid === null) throw new Error("the resumed worker pane was not created")
  return pid
}

function assertPaneStillCurrent(
  tx: ResumeTmux,
  slug: string,
  expectedIdentity: PaneIdentity | undefined,
  expectedPanePid: number | undefined,
): void {
  if (expectedIdentity && !samePaneIdentity(expectedIdentity, tx.paneIdentity?.(slug))) {
    throw new PermissionHandoffAbortedError("Permission change canceled because another worker process replaced this thread during startup")
  }
  if (!expectedIdentity && expectedPanePid !== undefined && tx.panePid?.(slug) !== expectedPanePid) {
    throw new PermissionHandoffAbortedError("Permission change canceled because another worker process replaced this thread during startup")
  }
}

function killCapturedPane(tx: ResumeTmux, slug: string, identity: PaneIdentity | undefined): void {
  if (identity && tx.killPane) {
    tx.killPane(identity)
    return
  }
  tx.killSession(slug)
}

function commitPermissionRuntime(
  deps: ResumeDeps,
  row: SessionRow,
  generation: number,
  expectedPending: string | null,
  permissionMode: PermissionModeValue,
  permissionPending: PermissionModeValue | null,
  exited: boolean,
  runtimeControl: string | null,
): void {
  if (!deps.storage.setPermissionStateIfCurrent(row.slug, {
    sessionId: row.session_id,
    generation,
    permissionPending: expectedPending,
    runtimeControl,
  }, {
    exited,
    permissionMode,
    permissionPending,
    controlError: null,
  })) {
    throw new PermissionHandoffAbortedError("Permission change canceled because this thread or process generation was deleted or replaced during startup")
  }
}

// Change a live standalone TUI's launch-time permission profile without fabricating a user turn.
// Callers must first prove the conversation is idle, has no running children, and has an empty native
// composer. Neither backend exposes a supported control channel for mutating an arbitrary live TUI;
// reopening the persisted conversation with its documented CLI flag is the truthful, deterministic
// transition. A failed target launch immediately restores the prior mode.
export function reattachThreadWithPermission(
  deps: ResumeDeps,
  slug: string,
  current: PermissionModeValue,
  requested: PermissionModeValue,
  onGeneration?: (generation: number) => void,
): Promise<{ generation: number }> {
  return reattachThreadWithPermissionAsync(deps, slug, current, requested, onGeneration)
}

export function reattachThreadWithProfile(
  deps: ResumeDeps,
  slug: string,
  current: { model: string; effort: string },
  requested: { model: string; effort: string },
  onGeneration?: (generation: number) => void,
  onCheckpoint?: (checkpoint: ProfileReattachCheckpoint) => void,
): Promise<{ generation: number; outcome: "target-ready" | "rollback-ready"; error?: string }> {
  const row = deps.storage.getSession(slug)
  if (!row) throw new Error(`no session registered for ${slug}`)
  const permission = permissionModeForRow(row, deps.getSettings())
  let lastCheckpoint: ProfileReattachCheckpoint | undefined
  return reattachThreadWithPermissionAsync(
    deps,
    slug,
    permission,
    permission,
    onGeneration,
    { current, requested, onCheckpoint: (checkpoint) => {
      onCheckpoint?.(checkpoint)
      lastCheckpoint = checkpoint
    } },
  ).then((result) => ({ ...result, outcome: "target-ready" as const })).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (lastCheckpoint?.phase === "rollback-ready") {
      return { generation: lastCheckpoint.generation, outcome: "rollback-ready" as const, error: message }
    }
    throw new Error(message.replaceAll("Permission change", "Profile change").replaceAll("Permission rollback", "Profile rollback"))
  })
}

async function reattachAdoptedThreadWithPermission(
  deps: ResumeDeps,
  tx: ResumeTmux,
  row: SessionRow,
  initialClaim: import("./storage.ts").AdoptionClaimRow,
  current: PermissionModeValue,
  requested: PermissionModeValue,
  onGeneration?: (generation: number) => void,
  profiles?: ProfileTransition,
): Promise<{ generation: number }> {
  const runtime = tx.lookupAdoptionPane && tx.findAdoptionPane && tx.findPaneIdentity &&
      tx.findExpectedAdoptionPane && tx.captureExpectedAdoptionPane && tx.killExpectedAdoptionPane
    ? {
        lookupAdoptionPane: tx.lookupAdoptionPane,
        findAdoptionPane: tx.findAdoptionPane,
        findPaneIdentity: tx.findPaneIdentity,
        killExpectedAdoptionPane: tx.killExpectedAdoptionPane,
      } satisfies AdoptionRecoveryRuntime
    : undefined
  if (!runtime || !tx.findExpectedAdoptionPane || !tx.captureExpectedAdoptionPane || !tx.killExpectedAdoptionPane) {
    throw new Error("The adopted worker's exact runtime controls are unavailable; permissions were not changed")
  }

  const initial = tx.findExpectedAdoptionPane(initialClaim)
  if (initial.kind !== "found" || initial.pane.dead) {
    throw new Error("The adopted worker's exact runtime identity is unavailable; permissions were not changed")
  }
  const expectedPending = row.permission_pending ?? null
  const expectedRuntimeControl = row.runtime_control ?? null
  const targetGeneration = deps.storage.beginRuntimeGeneration(
    row.slug,
    {
      sessionId: row.session_id,
      generation: row.runtime_generation ?? 0,
      permissionPending: expectedPending,
      runtimeControl: expectedRuntimeControl,
    },
    new Date().toISOString(),
  )
  if (targetGeneration === null) {
    throw new PermissionHandoffAbortedError("Permission change canceled because this thread or process generation was replaced before startup")
  }
  let ownedGeneration = targetGeneration
  onGeneration?.(ownedGeneration)
  const targetHandoffToken = profiles ? randomUUID() : undefined
  if (targetHandoffToken) emitProfileCheckpoint(profiles, {
    phase: "target-starting",
    generation: targetGeneration,
    handoffToken: targetHandoffToken,
  })

  const stopClaim = (claim: import("./storage.ts").AdoptionClaimRow): void => {
    const found = tx.findExpectedAdoptionPane!(claim)
    if (found.kind === "unknown") {
      throw new PermissionHandoffAbortedError("Permission change canceled because exact worker absence could not be proved")
    }
    if (found.kind === "found") {
      if (!tx.killExpectedAdoptionPane!(claim)) {
        throw new PermissionHandoffAbortedError("Permission change canceled because the exact worker changed before teardown")
      }
      if (tx.findExpectedAdoptionPane!(claim).kind !== "absent") {
        throw new PermissionHandoffAbortedError("Permission change canceled because the exact worker could not be confirmed stopped")
      }
    }
  }

  const spawnBound = (
    permissionMode: PermissionModeValue,
    previousAttemptToken: string,
    launchProfile?: { model: string; effort: string },
    profileHandoffToken?: string,
  ): { identity: PaneIdentity; claim: import("./storage.ts").AdoptionClaimRow } => {
    const reservedAtMs = Date.now()
    const attemptToken = randomUUID()
    if (!deps.storage.rearmFinalizedAdoptionClaim({
      slug: row.slug,
      attemptToken,
      sessionId: row.session_id,
      reservedAtMs,
      leaseExpiresAtMs: reservedAtMs + ADOPTION_ATTEMPT_LEASE_MS,
    }, previousAttemptToken)) {
      throw new PermissionHandoffAbortedError("Permission change canceled because the adopted runtime binding changed")
    }
    let identity: PaneIdentity | undefined
    try {
      const fenced = deps.storage.withAdoptionSpawnFence(
        row.slug,
        attemptToken,
        Date.now() + ADOPTION_ATTEMPT_LEASE_MS,
        (bindPane) => spawnPinnedSession(deps, tx, row, permissionMode, undefined, {
          adoptionAttemptToken: attemptToken,
          onCreated: (created) => {
            identity = created
            if (!bindPane(created, Date.now() + ADOPTION_ATTEMPT_LEASE_MS)) {
              throw new Error("adopted permission handoff lost its pane binding")
            }
          },
        }, launchProfile, profileHandoffToken),
      )
      if (!fenced.acquired) throw new Error("adopted permission handoff was retired before spawn")
      const returned = fenced.value
      identity = returned ?? identity
      if (!identity || !deps.storage.recordAdoptionPane(
        row.slug,
        attemptToken,
        identity,
        Date.now() + ADOPTION_ATTEMPT_LEASE_MS,
      )) {
        throw new Error("adopted permission handoff lost its pane binding")
      }
      if (!deps.storage.finalizeAdoptionRespawnClaim(row.slug, attemptToken, row.session_id, Date.now())) {
        throw new Error("adopted permission handoff lost ownership during finalization")
      }
      const claim = deps.storage.getAdoptionClaim(row.slug)
      if (!claim || claim.state !== "finalized" || claim.attempt_token !== attemptToken) {
        throw new Error("adopted permission handoff finalization could not be verified")
      }
      return { identity, claim }
    } catch (error) {
      const failedIdentity = identity ?? (error instanceof tmux.TmuxSpawnError ? error.identity : undefined)
      try {
        abandonAdoptionAttempt({
          storage: deps.storage,
          projectDir: deps.project.dir,
          slug: row.slug,
          attemptToken,
          sessionId: row.session_id,
          identity: failedIdentity,
          runtime,
          cleanupFiles: false,
        })
      } catch {
        // The durable leased attempt remains restart-recoverable.
      }
      throw error
    }
  }

  stopClaim(initialClaim)
  tx.ensureServer()
  let target: ReturnType<typeof spawnBound> | undefined
  try {
    target = spawnBound(requested, initialClaim.attempt_token, profiles?.requested, targetHandoffToken)
    if (targetHandoffToken) emitProfileCheckpoint(profiles, {
      phase: "target-spawned",
      generation: targetGeneration,
      handoffToken: targetHandoffToken,
      identity: target.identity,
      adoptionAttemptToken: target.claim.attempt_token,
    })
    const probe = await permissionProcessStayedLive(
      deps,
      tx,
      row,
      target.identity,
      target.identity.panePid,
      target.claim,
    )
    if (probe === "replaced") throw new PermissionHandoffAbortedError("Permission change canceled because another worker process replaced this thread during startup")
    if (probe === "exited") throw new Error("the resumed worker exited during startup")
    if (probe === "unready") throw new Error("the resumed worker did not reach an idle composer during startup")
    if (targetHandoffToken) emitProfileCheckpoint(profiles, {
      phase: "target-ready",
      generation: targetGeneration,
      handoffToken: targetHandoffToken,
      identity: target.identity,
      adoptionAttemptToken: target.claim.attempt_token,
    })
  } catch (targetError) {
    if (targetError instanceof ProfileCheckpointAbortedError) throw targetError
    if (profiles?.rollbackOnFailure === false) throw targetError
    const targetMessage = targetError instanceof Error ? targetError.message : String(targetError)
    try {
      assertPermissionGenerationCurrent(deps, row, targetGeneration, expectedPending, expectedRuntimeControl)
      const currentClaim = deps.storage.getAdoptionClaim(row.slug)
      if (!currentClaim || currentClaim.session_id !== row.session_id || currentClaim.state !== "finalized") {
        throw new PermissionHandoffAbortedError("Permission rollback canceled because the adopted runtime attempt still needs recovery")
      }
      const rollbackHandoffToken = profiles ? randomUUID() : undefined
      const rollbackGeneration = deps.storage.beginRuntimeGeneration(
        row.slug,
        { sessionId: row.session_id, generation: targetGeneration, permissionPending: expectedPending, runtimeControl: expectedRuntimeControl },
        new Date().toISOString(),
      )
      if (rollbackGeneration === null) {
        throw new PermissionHandoffAbortedError("Permission rollback canceled because the process generation was replaced")
      }
      ownedGeneration = rollbackGeneration
      onGeneration?.(ownedGeneration)
      if (rollbackHandoffToken) emitProfileCheckpoint(profiles, {
        phase: "rollback-starting",
        generation: rollbackGeneration,
        handoffToken: rollbackHandoffToken,
      })
      stopClaim(currentClaim)
      tx.ensureServer()
      const rollback = spawnBound(current, currentClaim.attempt_token, profiles?.current, rollbackHandoffToken)
      if (rollbackHandoffToken) emitProfileCheckpoint(profiles, {
        phase: "rollback-spawned",
        generation: rollbackGeneration,
        handoffToken: rollbackHandoffToken,
        identity: rollback.identity,
        adoptionAttemptToken: rollback.claim.attempt_token,
      })
      const rollbackProbe = await permissionProcessStayedLive(
        deps,
        tx,
        row,
        rollback.identity,
        rollback.identity.panePid,
        rollback.claim,
      )
      if (rollbackProbe !== "ready") throw new Error("the previous worker mode did not return to an idle composer")
      if (rollbackHandoffToken) emitProfileCheckpoint(profiles, {
        phase: "rollback-ready",
        generation: rollbackGeneration,
        handoffToken: rollbackHandoffToken,
        identity: rollback.identity,
        adoptionAttemptToken: rollback.claim.attempt_token,
      })
      assertPermissionGenerationCurrent(deps, row, rollbackGeneration, expectedPending, expectedRuntimeControl)
      commitPermissionRuntime(deps, row, rollbackGeneration, expectedPending, current, expectedPending as PermissionModeValue | null, false, expectedRuntimeControl)
      deps.board.refresh()
      throw new Error(`Permission change failed; the previous mode was restored: ${targetMessage.slice(0, 180)}`)
    } catch (rollbackError) {
      if (rollbackError instanceof Error && rollbackError.message.startsWith("Permission change failed;")) throw rollbackError
      try {
        commitPermissionRuntime(
          deps,
          row,
          ownedGeneration,
          expectedPending,
          current,
          expectedPending as PermissionModeValue | null,
          true,
          expectedRuntimeControl,
        )
        deps.board.refresh()
      } catch {
        // A replaced session owns its own state; preserve the more specific rollback error.
      }
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`Permission change failed and the worker could not be restored: ${rollbackMessage.slice(0, 180)}`)
    }
  }

  assertPermissionGenerationCurrent(deps, row, targetGeneration, expectedPending, expectedRuntimeControl)
  const finalized = deps.storage.getAdoptionClaim(row.slug)
  if (!target || !finalized || finalized.attempt_token !== target.claim.attempt_token ||
      tx.findExpectedAdoptionPane(finalized).kind !== "found") {
    throw new PermissionHandoffAbortedError("Permission change canceled because the exact resumed worker is unavailable")
  }
  commitPermissionRuntime(
    deps,
    row,
    targetGeneration,
    expectedPending,
    requested,
    expectedPending as PermissionModeValue | null,
    false,
    expectedRuntimeControl,
  )
  deps.board.refresh()
  return { generation: targetGeneration }
}

async function reattachThreadWithPermissionAsync(
  deps: ResumeDeps,
  slug: string,
  current: PermissionModeValue,
  requested: PermissionModeValue,
  onGeneration?: (generation: number) => void,
  profiles?: ProfileTransition,
): Promise<{ generation: number }> {
  const tx = deps.tmux ?? tmux
  const row = deps.storage.getSession(slug)
  if (!row) throw new Error(`no session registered for ${slug}`)
  const runtimeBinding = adoptionRuntimeBinding(deps.storage, row)
  if (runtimeBinding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; permissions were not changed")
  }
  if (runtimeBinding.kind === "bound") {
    return reattachAdoptedThreadWithPermission(
      deps,
      tx,
      row,
      runtimeBinding.claim,
      current,
      requested,
      onGeneration,
      profiles,
    )
  }
  if (!tx.isLive(slug)) {
    throw new Error("The worker exited before permissions could change; retry to save the mode for its next resume")
  }

  // If production cannot prove which process currently owns the slug, do not kill anything.
  const originalIdentity = tx.paneIdentity?.(slug) ?? undefined
  if (tx.paneIdentity && !originalIdentity) {
    throw new PermissionHandoffAbortedError("Permission change canceled because the current worker pane identity was not available")
  }
  const expectedPending = row.permission_pending ?? null
  const expectedRuntimeControl = row.runtime_control ?? null
  const targetGeneration = deps.storage.beginRuntimeGeneration(
    row.slug,
    {
      sessionId: row.session_id,
      generation: row.runtime_generation ?? 0,
      permissionPending: expectedPending,
      runtimeControl: expectedRuntimeControl,
    },
    new Date().toISOString(),
  )
  if (targetGeneration === null) {
    throw new PermissionHandoffAbortedError("Permission change canceled because this thread or process generation was replaced before startup")
  }
  let ownedGeneration = targetGeneration
  onGeneration?.(ownedGeneration)
  const targetHandoffToken = profiles ? randomUUID() : undefined
  if (targetHandoffToken) emitProfileCheckpoint(profiles, {
    phase: "target-starting",
    generation: targetGeneration,
    handoffToken: targetHandoffToken,
  })

  killCapturedPane(tx, slug, originalIdentity)
  tx.ensureServer()
  let targetIdentity: PaneIdentity | undefined
  let targetPanePid: number | undefined
  try {
    const spawnedIdentity = spawnPinnedSession(deps, tx, row, requested, undefined, undefined, profiles?.requested, targetHandoffToken)
    targetIdentity = spawnedIdentity ?? spawnedPaneIdentity(tx, slug)
    targetPanePid = spawnedPanePid(tx, slug, targetIdentity)
    if (targetHandoffToken) emitProfileCheckpoint(profiles, {
      phase: "target-spawned",
      generation: targetGeneration,
      handoffToken: targetHandoffToken,
      identity: targetIdentity,
    })
    const probe = await permissionProcessStayedLive(deps, tx, row, targetIdentity, targetPanePid)
    if (probe === "replaced") {
      throw new PermissionHandoffAbortedError("Permission change canceled because another worker process replaced this thread during startup")
    }
    if (probe === "exited") {
      throw new Error("the resumed worker exited during startup")
    }
    if (probe === "unready") throw new Error("the resumed worker did not reach an idle composer during startup")
    if (targetHandoffToken) emitProfileCheckpoint(profiles, {
      phase: "target-ready",
      generation: targetGeneration,
      handoffToken: targetHandoffToken,
      identity: targetIdentity,
    })
  } catch (targetError) {
    if (targetError instanceof tmux.TmuxSpawnError && targetError.identity) {
      targetIdentity = targetError.identity
      targetPanePid = targetError.identity.panePid
    }
    if (targetError instanceof PermissionHandoffAbortedError || targetError instanceof ProfileCheckpointAbortedError) throw targetError
    if (profiles?.rollbackOnFailure === false) throw targetError
    const targetMessage = targetError instanceof Error ? targetError.message : String(targetError)
    try {
      assertPermissionGenerationCurrent(deps, row, targetGeneration, expectedPending, expectedRuntimeControl)
      // If the target pane was replaced by an unknown process, never kill it in the name of rolling
      // back an older request. A generation change in storage is checked independently above.
      if (tx.paneIdentity) {
        if (!targetIdentity) throw new PermissionHandoffAbortedError("Permission rollback canceled because the target worker identity is unavailable")
        if (tx.isLive(slug)) assertPaneStillCurrent(tx, slug, targetIdentity, targetPanePid)
      } else if (targetPanePid !== undefined && tx.isLive(slug)) {
        assertPaneStillCurrent(tx, slug, undefined, targetPanePid)
      }
      const rollbackHandoffToken = profiles ? randomUUID() : undefined
      const rollbackGeneration = deps.storage.beginRuntimeGeneration(
        row.slug,
        { sessionId: row.session_id, generation: targetGeneration, permissionPending: expectedPending, runtimeControl: expectedRuntimeControl },
        new Date().toISOString(),
      )
      if (rollbackGeneration === null) {
        throw new PermissionHandoffAbortedError("Permission rollback canceled because the process generation was replaced")
      }
      ownedGeneration = rollbackGeneration
      onGeneration?.(ownedGeneration)
      if (rollbackHandoffToken) emitProfileCheckpoint(profiles, {
        phase: "rollback-starting",
        generation: rollbackGeneration,
        handoffToken: rollbackHandoffToken,
      })
      if (targetIdentity || !tx.paneIdentity) killCapturedPane(tx, slug, targetIdentity)
      tx.ensureServer()
      const spawnedRollbackIdentity = spawnPinnedSession(deps, tx, row, current, undefined, undefined, profiles?.current, rollbackHandoffToken)
      const rollbackIdentity = spawnedRollbackIdentity ?? spawnedPaneIdentity(tx, slug)
      const rollbackPanePid = spawnedPanePid(tx, slug, rollbackIdentity)
      if (rollbackHandoffToken) emitProfileCheckpoint(profiles, {
        phase: "rollback-spawned",
        generation: rollbackGeneration,
        handoffToken: rollbackHandoffToken,
        identity: rollbackIdentity,
      })
      const rollbackProbe = await permissionProcessStayedLive(deps, tx, row, rollbackIdentity, rollbackPanePid)
      if (rollbackProbe === "replaced") {
        throw new PermissionHandoffAbortedError("Permission rollback canceled because another worker process replaced this thread during startup")
      }
      if (rollbackProbe === "exited") {
        throw new Error("the previous worker mode also exited during startup")
      }
      if (rollbackProbe === "unready") throw new Error("the previous worker mode did not reach an idle composer during startup")
      if (rollbackHandoffToken) emitProfileCheckpoint(profiles, {
        phase: "rollback-ready",
        generation: rollbackGeneration,
        handoffToken: rollbackHandoffToken,
        identity: rollbackIdentity,
      })
      assertPermissionGenerationCurrent(deps, row, rollbackGeneration, expectedPending, expectedRuntimeControl)
      assertPaneStillCurrent(tx, slug, rollbackIdentity, rollbackPanePid)
      commitPermissionRuntime(deps, row, rollbackGeneration, expectedPending, current, expectedPending as PermissionModeValue | null, false, expectedRuntimeControl)
      deps.board.refresh()
      throw new Error(`Permission change failed; the previous mode was restored: ${targetMessage.slice(0, 180)}`)
    } catch (rollbackError) {
      if (rollbackError instanceof tmux.TmuxSpawnError && rollbackError.identity && tx.killPane) {
        tx.killPane(rollbackError.identity)
      }
      if (rollbackError instanceof PermissionHandoffAbortedError) throw rollbackError
      if (rollbackError instanceof Error && rollbackError.message.startsWith("Permission change failed;")) throw rollbackError
      commitPermissionRuntime(
        deps,
        row,
        ownedGeneration,
        expectedPending,
        current,
        expectedPending as PermissionModeValue | null,
        true,
        expectedRuntimeControl,
      )
      deps.board.refresh()
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`Permission change failed and the worker could not be restored: ${rollbackMessage.slice(0, 180)}`)
    }
  }

  assertPermissionGenerationCurrent(deps, row, targetGeneration, expectedPending, expectedRuntimeControl)
  assertPaneStillCurrent(tx, slug, targetIdentity, targetPanePid)
  commitPermissionRuntime(
    deps,
    row,
    targetGeneration,
    expectedPending,
    requested,
    expectedPending as PermissionModeValue | null,
    false,
    expectedRuntimeControl,
  )
  deps.board.refresh()
  return { generation: targetGeneration }
}

function profileBindingMatchesPane(binding: ProfileHandoffBinding, pane: tmux.PaneSnapshot): boolean {
  return binding.paneId === pane.paneId && binding.panePid === pane.panePid &&
    binding.sessionCreated === pane.sessionCreated &&
    (!binding.handoffToken || pane.profileHandoffToken === binding.handoffToken) &&
    (!binding.adoptionAttemptToken || pane.adoptionAttemptToken === binding.adoptionAttemptToken)
}

function profileExpectedFromRow(row: SessionRow): ProfileChangeExpectation {
  if (!row.profile_pending_model || !row.profile_pending_effort || !row.profile_handoff) {
    throw new Error("profile handoff ownership is incomplete")
  }
  return {
    sessionId: row.session_id,
    nativeSessionId: row.agent_session_id ?? null,
    generation: row.runtime_generation ?? 0,
    profileRevision: row.profile_revision ?? 0,
    controlRevision: row.runtime_control_revision ?? 0,
    model: row.profile_pending_model,
    effort: row.profile_pending_effort,
    profileHandoff: row.profile_handoff,
  }
}

// Restart recovery for a durable profile journal. Every destructive action is preceded by a SQLite
// checkpoint carrying an unguessable tmux environment token; every successful outcome returns only
// after the exact token+tuple runtime has been proven. The controller performs the final atomic
// commit/restore and otherwise deliberately leaves runtime_control='profile'.
export async function recoverThreadProfileHandoff(
  deps: ResumeDeps,
  initialRow: SessionRow,
  initialJournal: ProfileHandoffJournal,
  observation: ProfileRecoveryObservation,
): Promise<ProfileRecoveryResult> {
  const tx = deps.tmux ?? tmux
  let journal = initialJournal

  const checkpoint = (checkpointValue: ProfileReattachCheckpoint, phase = checkpointValue.phase): void => {
    const row = deps.storage.getSession(initialRow.slug)
    if (!row || row.session_id !== initialRow.session_id || row.runtime_control !== "profile") {
      throw new Error("profile recovery ownership changed")
    }
    const binding = checkpointValue.identity ? {
      kind: checkpointValue.adoptionAttemptToken ? "adopted" as const : "standalone" as const,
      ...checkpointValue.identity,
      ...(checkpointValue.adoptionAttemptToken ? { adoptionAttemptToken: checkpointValue.adoptionAttemptToken } : {}),
      handoffToken: checkpointValue.handoffToken,
    } : undefined
    const leg = {
      generation: checkpointValue.generation,
      handoffToken: checkpointValue.handoffToken,
      ...(binding ? { binding } : {}),
    }
    const next: ProfileHandoffJournal = phase.startsWith("target")
      ? { ...journal, phase: phase as ProfileHandoffJournal["phase"], target: leg }
      : { ...journal, phase: phase as ProfileHandoffJournal["phase"], rollback: leg }
    const serialized = deps.storage.checkpointProfileChange(initialRow.slug, profileExpectedFromRow(row), next)
    if (!serialized) throw new Error("profile recovery journal checkpoint lost ownership")
    journal = next
  }

  const checkpointPriorReady = (): ProfileRecoveryResult => {
    const row = deps.storage.getSession(initialRow.slug)
    if (!row) return { outcome: "blocked", error: "The thread disappeared during profile recovery; sends remain blocked" }
    const token = randomUUID()
    const next: ProfileHandoffJournal = {
      ...journal,
      phase: "rollback-ready",
      rollback: { generation: row.runtime_generation ?? 0, handoffToken: token, binding: journal.previous.binding },
    }
    const serialized = deps.storage.checkpointProfileChange(initialRow.slug, profileExpectedFromRow(row), next)
    if (!serialized) return { outcome: "blocked", error: "Exact prior-runtime proof lost its durable commit race; sends remain blocked" }
    journal = next
    return { outcome: "rollback-ready", error: "The interrupted profile change was canceled; the previous runtime was proven unchanged" }
  }

  const findPrior = (): tmux.AdoptionPaneLookup => {
    const prior = journal.previous.binding
    if (prior.kind === "adopted") {
      if (!prior.adoptionAttemptToken || !tx.findExpectedAdoptionPane) return { kind: "unknown" }
      return tx.findExpectedAdoptionPane({
        attempt_token: prior.adoptionAttemptToken,
        pane_id: prior.paneId,
        pane_pid: prior.panePid,
        session_created: prior.sessionCreated,
      })
    }
    return tx.findPaneIdentity?.(prior) ?? { kind: "unknown" }
  }

  const prior = findPrior()
  if (journal.phase === "armed" && prior.kind === "found" && !prior.pane.dead) return checkpointPriorReady()

  const legKind = journal.phase.startsWith("rollback") ? "rollback" : "target"
  const leg = legKind === "target" ? journal.target : journal.rollback
  if (!leg) {
    return { outcome: "blocked", error: `Profile recovery phase ${journal.phase} has no exact runtime token; sends remain blocked` }
  }
  const found = tx.findProfileHandoffPane?.(leg.handoffToken) ?? { kind: "unknown" as const }
  if (found.kind === "unknown") {
    return { outcome: "blocked", error: "The exact profile-handoff pane could not be inspected; sends remain blocked and no pane was touched" }
  }
  if (found.kind === "absent") {
    if (prior.kind === "found" && !prior.pane.dead) return checkpointPriorReady()
    return {
      outcome: "blocked",
      error: "The journaled profile pane was replaced or disappeared and the prior runtime is not provable; sends remain blocked",
    }
  }
  if (leg.binding && !profileBindingMatchesPane(leg.binding, found.pane)) {
    return { outcome: "blocked", error: "The profile-handoff token resolved to a different pane identity; sends remain blocked" }
  }
  const exactIdentity = { paneId: found.pane.paneId, panePid: found.pane.panePid, sessionCreated: found.pane.sessionCreated }
  if (!leg.binding) {
    checkpoint({
      phase: legKind === "target" ? "target-spawned" : "rollback-spawned",
      generation: leg.generation,
      handoffToken: leg.handoffToken,
      identity: exactIdentity,
      adoptionAttemptToken: found.pane.adoptionAttemptToken ?? undefined,
    })
  }

  if (legKind === "target" && !found.pane.dead &&
      (journal.phase === "target-ready" || observation.currentTargetObservation)) {
    if (journal.phase !== "target-ready") checkpoint({
      phase: "target-ready",
      generation: leg.generation,
      handoffToken: leg.handoffToken,
      identity: exactIdentity,
      adoptionAttemptToken: found.pane.adoptionAttemptToken ?? undefined,
    })
    return { outcome: "target-ready" }
  }

  if (legKind === "rollback") {
    const expected = { ...exactIdentity, handoffToken: leg.handoffToken }
    const capture = tx.captureExpectedProfileHandoffPane?.(expected, initialRow.backend === "codex")
    const composer = capture?.kind === "captured"
      ? initialRow.backend === "codex" ? inspectCodexComposer(capture.text) : inspectClaudeComposer(capture.text)
      : { kind: "unavailable" as const }
    if (!found.pane.dead && (journal.phase === "rollback-ready" || composer.kind === "empty")) {
      if (journal.phase !== "rollback-ready") checkpoint({
        phase: "rollback-ready",
        generation: leg.generation,
        handoffToken: leg.handoffToken,
        identity: exactIdentity,
        adoptionAttemptToken: found.pane.adoptionAttemptToken ?? undefined,
      })
      return { outcome: "rollback-ready", error: "The previous profile was restored after an interrupted handoff" }
    }
    return { outcome: "blocked", error: "The journaled prior-profile runtime has not reached a provable idle composer; sends remain blocked" }
  }

  if (!tx.killExpectedProfileHandoffPane || !tx.findProfileHandoffPane) {
    return { outcome: "blocked", error: "Exact profile-pane teardown is unavailable; sends remain blocked" }
  }

  // An adopted runtime already has an exact durable claim; reuse the normal exact-claim reattach but
  // disable its fallback-to-target behavior. A failed prior-profile spawn must remain locked, never
  // recreate the wrong requested profile and release sends.
  if (found.pane.adoptionAttemptToken) {
    const result = await reattachThreadWithPermissionAsync(
      deps,
      initialRow.slug,
      permissionModeForRow(initialRow, deps.getSettings()),
      permissionModeForRow(initialRow, deps.getSettings()),
      undefined,
      {
        current: journal.requested,
        requested: journal.previous,
        rollbackOnFailure: false,
        onCheckpoint: (value) => {
          const mapped = value.phase === "target-starting" ? "rollback-starting"
            : value.phase === "target-spawned" ? "rollback-spawned"
              : value.phase === "target-ready" ? "rollback-ready" : value.phase
          checkpoint(value, mapped)
        },
      },
    )
    const row = deps.storage.getSession(initialRow.slug)
    if (!row || result.generation !== (row.runtime_generation ?? 0)) {
      return { outcome: "blocked", error: "Prior-profile recovery lost its adopted runtime generation; sends remain blocked" }
    }
    return { outcome: "rollback-ready", error: "The previous profile was restored after an interrupted handoff" }
  }

  const rollbackToken = randomUUID()
  const current = deps.storage.getSession(initialRow.slug)
  if (!current) return { outcome: "blocked", error: "The thread disappeared before prior-profile recovery" }
  const rollbackGeneration = deps.storage.beginRuntimeGeneration(initialRow.slug, {
    sessionId: initialRow.session_id,
    generation: current.runtime_generation ?? 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, new Date().toISOString())
  if (rollbackGeneration === null) {
    return { outcome: "blocked", error: "Prior-profile recovery lost its process-generation claim; sends remain blocked" }
  }
  checkpoint({ phase: "rollback-starting", generation: rollbackGeneration, handoffToken: rollbackToken })
  const targetExpected = { ...exactIdentity, handoffToken: leg.handoffToken }
  if (!tx.killExpectedProfileHandoffPane(targetExpected) || tx.findProfileHandoffPane(leg.handoffToken).kind !== "absent") {
    return { outcome: "blocked", error: "The exact target pane could not be stopped and proven absent; sends remain blocked" }
  }
  tx.ensureServer()
  let rollbackIdentity: PaneIdentity | undefined
  try {
    rollbackIdentity = spawnPinnedSession(
      deps,
      tx,
      current,
      permissionModeForRow(current, deps.getSettings()),
      undefined,
      undefined,
      journal.previous,
      rollbackToken,
    ) as PaneIdentity | undefined
    rollbackIdentity = rollbackIdentity ?? spawnedPaneIdentity(tx, initialRow.slug)
    const provenRollbackIdentity = rollbackIdentity
    if (!provenRollbackIdentity) {
      return { outcome: "blocked", error: "The prior-profile runtime pane identity was unavailable after spawn; sends remain blocked" }
    }
    checkpoint({ phase: "rollback-spawned", generation: rollbackGeneration, handoffToken: rollbackToken, identity: provenRollbackIdentity })
    const probe = await permissionProcessStayedLive(deps, tx, current, provenRollbackIdentity, provenRollbackIdentity.panePid)
    if (probe !== "ready") {
      return { outcome: "blocked", error: `The prior-profile runtime could not be proven ready (${probe}); sends remain blocked` }
    }
    checkpoint({ phase: "rollback-ready", generation: rollbackGeneration, handoffToken: rollbackToken, identity: provenRollbackIdentity })
    return { outcome: "rollback-ready", error: "The previous profile was restored after an interrupted handoff" }
  } catch (error) {
    return { outcome: "blocked", error: `Prior-profile restore failed; sends remain blocked: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function resumeThreadOwned(deps: ResumeDeps, slug: string, message: string): void {
  const tx = deps.tmux ?? tmux
  const row = deps.storage.getSession(slug)
  if (!row) throw new Error(`no session registered for ${slug}`)
  // This barrier is deliberately before unarchive, live injection, and dead spawn. Any non-NULL
  // value — including a future/corrupt mode — is durable ownership held by the permission controller.
  if (row.permission_pending !== null && row.permission_pending !== undefined) {
    throw new Error("A permission change is in progress; wait for it to finish before sending a follow-up")
  }
  if (row.profile_pending_model !== null && row.profile_pending_model !== undefined ||
      row.profile_pending_effort !== null && row.profile_pending_effort !== undefined) {
    throw new Error("A model/effort change is in progress; wait for it to finish before sending a follow-up")
  }
  if (row.runtime_control !== null && row.runtime_control !== undefined &&
      row.runtime_control !== "follow-up" &&
      !(row.runtime_control === "codex-input" && row.backend === "codex")) {
    throw new Error("Another runtime control is in progress; wait for it to finish before sending a follow-up")
  }
  const codexQueue = row.backend === "codex"
    ? parseCodexInputQueue(row.codex_input_queue)
    : { valid: true, items: [] }
  if (!codexQueue.valid) {
    throw new Error("Invalid durable Codex input state cannot be resumed or discarded automatically")
  }
  // A submitted item may already have crossed the native boundary. Only explicit transcript
  // confirmation or the timed-out clear action can acknowledge it.
  if (hasUnconfirmedCodexSubmission(row)) {
    throw new Error("Codex has an unconfirmed submitted message; resolve or clear it before resuming")
  }
  const runtimeBinding = adoptionRuntimeBinding(deps.storage, row)
  if (runtimeBinding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; no worker was contacted")
  }
  // A bump/resume REACTIVATES an archived thread: the maintainer messaging an Inactive (archived)
  // thread expects it back in Active. Un-archive UP FRONT — before the live/dead branch — so BOTH the
  // live-inject path (which early-returns below) and the dead-resume path reactivate uniformly; without
  // this, bumping a still-LIVE archived thread would leave it stranded in Inactive. setState clears BOTH
  // the lifecycle `state` and the legacy `archived` flag (stateStmt: state='open', archived=0), and the
  // board refresh re-sections the row via the SSE delta (sectionOf keys on `state`). Touch the row only
  // when it is actually archived so a normal live steer emits no needless per-keystroke delta. (The
  // wakers scheduler never reaches here for an archived thread — it filters them out — so this only ever
  // un-hides a thread on an EXPLICIT human bump, never auto-resurrects a deliberately-shelved one.)
  if (row.state === "archived" || row.archived === 1) {
    if (!deps.storage.setStateIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, "open")) {
      throw new Error("This thread changed before it could be reopened; no worker was contacted")
    }
    deps.board.refresh()
  }
  const adoption = runtimeBinding.kind === "bound" ? runtimeBinding.claim : undefined
  const adoptionLookup = adoption ? tx.findExpectedAdoptionPane?.(adoption) : undefined
  if (adoption && !adoptionLookup) {
    throw new Error("This adopted thread's exact runtime identity could not be verified; retry after Fray reconnects")
  }
  if (adoptionLookup?.kind === "unknown") {
    throw new Error("This adopted thread's exact runtime identity could not be verified; retry")
  }
  const live = adoption
    ? adoptionLookup?.kind === "found" && !adoptionLookup.pane.dead
    : tx.isLive(slug)
  if (live && codexQueue.items.length > 0) {
    throw new Error("Queued Codex input must finish before direct live injection")
  }
  if (live) {
    if (adoption) {
      if (tx.sendTextToExpectedAdoptionPane?.(adoption, message, true) !== true) {
        throw new Error("This adopted worker changed before the follow-up could be submitted")
      }
    } else if (message.includes("\n")) tx.pasteText(slug, message)
    else tx.sendKeys(slug, message)
    return
  }
  if (!adoption) {
    // A pre-migration Fray pane can be reused only with three independent proofs: matching project
    // root, matching native conversation id, and an unchanged live pane tuple.  An existing draft
    // is never cleared or submitted on the user's behalf; there is no safe retry boundary there.
    const legacy = tx.findCompatibleLegacyWorker?.(slug, deps.project, row.agent_session_id ?? row.session_id, row.backend)
    if (legacy?.kind === "found") {
      const capture = tx.captureCompatibleLegacyWorker?.(legacy.worker, row.backend === "codex")
      if (capture?.kind !== "captured") {
        throw new Error("The compatible legacy worker changed before the follow-up could be submitted")
      }
      const composer = row.backend === "codex"
        ? inspectCodexComposer(capture.text)
        : inspectClaudeComposer(capture.text)
      if (composer.kind !== "empty") {
        throw new Error("The compatible legacy worker has an existing draft; it was left untouched")
      }
      if (tx.sendTextToCompatibleLegacyWorker?.(legacy.worker, message) !== true) {
        throw new Error("The compatible legacy worker changed before the follow-up could be submitted")
      }
      // The provider received the atomic paste+Enter.  This is a new runtime observation, not a
      // replay: clear only the stale exited artifact after the exact send succeeded.
      deps.storage.setExited(slug, false)
      deps.board.refresh()
      return
    }
    const migratedOwner = tx.crossSocketLiveOwner?.(slug, deps.project)
    if (migratedOwner === "live") {
      // A live worker owns this slug on a legacy socket, but findCompatibleLegacyWorker above could not
      // confirm its exact identity for safe injection (otherwise it would have delivered and returned).
      // This is TERMINAL: the identity conflict won't resolve by retrying, so raise the non-retryable
      // error the scheduler abandons+surfaces instead of retrying to a silent exhaustion.
      throw new TerminalDeliveryError("A live matching worker exists on a compatible legacy tmux socket; no duplicate was spawned")
    }
    if (migratedOwner === "unknown") {
      throw new Error("Could not verify compatible legacy tmux sockets; no worker was contacted")
    }
  }
  if (adoption) {
    if (adoptionLookup?.kind === "found") {
      if (!tx.killExpectedAdoptionPane) throw new Error("This adopted thread's exact dead pane cannot be cleared safely")
      if (!tx.killExpectedAdoptionPane(adoption)) {
        throw new Error("This adopted thread changed before its dead pane could be cleared; retry")
      }
      const afterKill = tx.findExpectedAdoptionPane?.(adoption)
      if (!afterKill || afterKill.kind !== "absent") {
        throw new Error("This adopted thread's exact dead pane could not be confirmed stopped; retry")
      }
    }
  } else {
    tx.killSession(slug) // clear the dead (remain-on-exit) pane so new-session can reuse the name
  }
  tx.ensureServer()
  // A thread-specific override always wins. Only a migrated/unknown row falls back to the current
  // defaults, and that concrete value is stamped below once this resume actually launches it.
  const permissionMode = permissionModeForRow(row, deps.getSettings())
  let resumeMessage: string | undefined = message
  if (row.backend === "codex" && codexQueue.items.length > 0) {
    const nextQueue = [
      ...codexQueue.items,
      { text: message, enqueuedAt: new Date().toISOString(), state: "pending" as const },
    ]
    const queued = deps.storage.setCodexInputQueueIfCurrent(
      row.slug,
      {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        queue: row.codex_input_queue ?? null,
      },
      JSON.stringify(nextQueue),
    )
    if (!queued) throw new Error("Codex input changed before the dead session could resume; retry")
    // Reattach only. The durable controller will submit the existing head first, then this trigger.
    resumeMessage = undefined
  }
  let adoptionAttemptToken: string | undefined
  if (adoption) {
    const reservedAtMs = Date.now()
    adoptionAttemptToken = randomUUID()
    if (!deps.storage.rearmFinalizedAdoptionClaim({
      slug,
      attemptToken: adoptionAttemptToken,
      sessionId: row.session_id,
      reservedAtMs,
      leaseExpiresAtMs: reservedAtMs + ADOPTION_ATTEMPT_LEASE_MS,
    }, adoption.attempt_token)) {
      throw new Error("This adopted thread changed before it could resume; retry")
    }
  }
  // The scratchpad orientation keys on the fray-minted session_id (unchanged by codex discovery); the
  // backend-NATIVE id (codex rollout id, pinned on agent_session_id) is what resume re-attaches +
  // `codex resume` continues. For claude, agent_session_id is NULL → session_id — byte-identical.
  const generation = deps.storage.beginRuntimeGeneration(
    row.slug,
    { sessionId: row.session_id, generation: row.runtime_generation ?? 0, permissionPending: null, runtimeControl: row.runtime_control ?? null },
    new Date().toISOString(),
  )
  if (generation === null) {
    if (adoptionAttemptToken) deps.storage.abandonAdoptionClaim(slug, adoptionAttemptToken)
    throw new Error("This thread changed before it could resume; retry")
  }
  let spawnedIdentity: PaneIdentity | undefined
  try {
    if (adoptionAttemptToken) {
      const fenced = deps.storage.withAdoptionSpawnFence(
        slug,
        adoptionAttemptToken,
        Date.now() + ADOPTION_ATTEMPT_LEASE_MS,
        (bindPane) => spawnPinnedSession(
          deps,
          tx,
          row,
          permissionMode,
          resumeMessage,
          {
            adoptionAttemptToken,
            onCreated: (identity) => {
              spawnedIdentity = identity
              if (!bindPane(identity, Date.now() + ADOPTION_ATTEMPT_LEASE_MS)) {
                throw new Error("adopted resume lost its durable pane binding")
              }
            },
          },
        ) as PaneIdentity | undefined,
      )
      if (!fenced.acquired) throw new Error("adopted resume was retired before spawn")
      spawnedIdentity = fenced.value
    } else {
      spawnedIdentity = spawnPinnedSession(
        deps,
        tx,
        row,
        permissionMode,
        resumeMessage,
      ) as PaneIdentity | undefined
    }
    if (adoptionAttemptToken) {
      if (!spawnedIdentity || !deps.storage.recordAdoptionPane(
        slug,
        adoptionAttemptToken,
        spawnedIdentity,
        Date.now() + ADOPTION_ATTEMPT_LEASE_MS,
      )) {
        throw new Error("adopted resume lost its durable pane binding")
      }
      if (!deps.storage.finalizeAdoptionRespawnClaim(slug, adoptionAttemptToken, row.session_id, Date.now())) {
        throw new Error("adopted resume lost ownership during finalization")
      }
    }
  } catch (error) {
    const failedIdentity = spawnedIdentity ?? (error instanceof tmux.TmuxSpawnError ? error.identity : undefined)
    if (adoptionAttemptToken) {
      const recoveryRuntime = tx.lookupAdoptionPane && tx.findAdoptionPane && tx.findPaneIdentity &&
          tx.killExpectedAdoptionPane
        ? {
            lookupAdoptionPane: tx.lookupAdoptionPane,
            findAdoptionPane: tx.findAdoptionPane,
            findPaneIdentity: tx.findPaneIdentity,
            killExpectedAdoptionPane: tx.killExpectedAdoptionPane,
          } satisfies AdoptionRecoveryRuntime
        : undefined
      if (recoveryRuntime) {
        try {
          abandonAdoptionAttempt({
            storage: deps.storage,
            projectDir: deps.project.dir,
            slug,
            attemptToken: adoptionAttemptToken,
            sessionId: row.session_id,
            identity: failedIdentity,
            runtime: recoveryRuntime,
            cleanupFiles: false,
          })
        } catch {
          // Keep the leased claim for restart recovery.
        }
      }
    } else if (failedIdentity && tx.killPane) tx.killPane(failedIdentity)
    deps.storage.setPermissionStateIfCurrent(
      row.slug,
      { sessionId: row.session_id, generation, permissionPending: null, runtimeControl: row.runtime_control ?? null },
      {
        exited: true,
        permissionMode,
        permissionPending: null,
        controlError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      },
    )
    deps.board.refresh()
    throw error
  }
  if (!deps.storage.setPermissionStateIfCurrent(
    row.slug,
    { sessionId: row.session_id, generation, permissionPending: null, runtimeControl: row.runtime_control ?? null },
    { exited: false, permissionMode, permissionPending: null, controlError: null },
  )) {
    throw new Error("This thread process generation was replaced during resume")
  }
  deps.board.refresh() // storage-only change — overlay is enough
}

export function resumeThread(deps: ResumeDeps, slug: string, message: string): void {
  const initial = deps.storage.getSession(slug)
  if (!initial) throw new Error(`no session registered for ${slug}`)
  // Preserve the specific, actionable errors from the inner path before trying the durable claim.
  // These checks are repeated after claiming; the SQLite CAS is still the actual race barrier.
  if (initial.permission_pending !== null && initial.permission_pending !== undefined) {
    throw new Error("A permission change is in progress; wait for it to finish before sending a follow-up")
  }
  if (initial.profile_pending_model !== null && initial.profile_pending_model !== undefined ||
      initial.profile_pending_effort !== null && initial.profile_pending_effort !== undefined) {
    throw new Error("A model/effort change is in progress; wait for it to finish before sending a follow-up")
  }
  const initialQueue = initial.backend === "codex"
    ? parseCodexInputQueue(initial.codex_input_queue)
    : { valid: true, items: [] }
  if (!initialQueue.valid) {
    throw new Error("Invalid durable Codex input state cannot be resumed or discarded automatically")
  }
  if (hasUnconfirmedCodexSubmission(initial)) {
    throw new Error("Codex has an unconfirmed submitted message; resolve or clear it before resuming")
  }
  if (adoptionRuntimeBinding(deps.storage, initial).kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; no worker was contacted")
  }
  // Durable Codex input already owns this path. Its queue controller is responsible for releasing
  // that claim after the native transcript acknowledges the final submitted item.
  if (initial.runtime_control === "codex-input" && initial.backend === "codex") {
    resumeThreadOwned(deps, slug, message)
    return
  }
  if (initial.runtime_control !== null && initial.runtime_control !== undefined) {
    throw new Error("Another runtime control is in progress; wait for it to finish before sending a follow-up")
  }
  const controlRevision = deps.storage.beginRuntimeControl(slug, {
    sessionId: initial.session_id,
    nativeSessionId: initial.agent_session_id ?? null,
    generation: initial.runtime_generation ?? 0,
  }, "follow-up")
  if (controlRevision === null) {
    throw new Error("This thread changed or another runtime control started; no follow-up was sent")
  }
  try {
    resumeThreadOwned(deps, slug, message)
  } finally {
    const current = deps.storage.getSession(slug)
    if (current?.session_id === initial.session_id && deps.storage.releaseRuntimeControl(slug, {
      sessionId: initial.session_id,
      generation: current.runtime_generation ?? 0,
      kind: "follow-up",
      revision: controlRevision,
    })) deps.board.refresh()
  }
}
