import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { execFile } from "node:child_process"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import pty from "node-pty"
import { ThreadSlug, tmuxSessionName, type TermClientMsg } from "@fray-ui/shared"
import { expectedAdoptionAttachArgs, socketName } from "./tmux.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import type { SessionRow, Storage } from "./storage.ts"
import { isTrustedLocalWebSocketRequest, rejectWebSocketUpgrade } from "./local-origin.ts"

// One PTY per viewing client: each ws connection on /term/<slug> spawns its OWN
// `tmux -L <socket> attach-session -t fray-<slug>` through node-pty (tmux multiplexes the shared
// session across attaches). Killing the pty on ws close detaches THIS client only — the tmux
// session (and the agent) keeps running. Mirrors the M0 spike exactly. The socket is PER-PROJECT
// (tmux.socketName(), set at server init) so the attach hits the SAME server spawn() used.

const TERM_PATH = /^\/term\/([^/?]+)$/

export function resolveThreadAttach(
  storage: Pick<Storage, "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession">,
  row: Pick<SessionRow, "slug" | "session_id" | "runtime_generation">,
): string[] | null {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") return null
  if (binding.kind === "bound") return expectedAdoptionAttachArgs(binding.claim)
  return ["attach-session", "-t", tmuxSessionName(row.slug)]
}

// Keep the raw websocket bounded before JSON parsing, and independently validate the decoded input.
// A terminal paste may reasonably be large, but accepting ws's 100 MiB default would let one local
// client pin the control plane. Grid dimensions are deliberately far above any real xterm viewport
// while staying comfortably inside node-pty/tmux's useful range.
export const TERMINAL_MAX_INPUT_BYTES = 1_048_576
export const TERMINAL_MAX_MESSAGE_BYTES = TERMINAL_MAX_INPUT_BYTES + 1_024
export const TERMINAL_MAX_COLS = 1_000
export const TERMINAL_MAX_ROWS = 1_000
export const TERMINAL_MAX_OUTPUT_BUFFER_BYTES = 4 * 1_024 * 1_024
export const TERMINAL_MAX_VIEWERS = 32
export const TERMINAL_MAX_VIEWERS_PER_SLUG = 8
export const TERMINAL_INPUT_RATE_WINDOW_MS = 1_000
export const TERMINAL_MAX_INPUT_FRAMES_PER_WINDOW = 120
export const TERMINAL_MAX_INPUT_BYTES_PER_WINDOW = 2 * TERMINAL_MAX_MESSAGE_BYTES
export const TERMINAL_CLOSE_GRACE_MS = 250
export const TERMINAL_SHUTDOWN_GRACE_MS = 500
export const TERMINAL_REFRESH_AFTER_RESIZE_MS = 180
export const TERMINAL_SETTLED_REFRESH_AFTER_RESIZE_MS = 700
export const TERMINAL_REFRESH_AFTER_CLEAR_MS = 180
const TERMINAL_REFRESH_OUTPUT_SUPPRESS_MS = 120
const ERASE_DISPLAY = /\x1b\[[0-3]?J/

export function parseTermClientMsg(raw: string): TermClientMsg | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const msg = value as Record<string, unknown>
  if (msg.t === "input") {
    if (
      Object.keys(msg).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(msg, "d") ||
      typeof msg.d !== "string" ||
      Buffer.byteLength(msg.d, "utf8") > TERMINAL_MAX_INPUT_BYTES
    ) return null
    return { t: "input", d: msg.d }
  }
  if (msg.t === "resize") {
    if (
      Object.keys(msg).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(msg, "cols") ||
      !Object.prototype.hasOwnProperty.call(msg, "rows")
    ) return null
    const cols = msg.cols
    const rows = msg.rows
    if (
      !Number.isFinite(cols) ||
      !Number.isInteger(cols) ||
      !Number.isFinite(rows) ||
      !Number.isInteger(rows) ||
      (cols as number) < 1 ||
      (rows as number) < 1 ||
      (cols as number) > TERMINAL_MAX_COLS ||
      (rows as number) > TERMINAL_MAX_ROWS
    ) {
      return null
    }
    return { t: "resize", cols: cols as number, rows: rows as number }
  }
  return null
}

export function parseTermSlug(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0]
  const m = path.match(TERM_PATH)
  if (!m) return null
  const parsed = ThreadSlug.safeParse(m[1])
  return parsed.success ? parsed.data : null
}

export interface TerminalServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
}

export interface TerminalServerDeps {
  spawnPty?: typeof pty.spawn
  socketName?: () => string
  maxOutputBufferBytes?: number
  maxViewers?: number
  maxViewersPerSlug?: number
  inputRateWindowMs?: number
  maxInputFramesPerWindow?: number
  maxInputBytesPerWindow?: number
  closeGraceMs?: number
  shutdownGraceMs?: number
  now?: () => number
  terminateSocket?: (ws: WebSocket) => void
  refreshDelaysMs?: readonly number[]
  refreshAfterClearMs?: number
  refreshClient?: (socket: string, term: ReturnType<typeof pty.spawn>) => void
  // Production uses this to enforce a finalized adoption's exact token+pane generation before a
  // slug-targeted tmux attach. Default true preserves the isolated transport-test seam.
  canAttach?: (slug: string) => boolean
  // Production resolver. A finalized adoption returns one tmux `if-shell` argv whose ownership
  // predicate and exact-pane attach execute together; null rejects before a PTY exists. Kept
  // separate from canAttach so older transport doubles remain small.
  resolveAttach?: (slug: string) => string[] | null
}

// node-pty does not expose the Unix slave path in IPty's public typings, but its UnixTerminal
// implementation keeps it in `_pty`; tmux uses that path as the client name. A full client refresh
// after SIGWINCH is required because a full-screen app can race tmux's own resize replay: tmux first
// sends the populated screen, then a late clear plus cursor-only diff can leave the browser's buffer
// blank even though capture-pane is correct. Refreshing this one attach replays the authoritative
// tmux grid without disturbing the worker or other viewers.
function refreshTmuxClient(socket: string, term: ReturnType<typeof pty.spawn>): void {
  const client = (term as unknown as { _pty?: unknown })._pty
  if (typeof client !== "string" || !client.startsWith("/dev/")) return
  try {
    const child = execFile("tmux", ["-L", socket, "refresh-client", "-t", client], () => {})
    child.unref()
  } catch {
    // A detach can race the timer. The WebSocket remains usable and a reconnect still replays tmux.
  }
}

// noServer mode: index.ts owns the single http server and routes upgrades here. Returns true
// iff the request was a /term/<slug> upgrade we claimed.
export function createTerminalServer(deps: TerminalServerDeps = {}): TerminalServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_MAX_MESSAGE_BYTES })
  let closing = false
  let closePromise: Promise<void> | null = null
  const spawnPty = deps.spawnPty ?? pty.spawn
  const activeSocketName = deps.socketName ?? socketName
  const configuredInteger = (value: number | undefined, fallback: number, minimum = 0) =>
    value !== undefined && Number.isSafeInteger(value) && value >= minimum ? value : fallback
  const maxOutputBufferBytes = configuredInteger(
    deps.maxOutputBufferBytes,
    TERMINAL_MAX_OUTPUT_BUFFER_BYTES,
  )
  const maxViewers = configuredInteger(deps.maxViewers, TERMINAL_MAX_VIEWERS)
  const maxViewersPerSlug = configuredInteger(
    deps.maxViewersPerSlug,
    TERMINAL_MAX_VIEWERS_PER_SLUG,
  )
  const inputRateWindowMs = configuredInteger(
    deps.inputRateWindowMs,
    TERMINAL_INPUT_RATE_WINDOW_MS,
    1,
  )
  const maxInputFramesPerWindow = configuredInteger(
    deps.maxInputFramesPerWindow,
    TERMINAL_MAX_INPUT_FRAMES_PER_WINDOW,
  )
  const maxInputBytesPerWindow = configuredInteger(
    deps.maxInputBytesPerWindow,
    TERMINAL_MAX_INPUT_BYTES_PER_WINDOW,
  )
  const closeGraceMs = configuredInteger(deps.closeGraceMs, TERMINAL_CLOSE_GRACE_MS)
  const shutdownGraceMs = configuredInteger(
    deps.shutdownGraceMs,
    TERMINAL_SHUTDOWN_GRACE_MS,
  )
  const now = deps.now ?? Date.now
  const terminateSocket = deps.terminateSocket ?? ((ws: WebSocket) => ws.terminate())
  const refreshDelaysMs = deps.refreshDelaysMs ?? [TERMINAL_REFRESH_AFTER_RESIZE_MS, TERMINAL_SETTLED_REFRESH_AFTER_RESIZE_MS]
  const refreshAfterClearMs = deps.refreshAfterClearMs ?? TERMINAL_REFRESH_AFTER_CLEAR_MS
  const refreshClient = deps.refreshClient ?? refreshTmuxClient
  let viewerCount = 0
  const viewersPerSlug = new Map<string, number>()

  interface Reservation {
    slug: string
    release(): void
  }
  interface Viewer {
    cleanup(): void
    shutdown(): void
  }
  interface PendingUpgrade {
    abort(status?: number, reason?: string): void
  }

  const viewers = new Set<Viewer>()
  const pendingUpgrades = new Set<PendingUpgrade>()

  const reserveViewer = (slug: string): Reservation | null => {
    const slugCount = viewersPerSlug.get(slug) ?? 0
    if (viewerCount >= maxViewers || slugCount >= maxViewersPerSlug) return null
    viewerCount += 1
    viewersPerSlug.set(slug, slugCount + 1)
    let released = false
    return {
      slug,
      release() {
        if (released) return
        released = true
        viewerCount -= 1
        const nextSlugCount = (viewersPerSlug.get(slug) ?? 1) - 1
        if (nextSlugCount <= 0) viewersPerSlug.delete(slug)
        else viewersPerSlug.set(slug, nextSlugCount)
      },
    }
  }

  const rawDataBuffer = (raw: RawData): Buffer => {
    if (Buffer.isBuffer(raw)) return raw
    if (Array.isArray(raw)) return Buffer.concat(raw)
    return Buffer.from(raw)
  }

  // noServer still emits operational errors (for example a malformed extension negotiation). Contain
  // them to this transport; individual socket/PTY failures have their own close paths below.
  wss.on("error", () => {})

  const acceptViewer = (ws: WebSocket, slug: string, reservation: Reservation): void => {
    let term: ReturnType<typeof pty.spawn> | undefined
    let tmuxSocket = ""
    let cleaned = false
    let closeStarted = false
    let terminated = false
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined
    let dataSubscription: { dispose(): void } | undefined
    let exitSubscription: { dispose(): void } | undefined
    let refreshTimers: ReturnType<typeof setTimeout>[] = []
    let clearRefreshTimer: ReturnType<typeof setTimeout> | undefined
    let outputControlTail = ""
    let suppressOutputRefreshUntil = 0
    const inputWindow: Array<{ at: number; bytes: number }> = []
    let inputWindowBytes = 0

    const clearRefreshTimers = () => {
      for (const timer of refreshTimers) clearTimeout(timer)
      refreshTimers = []
      clearTimeout(clearRefreshTimer)
      clearRefreshTimer = undefined
    }

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearRefreshTimers()
      reservation.release()
      const ownedDataSubscription = dataSubscription
      dataSubscription = undefined
      const ownedExitSubscription = exitSubscription
      exitSubscription = undefined
      try {
        ownedDataSubscription?.dispose()
      } catch {
        // A node-pty implementation may already have removed its data listener during exit.
      }
      try {
        ownedExitSubscription?.dispose()
      } catch {
        // Likewise, listener disposal is best-effort but is attempted exactly once.
      }
      const ownedTerm = term
      term = undefined
      if (ownedTerm) {
        try {
          ownedTerm.kill()
        } catch {
          // The attach PTY may already have exited. It is never the underlying tmux worker.
        }
      }
    }

    let viewer: Viewer
    const forceTerminate = () => {
      if (terminated) return
      terminated = true
      cleanup()
      try {
        terminateSocket(ws)
      } catch {
        // The peer may have disappeared without delivering a close event.
      }
      viewers.delete(viewer)
    }
    const beginClose = (code: number, reason: string) => {
      if (closeStarted) return
      closeStarted = true
      cleanup()
      if (ws.readyState === WebSocket.CLOSED) {
        viewers.delete(viewer)
        return
      }
      forceCloseTimer = setTimeout(forceTerminate, closeGraceMs)
      forceCloseTimer.unref?.()
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason)
        }
      } catch {
        forceTerminate()
      }
    }
    viewer = {
      cleanup,
      shutdown() {
        closeStarted = true
        cleanup()
        forceTerminate()
      },
    }
    viewers.add(viewer)

    ws.once("close", () => {
      clearTimeout(forceCloseTimer)
      cleanup()
      viewers.delete(viewer)
    })
    ws.on("error", () => beginClose(1011, "terminal transport failed"))

    if (closing) {
      viewer.shutdown()
      return
    }

    let attachArgs: string[] | null
    try {
      if (deps.canAttach && !deps.canAttach(slug)) {
        beginClose(1008, "terminal attach denied")
        return
      }
      attachArgs = deps.resolveAttach?.(slug) ?? (deps.resolveAttach
        ? null
        : ["attach-session", "-t", tmuxSessionName(slug)])
    } catch {
      beginClose(1011, "terminal unavailable")
      return
    }
    if (!attachArgs) {
      beginClose(1008, "terminal attach denied")
      return
    }

    try {
      tmuxSocket = activeSocketName()
      term = spawnPty("tmux", ["-L", tmuxSocket, ...attachArgs], {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        env: { ...process.env, TERM: "xterm-256color" },
      })
    } catch {
      beginClose(1011, "terminal unavailable")
      return
    }

    const refreshAuthoritativeGrid = () => {
      const activeTerm = term
      if (cleaned || !activeTerm || ws.readyState !== WebSocket.OPEN) return
      // `refresh-client` output can itself contain an erase-display while clearing rows below the
      // replayed grid. Suppress that immediate echo so a repair never schedules itself forever.
      suppressOutputRefreshUntil = Date.now() + TERMINAL_REFRESH_OUTPUT_SUPPRESS_MS
      try {
        refreshClient(tmuxSocket, activeTerm)
      } catch {
        // A test/custom refresher or a detach may fail synchronously; keep this viewer alive.
      }
    }

    const acceptInputSample = (bytes: number): boolean => {
      const at = now()
      const cutoff = at - inputRateWindowMs
      while (inputWindow.length > 0 && inputWindow[0]!.at <= cutoff) {
        inputWindowBytes -= inputWindow.shift()!.bytes
      }
      if (
        inputWindow.length + 1 > maxInputFramesPerWindow ||
        inputWindowBytes + bytes > maxInputBytesPerWindow
      ) {
        return false
      }
      inputWindow.push({ at, bytes })
      inputWindowBytes += bytes
      return true
    }

    try {
      dataSubscription = term.onData((d) => {
        if (cleaned || ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount + Buffer.byteLength(d, "utf8") > maxOutputBufferBytes) {
          // Release the PTY and viewer reservation immediately. A short close grace lets a healthy
          // peer receive 1013; a wedged peer is forcibly terminated without retaining resources.
          beginClose(1013, "terminal viewer overloaded")
          return
        }
        const controlWindow = outputControlTail + d
        outputControlTail = controlWindow.slice(-8)
        if (Date.now() >= suppressOutputRefreshUntil && ERASE_DISPLAY.test(controlWindow)) {
          // Full-screen TUIs can leave tmux's authoritative pane correct while sending this attach a
          // late clear plus cursor-only diff. Debounce until the app's final clear, then replay only
          // this viewer. Plain/slow terminal output never pays for a full-grid refresh.
          clearTimeout(clearRefreshTimer)
          clearRefreshTimer = setTimeout(refreshAuthoritativeGrid, refreshAfterClearMs)
        }
        try {
          ws.send(d, (error) => {
            if (error) beginClose(1011, "terminal transport failed")
          })
        } catch {
          beginClose(1011, "terminal transport failed")
        }
      })
      exitSubscription = term.onExit(({ exitCode }) => {
        if (!cleaned) beginClose(1000, `pty exit ${exitCode}`)
      })
    } catch {
      beginClose(1011, "terminal unavailable")
      return
    }

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (cleaned) return
      if (isBinary) {
        beginClose(1003, "terminal text frames required")
        return
      }
      const payload = rawDataBuffer(raw)
      if (!acceptInputSample(payload.byteLength)) {
        beginClose(1013, "terminal input rate limited")
        return
      }
      const msg = parseTermClientMsg(payload.toString("utf8"))
      if (!msg) {
        beginClose(1008, "invalid terminal message")
        return
      }
      const activeTerm = term
      if (!activeTerm) return
      try {
        if (msg.t === "input") activeTerm.write(msg.d)
        else {
          activeTerm.resize(msg.cols, msg.rows)
          clearRefreshTimers()
          // The early replay repairs an ordinary SIGWINCH redraw race. Server replacement can also
          // cause the booting page to attach, reload on boot-id change, and attach again; Codex may
          // emit its final clear after the first replay in that sequence, so replay once more after
          // the client settles. Both refresh only this viewer and use tmux's authoritative grid.
          refreshTimers = refreshDelaysMs.map((delayMs) =>
            setTimeout(refreshAuthoritativeGrid, delayMs),
          )
        }
      } catch {
        // A valid message can still race a dead/detached PTY. Contain that failure to this viewer;
        // the Fray control plane and independent tmux worker must survive.
        beginClose(1011, "terminal unavailable")
      }
    })
  }

  return {
    handleUpgrade(req, socket, head) {
      const slug = parseTermSlug(req.url)
      if (slug === null) return false
      if (closing) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable")
        return true
      }
      // A terminal attach is direct keyboard authority over a live agent. Browser upgrades must carry
      // the exact same loopback Origin as Host; missing, cross-origin, forwarded, and DNS-prefix claims
      // are denied before a PTY exists.
      if (!isTrustedLocalWebSocketRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return true
      }

      // Reserve synchronously before websocket negotiation. This counts both established viewers and
      // upgrades in flight, so concurrent handshakes cannot race past either cap before spawning PTYs.
      const reservation = reserveViewer(slug)
      if (!reservation) {
        rejectWebSocketUpgrade(socket, 429, "Too Many Requests")
        return true
      }

      let finished = false
      const finishPending = (): boolean => {
        if (finished) return false
        finished = true
        pendingUpgrades.delete(pending)
        socket.removeListener("close", abandonPending)
        socket.removeListener("error", abandonPending)
        return true
      }
      const abandonPending = () => {
        if (finishPending()) reservation.release()
      }
      const pending: PendingUpgrade = {
        abort(status, reason) {
          if (!finishPending()) return
          reservation.release()
          if (status) rejectWebSocketUpgrade(socket, status, reason)
          else {
            try {
              socket.destroy()
            } catch {
              // The peer already left while its handshake was in flight.
            }
          }
        },
      }
      pendingUpgrades.add(pending)
      socket.once("close", abandonPending)
      socket.once("error", abandonPending)

      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (!finishPending()) {
            try {
              ws.terminate()
            } catch {
              // Shutdown already reclaimed the in-flight upgrade.
            }
            return
          }
          try {
            acceptViewer(ws, slug, reservation)
          } catch {
            reservation.release()
            try {
              ws.terminate()
            } catch {
              // A failed setup owns no PTY and cannot escape the transport boundary.
            }
          }
        })
      } catch {
        pending.abort(400, "Bad Request")
      }
      return true
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        // Reclaim all owned PTYs, reservations, listeners and timers synchronously. Socket close
        // events are advisory during replacement: a bounded server drain prevents a broken peer or
        // mocked transport from keeping the old control-plane process alive indefinitely.
        for (const pending of [...pendingUpgrades]) {
          pending.abort(503, "Service Unavailable")
        }
        for (const viewer of [...viewers]) viewer.shutdown()

        let drainTimer: ReturnType<typeof setTimeout> | undefined
        const boundedServerDrain = new Promise<void>((resolve) => {
          let resolved = false
          const finish = () => {
            if (resolved) return
            resolved = true
            clearTimeout(drainTimer)
            resolve()
          }
          drainTimer = setTimeout(finish, shutdownGraceMs)
          try {
            wss.close(finish)
          } catch {
            finish() // Idempotent shutdown after a failed boot/upgrade.
          }
        })
        await boundedServerDrain
        viewers.clear()
      })()
      return closePromise
    },
  }
}
