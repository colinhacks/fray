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
import { createScheduler, type Scheduler } from "./scheduler.ts"
import { resumeThread } from "./resume.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend } from "./backend/codex.ts"
import type { AgentBackend } from "./backend/types.ts"
import { detectGithub, type GithubDetection } from "./github.ts"
import * as tmux from "./tmux.ts"

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
  board: BoardManager
  tailer: Tailer
  dispatcher: Dispatcher
  // Per-session agent-backend resolver behind the spawn/resume/transcript seam (Codex-support epic).
  // Maps a row's `backend` column (claude|codex) to its AgentBackend; DEFAULTS to claude for any unset/
  // unknown kind, so every existing session and all current behavior are unchanged until a dispatch
  // explicitly selects codex. Shared by the dispatcher, the tailer, and every resumeThread call.
  backendFor: (kind?: string) => AgentBackend
  // The WAKERS scheduler: resumes a rested `awaiting`-fenced session when its declared timer/pr/ci
  // condition fires. Started in index.ts alongside the tailer; boot-safe (never fires on first sight).
  scheduler: Scheduler
  getSettings: () => Settings
  setSettings: (s: Settings) => Settings
  resetSettings: () => Settings
  // GitHub detection (installed/inRepo/nameWithOwner) resolved ONCE at boot via initGithub() — stable
  // for the process lifetime. `authed` is NOT cached here; the githubStatus query re-checks it live so
  // a mid-session `gh auth login` reflects immediately. Undefined until initGithub() resolves (the
  // githubStatus handler falls back to a live detect during that ~30ms window). Kept OUT of the board
  // snapshot deliberately — no gh shell-out on every board delta.
  github?: GithubDetection
}

export interface ContextOptions {
  claudeBin?: string // injectable dispatch executable (tests use a stand-in)
}

// Boot reconcile: a session row whose tmux session is no longer live was orphaned by a prior
// server exit (or the agent finished/was killed) — stamp exited so the registry doesn't show a
// forever-running ghost. Runtime is also derived live on each board build; this keeps the stored
// column honest too.
export function reconcileSessions(storage: Storage) {
  for (const row of storage.allSessions()) {
    const live = tmux.isLive(row.slug)
    if (!live && row.exited !== 1) storage.setExited(row.slug, true)
  }
}

// Resolve the stable GitHub detection triple once and cache it on ctx.github. Never throws
// (detectGithub swallows every gh failure), so it is safe to fire-and-forget at boot: a broken or
// absent gh just leaves the feature off. Called from startServer without blocking the listen — the
// githubStatus handler live-detects during the brief pre-cache window.
export async function initGithub(ctx: AppContext): Promise<void> {
  ctx.github = await detectGithub(ctx.project.dir)
}

export function createContext(opts: ContextOptions = {}): AppContext {
  const project = resolveProject()
  // Isolate this instance's tmux server by PROJECT (C3): two fray-ui instances sharing one
  // `tmux -L fray` server would collide on fray-<slug> session names. Derive the socket from the
  // stable project id BEFORE any tmux call — reconcileSessions below calls tmux.isLive, and the
  // wrong socket would find no live sessions and wrongly mark them all exited on every boot.
  // FRAY_TMUX_SOCKET pins the socket explicitly (escape hatch): used to keep an already-running
  // instance on the legacy bare `fray` socket across a bounce so its in-flight sessions aren't
  // stranded onto a fresh per-project socket. Unset → the per-project default.
  tmux.setSocket(process.env.FRAY_TMUX_SOCKET || tmux.deriveSocket(project.id))
  const storage = createStorage(join(project.stateDir, "ui.db"))
  const bus = new Bus()
  const transcriptChange = new Emitter<string[]>()
  const bootId = randomUUID()

  reconcileSessions(storage)

  // The agent backends behind the spawn/resume/transcript seam (Codex-support epic). The ClaudeBackend's
  // transcript dir matches the tailer's (defaultLogDir) so foreign-scan + per-session path stay
  // consistent; the CodexBackend uses $CODEX_HOME (default ~/.codex). `backendFor` maps a row's `backend`
  // column to the right one, DEFAULTING to claude for any unset/unknown kind — so a session is codex ONLY
  // when it was dispatched codex, and every claude path is byte-identical to before.
  const claudeBackend = createClaudeBackend({ logDir: defaultLogDir(project), claudeBin: opts.claudeBin })
  const codexBackend = createCodexBackend({})
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)

  // The tailer derives turn/liveness telemetry and, on a state change, asks the board for an
  // OVERLAY-ONLY refresh (tailer changes never alter .fray content — the full shell-out rebuild
  // here was the source of multi-second RPC stalls). Late-bound `board` breaks the cycle.
  // It ALSO reports, per tick, which sessions' JSONL advanced → fanned out on transcriptChange so the
  // /ws transcript producer can push (no board dependency; the two signals are independent).
  let board: BoardManager
  const tailer = createTailer({
    project,
    storage,
    bus,
    backendFor,
    onChange: () => board.refresh(),
    onTranscriptChange: (slugs) => transcriptChange.emit(slugs),
  })
  board = createBoard(project, storage, bus, tailer, bootId)
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => getSettings(storage),
    claudeBin: opts.claudeBin,
    backendFor,
  })

  // Wakers: on each tick, resume any at-rest `awaiting` session whose timer/pr/ci condition just
  // fired. Reuses the SAME resume path as the followUp RPC (resumeThread) so a fired wake is
  // indistinguishable from a human steer. Boot-safe: only fires on a condition it witnesses cross.
  const scheduler = createScheduler({
    storage,
    tailer,
    resume: (slug, message) => resumeThread({ project, storage, board, getSettings: () => getSettings(storage), backendFor }, slug, message),
  })

  return {
    bootId,
    project,
    bus,
    transcriptChange,
    storage,
    board,
    tailer,
    dispatcher,
    scheduler,
    backendFor,
    getSettings: () => getSettings(storage),
    setSettings: (s) => setSettings(storage, s),
    resetSettings: () => resetSettings(storage),
  }
}
