import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import {
  DEV_CRASH_RETRY_MAX_MS,
  classifyDevChange,
  createSupervisorShutdownHandler,
  defaultDevWatchRoots,
  devChildEnv,
  devConfigSyntaxError,
  devCrashRetryDelay,
  devReexecEnv,
  isDevServerSource,
  startDevSupervisor,
  type DevBoot,
  type DevSupervisor,
  type DevSupervisorOptions,
} from "./dev-supervisor.ts"
import { acquireProjectLaunchOwner, type ProjectLaunchLease } from "./project-launch.ts"
import { createStorage } from "./storage.ts"

const projectLaunchUrl = pathToFileURL(join(import.meta.dirname, "project-launch.ts")).href

test("dev supervisor classifies runtime and launcher/config changes without touching web HMR or artifacts", () => {
  const [workspace] = defaultDevWatchRoots()
  const server = join(workspace, "packages", "server", "src")
  const shared = join(workspace, "packages", "shared", "src")
  const rpc = join(workspace, "packages", "rpc", "src")
  const cli = join(workspace, "packages", "cli", "src")
  const sdk = join(workspace, "packages", "claude-agent-sdk-runtime")
  assert.equal(isDevServerSource(join(server, "router.ts")), true)
  assert.equal(isDevServerSource(join(server, "backend", "codex.ts")), true)
  assert.equal(isDevServerSource(join(shared, "index.ts")), true)
  assert.equal(isDevServerSource(join(rpc, "client.ts")), true)
  assert.equal(classifyDevChange(join(server, "router.ts")), "child")
  assert.equal(classifyDevChange(join(shared, "index.ts")), "child")
  assert.equal(classifyDevChange(join(rpc, "client.ts")), "child")
  assert.equal(classifyDevChange(join(sdk, "src", "index.ts")), "child")
  assert.equal(classifyDevChange(join(sdk, "src", "nested", "schema.json")), "child")
  assert.equal(classifyDevChange(join(sdk, "package.json")), "child")
  assert.equal(classifyDevChange(join(server, "dev-supervisor.ts")), "launcher")
  assert.equal(classifyDevChange(join(cli, "index.ts")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "packages", "server", "package.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "packages", "shared", "package.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "package.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "pnpm-lock.yaml")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "tsconfig.base.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "packages", "web", "vite.config.ts")), "launcher")

  assert.equal(isDevServerSource(join(server, "router.test.ts")), false)
  assert.equal(isDevServerSource(join(server, "WORKER_PROMPT.claude.golden.txt")), false)
  assert.equal(isDevServerSource(join(server, "backend", "codex.fixtures", "sample.json")), false)
  assert.equal(isDevServerSource(join(server, "ui.db")), false)
  assert.equal(isDevServerSource(join(server, "ui.db-wal")), false)
  assert.equal(isDevServerSource(join(server, "transcript.jsonl")), false)
  assert.equal(isDevServerSource(join(server, "..", "dist", "index.js")), false)
  assert.equal(isDevServerSource(join(sdk, ".cache", "generated.ts")), false)
  assert.equal(isDevServerSource(join(sdk, ".parcel-cache", "generated.js")), false)
  assert.equal(isDevServerSource(join(sdk, "node_modules", "dependency", "index.ts")), false)
  assert.equal(isDevServerSource(join(sdk, "src", "index.test.ts")), false)
  assert.equal(isDevServerSource(join(workspace, "packages", "unrelated-tool", "src", "index.ts")), false)
  assert.equal(isDevServerSource(join(server, "..", "..", "web", "src", "main.tsx")), false)

  const disposableRoot = join(tmpdir(), "fray-disposable-watch-root")
  assert.equal(
    classifyDevChange(join(disposableRoot, "packages", "claude-agent-sdk-runtime", "src", "index.ts"), [disposableRoot]),
    "child",
    "custom roots classify against their own workspace rather than the source checkout",
  )
})

test("dev child inherits the complete environment including the tmux socket", () => {
  const input: NodeJS.ProcessEnv = {
    HOME: "/tmp/fray-home",
    PATH: "/bin:/usr/bin",
    FRAY_TMUX_SOCKET: "fray-legacy-nub",
    CUSTOM_VALUE: "kept",
  }
  const output = devChildEnv(input, 51234)
  assert.deepEqual(output, {
    ...input,
    FRAY_DEV_PORT: "51234",
    FRAY_DEV_CHILD: "1",
  })
  assert.notEqual(output, input)
  assert.equal(input.FRAY_DEV_PORT, undefined, "the caller's env object is not mutated")
})

test("dev launcher re-exec preserves user environment and drops only child-private markers", () => {
  const output = devReexecEnv({
    HOME: "/tmp/fray-home",
    FRAY_TMUX_SOCKET: "fray-nub",
    CUSTOM_VALUE: "kept",
    FRAY_DEV_CHILD: "1",
    FRAY_DEV_PORT: "4917",
  })
  assert.deepEqual(output, {
    HOME: "/tmp/fray-home",
    FRAY_TMUX_SOCKET: "fray-nub",
    CUSTOM_VALUE: "kept",
    FRAY_DEV_REEXEC: "1",
  })
})

test("dev crash retry backs off exponentially and caps restart storms", () => {
  assert.equal(devCrashRetryDelay(1), 500)
  assert.equal(devCrashRetryDelay(2), 1000)
  assert.equal(devCrashRetryDelay(3), 2000)
  assert.equal(devCrashRetryDelay(99), DEV_CRASH_RETRY_MAX_MS)
})

test("repeated supervisor signals share one close, release, and exit decision", async () => {
  let resolveClose!: () => void
  const closing = new Promise<void>((resolve) => { resolveClose = resolve })
  let closes = 0
  let releases = 0
  const exits: number[] = []
  const stop = createSupervisorShutdownHandler({
    close: () => { closes++; return closing },
    release: () => { releases++ },
    exit: (code) => { exits.push(code) },
  })
  stop()
  stop()
  stop()
  assert.equal(closes, 1)
  assert.equal(releases, 0)
  resolveClose()
  await closing
  await Promise.resolve()
  assert.equal(releases, 1)
  assert.deepEqual(exits, [0])
})

test("dev launcher syntax-checks package JSON and JSONC tsconfig before replacing a healthy child", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-dev-config-"))
  try {
    const pkg = join(dir, "package.json")
    writeFileSync(pkg, '{"name":"ok"}\n')
    assert.equal(devConfigSyntaxError(pkg), null)
    writeFileSync(pkg, "{ invalid json\n")
    assert.match(devConfigSyntaxError(pkg) ?? "", /package\.json/)

    const tsconfig = join(dir, "tsconfig.json")
    writeFileSync(tsconfig, '{\n  // JSONC is valid here\n  "compilerOptions": { "strict": true, },\n}\n')
    assert.equal(devConfigSyntaxError(tsconfig), null)
    writeFileSync(tsconfig, '{ "compilerOptions": { "strict": !!! } }\n')
    assert.match(devConfigSyntaxError(tsconfig) ?? "", /tsconfig\.json/)

    assert.equal(devConfigSyntaxError(join(dir, "vite.config.ts")), null, "Vite is validated by child startup")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("exported supervisor API rejects an unowned caller before status or watcher initialization", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-dev-supervisor-owner-gate-"))
  const stateDir = join(workspace, "state")
  mkdirSync(stateDir, { recursive: true })
  let watched = 0
  try {
    await assert.rejects(startDevSupervisor({
      port: 49_173,
      launchTarget: { projectId: randomUUID(), projectDir: workspace, stateDir },
      launchOwnerToken: randomUUID(),
      watchRoots: [workspace],
      watchSubscribe: async () => {
        watched++
        return { unsubscribe: async () => {} }
      },
    }), /no live matching project launch owner/u)
    assert.equal(watched, 0)
    assert.equal(existsSync(join(stateDir, "dev-supervisor.lock")), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("exported supervisor API rejects a valid owner token presented by the wrong process", { timeout: 10_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-dev-supervisor-wrong-process-"))
  const stateDir = join(workspace, "state")
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  mkdirSync(stateDir, { recursive: true })
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireProjectLaunchOwner } from ${JSON.stringify(projectLaunchUrl)}
    const target = JSON.parse(process.env.TARGET)
    const lease = acquireProjectLaunchOwner(target, "supervisor")
    console.log(JSON.stringify({ token: lease.token }))
    const stop = () => { lease.release(); process.exit(0) }
    process.on("SIGTERM", stop)
    setInterval(() => {}, 1000)
  `], {
    cwd: process.cwd(),
    env: { ...process.env, TARGET: JSON.stringify(launchTarget) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let watched = 0
  try {
    const [chunk] = await once(child.stdout!, "data") as [Buffer]
    const { token } = JSON.parse(chunk.toString("utf8").trim()) as { token: string }
    await assert.rejects(startDevSupervisor({
      port: 49_173,
      launchTarget,
      launchOwnerToken: token,
      watchRoots: [workspace],
      watchSubscribe: async () => {
        watched++
        return { unsubscribe: async () => {} }
      },
    }), /caller is not the exact project launch owner/u)
    assert.equal(watched, 0)
    assert.equal(existsSync(join(stateDir, "dev-supervisor.lock")), false)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    await stopFixtureWorker(child)
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("supervisor rejects an unregistered child ready claim before accepting the generation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-dev-supervisor-child-gate-"))
  const stateDir = join(workspace, "state")
  const childEntry = join(workspace, "unregistered-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    process.send?.({
      type: "fray-ready",
      pid: process.pid,
      processStart: "opaque:forged-unregistered-child",
      port: Number(process.env.FRAY_DEV_PORT),
      bootId: "forged-ready",
    })
    process.on("SIGTERM", () => process.exit(0))
    setInterval(() => {}, 1000)
  `)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port: 49_173,
      launchTarget,
      launchOwnerToken: owner.token,
      childEntry,
      watchRoots: [workspace],
      watchSubscribe: async () => ({ unsubscribe: async () => {} }),
      log: () => {},
      error: () => {},
    })
    await eventually(() => {
      const status = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return status?.state === "failed" && /without a registered owner-bound generation/u.test(status.message)
        ? status
        : undefined
    }, "unregistered child rejection")
    assert.equal(supervisor.currentBoot(), null)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("supervisor rejects a forged ready PID even when the child registered its real generation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-dev-supervisor-forged-ready-pid-"))
  const stateDir = join(workspace, "state")
  const childEntry = join(workspace, "forged-ready-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(70)
    const lease = registerProjectLaunchDelegate(target, token)
    process.send?.({
      type: "fray-ready",
      pid: process.pid + 100000,
      processStart: lease.processStart,
      port: Number(process.env.FRAY_DEV_PORT),
      bootId: "forged-ready-pid",
    })
    const stop = () => { lease.release(); process.exit(0) }
    process.on("SIGTERM", stop)
    process.on("disconnect", stop)
    setInterval(() => {}, 1000)
  `)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port: 49_173,
      launchTarget,
      launchOwnerToken: owner.token,
      childEntry,
      watchRoots: [workspace],
      watchSubscribe: async () => ({ unsubscribe: async () => {} }),
      log: () => {},
      error: () => {},
    })
    await eventually(() => {
      const status = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return status?.state === "failed" && /without a registered owner-bound generation/u.test(status.message)
        ? status
        : undefined
    }, "registered child forged PID rejection")
    assert.equal(supervisor.currentBoot(), null)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

interface SupervisorStatus {
  pid: number
  childPid?: number
  state: "starting" | "restarting" | "ready" | "failed" | "degraded"
  message: string
  artifactDigest?: string
}

async function freeSupervisorPort(): Promise<number> {
  const listener = createNetServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once("error", rejectListen)
    listener.listen(0, "127.0.0.1", () => resolveListen())
  })
  const address = listener.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()))
  return address.port
}

async function eventually<T>(probe: () => T | undefined, description: string, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await delay(10)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function readSupervisorStatus(path: string): SupervisorStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SupervisorStatus
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function nextBoot(supervisor: DevSupervisor, previousPid: number): Promise<DevBoot> {
  return eventually(() => {
    const boot = supervisor.currentBoot()
    return boot && boot.pid !== previousPid ? boot : undefined
  }, `a control-plane boot after pid ${previousPid}`)
}

async function stopFixtureWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  const exited = once(worker, "exit")
  worker.kill("SIGTERM")
  await Promise.race([exited, delay(1_000)])
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL")
}

type DurableUpdateFailure = "missing-reexec" | "prepare-throws" | "reexec-throws" | "reexec-returns" | "rollback-throws"

async function exerciseDurableUpdateFailure(kind: DurableUpdateFailure): Promise<{
  first: DevBoot
  recovered: DevBoot | undefined
  rollbackCalls: number
  reexecCalls: number
  pointer: string
  observed: string
  status: SupervisorStatus
}> {
  const workspace = mkdtempSync(join(tmpdir(), `fray-durable-update-${kind}-`))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "child.mjs")
  const observedPath = join(stateDir, "observed")
  const oldDigest = "old-artifact"
  const newDigest = "new-artifact"
  const pointer = join(stateDir, "pointer")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(pointer, oldDigest)
  writeFileSync(childEntry, `
    import { writeFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    writeFileSync(process.env.OBSERVED, process.env.FRAY_STABLE_ARTIFACT)
    process.send?.({ type: "fray-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRAY_DEV_PORT), bootId: "artifact-" + process.env.FRAY_STABLE_ARTIFACT + "-" + process.pid })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  let supervisor: DevSupervisor | undefined
  let rollbackCalls = 0
  let reexecCalls = 0
  try {
    supervisor = await startDevSupervisor({
      port: await freeSupervisorPort(),
      cwd: workspace,
      stateDir,
      launchTarget: target,
      launchOwnerToken: owner.token,
      watch: false,
      childLaunchProvider: () => ({ entry: childEntry, environment: { FRAY_STABLE_ARTIFACT: readFileSync(pointer, "utf8"), OBSERVED: observedPath } }),
      updateRestart: async () => {
        writeFileSync(pointer, newDigest)
        return { state: "ready" }
      },
      rollbackUpdate: () => {
        rollbackCalls++
        if (kind === "rollback-throws") throw new Error("rollback fixture failed")
        writeFileSync(pointer, oldDigest)
      },
      ...(kind === "missing-reexec" ? {} : {
        durableReexec: async () => {
          reexecCalls++
          if (kind === "reexec-throws") throw new Error("reexec fixture failed")
        },
      }),
      log: () => {},
      error: () => {},
    })
    const first = await supervisor.firstBoot
    if (kind === "prepare-throws") {
      const internals = supervisor as unknown as { prepareDurableReexec: () => Promise<void> }
      const prepare = internals.prepareDurableReexec.bind(supervisor)
      internals.prepareDurableReexec = async () => {
        await prepare()
        throw new Error("prepare fixture failed")
      }
    }
    const response = await fetch(`http://127.0.0.1:${supervisor.port}/_fray/control/update-restart`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${supervisor.port}` },
    })
    assert.equal(response.status, 202)
    const status = await eventually(() => {
      const current = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return current?.state === "failed" ? current : undefined
    }, `${kind} durable update failure`)
    const recovered = kind === "missing-reexec" ? undefined : await nextBoot(supervisor, first.pid)
    return { first, recovered, rollbackCalls, reexecCalls, pointer: readFileSync(pointer, "utf8"), observed: readFileSync(observedPath, "utf8"), status }
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
}

test("Update & Restart rolls back a promoted pointer when durable re-exec is unavailable", { timeout: 15_000 }, async () => {
  const result = await exerciseDurableUpdateFailure("missing-reexec")
  assert.equal(result.rollbackCalls, 1)
  assert.equal(result.reexecCalls, 0)
  assert.equal(result.pointer, "old-artifact")
  assert.equal(result.observed, "old-artifact", "the healthy control plane remains available")
  assert.match(result.status.message, /requires a durable supervisor handoff/)
})

test("Update & Restart restores the lease-owning supervisor after prepare fails", { timeout: 15_000 }, async () => {
  const result = await exerciseDurableUpdateFailure("prepare-throws")
  assert.equal(result.rollbackCalls, 1)
  assert.equal(result.reexecCalls, 0)
  assert.notEqual(result.recovered?.pid, result.first.pid)
  assert.equal(result.pointer, "old-artifact")
  assert.equal(result.observed, "old-artifact")
  assert.match(result.status.message, /prepare fixture failed/)
})

test("Update & Restart rolls back and restores after durable re-exec throws or returns", { timeout: 25_000 }, async () => {
  for (const kind of ["reexec-throws", "reexec-returns"] as const) {
    const result = await exerciseDurableUpdateFailure(kind)
    assert.equal(result.rollbackCalls, 1, kind)
    assert.equal(result.reexecCalls, 1, kind)
    assert.notEqual(result.recovered?.pid, result.first.pid, kind)
    assert.equal(result.pointer, "old-artifact", kind)
    assert.equal(result.observed, "old-artifact", kind)
    assert.match(result.status.message, kind === "reexec-throws" ? /reexec fixture failed/ : /returned unexpectedly/)
  }
})

test("Update & Restart keeps its supervisor recoverable when rollback fails", { timeout: 15_000 }, async () => {
  const result = await exerciseDurableUpdateFailure("rollback-throws")
  assert.equal(result.rollbackCalls, 1)
  assert.equal(result.reexecCalls, 1)
  assert.notEqual(result.recovered?.pid, result.first.pid)
  assert.equal(result.pointer, "new-artifact", "a failed rollback never lies about the selected pointer")
  assert.equal(result.observed, "new-artifact", "the verified selected candidate restores the control plane")
  assert.match(result.status.message, /rollback failed: rollback fixture failed/)
})

test("Update & Restart hands the durable owner to a fresh supervisor without copying project state", { timeout: 20_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-durable-update-handoff-"))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "handoff-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  // This is deliberately real SQLite state, including a persisted provider session and a queued
  // Codex input. The handoff must leave it in place rather than export/import a lossy snapshot.
  const storage = createStorage(join(stateDir, "ui.db"))
  storage.upsertSession({
    slug: "kept", session_id: "fray-session", tmux_name: "fray-kept", spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: null, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
    backend: "codex", agent_session_id: "provider-rollout", codex_input_queue: '[{"text":"continue"}]',
  })
  storage.setAgentSession("kept", "provider-rollout")
  storage.close()
  writeFileSync(childEntry, `
    import { writeFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env); const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    writeFileSync(process.env.OBSERVED, process.env.GENERATION)
    process.send?.({ type: "fray-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRAY_DEV_PORT), bootId: process.env.GENERATION + "-" + process.pid })
    const stop = () => { delegate.release(); process.exit(0) }
    process.on("SIGTERM", stop); process.on("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const observed = join(stateDir, "child-generation")
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  let successor: DevSupervisor | undefined
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childEntry, childEnvironment: () => ({ OBSERVED: observed, GENERATION: "old-child" }),
      updateRestart: async () => ({ state: "ready" }),
      durableReexec: async () => {
        successor = await startDevSupervisor({
          port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
          childEntry, childEnvironment: () => ({ OBSERVED: observed, GENERATION: "new-child" }), log: () => {}, error: () => {},
        })
        await successor.firstBoot
      },
      log: () => {}, error: () => {},
    })
    const first = await supervisor.firstBoot
    assert.equal(readFileSync(observed, "utf8"), "old-child")
    const response = await fetch(`http://127.0.0.1:${port}/_fray/control/update-restart`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${port}` },
    })
    // The durable owner now acknowledges before its async build/re-exec can drain the request-owning
    // process. The browser follows /status rather than treating that accepted handoff as a failure.
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { protocol: 1, state: "restarting" })
    const next = await eventually(() => successor?.currentBoot() ?? undefined, "successor control-plane boot")
    assert.ok(next && next.pid !== first.pid, "the successor booted a new disposable control-plane child")
    assert.equal(readFileSync(observed, "utf8"), "new-child")
    const reopened = createStorage(join(stateDir, "ui.db"))
    const kept = reopened.getSession("kept")
    reopened.close()
    assert.deepEqual({ session: kept?.session_id, provider: kept?.agent_session_id, queue: kept?.codex_input_queue }, {
      session: "fray-session", provider: "provider-rollout", queue: '[{"text":"continue"}]',
    })
  } finally {
    await successor?.close()
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("authenticated restart takes one fresh artifact launch snapshot and fails closed when it cannot verify one", { timeout: 15_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-dev-supervisor-artifact-restart-"))
  const stateDir = join(workspace, ".state")
  const observed = join(stateDir, "child-artifact.json")
  mkdirSync(stateDir, { recursive: true })
  const artifactEntry = (digest: string) => join(workspace, `artifact-${digest}.mjs`)
  const writeArtifactEntry = (digest: string) => writeFileSync(artifactEntry(digest), `
    import { writeFileSync } from "node:fs"
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(73)
    const delegate = registerProjectLaunchDelegate(target, token)
    writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
      artifact: process.env.FRAY_STABLE_ARTIFACT,
      web: process.env.FRAY_STABLE_WEB_DIST,
      entry: import.meta.url,
    }))
    process.send?.({
      type: "fray-ready",
      pid: delegate.pid,
      processStart: delegate.processStart,
      port: Number(process.env.FRAY_DEV_PORT),
      bootId: \`artifact-\${process.pid}-\${Date.now()}\`,
    })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop)
    process.once("disconnect", stop)
    setInterval(() => {}, 1000)
  `)
  const firstDigest = "a".repeat(64)
  const secondDigest = "b".repeat(64)
  writeArtifactEntry(firstDigest)
  writeArtifactEntry(secondDigest)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  const port = await freeSupervisorPort()
  const pointer = join(stateDir, "promoted-digest")
  writeFileSync(pointer, firstDigest)
  let supervisor: DevSupervisor | undefined
  const artifactLaunch = () => {
    const promoted = readFileSync(pointer, "utf8")
    if (promoted === "broken") throw new Error("promoted artifact failed manifest verification")
    return {
      entry: artifactEntry(promoted),
      environment: {
        FRAY_STABLE_ARTIFACT: promoted,
        FRAY_STABLE_WEB_DIST: `/immutable/${promoted}/web`,
      },
    }
  }
  try {
    supervisor = await startDevSupervisor({
      port,
      cwd: workspace,
      stateDir,
      launchTarget,
      launchOwnerToken: owner.token,
      watch: false,
      childLaunchProvider: artifactLaunch,
      log: () => {},
      error: () => {},
    })
    const first = await supervisor.firstBoot
    const firstObserved = JSON.parse(readFileSync(observed, "utf8")) as Record<string, string>
    assert.deepEqual({ artifact: firstObserved.artifact, web: firstObserved.web }, {
      artifact: firstDigest,
      web: `/immutable/${firstDigest}/web`,
    })
    assert.match(firstObserved.entry, new RegExp(`artifact-${firstDigest}\\.mjs$`))

    writeFileSync(pointer, secondDigest) // equivalent to verified `fray-dev promote <digest>`
    const response = await fetch(`http://127.0.0.1:${port}/_fray/control/restart`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { protocol: 1, state: "ready" })
    const second = await nextBoot(supervisor, first.pid)
    assert.notEqual(second.bootId, first.bootId)
    const secondObserved = JSON.parse(readFileSync(observed, "utf8")) as Record<string, string>
    assert.deepEqual({ artifact: secondObserved.artifact, web: secondObserved.web }, {
      artifact: secondDigest,
      web: `/immutable/${secondDigest}/web`,
    })
    assert.match(secondObserved.entry, new RegExp(`artifact-${secondDigest}\\.mjs$`))
    assert.equal(readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))?.artifactDigest, secondDigest)

    writeFileSync(pointer, "broken")
    const failed = await fetch(`http://127.0.0.1:${port}/_fray/control/restart`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(failed.status, 503)
    assert.match((await failed.json() as { message: string }).message, /failed manifest verification/)
    const status = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
    assert.equal(status?.state, "failed")
    assert.equal(status?.artifactDigest, undefined, "a failed launch never claims the promoted digest is running")
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("private SDK runtime changes recycle only disposable children and recover without touching workers", { timeout: 25_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fray-dev-supervisor-e2e-"))
  const stateDir = join(workspace, ".state")
  const sdkDir = join(workspace, "packages", "claude-agent-sdk-runtime")
  const sdkSrc = join(sdkDir, "src")
  const sdkIndex = join(sdkSrc, "index.ts")
  const sdkExtra = join(sdkSrc, "extra.ts")
  const sdkPackage = join(sdkDir, "package.json")
  const childEntry = join(workspace, "fixture-control-plane.mjs")
  const workerIdentityPath = join(stateDir, "worker-session.json")
  const supervisorLock = join(stateDir, "dev-supervisor.lock")
  mkdirSync(sdkSrc, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(sdkIndex, "export const generation = 1\n")
  writeFileSync(sdkPackage, '{"name":"@fray-ui/claude-agent-sdk-runtime","private":true,"type":"module"}\n')
  writeFileSync(workerIdentityPath, '{"slug":"kept-worker","sessionId":"session-stable"}\n')
  writeFileSync(childEntry, `
    import { readFileSync } from "node:fs"
    import { join } from "node:path"
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const workspace = process.argv[2]
    let source = ""
    try { source = readFileSync(join(workspace, "packages", "claude-agent-sdk-runtime", "src", "index.ts"), "utf8") }
    catch { process.exit(71) }
    if (source.includes("FAIL_BOOT")) process.exit(72)
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(73)
    const delegate = registerProjectLaunchDelegate(target, token)
    process.send?.({
      type: "fray-ready",
      pid: delegate.pid,
      processStart: delegate.processStart,
      port: Number(process.env.FRAY_DEV_PORT),
      bootId: \`fixture-\${process.pid}-\${Date.now()}\`,
    })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    process.once("disconnect", stop)
    setInterval(() => {}, 1000)
  `)

  let notify: Parameters<NonNullable<DevSupervisorOptions["watchSubscribe"]>>[1] | undefined
  let watchOptions: Parameters<NonNullable<DevSupervisorOptions["watchSubscribe"]>>[2] | undefined
  let unsubscribed = false
  const reexecs: Parameters<NonNullable<DevSupervisorOptions["reexec"]>>[0][] = []
  const parentPid = process.pid
  let supervisor: DevSupervisor | undefined
  let launchOwner: ProjectLaunchLease | undefined
  let worker: ChildProcess | undefined

  const assertWorkerPreserved = () => {
    assert.equal(process.pid, parentPid, "runtime changes keep the stable supervisor process")
    assert.equal(reexecs.length, 0, "runtime changes never request launcher re-exec")
    assert.ok(worker?.pid && processIsAlive(worker.pid), "the independent worker process remains alive")
    assert.equal(readFileSync(workerIdentityPath, "utf8"), '{"slug":"kept-worker","sessionId":"session-stable"}\n')
  }
  const emit = (path: string, type: "create" | "update" | "delete") => {
    assert.ok(notify, "watch subscription is active")
    notify(null, [{ path, type }])
  }
  const recycle = async (boot: DevBoot, path: string, type: "create" | "update" | "delete") => {
    emit(path, type)
    const next = await nextBoot(supervisor!, boot.pid)
    assertWorkerPreserved()
    return next
  }

  try {
    worker = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)"], {
      stdio: "ignore",
    })
    await once(worker, "spawn")

    const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
    launchOwner = acquireProjectLaunchOwner(launchTarget, "supervisor")

    supervisor = await startDevSupervisor({
      port: 49_173,
      cwd: workspace,
      stateDir,
      launchTarget,
      launchOwnerToken: launchOwner.token,
      watchRoots: [workspace],
      debounceMs: 1,
      childEntry,
      childArgs: [workspace],
      watchSubscribe: async (_root, callback, options) => {
        notify = callback
        watchOptions = options
        return { unsubscribe: async () => { unsubscribed = true } }
      },
      reexec: (request) => { reexecs.push(request) },
      log: () => {},
      error: () => {},
    })
    let boot = await supervisor.firstBoot
    assertWorkerPreserved()
    assert.ok(watchOptions?.ignore?.includes("**/.cache/**"))
    assert.ok(watchOptions?.ignore?.includes("**/.parcel-cache/**"))
    assert.ok(watchOptions?.ignore?.includes("**/node_modules/**"))

    // Runtime edit/add/delete events all recycle only the disposable child.
    writeFileSync(sdkIndex, "export const generation = 2\n")
    boot = await recycle(boot, sdkIndex, "update")
    writeFileSync(sdkExtra, "export const extra = true\n")
    boot = await recycle(boot, sdkExtra, "create")
    unlinkSync(sdkExtra)
    boot = await recycle(boot, sdkExtra, "delete")

    // The private membrane's package metadata belongs to the child graph, not the stable launcher.
    writeFileSync(sdkPackage, '{"name":"@fray-ui/claude-agent-sdk-runtime","private":true,"type":"module","version":"0.0.2"}\n')
    boot = await recycle(boot, sdkPackage, "update")

    // A deleted/invalid config is rejected before the healthy generation is stopped. Re-creation is
    // the corrective event and validates through a fresh child generation.
    unlinkSync(sdkPackage)
    emit(sdkPackage, "delete")
    await eventually(() => {
      const status = readSupervisorStatus(supervisorLock)
      return status?.state === "failed" && /package\.json/.test(status.message) ? status : undefined
    }, "deleted package metadata to enter failed state")
    assert.equal(supervisor.currentBoot()?.pid, boot.pid)
    assertWorkerPreserved()
    writeFileSync(sdkPackage, '{"name":"@fray-ui/claude-agent-sdk-runtime","private":true,"type":"module"}\n')
    boot = await recycle(boot, sdkPackage, "create")

    // A child that cannot reach ready leaves the stable watcher alive in a precise failed state; the
    // next source edit is a fresh corrective generation.
    writeFileSync(sdkIndex, "FAIL_BOOT\n")
    emit(sdkIndex, "update")
    await eventually(() => {
      const status = readSupervisorStatus(supervisorLock)
      return status?.state === "failed" && /before ready/.test(status.message) && supervisor?.currentBoot() === null
        ? status
        : undefined
    }, "failed child generation")
    assertWorkerPreserved()
    writeFileSync(sdkIndex, "export const generation = 3\n")
    emit(sdkIndex, "update")
    boot = await eventually(() => supervisor?.currentBoot() ?? undefined, "recovered child generation")
    assertWorkerPreserved()

    // Watch failures are degraded, not fatal. A later valid event clears the state via a normal child
    // recycle without replacing the parent or disturbing independent workers.
    notify?.(new Error("fixture watch stream interrupted"), [])
    await eventually(() => {
      const status = readSupervisorStatus(supervisorLock)
      return status?.state === "degraded" && /watch stream interrupted/.test(status.message) ? status : undefined
    }, "degraded watcher status")
    assert.equal(supervisor.currentBoot()?.pid, boot.pid)
    assertWorkerPreserved()
    writeFileSync(sdkIndex, "export const generation = 4\n")
    boot = await recycle(boot, sdkIndex, "update")
    await eventually(() => readSupervisorStatus(supervisorLock)?.state === "ready" ? true : undefined, "ready status after watcher recovery")
    assertWorkerPreserved()
  } finally {
    await supervisor?.close()
    launchOwner?.release()
    await stopFixtureWorker(worker)
    assert.equal(supervisor ? unsubscribed : true, true)
    rmSync(workspace, { recursive: true, force: true })
  }
})
