// The detached broker daemon: one per live agent session. It owns a node-pty running the agent argv,
// serves attach/control clients over a local socket, and outlives the fray server that spawned it —
// which is what makes a session survive Update & Restart. Launched by spawnSession() in
// session-broker.ts, which passes its whole config as JSON in FRAY_SESSION_BROKER. This process has
// no stdio (stdio:"ignore"); its only interface is the socket and the on-disk record file.
import { createServer, type Socket } from "node:net"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import pty from "node-pty"
import { createFrameParser, encodeFrame, FRAME } from "./session-broker.ts"

interface DaemonConfig {
  slug: string
  stateDir: string
  socketPath: string
  recordPath: string
  argv: string[]
  cwd: string
  cols: number
  rows: number
}

function readConfig(): DaemonConfig {
  const raw = process.env.FRAY_SESSION_BROKER
  if (!raw) throw new Error("session broker daemon started without FRAY_SESSION_BROKER")
  const c = JSON.parse(raw) as DaemonConfig
  if (!Array.isArray(c.argv) || c.argv.length === 0) throw new Error("session broker daemon config has empty argv")
  return c
}

const RING_MAX = 256 * 1024

function main(): void {
  const config = readConfig()
  const term = pty.spawn(config.argv[0]!, config.argv.slice(1), {
    name: "xterm-256color",
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: process.env as Record<string, string>,
  })

  // Recent-output ring so a fresh attach (or a capture) sees current screen state.
  let ring = Buffer.alloc(0)
  const clients = new Set<Socket>()

  term.onData((data) => {
    const buf = Buffer.from(data, "utf8")
    ring = ring.length ? Buffer.concat([ring, buf]) : buf
    if (ring.length > RING_MAX) ring = ring.subarray(ring.length - RING_MAX)
    const frame = encodeFrame(FRAME.STREAM, buf)
    for (const c of clients) { try { c.write(frame) } catch {} }
  })

  const cleanup = (): void => {
    for (const c of clients) { try { c.destroy() } catch {} }
    try { unlinkSync(config.recordPath) } catch {}
    if (process.platform !== "win32") { try { unlinkSync(config.socketPath) } catch {} }
  }

  term.onExit(({ exitCode }) => {
    cleanup()
    process.exit(exitCode ?? 0)
  })

  const server = createServer((sock) => {
    clients.add(sock)
    // Replay current state so an attaching terminal is immediately caught up.
    if (ring.length) { try { sock.write(encodeFrame(FRAME.STREAM, ring)) } catch {} }
    const parse = createFrameParser((type, payload) => {
      switch (type) {
        case FRAME.STREAM:
          term.write(payload.toString("utf8"))
          break
        case FRAME.RESIZE:
          if (payload.length >= 4) { try { term.resize(payload.readUInt16BE(0), payload.readUInt16BE(2)) } catch {} }
          break
        case FRAME.CAPTURE_REQ:
          try { sock.write(encodeFrame(FRAME.CAPTURE_RES, ring)) } catch {}
          break
        case FRAME.KILL:
          try { term.kill() } catch {}
          break
      }
    })
    sock.on("data", parse)
    const drop = (): void => { clients.delete(sock) }
    sock.on("close", drop)
    sock.on("error", drop)
  })

  // A stale unix socket from a crashed prior daemon would block listen(); named pipes need no unlink.
  if (process.platform !== "win32" && existsSync(config.socketPath)) { try { unlinkSync(config.socketPath) } catch {} }

  server.listen(config.socketPath, () => {
    writeFileSync(
      config.recordPath,
      JSON.stringify({
        slug: config.slug,
        daemonPid: process.pid,
        childPid: term.pid,
        socketPath: config.socketPath,
        createdAt: new Date().toISOString(),
      }),
    )
  })

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      try { term.kill() } catch {}
      cleanup()
      process.exit(0)
    })
  }
}

main()
