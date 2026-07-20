import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { createHash } from "node:crypto"
import { WebSocketServer, type WebSocket } from "ws"
import type { BoardSnapshot, ServerEvent, SocketServerMsg, TranscriptMessage } from "@fray-ui/shared"
import { SocketClientMsg } from "@fray-ui/shared"
import type { Bus } from "./bus.ts"
import type { Emitter } from "./bus.ts"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { AgentBackend } from "./backend/types.ts"
import { readThreadTranscript } from "./transcript.ts"
import { isTrustedLocalWebSocketRequest, rejectWebSocketUpgrade } from "./local-origin.ts"

// Stage-2 multiplex: a SECOND noServer WebSocket at /ws (beside the terminal WS) carrying the board
// channel (keyframe + deltas + notify — the stage-1 ServerEvent shapes, wrapped in {t:"event"}) AND
// per-thread transcript PUSH (replacing the client's 1.5s threadTranscript poll). index.ts routes the
// /ws upgrade here; terminals stay on /term/:slug.

const WS_PATH = "/ws"

function isWsPath(url: string | undefined): boolean {
  return (url ?? "").split("?")[0] === WS_PATH
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

  isSubscribed(conn: C, slug: string): boolean {
    return this.byConn.get(conn)?.has(slug) ?? false
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
  /** Narrow test/operational seams; production uses the conservative exported defaults below. */
  maxLogicalFrameBytes?: number
  maxOutputBufferBytes?: number
  maxConnections?: number
  maxSubscriptionsPerConnection?: number
  maxMessagesPerWindow?: number
  messageWindowMs?: number
  maxBufferedKeyframeEvents?: number
  maxTranscriptReadsPerOrigin?: number
  maxTranscriptReadsOverall?: number
  transcriptReadWindowMs?: number
  maxTranscriptCacheEntries?: number
  maxTranscriptCacheBytes?: number
  bufferedAmount?: (ws: WebSocket) => number
  now?: () => number
  serializeMessage?: (msg: SocketServerMsg) => string
}

// Build the transcript reader index.ts injects — resolves a thread slug to its rendered transcript the
// SAME way router.ts's threadTranscript does (registry row → its session's JSONL; foreign slug → the
// session id itself; else []). Shared via readThreadTranscript so both paths render foreign threads.
export function makeTranscriptReader(
  project: Project,
  storage: Storage,
  backendFor?: (kind?: string) => AgentBackend,
): (slug: string) => TranscriptMessage[] {
  return (slug: string) => readThreadTranscript(project, storage, slug, backendFor)
}

export interface AppSocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
  // Exposed for tests/observability — the live subscription registry.
  registry: SubscriptionRegistry<WebSocket>
  // Count of cached per-slug transcript signatures — for tests to assert no unbounded growth.
  readonly lastSigSize: number
  // Bounded process-wide resource gauges — intentionally narrow, read-only observability for tests.
  readonly connectionCount: number
  readonly transcriptCacheEntries: number
  readonly transcriptCacheBytes: number
  readonly pendingTranscriptRefreshes: number
}

const HEARTBEAT_MS = 10_000
export const APP_SOCKET_MAX_MESSAGE_BYTES = 1_048_576
export const APP_SOCKET_MAX_LOGICAL_FRAME_BYTES = 4 * 1_024 * 1_024
export const APP_SOCKET_MAX_OUTPUT_BUFFER_BYTES = 4 * 1_024 * 1_024
export const APP_SOCKET_MAX_CONNECTIONS = 64
export const APP_SOCKET_MAX_SUBSCRIPTIONS = 32
export const APP_SOCKET_MAX_MESSAGES_PER_WINDOW = 120
export const APP_SOCKET_MESSAGE_WINDOW_MS = 1_000
export const APP_SOCKET_MAX_BUFFERED_KEYFRAME_EVENTS = 256
export const APP_SOCKET_MAX_TRANSCRIPT_READS_PER_ORIGIN = 16
export const APP_SOCKET_MAX_TRANSCRIPT_READS_OVERALL = 64
export const APP_SOCKET_TRANSCRIPT_READ_WINDOW_MS = 1_000
export const APP_SOCKET_MAX_TRANSCRIPT_CACHE_ENTRIES = 128
export const APP_SOCKET_MAX_TRANSCRIPT_CACHE_BYTES = 32 * 1_024 * 1_024

export function createAppSocketServer(deps: AppSocketDeps): AppSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: APP_SOCKET_MAX_MESSAGE_BYTES })
  const registry = new SubscriptionRegistry<WebSocket>()
  const boundedCount = (value: number | undefined, fallback: number): number => {
    const candidate = value ?? fallback
    return Number.isFinite(candidate) ? Math.max(0, Math.floor(candidate)) : fallback
  }
  const positiveDuration = (value: number | undefined, fallback: number): number => {
    const candidate = value ?? fallback
    return Number.isFinite(candidate) ? Math.max(1, Math.floor(candidate)) : fallback
  }
  const maxLogicalFrameBytes = deps.maxLogicalFrameBytes ?? APP_SOCKET_MAX_LOGICAL_FRAME_BYTES
  const maxOutputBufferBytes = deps.maxOutputBufferBytes ?? APP_SOCKET_MAX_OUTPUT_BUFFER_BYTES
  const maxConnections = boundedCount(deps.maxConnections, APP_SOCKET_MAX_CONNECTIONS)
  const maxSubscriptions = deps.maxSubscriptionsPerConnection ?? APP_SOCKET_MAX_SUBSCRIPTIONS
  const maxMessagesPerWindow = deps.maxMessagesPerWindow ?? APP_SOCKET_MAX_MESSAGES_PER_WINDOW
  const messageWindowMs = deps.messageWindowMs ?? APP_SOCKET_MESSAGE_WINDOW_MS
  const maxBufferedKeyframeEvents = deps.maxBufferedKeyframeEvents ?? APP_SOCKET_MAX_BUFFERED_KEYFRAME_EVENTS
  const maxTranscriptReadsPerOrigin = boundedCount(
    deps.maxTranscriptReadsPerOrigin,
    APP_SOCKET_MAX_TRANSCRIPT_READS_PER_ORIGIN,
  )
  const maxTranscriptReadsOverall = boundedCount(
    deps.maxTranscriptReadsOverall,
    APP_SOCKET_MAX_TRANSCRIPT_READS_OVERALL,
  )
  const transcriptReadWindowMs = positiveDuration(
    deps.transcriptReadWindowMs,
    APP_SOCKET_TRANSCRIPT_READ_WINDOW_MS,
  )
  const maxTranscriptCacheEntries = boundedCount(
    deps.maxTranscriptCacheEntries,
    APP_SOCKET_MAX_TRANSCRIPT_CACHE_ENTRIES,
  )
  const maxTranscriptCacheBytes = boundedCount(
    deps.maxTranscriptCacheBytes,
    APP_SOCKET_MAX_TRANSCRIPT_CACHE_BYTES,
  )
  const bufferedAmount = deps.bufferedAmount ?? ((ws: WebSocket) => ws.bufferedAmount)
  const now = deps.now ?? Date.now
  const serializeMessage = deps.serializeMessage ?? JSON.stringify
  const terminationTimers = new WeakMap<WebSocket, NodeJS.Timeout>()
  const keyframes = new Set<Promise<void>>()
  let closing = false
  let closePromise: Promise<void> | null = null
  let connectionCount = 0
  let pendingUpgrades = 0
  const socketOrigins = new WeakMap<WebSocket, string>()
  // Per-slug signature of the last BROADCAST transcript — dedupes an unchanged re-read (a tailer tick that
  // advanced the file with records the transcript renderer ignores) so we don't push identical frames.
  const lastSig = new Map<string, string>()

  function closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    try {
      ws.close(code, reason)
      // A peer that stopped reading may never consume the close frame. Reclaim it after a short grace;
      // normal clients complete the handshake and clear this timer in their close handler.
      const prior = terminationTimers.get(ws)
      if (prior) clearTimeout(prior)
      const timer = setTimeout(() => {
        try {
          ws.terminate()
        } catch {
          // Already closed.
        }
      }, 250)
      timer.unref?.()
      terminationTimers.set(ws, timer)
    } catch {
      try {
        ws.terminate()
      } catch {
        // Already closed.
      }
    }
  }

  interface EncodedMessage {
    text: string
    bytes: number
  }
  type SendResult =
    | { kind: "sent" }
    | { kind: "unavailable" }
    | { kind: "slow" }
    | { kind: "oversized"; actualBytes: number }

  function encodeMsg(msg: SocketServerMsg): EncodedMessage | null {
    try {
      const text = serializeMessage(msg)
      return { text, bytes: Buffer.byteLength(text, "utf8") }
    } catch {
      return null
    }
  }

  // Logical frame size and queued transport pressure are different failure classes. A payload that is
  // intrinsically too large gets a typed, non-closing downgrade below; a bounded frame that cannot be
  // queued because this peer stopped reading is still shed as a slow consumer.
  function sendEncoded(ws: WebSocket, frame: EncodedMessage, enforceLogicalLimit = true): SendResult {
    if (ws.readyState !== ws.OPEN) return { kind: "unavailable" }
    if (enforceLogicalLimit && frame.bytes > maxLogicalFrameBytes) {
      return { kind: "oversized", actualBytes: frame.bytes }
    }
    if (bufferedAmount(ws) + frame.bytes > maxOutputBufferBytes) {
      closeSocket(ws, 1013, "client too slow")
      return { kind: "slow" }
    }
    try {
      ws.send(frame.text, (error) => {
        if (error) closeSocket(ws, 1011, "transport failed")
      })
      return { kind: "sent" }
    } catch {
      closeSocket(ws, 1011, "transport failed")
      return { kind: "unavailable" }
    }
  }

  function sendMsg(ws: WebSocket, msg: SocketServerMsg): SendResult {
    const frame = encodeMsg(msg)
    if (!frame) {
      closeSocket(ws, 1011, "serialization failed")
      return { kind: "unavailable" }
    }
    return sendEncoded(ws, frame)
  }

  function sendPayloadTooLarge(
    ws: WebSocket,
    msg: Extract<SocketServerMsg, { t: "payload-too-large" }>,
  ): void {
    const frame = encodeMsg(msg)
    if (!frame) {
      closeSocket(ws, 1011, "serialization failed")
      return
    }
    // The small control frame must not recursively fail the logical-payload limit it reports. It still
    // obeys the real queued-output cap, so an actually slow peer is reclaimed normally.
    sendEncoded(ws, frame, false)
  }

  function sendResourceLimited(
    ws: WebSocket,
    msg: Extract<SocketServerMsg, { t: "resource-limited" }>,
  ): void {
    const frame = encodeMsg(msg)
    if (!frame) {
      closeSocket(ws, 1011, "serialization failed")
      return
    }
    // Like payload-too-large, this is a small control frame describing why ONE subscription was
    // rejected. It bypasses the logical data-frame limit but never the queued-output/slow-peer bound.
    sendEncoded(ws, frame, false)
  }

  function frameSignature(frame: EncodedMessage): string {
    return createHash("sha256").update(frame.text).digest("base64url")
  }

  // ── aggregate transcript read budget ─────────────────────────────────────────────────────────────
  // Sliding timestamps (rather than resettable fixed windows) prevent a client from taking one full
  // allowance immediately before a boundary and another immediately after it. Origin reservations make
  // one noisy browser identity unable to consume every on-demand read; global reservations bound all
  // actual full reads, including tailer-driven refreshes shared by many origins.
  const globalReadTimes: number[] = []
  const originReadTimes = new Map<string, number[]>()
  const effectiveReadWindowMs = Math.max(1, transcriptReadWindowMs)
  let lastReadBudgetAt = Number.NEGATIVE_INFINITY

  function readBudgetNow(): number {
    const candidate = now()
    if (Number.isFinite(candidate)) lastReadBudgetAt = Math.max(lastReadBudgetAt, candidate)
    if (!Number.isFinite(lastReadBudgetAt)) lastReadBudgetAt = Date.now()
    return lastReadBudgetAt
  }

  function pruneReadTimes(times: number[], at: number): void {
    const expiredAt = at - effectiveReadWindowMs
    while (times.length && times[0] <= expiredAt) times.shift()
  }

  function retryAfter(times: number[], limit: number, at: number): number {
    if (limit <= 0 || !times.length) return effectiveReadWindowMs
    return Math.max(1, Math.ceil(times[0] + effectiveReadWindowMs - at))
  }

  type ReadReservation =
    | { kind: "allowed" }
    | { kind: "limited"; scope: "origin" | "global"; retryAfterMs: number }

  function reserveTranscriptRead(origin?: string): ReadReservation {
    const at = readBudgetNow()
    pruneReadTimes(globalReadTimes, at)
    let perOrigin: number[] | undefined
    if (origin) {
      perOrigin = originReadTimes.get(origin)
      if (!perOrigin) {
        perOrigin = []
        originReadTimes.set(origin, perOrigin)
      }
      pruneReadTimes(perOrigin, at)
      if (perOrigin.length >= maxTranscriptReadsPerOrigin) {
        return {
          kind: "limited",
          scope: "origin",
          retryAfterMs: retryAfter(perOrigin, maxTranscriptReadsPerOrigin, at),
        }
      }
    }
    if (globalReadTimes.length >= maxTranscriptReadsOverall) {
      return {
        kind: "limited",
        scope: "global",
        retryAfterMs: retryAfter(globalReadTimes, maxTranscriptReadsOverall, at),
      }
    }
    globalReadTimes.push(at)
    perOrigin?.push(at)
    return { kind: "allowed" }
  }

  // ── bounded encoded transcript snapshot cache ────────────────────────────────────────────────────
  // Cache the exact encoded frame, not both the message graph and another JSON copy. Hits therefore do
  // zero disk/parse work AND zero full-frame serialization. Map insertion order is the LRU order.
  // Entries are evicted as soon as the last subscriber leaves, so a forgotten thread cannot be served
  // from stale retained content; tailer invalidation deletes the entry synchronously before refresh.
  interface TranscriptSnapshot {
    frame: EncodedMessage
    sig: string
    weight: number
  }
  const transcriptCache = new Map<string, TranscriptSnapshot>()
  let transcriptCacheBytes = 0

  function snapshotWeight(frame: EncodedMessage): number {
    // V8 strings may occupy two bytes/code-unit; take the larger of UTF-8 wire bytes and that
    // conservative in-memory estimate. Small Map/object overhead is bounded by the separate entry cap.
    return Math.max(frame.bytes, frame.text.length * 2)
  }

  function deleteTranscriptSnapshot(slug: string): void {
    const cached = transcriptCache.get(slug)
    if (!cached) return
    transcriptCache.delete(slug)
    transcriptCacheBytes -= cached.weight
  }

  function getTranscriptSnapshot(slug: string): TranscriptSnapshot | undefined {
    const cached = transcriptCache.get(slug)
    if (!cached) return undefined
    transcriptCache.delete(slug)
    transcriptCache.set(slug, cached)
    return cached
  }

  function cacheTranscriptSnapshot(slug: string, snapshot: TranscriptSnapshot): void {
    deleteTranscriptSnapshot(slug)
    if (
      maxTranscriptCacheEntries <= 0
      || maxTranscriptCacheBytes <= 0
      || snapshot.weight > maxTranscriptCacheBytes
    ) return
    transcriptCache.set(slug, snapshot)
    transcriptCacheBytes += snapshot.weight
    while (
      transcriptCache.size > maxTranscriptCacheEntries
      || transcriptCacheBytes > maxTranscriptCacheBytes
    ) {
      const oldest = transcriptCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      deleteTranscriptSnapshot(oldest)
    }
  }

  function clearTranscriptSnapshots(): void {
    transcriptCache.clear()
    transcriptCacheBytes = 0
  }

  function readTranscript(slug: string): TranscriptMessage[] | null {
    try {
      return deps.readTranscript(slug)
    } catch {
      return null
    }
  }

  type SnapshotResult =
    | { kind: "ready"; snapshot: TranscriptSnapshot }
    | { kind: "unavailable" }
    | { kind: "oversized"; actualBytes: number }
    | { kind: "limited"; scope: "origin" | "global"; retryAfterMs: number }

  function snapshotFor(slug: string, origin?: string): SnapshotResult {
    const cached = getTranscriptSnapshot(slug)
    if (cached) return { kind: "ready", snapshot: cached }
    const reservation = reserveTranscriptRead(origin)
    if (reservation.kind === "limited") return reservation
    const messages = readTranscript(slug)
    if (!messages) return { kind: "unavailable" }
    const frame = encodeMsg({ t: "transcript", slug, messages })
    if (!frame) return { kind: "unavailable" }
    if (frame.bytes > maxLogicalFrameBytes) return { kind: "oversized", actualBytes: frame.bytes }
    const snapshot = { frame, sig: frameSignature(frame), weight: snapshotWeight(frame) }
    cacheTranscriptSnapshot(slug, snapshot)
    return { kind: "ready", snapshot }
  }

  function dropSubscription(ws: WebSocket, slug: string): void {
    registry.unsubscribe(ws, slug)
    if (!registry.hasSubscribers(slug)) {
      lastSig.delete(slug)
      deleteTranscriptSnapshot(slug)
    }
  }

  // Read + push one slug's current transcript to a SINGLE connection (the immediate on-subscribe push).
  // Seeds lastSig so a subsequent identical broadcast is deduped — but ONLY when this connection is the
  // SOLE subscriber. With multiple subscribers, seeding here would suppress the producer's pending
  // broadcast of this SAME change to the OTHER (already-subscribed) connections, leaving them stale until
  // the next change. Called right after registry.subscribe, so subscribers(slug) includes this conn.
  function pushSnapshotResult(ws: WebSocket, slug: string, result: SnapshotResult): void {
    if (result.kind === "unavailable") {
      closeSocket(ws, 1011, "transcript unavailable")
      return
    }
    if (result.kind === "limited") {
      dropSubscription(ws, slug)
      sendResourceLimited(ws, {
        t: "resource-limited",
        resource: "transcript-read",
        scope: result.scope,
        slug,
        retryAfterMs: result.retryAfterMs,
      })
      return
    }
    if (result.kind === "oversized") {
      dropSubscription(ws, slug)
      sendPayloadTooLarge(ws, {
        t: "payload-too-large",
        channel: "transcript",
        slug,
        actualBytes: result.actualBytes,
        maxBytes: maxLogicalFrameBytes,
      })
      return
    }
    const sent = sendEncoded(ws, result.snapshot.frame)
    if (sent.kind === "sent" && registry.subscribers(slug).length <= 1) {
      lastSig.set(slug, result.snapshot.sig)
    }
  }

  // New subscriptions are deferred to one check-phase batch. All sockets that arrive in that batch
  // share the first fresh read/encoded snapshot; a LATER batch first invalidates retained cache so it
  // preserves the historical guarantee that a late subscriber sees disk truth even in the small gap
  // before the tailer emits its change edge. Map+Set dedupes sub/unsub/sub churn within the same batch.
  const pendingSubscriptionPushes = new Map<WebSocket, Set<string>>()
  let subscriptionFlushImmediate: NodeJS.Immediate | null = null

  function enqueueSubscriptionPush(ws: WebSocket, slug: string): void {
    deleteTranscriptSnapshot(slug)
    let slugs = pendingSubscriptionPushes.get(ws)
    if (!slugs) {
      slugs = new Set()
      pendingSubscriptionPushes.set(ws, slugs)
    }
    slugs.add(slug)
    if (subscriptionFlushImmediate) return
    subscriptionFlushImmediate = setImmediate(() => {
      subscriptionFlushImmediate = null
      if (closing) {
        pendingSubscriptionPushes.clear()
        return
      }
      const batch = [...pendingSubscriptionPushes]
      pendingSubscriptionPushes.clear()
      const batchResults = new Map<string, SnapshotResult>()
      for (const [candidate, candidateSlugs] of batch) {
        if (candidate.readyState !== candidate.OPEN) continue
        for (const candidateSlug of candidateSlugs) {
          if (!registry.isSubscribed(candidate, candidateSlug)) continue
          let result = batchResults.get(candidateSlug)
          if (!result || (result.kind === "limited" && result.scope === "origin")) {
            result = snapshotFor(candidateSlug, socketOrigins.get(candidate))
            // An origin denial is local to that origin; let the next origin attempt its own fair share.
            // Every other outcome describes the one process-wide read/result and is safe to share.
            if (!(result.kind === "limited" && result.scope === "origin")) {
              batchResults.set(candidateSlug, result)
            }
          }
          pushSnapshotResult(candidate, candidateSlug, result)
        }
      }
    })
    subscriptionFlushImmediate.unref?.()
  }

  function cancelPendingSubscriptionPush(ws: WebSocket, slug?: string): void {
    if (slug === undefined) {
      pendingSubscriptionPushes.delete(ws)
      return
    }
    const slugs = pendingSubscriptionPushes.get(ws)
    if (!slugs) return
    slugs.delete(slug)
    if (!slugs.size) pendingSubscriptionPushes.delete(ws)
  }

  // Producer invalidations coalesce by slug in one microtask. A global-budget miss retains the dirty slug
  // and arms ONE retry timer for the earliest token; further invalidations merely join the same set/timer.
  // This preserves eventual freshness without a timer/read amplification loop.
  const pendingTranscriptRefreshes = new Set<string>()
  let transcriptFlushQueued = false
  let transcriptRefreshTimer: NodeJS.Timeout | null = null

  function scheduleTranscriptFlush(delayMs = 0): void {
    if (closing) return
    if (delayMs > 0) {
      if (transcriptRefreshTimer || transcriptFlushQueued) return
      transcriptRefreshTimer = setTimeout(() => {
        transcriptRefreshTimer = null
        scheduleTranscriptFlush()
      }, Math.max(1, Math.ceil(delayMs)))
      transcriptRefreshTimer.unref?.()
      return
    }
    // An existing budget timer is the one allowed retry edge. New invalidations join it without probing.
    if (transcriptRefreshTimer || transcriptFlushQueued) return
    transcriptFlushQueued = true
    queueMicrotask(() => {
      transcriptFlushQueued = false
      flushTranscriptChanges()
    })
  }

  function flushTranscriptChanges(): void {
    if (closing) {
      pendingTranscriptRefreshes.clear()
      return
    }
    const slugs = [...pendingTranscriptRefreshes]
    pendingTranscriptRefreshes.clear()
    let retryMs: number | undefined
    for (const slug of slugs) {
      if (!registry.hasSubscribers(slug)) {
        lastSig.delete(slug)
        deleteTranscriptSnapshot(slug)
        continue
      }
      const result = snapshotFor(slug) // shared producer refresh: global budget only
      if (result.kind === "limited") {
        if (maxTranscriptReadsOverall === 0) {
          for (const ws of registry.subscribers(slug)) {
            dropSubscription(ws, slug)
            sendResourceLimited(ws, {
              t: "resource-limited",
              resource: "transcript-read",
              scope: "global",
              slug,
              retryAfterMs: result.retryAfterMs,
            })
          }
          deleteTranscriptSnapshot(slug)
          continue
        }
        pendingTranscriptRefreshes.add(slug)
        retryMs = retryMs === undefined ? result.retryAfterMs : Math.min(retryMs, result.retryAfterMs)
        continue
      }
      if (result.kind === "unavailable") {
        for (const ws of registry.subscribers(slug)) closeSocket(ws, 1011, "transcript unavailable")
        lastSig.delete(slug)
        deleteTranscriptSnapshot(slug)
        continue
      }
      if (result.kind === "oversized") {
        const subscribers = registry.subscribers(slug)
        for (const ws of subscribers) {
          dropSubscription(ws, slug)
          sendPayloadTooLarge(ws, {
            t: "payload-too-large",
            channel: "transcript",
            slug,
            actualBytes: result.actualBytes,
            maxBytes: maxLogicalFrameBytes,
          })
        }
        lastSig.delete(slug)
        deleteTranscriptSnapshot(slug)
        continue
      }
      if (result.snapshot.sig === lastSig.get(slug)) continue
      let sent = false
      for (const ws of registry.subscribers(slug)) {
        if (sendEncoded(ws, result.snapshot.frame).kind === "sent") sent = true
      }
      if (sent) lastSig.set(slug, result.snapshot.sig)
    }
    if (pendingTranscriptRefreshes.size) scheduleTranscriptFlush(retryMs ?? 0)
  }

  const offTranscript = deps.transcriptChange.on((slugs) => {
    if (closing) return
    for (const slug of slugs) {
      deleteTranscriptSnapshot(slug) // dirty NOW: a same-tick subscriber can never receive old content
      pendingTranscriptRefreshes.add(slug)
    }
    if (pendingTranscriptRefreshes.size) scheduleTranscriptFlush()
  })

  function initializeConnection(ws: WebSocket): void {
    if (closing) {
      closeSocket(ws, 1012, "server restarting")
      return
    }
    // Board channel: SUBSCRIBE FIRST + buffer, capture the keyframe, then flush — the same ordering
    // guarantee as the /events SSE handler (app.ts). A publish that fires while we assemble the keyframe is
    // buffered; its seq is ≤ the keyframe's, so the client's dup-guard drops it. No delta is lost.
    let flushed = false
    let boardDisabled = false
    const buffer: ServerEvent[] = []
    let unsubscribeBus = () => {}
    const sendBoardEvent = (event: ServerEvent): boolean => {
      if (boardDisabled) return false
      const result = sendMsg(ws, { t: "event", event })
      if (result.kind === "oversized") {
        boardDisabled = true
        try {
          unsubscribeBus()
        } catch {
          // The typed downgrade is already terminal for this connection's board channel.
        }
        sendPayloadTooLarge(ws, {
          t: "payload-too-large",
          channel: "board",
          actualBytes: result.actualBytes,
          maxBytes: maxLogicalFrameBytes,
        })
        return false
      }
      return result.kind === "sent"
    }
    try {
      unsubscribeBus = deps.bus.subscribe((event) => {
        if (flushed) {
          sendBoardEvent(event)
          return
        }
        if (buffer.length >= maxBufferedKeyframeEvents) {
          closeSocket(ws, 1013, "keyframe backlog")
          return
        }
        buffer.push(event)
      })
    } catch {
      closeSocket(ws, 1011, "board unavailable")
      return
    }

    const keyframe = (async () => {
      try {
        const board = await deps.boardSnapshot()
        if (closing) return
        sendBoardEvent({ type: "board", board, seq: deps.currentSeq(), bootId: deps.bootId })
      } catch {
        // board not ready: skip the keyframe. The client has no base yet, so the next board-delta makes it
        // resync (reconnect) — which retries this keyframe. A transient snapshot failure self-heals on the
        // reconnect; this mirrors the /events SSE handler's identical behavior (app.ts).
      }
      flushed = true
      for (const event of buffer) if (!sendBoardEvent(event)) break
      buffer.length = 0
    })()
    keyframes.add(keyframe)
    void keyframe.finally(() => keyframes.delete(keyframe)).catch(() => {})

    const heartbeat = setInterval(() => sendMsg(ws, { t: "hb" }), HEARTBEAT_MS)
    heartbeat.unref?.()
    let windowStartedAt = now()
    let messagesInWindow = 0

    ws.on("message", (raw, isBinary) => {
      // close() flips readyState synchronously. Ignore frames already parsed/queued by ws after any
      // policy violation so a single coalesced flood cannot keep reaching transcript work while the
      // close handshake drains.
      if (closing || ws.readyState !== ws.OPEN) return
      const at = now()
      if (at - windowStartedAt >= messageWindowMs) {
        windowStartedAt = at
        messagesInWindow = 0
      }
      messagesInWindow++
      if (messagesInWindow > maxMessagesPerWindow) {
        closeSocket(ws, 1008, "message rate exceeded")
        return
      }
      if (isBinary) {
        closeSocket(ws, 1003, "text frames required")
        return
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(raw.toString())
      } catch {
        closeSocket(ws, 1008, "invalid message")
        return
      }
      const parsed = SocketClientMsg.safeParse(decoded)
      if (!parsed.success) {
        closeSocket(ws, 1008, "invalid message")
        return
      }
      const msg = parsed.data
      if (msg.t === "sub") {
        // A duplicate subscription is a true no-op: it consumes rate budget but cannot force another
        // disk read or transcript serialization.
        if (registry.isSubscribed(ws, msg.slug)) return
        if (registry.slugsFor(ws).length >= maxSubscriptions) {
          closeSocket(ws, 1008, "subscription limit exceeded")
          return
        }
        registry.subscribe(ws, msg.slug)
        enqueueSubscriptionPush(ws, msg.slug)
      } else if (msg.t === "unsub") {
        cancelPendingSubscriptionPush(ws, msg.slug)
        dropSubscription(ws, msg.slug)
      }
    })

    ws.on("close", () => {
      try {
        unsubscribeBus()
      } catch {
        // A broken producer cleanup must not skip this connection's remaining resource cleanup.
      }
      clearInterval(heartbeat)
      cancelPendingSubscriptionPush(ws)
      const terminationTimer = terminationTimers.get(ws)
      if (terminationTimer) clearTimeout(terminationTimer)
      terminationTimers.delete(ws)
      const held = registry.slugsFor(ws) // capture BEFORE removeConn so we can reclaim orphaned signatures
      registry.removeConn(ws) // leak-guard: drop this connection from every slug it held
      for (const slug of held) {
        if (!registry.hasSubscribers(slug)) {
          lastSig.delete(slug)
          deleteTranscriptSnapshot(slug)
        }
      }
      socketOrigins.delete(ws)
    })
    ws.on("error", () => {
      closeSocket(ws, 1011, "transport failed")
    })
  }

  wss.on("error", () => {})
  wss.on("connection", (ws: WebSocket) => {
    connectionCount++
    ws.once("close", () => {
      connectionCount = Math.max(0, connectionCount - 1)
    })
    if (closing) {
      closeSocket(ws, 1012, "server restarting")
      return
    }
    try {
      initializeConnection(ws)
    } catch {
      closeSocket(ws, 1011, "connection failed")
    }
  })

  return {
    handleUpgrade(req, socket, head) {
      if (!isWsPath(req.url)) return false
      if (closing) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable")
        return true
      }
      // The first frame is a full project board, so apply the same mandatory browser-origin boundary as
      // the terminal before the WebSocket parser or any board/transcript work is reachable.
      if (!isTrustedLocalWebSocketRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return true
      }
      // Reserve before handing bytes to ws so simultaneous upgrades cannot all observe the same final
      // slot. Capacity rejection stays an HTTP 503: a rejected peer never allocates a WebSocket/parser,
      // never reaches a board snapshot, and can retry after another tab closes.
      if (connectionCount + pendingUpgrades >= maxConnections) {
        rejectWebSocketUpgrade(socket, 503, "WebSocket capacity reached")
        return true
      }
      pendingUpgrades++
      let reserved = true
      const releaseReservation = () => {
        if (!reserved) return
        reserved = false
        pendingUpgrades = Math.max(0, pendingUpgrades - 1)
      }
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          releaseReservation()
          const origin = req.headers.origin
          if (typeof origin === "string") socketOrigins.set(ws, origin)
          wss.emit("connection", ws, req)
        })
      } catch {
        releaseReservation()
        rejectWebSocketUpgrade(socket, 400, "Bad Request")
      }
      return true
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      try {
        offTranscript()
      } catch {
        // Continue reclaiming sockets even if a custom producer cleanup fails.
      }
      if (subscriptionFlushImmediate) clearImmediate(subscriptionFlushImmediate)
      subscriptionFlushImmediate = null
      pendingSubscriptionPushes.clear()
      if (transcriptRefreshTimer) clearTimeout(transcriptRefreshTimer)
      transcriptRefreshTimer = null
      pendingTranscriptRefreshes.clear()
      clearTranscriptSnapshots()
      globalReadTimes.length = 0
      originReadTimes.clear()
      // Force clients onto their reconnect path before the old process releases its listener. Normal
      // close handshakes can otherwise keep a replaced dev child alive indefinitely in a sleeping tab.
      const socketDrains = [...wss.clients].map((ws) => new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once("close", () => resolve())
        try {
          ws.terminate()
        } catch {
          resolve() // One broken client must not keep the rest of the server alive.
        }
      }))
      lastSig.clear()
      closePromise = (async () => {
        // A keyframe may already be awaiting a board rebuild. Drain it before its dependencies close;
        // the `closing` check above prevents it from reading currentSeq or sending after the await.
        await Promise.allSettled([...keyframes, ...socketDrains])
        try {
          wss.close()
        } catch {
          // Idempotent shutdown after a failed boot/upgrade.
        }
      })()
      return closePromise
    },
    registry,
    get lastSigSize() {
      return lastSig.size
    },
    get connectionCount() {
      return connectionCount
    },
    get transcriptCacheEntries() {
      return transcriptCache.size
    },
    get transcriptCacheBytes() {
      return transcriptCacheBytes
    },
    get pendingTranscriptRefreshes() {
      return pendingTranscriptRefreshes.size
    },
  }
}
