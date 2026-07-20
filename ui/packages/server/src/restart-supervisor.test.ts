import assert from "node:assert/strict"
import { createServer, request, type RequestListener } from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import {
  RestartSupervisorProxy,
  SUPERVISOR_RESTART_PATH,
  SUPERVISOR_UPDATE_RESTART_PATH,
  SUPERVISOR_STATUS_PATH,
  type RestartResult,
} from "./restart-supervisor.ts"

async function listen(handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    server,
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, "close")
    },
  }
}

async function get(port: number, path: string, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { origin: `http://127.0.0.1:${port}` },
    }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once("error", reject)
    req.end()
  })
}

async function child(label: string) {
  return listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`${label}:${req.url}`)
  })
}

test("public restart supervisor preserves routes, does not restart initial/subresource requests, and recovers a dead child", async () => {
  let current = await child("one")
  let restarts = 0
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async (): Promise<RestartResult> => {
      restarts++
      await current.close().catch(() => undefined)
      current = await child(`generation-${restarts + 1}`)
      return { state: "ready" }
    },
  })
  try {
    await proxy.listen()
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "one:/thread/demo?tab=terminal")
    assert.equal((await get(port, "/assets/app.css")).body, "one:/assets/app.css")
    assert.equal(restarts, 0, "ordinary initial and subresource requests never restart Fray")

    assert.equal((await get(port, SUPERVISOR_RESTART_PATH, "POST")).status, 202)
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "generation-2:/thread/demo?tab=terminal")

    // Simulate a crash that leaves the durable proxy still bound. Restart remains available without
    // talking to the dead child first.
    await current.close()
    assert.equal((await get(port, SUPERVISOR_RESTART_PATH, "POST")).status, 202)
    assert.equal((await get(port, "/thread/demo?tab=terminal")).body, "generation-3:/thread/demo?tab=terminal")
    assert.equal(restarts, 2)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("repeat restart clicks coalesce and status is served by the public owner", async () => {
  const current = await child("one")
  let calls = 0
  let release!: (result: RestartResult) => void
  const waiting = new Promise<RestartResult>((resolve) => { release = resolve })
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: () => { calls++; return waiting },
  })
  try {
    await proxy.listen()
    const first = get(port, SUPERVISOR_RESTART_PATH, "POST")
    const second = get(port, SUPERVISOR_RESTART_PATH, "POST")
    await eventually(() => calls === 1 ? calls : undefined, "the one coalesced restart action")
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /restarting/)
    release({ state: "ready" })
    assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [202, 202])
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("public supervisor fails closed on a forbidden restart or occupied public port", async () => {
  const current = await child("one")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({ port, childPort: () => current.port, restart: async () => ({ state: "ready" }) })
  try {
    await proxy.listen()
    const denied = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: SUPERVISOR_RESTART_PATH, method: "POST" }, (res) => resolve(res.statusCode ?? 0))
      req.once("error", reject)
      req.end()
    })
    assert.equal(denied, 403)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }

  const blocker = await listen((_req, res) => res.end())
  const occupied = new RestartSupervisorProxy({ port: blocker.port, childPort: () => undefined, restart: async () => ({ state: "ready" }) })
  await assert.rejects(occupied.listen())
  await blocker.close()
})

test("update-and-restart is explicit and never falls through to an ordinary restart", async () => {
  const current = await child("one")
  const port = await freePort()
  let ordinary = 0
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => { ordinary++; return { state: "ready" } },
  })
  try {
    await proxy.listen()
    const response = await get(port, SUPERVISOR_UPDATE_RESTART_PATH, "POST")
    assert.equal(response.status, 409)
    assert.match(response.body, /immutable Fray artifact/)
    assert.equal(ordinary, 0)
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateRestart":false/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("status advertises Update & Restart only when the durable supervisor owns that capability", async () => {
  const current = await child("one")
  const port = await freePort()
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    restart: async () => ({ state: "ready" }),
    updateRestart: async () => ({ state: "ready" }),
  })
  try {
    await proxy.listen()
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"updateRestart":true/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

test("update acknowledgement and status stay truthful while the old child remains ready", async () => {
  const current = await child("old-but-still-serving")
  const port = await freePort()
  let release!: (result: RestartResult) => void
  const building = new Promise<RestartResult>((resolve) => { release = resolve })
  const proxy = new RestartSupervisorProxy({
    port,
    childPort: () => current.port,
    // This recreates the real failure mode: the disposable child can serve requests while the
    // durable owner builds its successor artifact.
    status: () => ({ state: "ready", artifactDigest: "old-artifact" }),
    restart: async () => ({ state: "ready" }),
    updateRestart: () => building,
  })
  try {
    await proxy.listen()
    const update = await get(port, SUPERVISOR_UPDATE_RESTART_PATH, "POST")
    assert.equal(update.status, 202)
    assert.match(update.body, /"state":"restarting"/)
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"state":"restarting"/)
    assert.equal((await get(port, "/still-live")).body, "old-but-still-serving:/still-live")
    release({ state: "ready" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match((await get(port, SUPERVISOR_STATUS_PATH)).body, /"state":"ready"/)
  } finally {
    await proxy.close().catch(() => undefined)
    await current.close().catch(() => undefined)
  }
})

async function freePort(): Promise<number> {
  const listener = await listen((_req, res) => res.end())
  const port = listener.port
  await listener.close()
  return port
}

async function eventually<T>(probe: () => T | undefined, description: string, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${description}`)
}
