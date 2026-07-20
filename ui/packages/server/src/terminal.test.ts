import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { WebSocket, type ClientOptions } from "ws"
import {
  createTerminalServer,
  parseTermClientMsg,
  parseTermSlug,
  resolveThreadAttach,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_INPUT_BYTES_PER_WINDOW,
  TERMINAL_MAX_INPUT_FRAMES_PER_WINDOW,
  TERMINAL_MAX_MESSAGE_BYTES,
  TERMINAL_MAX_OUTPUT_BUFFER_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MAX_VIEWERS,
  TERMINAL_MAX_VIEWERS_PER_SLUG,
  type TerminalServerDeps,
} from "./terminal.ts"
import { createStorage, type SessionRow } from "./storage.ts"

function terminalRow(slug: string, sessionId: string): SessionRow {
  return {
    slug, session_id: sessionId, tmux_name: `fray-${slug}`, spawned_at: "2026-07-13T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, transcript_id: null, state: "open", meta: null, seen_at: null, plan_path: null,
    runtime_generation: 0,
  }
}

test("parseTermSlug uses the same bounded canonical identity as RPC and tmux", () => {
  assert.equal(parseTermSlug("/term/valid-thread"), "valid-thread")
  for (const url of [
    "/term/../escape",
    "/term/-option",
    "/term/Upper",
    "/term/control%0a",
    "/term/control\nslug",
    `/term/${"a".repeat(201)}`,
  ]) {
    assert.equal(parseTermSlug(url), null, url)
  }
})

test("terminal attach resolver rejects a stale replaced row instead of name-attaching its successor", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-terminal-aba-")), "ui.db"))
  const stale = terminalRow("terminal-aba", "owner-a")
  storage.upsertSession(stale)
  assert.deepEqual(resolveThreadAttach(storage, stale), ["attach-session", "-t", "fray-terminal-aba"])
  storage.upsertSession(terminalRow(stale.slug, "owner-b"))
  assert.equal(resolveThreadAttach(storage, stale), null)
})

const invalidMessages = [
  "",
  "{",
  "null",
  "[]",
  "1",
  "true",
  JSON.stringify({}),
  JSON.stringify({ t: "wat" }),
  JSON.stringify({ t: "input" }),
  JSON.stringify({ t: "input", d: null }),
  JSON.stringify({ t: "input", d: 42 }),
  JSON.stringify({ t: "input", d: "x", extra: true }),
  JSON.stringify({ t: "input", d: "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1) }),
  JSON.stringify({ t: "resize" }),
  JSON.stringify({ t: "resize", cols: 0, rows: 24 }),
  JSON.stringify({ t: "resize", cols: -1, rows: 24 }),
  JSON.stringify({ t: "resize", cols: 80, rows: 0 }),
  JSON.stringify({ t: "resize", cols: 80, rows: -1 }),
  JSON.stringify({ t: "resize", cols: 1.5, rows: 24 }),
  JSON.stringify({ t: "resize", cols: 80, rows: 2.5 }),
  JSON.stringify({ t: "resize", cols: "NaN", rows: 24 }),
  JSON.stringify({ t: "resize", cols: 80, rows: "Infinity" }),
  JSON.stringify({ t: "resize", cols: 80, rows: 24, extra: true }),
  JSON.stringify({ t: "resize", cols: TERMINAL_MAX_COLS + 1, rows: 24 }),
  JSON.stringify({ t: "resize", cols: 80, rows: TERMINAL_MAX_ROWS + 1 }),
]

test("parseTermClientMsg: rejects malformed, unknown, oversized, and unsafe terminal messages", () => {
  for (const raw of invalidMessages) assert.equal(parseTermClientMsg(raw), null, raw.slice(0, 120))

  assert.deepEqual(parseTermClientMsg(JSON.stringify({ t: "input", d: "hello\n" })), { t: "input", d: "hello\n" })
  const exactMultibyteInput = "é".repeat(TERMINAL_MAX_INPUT_BYTES / 2)
  const parsedMultibyte = parseTermClientMsg(JSON.stringify({ t: "input", d: exactMultibyteInput }))
  assert.equal(parsedMultibyte?.t, "input")
  assert.equal(parsedMultibyte?.t === "input" ? parsedMultibyte.d.length : 0, exactMultibyteInput.length)
  assert.equal(parseTermClientMsg(JSON.stringify({ t: "input", d: `${exactMultibyteInput}é` })), null)
  assert.deepEqual(parseTermClientMsg(JSON.stringify({ t: "resize", cols: 80, rows: 24 })), { t: "resize", cols: 80, rows: 24 })
  assert.deepEqual(parseTermClientMsg(JSON.stringify({ t: "resize", cols: TERMINAL_MAX_COLS, rows: TERMINAL_MAX_ROWS })), {
    t: "resize",
    cols: TERMINAL_MAX_COLS,
    rows: TERMINAL_MAX_ROWS,
  })
})

class FakePty {
  writes: string[] = []
  resizes: [number, number][] = []
  kills = 0
  throwOnWrite = false
  throwOnResize = false
  #data = new Set<(data: string) => void>()
  #exit = new Set<(event: { exitCode: number; signal?: number }) => void>()

  onData(listener: (data: string) => void) {
    this.#data.add(listener)
    return { dispose: () => this.#data.delete(listener) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.#exit.add(listener)
    return { dispose: () => this.#exit.delete(listener) }
  }

  write(data: string) {
    if (this.throwOnWrite) throw new Error("dead pty")
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    if (this.throwOnResize) throw new Error("dead pty")
    this.resizes.push([cols, rows])
  }

  kill() {
    this.kills++
  }

  emitData(data: string) {
    for (const listener of this.#data) listener(data)
  }

  emitExit(exitCode = 0) {
    for (const listener of this.#exit) listener({ exitCode })
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return address.port
}

async function openSocket(port: number, options: ClientOptions = {}, slug = "safe-test"): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${slug}`, {
    origin: `http://127.0.0.1:${port}`,
    ...options,
  })
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  return ws
}

async function rejectedSocket(
  port: number,
  options: ClientOptions = {},
  slug = "safe-test",
): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${slug}`, options)
  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for terminal rejection")), 1_000)
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout)
      const status = response.statusCode ?? 0
      response.resume()
      resolve(status)
    })
    ws.once("open", () => {
      clearTimeout(timeout)
      ws.close()
      reject(new Error("hostile terminal websocket unexpectedly opened"))
    })
    ws.once("error", () => {})
  })
}

async function connectOutcome(port: number, slug: string): Promise<WebSocket | number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${slug}`, {
    origin: `http://127.0.0.1:${port}`,
  })
  return await new Promise<WebSocket | number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for terminal outcome")), 1_000)
    ws.once("open", () => {
      clearTimeout(timeout)
      resolve(ws)
    })
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout)
      const status = response.statusCode ?? 0
      response.resume()
      resolve(status)
    })
    ws.once("error", () => {})
  })
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => ws.once("close", resolve))
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= until) throw new Error("condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function closeHttp(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test("terminal websocket: only an exact same-origin loopback browser can create a PTY", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  const validOrigin = `http://127.0.0.1:${port}`

  try {
    assert.equal(await rejectedSocket(port), 403, "a non-browser client must opt into the browser origin contract")
    for (const origin of [
      "http://evil.example",
      `http://localhost.evil.example:${port}`,
      `http://127.0.0.1.evil.example:${port}`,
      `http://127.0.0.1:${port + 1}`,
      `http://localhost:${port}`,
      "null",
    ]) {
      assert.equal(await rejectedSocket(port, { origin }), 403, origin)
    }
    assert.equal(await rejectedSocket(port, {
      origin: validOrigin,
      headers: { "x-forwarded-host": `127.0.0.1:${port}` },
    }), 403, "forwarded authority is never trusted")
    assert.equal(await rejectedSocket(port, {
      origin: validOrigin,
      headers: { host: `localhost.evil.example:${port}` },
    }), 403, "Host cannot be replaced by an attacker-controlled DNS name")
    assert.equal(ptys.length, 0, "rejected handshakes never create a terminal process")

    const valid = await openSocket(port)
    valid.send(JSON.stringify({ t: "input", d: "same-origin-input" }))
    await waitFor(() => ptys[0]?.writes[0] === "same-origin-input")
    valid.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: malformed and extra-key messages close only their viewer; recovery stays healthy", async () => {
  const ptys: FakePty[] = []
  const spawnPty = (() => {
    const fake = new FakePty()
    ptys.push(fake)
    return fake
  }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>
  const terminal = createTerminalServer({ spawnPty, socketName: () => "test-socket" })
  const http = createServer((_req, res) => res.end("healthy"))
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)

  try {
    for (const raw of ["{", JSON.stringify({ t: "input", d: "must-not-run", extra: true })]) {
      const attacked = await openSocket(port)
      const index = ptys.length - 1
      const closed = closeCode(attacked)
      attacked.send(raw)
      assert.equal(await closed, 1008)
      assert.deepEqual(ptys[index]?.writes, [])
      assert.equal(ptys[index]?.kills, 1)
    }

    const valid = await openSocket(port)
    valid.send(JSON.stringify({ t: "resize", cols: 91, rows: 33 }))
    valid.send(JSON.stringify({ t: "input", d: "valid-after-attacks" }))
    await waitFor(() => ptys[2]?.writes.length === 1 && ptys[2]?.resizes.length === 1)
    assert.deepEqual(ptys[2].resizes, [[91, 33]])
    assert.deepEqual(ptys[2].writes, ["valid-after-attacks"])
    assert.equal(valid.readyState, WebSocket.OPEN)
    valid.close()
    await waitFor(() => ptys[2].kills === 1)

    // A raw oversized frame is contained by ws maxPayload and closes only this viewer.
    const oversized = await openSocket(port)
    const closed = closeCode(oversized)
    oversized.send("x".repeat(TERMINAL_MAX_MESSAGE_BYTES + 1))
    assert.equal(await closed, 1009)
    await waitFor(() => ptys[3].kills === 1)

    // The same HTTP/WS server remains usable after the attack.
    const recovery = await openSocket(port)
    recovery.send(JSON.stringify({ t: "resize", cols: 80, rows: 24 }))
    recovery.send(JSON.stringify({ t: "input", d: "still-healthy" }))
    await waitFor(() => ptys[4]?.writes[0] === "still-healthy")
    assert.deepEqual(ptys[4].resizes, [[80, 24]])
    recovery.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: non-canonical 201-character and encoded-control slugs never create a PTY", async () => {
  let spawns = 0
  const terminal = createTerminalServer({
    spawnPty: (() => {
      spawns++
      return new FakePty()
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    }
  })
  const port = await listen(http)
  const options = { origin: `http://127.0.0.1:${port}` }
  try {
    assert.equal(await rejectedSocket(port, options, "a".repeat(201)), 404)
    assert.equal(await rejectedSocket(port, options, "control%0a"), 404)
    assert.equal(spawns, 0)
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: binary JSON is rejected before PTY input and a text reconnect works", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const binary = await openSocket(port)
    const binaryClosed = closeCode(binary)
    binary.send(Buffer.from(JSON.stringify({ t: "input", d: "binary-must-not-run" })))
    assert.equal(await binaryClosed, 1003)
    assert.deepEqual(ptys[0]?.writes, [])
    assert.equal(ptys[0]?.kills, 1)

    const recovery = await openSocket(port)
    recovery.send(JSON.stringify({ t: "input", d: "text-recovery" }))
    await waitFor(() => ptys[1]?.writes[0] === "text-recovery")
    recovery.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: fragmented text is aggregated once and aggregate maxPayload closes with 1009", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    maxInputFramesPerWindow: 1,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const fragmented = await openSocket(port)
    const message = JSON.stringify({ t: "input", d: "one-aggregate" })
    fragmented.send(message.slice(0, 8), { fin: false })
    fragmented.send(message.slice(8), { fin: true })
    await waitFor(() => ptys[0]?.writes[0] === "one-aggregate")
    assert.equal(fragmented.readyState, WebSocket.OPEN, "fragments count as one complete input message")
    const rateClosed = closeCode(fragmented)
    fragmented.send(JSON.stringify({ t: "input", d: "second-message" }))
    assert.equal(await rateClosed, 1013)
    assert.deepEqual(ptys[0]?.writes, ["one-aggregate"])

    const oversized = await openSocket(port)
    const oversizedClosed = closeCode(oversized)
    const firstSize = Math.floor(TERMINAL_MAX_MESSAGE_BYTES / 2)
    oversized.send("x".repeat(firstSize), { fin: false })
    oversized.send("x".repeat(TERMINAL_MAX_MESSAGE_BYTES + 1 - firstSize), { fin: true })
    assert.equal(await oversizedClosed, 1009)
    assert.deepEqual(ptys[1]?.writes, [])
    assert.equal(ptys[1]?.kills, 1)
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: concurrent upgrades obey per-slug and global caps with immediate fair recovery", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    maxViewers: 3,
    maxViewersPerSlug: 2,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  const opened: WebSocket[] = []
  try {
    const alphaRace = await Promise.all(
      Array.from({ length: 12 }, () => connectOutcome(port, "alpha-thread")),
    )
    const alpha = alphaRace.filter((outcome): outcome is WebSocket => outcome instanceof WebSocket)
    const alphaRejected = alphaRace.filter((outcome): outcome is number => typeof outcome === "number")
    opened.push(...alpha)
    assert.equal(alpha.length, 2)
    assert.deepEqual(alphaRejected, Array(10).fill(429))
    assert.equal(ptys.length, 2, "only reserved concurrent upgrades may spawn")

    const betaOne = await connectOutcome(port, "beta-thread")
    assert.ok(betaOne instanceof WebSocket)
    opened.push(betaOne)
    assert.equal(await connectOutcome(port, "beta-thread"), 429, "the global cap is shared across slugs")
    assert.equal(ptys.length, 3)

    const alphaClosed = closeCode(alpha[0]!)
    alpha[0]!.close()
    await alphaClosed
    await waitFor(() => ptys[0]?.kills === 1)
    const betaTwo = await connectOutcome(port, "beta-thread")
    assert.ok(betaTwo instanceof WebSocket)
    opened.push(betaTwo)
    assert.equal(await connectOutcome(port, "alpha-thread"), 429, "recovery still respects the global cap")

    const betaClosed = closeCode(betaOne)
    betaOne.close()
    await betaClosed
    const alphaReplacement = await connectOutcome(port, "alpha-thread")
    assert.ok(alphaReplacement instanceof WebSocket)
    opened.push(alphaReplacement)
    assert.equal(ptys.length, 5)
    assert.equal(TERMINAL_MAX_VIEWERS, 32)
    assert.equal(TERMINAL_MAX_VIEWERS_PER_SLUG, 8)
  } finally {
    await terminal.close()
    for (const ws of opened) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
    }
    assert.equal(ptys.length, 5)
    assert.ok(ptys.every((fake) => fake.kills === 1), "each spawned attach is reclaimed exactly once")
    await closeHttp(http)
  }
})

test("terminal websocket: sliding frame and byte limits are inclusive at their exact boundaries", async () => {
  const ptys: FakePty[] = []
  let clock = 0
  const sample = JSON.stringify({ t: "input", d: "x" })
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    now: () => clock,
    inputRateWindowMs: 1_000,
    maxInputFramesPerWindow: 2,
    maxInputBytesPerWindow: Buffer.byteLength(sample) * 2,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const belowBoundary = await openSocket(port)
    belowBoundary.send(sample)
    belowBoundary.send(sample)
    await waitFor(() => ptys[0]?.writes.length === 2)
    clock = 999
    const belowClosed = closeCode(belowBoundary)
    belowBoundary.send(sample)
    assert.equal(await belowClosed, 1013)
    assert.equal(ptys[0]?.writes.length, 2, "rate rejection happens before PTY input")

    clock = 0
    const exactBoundary = await openSocket(port)
    exactBoundary.send(sample)
    exactBoundary.send(sample)
    await waitFor(() => ptys[1]?.writes.length === 2)
    clock = 1_000
    exactBoundary.send(sample)
    exactBoundary.send(sample)
    await waitFor(() => ptys[1]?.writes.length === 4)
    const exactClosed = closeCode(exactBoundary)
    exactBoundary.send(sample)
    assert.equal(await exactClosed, 1013)
    assert.equal(ptys[1]?.writes.length, 4)
    assert.equal(TERMINAL_MAX_INPUT_FRAMES_PER_WINDOW, 120)
    assert.equal(TERMINAL_MAX_INPUT_BYTES_PER_WINDOW, 2 * TERMINAL_MAX_MESSAGE_BYTES)
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: an exact 1 MiB paste is accepted once and a same-window flood is rejected before write", async () => {
  const ptys: FakePty[] = []
  const oneMiB = "z".repeat(TERMINAL_MAX_INPUT_BYTES)
  const payload = JSON.stringify({ t: "input", d: oneMiB })
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    now: () => 0,
    maxInputFramesPerWindow: 10,
    maxInputBytesPerWindow: Buffer.byteLength(payload),
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const flooded = await openSocket(port)
    flooded.send(payload)
    await waitFor(() => ptys[0]?.writes.length === 1, 3_000)
    assert.equal(ptys[0]?.writes[0]?.length, TERMINAL_MAX_INPUT_BYTES)
    const floodClosed = closeCode(flooded)
    flooded.send(JSON.stringify({ t: "input", d: "must-not-follow-flood" }))
    assert.equal(await floodClosed, 1013)
    assert.equal(ptys[0]?.writes.length, 1)

    const recovery = await openSocket(port)
    recovery.send(JSON.stringify({ t: "input", d: "new-window-via-reconnect" }))
    await waitFor(() => ptys[1]?.writes[0] === "new-window-via-reconnect")
    recovery.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: an exact-runtime ownership veto closes before any tmux attach", async () => {
  let spawns = 0
  const terminal = createTerminalServer({
    canAttach: () => false,
    spawnPty: (() => {
      spawns++
      return new FakePty()
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const ws = await openSocket(port)
    const code = await new Promise<number>((resolve) => ws.once("close", resolve))
    assert.equal(code, 1008)
    assert.equal(spawns, 0)
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: exact attach authorization and pane attach share one tmux command", async () => {
  const exactArgs = [
    "if-shell", "-t", "%77", "-F", "#{exact-owner}",
    "attach-session -t %77",
    "",
  ]
  const launches: { file: string; args: string[] }[] = []
  const terminal = createTerminalServer({
    socketName: () => "exact-test-socket",
    resolveAttach: () => exactArgs,
    spawnPty: ((file: string, args: string[]) => {
      launches.push({ file, args })
      return new FakePty()
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const ws = await openSocket(port)
    await waitFor(() => launches.length === 1)
    assert.deepEqual(launches, [{ file: "tmux", args: ["-L", "exact-test-socket", ...exactArgs] }])
    assert.equal(launches[0].args.includes("fray-thread"), false, "there is no later reusable-name attach")
    ws.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: a dead PTY exception closes only its viewer and a new attach still works", async () => {
  const ptys: FakePty[] = []
  const spawnPty = (() => {
    const fake = new FakePty()
    if (ptys.length === 0) fake.throwOnResize = true
    ptys.push(fake)
    return fake
  }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>
  const terminal = createTerminalServer({ spawnPty })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)

  try {
    const doomed = await openSocket(port)
    const closed = new Promise<number>((resolve) => doomed.once("close", resolve))
    doomed.send(JSON.stringify({ t: "resize", cols: 80, rows: 24 }))
    assert.equal(await closed, 1011)
    await waitFor(() => ptys[0].kills === 1)

    const healthy = await openSocket(port)
    healthy.send(JSON.stringify({ t: "input", d: "next-viewer" }))
    await waitFor(() => ptys[1]?.writes[0] === "next-viewer")
    assert.equal(healthy.readyState, WebSocket.OPEN)
    healthy.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: resize schedules an authoritative tmux client refresh", async () => {
  const fake = new FakePty()
  const refreshed: Array<{ socket: string; term: unknown }> = []
  const terminal = createTerminalServer({
    spawnPty: (() => fake) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    socketName: () => "resize-socket",
    refreshDelaysMs: [0],
    refreshClient: (socket, term) => refreshed.push({ socket, term }),
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({ t: "resize", cols: 41, rows: 49 }))
    await waitFor(() => refreshed.length === 1)
    assert.deepEqual(fake.resizes, [[41, 49]])
    assert.equal(refreshed[0]?.socket, "resize-socket")
    assert.equal(refreshed[0]?.term, fake)
    ws.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: a full-screen clear schedules one non-recursive authoritative refresh", async () => {
  const fake = new FakePty()
  let refreshes = 0
  const terminal = createTerminalServer({
    spawnPty: (() => fake) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    refreshAfterClearMs: 0,
    refreshClient: () => {
      refreshes++
      // A real tmux replay may contain its own erase-display. It must not arm another refresh.
      fake.emitData("\x1b[H\x1b[Jreplayed authoritative grid")
    },
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)

  try {
    const ws = await openSocket(port)
    fake.emitData("late clear \x1b[")
    fake.emitData("J with cursor-only diff")
    await waitFor(() => refreshes === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(refreshes, 1)
    assert.equal(ws.readyState, WebSocket.OPEN)
    ws.close()
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: a slow consumer releases its PTY and capacity before bounded forced close", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    maxOutputBufferBytes: 0,
    maxViewers: 1,
    maxViewersPerSlug: 1,
    closeGraceMs: 10,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)

  try {
    const slow = await openSocket(port)
    const closed = closeCode(slow)
    const slowTransport = (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket
    slowTransport.pause()
    ptys[0]?.emitData("x")
    await waitFor(() => ptys[0]?.kills === 1)

    // The close event is deliberately unable to arrive while the client transport is paused. The
    // released reservation must nevertheless permit a replacement before the force-close timer.
    const recovery = await openSocket(port)
    recovery.send(JSON.stringify({ t: "input", d: "healthy-after-overload" }))
    await waitFor(() => ptys[1]?.writes[0] === "healthy-after-overload")
    assert.equal(recovery.readyState, WebSocket.OPEN)
    assert.equal(TERMINAL_MAX_OUTPUT_BUFFER_BYTES, 4 * 1_024 * 1_024)
    recovery.close()
    slowTransport.resume()
    assert.equal(await closed, 1013)
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: abrupt socket close and repeated PTY exit callbacks reclaim each attach once", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    maxViewers: 1,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  try {
    const abrupt = await openSocket(port)
    ;(abrupt as unknown as { _socket: { destroy(error?: Error): void } })._socket.destroy(
      new Error("test transport failure"),
    )
    await waitFor(() => ptys[0]?.kills === 1)

    const exited = await openSocket(port)
    const exitedClosed = closeCode(exited)
    ptys[1]?.emitExit(7)
    ptys[1]?.emitExit(8)
    assert.equal(await exitedClosed, 1000)
    assert.equal(ptys[1]?.kills, 1)

    const recovery = await openSocket(port)
    recovery.send(JSON.stringify({ t: "input", d: "after-close-and-exit" }))
    await waitFor(() => ptys[2]?.writes[0] === "after-close-and-exit")
    recovery.close()
  } finally {
    await terminal.close()
    assert.ok(ptys.every((fake) => fake.kills === 1))
    await closeHttp(http)
  }
})

test("terminal websocket: shutdown is bounded when close never fires and races stay idempotent", async () => {
  const ptys: FakePty[] = []
  let terminateCalls = 0
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
    shutdownGraceMs: 20,
    terminateSocket: () => {
      terminateCalls++
      // Intentionally do not terminate: this models a transport whose close event never arrives.
    },
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  const ws = await openSocket(port)
  try {
    const startedAt = Date.now()
    const firstClose = terminal.close()
    assert.equal(terminal.close(), firstClose)
    ptys[0]?.emitData("late-output")
    ptys[0]?.emitExit(9)
    await firstClose
    assert.ok(Date.now() - startedAt < 250, "shutdown cannot wait indefinitely for a close event")
    assert.equal(terminateCalls, 1)
    assert.equal(ptys[0]?.kills, 1)
    assert.equal(
      await rejectedSocket(port, { origin: `http://127.0.0.1:${port}` }),
      503,
    )
    assert.equal(ptys.length, 1)
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
    await waitFor(() => ws.readyState === WebSocket.CLOSED)
    await terminal.close()
    assert.equal(ptys[0]?.kills, 1)
    await closeHttp(http)
  }
})

test("terminal websocket: close rejects new upgrades and drains every viewer PTY exactly once", async () => {
  const ptys: FakePty[] = []
  const terminal = createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      ptys.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!terminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  const ws = await openSocket(port)
  const clientClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()))

  try {
    const firstClose = terminal.close()
    assert.equal(terminal.close(), firstClose, "competing shutdown paths share one terminal drain")
    await firstClose
    await clientClosed
    assert.equal(ptys.length, 1)
    assert.equal(ptys[0]?.kills, 1, "the viewer attach is killed before terminal close settles")
    assert.equal(
      await rejectedSocket(port, { origin: `http://127.0.0.1:${port}` }),
      503,
      "terminal upgrades are gated immediately after close starts",
    )
    assert.equal(ptys.length, 1, "a post-close upgrade cannot create another PTY")
  } finally {
    await terminal.close()
    await closeHttp(http)
  }
})

test("terminal websocket: control-plane boot replacement reclaims the old attach and accepts a fresh tab", async () => {
  const firstBootPtys: FakePty[] = []
  const secondBootPtys: FakePty[] = []
  const makeTerminal = (owned: FakePty[]) => createTerminalServer({
    spawnPty: (() => {
      const fake = new FakePty()
      owned.push(fake)
      return fake
    }) as unknown as NonNullable<TerminalServerDeps["spawnPty"]>,
  })
  const firstBoot = makeTerminal(firstBootPtys)
  let activeTerminal = firstBoot
  const http = createServer()
  http.on("upgrade", (req, socket, head) => {
    if (!activeTerminal.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(http)
  let secondBoot: ReturnType<typeof createTerminalServer> | undefined
  try {
    const oldTab = await openSocket(port)
    oldTab.send(JSON.stringify({ t: "input", d: "before-replacement" }))
    await waitFor(() => firstBootPtys[0]?.writes[0] === "before-replacement")
    const oldTabClosed = closeCode(oldTab)
    await firstBoot.close()
    await oldTabClosed
    assert.equal(firstBootPtys[0]?.kills, 1)

    secondBoot = makeTerminal(secondBootPtys)
    activeTerminal = secondBoot
    const freshTab = await openSocket(port)
    freshTab.send(JSON.stringify({ t: "resize", cols: 101, rows: 37 }))
    freshTab.send(JSON.stringify({ t: "input", d: "after-replacement" }))
    await waitFor(() => secondBootPtys[0]?.writes[0] === "after-replacement")
    assert.deepEqual(secondBootPtys[0]?.resizes, [[101, 37]])
    freshTab.close()
  } finally {
    await firstBoot.close()
    await secondBoot?.close()
    assert.equal(firstBootPtys[0]?.kills, 1)
    assert.equal(secondBootPtys[0]?.kills, 1)
    await closeHttp(http)
  }
})
