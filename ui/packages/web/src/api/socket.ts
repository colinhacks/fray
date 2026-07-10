import type { QueryClient } from "@tanstack/react-query"
import type { SocketClientMsg, SocketServerMsg } from "@fray-ui/shared"
import { store } from "../store.ts"
import { BoardStream } from "./board-stream.ts"
import { connectSSE } from "./sse.ts"
import { mergeOptimistic, type QueuedMessage } from "../lib/transcript-sync.ts"

// The stage-2 multiplexed client: ONE WebSocket("/ws") carrying the board channel (keyframe + deltas +
// notify, driven through the shared BoardStream) AND per-thread transcript push (replacing the 1.5s
// threadTranscript poll). Terminals keep their own /term/:slug socket.
//
// GRACEFUL FALLBACK: a pre-restart server has no /ws route — its upgrade handler destroys the socket, so
// we never see `onopen`. On a close/error BEFORE the socket ever confirms, we hand the board channel back
// to the proven SSE path (connectSSE) and useTranscript keeps polling — i.e. EXACTLY today's behavior.
// Once confirmed, transient drops reconnect on /ws (never fall back); the boot-id reload closes the
// bundle-mismatch window across a server bounce.

let ws: WebSocket | null = null
let qc: QueryClient | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let health: ReturnType<typeof setInterval> | null = null
let failures = 0
let lastMsg = 0
// /ws proved live at least once this session (onopen fired). A PERMANENT latch by design: after the first
// confirm, later drops reconnect on /ws with backoff and never fall back. Bounces are forward-only (/ws is
// only ever ADDED), so a hypothetical restart to a /ws-less build would retry (backoff-capped, not a storm)
// rather than degrade — an accepted tradeoff for not re-probing SSE on every transient blip.
let confirmed = false
let fellBack = false // committed to the SSE fallback — never touch /ws again this session

// slug → count of interested surfaces (main ChatView + any drawer ChatViews on the same running thread).
// Ref-counted so a drawer close doesn't unsubscribe a slug the main view still shows; the server holds one
// subscription per connection per slug, so we send `sub` on 0→1 and `unsub` on 1→0.
const subs = new Map<string, number>()

// Board seq-gap resync = reconnect the socket (mirror sse.ts): drop + immediately re-open; the connect
// handshake re-sends a full keyframe with the current seq. Deliberately skips the backoff/failure counter.
const stream = new BoardStream(() => resync())

// Server pushes a 10s heartbeat; if we go quiet past this we assume the socket is dead and reconnect.
const HEARTBEAT_TIMEOUT = 35_000

function wsUrl(): string {
  return `${location.origin.replace(/^http/, "ws")}/ws`
}

function connect(): void {
  if (ws || fellBack) return
  if (store.connection !== "open") store.connection = "connecting"
  const sock = new WebSocket(wsUrl())
  ws = sock
  lastMsg = Date.now()

  sock.onopen = () => {
    // The server spoke WebSocket on /ws → the route exists → commit to socket mode.
    confirmed = true
    failures = 0
    lastMsg = Date.now()
    store.connection = "open"
    store.socketTranscripts = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    resubscribe() // replay every active transcript subscription on the fresh socket
  }

  sock.onmessage = (e) => {
    lastMsg = Date.now()
    try {
      handle(JSON.parse(e.data) as SocketServerMsg)
    } catch (err) {
      console.error("bad /ws message", err)
    }
  }

  // Let onclose drive recovery (onerror always precedes a close for a failed/closed socket).
  sock.onerror = () => {}
  sock.onclose = () => {
    if (ws !== sock) return // superseded by a newer socket (resync/forceReconnect already handled it)
    ws = null
    onDrop()
  }

  installHealth()
}

// Detach handlers + close WITHOUT triggering the onclose recovery path — for INTENTIONAL drops
// (resync / watchdog) that immediately reconnect themselves.
function dropWs(): void {
  const sock = ws
  ws = null
  if (!sock) return
  sock.onopen = null
  sock.onmessage = null
  sock.onerror = null
  sock.onclose = null
  try {
    sock.close()
  } catch {
    // already closing/closed
  }
}

// An UNEXPECTED close. If /ws never confirmed, the server has no /ws route (pre-restart) → fall back to
// SSE for good. Otherwise it's a transient drop → reconnect on /ws with backoff (same robustness as SSE).
function onDrop(): void {
  stream.reset() // the socket is gone; the fresh keyframe re-establishes the seq
  if (!confirmed) {
    fallBackToSSE()
    return
  }
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  scheduleReconnect()
}

function scheduleReconnect(immediate = false): void {
  if (reconnectTimer) {
    if (!immediate) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const delay = immediate ? 0 : Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15_000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

// Board seq gap: drop the socket and immediately re-open for a fresh keyframe. NOT a failure (the
// connection is healthy) so it skips the backoff/failure counter; connect()'s "open" guard avoids flicker.
function resync(): void {
  stream.reset()
  dropWs()
  connect()
}

function installHealth(): void {
  if (health) return
  health = setInterval(() => {
    if (ws && Date.now() - lastMsg > HEARTBEAT_TIMEOUT) forceReconnect()
  }, 10_000)

  // Timers throttle in hidden tabs and stall across machine sleep, so a dead socket can sit unnoticed.
  // These wake signals force an immediate staleness check the moment the user is back.
  const wake = () => {
    if (fellBack) return
    if (!ws || Date.now() - lastMsg > HEARTBEAT_TIMEOUT) forceReconnect(true)
  }
  window.addEventListener("focus", wake)
  window.addEventListener("online", wake)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake()
  })
}

// Watchdog/wake-triggered reconnect. A socket that never confirmed and has now gone stale is treated like
// an unconfirmed drop (fall back to SSE); a confirmed one reconnects with backoff.
function forceReconnect(immediate = false): void {
  if (fellBack) return
  dropWs()
  stream.reset()
  if (!confirmed) {
    fallBackToSSE()
    return
  }
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
  scheduleReconnect(immediate)
}

function fallBackToSSE(): void {
  if (fellBack) return
  fellBack = true
  store.socketTranscripts = false // useTranscript resumes its 1.5s poll (today's behavior)
  // Hand the board channel + notifications to the proven SSE path.
  connectSSE()
}

function handle(msg: SocketServerMsg): void {
  switch (msg.t) {
    case "event":
      stream.handle(msg.event)
      break
    case "transcript":
      // Write server truth into the SAME cache useTranscript reads — components are unchanged. PRESERVE any
      // optimistic `queued` bubble the incoming truth doesn't yet carry (mergeOptimistic), so a just-sent
      // follow-up never vanishes in the window before the server's own copy lands (the S1 sync-audit fix).
      qc?.setQueryData<{ messages: QueuedMessage[] }>(["transcript", msg.slug], (prev) => ({
        messages: mergeOptimistic(prev?.messages, msg.messages as QueuedMessage[]),
      }))
      break
    case "hb":
      break // lastMsg already bumped
  }
}

function send(msg: SocketClientMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function resubscribe(): void {
  for (const slug of subs.keys()) send({ t: "sub", topic: "transcript", slug })
}

// ── Public API (used by useTranscript) ───────────────────────────────────────────────────────────────

// Register interest in a thread's transcript. Ref-counted: the first interested surface sends `sub`;
// later ones just bump the count. A no-op before the socket opens — resubscribe() replays on open.
export function subscribeTranscript(slug: string): void {
  const n = (subs.get(slug) ?? 0) + 1
  subs.set(slug, n)
  if (n === 1) send({ t: "sub", topic: "transcript", slug })
}

// Drop one surface's interest. The LAST one sends `unsub` and forgets the slug (no leak); others decrement.
export function unsubscribeTranscript(slug: string): void {
  const n = (subs.get(slug) ?? 0) - 1
  if (n <= 0) {
    subs.delete(slug)
    send({ t: "unsub", topic: "transcript", slug })
  } else {
    subs.set(slug, n)
  }
}

// Entry point (replaces connectSSE in main.tsx). Deferred to `load` so the socket doesn't consume one of
// Chrome's 6 per-host connection slots while Vite is still streaming modules in dev.
export function connectSync(queryClient: QueryClient): void {
  qc = queryClient
  const go = () => connect()
  if (document.readyState === "complete") go()
  else window.addEventListener("load", go, { once: true })
}
