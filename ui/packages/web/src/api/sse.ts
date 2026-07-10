import type { ServerEvent } from "@fray-ui/shared"
import { store } from "../store.ts"
import { BoardStream } from "./board-stream.ts"

// The SSE transport — the FALLBACK path once the /ws multiplex exists (socket.ts calls connectSSE() when
// a pre-restart server has no /ws route). It carries the board channel (keyframe + deltas + notify) through
// the shared BoardStream — the exact same delta/seq/boot state machine the socket uses. Transcript freshness
// on this path stays the 1.5s useTranscript poll (store.socketTranscripts is false while SSE is the source).

let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lastMsg = 0
let health: ReturnType<typeof setInterval> | null = null
let failures = 0

// Board seq-gap resync = reconnect the EventSource: the connect handshake re-sends the full board as a
// fresh keyframe with the current seq. NOT a failure (the connection is healthy) so it skips backoff.
const stream = new BoardStream(() => resync())

// Server pushes full board snapshots (+ optional heartbeats). If we go quiet for
// this long we assume the connection is dead and reconnect. Reattach is cheap.
const HEARTBEAT_TIMEOUT = 35_000

function connect() {
  if (es) return
  if (store.connection !== "open") store.connection = "connecting"
  es = new EventSource("/events")
  lastMsg = Date.now()

  es.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    failures = 0
    lastMsg = Date.now()
    store.connection = "open"
  }

  es.addEventListener("heartbeat", () => {
    lastMsg = Date.now()
  })

  es.onmessage = (e) => {
    lastMsg = Date.now()
    try {
      stream.handle(JSON.parse(e.data) as ServerEvent)
    } catch (err) {
      console.error("bad SSE event", err)
    }
  }

  es.onerror = () => reconnect()

  if (!health) {
    health = setInterval(() => {
      if (es && Date.now() - lastMsg > HEARTBEAT_TIMEOUT) reconnect()
    }, 10_000)

    // Timers throttle in hidden tabs and stall across machine sleep, so a dead socket can sit
    // unnoticed until long after the user returns. These wake signals force an IMMEDIATE
    // staleness check + reconnect the moment the user is back.
    const wake = () => {
      if (!es || Date.now() - lastMsg > HEARTBEAT_TIMEOUT) reconnect(true)
    }
    window.addEventListener("focus", wake)
    window.addEventListener("online", wake)
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) wake()
    })
  }
}

// Drop the socket and schedule a retry. While actively retrying the dot shows "connecting…";
// only a run of consecutive failures reads as truly "disconnected". Backoff grows 1s → 15s;
// `immediate` (user-return wake signals) skips the wait entirely.
function reconnect(immediate = false) {
  es?.close()
  es = null
  // The socket is gone; the fresh connect will re-establish the keyframe. Drop the seq so any stray
  // delta arriving before that keyframe forces a resync rather than applying against a torn base.
  stream.reset()
  failures++
  store.connection = failures > 3 ? "closed" : "connecting"
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

// Force a fresh full-board keyframe by reconnecting. A seq gap means we can no longer trust the
// incremental board, and SSE is one-directional (no in-band resync request), so the cleanest resync is
// to drop and immediately re-open: the connect handshake re-sends the whole board with the current seq.
// This is NOT a failure — the connection is healthy — so it deliberately skips the backoff/failure
// counter; connect()'s "open" guard keeps the connection dot from flickering.
function resync() {
  stream.reset()
  es?.close()
  es = null
  connect()
}

// Connect after load so the SSE socket doesn't consume one of Chrome's 6 per-host
// connection slots while Vite is still streaming modules in dev.
export function connectSSE() {
  if (document.readyState === "complete") connect()
  else window.addEventListener("load", connect, { once: true })
}
