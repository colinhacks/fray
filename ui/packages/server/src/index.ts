export type { AppRouter } from "./router.ts"

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs"
import { join, resolve, extname, normalize } from "node:path"
import { DEFAULT_PORT } from "@fray-ui/shared"
import { createContext, initGithub } from "./context.ts"
import { createApp } from "./app.ts"
import { createTerminalServer } from "./terminal.ts"
import { createAppSocketServer, makeTranscriptReader } from "./app-socket.ts"

export interface StartOptions {
  dev?: boolean
  port?: number
  claudeBin?: string // injectable dispatch executable (used by tests / a stand-in)
}

const isApiUrl = (url: string) =>
  url.startsWith("/rpc") || url.startsWith("/events") || url === "/health" || url.startsWith("/local-image") || url === "/attach"

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
async function pipeToApp(app: ReturnType<typeof createApp>, req: IncomingMessage, res: ServerResponse, port: number) {
  const url = `http://127.0.0.1:${port}${req.url ?? "/"}`
  const controller = new AbortController()
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

export async function startServer(opts: StartOptions = {}) {
  const port = opts.port ?? DEFAULT_PORT
  const ctx = createContext({ claudeBin: opts.claudeBin })
  // Resolve the GitHub detection cache in the background — never blocks the listen (a broken/absent
  // gh must not delay boot); the githubStatus query live-detects until this lands (~30ms).
  void initGithub(ctx)
  const app = createApp(ctx)
  const terminal = createTerminalServer()
  // Stage-2 multiplex socket: board channel + per-thread transcript push + notify on one /ws connection.
  // Narrow deps (not the whole ctx) so the protocol stays independently testable. Coexists with /events.
  const appSocket = createAppSocketServer({
    bus: ctx.bus,
    bootId: ctx.bootId,
    transcriptChange: ctx.transcriptChange,
    boardSnapshot: () => ctx.board.snapshot(),
    currentSeq: () => ctx.board.currentSeq(),
    readTranscript: makeTranscriptReader(ctx.project, ctx.storage),
  })
  await ctx.board.start()
  ctx.tailer.start() // resume tailing every registered session (live + orphaned) from disk offset 0
  // WAKERS: resume a rested `awaiting` session when its timer/pr/ci condition fires. FRAY_WAKERS_OFF=1
  // is a kill switch — bounce a LIVE board before the scheduler is fully verified, so un-vetted
  // session-resume logic never runs against real work.
  if (process.env.FRAY_WAKERS_OFF !== "1") ctx.scheduler.start()

  const lockPath = join(ctx.project.stateDir, "server.lock")
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port }))

  // Dev: embed Vite middleware on the same port. Lazy + guarded so an incomplete web package
  // degrades this to API-only instead of crashing the server (the API is what matters for M1).
  const webRoot = resolve(import.meta.dirname, "..", "..", "web")
  const distDir = join(webRoot, "dist")
  let vite: import("vite").ViteDevServer | null = null
  if (opts.dev) {
    try {
      const { createServer: createVite } = await import("vite")
      // HMR gets its OWN websocket port, moved FAR from the fray-ui server-port range so a SECOND
      // instance's SERVER port never lands on this instance's HMR port. `port + 1` did exactly that:
      // nub on :4917 put HMR on :4918 — the scratch instance's server port — so with both running,
      // nub's live-reload silently failed and only a manual page reload showed new code (found
      // 2026-07-09). +39000 keeps HMR out of the 49xx range entirely (4917→43917, 4918→43918).
      const hmrPort = port + 39000 <= 65535 ? port + 39000 : port - 1000
      vite = await createVite({ root: webRoot, server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" })
    } catch (err) {
      console.warn(`[fray-ui] vite dev middleware unavailable — serving API only: ${err instanceof Error ? err.message : err}`)
    }
  }

  const httpServer = createServer((req, res) => {
    const url = req.url ?? "/"
    if (isApiUrl(url)) {
      void pipeToApp(app, req, res, port).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
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
  })

  // Chrome caps 6 connections/host; reclaim idle keep-alives promptly so SSE + terminal don't starve.
  httpServer.keepAliveTimeout = 5000
  httpServer.headersTimeout = 10000

  // Path-routed upgrades on the shared http server: /term/:slug → terminal (raw pty), /ws → the multiplex
  // socket (board + transcript + notify). Anything else is destroyed. First matcher wins.
  httpServer.on("upgrade", (req, socket, head) => {
    if (terminal.handleUpgrade(req, socket, head)) return
    if (appSocket.handleUpgrade(req, socket, head)) return
    socket.destroy()
  })

  await new Promise<void>((r) => httpServer.listen(port, "127.0.0.1", r))
  console.log(`[fray-ui] server on http://127.0.0.1:${port} (${opts.dev ? "dev" : "prod"}) — project ${ctx.project.name}`)

  const cleanup = () => {
    try {
      unlinkSync(lockPath)
    } catch {}
    ctx.tailer.stop()
    ctx.scheduler.stop()
    void ctx.board.stop()
    terminal.close()
    appSocket.close()
    httpServer.close()
    process.exit()
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  return { httpServer, ctx, port }
}
