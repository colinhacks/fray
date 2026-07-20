// The durable launcher owns the browser-facing port.  A disposable Fray control-plane child binds
// only a private loopback port, which means a browser can still ask the owner to recover it after a
// crash.  This intentionally contains no source-watch logic: stable and legacy launchers can share it.
import { request as requestHttp, createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { connect } from "node:net"
import { isTrustedLocalHttpRequest } from "./local-origin.ts"

export const SUPERVISOR_CONTROL_PREFIX = "/_fray/control"
export const SUPERVISOR_RESTART_PATH = `${SUPERVISOR_CONTROL_PREFIX}/restart`
export const SUPERVISOR_UPDATE_RESTART_PATH = `${SUPERVISOR_CONTROL_PREFIX}/update-restart`
export const SUPERVISOR_STATUS_PATH = `${SUPERVISOR_CONTROL_PREFIX}/status`
export const SUPERVISOR_CONTROL_PROTOCOL = 1

export type RestartControlState = "ready" | "restarting" | "failed"

export interface RestartResult {
  // A durable update must acknowledge before it begins draining/re-execing the process which owns
  // the response socket.  "restarting" is therefore an accepted action, not a failed request.
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface RestartSupervisorProxyOptions {
  /** Public Fray port held for the supervisor's whole lifetime. */
  port: number
  /** The current disposable child. Undefined means it is starting, stopped, or failed. */
  childPort: () => number | undefined
  /** Must coalesce work itself or return the same in-flight promise for repeat requests. */
  restart: () => Promise<RestartResult>
  /** Build/validate/promote a new immutable artifact, then restart the child. Omitted for legacy mode. */
  updateRestart?: () => Promise<RestartResult>
  /** Status is intentionally available without a child, for a useful recovery UI. */
  status?: () => { state: RestartControlState; message?: string; artifactDigest?: string }
}

function responseJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(value))
}

function recoveryPage(url: string, detail = "Fray is restarting or unavailable."): string {
  // This is deliberately not an auto-refresh page. A broken child must not make a browser spin forever.
  const escaped = url.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
  return `<!doctype html><meta charset="utf-8"><title>Fray recovering</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:3rem;font:16px system-ui;color:#e7e7e7;background:#171717}main{max-width:36rem;padding:1.5rem;border:1px solid #444;border-radius:.75rem;background:#222}a{color:#f7d64a}</style><main><h1>Fray is recovering</h1><p>${detail}</p><p><a href="${escaped}">Try this page again</a></p></main>`
}

function proxyHeaders(req: IncomingMessage, childPort: number): Record<string, string | string[] | undefined> {
  const headers = { ...req.headers }
  // The child retains Fray's strict local-origin policy. Translate public browser authority to the
  // private child authority; no external proxy authority is ever trusted.
  headers.host = `127.0.0.1:${childPort}`
  if (typeof headers.origin === "string") headers.origin = `http://127.0.0.1:${childPort}`
  delete headers.connection
  return headers
}

function isControlRequest(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://fray.invalid")
  return url.pathname === SUPERVISOR_RESTART_PATH || url.pathname === SUPERVISOR_UPDATE_RESTART_PATH || url.pathname === SUPERVISOR_STATUS_PATH
}

export class RestartSupervisorProxy {
  private server: Server | null = null
  private restartInFlight: Promise<RestartResult> | null = null
  private state: RestartControlState = "ready"
  private message: string | undefined
  private readonly options: RestartSupervisorProxyOptions

  constructor(options: RestartSupervisorProxyOptions) {
    this.options = options
  }

  async listen(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => this.handle(req, res))
    server.keepAliveTimeout = 5_000
    server.headersTimeout = 10_000
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head))
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(this.options.port, "127.0.0.1", () => {
        server.off("error", rejectListen)
        resolveListen()
      })
    })
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections()
    })
  }

  private status(): { state: RestartControlState; message?: string; artifactDigest?: string; updateRestart: boolean } {
    const delegated = this.options.status?.()
    // The disposable child can quite correctly still report ready while the durable owner is building
    // a successor. The owner is the authority for that transition; never leak the old child's ready
    // state during it, or clients will send writes to a server that is about to disappear.
    const ownerTransition = this.restartInFlight !== null || this.state === "failed"
    return {
      ...(delegated ?? {}),
      ...(ownerTransition
        ? { state: this.state, ...(this.message ? { message: this.message } : {}) }
        : delegated ?? { state: this.state, ...(this.message ? { message: this.message } : {}) }),
      // Never infer this from the generic protocol: legacy/static supervisors can recover a child
      // but cannot build and promote the canonical Fray artifact.
      updateRestart: typeof this.options.updateRestart === "function",
    }
  }

  private async runAction(action: () => Promise<RestartResult>): Promise<RestartResult> {
    if (this.restartInFlight) return this.restartInFlight
    this.state = "restarting"
    this.message = undefined
    const work = action().then(
      (result) => {
        this.state = result.state
        this.message = result.message
        return result
      },
      (error) => {
        const result: RestartResult = { state: "failed", message: error instanceof Error ? error.message : String(error) }
        this.state = result.state
        this.message = result.message
        return result
      },
    ).finally(() => { this.restartInFlight = null })
    this.restartInFlight = work
    return work
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://fray.invalid").pathname
    const allowMissingOrigin = pathname === SUPERVISOR_STATUS_PATH && req.method === "GET" && req.headers["sec-fetch-site"] === "same-origin"
    if (!isTrustedLocalHttpRequest(req.headers, this.options.port, allowMissingOrigin)) {
      res.writeHead(403)
      res.end("Forbidden")
      return
    }
    if (pathname === SUPERVISOR_STATUS_PATH && req.method === "GET") {
      responseJson(res, 200, { protocol: SUPERVISOR_CONTROL_PROTOCOL, ...this.status() })
      return
    }
    if ((pathname !== SUPERVISOR_RESTART_PATH && pathname !== SUPERVISOR_UPDATE_RESTART_PATH) || req.method !== "POST") {
      res.writeHead(405, { allow: pathname === SUPERVISOR_STATUS_PATH ? "GET" : "POST" })
      res.end()
      return
    }
    if (pathname === SUPERVISOR_UPDATE_RESTART_PATH && !this.options.updateRestart) {
      responseJson(res, 409, { protocol: SUPERVISOR_CONTROL_PROTOCOL, state: "failed", message: "Update & Restart is available only for a stable immutable Fray artifact" })
      return
    }
    if (pathname === SUPERVISOR_UPDATE_RESTART_PATH) {
      // Building and re-executing the durable owner can outlive (and intentionally close) this
      // response. Acknowledge ownership of the transition immediately; /status remains the source
      // of truth until a successor is ready or the candidate fails.
      void this.runAction(this.options.updateRestart!)
      responseJson(res, 202, { protocol: SUPERVISOR_CONTROL_PROTOCOL, state: "restarting" })
      return
    }
    const result = await this.runAction(this.options.restart)
    responseJson(res, result.state === "ready" ? 202 : 503, { protocol: SUPERVISOR_CONTROL_PROTOCOL, ...result })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (isControlRequest(req)) {
      void this.handleControl(req, res)
      return
    }
    const childPort = this.options.childPort()
    if (!childPort) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "2" })
      res.end(recoveryPage(req.url ?? "/"))
      return
    }
    const upstream = requestHttp({
      host: "127.0.0.1",
      port: childPort,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, childPort),
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstream.once("error", () => {
      if (res.headersSent) return res.destroy()
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(recoveryPage(req.url ?? "/", "The Fray application server is unavailable. Use Restart Fray to recover it."))
    })
    req.pipe(upstream)
  }

  private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const childPort = this.options.childPort()
    if (!childPort) {
      socket.destroy()
      return
    }
    const upstream = connect(childPort, "127.0.0.1")
    upstream.once("connect", () => {
      const headers = proxyHeaders(req, childPort)
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.once("error", () => socket.destroy())
    socket.once("error", () => upstream.destroy())
  }
}
