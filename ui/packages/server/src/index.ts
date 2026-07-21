export type { AppRouter } from "./router.ts"

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { join, resolve, extname, normalize } from "node:path"
import { DEFAULT_PORT } from "@fray-ui/shared"
import {
  ContextStartupError,
  createContext,
  initGithub,
  type AppContext,
  type ContextOptions,
  type ContextStartupFence,
} from "./context.ts"
import { createApp, type AppOptions } from "./app.ts"
import { createTerminalServer, resolveThreadAttach } from "./terminal.ts"
import { createAppSocketServer, makeTranscriptReader } from "./app-socket.ts"
import {
  createRetryableCleanup,
  createShutdownBarrier,
  DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
  type ShutdownBarrier,
  type ShutdownBarrierOptions,
  type ShutdownDiagnostic,
} from "./shutdown.ts"
import { projectLaunchTarget, resolveProject, type Project } from "./project.ts"
import {
  acquireProjectLaunchOwner,
  currentProcessGeneration,
  projectLaunchTokenProof,
  registerProjectLaunchDelegate,
  removeProjectStatus,
  writeProjectStatus,
  type ProjectLaunchDelegateLease,
  type ProjectLaunchLease,
  type ProcessGeneration,
} from "./project-launch.ts"
import * as tmux from "./tmux.ts"

export const SERVER_SHUTDOWN_TIMEOUT_MS = 4_000
export const SERVER_FORCE_EXIT_MS = 5_000

export type ServerStartupPhase =
  | "launch ownership"
  | "context"
  | "GitHub initialization"
  | "application"
  | "terminal transport"
  | "application socket"
  | "board producer"
  | "tailer producer"
  | "permission producer"
  | "profile producer"
  | "wake scheduler"
  | "Vite"
  | "HTTP server"
  | "HTTP listen"
  | "status publication"
  | "signal handlers"

type HttpServer = ReturnType<typeof createServer>
type TerminalServer = ReturnType<typeof createTerminalServer>
type AppSocketServer = ReturnType<typeof createAppSocketServer>
type ViteServer = import("vite").ViteDevServer

/** Dependency seam for deterministic startup-rollback tests. Production callers must not set it. */
export interface StartServerRuntime {
  createContext(options: ContextOptions): AppContext | Promise<AppContext>
  initGithub(ctx: AppContext): Promise<void>
  createApp(ctx: AppContext, options: AppOptions): ReturnType<typeof createApp>
  createTerminal(options: Parameters<typeof createTerminalServer>[0]): TerminalServer
  createAppSocket(options: Parameters<typeof createAppSocketServer>[0]): AppSocketServer
  createVite(options: {
    root: string
    server: { middlewareMode: true; hmr: { port: number } }
    appType: "custom"
  }): Promise<ViteServer>
  createHttpServer(listener: (req: IncomingMessage, res: ServerResponse) => void): HttpServer
  currentProcessGeneration(): ProcessGeneration
  writeStatus(path: string, value: Record<string, unknown>): void
  removeStatus(
    path: string,
    expected: { pid: number; processStart: string; publisherToken: string; ownerToken: string },
  ): boolean
  afterPhase?(phase: ServerStartupPhase): void | Promise<void>
  shutdownDeadline?: ShutdownBarrierOptions["deadline"]
}

const defaultStartServerRuntime: StartServerRuntime = {
  createContext,
  initGithub,
  createApp,
  createTerminal: createTerminalServer,
  createAppSocket: createAppSocketServer,
  createVite: async (options) => {
    const { createServer: createVite } = await import("vite")
    return createVite(options)
  },
  createHttpServer: (listener) => createServer(listener),
  currentProcessGeneration,
  writeStatus: writeProjectStatus,
  removeStatus: removeProjectStatus,
}

export interface ServerShutdownFence {
  /** True until every live resource is drained, exact status is retired, and ownership is released. */
  readonly ownershipRetained: boolean
  /** Current authoritative cleanup attempt. It rejects while the ownership fence must remain. */
  whenSafe(): Promise<void>
  /** Retry idempotent cleanup after a diagnosed failure, then release the retained fence on success. */
  recover(): Promise<void>
}

export class ServerStartupError extends Error {
  readonly phase: ServerStartupPhase
  readonly startupError: unknown
  readonly cleanupError: unknown
  readonly diagnostics: readonly ShutdownDiagnostic[]
  readonly fence: ServerShutdownFence

  constructor(options: {
    phase: ServerStartupPhase
    startupError: unknown
    cleanupError?: unknown
    diagnostics: readonly ShutdownDiagnostic[]
    fence: ServerShutdownFence
  }) {
    const startupMessage = options.startupError instanceof Error ? options.startupError.message : String(options.startupError)
    const cleanupMessage = options.cleanupError instanceof Error ? `; rollback failed: ${options.cleanupError.message}` : ""
    super(`Fray server startup failed during ${options.phase}: ${startupMessage}${cleanupMessage}`, {
      cause: options.startupError,
    })
    this.name = "ServerStartupError"
    this.phase = options.phase
    this.startupError = options.startupError
    this.cleanupError = options.cleanupError
    this.diagnostics = [...options.diagnostics]
    this.fence = options.fence
  }
}

export interface StartOptions {
  dev?: boolean
  port?: number
  claudeBin?: string // injectable dispatch executable (used by tests / a stand-in)
  // The dev supervisor owns signals itself and asks the child to close explicitly. Standalone/prod
  // callers keep the historical signal behavior by leaving this enabled.
  installSignalHandlers?: boolean
  // A supervised generation is a launch validator, not an API-only fallback: broken Vite config or
  // startup must fail before the child announces ready so the old parent watcher can await a fix.
  requireDevWeb?: boolean
  /** Verified immutable web artifact for stable mode; avoids reading web/dist from the checkout. */
  webDistDir?: string
  shutdownTimeoutMs?: number
  shutdownDiagnostic?: (event: ShutdownDiagnostic) => void
  /** Internal: a supervisor-verified pinned project and its delegated owner token. */
  project?: Project
  launchOwnerToken?: string
  /** Internal token-bound path used by a supervised child to ask its durable owner to stop. */
  requestOwnerStop?: () => void
  /** Internal deterministic fixture seam; never configured by production launchers. */
  runtime?: Partial<StartServerRuntime>
}

export interface StartedServer {
  httpServer: HttpServer
  ctx: AppContext
  port: number
  close(): Promise<void>
  readonly shutdownFence: ServerShutdownFence
}

const isApiUrl = (url: string) =>
  url.startsWith("/rpc") || url.startsWith("/events") || url === "/health" || url === "/control/stop"
  || url.startsWith("/local-image") || url === "/attach"

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

// Bridge a node req/res through Hono's fetch handler (Web Request/Response). Streams the body so
// SSE stays live. Adapted from gent's dev server.
async function pipeToApp(
  app: ReturnType<typeof createApp>,
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  controller: AbortController,
) {
  const url = `http://127.0.0.1:${port}${req.url ?? "/"}`
  req.on("close", () => controller.abort())
  const response = await app.fetch(
    new Request(url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v as string)]),
      ),
      body: req.method !== "GET" && req.method !== "HEAD" ? (req as unknown as BodyInit) : undefined,
      // @ts-expect-error duplex is required by node's fetch when streaming a request body
      duplex: "half",
      signal: controller.signal,
    }),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body) {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || !res.writable) break
        res.write(value)
      }
    } catch {
      // client went away mid-stream
    }
  }
  res.end()
}

export interface ShutdownSignalHandlerOptions {
  close: () => Promise<void>
  exit: (code: number) => void
  error?: (line: string) => void
  forceAfterMs?: number
  scheduleForce?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

/** One handler is shared by SIGINT and SIGTERM so a second signal cannot start a competing close. */
export function createShutdownSignalHandler(options: ShutdownSignalHandlerOptions): () => void {
  let started = false
  return () => {
    if (started) return
    started = true
    const scheduleForce = options.scheduleForce ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    const forceAfterMs = options.forceAfterMs ?? SERVER_FORCE_EXIT_MS
    let decided = false
    let force: ReturnType<typeof setTimeout> | undefined
    const decide = (code: number) => {
      if (decided) return
      decided = true
      if (force) clearTimeout(force)
      options.exit(code)
    }
    force = scheduleForce(() => {
      options.error?.(`[fray-ui] shutdown force deadline exceeded after ${forceAfterMs}ms`)
      decide(1)
    }, forceAfterMs)
    if (decided) clearTimeout(force)
    else force.unref?.()
    void options.close().then(
      () => decide(0),
      (error) => {
        options.error?.(`[fray-ui] shutdown failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
        decide(1)
      },
    )
  }
}

// Serve a built asset from web/dist, falling back to index.html for SPA routes. Path is
// normalized + confined to distDir so a request can't escape the root.
function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse) {
  const rel = normalize((req.url ?? "/").split("?")[0]).replace(/^(\.\.[/\\])+/, "")
  let file = join(distDir, rel === "/" ? "index.html" : rel)
  if (!file.startsWith(distDir)) file = join(distDir, "index.html")
  if (!existsSync(file)) file = join(distDir, "index.html") // SPA fallback
  try {
    const body = readFileSync(file)
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end("not found")
  }
}

export async function startServer(opts: StartOptions = {}): Promise<StartedServer> {
  const runtime: StartServerRuntime = { ...defaultStartServerRuntime, ...opts.runtime }
  const port = opts.port ?? DEFAULT_PORT
  const project = opts.project ?? resolveProject()
  const launchTarget = projectLaunchTarget(project)
  let ownedLaunch: ProjectLaunchLease | undefined
  let delegatedLaunch: ProjectLaunchDelegateLease | undefined
  const ownerToken = opts.launchOwnerToken
  if (ownerToken) delegatedLaunch = registerProjectLaunchDelegate(launchTarget, ownerToken)
  else ownedLaunch = acquireProjectLaunchOwner(launchTarget, "server")
  const effectiveOwnerToken = ownerToken ?? ownedLaunch!.token

  let startupPhase: ServerStartupPhase = "launch ownership"
  let ctx: AppContext | undefined
  let githubInit: Promise<void> | undefined
  let terminal: TerminalServer | undefined
  let appSocket: AppSocketServer | undefined
  let vite: ViteServer | undefined
  let httpServer: HttpServer | undefined
  let accepting = false
  let statusPath: string | undefined
  let statusIdentity: {
    pid: number
    processStart: string
    publisherToken: string
    ownerToken: string
  } | undefined
  const requestControllers = new Set<AbortController>()
  const requestTasks = new Set<Promise<void>>()
  const diagnostics: ShutdownDiagnostic[] = []
  let httpClose: Promise<void> | null = null
  let closing: Promise<void> | null = null
  let activeSafety: Promise<void> | null = null
  let recovery: Promise<void> | null = null
  let finalized = false
  let finalization: Promise<void> | null = null
  let upstreamContextFence: ContextStartupFence | undefined
  let removeSignalHandlers = () => {}
  let ownerStopHandler = opts.requestOwnerStop
  let ownerStopPending = false

  const diagnostic = (event: ShutdownDiagnostic) => {
    diagnostics.push(event)
    if (opts.shutdownDiagnostic) opts.shutdownDiagnostic(event)
    else {
      console.error(
        `[fray-ui] shutdown ${event.phase}: ${event.message}${event.error instanceof Error ? ` — ${event.error.message}` : ""}`,
      )
    }
  }

  const requestOwnerStop = () => {
    if (ownerStopHandler) ownerStopHandler()
    else ownerStopPending = true
  }

  const stopHttp = (): Promise<void> => {
    accepting = false
    for (const controller of requestControllers) controller.abort()
    if (httpClose) return httpClose
    const server = httpServer
    const attempt = new Promise<void>((resolveClose, rejectClose) => {
      if (!server?.listening) return resolveClose()
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections()
    })
    httpClose = attempt
    void attempt.catch(() => {
      if (httpClose === attempt) httpClose = null
    })
    return attempt
  }

  const cleanupHttp = createRetryableCleanup(async () => {
    const closingHttp = stopHttp()
    await Promise.all([closingHttp, Promise.allSettled([...requestTasks]).then(() => undefined)])
  })
  const cleanupTerminal = createRetryableCleanup(async () => { await terminal?.close() })
  const cleanupAppSocket = createRetryableCleanup(async () => { await appSocket?.close() })
  const cleanupTailer = createRetryableCleanup(() => ctx?.tailer.stop())
  const cleanupLoginUtility = createRetryableCleanup(() => ctx?.loginUtility?.stop())
  const cleanupPermission = createRetryableCleanup(() => ctx?.permissionController.stop())
  const cleanupProfile = createRetryableCleanup(() => ctx?.profileController?.stop())
  const cleanupSubscriptions = createRetryableCleanup(() => ctx?.stopSubscriptions())
  const cleanupScheduler = createRetryableCleanup(async () => { await ctx?.scheduler.stop() })
  const cleanupBoard = createRetryableCleanup(async () => { await ctx?.board.stop() })
  const cleanupBridge = createRetryableCleanup(async () => { await ctx?.codexAppServer?.shutdown() })
  const cleanupVite = createRetryableCleanup(async () => { await vite?.close() })
  const cleanupGithub = createRetryableCleanup(async () => { await githubInit })
  const cleanupStorage = createRetryableCleanup(() => ctx?.storage.close())

  const createLifecycleBarrier = (): ShutdownBarrier => createShutdownBarrier({
    timeoutMs: opts.shutdownTimeoutMs ?? SERVER_SHUTDOWN_TIMEOUT_MS,
    // A wedged producer (e.g. an in-flight wake delivery shelling out to tmux/git) must not stall the
    // authoritative drain until the supervisor's 15s SIGKILL. This bounds+names each phase so the
    // child's post-deadline ownership wait settles promptly instead of hanging to the hard kill.
    phaseTimeoutMs: DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
    diagnostic,
    deadline: runtime.shutdownDeadline,
    phases: [
      {
        name: "http requests",
        run: cleanupHttp,
      },
      {
        name: "terminal transport",
        run: cleanupTerminal,
      },
      {
        name: "application socket",
        run: cleanupAppSocket,
      },
      { name: "tailer producer", run: cleanupTailer },
      // Kill any live login-attempt pane so OAuth bytes never outlive the server.
      { name: "login utility", run: cleanupLoginUtility },
      { name: "permission producer", run: cleanupPermission },
      { name: "profile producer", run: cleanupProfile },
      { name: "context subscriptions", run: cleanupSubscriptions },
      { name: "wake scheduler", run: cleanupScheduler },
      { name: "board producer and watcher", run: cleanupBoard },
      {
        name: "Codex app-server bridge",
        run: cleanupBridge,
      },
      {
        name: "Vite",
        requiredForStorage: false,
        requiredForCompletion: true,
        run: cleanupVite,
      },
      {
        name: "GitHub initialization",
        requiredForStorage: false,
        requiredForCompletion: true,
        run: cleanupGithub,
      },
    ],
    closeStorage: cleanupStorage,
  })

  let lifecycle = createLifecycleBarrier()

  const finalizeOwnership = (): Promise<void> => {
    if (finalized) return Promise.resolve()
    if (finalization) return finalization
    const attempt = (async () => {
      removeSignalHandlers()
      if (statusPath && statusIdentity) runtime.removeStatus(statusPath, statusIdentity)
      // Ownership is always the final resource. A thrown status cleanup leaves this exact fence live.
      delegatedLaunch?.release()
      ownedLaunch?.release()
      finalized = true
    })()
    finalization = attempt
    void attempt.catch(() => {
      if (finalization === attempt) finalization = null
    })
    return attempt
  }

  const attachSafety = (
    barrier: ShutdownBarrier,
    contextSafety = upstreamContextFence?.whenSafe() ?? Promise.resolve(),
  ): Promise<void> => {
    const safety = Promise.all([barrier.whenDrained(), contextSafety]).then(() => finalizeOwnership())
    activeSafety = safety
    void safety.catch(() => undefined)
    return safety
  }

  const beginClose = (): Promise<void> => {
    if (closing) return closing
    const safety = attachSafety(lifecycle)
    closing = lifecycle.close().then(() => safety)
    return closing
  }

  const shutdownFence: ServerShutdownFence = {
    get ownershipRetained() {
      return !finalized
    },
    whenSafe() {
      if (finalized) return Promise.resolve()
      return activeSafety ?? Promise.reject(new Error("Fray server shutdown has not started"))
    },
    recover() {
      if (finalized) return Promise.resolve()
      if (recovery) return recovery
      accepting = false
      lifecycle = createLifecycleBarrier()
      const contextSafety = upstreamContextFence?.recover() ?? Promise.resolve()
      const safety = attachSafety(lifecycle, contextSafety)
      const attempt = lifecycle.close().then(() => safety)
      recovery = attempt
      void attempt.catch(() => {
        if (recovery === attempt) recovery = null
      })
      return attempt
    },
  }

  const cleanup = createShutdownSignalHandler({
    close: beginClose,
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })

  const phase = async <T>(
    name: ServerStartupPhase,
    operation: () => T | Promise<T>,
    commit?: (value: T) => void,
  ): Promise<T> => {
    startupPhase = name
    const value = await operation()
    // Publish a newly-created resource to the rollback ledger before an injected post-phase failure.
    commit?.(value)
    await runtime.afterPhase?.(name)
    return value
  }

  try {
    await phase("launch ownership", () => undefined)
    ctx = await phase(
      "context",
      () => runtime.createContext({
        claudeBin: opts.claudeBin,
        project,
        startup: {
          cleanupTimeoutMs: opts.shutdownTimeoutMs ?? SERVER_SHUTDOWN_TIMEOUT_MS,
          cleanupDiagnostic: diagnostic,
          cleanupDeadline: runtime.shutdownDeadline,
        },
      }),
      (value) => { ctx = value },
    )

    // Resolve GitHub detection in the background. The original promise is retained and drained on
    // rollback so even an injected/hung initializer cannot outlive ownership silently.
    startupPhase = "GitHub initialization"
    githubInit = runtime.initGithub(ctx)
    void githubInit.catch(() => undefined)
    await runtime.afterPhase?.("GitHub initialization")

    const app = await phase("application", () => runtime.createApp(ctx!, {
      port,
      ownerProof: projectLaunchTokenProof(launchTarget, effectiveOwnerToken),
      controlToken: effectiveOwnerToken,
      requestOwnerStop,
    }))
    terminal = await phase(
      "terminal transport",
      () => runtime.createTerminal({
        resolveAttach: (slug) => {
          // A live login-utility attempt (slug-shaped opaque id, no registry row) attaches to its
          // restricted `claude auth login` session; everything else requires a registered thread.
          const util = ctx!.loginUtility.attachArgs(slug)
          if (util) return util
          const row = ctx!.storage.getSession(slug)
          if (!row) return null
          return resolveThreadAttach(ctx!.storage, row)
        },
      }),
      (value) => { terminal = value },
    )
    appSocket = await phase(
      "application socket",
      () => runtime.createAppSocket({
        bus: ctx!.bus,
        bootId: ctx!.bootId,
        transcriptChange: ctx!.transcriptChange,
        boardSnapshot: () => ctx!.board.snapshot(),
        currentSeq: () => ctx!.board.currentSeq(),
        readTranscript: makeTranscriptReader(ctx!.project, ctx!.storage, ctx!.backendFor),
      }),
      (value) => { appSocket = value },
    )
    await phase("board producer", () => ctx!.board.start())
    await phase("tailer producer", () => ctx!.tailer.start())
    await phase("permission producer", () => ctx!.permissionController.start())
    await phase("profile producer", () => ctx!.profileController?.start())
    if (process.env.FRAY_WAKERS_OFF !== "1") {
      await phase("wake scheduler", () => ctx!.scheduler.start())
    } else {
      await phase("wake scheduler", () => undefined)
    }

    statusPath = join(ctx.project.stateDir, "server.lock")
    const webRoot = resolve(import.meta.dirname, "..", "..", "web")
    const distDir = opts.webDistDir ? resolve(opts.webDistDir) : join(webRoot, "dist")
    startupPhase = "Vite"
    if (opts.dev) {
      try {
        const hmrPort = port + 39000 <= 65535 ? port + 39000 : port - 1000
        vite = await runtime.createVite({
          root: webRoot,
          server: { middlewareMode: true, hmr: { port: hmrPort } },
          appType: "custom",
        })
      } catch (error) {
        if (opts.requireDevWeb) throw error
        console.warn(
          `[fray-ui] vite dev middleware unavailable — serving API only: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    await runtime.afterPhase?.("Vite")

    accepting = true
    httpServer = await phase("HTTP server", () => runtime.createHttpServer((req, res) => {
      if (!accepting) {
        res.writeHead(503, { connection: "close" })
        res.end("server shutting down")
        return
      }
      const url = req.url ?? "/"
      if (isApiUrl(url)) {
        const controller = new AbortController()
        requestControllers.add(controller)
        let task!: Promise<void>
        task = pipeToApp(app, req, res, port, controller)
          .catch(() => {
            if (!res.headersSent) res.writeHead(controller.signal.aborted ? 503 : 500)
            res.end()
          })
          .finally(() => {
            requestControllers.delete(controller)
            requestTasks.delete(task)
          })
        requestTasks.add(task)
        return
      }
      if (vite) {
        vite.middlewares(req, res, () => {
          try {
            const html = readFileSync(join(webRoot, "index.html"), "utf8")
            void vite!.transformIndexHtml(url, html).then((out) => {
              res.writeHead(200, { "content-type": "text/html" })
              res.end(out)
            })
          } catch {
            res.writeHead(404)
            res.end("web not built")
          }
        })
        return
      }
      if (existsSync(distDir)) {
        serveStatic(distDir, req, res)
        return
      }
      res.writeHead(503)
      res.end("web assets unavailable (dev vite failed to load, no dist build)")
    }), (value) => { httpServer = value })
    httpServer.keepAliveTimeout = 5000
    httpServer.headersTimeout = 10000
    httpServer.on("upgrade", (req, socket, head) => {
      if (!accepting) {
        socket.destroy()
        return
      }
      if (terminal!.handleUpgrade(req, socket, head)) return
      if (appSocket!.handleUpgrade(req, socket, head)) return
      socket.destroy()
    })

    await phase("HTTP listen", () => new Promise<void>((resolveListen, rejectListen) => {
      const server = httpServer!
      const onError = (error: Error) => rejectListen(error)
      server.once("error", onError)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError)
        resolveListen()
      })
    }))

    const processGeneration = runtime.currentProcessGeneration()
    statusIdentity = {
      pid: processGeneration.pid,
      processStart: processGeneration.processStart,
      publisherToken: ctx.bootId,
      ownerToken: effectiveOwnerToken,
    }
    await phase("status publication", () => runtime.writeStatus(statusPath!, {
      ...statusIdentity,
      projectId: project.id,
      projectDir: project.dir,
      port,
      bootId: ctx!.bootId,
    }))
    console.log(
      `[fray-ui] server on http://127.0.0.1:${port} (${opts.dev ? "dev" : "prod"}) — project ${ctx.project.name}`,
    )

    startupPhase = "signal handlers"
    if (!opts.requestOwnerStop) {
      ownerStopHandler = cleanup
      if (ownerStopPending) cleanup()
    }
    if (opts.installSignalHandlers !== false) {
      process.on("SIGINT", cleanup)
      process.on("SIGTERM", cleanup)
      removeSignalHandlers = () => {
        process.off("SIGINT", cleanup)
        process.off("SIGTERM", cleanup)
        removeSignalHandlers = () => {}
      }
    }
    await runtime.afterPhase?.("signal handlers")

    return { httpServer, ctx, port, close: beginClose, shutdownFence }
  } catch (startupError) {
    accepting = false
    let cleanupError: unknown
    let reportedStartupError = startupError
    if (startupError instanceof ContextStartupError) {
      upstreamContextFence = startupError.fence
      for (const event of startupError.diagnostics) {
        if (!diagnostics.includes(event)) diagnostics.push(event)
      }
      reportedStartupError = startupError.startupError
      cleanupError = startupError.cleanupError
      // The context already exhausted its bounded rollback. Drain the outer ledger without awaiting
      // its unbounded context fence; attachSafety releases ownership automatically if that fence later
      // proves safe, while the structured startup error returns promptly now.
      attachSafety(lifecycle)
      try {
        await lifecycle.close()
      } catch (error) {
        cleanupError = new AggregateError([startupError.cleanupError, error], "context and server rollback both failed")
      }
    } else {
      try {
        await beginClose()
      } catch (error) {
        cleanupError = error
      }
    }
    throw new ServerStartupError({
      phase: startupPhase,
      startupError: reportedStartupError,
      cleanupError,
      diagnostics,
      fence: shutdownFence,
    })
  }
}
