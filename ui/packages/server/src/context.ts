import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Settings } from "@fray-ui/shared"
import { Bus, Emitter } from "./bus.ts"
import { resolveProject, type Project } from "./project.ts"
import { createStorage, type Storage } from "./storage.ts"
import { getSettings, setSettings, resetSettings } from "./settings.ts"
import { createBoard, type BoardManager } from "./board.ts"
import { createTailer, defaultLogDir, type Tailer } from "./tailer.ts"
import { createDispatcher, type Dispatcher } from "./dispatch.ts"
import { createScheduler, wakeDeliveryToken, type Scheduler } from "./scheduler.ts"
import {
  reattachThreadWithPermission,
  reattachThreadWithProfile,
  recoverThreadProfileHandoff,
  resumeThread,
} from "./resume.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { readClaudeAuthStatusCli, readCodexAuthState } from "./backend/auth-status.ts"
import { createLoginUtility, type LoginUtility } from "./login-utility.ts"
import type { AgentBackend } from "./backend/types.ts"
import { detectGithub, type GithubDetection } from "./github.ts"
import * as tmux from "./tmux.ts"
import { createPermissionController, type PermissionController } from "./permission-controller.ts"
import { createProfileController, type ProfileController } from "./profile-controller.ts"
import type { InteractionStore } from "./interaction-store.ts"
import {
  codexAppServerBridgeEnabled,
  createCodexAppServerBridge,
  type CodexAppServerBridge,
} from "./backend/codex-app-server.ts"
import {
  ADOPTION_RECONCILE_INTERVAL_MS,
  adoptionRuntimeBinding,
  reconcileAdoptionClaims,
} from "./adoption-recovery.ts"
import { startOrphanReaper } from "./orphan-reaper.ts"
import {
  createRetryableCleanup,
  createShutdownBarrier,
  DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
  type ShutdownBarrier,
  type ShutdownBarrierOptions,
  type ShutdownDiagnostic,
} from "./shutdown.ts"

export const CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS = 4_000

export type ContextStartupPhase =
  | "storage"
  | "subscriptions"
  | "Codex app-server bridge"
  | "tailer"
  | "board watcher"
  | "permission producer"
  | "profile producer"
  | "wake scheduler"

export interface ContextStartupFence {
  whenSafe(): Promise<void>
  recover(): Promise<void>
}

export class ContextStartupError extends Error {
  readonly startupError: unknown
  readonly cleanupError: unknown
  readonly diagnostics: readonly ShutdownDiagnostic[]
  readonly fence: ContextStartupFence

  constructor(options: {
    startupError: unknown
    cleanupError: unknown
    diagnostics: readonly ShutdownDiagnostic[]
    fence: ContextStartupFence
  }) {
    const startupMessage = options.startupError instanceof Error ? options.startupError.message : String(options.startupError)
    const cleanupMessage = options.cleanupError instanceof Error ? options.cleanupError.message : String(options.cleanupError)
    super(`Fray context initialization failed: ${startupMessage}; partial-context cleanup failed: ${cleanupMessage}`, {
      cause: options.startupError,
    })
    this.name = "ContextStartupError"
    this.startupError = options.startupError
    this.cleanupError = options.cleanupError
    this.diagnostics = [...options.diagnostics]
    this.fence = options.fence
  }
}

// The wired singletons every request handler shares. Built once at boot in createContext.
export interface AppContext {
  // Random per-process id minted at boot. It rides every board/board-delta SSE frame and the
  // `x-fray-boot` header on /rpc responses; a client that sees it CHANGE knows the server restarted
  // under a possibly-stale page and hard-reloads once. Closes the stale-bundle / zombie-reconnect class.
  bootId: string
  project: Project
  bus: Bus
  // Internal (non-wire) per-tick signal: the batch of thread slugs whose session JSONL advanced this
  // tailer tick. The /ws transcript producer subscribes to it to PUSH updated transcripts to subscribed
  // clients (replacing the client's 1.5s poll). Kept off the wire ServerEvent bus deliberately.
  transcriptChange: Emitter<string[]>
  storage: Storage
  // Durable runtime-neutral interaction journal. Default TUI backends do not publish into it; the
  // disabled-by-default app-server foundation below is the only current provider adapter.
  interactions: InteractionStore
  // Experimental foundation for NEW bridge-owned Codex sessions only. Undefined by default; it is
  // never selected by backendFor and therefore cannot migrate or control an existing TUI session.
  codexAppServer?: CodexAppServerBridge
  board: BoardManager
  tailer: Tailer
  dispatcher: Dispatcher
  // Per-session agent-backend resolver behind the spawn/resume/transcript seam (Codex-support epic).
  // Maps a row's `backend` column (claude|codex) to its AgentBackend; DEFAULTS to claude for any unset/
  // unknown kind, so every existing session and all current behavior are unchanged until a dispatch
  // explicitly selects codex. Shared by the dispatcher, the tailer, and every resumeThread call.
  backendFor: (kind?: string) => AgentBackend
  // Durable confirmed-wait scheduler: resumes a rested `awaiting` session at its timer or when new
  // non-bot human GitHub review activity appears. Started alongside the tailer; boot-safe.
  scheduler: Scheduler
  // Per-thread permission changes. Idle standalone TUIs are reopened on the same persisted
  // conversation with backend-native launch flags; busy/ambiguous states fail explicitly.
  permissionController: PermissionController
  profileController?: ProfileController
  // Detach storage-owned observers before board/storage teardown. Idempotent and synchronous so a
  // deferred interaction notification cannot enqueue fresh board work during the shutdown drain.
  stopSubscriptions(): void
  getSettings: () => Settings
  setSettings: (s: Settings) => Settings
  resetSettings: () => Settings
  // GitHub detection (installed/inRepo/nameWithOwner) resolved ONCE at boot via initGithub() — stable
  // for the process lifetime. `authed` is NOT cached here; the githubStatus query re-checks it live so
  // a mid-session `gh auth login` reflects immediately. Undefined until initGithub() resolves (the
  // githubStatus handler falls back to a live detect during that ~30ms window). Kept OUT of the board
  // snapshot deliberately — no gh shell-out on every board delta.
  github?: GithubDetection
  // The dispatch Claude executable (tests use a stand-in). The account logout action runs the SAME
  // binary so sign-out targets the credential the workers actually use.
  claudeBin?: string
  // Same seam for Codex: the resolved app-server/backend executable, so codex login/logout target
  // the binary fray actually runs rather than whatever "codex" is first on PATH.
  codexBin?: string
  // Slice B account utility: the restricted short-lived `claude auth login` terminal behind the
  // sign-in modal's primary action. Attempts ride the /term transport via slug-shaped opaque ids.
  loginUtility: LoginUtility
}

export interface ContextOptions {
  claudeBin?: string // injectable dispatch executable (tests use a stand-in)
  codexBin?: string // injectable app-server executable; unused unless the bridge flag is enabled
  // startServer pins the owner-verified project before any SQLite/tailer/scheduler initialization.
  project?: Project
  /** Internal deterministic construction/rollback seam. */
  startup?: {
    afterPhase?: (phase: ContextStartupPhase) => void
    cleanupTimeoutMs?: number
    cleanupDiagnostic?: (event: ShutdownDiagnostic) => void
    cleanupDeadline?: ShutdownBarrierOptions["deadline"]
  }
}

// Boot reconcile: a session row whose tmux session is no longer live was orphaned by a prior
// server exit (or the agent finished/was killed) — stamp exited so the registry doesn't show a
// forever-running ghost. Runtime is also derived live on each board build; this keeps the stored
// column honest too.
export function reconcileSessions(storage: Storage) {
  for (const row of storage.allSessions()) {
    const binding = adoptionRuntimeBinding(storage, row)
    const live = binding.kind === "unbound"
      ? tmux.isLive(row.slug)
      : binding.kind === "bound"
        ? (() => {
            const current = tmux.findExpectedAdoptionPane(binding.claim)
            return current.kind === "found" && !current.pane.dead
          })()
        : false
    if (!live && row.exited !== 1) {
      storage.setExitedIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, true)
    }
  }
}

// Resolve the stable GitHub detection triple once and cache it on ctx.github. Never throws
// (detectGithub swallows every gh failure), so it is safe to fire-and-forget at boot: a broken or
// absent gh just leaves the feature off. Called from startServer without blocking the listen — the
// githubStatus handler live-detects during the brief pre-cache window.
export async function initGithub(ctx: AppContext): Promise<void> {
  ctx.github = await detectGithub(ctx.project.dir)
}

interface PartialContextResources {
  storage?: Storage
  stopSubscriptions?: () => void
  codexAppServer?: CodexAppServerBridge
  board?: BoardManager
  tailer?: Tailer
  scheduler?: Scheduler
  permissionController?: PermissionController
  profileController?: ProfileController
}

interface PartialContextCleanup {
  tailer(): Promise<void>
  permissionController(): Promise<void>
  profileController(): Promise<void>
  subscriptions(): Promise<void>
  scheduler(): Promise<void>
  board(): Promise<void>
  codexAppServer(): Promise<void>
  storage(): Promise<void>
}

function partialContextCleanup(resources: PartialContextResources): PartialContextCleanup {
  return {
    tailer: createRetryableCleanup(() => resources.tailer?.stop()),
    permissionController: createRetryableCleanup(() => resources.permissionController?.stop()),
    profileController: createRetryableCleanup(() => resources.profileController?.stop()),
    subscriptions: createRetryableCleanup(() => resources.stopSubscriptions?.()),
    scheduler: createRetryableCleanup(async () => { await resources.scheduler?.stop() }),
    board: createRetryableCleanup(async () => { await resources.board?.stop() }),
    codexAppServer: createRetryableCleanup(async () => { await resources.codexAppServer?.shutdown() }),
    storage: createRetryableCleanup(() => resources.storage?.close()),
  }
}

function contextCleanupBarrier(
  cleanup: PartialContextCleanup,
  opts: ContextOptions,
  diagnostic: (event: ShutdownDiagnostic) => void,
): ShutdownBarrier {
  return createShutdownBarrier({
    timeoutMs: opts.startup?.cleanupTimeoutMs ?? CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS,
    // Bound + name each producer so a wedged one cannot stall startup-rollback cleanup indefinitely.
    phaseTimeoutMs: DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
    diagnostic,
    deadline: opts.startup?.cleanupDeadline,
    phases: [
      { name: "context tailer", run: cleanup.tailer },
      { name: "context permission producer", run: cleanup.permissionController },
      { name: "context profile producer", run: cleanup.profileController },
      { name: "context subscriptions", run: cleanup.subscriptions },
      { name: "context wake scheduler", run: cleanup.scheduler },
      { name: "context board watcher", run: cleanup.board },
      {
        name: "context Codex app-server bridge",
        run: cleanup.codexAppServer,
      },
    ],
    closeStorage: cleanup.storage,
  })
}

/**
 * Context construction is atomic to startServer: if any constructor/reconciliation step throws,
 * every already-created timer, observer, bridge, watcher and storage handle drains behind the same
 * bounded lifecycle barrier before the error crosses the ownership boundary.
 */
export async function createContext(opts: ContextOptions = {}): Promise<AppContext> {
  const resources: PartialContextResources = {}
  const cleanup = partialContextCleanup(resources)
  try {
    return createContextUnchecked(opts, resources)
  } catch (startupError) {
    const diagnostics: ShutdownDiagnostic[] = []
    const diagnostic = (event: ShutdownDiagnostic) => {
      diagnostics.push(event)
      opts.startup?.cleanupDiagnostic?.(event)
    }
    let barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
    let activeSafety = barrier.whenDrained()
    void activeSafety.catch(() => undefined)
    let cleanupError: unknown
    try {
      await barrier.close()
      await activeSafety
    } catch (error) {
      cleanupError = error
    }
    if (!cleanupError) throw startupError

    let recovery: Promise<void> | null = null
    const fence: ContextStartupFence = {
      whenSafe: () => activeSafety,
      recover: () => {
        if (recovery) return recovery
        barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
        activeSafety = barrier.whenDrained()
        void activeSafety.catch(() => undefined)
        const attempt = barrier.close().then(() => activeSafety)
        recovery = attempt
        void attempt.catch(() => {
          if (recovery === attempt) recovery = null
        })
        return attempt
      },
    }
    throw new ContextStartupError({ startupError, cleanupError, diagnostics, fence })
  }
}

function createContextUnchecked(opts: ContextOptions, resources: PartialContextResources): AppContext {
  const project = opts.project ?? resolveProject()
  // Isolate this instance's tmux server by PROJECT (C3): two fray-ui instances sharing one
  // `tmux -L fray` server would collide on fray-<slug> session names. Derive the socket from the
  // stable project id BEFORE any tmux call — reconcileSessions below calls tmux.isLive, and the
  // wrong socket would find no live sessions and wrongly mark them all exited on every boot.
  // The launcher/project resolver performs the crash-safe legacy migration exactly once and pins the
  // result through supervisor/child/reexec ownership. Never re-read FRAY_TMUX_SOCKET in a disposable
  // child: an environment drift must not move live workers to another server mid-run.
  tmux.pinSocket(project.tmuxSocket ?? tmux.deriveProjectSocket(
    project.id,
    project.identityScope === "worktree",
  ), {
    projectId: project.id,
    projectDir: project.dir,
  }, project.tmuxSocketManaged !== false)
  const dbPath = join(project.stateDir, "ui.db")
  const storage = createStorage(dbPath)
  resources.storage = storage
  const bus = new Bus()
  const transcriptChange = new Emitter<string[]>()
  const bootId = randomUUID()
  // Late-bound for the journal observer and tailer callbacks; boot expiry runs before assignment and
  // needs no board edge because the first build reads authoritative pending state directly.
  let board!: BoardManager
  const contextUnsubscribers: (() => void)[] = []
  let subscriptionsStopped = false
  const stopSubscriptions = () => {
    if (subscriptionsStopped) return
    const failures: { unsubscribe: () => void; error: unknown }[] = []
    for (const unsubscribe of contextUnsubscribers.splice(0).reverse()) {
      try {
        unsubscribe()
      } catch (error) {
        failures.push({ unsubscribe, error })
      }
    }
    if (failures.length > 0) {
      // Preserve failed observers for an explicit recover() attempt while still trying every sibling.
      contextUnsubscribers.push(...failures.map(({ unsubscribe }) => unsubscribe).reverse())
      throw new AggregateError(
        failures.map(({ error }) => error),
        `could not detach ${failures.length} context subscription${failures.length === 1 ? "" : "s"}`,
      )
    }
    subscriptionsStopped = true
  }
  resources.stopSubscriptions = stopSubscriptions
  opts.startup?.afterPhase?.("storage")

  contextUnsubscribers.push(storage.interactions.subscribe((change) => {
    // The DB is project-local, but still verify the explicit protocol owner before publishing. A
    // malformed/future adapter can never leak another project's invalidation onto this server.
    if (change.projectId !== project.id) return
    bus.publish({
      type: "interactions-invalidated",
      slug: change.threadSlug,
      sessionId: change.sessionId,
      interactionId: change.interactionId,
      lifecycle: change.lifecycle,
      recordRevision: change.recordRevision,
    })
    board?.interactionChanged?.(change)
  }))
  storage.interactions.expireDue()

  reconcileAdoptionClaims({ storage, projectDir: project.dir })
  // Permanent retired tokens are an active fence for pre-upgrade actors only if enforcement is
  // level-triggered. Sweep the single batched tmux inventory periodically so a late token pane is
  // killed within a bounded window even when no restart or new adoption occurs.
  const adoptionReconcileTimer = setInterval(() => {
    try {
      reconcileAdoptionClaims({ storage, projectDir: project.dir, includeFinalized: false })
    } catch {
      // Retain every claim/tombstone and retry next tick; recovery is deliberately fail-closed.
    }
  }, ADOPTION_RECONCILE_INTERVAL_MS)
  adoptionReconcileTimer.unref?.()
  contextUnsubscribers.push(() => clearInterval(adoptionReconcileTimer))

  // Reap this machine's leaked worker aux — verification browsers (agent-browser/chrome-devtools/
  // puppeteer) and MCP/dev servers that daemonized out of a stopped worker's tmux tree, so nothing
  // else ever collects them. A sweep on startup clears accumulated leaks; the interval catches new
  // orphans (a stopped/crashed thread's browsers) within a bounded window. Reaps ONLY processes
  // whose FRAY_UI_THREAD slug has no live claude/codex root; never a session/tmux/self process.
  // FRAY_ORPHAN_REAPER_OFF disables it for disposable adhoc/test stacks (mirrors FRAY_WAKERS_OFF) so a
  // throwaway instance never reaps the real machine's processes.
  if (!process.env.FRAY_ORPHAN_REAPER_OFF) {
    contextUnsubscribers.push(startOrphanReaper({ log: (m) => console.log(`[fray-ui] ${m}`) }))
  }
  reconcileSessions(storage)
  opts.startup?.afterPhase?.("subscriptions")

  // The agent backends behind the spawn/resume/transcript seam (Codex-support epic). The ClaudeBackend's
  // transcript dir matches the tailer's (defaultLogDir) so foreign-scan + per-session path stay
  // consistent; the CodexBackend uses $CODEX_HOME (default ~/.codex). `backendFor` maps a row's `backend`
  // column to the right one, DEFAULTING to claude for any unset/unknown kind — so a session is codex ONLY
  // when it was dispatched codex, and every claude path is byte-identical to before.
  const claudeBackend = createClaudeBackend({ logDir: defaultLogDir(project), claudeBin: opts.claudeBin })
  const codexBackend = createCodexBackend({})
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const codexAppServer = codexAppServerBridgeEnabled()
    ? createCodexAppServerBridge({
        projectId: project.id,
        projectDir: project.dir,
        dbPath,
        interactions: storage.interactions,
        codexBin: opts.codexBin,
      })
    : undefined
  resources.codexAppServer = codexAppServer
  if (codexAppServer) {
    contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
      codexAppServer.releaseSession(
        event.previous.slug,
        event.previous.session_id,
        event.type === "replaced" ? "session-replaced" : "session-deleted",
      )
    }))
  }
  opts.startup?.afterPhase?.("Codex app-server bridge")

  // The tailer derives turn/liveness telemetry and, on a state change, asks the board for an
  // OVERLAY-ONLY refresh (tailer changes never alter .fray content — the full shell-out rebuild
  // here was the source of multi-second RPC stalls). Late-bound `board` breaks the cycle.
  // It ALSO reports, per tick, which sessions' JSONL advanced → fanned out on transcriptChange so the
  // /ws transcript producer can push (no board dependency; the two signals are independent).
  const tailer = createTailer({
    project,
    storage,
    bus,
    backendFor,
    onChange: () => board.refresh(),
    onTranscriptChange: (slugs) => transcriptChange.emit(slugs),
  })
  resources.tailer = tailer
  opts.startup?.afterPhase?.("tailer")
  board = createBoard(project, storage, bus, tailer, bootId)
  resources.board = board
  opts.startup?.afterPhase?.("board watcher")
  const permissionController = createPermissionController({
    storage,
    tailer,
    board,
    reattach: (slug, current, requested, onGeneration) =>
      reattachThreadWithPermission(
        { project, storage, board, getSettings: () => getSettings(storage), backendFor },
        slug,
        current,
        requested,
        onGeneration,
      ),
  })
  resources.permissionController = permissionController
  opts.startup?.afterPhase?.("permission producer")
  const profileController = createProfileController({
    storage,
    tailer,
    board,
    reattach: (slug, current, requested, onGeneration, onCheckpoint) =>
      reattachThreadWithProfile(
        { project, storage, board, getSettings: () => getSettings(storage), backendFor },
        slug,
        current,
        requested,
        onGeneration,
        onCheckpoint,
      ),
    recover: (row, journal, observation) => recoverThreadProfileHandoff(
      { project, storage, board, getSettings: () => getSettings(storage), backendFor },
      row,
      journal,
      observation,
    ),
  })
  resources.profileController = profileController
  opts.startup?.afterPhase?.("profile producer")
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => getSettings(storage),
    claudeBin: opts.claudeBin,
    backendFor,
    // Auth preflight (claude-auth plan, Slice A): Claude asks its own CLI (`claude auth status
    // --json`, run in the project cwd with the dispatch executable); Codex reads the local
    // auth.json/env. Both block only on a positive "signed-out" — everything else fails open.
    preflightAuth: (kind) =>
      kind === "codex"
        ? Promise.resolve(readCodexAuthState())
        : readClaudeAuthStatusCli({ claudeBin: opts.claudeBin, cwd: project.dir }),
  })

  // Confirmed timer / external-review waits reuse the same durable resume path as follow-up. Merely
  // writing an awaiting fence never arms this scheduler; the operator confirmation in SQLite does.
  const scheduler = createScheduler({
    storage,
    tailer,
    resume: (slug, message, deliveryId, expectedSessionId) => {
      const deliveryMessage = `${message}\n\n${wakeDeliveryToken(deliveryId)}`
      const row = storage.getSession(slug)
      if (row?.session_id === expectedSessionId && row.backend === "codex") {
        const binding = adoptionRuntimeBinding(storage, row)
        const live = binding.kind === "unbound"
          ? tmux.isLive(slug)
          : binding.kind === "bound" && tmux.findExpectedAdoptionPane(binding.claim).kind === "found"
        if (live) {
          permissionController.queueFollowUp(slug, deliveryMessage, deliveryId, expectedSessionId)
          return
        }
      }
      resumeThread(
        { project, storage, board, getSettings: () => getSettings(storage), backendFor },
        slug,
        deliveryMessage,
        expectedSessionId,
      )
    },
    onWaitChange: () => board.refresh(),
  })
  resources.scheduler = scheduler
  opts.startup?.afterPhase?.("wake scheduler")

  return {
    bootId,
    project,
    bus,
    transcriptChange,
    storage,
    interactions: storage.interactions,
    codexAppServer,
    board,
    tailer,
    dispatcher,
    scheduler,
    permissionController,
    profileController,
    stopSubscriptions,
    backendFor,
    getSettings: () => getSettings(storage),
    setSettings: (s) => setSettings(storage, s),
    resetSettings: () => resetSettings(storage),
    claudeBin: opts.claudeBin,
    codexBin: opts.codexBin,
    loginUtility: createLoginUtility({ claudeBin: opts.claudeBin, codexBin: opts.codexBin, cwd: project.dir }),
  }
}
