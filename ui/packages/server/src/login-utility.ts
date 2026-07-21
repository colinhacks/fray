import { randomBytes } from "node:crypto"
import type { Backend } from "@fray-ui/shared"
import { tmuxSessionName } from "@fray-ui/shared"
import * as tmux from "./tmux.ts"

// Slice B of the claude-auth plan: a restricted, short-lived provider ACCOUNT utility — the terminal
// behind the sign-in modal's primary "Sign in" action. This is NOT the agent-thread terminal: it
// never resumes or mutates a worker, inherits no project prompt, and accepts no arbitrary shell
// command — the tmux session runs exactly the provider's own login argv (`claude auth login`) and
// nothing else, spawned WITHOUT an intervening shell.
//
// Addressing: each attempt gets an opaque, server-issued, slug-SHAPED id ("login-<16 hex>", 64
// random bits). Being slug-shaped lets the attempt ride the existing hardened /term/<slug> transport
// (same input/output/viewer bounds) — index.ts resolves an attempt id BEFORE consulting the session
// registry, and no registry row ever exists for one, so the board/tailer/adoption never see it.
//
// Ephemerality: login output (OAuth URLs, pasted codes) lives only in the tmux pane and the bounded
// WS byte stream — never in a transcript, SQLite, scratchpads, or server logs. Teardown kills the
// tmux session on cancel, success detection, timeout, or server shutdown.

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000 // a browser-OAuth round trip, generously bounded

export interface LoginAttemptStatus {
  // "running" = the login CLI is still interactive; "exited" = it finished (either way — the caller
  // re-reads the credential state for the verdict); "unknown" = the pane could not be inspected.
  state: "running" | "exited" | "unknown"
  // The provider this attempt signs into; undefined once the attempt is gone/never existed.
  backend?: Backend
}

export interface LoginUtility {
  // Starts (or returns the existing) login attempt for a provider. At most ONE live attempt per
  // provider per fray server — a second Sign in click attaches to the same terminal rather than
  // racing two OAuth flows against one credential store.
  start(backend: Backend): { attemptId: string }
  // True iff this slug-shaped id addresses a live attempt (the /term transport's gate).
  attachArgs(slug: string): string[] | null
  status(attemptId: string): LoginAttemptStatus
  cancel(attemptId: string): void
  stop(): void
}

interface LiveAttempt {
  id: string
  backend: Backend
  timer: NodeJS.Timeout
}

export function createLoginUtility(deps: {
  claudeBin?: string
  codexBin?: string
  // The cwd for the spawned CLI. Login is account-global, but the CLI still wants a valid cwd.
  cwd: string
  lifetimeMs?: number
  // Injectable seams so tests never touch a real tmux server.
  spawn?: typeof tmux.spawn
  ensureServer?: typeof tmux.ensureServer
  killSession?: typeof tmux.killSession
  hasSession?: typeof tmux.hasSession
  lookupPane?: typeof tmux.lookupAdoptionPane
}): LoginUtility {
  const spawn = deps.spawn ?? tmux.spawn
  const ensureServer = deps.ensureServer ?? tmux.ensureServer
  const killSession = deps.killSession ?? tmux.killSession
  const hasSession = deps.hasSession ?? tmux.hasSession
  const lookupPane = deps.lookupPane ?? tmux.lookupAdoptionPane
  const lifetimeMs = deps.lifetimeMs ?? ATTEMPT_LIFETIME_MS
  const attempts = new Map<string, LiveAttempt>()

  function loginArgv(backend: Backend): string[] {
    return backend === "codex" ? [deps.codexBin ?? "codex", "login"] : [deps.claudeBin ?? "claude", "auth", "login"]
  }

  function teardown(id: string): void {
    const attempt = attempts.get(id)
    if (!attempt) return
    clearTimeout(attempt.timer)
    attempts.delete(id)
    try {
      killSession(id)
    } catch {
      // Already gone — teardown is idempotent.
    }
  }

  return {
    start(backend) {
      for (const attempt of attempts.values()) {
        if (attempt.backend !== backend) continue
        // Reuse only a still-live session; a vanished one (killed externally) is replaced.
        if (hasSession(attempt.id)) return { attemptId: attempt.id }
        teardown(attempt.id)
      }
      const id = `login-${randomBytes(8).toString("hex")}`
      ensureServer()
      spawn(id, loginArgv(backend), deps.cwd)
      const timer = setTimeout(() => teardown(id), lifetimeMs)
      timer.unref?.()
      attempts.set(id, { id, backend, timer })
      return { attemptId: id }
    },
    attachArgs(slug) {
      if (!attempts.has(slug)) return null
      return ["attach-session", "-t", tmuxSessionName(slug)]
    },
    status(attemptId) {
      const attempt = attempts.get(attemptId)
      if (!attempt) return { state: "exited" }
      // Threads spawn with remain-on-exit, so the SESSION outlives the CLI — pane_dead is the
      // authoritative "the login command finished" signal.
      const lookup = lookupPane(attemptId)
      if (lookup.kind === "found") return { state: lookup.pane.dead ? "exited" : "running", backend: attempt.backend }
      if (lookup.kind === "absent") return { state: "exited", backend: attempt.backend }
      return { state: "unknown", backend: attempt.backend }
    },
    cancel(attemptId) {
      teardown(attemptId)
    },
    stop() {
      for (const id of [...attempts.keys()]) teardown(id)
    },
  }
}
