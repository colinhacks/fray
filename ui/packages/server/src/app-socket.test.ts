import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { WebSocket } from "ws"
import type { BoardSnapshot, SocketServerMsg, TranscriptMessage } from "@fray-ui/shared"
import { Bus, Emitter } from "./bus.ts"
import { createAppSocketServer, SubscriptionRegistry, type AppSocketDeps } from "./app-socket.ts"

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
        appSocket.close()
        server.close(() => r())
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

async function connectClient(port: number, path = "/ws") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const c = collect(ws)
  await once(ws, "open")
  return { ws, ...c }
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
