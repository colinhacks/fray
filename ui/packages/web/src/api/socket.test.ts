import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, SocketServerMsg } from "@fray-ui/shared"

type Listener = (event: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  closeCalls = 0
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null
  onclose: Listener | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  message(message: SocketServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({})
  }

  send(data: string): void {
    this.sent.push(String(data))
  }

  close(): void {
    this.closeCalls++
    this.readyState = FakeWebSocket.CLOSED
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closeCalls = 0
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onerror: Listener | null = null
  private listeners = new Map<string, Listener[]>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.closeCalls++
  }
}

interface FakeTimeout {
  id: number
  delay: number
  run: () => void
  cleared: boolean
}

test("socket transport bounds oversized frames and only resets reconnect backoff after protocol traffic", async () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }

  const windowListeners = new Map<string, Listener[]>()
  const documentListeners = new Map<string, Listener[]>()
  const addListener = (target: Map<string, Listener[]>) => (type: string, listener: Listener) => {
    const listeners = target.get(type) ?? []
    listeners.push(listener)
    target.set(type, listeners)
  }
  const storage = new Map<string, string>()
  const timeouts: FakeTimeout[] = []
  let nextTimer = 0
  const intervals = new Set<number>()

  install("WebSocket", FakeWebSocket)
  install("EventSource", FakeEventSource)
  install("location", { origin: "http://127.0.0.1:54917", reload: () => {} })
  install("window", {
    addEventListener: addListener(windowListeners),
    removeEventListener: () => {},
    focus: () => {},
  })
  install("document", {
    readyState: "complete",
    hidden: false,
    addEventListener: addListener(documentListeners),
    removeEventListener: () => {},
  })
  install("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  install("setTimeout", ((fn: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timeout: FakeTimeout = {
      id: ++nextTimer,
      delay,
      run: () => fn(...args),
      cleared: false,
    }
    timeouts.push(timeout)
    return timeout.id
  }) as typeof setTimeout)
  install("clearTimeout", ((id: number) => {
    const timeout = timeouts.find((candidate) => candidate.id === Number(id))
    if (timeout) timeout.cleared = true
  }) as typeof clearTimeout)
  install("setInterval", ((() => {
    const id = ++nextTimer
    intervals.add(id)
    return id
  }) as unknown) as typeof setInterval)
  install("clearInterval", ((id: number) => {
    intervals.delete(Number(id))
  }) as typeof clearInterval)

  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }

  const board: BoardSnapshot = {
    projectDir: "/fixture",
    projectName: "fixture",
    projectLabel: "fixture/fixture",
    frayActive: true,
    threads: [],
    errors: [],
    warnings: [],
  }
  const boardFrame: SocketServerMsg = {
    t: "event",
    event: { type: "board", board, seq: 1, bootId: "boot-test" },
  }
  const cache = new Map<string, unknown>()
  const queryClient = {
    setQueryData(key: readonly unknown[], update: unknown) {
      const cacheKey = JSON.stringify(key)
      const previous = cache.get(cacheKey)
      cache.set(cacheKey, typeof update === "function" ? (update as (value: unknown) => unknown)(previous) : update)
    },
    invalidateQueries: async () => {},
  }

  const resetTransportFixtures = () => {
    FakeWebSocket.instances = []
    timeouts.length = 0
    windowListeners.clear()
    documentListeners.clear()
  }
  const nextReconnect = (expectedDelay: number) => {
    const timeout = timeouts.find((candidate) => !candidate.cleared)
    assert.ok(timeout, `expected a ${expectedDelay}ms reconnect`)
    assert.equal(timeout.delay, expectedDelay)
    timeout.cleared = true
    timeout.run()
  }

  try {
    const { store } = await import("../store.ts")

    // Opening TCP repeatedly is not enough to erase failure history. A healthy protocol frame is.
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketBoardFallback = null
    store.socketTranscriptFallbacks = {}
    const backoff = await import(`./socket.ts?backoff-${Date.now()}`)
    backoff.connectSync(queryClient as never)
    const first = FakeWebSocket.instances[0]
    first.open()
    first.serverClose()
    nextReconnect(1_000)
    const second = FakeWebSocket.instances[1]
    second.open()
    second.serverClose()
    nextReconnect(2_000)
    const third = FakeWebSocket.instances[2]
    third.open()
    third.message({ t: "hb" })
    third.serverClose()
    assert.equal(timeouts.find((candidate) => !candidate.cleared)?.delay, 1_000)

    // A transcript overflow removes only that live subscription. It neither reconnects nor polls;
    // one explicit retry sends one subscription and a normal frame clears the stable fallback.
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketBoardFallback = null
    store.socketTranscriptFallbacks = {}
    const transcript = await import(`./socket.ts?transcript-${Date.now()}`)
    transcript.connectSync(queryClient as never)
    const transcriptSocket = FakeWebSocket.instances[0]
    transcriptSocket.open()
    transcript.subscribeTranscript("large-thread")
    assert.deepEqual(transcriptSocket.sent, [], "subscriptions wait for a valid board keyframe")
    transcriptSocket.message(boardFrame)
    assert.deepEqual(transcriptSocket.sent.map(JSON.parse), [
      { t: "sub", topic: "transcript", slug: "large-thread" },
    ])
    transcriptSocket.message({
      t: "payload-too-large",
      channel: "transcript",
      slug: "large-thread",
      actualBytes: 4_194_305,
      maxBytes: 4_194_304,
    })
    assert.deepEqual(store.socketTranscriptFallbacks["large-thread"], {
      kind: "payload-too-large",
      actualBytes: 4_194_305,
      maxBytes: 4_194_304,
    })
    assert.equal(transcriptSocket.readyState, FakeWebSocket.OPEN)
    assert.equal(FakeEventSource.instances.length, 0)
    assert.equal(timeouts.length, 0, "a logical overflow cannot enter reconnect backoff")
    transcript.subscribeTranscript("large-thread")
    assert.equal(transcriptSocket.sent.length, 1, "additional mounted views cannot auto-retry a paused slug")
    transcript.retryTranscriptSocket("large-thread")
    assert.equal(transcriptSocket.sent.length, 2, "the explicit retry sends exactly one subscription")
    transcriptSocket.message({
      t: "transcript",
      slug: "large-thread",
      messages: [{ role: "assistant", text: "small again", tools: [], parts: [] }],
    })
    assert.equal(store.socketTranscriptFallbacks["large-thread"], undefined)
    assert.deepEqual(cache.get(JSON.stringify(["transcript", "large-thread"])), {
      messages: [{ role: "assistant", text: "small again", tools: [], parts: [] }],
    })

    // A fresh page/module has no stale failure latch: after the payload shrinks, normal keyframe +
    // transcript traffic resumes without requiring a special server-side recovery state.
    transcriptSocket.close()
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketBoardFallback = null
    store.socketTranscriptFallbacks = {}
    const reloaded = await import(`./socket.ts?reload-${Date.now()}`)
    reloaded.connectSync(queryClient as never)
    const reloadedSocket = FakeWebSocket.instances[0]
    reloadedSocket.open()
    reloaded.subscribeTranscript("large-thread")
    reloadedSocket.message(boardFrame)
    reloadedSocket.message({
      t: "transcript",
      slug: "large-thread",
      messages: [{ role: "assistant", text: "recovered on reload", tools: [], parts: [] }],
    })
    assert.equal(store.socketTranscriptFallbacks["large-thread"], undefined)
    assert.equal(reloadedSocket.sent.length, 1)

    // Aggregate server read pressure rejects only the affected subscription with a typed, stable state.
    // It never drops the board socket; one human retry sends one new sub and normal truth clears it.
    reloadedSocket.close()
    resetTransportFixtures()
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketBoardFallback = null
    store.socketTranscriptFallbacks = {}
    const limited = await import(`./socket.ts?limited-${Date.now()}`)
    limited.connectSync(queryClient as never)
    const limitedSocket = FakeWebSocket.instances[0]
    limitedSocket.open()
    limited.subscribeTranscript("busy-thread")
    limitedSocket.message(boardFrame)
    limitedSocket.message({
      t: "resource-limited",
      resource: "transcript-read",
      scope: "origin",
      slug: "busy-thread",
      retryAfterMs: 750,
    })
    assert.deepEqual(store.socketTranscriptFallbacks["busy-thread"], {
      kind: "read-budget",
      scope: "origin",
      retryAfterMs: 750,
    })
    assert.equal(limitedSocket.readyState, FakeWebSocket.OPEN)
    assert.equal(timeouts.length, 0)
    limited.retryTranscriptSocket("busy-thread")
    assert.equal(limitedSocket.sent.length, 2)
    limitedSocket.message({
      t: "transcript",
      slug: "busy-thread",
      messages: [{ role: "assistant", text: "budget recovered", tools: [], parts: [] }],
    })
    assert.equal(store.socketTranscriptFallbacks["busy-thread"], undefined)

    // Board overflow is a one-way, intentional SSE handoff. Closing that socket cannot schedule a
    // reconnect, and the visible board fallback state remains stable while SSE takes over.
    limitedSocket.close()
    resetTransportFixtures()
    FakeEventSource.instances = []
    store.connection = "connecting"
    store.socketTranscripts = false
    store.socketBoardFallback = null
    store.socketTranscriptFallbacks = {
      stale: { kind: "payload-too-large", actualBytes: 9, maxBytes: 8 },
    }
    const boardFallback = await import(`./socket.ts?board-${Date.now()}`)
    boardFallback.connectSync(queryClient as never)
    const boardSocket = FakeWebSocket.instances[0]
    boardSocket.open()
    boardSocket.message({
      t: "payload-too-large",
      channel: "board",
      actualBytes: 4_194_305,
      maxBytes: 4_194_304,
    })
    assert.equal(boardSocket.closeCalls, 1)
    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(FakeEventSource.instances[0].url, "/events")
    assert.deepEqual(store.socketBoardFallback, { actualBytes: 4_194_305, maxBytes: 4_194_304 })
    assert.deepEqual(store.socketTranscriptFallbacks, {})
    assert.equal(store.socketTranscripts, false)
    assert.equal(timeouts.length, 0)
    assert.equal(warnings.length, 3, "each explicit downgrade logs once without console churn")
  } finally {
    console.warn = originalWarn
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
