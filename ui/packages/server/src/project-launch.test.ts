import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test, type TestContext } from "node:test"
import {
  acquireProjectLaunchOwner,
  adoptProjectLaunchOwner,
  currentProcessGeneration,
  projectLaunchOwnerPath,
  projectLaunchTokenProof,
  readProjectLaunchOwner,
  registerProjectLaunchDelegate,
  tryAcquireProjectLaunchOwner,
  removeProjectStatus,
  writeProjectStatus,
  type ProcessGeneration,
  type ProcessGenerationObservation,
  type ProcessPlatformAdapter,
  type ProjectLaunchTarget,
} from "./project-launch.ts"
import { startServer } from "./index.ts"

interface FakeProcess extends ProcessGeneration {
  alive: boolean
  confidence: ProcessGenerationObservation["confidence"]
}

function fakePlatform(initial: FakeProcess) {
  let current: ProcessGeneration = { pid: initial.pid, processStart: initial.processStart }
  let now = 1_000
  const processes = new Map<number, FakeProcess>([[initial.pid, { ...initial }]])
  let onSleep: ((ms: number) => void) | undefined
  const adapter: ProcessPlatformAdapter = {
    current: () => ({ ...current }),
    observe: (pid) => {
      const process = processes.get(pid)
      return process?.alive
        ? { processStart: process.processStart, confidence: process.confidence }
        : { confidence: "unavailable" }
    },
    isAlive: (pid) => processes.get(pid)?.alive === true,
    now: () => now,
    sleep: (ms) => { now += ms; onSleep?.(ms) },
  }
  return {
    adapter,
    processes,
    setCurrent(process: FakeProcess) {
      current = { pid: process.pid, processStart: process.processStart }
      processes.set(process.pid, { ...process })
    },
    onSleep(callback: (ms: number) => void) { onSleep = callback },
  }
}

function fixture(t: TestContext): ProjectLaunchTarget {
  const projectDir = mkdtempSync(join(tmpdir(), "fray-project-launch-test-"))
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  return { projectId: randomUUID(), projectDir, stateDir: join(projectDir, "state") }
}

test("canonical self generation is tagged and stable", () => {
  const first = currentProcessGeneration()
  const second = currentProcessGeneration()
  assert.deepEqual(second, first)
  assert.match(first.processStart, /^(?:linux|ps-utc|opaque):/u)
})

test("property: one exact project admits at most one live owner", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 10, processStart: "linux:boot:10", alive: true, confidence: "exact" })
  for (let index = 0; index < 32; index++) {
    const owner = acquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter })
    platform.setCurrent({
      pid: 100 + index,
      processStart: `linux:boot:${100 + index}`,
      alive: true,
      confidence: "exact",
    })
    const contender = tryAcquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter })
    assert.equal(contender.kind, "contended")
    assert.equal(owner.release(), true)
  }
})

test("weak same-second proof retains ownership for authenticated control", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 41, processStart: "ps-utc:Mon Jan 1 00:00:00 2024", alive: true, confidence: "weak" })
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter: platform.adapter })
  platform.setCurrent({ pid: 42, processStart: "opaque:contender", alive: true, confidence: "unavailable" })
  assert.equal(tryAcquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter }).kind, "contended")
  owner.release()
})

test("observer capability changes fail closed instead of declaring a live owner stale", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 45, processStart: "linux:boot:45", alive: true, confidence: "exact" })
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter: platform.adapter })
  platform.processes.set(45, {
    pid: 45,
    processStart: "ps-utc:Mon Jan 1 00:00:00 2024",
    alive: true,
    confidence: "weak",
  })
  platform.setCurrent({ pid: 46, processStart: "opaque:observer", alive: true, confidence: "unavailable" })
  assert.equal(tryAcquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter }).kind, "contended")
  platform.processes.get(45)!.alive = false
  const recovered = tryAcquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter })
  assert.equal(recovered.kind, "acquired")
  if (recovered.kind === "acquired") recovered.lease.release()
  owner.release()
})

test("version-1 ownership normalizes and adopts atomically into the current schema", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 47, processStart: "linux:boot:47", alive: true, confidence: "exact" })
  const original = acquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter })
  const record = readProjectLaunchOwner(target.stateDir)!
  writeFileSync(projectLaunchOwnerPath(target.stateDir), JSON.stringify({
    version: 1,
    pid: record.pid,
    processStart: record.processStart,
    token: record.token,
    projectId: record.projectId,
    projectDir: record.projectDir,
    role: record.role,
    acquiredAt: record.acquiredAt,
    updatedAt: record.updatedAt,
  }))

  assert.deepEqual(readProjectLaunchOwner(target.stateDir), {
    ...record,
    version: 2,
    state: "active",
    delegates: [],
  })
  const adopted = adoptProjectLaunchOwner(target, original.token, "supervisor", { adapter: platform.adapter })
  assert.equal(readProjectLaunchOwner(target.stateDir)?.version, 2)
  assert.equal(readProjectLaunchOwner(target.stateDir)?.state, "active")
  assert.deepEqual(readProjectLaunchOwner(target.stateDir)?.delegates, [])
  assert.equal(readProjectLaunchOwner(target.stateDir)?.role, "supervisor")
  assert.equal(adopted.release(), true)
  assert.equal(original.release(), false)
})

test("stale owner waits for registered delegates to self-exit before status replacement", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 51, processStart: "linux:boot:51", alive: true, confidence: "exact" })
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter: platform.adapter })
  platform.setCurrent({ pid: 52, processStart: "linux:boot:52", alive: true, confidence: "exact" })
  registerProjectLaunchDelegate(target, owner.token, "control-plane", { adapter: platform.adapter })
  const status = join(target.stateDir, "server.lock")
  writeProjectStatus(status, { ownerToken: owner.token, pid: 52, processStart: "linux:boot:52" })

  platform.processes.get(51)!.alive = false
  platform.setCurrent({ pid: 53, processStart: "linux:boot:53", alive: true, confidence: "exact" })
  platform.onSleep(() => { platform.processes.get(52)!.alive = false })
  const successor = tryAcquireProjectLaunchOwner(target, "launcher", {
    adapter: platform.adapter,
    delegateDrainTimeoutMs: 50,
  })
  assert.equal(successor.kind, "acquired")
  assert.equal(existsSync(status), false)
  if (successor.kind === "acquired") successor.lease.release()
})

test("a delegate PID recycled during drain is treated as stale without touching the new process", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 54, processStart: "linux:boot:54", alive: true, confidence: "exact" })
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter: platform.adapter })
  platform.setCurrent({ pid: 55, processStart: "linux:boot:old-55", alive: true, confidence: "exact" })
  registerProjectLaunchDelegate(target, owner.token, "control-plane", { adapter: platform.adapter })
  platform.processes.get(owner.pid)!.alive = false
  platform.setCurrent({ pid: 56, processStart: "linux:boot:56", alive: true, confidence: "exact" })
  platform.onSleep(() => {
    platform.processes.set(55, {
      pid: 55,
      processStart: "linux:boot:unrelated-reused-55",
      alive: true,
      confidence: "exact",
    })
  })

  const successor = tryAcquireProjectLaunchOwner(target, "launcher", {
    adapter: platform.adapter,
    delegateDrainTimeoutMs: 50,
    pollMs: 5,
  })
  assert.equal(successor.kind, "acquired")
  assert.deepEqual(platform.processes.get(55), {
    pid: 55,
    processStart: "linux:boot:unrelated-reused-55",
    alive: true,
    confidence: "exact",
  })
  if (successor.kind === "acquired") successor.lease.release()
})

test("unverifiable live delegate leaves a draining fence and status intact at timeout", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 61, processStart: "opaque:owner", alive: true, confidence: "unavailable" })
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter: platform.adapter })
  platform.setCurrent({ pid: 62, processStart: "opaque:delegate", alive: true, confidence: "unavailable" })
  registerProjectLaunchDelegate(target, owner.token, "control-plane", { adapter: platform.adapter })
  const status = join(target.stateDir, "server.lock")
  writeProjectStatus(status, { ownerToken: owner.token, pid: 62, processStart: "opaque:delegate" })

  platform.processes.get(61)!.alive = false
  platform.setCurrent({ pid: 63, processStart: "opaque:successor", alive: true, confidence: "unavailable" })
  const blocked = tryAcquireProjectLaunchOwner(target, "launcher", {
    adapter: platform.adapter,
    delegateDrainTimeoutMs: 30,
    pollMs: 5,
  })
  assert.equal(blocked.kind, "contended")
  assert.equal(readProjectLaunchOwner(target.stateDir)?.state, "draining")
  assert.equal(existsSync(status), true)

  platform.processes.get(62)!.alive = false
  const recovered = tryAcquireProjectLaunchOwner(target, "launcher", { adapter: platform.adapter })
  assert.equal(recovered.kind, "acquired")
  if (recovered.kind === "acquired") recovered.lease.release()
})

test("a moved root retires only a stale owner at the same durable project identity", (t) => {
  const original = fixture(t)
  const moved = { ...original, projectDir: `${original.projectDir}-moved` }
  const platform = fakePlatform({ pid: 64, processStart: "linux:boot:64", alive: true, confidence: "exact" })
  const owner = acquireProjectLaunchOwner(original, "supervisor", { adapter: platform.adapter })

  platform.setCurrent({ pid: 65, processStart: "linux:boot:65", alive: true, confidence: "exact" })
  const liveAttempt = tryAcquireProjectLaunchOwner(moved, "launcher", { adapter: platform.adapter })
  assert.equal(liveAttempt.kind, "contended")
  assert.equal(readProjectLaunchOwner(original.stateDir)?.projectDir, original.projectDir)

  platform.processes.get(owner.pid)!.alive = false
  const successor = tryAcquireProjectLaunchOwner(moved, "launcher", { adapter: platform.adapter })
  assert.equal(successor.kind, "acquired")
  assert.equal(readProjectLaunchOwner(original.stateDir)?.projectDir, moved.projectDir)

  platform.setCurrent({ pid: 66, processStart: "linux:boot:66", alive: true, confidence: "exact" })
  assert.equal(tryAcquireProjectLaunchOwner(moved, "launcher", { adapter: platform.adapter }).kind, "contended")
  if (successor.kind === "acquired") successor.lease.release()
})

test("a moved root remains fenced while a stale owner's delegate cannot drain", (t) => {
  const original = fixture(t)
  const moved = { ...original, projectDir: `${original.projectDir}-moved` }
  const platform = fakePlatform({ pid: 67, processStart: "linux:boot:67", alive: true, confidence: "exact" })
  const owner = acquireProjectLaunchOwner(original, "supervisor", { adapter: platform.adapter })
  platform.setCurrent({ pid: 68, processStart: "linux:boot:68", alive: true, confidence: "exact" })
  registerProjectLaunchDelegate(original, owner.token, "control-plane", { adapter: platform.adapter })
  const status = join(original.stateDir, "server.lock")
  writeProjectStatus(status, { ownerToken: owner.token, pid: 68, processStart: "linux:boot:68" })

  platform.processes.get(owner.pid)!.alive = false
  platform.setCurrent({ pid: 69, processStart: "linux:boot:69", alive: true, confidence: "exact" })
  const blocked = tryAcquireProjectLaunchOwner(moved, "launcher", {
    adapter: platform.adapter,
    delegateDrainTimeoutMs: 20,
    pollMs: 5,
  })
  assert.equal(blocked.kind, "contended")
  assert.equal(readProjectLaunchOwner(original.stateDir)?.state, "draining")
  assert.equal(readProjectLaunchOwner(original.stateDir)?.projectDir, original.projectDir)
  assert.equal(existsSync(status), true)

  platform.processes.get(68)!.alive = false
  const recovered = tryAcquireProjectLaunchOwner(moved, "launcher", { adapter: platform.adapter })
  assert.equal(recovered.kind, "acquired")
  assert.equal(readProjectLaunchOwner(original.stateDir)?.projectDir, moved.projectDir)
  assert.equal(existsSync(status), false)
  if (recovered.kind === "acquired") recovered.lease.release()
})

test("a stale owner from another project id cannot be retired through a shared state path", (t) => {
  const target = fixture(t)
  const platform = fakePlatform({ pid: 70, processStart: "linux:boot:70", alive: true, confidence: "exact" })
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter: platform.adapter })
  platform.processes.get(owner.pid)!.alive = false
  platform.setCurrent({ pid: 71, processStart: "linux:boot:71", alive: true, confidence: "exact" })
  const foreign = tryAcquireProjectLaunchOwner({ ...target, projectId: randomUUID() }, "launcher", {
    adapter: platform.adapter,
  })
  assert.equal(foreign.kind, "contended")
  assert.equal(readProjectLaunchOwner(target.stateDir)?.state, "active")
})

test("token proof is stable and bound to the exact project root and id", (t) => {
  const target = fixture(t)
  const token = randomUUID()
  assert.equal(projectLaunchTokenProof(target, token), projectLaunchTokenProof(target, token))
  assert.notEqual(
    projectLaunchTokenProof(target, token),
    projectLaunchTokenProof({ ...target, projectDir: `${target.projectDir}-other` }, token),
  )
  assert.notEqual(projectLaunchTokenProof(target, token), projectLaunchTokenProof(target, randomUUID()))
})

test("status retirement requires the exact owner token and publisher generation", (t) => {
  const target = fixture(t)
  const path = join(target.stateDir, "server.lock")
  const ownerToken = randomUUID()
  const publisherToken = randomUUID()
  mkdirSync(target.stateDir, { recursive: true })
  writeProjectStatus(path, {
    pid: 321,
    processStart: "linux:boot:321",
    publisherToken,
    ownerToken,
  })
  assert.equal(removeProjectStatus(path, {
    pid: 321,
    processStart: "linux:boot:321",
    publisherToken,
    ownerToken: randomUUID(),
  }), false)
  assert.equal(existsSync(path), true)
  assert.equal(removeProjectStatus(path, {
    pid: 321,
    processStart: "linux:boot:321",
    publisherToken,
    ownerToken,
  }), true)
  assert.equal(existsSync(path), false)
})

test("linked-worktree state directories own independently", (t) => {
  const first = fixture(t)
  const second = fixture(t)
  const firstOwner = acquireProjectLaunchOwner(first, "launcher")
  const secondOwner = acquireProjectLaunchOwner(second, "launcher")
  assert.notEqual(firstOwner.token, secondOwner.token)
  assert.equal(firstOwner.release(), true)
  assert.equal(secondOwner.release(), true)
})

test("direct server contention fails before SQLite, watcher, or port initialization", async (t) => {
  const target = fixture(t)
  const owner = acquireProjectLaunchOwner(target, "launcher")
  try {
    await assert.rejects(startServer({
      port: 65_123,
      project: {
        id: target.projectId,
        dir: target.projectDir,
        stateDir: target.stateDir,
        name: "owner-gate",
        label: "owner-gate",
        cwdSlug: "-owner-gate",
      },
    }), /already owned/u)
    assert.equal(existsSync(join(target.stateDir, "ui.db")), false)
    assert.equal(existsSync(join(target.stateDir, "server.lock")), false)
  } finally {
    owner.release()
  }
})

const projectLaunchUrl = pathToFileURL(join(import.meta.dirname, "project-launch.ts")).href

function processScript(kind: "owner" | "delegate"): string {
  if (kind === "owner") return `
    import { tryAcquireProjectLaunchOwner } from ${JSON.stringify(projectLaunchUrl)}
    const target = JSON.parse(process.env.TARGET)
    const attempt = tryAcquireProjectLaunchOwner(target, process.env.ROLE ?? "launcher", {
      delegateDrainTimeoutMs: Number(process.env.DRAIN_MS ?? 6000),
    })
    console.log(JSON.stringify(attempt.kind === "acquired"
      ? { kind: "acquired", token: attempt.lease.token, pid: attempt.lease.pid, processStart: attempt.lease.processStart }
      : { kind: "contended", owner: attempt.owner }))
    if (attempt.kind === "acquired") {
      const finish = () => { attempt.lease.release(); process.exit(0) }
      process.on("SIGTERM", finish)
      setTimeout(finish, Number(process.env.HOLD_MS ?? 30000))
    }
  `
  return `
    import { registerProjectLaunchDelegate } from ${JSON.stringify(projectLaunchUrl)}
    const target = JSON.parse(process.env.TARGET)
    const lease = registerProjectLaunchDelegate(target, process.env.TOKEN)
    console.log(JSON.stringify({ kind: "delegated", pid: lease.pid, processStart: lease.processStart }))
    let ownerGoneAt = 0
    const timer = setInterval(() => {
      try { process.kill(Number(process.env.OWNER_PID), 0); ownerGoneAt = 0 }
      catch {
        ownerGoneAt ||= Date.now()
        if (Date.now() - ownerGoneAt >= Number(process.env.EXIT_DELAY_MS ?? 0)) {
          clearInterval(timer); lease.release(); process.exit(0)
        }
      }
    }, 10)
    process.on("SIGTERM", () => { clearInterval(timer); lease.release(); process.exit(0) })
  `
}

function spawnScript(source: string, target: ProjectLaunchTarget, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, TARGET: JSON.stringify(target), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const line = new Promise<Record<string, unknown>>((resolveLine, rejectLine) => {
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline >= 0) resolveLine(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>)
    })
    child.once("exit", (code, signal) => {
      if (!stdout.includes("\n")) rejectLine(new Error(`child exited ${code}/${signal}: ${stderr}`))
    })
  })
  return { child, line }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  await exited
}

test("real processes with different TZ/locale cannot steal one live owner", { timeout: 10_000 }, async (t) => {
  const target = fixture(t)
  const first = spawnScript(processScript("owner"), target, { TZ: "UTC", LC_ALL: "C", HOLD_MS: "30000" })
  assert.equal((await first.line).kind, "acquired")
  const second = spawnScript(processScript("owner"), target, {
    TZ: "America/Los_Angeles",
    LC_ALL: "en_US.UTF-8",
    HOLD_MS: "100",
  })
  assert.equal((await second.line).kind, "contended")
  await stopChild(first.child)
  await stopChild(second.child)
})

test("real PATH-without-ps owner is retained for token control when proof is opaque", { timeout: 10_000 }, async (t) => {
  const target = fixture(t)
  const owner = spawnScript(processScript("owner"), target, { PATH: "", HOLD_MS: "30000" })
  const record = await owner.line
  assert.equal(record.kind, "acquired")
  const contender = spawnScript(processScript("owner"), target, { HOLD_MS: "100" })
  assert.equal((await contender.line).kind, "contended")
  await stopChild(owner.child)
  await stopChild(contender.child)
})

test("real supervisor SIGKILL waits for its registered child before successor ownership", { timeout: 15_000 }, async (t) => {
  const target = fixture(t)
  const owner = spawnScript(processScript("owner"), target, { ROLE: "supervisor", HOLD_MS: "30000" })
  const ownerRecord = await owner.line
  assert.equal(ownerRecord.kind, "acquired")
  const delegate = spawnScript(processScript("delegate"), target, {
    TOKEN: String(ownerRecord.token),
    OWNER_PID: String(ownerRecord.pid),
    EXIT_DELAY_MS: "150",
  })
  assert.equal((await delegate.line).kind, "delegated")
  owner.child.kill("SIGKILL")
  await once(owner.child, "exit")
  const started = Date.now()
  const successor = spawnScript(processScript("owner"), target, { ROLE: "supervisor", HOLD_MS: "100" })
  assert.equal((await successor.line).kind, "acquired")
  assert.ok(Date.now() - started >= 100, "successor waits for the prior delegate to drain")
  await stopChild(delegate.child)
  await stopChild(successor.child)
})

test("real SIGKILL recovery follows canonical main and linked-worktree root moves", { timeout: 20_000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), "fray-project-launch-moved-roots-"))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  for (const variant of ["main", "linked"] as const) {
    const originalDir = join(base, `${variant}-original`)
    const movedDir = join(base, `${variant}-moved`)
    mkdirSync(originalDir)
    const original: ProjectLaunchTarget = {
      projectId: randomUUID(),
      projectDir: originalDir,
      stateDir: join(base, `${variant}-state`),
      ...(variant === "linked" ? { identityScope: "worktree" as const } : {}),
    }
    const owner = spawnScript(processScript("owner"), original, { ROLE: "supervisor", HOLD_MS: "30000" })
    assert.equal((await owner.line).kind, "acquired")
    const ownerExit = once(owner.child, "exit")
    owner.child.kill("SIGKILL")
    await ownerExit
    renameSync(originalDir, movedDir)

    const moved = { ...original, projectDir: movedDir }
    const successor = spawnScript(processScript("owner"), moved, { ROLE: "supervisor", HOLD_MS: "30000" })
    assert.equal((await successor.line).kind, "acquired")
    assert.equal(readProjectLaunchOwner(moved.stateDir)?.projectDir, movedDir)
    const repeated = spawnScript(processScript("owner"), moved, { ROLE: "supervisor", HOLD_MS: "100" })
    assert.equal((await repeated.line).kind, "contended")
    await stopChild(repeated.child)
    await stopChild(successor.child)
  }
})
