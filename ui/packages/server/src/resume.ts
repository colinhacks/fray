import { writeFileSync } from "node:fs"
import { tmuxSessionName, type Settings } from "@fray-ui/shared"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { AgentBackend } from "./backend/types.ts"
import { ensureCwdTrusted } from "./backend/codex.ts"
import { buildClaudeResumeCommand, workerPluginDir, scratchpadOrientation, loadWorkerPrompt } from "./dispatch.ts"
import * as tmux from "./tmux.ts"

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
  pasteText(slug: string, text: string): void
  sendKeys(slug: string, text: string): void
  killSession(slug: string): void
  ensureServer(): void
  spawn(slug: string, cmd: string[], cwd: string, env?: Record<string, string>): void
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
}

export function resumeThread(deps: ResumeDeps, slug: string, message: string): void {
  const tx = deps.tmux ?? tmux
  // A bump/resume REACTIVATES an archived thread: the maintainer messaging an Inactive (archived)
  // thread expects it back in Active. Un-archive UP FRONT — before the live/dead branch — so BOTH the
  // live-inject path (which early-returns below) and the dead-resume path reactivate uniformly; without
  // this, bumping a still-LIVE archived thread would leave it stranded in Inactive. setState clears BOTH
  // the lifecycle `state` and the legacy `archived` flag (stateStmt: state='open', archived=0), and the
  // board refresh re-sections the row via the SSE delta (sectionOf keys on `state`). Touch the row only
  // when it is actually archived so a normal live steer emits no needless per-keystroke delta. (The
  // wakers scheduler never reaches here for an archived thread — it filters them out — so this only ever
  // un-hides a thread on an EXPLICIT human bump, never auto-resurrects a deliberately-shelved one.)
  const existing = deps.storage.getSession(slug)
  if (existing && (existing.state === "archived" || existing.archived === 1)) {
    deps.storage.setState(slug, "open")
    deps.board.refresh()
  }

  if (tx.isLive(slug)) {
    if (message.includes("\n")) tx.pasteText(slug, message)
    else tx.sendKeys(slug, message)
    return
  }
  const row = deps.storage.getSession(slug)
  if (!row) throw new Error(`no session registered for ${slug}`)
  tx.killSession(slug) // clear the dead (remain-on-exit) pane so new-session can reuse the name
  tx.ensureServer()
  const permissionMode = deps.getSettings().permissionMode
  // The scratchpad orientation keys on the fray-minted session_id (unchanged by codex discovery); the
  // backend-NATIVE id (codex rollout id, pinned on agent_session_id) is what resume re-attaches +
  // `codex resume` continues. For claude, agent_session_id is NULL → session_id — byte-identical.
  const extraSystemPrompt = scratchpadOrientation(row.session_id, row.plan_path)
  const backend = deps.backendFor?.(row.backend)
  // A dead codex resume re-spawns a fresh TUI, which blocks on the trust modal for an untrusted cwd
  // exactly like a dispatch spawn — pre-arm it (idempotent; respects an existing trust choice).
  if (row.backend === "codex") ensureCwdTrusted(deps.project.dir, deps.codexHome)
  const nativeSessionId = row.agent_session_id ?? row.session_id
  const built = backend
    ? backend.buildResume({ sessionId: nativeSessionId, cwd: deps.project.dir, message, workerContract: loadWorkerPrompt(), extraSystemPrompt, permissionMode })
    : { argv: buildClaudeResumeCommand({ sessionId: nativeSessionId, permissionMode, message, pluginDir: workerPluginDir(), extraSystemPrompt }), env: {} as Record<string, string>, prewrite: [] }
  for (const f of built.prewrite) writeFileSync(f.path, f.contents)
  tx.spawn(slug, built.argv, deps.project.dir, { ...built.env, FRAY_UI_THREAD: slug })
  deps.storage.upsertSession({ ...row, tmux_name: tmuxSessionName(slug), spawned_at: new Date().toISOString(), exited: 0 })
  deps.board.refresh() // storage-only change — overlay is enough
}
