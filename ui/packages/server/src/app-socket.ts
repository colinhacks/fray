import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import type { BoardSnapshot, ServerEvent, SocketServerMsg, TranscriptMessage } from "@fray-ui/shared"
import { SocketClientMsg } from "@fray-ui/shared"
import type { Bus } from "./bus.ts"
import type { Emitter } from "./bus.ts"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import { readThreadTranscript } from "./transcript.ts"

// Stage-2 multiplex: a SECOND noServer WebSocket at /ws (beside the terminal WS) carrying the board
// channel (keyframe + deltas + notify — the stage-1 ServerEvent shapes, wrapped in {t:"event"}) AND
// per-thread transcript PUSH (replacing the client's 1.5s threadTranscript poll). index.ts routes the
// /ws upgrade here; terminals stay on /term/:slug.

const WS_PATH = "/ws"

function isWsPath(url: string | undefined): boolean {
  return ((url ?? "").split("?")[0] ) === WS_PATH
}

// ── subscription registry ─────────────────────────────────────────────────────────────────────────────
// Tracks which connections are subscribed to which thread transcripts, both directions (slug→conns for the
// producer fan-out, conn→slugs for O(1) cleanup on socket close). Generic over the connection type so it is
// unit-testable with a plain token. Subscribing the same conn+slug twice is idempotent (a Set).
export class SubscriptionRegistry<C> {
  private bySlug = new Map<string, Set<C>>()
  private byConn = new Map<C, Set<string>>()

  // Returns true iff this slug had NO subscribers before (the producer can skip work until the first).
  subscribe(conn: C, slug: string): boolean {
    const wasEmpty = !this.bySlug.has(slug)
    let conns = this.bySlug.get(slug)
    if (!conns) {
      conns = new Set()
      this.bySlug.set(slug, conns)
    }
    conns.add(conn)
    let slugs = this.byConn.get(conn)
    if (!slugs) {
      slugs = new Set()
      this.byConn.set(conn, slugs)
    }
    slugs.add(slug)
    return wasEmpty
  }

  unsubscribe(conn: C, slug: string): void {
    const conns = this.bySlug.get(slug)
    if (conns) {
      conns.delete(conn)
      if (conns.size === 0) this.bySlug.delete(slug)
    }
    const slugs = this.byConn.get(conn)
    if (slugs) {
      slugs.delete(slug)
      if (slugs.size === 0) this.byConn.delete(conn)
    }
  }

  // Drop a whole connection (socket close) — clears it from every slug it held. This is the leak-guard:
  // after removeConn, no slug set can still reference the closed connection.
  removeConn(conn: C): void {
    const slugs = this.byConn.get(conn)
    if (!slugs) return
    for (const slug of slugs) {
      const conns = this.bySlug.get(slug)
      if (conns) {
        conns.delete(conn)
        if (conns.size === 0) this.bySlug.delete(slug)
      }
    }
    this.byConn.delete(conn)
  }

  subscribers(slug: string): C[] {
    const conns = this.bySlug.get(slug)
    return conns ? [...conns] : []
  }

  hasSubscribers(slug: string): boolean {
    return this.bySlug.has(slug)
  }

  slugsFor(conn: C): string[] {
    const slugs = this.byConn.get(conn)
    return slugs ? [...slugs] : []
  }

  // Live counts — for tests/assertions (a clean shutdown must leave both at 0).
  get slugCount(): number {
    return this.bySlug.size
  }
  get connCount(): number {
    return this.byConn.size
  }
}

// ── narrow deps ─────────────────────────────────────────────────────────────────────────────────────
// app-socket depends on this SUBSET of AppContext (not the whole thing) so the protocol is testable with
// fakes + an in-process ws client — no real board/tailer/storage needed.
export interface AppSocketDeps {
  bus: Pick<Bus, "subscribe">
  bootId: string
  transcriptChange: Pick<Emitter<string[]>, "on">
  boardSnapshot: () => Promise<BoardSnapshot>
  currentSeq: () => number
  readTranscript: (slug: string) => TranscriptMessage[]
}

// Build the transcript reader index.ts injects — resolves a thread slug to its rendered transcript the
// SAME way router.ts's threadTranscript does (registry row → its session's JSONL; foreign slug → the
// session id itself; else []). Shared via readThreadTranscript so both paths render foreign threads.
export function makeTranscriptReader(project: Project, storage: Storage): (slug: string) => TranscriptMessage[] {
  return (slug: string) => readThreadTranscript(project, storage, slug)
}

export interface AppSocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): void
  // Exposed for tests/observability — the live subscription registry.
  registry: SubscriptionRegistry<WebSocket>
  // Count of cached per-slug transcript signatures — for tests to assert no unbounded growth.
  readonly lastSigSize: number
}

const HEARTBEAT_MS = 10_000

export function createAppSocketServer(deps: AppSocketDeps): AppSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  const registry = new SubscriptionRegistry<WebSocket>()
  // Per-slug signature of the last BROADCAST transcript — dedupes an unchanged re-read (a tailer tick that
  // advanced the file with records the transcript renderer ignores) so we don't push identical frames.
  const lastSig = new Map<string, string>()

  function sendMsg(ws: WebSocket, msg: SocketServerMsg): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // client went away mid-send — the close handler will clean up
      }
    }
  }

  // Read + push one slug's current transcript to a SINGLE connection (the immediate on-subscribe push).
  // Seeds lastSig so a subsequent identical broadcast is deduped — but ONLY when this connection is the
  // SOLE subscriber. With multiple subscribers, seeding here would suppress the producer's pending
  // broadcast of this SAME change to the OTHER (already-subscribed) connections, leaving them stale until
  // the next change. Called right after registry.subscribe, so subscribers(slug) includes this conn.
  function pushTo(ws: WebSocket, slug: string): void {
    const messages = deps.readTranscript(slug)
    if (registry.subscribers(slug).length <= 1) lastSig.set(slug, JSON.stringify(messages))
    sendMsg(ws, { t: "transcript", slug, messages })
  }

  // Producer: on a tailer-reported transcript change, re-read each subscribed slug once, dedup, broadcast.
  const offTranscript = deps.transcriptChange.on((slugs) => {
    for (const slug of slugs) {
      if (!registry.hasSubscribers(slug)) {
        lastSig.delete(slug) // nobody's listening — forget the signature so it can't go stale
        continue
      }
      const messages = deps.readTranscript(slug)
      const sig = JSON.stringify(messages)
      if (sig === lastSig.get(slug)) continue // no rendered change since the last push
      lastSig.set(slug, sig)
      const frame: SocketServerMsg = { t: "transcript", slug, messages }
      for (const ws of registry.subscribers(slug)) sendMsg(ws, frame)
    }
  })

  wss.on("connection", (ws: WebSocket) => {
    // Board channel: SUBSCRIBE FIRST + buffer, capture the keyframe, then flush — the same ordering
    // guarantee as the /events SSE handler (app.ts). A publish that fires while we assemble the keyframe is
    // buffered; its seq is ≤ the keyframe's, so the client's dup-guard drops it. No delta is lost.
    let flushed = false
    const buffer: ServerEvent[] = []
    const unsubscribeBus = deps.bus.subscribe((event) => {
      if (flushed) sendMsg(ws, { t: "event", event })
      else buffer.push(event)
    })

    void (async () => {
      try {
        const board = await deps.boardSnapshot()
        sendMsg(ws, { t: "event", event: { type: "board", board, seq: deps.currentSeq(), bootId: deps.bootId } })
      } catch {
        // board not ready: skip the keyframe. The client has no base yet, so the next board-delta makes it
        // resync (reconnect) — which retries this keyframe. A transient snapshot failure self-heals on the
        // reconnect; this mirrors the /events SSE handler's identical behavior (app.ts).
      }
      flushed = true
      for (const event of buffer) sendMsg(ws, { t: "event", event })
      buffer.length = 0
    })()

    const heartbeat = setInterval(() => sendMsg(ws, { t: "hb" }), HEARTBEAT_MS)

    ws.on("message", (raw) => {
      let msg: SocketClientMsg
      try {
        msg = SocketClientMsg.parse(JSON.parse(raw.toString()))
      } catch {
        return // malformed / unknown client frame — ignore (never throw on the socket)
      }
      if (msg.t === "sub") {
        registry.subscribe(ws, msg.slug)
        pushTo(ws, msg.slug) // immediate current transcript, so a fresh subscriber never waits for a change
      } else if (msg.t === "unsub") {
        registry.unsubscribe(ws, msg.slug)
        if (!registry.hasSubscribers(msg.slug)) lastSig.delete(msg.slug) // last subscriber gone — reclaim the cached signature
      }
    })

    ws.on("close", () => {
      unsubscribeBus()
      clearInterval(heartbeat)
      const held = registry.slugsFor(ws) // capture BEFORE removeConn so we can reclaim orphaned signatures
      registry.removeConn(ws) // leak-guard: drop this connection from every slug it held
      for (const slug of held) if (!registry.hasSubscribers(slug)) lastSig.delete(slug)
    })
    ws.on("error", () => {
      try {
        ws.close()
      } catch {
        // fall through to the close handler
      }
    })
  })

  return {
    handleUpgrade(req, socket, head) {
      if (!isWsPath(req.url)) return false
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      return true
    },
    close() {
      offTranscript()
      wss.close()
    },
    registry,
    get lastSigSize() {
      return lastSig.size
    },
  }
}
