import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, extname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { mountRouter } from "@fray-ui/rpc/server"
import { DEFAULT_PORT, ATTACHMENT_MAX_BASE64_CHARS, attachmentExtension, isAllowedAttachmentName, type ServerEvent } from "@fray-ui/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import { allowedLocalCorsOrigin, isTrustedLocalHttpRequest } from "./local-origin.ts"

// Local image serving. Screenshot paths in agent markdown point at real files on disk; the web
// client renders them via <img src="/local-image?path=…">. Strictly gated: absolute paths only,
// an image-extension whitelist, and the symlink-resolved real path must sit under a trusted root
// (the project dir, the OS temp dir, or ~/Screenshots). Anything else is 403 — never a raw file read.
const IMAGE_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export type LocalImageResult =
  | { status: 400 | 404 }
  | { status: 200; contentType: string; body: Buffer }

// Resolve a local image request. Deliberately UNCONFINED — no trusted-root allowlist: the proxy renders
// ANY readable local image the requester names (a screenshot anywhere on disk, not just under the
// workspace/tmp). This is safe to widen: the route is loopback-only (the app-wide origin gate), the
// extension allowlist keeps it to image bytes, realpath+isFile reject non-files and dangling/looping
// symlinks, and the bytes render in the viewer's OWN browser where sanitized markdown can't read them
// back — so it adds no exfiltration path. Any failed check returns a status-only result.
export function resolveLocalImage(rawPath: string | undefined): LocalImageResult {
  if (!rawPath || !isAbsolute(rawPath)) return { status: 400 }

  const ext = extname(rawPath).toLowerCase()
  const contentType = IMAGE_CONTENT_TYPE[ext]
  if (!contentType) return { status: 400 }

  let real: string
  try {
    real = realpathSync(rawPath) // resolve symlinks; a dangling/looping link is a clean 404
  } catch {
    return { status: 404 }
  }

  try {
    if (!statSync(real).isFile()) return { status: 404 }
    return { status: 200, contentType, body: readFileSync(real) }
  } catch {
    return { status: 404 }
  }
}

// The API surface routed to app.fetch: /rpc/* (typed procedures), /events (the single SSE
// board channel), /health. The terminal WebSocket and static/Vite assets are handled by the
// node http server in index.ts, not here.
export interface AppOptions {
  port?: number
  ownerProof?: string
  controlToken?: string
  requestOwnerStop?: () => void
}

export function createApp(ctx: AppContext, options: AppOptions = {}) {
  const app = new Hono()
  const port = options.port ?? DEFAULT_PORT

  // The API is a local control plane, not a public CORS service. Validate Host and require every present
  // Origin to name that SAME canonical loopback hostname + actual port, so an unrelated service on another
  // loopback family cannot borrow Fray's browser authority. Reject all forwarded authority (Fray does not
  // run behind a trusted proxy) and every non-local/mismatched Origin. Missing Origin is allowed
  // only for the read-only CLI health probe or a browser-forbidden `Sec-Fetch-Site: same-origin` request
  // (same-origin GET/fetch requests may omit Origin). Browser WebSockets use the stricter mandatory
  // same-origin policy in local-origin.ts.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    const allowMissingOrigin = origin === undefined && (
      (c.req.method === "GET" && c.req.path === "/health") ||
      (c.req.method === "POST" && c.req.path === "/control/stop") ||
      c.req.header("sec-fetch-site") === "same-origin"
    )
    if (!isTrustedLocalHttpRequest({
      host: c.req.header("host"),
      origin,
      forwarded: c.req.header("forwarded"),
      "x-forwarded-for": c.req.header("x-forwarded-for"),
      "x-forwarded-host": c.req.header("x-forwarded-host"),
      "x-forwarded-port": c.req.header("x-forwarded-port"),
      "x-forwarded-proto": c.req.header("x-forwarded-proto"),
    }, port, allowMissingOrigin)) {
      return c.text("Forbidden", 403)
    }
    await next()
  })

  app.use(
    cors({
      origin: (origin) => allowedLocalCorsOrigin(origin, port),
      // Expose the boot-id header so the client can read it off /rpc responses. Today the web app is
      // same-origin to the API (Vite middleware in dev, static in prod) so this is moot — but if it is
      // ever served cross-origin, without this the browser hides x-fray-boot and the RPC restart-detection
      // channel silently dies (SSE frames still carry the id, so detection degrades rather than breaks).
      exposeHeaders: ["x-fray-boot"],
    }),
  )

  // Stamp the server boot id on every /rpc response — a second, always-warm channel (besides the SSE
  // board frames) for the client to notice a restart even when the board is quiet but RPCs are flowing.
  app.use("/rpc/*", async (c, next) => {
    c.header("x-fray-boot", ctx.bootId)
    await next()
  })

  // Launcher identity probe: a bare `{ok:true}` cannot distinguish two workspace servers that race
  // for a port or a stale lock whose PID was reused. Keep this small and non-secret; all fields are
  // already visible in the board keyframe/client URL.
  app.get("/health", (c) => c.json({
    ok: true as const,
    projectId: ctx.project.id,
    projectDir: ctx.project.dir,
    bootId: ctx.bootId,
    ...(options.ownerProof ? { ownerProof: options.ownerProof } : {}),
  }))

  // Cross-platform owner stop channel. The raw capability is never returned by /health; the CLI
  // reads it from the 0600 owner record and health proves only its project-bound SHA-256 digest.
  app.post("/control/stop", (c) => {
    const supplied = c.req.header("x-fray-launch-token")
    if (!options.controlToken || !supplied || supplied !== options.controlToken) return c.text("Forbidden", 403)
    if (!options.requestOwnerStop) return c.text("Owner control unavailable", 503)
    const stop = setTimeout(options.requestOwnerStop, 25)
    stop.unref()
    return c.json({ accepted: true as const }, 202)
  })

  app.get("/local-image", (c) => {
    const r = resolveLocalImage(c.req.query("path"))
    if (r.status !== 200) return c.text(String(r.status), r.status)
    // Copy into a plain Uint8Array<ArrayBuffer> — Hono's body type rejects Node's Buffer union.
    return c.body(Uint8Array.from(r.body), 200, { "content-type": r.contentType, "cache-control": "private, max-age=60" })
  })

  // Attachment intake for drag-and-dropped / pasted / picked files (images AND the safe-tier document
  // set — see @fray-ui/shared ATTACHMENT_EXTENSIONS): the file lands on DISK (outside the repo, under
  // the project's state dir) and the client inserts the returned absolute path into the message text.
  // Workers open it with their Read/file tool; the chat renders images via /local-image and non-image
  // files as an openable chip (both roots include the attachments dir). JSON base64 keeps the route
  // dependency-free. The extension allowlist + the char cap are the only trust gates; the on-disk name
  // is timestamped and stripped of every client path segment.
  app.post("/attach", async (c) => {
    let body: { name?: string; data?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid json" }, 400)
    }
    const name = body.name ?? ""
    if (!isAllowedAttachmentName(name)) return c.json({ error: "unsupported file type" }, 400)
    if (typeof body.data !== "string" || body.data.length > ATTACHMENT_MAX_BASE64_CHARS) return c.json({ error: "bad payload" }, 400)
    const ext = `.${attachmentExtension(name)}` // allowlist-validated, lowercased
    const buf = Buffer.from(body.data, "base64")
    const dir = join(ctx.project.stateDir, "attachments")
    mkdirSync(dir, { recursive: true })
    // Timestamped + random-suffixed, sanitized name — never trust the client's path segments, and never
    // let two same-named files dropped in the same millisecond collide (the second would overwrite the
    // first and the message would carry a duplicate path).
    const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "file"
    const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${base}${ext}`)
    writeFileSync(path, buf)
    return c.json({ path })
  })

  // Delta SSE: the first frame is a FULL board keyframe (so a fresh client renders without a round-trip)
  // carrying the seq it corresponds to + the boot id; every subsequent bus event is a per-thread delta
  // (or a notify). A 10s heartbeat keeps the pipe warm.
  //
  // Ordering guarantee: we SUBSCRIBE FIRST and buffer, capture the keyframe, then flush. A publish that
  // fires while we assemble the keyframe (e.g. a cold-start rebuild that itself publishes) is therefore
  // never lost — buffered deltas are all ≤ the keyframe's seq (the keyframe reflects the latest committed
  // state), so the client's dup-guard drops them. Without this, a lost delta would force an immediate
  // resync on connect.
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0
      const send = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event), id: String(id++) })

      let flushed = false
      const buffer: ServerEvent[] = []
      const unsubscribe = ctx.bus.subscribe((event) => {
        if (flushed) void send(event).catch(() => {})
        else buffer.push(event)
      })

      try {
        const board = await ctx.board.snapshot()
        await send({ type: "board", board, seq: ctx.board.currentSeq(), bootId: ctx.bootId })
      } catch {
        // board not ready — a buffered/live bus publish will deliver the first delta instead
      }
      flushed = true
      for (const event of buffer) void send(event).catch(() => {})
      buffer.length = 0

      const heartbeat = setInterval(() => void stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {}), 10000)

      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          unsubscribe()
          clearInterval(heartbeat)
          resolve()
        }),
      )
    }),
  )

  mountRouter(app, "/rpc", createRouter(ctx))
  return app
}
