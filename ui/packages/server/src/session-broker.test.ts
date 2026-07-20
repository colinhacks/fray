import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureSession,
  createFrameParser,
  encodeFrame,
  FRAME,
  hasSession,
  killSession,
  listSessions,
  spawnSession,
  writeToSession,
} from "./session-broker.ts"

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForCapture(stateDir: string, slug: string, needle: string, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let text = ""
    try { text = await captureSession(stateDir, slug) } catch {}
    if (text.includes(needle)) return text
    if (Date.now() > deadline) throw new Error(`capture never contained ${JSON.stringify(needle)}; last was ${JSON.stringify(text.slice(-200))}`)
    await delay(120)
  }
}

test("frame parser reassembles split and coalesced frames", () => {
  const seen: Array<[number, string]> = []
  const parse = createFrameParser((type, payload) => seen.push([type, payload.toString()]))
  const a = encodeFrame(FRAME.STREAM, Buffer.from("hello"))
  const b = encodeFrame(FRAME.CAPTURE_RES, Buffer.from("world"))
  const joined = Buffer.concat([a, b])
  parse(joined.subarray(0, 3)) // split mid-header
  parse(joined.subarray(3, 9)) // straddle frame boundary
  parse(joined.subarray(9))
  assert.deepEqual(seen, [[FRAME.STREAM, "hello"], [FRAME.CAPTURE_RES, "world"]])
})

test("broker: real TTY, survives launcher exit, input round-trips, capture + kill", { timeout: 30_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "fray-broker-"))
  const slug = "spike-1"
  // A shell-agnostic child: announce TTY status, then echo each stdin line back with a prefix.
  const script =
    'process.stdout.write("TTY=" + Boolean(process.stdout.isTTY) + "\\n");' +
    'process.stdin.on("data", (d) => process.stdout.write("GOT:" + d.toString()));'
  try {
    const record = await spawnSession({
      stateDir,
      slug,
      argv: [process.execPath, "-e", script],
      cwd: stateDir,
      env: process.env,
    })
    assert.ok(record.daemonPid > 0, "daemon pid published")
    assert.ok(record.childPid > 0, "child pid published")
    // The daemon was spawned detached, so its very existence proves it is not our child — i.e. it
    // would survive a fray restart. Discovery works from a cold read of the state dir:
    assert.equal(hasSession(stateDir, slug), true)
    assert.deepEqual(listSessions(stateDir), [slug])

    // Real terminal: the child sees a TTY (the whole reason subscription-auth TUIs work).
    const boot = await waitForCapture(stateDir, slug, "TTY=")
    assert.match(boot, /TTY=true/, "child must believe it is on a real terminal")

    // Input round-trips into the live PTY from a fresh control connection.
    await writeToSession(stateDir, slug, "ping-42\n")
    const echoed = await waitForCapture(stateDir, slug, "GOT:ping-42")
    assert.match(echoed, /GOT:ping-42/)

    await killSession(stateDir, slug)
    await delay(300)
    assert.equal(hasSession(stateDir, slug), false, "session gone after kill")
    assert.deepEqual(listSessions(stateDir), [])
  } finally {
    try { await killSession(stateDir, slug) } catch {}
    rmSync(stateDir, { recursive: true, force: true })
  }
})
