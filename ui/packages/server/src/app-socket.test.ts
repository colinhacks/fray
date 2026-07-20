import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { WebSocket, type ClientOptions } from "ws"
import type { BoardSnapshot, SocketServerMsg, TranscriptMessage } from "@fray-ui/shared"
import { Bus, Emitter } from "./bus.ts"
import {
  APP_SOCKET_MAX_MESSAGE_BYTES,
  createAppSocketServer,
  SubscriptionRegistry,
  type AppSocketDeps,
} from "./app-socket.ts"

// ── SubscriptionRegistry (pure unit) ──────────────────────────────────────────────────────────────────

test("registry: subscribe/unsubscribe/subscribers/hasSubscribers", () => {
  const r = new SubscriptionRegistry<string>()
  assert.equal(r.subscribe("c1", "a"), true) // first subscriber for the slug
  assert.equal(r.subscribe("c2", "a"), false) // slug already had a subscriber
  assert.equal(r.subscribe("c1", "a"), false) // idempotent — same conn+slug
  assert.deepEqual(r.subscribers("a").sort(), ["c1", "c2"])
  assert.equal(r.hasSubscribers("a"), true)
  assert.equal(r.slugCount, 1)

  r.unsubscribe("c1", "a")
  assert.deepEqual(r.subscribers("a"), ["c2"])
  assert.equal(r.hasSubscribers("a"), true)
  r.unsubscribe("c2", "a")
  assert.equal(r.hasSubscribers("a"), false)
  assert.equal(r.slugCount, 0)
  assert.equal(r.connCount, 0)
})

test("registry: removeConn clears a connection from every slug (no leak)", () => {
  const r = new SubscriptionRegistry<string>()
  r.subscribe("c1", "a")
  r.subscribe("c1", "b")
  r.subscribe("c2", "a")
  assert.deepEqual(r.slugsFor("c1").sort(), ["a", "b"])

  r.removeConn("c1")
  assert.deepEqual(r.slugsFor("c1"), [])
  assert.deepEqual(r.subscribers("a"), ["c2"]) // c2's subscription survives
  assert.equal(r.hasSubscribers("b"), false) // b had only c1 → gone
  assert.equal(r.connCount, 1) // only c2 remains

  r.removeConn("c2")
  assert.equal(r.slugCount, 0)
  assert.equal(r.connCount, 0)
})

// ── in-process /ws protocol ─────────────────────────────────────────────────────────────────────────

const board: BoardSnapshot = {
  projectDir: "/x",
  projectName: "x",
  projectLabel: "x/x",
  frayActive: true,
  threads: [],
  errors: [],
  warnings: [],
}
const msg = (text: string): TranscriptMessage => ({ role: "assistant", text, tools: [], parts: [] })
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Harness {
  server: Server
  port: number
  bus: Bus
  transcriptChange: Emitter<string[]>
  transcripts: Map<string, TranscriptMessage[]>
  appSocket: ReturnType<typeof createAppSocketServer>
  close: () => Promise<void>
}

async function startHarness(overrides: Partial<AppSocketDeps> = {}): Promise<Harness> {
  const bus = new Bus()
  const transcriptChange = new Emitter<string[]>()
  const transcripts = new Map<string, TranscriptMessage[]>()
  const appSocket = createAppSocketServer({
    bus,
    bootId: "boot-1",
    transcriptChange,
    boardSnapshot: async () => board,
    currentSeq: () => 7,
    readTranscript: (slug) => transcripts.get(slug) ?? [],
    ...overrides,
  })
  const server = createServer()
  server.on("upgrade", (req, socket, head) => {
    if (!appSocket.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    bus,
    transcriptChange,
    transcripts,
    appSocket,
    close: () =>
      new Promise<void>((r) => {
        void appSocket.close().finally(() => server.close(() => r()))
      }),
  }
}

function collect(ws: WebSocket) {
  const q: SocketServerMsg[] = []
  const waiters: ((m: SocketServerMsg) => void)[] = []
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as SocketServerMsg
    const w = waiters.shift()
    if (w) w(m)
    else q.push(m)
  })
  return {
    q,
    next(timeoutMs = 1000): Promise<SocketServerMsg> {
      const m = q.shift()
      if (m) return Promise.resolve(m)
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("timeout waiting for /ws message")), timeoutMs)
        waiters.push((got) => {
          clearTimeout(t)
          res(got)
        })
      })
    },
    async expectNone(ms = 150): Promise<void> {
      await delay(ms)
      assert.equal(q.length, 0, `expected no message but got ${JSON.stringify(q)}`)
    },
  }
}

async function connectClient(port: number, path = "/ws", options: ClientOptions = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: `http://127.0.0.1:${port}`,
    ...options,
  })
  const c = collect(ws)
  await once(ws, "open")
  return { ws, ...c }
}

async function rejectedClientDetails(
  port: number,
  options: ClientOptions = {},
): Promise<{ status: number; body: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options)
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for /ws rejection")), 1_000)
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout)
      const status = response.statusCode ?? 0
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }))
      response.resume()
    })
    ws.once("open", () => {
      clearTimeout(timeout)
      ws.close()
      reject(new Error("hostile app websocket unexpectedly opened"))
    })
    ws.once("error", () => {})
  })
}

async function rejectedClient(port: number, options: ClientOptions = {}): Promise<number> {
  return (await rejectedClientDetails(port, options)).status
}

test("protocol: connect sends a board keyframe with seq + bootId", async () => {
  const h = await startHarness()
  try {
    const c = await connectClient(h.port)
    const first = await c.next()
    assert.equal(first.t, "event")
    if (first.t === "event") {
      assert.equal(first.event.type, "board")
      if (first.event.type === "board") {
        assert.equal(first.event.seq, 7)
        assert.equal(first.event.bootId, "boot-1")
        assert.deepEqual(first.event.board, board)
      }
    }
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: an oversized initial board produces one typed downgrade without reconnecting or reserializing", async () => {
  let snapshots = 0
  let boardSerializations = 0
  const h = await startHarness({
    maxLogicalFrameBytes: 64,
    boardSnapshot: async () => {
      snapshots++
      return board
    },
    serializeMessage: (serverMsg) => {
      if (serverMsg.t === "event" && serverMsg.event.type === "board") boardSerializations++
      return JSON.stringify(serverMsg)
    },
  })
  try {
    const c = await connectClient(h.port)
    const failure = await c.next()
    assert.deepEqual(failure, {
      t: "payload-too-large",
      channel: "board",
      actualBytes: Buffer.byteLength(JSON.stringify({
        t: "event",
        event: { type: "board", board, seq: 7, bootId: "boot-1" },
      }), "utf8"),
      maxBytes: 64,
    })
    assert.equal(c.ws.readyState, WebSocket.OPEN, "a logical overflow is not a slow-client close")

    h.bus.publish({ type: "notify", slug: "foo", kind: "turn-done", title: "Foo" })
    await c.expectNone(50)
    assert.equal(snapshots, 1)
    assert.equal(boardSerializations, 1, "the failed keyframe is serialized exactly once")
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: process-wide connection capacity rejects before board work and recovers after a tab closes", async () => {
  let snapshots = 0
  const h = await startHarness({
    maxConnections: 2,
    boardSnapshot: async () => {
      snapshots++
      return board
    },
  })
  try {
    const a = await connectClient(h.port)
    const b = await connectClient(h.port)
    await Promise.all([a.next(), b.next()])
    assert.equal(h.appSocket.connectionCount, 2)
    assert.equal(snapshots, 2)

    const denied = await rejectedClientDetails(h.port, {
      origin: `http://127.0.0.1:${h.port}`,
    })
    assert.deepEqual(denied, { status: 503, body: "WebSocket capacity reached\n" })
    assert.equal(snapshots, 2, "a capacity rejection cannot reach board snapshot work")
    assert.equal(h.appSocket.connectionCount, 2)

    const aClosed = once(a.ws, "close")
    a.ws.close()
    await aClosed
    await delay(10)
    assert.equal(h.appSocket.connectionCount, 1)

    const recovery = await connectClient(h.port)
    assert.equal((await recovery.next()).t, "event")
    assert.equal(h.appSocket.connectionCount, 2)
    assert.equal(snapshots, 3)
    b.ws.close()
    recovery.ws.close()
  } finally {
    await h.close()
  }
})

test("security: /ws rejects missing, hostile, prefix, port, Host, and forwarded origins before reading the board", async () => {
  let snapshots = 0
  const h = await startHarness({
    boardSnapshot: async () => {
      snapshots++
      return board
    },
  })
  const validOrigin = `http://127.0.0.1:${h.port}`
  try {
    assert.equal(await rejectedClient(h.port), 403)
    for (const origin of [
      "http://evil.example",
      `http://localhost.evil.example:${h.port}`,
      `http://127.0.0.1.evil.example:${h.port}`,
      `http://127.0.0.1:${h.port + 1}`,
      `http://localhost:${h.port}`,
      "null",
    ]) {
      assert.equal(await rejectedClient(h.port, { origin }), 403, origin)
    }
    assert.equal(await rejectedClient(h.port, {
      origin: validOrigin,
      headers: { host: `localhost.evil.example:${h.port}` },
    }), 403)
    assert.equal(await rejectedClient(h.port, {
      origin: validOrigin,
      headers: { "x-forwarded-proto": "http" },
    }), 403)
    assert.equal(snapshots, 0, "untrusted upgrades cannot reach the project keyframe")
    assert.equal(h.appSocket.registry.connCount, 0)

    const valid = await connectClient(h.port)
    assert.equal((await valid.next()).t, "event")
    assert.equal(snapshots, 1)
    valid.ws.close()
  } finally {
    await h.close()
  }
})

test("security: /ws enforces strict bounded text frames and contains malformed or oversized clients", async () => {
  const h = await startHarness()
  try {
    for (const invalid of [
      "{",
      JSON.stringify({ t: "sub", topic: "transcript", slug: "foo", extra: true }),
      JSON.stringify({ t: "sub", topic: "transcript", slug: "../escape" }),
      JSON.stringify({ t: "sub", topic: "transcript", slug: "a".repeat(201) }),
    ]) {
      const client = await connectClient(h.port)
      await client.next()
      const closed = once(client.ws, "close") as Promise<[number, Buffer]>
      client.ws.send(invalid)
      assert.equal((await closed)[0], 1008, invalid.slice(0, 80))
    }

    const binary = await connectClient(h.port)
    await binary.next()
    const binaryClosed = once(binary.ws, "close") as Promise<[number, Buffer]>
    binary.ws.send(Buffer.from("binary"))
    assert.equal((await binaryClosed)[0], 1003)

    const huge = await connectClient(h.port)
    await huge.next()
    const hugeClosed = once(huge.ws, "close") as Promise<[number, Buffer]>
    huge.ws.send("x".repeat(APP_SOCKET_MAX_MESSAGE_BYTES + 1))
    assert.equal((await hugeClosed)[0], 1009)

    const recovery = await connectClient(h.port)
    assert.equal((await recovery.next()).t, "event")
    recovery.ws.close()
  } finally {
    await h.close()
  }
})

test("security: dependency and serialization exceptions close one app socket without poisoning recovery", async () => {
  const circular: unknown[] = []
  circular.push(circular)
  const h = await startHarness({
    readTranscript: (slug) => {
      if (slug === "reader-fails") throw new Error("fixture read failure")
      if (slug === "circular") return circular as TranscriptMessage[]
      return [msg("healthy")]
    },
  })
  try {
    for (const slug of ["reader-fails", "circular"]) {
      const client = await connectClient(h.port)
      await client.next()
      const closed = once(client.ws, "close") as Promise<[number, Buffer]>
      client.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug }))
      assert.equal((await closed)[0], 1011)
    }

    const recovery = await connectClient(h.port)
    await recovery.next()
    recovery.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "healthy" }))
    const pushed = await recovery.next()
    assert.equal(pushed.t, "transcript")
    if (pushed.t === "transcript") assert.deepEqual(pushed.messages, [msg("healthy")])
    recovery.ws.close()
  } finally {
    await h.close()
  }
})

test("security: duplicate subscriptions are read-once, the per-connection cap is enforced, and cleanup is complete", async () => {
  let reads = 0
  const h = await startHarness({
    maxSubscriptionsPerConnection: 2,
    readTranscript: (slug) => {
      reads++
      return [msg(slug)]
    },
  })
  try {
    const client = await connectClient(h.port)
    await client.next()
    const subscribe = (slug: string) => client.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug }))

    subscribe("one")
    assert.equal((await client.next()).t, "transcript")
    subscribe("one")
    await client.expectNone(50)
    assert.equal(reads, 1, "a duplicate cannot force another transcript read")
    assert.equal(h.appSocket.registry.slugCount, 1)

    subscribe("two")
    assert.equal((await client.next()).t, "transcript")
    const closed = once(client.ws, "close") as Promise<[number, Buffer]>
    subscribe("three")
    assert.equal((await closed)[0], 1008)
    await delay(20)
    assert.equal(h.appSocket.registry.connCount, 0)
    assert.equal(h.appSocket.registry.slugCount, 0)
    assert.equal(h.appSocket.lastSigSize, 0)
  } finally {
    await h.close()
  }
})

test("security: a valid-frame flood and a slow outbound consumer are shed without poisoning recovery", async () => {
  let simulateSlow = false
  let transcriptReads = 0
  const h = await startHarness({
    maxMessagesPerWindow: 3,
    messageWindowMs: 60_000,
    maxOutputBufferBytes: 1_024,
    bufferedAmount: () => simulateSlow ? 1_024 : 0,
    readTranscript: () => {
      transcriptReads++
      return []
    },
  })
  try {
    const flood = await connectClient(h.port)
    await flood.next()
    const floodClosed = once(flood.ws, "close") as Promise<[number, Buffer]>
    for (let i = 0; i < 8; i++) {
      flood.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: `flood-${i}` }))
    }
    assert.equal((await floodClosed)[0], 1008)
    assert.equal(
      transcriptReads,
      0,
      "the deferred subscription batch is cancelled when the rate close wins, so no queued read starts",
    )

    const slow = await connectClient(h.port)
    await slow.next()
    simulateSlow = true
    const slowClosed = once(slow.ws, "close") as Promise<[number, Buffer]>
    h.bus.publish({ type: "notify", slug: "foo", kind: "turn-done", title: "Foo" })
    assert.equal((await slowClosed)[0], 1013)

    simulateSlow = false
    const recovery = await connectClient(h.port)
    assert.equal((await recovery.next()).t, "event")
    recovery.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: bus board-delta + notify are forwarded as {t:'event'}", async () => {
  const h = await startHarness()
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe

    h.bus.publish({ type: "board-delta", seq: 8, bootId: "boot-1", upserts: [], removed: [] })
    const delta = await c.next()
    assert.equal(delta.t, "event")
    if (delta.t === "event") assert.equal(delta.event.type, "board-delta")

    h.bus.publish({ type: "notify", slug: "foo", kind: "turn-done", title: "Foo" })
    const notify = await c.next()
    assert.equal(notify.t, "event")
    if (notify.t === "event") assert.equal(notify.event.type, "notify")

    c.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: sub pushes the current transcript immediately", async () => {
  const h = await startHarness()
  h.transcripts.set("foo", [msg("v1")])
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe

    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    const push = await c.next()
    assert.equal(push.t, "transcript")
    if (push.t === "transcript") {
      assert.equal(push.slug, "foo")
      assert.deepEqual(push.messages, [msg("v1")])
    }
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: concurrent tabs coalesce one slow transcript read and one serialization", async () => {
  let reads = 0
  let serializations = 0
  const messages = [msg("shared snapshot")]
  const h = await startHarness({
    maxConnections: 16,
    readTranscript: () => {
      reads++
      const until = Date.now() + 20
      while (Date.now() < until) {
        // Deliberately synchronous like the real readFileSync + parse path.
      }
      return messages
    },
    serializeMessage: (serverMsg) => {
      if (serverMsg.t === "transcript") serializations++
      return JSON.stringify(serverMsg)
    },
  })
  try {
    const clients = await Promise.all(Array.from({ length: 8 }, () => connectClient(h.port)))
    await Promise.all(clients.map((client) => client.next()))
    for (const client of clients) {
      client.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "shared" }))
    }
    const pushes = await Promise.all(clients.map((client) => client.next()))
    for (const push of pushes) {
      assert.equal(push.t, "transcript")
      if (push.t === "transcript") assert.deepEqual(push.messages, messages)
    }
    assert.equal(reads, 1, "all tabs in one subscription batch share the synchronous parse")
    assert.equal(serializations, 1, "all tabs share the exact encoded frame")
    assert.equal(h.appSocket.transcriptCacheEntries, 1)
    assert.ok(h.appSocket.transcriptCacheBytes > 0)

    for (const client of clients) {
      client.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "shared" }))
    }
    await Promise.all(clients.map((client) => client.expectNone(50)))
    assert.equal(reads, 1, "duplicate subscriptions remain true no-ops")
    assert.equal(serializations, 1)
    for (const client of clients) client.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: rapid alternating sub/unsub churn collapses to one surviving read", async () => {
  let reads = 0
  const h = await startHarness({
    maxMessagesPerWindow: 200,
    readTranscript: () => {
      reads++
      return [msg("stable")]
    },
  })
  try {
    const c = await connectClient(h.port)
    await c.next()
    const sub = JSON.stringify({ t: "sub", topic: "transcript", slug: "churn" })
    const unsub = JSON.stringify({ t: "unsub", topic: "transcript", slug: "churn" })
    for (let i = 0; i < 40; i++) {
      c.ws.send(sub)
      c.ws.send(unsub)
    }
    c.ws.send(sub)
    const pushed = await c.next()
    assert.equal(pushed.t, "transcript")
    assert.equal(reads, 1)
    assert.equal(h.appSocket.registry.hasSubscribers("churn"), true)
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: per-origin and global sliding read budgets are fair, typed, and recover", async () => {
  let at = 0
  let reads = 0
  const h = await startHarness({
    now: () => at,
    maxTranscriptReadsPerOrigin: 2,
    maxTranscriptReadsOverall: 3,
    transcriptReadWindowMs: 1_000,
    readTranscript: (slug) => {
      reads++
      return [msg(slug)]
    },
  })
  try {
    const originA = await connectClient(h.port)
    const originB = await connectClient(h.port, "/ws", {
      origin: `http://localhost:${h.port}`,
      headers: { host: `localhost:${h.port}` },
    })
    await Promise.all([originA.next(), originB.next()])
    const sub = (client: typeof originA, slug: string) => {
      client.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug }))
    }
    const unsub = async (client: typeof originA, slug: string) => {
      client.ws.send(JSON.stringify({ t: "unsub", topic: "transcript", slug }))
      await delay(10)
    }

    sub(originA, "a-one")
    assert.equal((await originA.next()).t, "transcript")
    await unsub(originA, "a-one")
    sub(originA, "a-two")
    assert.equal((await originA.next()).t, "transcript")
    await unsub(originA, "a-two")
    sub(originA, "a-limited")
    assert.deepEqual(await originA.next(), {
      t: "resource-limited",
      resource: "transcript-read",
      scope: "origin",
      slug: "a-limited",
      retryAfterMs: 1_000,
    })
    assert.equal(h.appSocket.registry.hasSubscribers("a-limited"), false)
    assert.equal(reads, 2)

    // A's rejected request consumed no global token, so another trusted loopback origin gets its fair read.
    sub(originB, "b-one")
    assert.equal((await originB.next()).t, "transcript")
    await unsub(originB, "b-one")
    sub(originB, "b-global")
    assert.deepEqual(await originB.next(), {
      t: "resource-limited",
      resource: "transcript-read",
      scope: "global",
      slug: "b-global",
      retryAfterMs: 1_000,
    })
    assert.equal(reads, 3)

    at = 1_001
    sub(originA, "a-limited")
    const recovered = await originA.next()
    assert.equal(recovered.t, "transcript")
    if (recovered.t === "transcript") assert.deepEqual(recovered.messages, [msg("a-limited")])
    assert.equal(reads, 4)
    originA.ws.close()
    originB.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: a sliding window does not amplify bursts across a fixed-window boundary", async () => {
  let at = 999
  let reads = 0
  const h = await startHarness({
    now: () => at,
    maxTranscriptReadsPerOrigin: 2,
    maxTranscriptReadsOverall: 2,
    transcriptReadWindowMs: 1_000,
    readTranscript: (slug) => {
      reads++
      return [msg(slug)]
    },
  })
  try {
    const c = await connectClient(h.port)
    await c.next()
    const readThenUnsub = async (slug: string) => {
      c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug }))
      assert.equal((await c.next()).t, "transcript")
      c.ws.send(JSON.stringify({ t: "unsub", topic: "transcript", slug }))
      await delay(10)
    }
    await readThenUnsub("edge-one")
    await readThenUnsub("edge-two")

    at = 1_001 // only 2ms later, despite crossing a conventional 1s bucket boundary
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "edge-denied" }))
    const denied = await c.next()
    assert.equal(denied.t, "resource-limited")
    if (denied.t === "resource-limited") assert.equal(denied.retryAfterMs, 998)
    assert.equal(reads, 2)

    at = 1_999
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "edge-recovered" }))
    assert.equal((await c.next()).t, "transcript")
    assert.equal(reads, 3)
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: a transcript frame exactly at the logical byte limit is delivered", async () => {
  const messages = [msg("x".repeat(2_048))]
  const frame: SocketServerMsg = { t: "transcript", slug: "boundary", messages }
  const exactBytes = Buffer.byteLength(JSON.stringify(frame), "utf8")
  const h = await startHarness({
    maxLogicalFrameBytes: exactBytes,
    readTranscript: () => messages,
  })
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe is much smaller than the transcript boundary fixture
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "boundary" }))
    assert.deepEqual(await c.next(), frame)
    assert.equal(c.ws.readyState, WebSocket.OPEN)
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: a one-byte-over Unicode transcript pauses only that slug and an explicit retry recovers after shrink", async () => {
  let current = [msg("🟣".repeat(1_024))]
  const oversizedFrame: SocketServerMsg = { t: "transcript", slug: "unicode", messages: current }
  const encoded = JSON.stringify(oversizedFrame)
  const actualBytes = Buffer.byteLength(encoded, "utf8")
  assert.ok(actualBytes > encoded.length, "fixture must distinguish UTF-8 bytes from JS code units")

  let reads = 0
  let transcriptSerializations = 0
  const h = await startHarness({
    maxLogicalFrameBytes: actualBytes - 1,
    readTranscript: () => {
      reads++
      return current
    },
    serializeMessage: (serverMsg) => {
      if (serverMsg.t === "transcript") transcriptSerializations++
      return JSON.stringify(serverMsg)
    },
  })
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "unicode" }))
    assert.deepEqual(await c.next(), {
      t: "payload-too-large",
      channel: "transcript",
      slug: "unicode",
      actualBytes,
      maxBytes: actualBytes - 1,
    })
    assert.equal(c.ws.readyState, WebSocket.OPEN, "the board socket remains healthy")
    assert.equal(h.appSocket.registry.hasSubscribers("unicode"), false)
    assert.equal(reads, 1)
    assert.equal(transcriptSerializations, 1, "the failed frame is serialized exactly once")

    h.transcriptChange.emit(["unicode"])
    await c.expectNone(50)
    assert.equal(reads, 1, "a paused slug cannot create a read/serialize retry loop")
    assert.equal(transcriptSerializations, 1)

    current = [msg("small again")]
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "unicode" }))
    const recovered = await c.next()
    assert.equal(recovered.t, "transcript")
    if (recovered.t === "transcript") assert.deepEqual(recovered.messages, current)
    assert.equal(reads, 2, "an explicit retry performs exactly one fresh read")
    assert.equal(transcriptSerializations, 2)
    assert.equal(h.appSocket.registry.hasSubscribers("unicode"), true)
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: transcriptChange pushes to subscribers, dedups unchanged, respects unsub", async () => {
  const h = await startHarness()
  h.transcripts.set("foo", [msg("v1")])
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    await c.next() // immediate v1 push (also seeds the dedup signature)

    // Unchanged content → deduped, no push.
    h.transcriptChange.emit(["foo"])
    await c.expectNone()

    // Changed content → push v2.
    h.transcripts.set("foo", [msg("v1"), msg("v2")])
    h.transcriptChange.emit(["foo"])
    const push = await c.next()
    assert.equal(push.t, "transcript")
    if (push.t === "transcript") assert.deepEqual(push.messages, [msg("v1"), msg("v2")])

    // Re-emit same content → deduped.
    h.transcriptChange.emit(["foo"])
    await c.expectNone()

    // Unsub → no more pushes even on change.
    c.ws.send(JSON.stringify({ t: "unsub", topic: "transcript", slug: "foo" }))
    await delay(50) // let the unsub land server-side
    h.transcripts.set("foo", [msg("v3")])
    h.transcriptChange.emit(["foo"])
    await c.expectNone()

    c.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: duplicate invalidations coalesce and a budget-delayed refresh recovers once", async () => {
  let reads = 0
  let current = [msg("v1")]
  const h = await startHarness({
    maxTranscriptReadsPerOrigin: 8,
    maxTranscriptReadsOverall: 1,
    transcriptReadWindowMs: 25,
    readTranscript: () => {
      reads++
      return current
    },
  })
  try {
    const c = await connectClient(h.port)
    await c.next()
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "coalesced" }))
    assert.equal((await c.next()).t, "transcript")
    assert.equal(reads, 1)

    current = [msg("v2")]
    h.transcriptChange.emit(["coalesced"])
    h.transcriptChange.emit(["coalesced", "coalesced"])
    const refreshed = await c.next(500)
    assert.equal(refreshed.t, "transcript")
    if (refreshed.t === "transcript") assert.deepEqual(refreshed.messages, current)
    assert.equal(reads, 2, "three same-turn invalidations become one eventual full read")
    assert.equal(h.appSocket.pendingTranscriptRefreshes, 0)
    assert.equal(h.appSocket.transcriptCacheEntries, 1)
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: snapshot cache is entry/byte bounded and last-unsubscribe cannot leak forgotten content", async () => {
  const snapshots = new Map<string, TranscriptMessage[]>([
    ["cache-a", [msg("a")]],
    ["cache-b", [msg("b")]],
    ["cache-c", [msg("c")]],
    ["forgotten", [msg("must disappear")]],
  ])
  const sampleText = JSON.stringify({ t: "transcript", slug: "cache-a", messages: snapshots.get("cache-a") })
  const oneEntryWeight = Math.max(Buffer.byteLength(sampleText, "utf8"), sampleText.length * 2)
  let reads = 0
  const h = await startHarness({
    maxConnections: 8,
    maxTranscriptCacheEntries: 2,
    maxTranscriptCacheBytes: oneEntryWeight * 2,
    readTranscript: (slug) => {
      reads++
      return snapshots.get(slug) ?? []
    },
  })
  try {
    const clients = await Promise.all(Array.from({ length: 4 }, () => connectClient(h.port)))
    await Promise.all(clients.map((client) => client.next()))
    for (let i = 0; i < 3; i++) {
      const slug = `cache-${String.fromCharCode(97 + i)}`
      clients[i].ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug }))
      assert.equal((await clients[i].next()).t, "transcript")
    }
    assert.equal(reads, 3)
    assert.equal(h.appSocket.transcriptCacheEntries, 2)
    assert.ok(h.appSocket.transcriptCacheBytes <= oneEntryWeight * 2)

    const forgotten = clients[3]
    forgotten.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "forgotten" }))
    assert.equal((await forgotten.next()).t, "transcript")
    assert.equal(reads, 4)
    forgotten.ws.send(JSON.stringify({ t: "unsub", topic: "transcript", slug: "forgotten" }))
    await delay(20)
    assert.equal(h.appSocket.registry.hasSubscribers("forgotten"), false)
    snapshots.set("forgotten", []) // registry/thread deletion can happen without a transcript tail edge

    forgotten.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "forgotten" }))
    const afterDelete = await forgotten.next()
    assert.equal(afterDelete.t, "transcript")
    if (afterDelete.t === "transcript") assert.deepEqual(afterDelete.messages, [])
    assert.equal(reads, 5, "last-unsubscribe evicts, so a forgotten transcript is read as empty")
    for (const client of clients) client.ws.close()
  } finally {
    await h.close()
  }
})

test("resource control: shutdown cancels a budget retry and drains cache/pending work without another read", async () => {
  let reads = 0
  let current = [msg("v1")]
  const h = await startHarness({
    maxTranscriptReadsPerOrigin: 1,
    maxTranscriptReadsOverall: 1,
    transcriptReadWindowMs: 1_000,
    readTranscript: () => {
      reads++
      return current
    },
  })
  try {
    const c = await connectClient(h.port)
    await c.next()
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "shutdown" }))
    await c.next()
    assert.equal(reads, 1)

    current = [msg("v2")]
    h.transcriptChange.emit(["shutdown"])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(h.appSocket.pendingTranscriptRefreshes, 1)
    const closing = h.appSocket.close()
    await closing
    await delay(30)
    assert.equal(reads, 1)
    assert.equal(h.appSocket.pendingTranscriptRefreshes, 0)
    assert.equal(h.appSocket.transcriptCacheEntries, 0)
    assert.equal(h.appSocket.transcriptCacheBytes, 0)
    assert.equal(h.appSocket.connectionCount, 0)
  } finally {
    await h.close()
  }
})

test("protocol: a late second subscriber does NOT starve the first of a pending change (M1)", async () => {
  // Regression for the shared-lastSig seeding bug: two clients on one slug; content changes AFTER A
  // subscribed but BEFORE the tailer tick; B subscribes in that gap. B's immediate push must not seed the
  // shared dedup signature such that the subsequent broadcast is suppressed for A.
  const h = await startHarness()
  h.transcripts.set("foo", [msg("v1")])
  try {
    const a = await connectClient(h.port)
    await a.next() // keyframe
    a.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    const aFirst = await a.next()
    assert.equal(aFirst.t, "transcript")
    if (aFirst.t === "transcript") assert.deepEqual(aFirst.messages, [msg("v1")])

    // Content advances on disk (agent wrote a turn) before the tailer ticks.
    h.transcripts.set("foo", [msg("v1"), msg("v2")])

    // B subscribes in the gap → gets v2 immediately, but must NOT seed lastSig away from A's v1.
    const b = await connectClient(h.port)
    await b.next() // keyframe
    b.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    const bFirst = await b.next()
    assert.equal(bFirst.t, "transcript")
    if (bFirst.t === "transcript") assert.deepEqual(bFirst.messages, [msg("v1"), msg("v2")])

    // Tailer tick → the change must broadcast to A (who is still on v1).
    h.transcriptChange.emit(["foo"])
    const aSecond = await a.next()
    assert.equal(aSecond.t, "transcript")
    if (aSecond.t === "transcript") assert.deepEqual(aSecond.messages, [msg("v1"), msg("v2")])

    a.ws.close()
    b.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: lastSig is reclaimed on last-unsub and on close (no leak)", async () => {
  const h = await startHarness()
  h.transcripts.set("foo", [msg("v1")])
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    await c.next() // push seeds lastSig[foo] (sole subscriber)
    assert.equal(h.appSocket.lastSigSize, 1)

    c.ws.send(JSON.stringify({ t: "unsub", topic: "transcript", slug: "foo" }))
    await delay(50)
    assert.equal(h.appSocket.lastSigSize, 0) // reclaimed on last-unsub

    // Re-sub then close without unsub → close reclaims it.
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    await c.next()
    assert.equal(h.appSocket.lastSigSize, 1)
    c.ws.close()
    await once(c.ws, "close")
    await delay(50)
    assert.equal(h.appSocket.lastSigSize, 0)
  } finally {
    await h.close()
  }
})

test("protocol: a change for a slug nobody subscribes is ignored", async () => {
  const h = await startHarness()
  h.transcripts.set("bar", [msg("x")])
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe
    h.transcriptChange.emit(["bar"]) // no subscribers
    await c.expectNone()
    c.ws.close()
  } finally {
    await h.close()
  }
})

test("protocol: closing the socket removes it from the registry (leak-guard)", async () => {
  const h = await startHarness()
  h.transcripts.set("foo", [msg("v1")])
  try {
    const c = await connectClient(h.port)
    await c.next() // keyframe
    c.ws.send(JSON.stringify({ t: "sub", topic: "transcript", slug: "foo" }))
    await c.next() // push
    assert.equal(h.appSocket.registry.hasSubscribers("foo"), true)

    c.ws.close()
    await once(c.ws, "close")
    await delay(50) // let the server-side close handler run
    assert.equal(h.appSocket.registry.connCount, 0)
    assert.equal(h.appSocket.registry.slugCount, 0)
    assert.equal(h.appSocket.registry.hasSubscribers("foo"), false)
  } finally {
    await h.close()
  }
})

test("protocol: a non-/ws upgrade is rejected (no keyframe)", async () => {
  const h = await startHarness()
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/nope`)
    const [err] = (await Promise.race([
      once(ws, "error"),
      once(ws, "open").then(() => [null]),
    ])) as [Error | null]
    assert.ok(err, "expected the /nope upgrade to be rejected")
    try {
      ws.close()
    } catch {
      // already closed
    }
  } finally {
    await h.close()
  }
})

test("protocol: close rejects new upgrades and drains an in-flight board keyframe", async () => {
  let markSnapshotStarted!: () => void
  const snapshotStarted = new Promise<void>((resolve) => { markSnapshotStarted = resolve })
  let releaseSnapshot!: () => void
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })
  let currentSeqReads = 0
  const h = await startHarness({
    boardSnapshot: async () => {
      markSnapshotStarted()
      await snapshotGate
      return board
    },
    currentSeq: () => {
      currentSeqReads++
      return 7
    },
  })
  const client = await connectClient(h.port)
  const clientClosed = once(client.ws, "close")
  await snapshotStarted

  try {
    let closeSettled = false
    const firstClose = h.appSocket.close()
    assert.equal(h.appSocket.close(), firstClose, "close is one idempotent drain promise")
    const closing = firstClose.then(() => { closeSettled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closeSettled, false, "the socket cannot outlive its in-flight board dependency")
    assert.equal(await rejectedClient(h.port), 503, "new upgrades are rejected as soon as close begins")

    releaseSnapshot()
    await closing
    await clientClosed
    assert.equal(currentSeqReads, 0, "a snapshot settling after close cannot read the board sequence")
    assert.equal(h.appSocket.registry.connCount, 0)
  } finally {
    releaseSnapshot()
    await h.close()
  }
})
