import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, extname, join, resolve, sep } from "node:path"
import { homedir, tmpdir } from "node:os"
import { mountRouter } from "@fray-ui/rpc/server"
import type { ServerEvent } from "@fray-ui/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"

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

// True when `real` is `root` itself or nested beneath it. Compares realpath-resolved, separator-
// terminated prefixes so "/a/bc" doesn't count as inside "/a/b".
function isUnder(real: string, root: string): boolean {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return false // root doesn't exist (e.g. no ~/Screenshots) — can't be a container
  }
  return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
}

export type LocalImageResult =
  | { status: 400 | 403 | 404 }
  | { status: 200; contentType: string; body: Buffer }

// Resolve + gate a local image request. Pure (roots injected) so it's unit-testable without an app:
// absolute path → whitelisted image extension → symlink-resolved real path under a trusted root →
// existing regular file. Any failed gate returns a status-only result; never reads outside the roots.
export function resolveLocalImage(rawPath: string | undefined, roots: string[]): LocalImageResult {
  if (!rawPath || !isAbsolute(rawPath)) return { status: 400 }

  const ext = extname(rawPath).toLowerCase()
  const contentType = IMAGE_CONTENT_TYPE[ext]
  if (!contentType) return { status: 400 }

  let real: string
  try {
    real = realpathSync(rawPath) // resolves symlinks so a link can't smuggle a path outside the roots
  } catch {
    return { status: 404 }
  }

  if (!roots.some((root) => isUnder(real, root))) return { status: 403 }

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
export function createApp(ctx: AppContext) {
  const app = new Hono()

  app.use(
    cors({
      origin: (o) => (o?.startsWith("http://localhost") || o?.startsWith("http://127.0.0.1") ? o : undefined),
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

  app.get("/health", (c) => c.json({ ok: true }))

  app.get("/local-image", (c) => {
    const roots = [ctx.project.dir, tmpdir(), resolve(homedir(), "Screenshots"), join(ctx.project.stateDir, "attachments")]
    const r = resolveLocalImage(c.req.query("path"), roots)
    if (r.status !== 200) return c.text(String(r.status), r.status)
    // Copy into a plain Uint8Array<ArrayBuffer> — Hono's body type rejects Node's Buffer union.
    return c.body(Uint8Array.from(r.body), 200, { "content-type": r.contentType, "cache-control": "private, max-age=60" })
  })

  // Attachment intake for drag-and-dropped / pasted screenshots: the image lands on DISK (outside
  // the repo, under the project's state dir) and the client inserts the returned absolute path into
  // the prompt text. Workers view it with their Read tool; the chat renders it via /local-image
  // (the attachments dir is in its roots above). JSON base64 keeps the route dependency-free.
  app.post("/attach", async (c) => {
    let body: { name?: string; data?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid json" }, 400)
    }
    const ext = (body.name ?? "").match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[0]?.toLowerCase()
    if (!ext) return c.json({ error: "unsupported file type" }, 400)
    if (typeof body.data !== "string" || body.data.length > 15_000_000) return c.json({ error: "bad payload" }, 400)
    const buf = Buffer.from(body.data, "base64")
    const dir = join(ctx.project.stateDir, "attachments")
    mkdirSync(dir, { recursive: true })
    // Timestamped, sanitized name — never trust the client's path segments.
    const base = (body.name ?? "image").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "image"
    const path = join(dir, `${Date.now()}-${base}${ext}`)
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
