// Fray-owned session broker (Architecture A): the cross-platform replacement for tmux on the
// agent-execution path. Each interactive agent runs inside a node-pty PTY owned by a small DETACHED
// daemon (session-broker-daemon.ts) that outlives the fray server — so a session survives Update &
// Restart, and a user can re-attach from their own terminal. This module is the CLIENT side: it
// spawns the daemon, discovers running sessions, and talks the wire protocol (write input, capture
// recent output, resize, kill, attach). The PTY is provided by node-pty (mature ConPTY on Windows),
// which is the only reason this is portable; everything here is plain JS over a local socket.
import { spawn } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// ---- wire protocol -------------------------------------------------------------------------------
// FRAME = [type:1][len:uint32 BE][payload:len]. One protocol both directions; the peer reacts per
// frame. Raw terminal bytes are STREAM frames; everything else (resize/capture/kill) is typed, so a
// control connection and an interactive attach connection can share one socket without ambiguity.
export const FRAME = {
  STREAM: 0x01, // client->daemon: keystrokes into the pty; daemon->client: pty output
  RESIZE: 0x02, // client->daemon: payload [cols:uint16 BE][rows:uint16 BE]
  CAPTURE_REQ: 0x03, // client->daemon: request the current output ring
  CAPTURE_RES: 0x04, // daemon->client: payload = ring buffer bytes
  KILL: 0x05, // client->daemon: terminate the pty child and exit the daemon
} as const
export type FrameType = (typeof FRAME)[keyof typeof FRAME]

export function encodeFrame(type: FrameType, payload: Buffer = Buffer.alloc(0)): Buffer<ArrayBufferLike> {
  const head = Buffer.allocUnsafe(5)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/** Streaming frame parser. Feed it socket chunks; it invokes `onFrame` per complete frame. */
export function createFrameParser(onFrame: (type: number, payload: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      if (buf.length < 5) return
      const len = buf.readUInt32BE(1)
      if (buf.length < 5 + len) return
      const type = buf.readUInt8(0)
      const payload = buf.subarray(5, 5 + len)
      buf = buf.subarray(5 + len)
      onFrame(type, payload)
    }
  }
}

export function encodeResize(cols: number, rows: number): Buffer<ArrayBufferLike> {
  const p = Buffer.allocUnsafe(4)
  p.writeUInt16BE(Math.max(1, Math.min(65535, cols | 0)), 0)
  p.writeUInt16BE(Math.max(1, Math.min(65535, rows | 0)), 2)
  return encodeFrame(FRAME.RESIZE, p)
}

// ---- addressing ----------------------------------------------------------------------------------
export interface SessionRecord {
  slug: string
  daemonPid: number
  childPid: number
  socketPath: string
  createdAt: string
}

function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions")
}

function recordPath(stateDir: string, slug: string): string {
  return join(sessionsDir(stateDir), `${slug}.json`)
}

/**
 * Platform-appropriate socket path. Windows uses a named pipe (its own namespace, no length limit).
 * Unix domain sockets have a hard ~104-byte path limit on macOS/BSD, and the project state dir can be
 * long, so we hash (stateDir, slug) into a short, collision-resistant name under the OS temp dir.
 */
export function sessionSocketPath(stateDir: string, slug: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(slug).digest("hex").slice(0, 16)
  if (process.platform === "win32") return `\\\\.\\pipe\\fray-sess-${key}`
  return join(process.env.TMPDIR ?? "/tmp", `fray-sess-${key}.sock`)
}

// ---- daemon discovery / lifecycle ----------------------------------------------------------------
const daemonEntry = fileURLToPath(new URL("./session-broker-daemon.ts", import.meta.url))

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readRecord(stateDir: string, slug: string): SessionRecord | null {
  try {
    const value = JSON.parse(readFileSync(recordPath(stateDir, slug), "utf8")) as Partial<SessionRecord>
    if (typeof value.daemonPid !== "number" || typeof value.socketPath !== "string" || typeof value.childPid !== "number") return null
    return { slug, daemonPid: value.daemonPid, childPid: value.childPid, socketPath: value.socketPath, createdAt: value.createdAt ?? "" }
  } catch {
    return null
  }
}

/** A session is live only if its daemon process is still running; stale records are pruned. */
export function hasSession(stateDir: string, slug: string): boolean {
  const record = readRecord(stateDir, slug)
  if (!record) return false
  if (pidAlive(record.daemonPid)) return true
  try { unlinkSync(recordPath(stateDir, slug)) } catch {}
  return false
}

export function listSessions(stateDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDir(stateDir))
  } catch {
    return []
  }
  const live: string[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const slug = name.slice(0, -".json".length)
    if (hasSession(stateDir, slug)) live.push(slug)
  }
  return live
}

export interface SpawnSessionOptions {
  stateDir: string
  slug: string
  /** Full command + args to run inside the PTY (e.g. the claude/codex argv). */
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  /** Test seam: override the forked daemon entry. */
  daemonEntry?: string
  timeoutMs?: number
}

/**
 * Fork a DETACHED broker daemon that owns the PTY child and outlives this process. Resolves once the
 * daemon has published its record (socket listening + child pid known). The daemon is unref'd, so a
 * fray restart does not kill the session; a later generation rediscovers it via listSessions().
 */
export function spawnSession(options: SpawnSessionOptions): Promise<SessionRecord> {
  const { stateDir, slug, argv, cwd, env } = options
  if (argv.length === 0) throw new Error("spawnSession requires a non-empty argv")
  mkdirSync(sessionsDir(stateDir), { recursive: true })
  const socketPath = sessionSocketPath(stateDir, slug)
  const record = recordPath(stateDir, slug)
  try { unlinkSync(record) } catch {}

  const payload = JSON.stringify({
    slug,
    stateDir,
    socketPath,
    recordPath: record,
    argv,
    cwd,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
  })
  const child = spawn(process.execPath, [options.daemonEntry ?? daemonEntry], {
    cwd,
    env: { ...env, FRAY_SESSION_BROKER: payload },
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  return new Promise<SessionRecord>((resolve, reject) => {
    const poll = () => {
      const found = readRecord(stateDir, slug)
      if (found && pidAlive(found.daemonPid)) return resolve(found)
      if (Date.now() > deadline) return reject(new Error(`session broker for "${slug}" did not become ready`))
      setTimeout(poll, 50)
    }
    child.once("error", reject)
    poll()
  })
}

// ---- control operations --------------------------------------------------------------------------
function connect(stateDir: string, slug: string): Socket {
  const record = readRecord(stateDir, slug)
  if (!record) throw new Error(`no session broker for "${slug}"`)
  return createConnection(record.socketPath)
}

/** One-shot: deliver input (a follow-up message or a keystroke) into the live agent's PTY. */
export function writeToSession(stateDir: string, slug: string, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(stateDir, slug)
    sock.once("error", reject)
    sock.once("connect", () => {
      sock.write(encodeFrame(FRAME.STREAM, Buffer.from(data)), () => {
        sock.end()
        resolve()
      })
    })
  })
}

/** Request the daemon's recent-output ring — the replacement for `tmux capture-pane`. */
export function captureSession(stateDir: string, slug: string, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(stateDir, slug)
    const parse = createFrameParser((type, payload) => {
      if (type === FRAME.CAPTURE_RES) {
        sock.end()
        resolve(payload.toString("utf8"))
      }
    })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`capture for "${slug}" timed out`))
    }, timeoutMs)
    timer.unref?.()
    sock.once("error", reject)
    sock.once("close", () => clearTimeout(timer))
    sock.on("data", parse)
    sock.once("connect", () => sock.write(encodeFrame(FRAME.CAPTURE_REQ)))
  })
}

export function killSession(stateDir: string, slug: string, timeoutMs = 5_000): Promise<void> {
  const record = readRecord(stateDir, slug)
  if (!record) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try { unlinkSync(recordPath(stateDir, slug)) } catch {}
      resolve()
    }
    const sock = createConnection(record.socketPath)
    const giveUp = setTimeout(() => {
      // The daemon may already be gone; fall back to a direct signal, then declare it done.
      if (pidAlive(record.daemonPid)) { try { process.kill(record.daemonPid, "SIGTERM") } catch {} }
      sock.destroy()
      done()
    }, timeoutMs)
    giveUp.unref?.()
    sock.once("error", () => { clearTimeout(giveUp); done() })
    sock.once("close", () => { clearTimeout(giveUp); done() })
    sock.once("connect", () => sock.write(encodeFrame(FRAME.KILL)))
  })
}
