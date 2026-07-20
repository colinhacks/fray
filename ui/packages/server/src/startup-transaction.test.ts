import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { test, type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { ContextStartupError, type AppContext } from "./context.ts"
import {
  ServerStartupError,
  startServer,
  type ServerStartupPhase,
  type StartServerRuntime,
} from "./index.ts"
import {
  readProjectLaunchOwner,
  removeProjectStatus,
  type ProjectLaunchTarget,
} from "./project-launch.ts"
import type { Project } from "./project.ts"
import { ShutdownTimeoutError } from "./shutdown.ts"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FixtureControls {
  failAfter?: ServerStartupPhase
  viteStartupError?: Error
  schedulerStopGate?: Promise<void>
  schedulerStopFailures?: number
  viteCloseFailures?: number
  statusRemoveFailures?: number
  shutdownDeadline?: StartServerRuntime["shutdownDeadline"]
}

interface ContextState {
  storageClosed: number
  subscriptionsStopped: number
  boardStarted: number
  boardStopped: number
  tailerStarted: number
  tailerStopped: number
  permissionStarted: number
  permissionStopped: number
  schedulerStarted: number
  schedulerStopped: number
}

class FakeHttpServer extends EventEmitter {
  listening = false
  keepAliveTimeout = 0
  headersTimeout = 0
  closeCalls = 0
  closeAllCalls = 0

  listen(_port: number, _host: string, callback: () => void) {
    this.listening = true
    queueMicrotask(callback)
    return this
  }

  close(callback?: (error?: Error) => void) {
    this.closeCalls++
    this.listening = false
    queueMicrotask(() => callback?.())
    return this
  }

  closeAllConnections() {
    this.closeAllCalls++
  }
}

function fixture(t: TestContext, controls: FixtureControls = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fray-startup-transaction-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project: Project = {
    id: randomUUID(),
    dir,
    stateDir: join(dir, "state"),
    name: "transaction-fixture",
    label: "transaction-fixture",
    cwdSlug: "-transaction-fixture",
  }
  const target: ProjectLaunchTarget = {
    projectId: project.id,
    projectDir: project.dir,
    stateDir: project.stateDir,
  }
  const contexts: ContextState[] = []
  const httpServers: FakeHttpServer[] = []
  const closeCounts = { terminal: 0, appSocket: 0, vite: 0 }

  const runtime: Partial<StartServerRuntime> = {
    createContext() {
      const state: ContextState = {
        storageClosed: 0,
        subscriptionsStopped: 0,
        boardStarted: 0,
        boardStopped: 0,
        tailerStarted: 0,
        tailerStopped: 0,
        permissionStarted: 0,
        permissionStopped: 0,
        schedulerStarted: 0,
        schedulerStopped: 0,
      }
      contexts.push(state)
      let storageClosed = false
      let subscriptionsStopped = false
      let boardStopped: Promise<void> | undefined
      let tailerStopped = false
      let permissionStopped = false
      const ctx = {
        bootId: randomUUID(),
        project,
        bus: {},
        transcriptChange: {},
        storage: {
          getSession: () => undefined,
          close() {
            if (storageClosed) return
            storageClosed = true
            state.storageClosed++
          },
        },
        board: {
          snapshot: async () => ({}),
          currentSeq: () => 0,
          rebuild: async () => ({}),
          refresh: () => ({}),
          async start() { state.boardStarted++ },
          stop() {
            if (!boardStopped) {
              state.boardStopped++
              boardStopped = Promise.resolve()
            }
            return boardStopped
          },
        },
        tailer: {
          start() { state.tailerStarted++ },
          stop() {
            if (tailerStopped) return
            tailerStopped = true
            state.tailerStopped++
          },
        },
        permissionController: {
          start() { state.permissionStarted++ },
          stop() {
            if (permissionStopped) return
            permissionStopped = true
            state.permissionStopped++
          },
        },
        scheduler: {
          start() { state.schedulerStarted++ },
          async stop() {
            state.schedulerStopped++
            if ((controls.schedulerStopFailures ?? 0) > 0) {
              controls.schedulerStopFailures!--
              throw new Error("injected scheduler cleanup failure")
            }
            await controls.schedulerStopGate
          },
        },
        stopSubscriptions() {
          if (subscriptionsStopped) return
          subscriptionsStopped = true
          state.subscriptionsStopped++
        },
        backendFor: () => ({}),
      }
      return ctx as unknown as AppContext
    },
    initGithub: async () => {},
    createApp: (() => ({ fetch: async () => new Response() })) as unknown as StartServerRuntime["createApp"],
    createTerminal: (() => {
      let closed: Promise<void> | undefined
      return {
        handleUpgrade: () => false,
        close() {
          if (!closed) {
            closeCounts.terminal++
            closed = Promise.resolve()
          }
          return closed
        },
      }
    }) as StartServerRuntime["createTerminal"],
    createAppSocket: (() => {
      let closed: Promise<void> | undefined
      return {
        handleUpgrade: () => false,
        close() {
          if (!closed) {
            closeCounts.appSocket++
            closed = Promise.resolve()
          }
          return closed
        },
      }
    }) as unknown as StartServerRuntime["createAppSocket"],
    createVite: (async () => {
      if (controls.viteStartupError) throw controls.viteStartupError
      let closed = false
      return {
        middlewares: (_req: IncomingMessage, _res: ServerResponse, next: () => void) => next(),
        transformIndexHtml: async (_url: string, html: string) => html,
        async close() {
          if (closed) return
          if ((controls.viteCloseFailures ?? 0) > 0) {
            controls.viteCloseFailures!--
            throw new Error("injected Vite cleanup failure")
          }
          closed = true
          closeCounts.vite++
        },
      }
    }) as unknown as StartServerRuntime["createVite"],
    createHttpServer: ((_listener: (req: IncomingMessage, res: ServerResponse) => void) => {
      const server = new FakeHttpServer()
      httpServers.push(server)
      return server
    }) as unknown as StartServerRuntime["createHttpServer"],
    removeStatus(path, expected) {
      if ((controls.statusRemoveFailures ?? 0) > 0) {
        controls.statusRemoveFailures!--
        throw new Error("injected status removal failure")
      }
      return removeProjectStatus(path, expected)
    },
    afterPhase(phase) {
      if (phase === controls.failAfter) throw new Error(`injected failure after ${phase}`)
    },
    shutdownDeadline: controls.shutdownDeadline,
  }

  const assertClean = () => {
    assert.equal(readProjectLaunchOwner(project.stateDir), null, "launch ownership is released")
    assert.equal(existsSync(join(project.stateDir, "server.lock")), false, "exact status is retired")
    assert.equal(existsSync(join(project.stateDir, "ui.db")), false, "the fake fixture never creates SQLite")
    for (const state of contexts) {
      assert.equal(state.storageClosed, 1, "created storage closes exactly once")
      assert.equal(state.subscriptionsStopped, 1, "created subscriptions stop exactly once")
      assert.equal(state.boardStopped, 1, "created board/watcher stops exactly once")
      assert.equal(state.tailerStopped, 1, "created tailer stops exactly once")
      assert.equal(state.permissionStopped, 1, "created permission timer stops exactly once")
      assert.ok(state.schedulerStopped >= 1, "created scheduler receives a stop")
    }
    for (const server of httpServers) assert.equal(server.listening, false, "no fake listener remains live")
  }

  return { controls, project, target, runtime, contexts, httpServers, closeCounts, assertClean }
}

const allPhases: ServerStartupPhase[] = [
  "launch ownership",
  "context",
  "GitHub initialization",
  "application",
  "terminal transport",
  "application socket",
  "board producer",
  "tailer producer",
  "permission producer",
  "profile producer",
  "wake scheduler",
  "Vite",
  "HTTP server",
  "HTTP listen",
  "status publication",
  "signal handlers",
]

for (const failurePhase of allPhases) {
  test(`startServer transaction unwinds a failure after ${failurePhase}`, async (t) => {
    const h = fixture(t, { failAfter: failurePhase })
    await assert.rejects(
      startServer({
        project: h.project,
        port: 49_999,
        dev: true,
        requireDevWeb: true,
        installSignalHandlers: false,
        runtime: h.runtime,
      }),
      (error) => error instanceof ServerStartupError
        && error.phase === failurePhase
        && error.cleanupError === undefined
        && error.fence.ownershipRetained === false,
    )
    h.assertClean()
  })
}

test("Vite construction failure drains every earlier resource before releasing ownership", async (t) => {
  const h = fixture(t, { viteStartupError: new Error("injected Vite startup failure") })
  await assert.rejects(startServer({
    project: h.project,
    port: 49_999,
    dev: true,
    requireDevWeb: true,
    installSignalHandlers: false,
    runtime: h.runtime,
  }), (error) => error instanceof ServerStartupError && error.phase === "Vite")
  assert.equal(h.httpServers.length, 0)
  h.assertClean()
})

test("an in-flight producer keeps status, storage, and ownership fenced until it drains", async (t) => {
  const gate = deferred()
  const h = fixture(t, { failAfter: "status publication", schedulerStopGate: gate.promise })
  const starting = startServer({
    project: h.project,
    port: 49_999,
    dev: true,
    requireDevWeb: true,
    installSignalHandlers: false,
    runtime: h.runtime,
  })
  while ((h.contexts[0]?.schedulerStopped ?? 0) === 0) await nextTurn()
  assert.ok(readProjectLaunchOwner(h.project.stateDir), "owner remains while producer work is live")
  assert.equal(existsSync(join(h.project.stateDir, "server.lock")), true)
  assert.equal(h.contexts[0].storageClosed, 0)
  assert.equal(h.httpServers[0].listening, false, "new HTTP work is gated immediately")
  gate.resolve()
  await assert.rejects(starting, ServerStartupError)
  h.assertClean()
})

test("cleanup failure retains a recoverable owner/status fence and a retry releases it last", async (t) => {
  const h = fixture(t, { failAfter: "status publication", schedulerStopFailures: 1 })
  let startupError: ServerStartupError | undefined
  try {
    await startServer({
      project: h.project,
      port: 49_999,
      dev: true,
      requireDevWeb: true,
      installSignalHandlers: false,
      runtime: h.runtime,
    })
  } catch (error) {
    assert.ok(error instanceof ServerStartupError)
    startupError = error
  }
  assert.ok(startupError?.cleanupError instanceof AggregateError)
  assert.equal(startupError?.fence.ownershipRetained, true)
  assert.ok(readProjectLaunchOwner(h.project.stateDir))
  assert.equal(existsSync(join(h.project.stateDir, "server.lock")), true)
  assert.equal(h.contexts[0].storageClosed, 0, "unsafe cleanup failure keeps storage open and fenced")

  await startupError!.fence.recover()
  assert.equal(startupError!.fence.ownershipRetained, false)
  h.assertClean()
})

test("cleanup timeout throws promptly but the raw drain automatically releases the fence when safe", async (t) => {
  const gate = deferred()
  const timeout = new ShutdownTimeoutError(25)
  const h = fixture(t, {
    failAfter: "status publication",
    schedulerStopGate: gate.promise,
    shutdownDeadline: async () => { throw timeout },
  })
  let startupError: ServerStartupError | undefined
  try {
    await startServer({
      project: h.project,
      port: 49_999,
      dev: true,
      requireDevWeb: true,
      installSignalHandlers: false,
      runtime: h.runtime,
    })
  } catch (error) {
    assert.ok(error instanceof ServerStartupError)
    startupError = error
  }
  assert.equal(startupError?.cleanupError, timeout)
  assert.equal(startupError?.fence.ownershipRetained, true)
  assert.ok(readProjectLaunchOwner(h.project.stateDir))
  gate.resolve()
  await startupError!.fence.whenSafe()
  h.assertClean()
})

test("a partial-context cleanup fence composes with server rollback before ownership can release", async (t) => {
  const gate = deferred()
  const h = fixture(t)
  const contextStartup = new Error("injected failure after context subscriptions")
  const contextCleanup = new ShutdownTimeoutError(25)
  h.runtime.createContext = async () => {
    throw new ContextStartupError({
      startupError: contextStartup,
      cleanupError: contextCleanup,
      diagnostics: [{ phase: "context subscriptions", message: "partial context is still draining" }],
      fence: {
        whenSafe: () => gate.promise,
        recover: () => gate.promise,
      },
    })
  }
  let startupError: ServerStartupError | undefined
  try {
    await startServer({
      project: h.project,
      port: 49_999,
      installSignalHandlers: false,
      runtime: h.runtime,
    })
  } catch (error) {
    assert.ok(error instanceof ServerStartupError)
    startupError = error
  }
  assert.equal(startupError?.phase, "context")
  assert.equal(startupError?.startupError, contextStartup)
  assert.equal(startupError?.cleanupError, contextCleanup)
  assert.equal(startupError?.fence.ownershipRetained, true)
  assert.ok(readProjectLaunchOwner(h.project.stateDir))
  gate.resolve()
  await startupError!.fence.whenSafe()
  h.assertClean()
})

test("Vite/status cleanup failures retain ownership and explicit recovery retries idempotently", async (t) => {
  const h = fixture(t, {
    failAfter: "status publication",
    viteCloseFailures: 1,
    statusRemoveFailures: 1,
  })
  let startupError: ServerStartupError | undefined
  try {
    await startServer({
      project: h.project,
      port: 49_999,
      dev: true,
      requireDevWeb: true,
      installSignalHandlers: false,
      runtime: h.runtime,
    })
  } catch (error) {
    assert.ok(error instanceof ServerStartupError)
    startupError = error
  }
  assert.ok(startupError?.cleanupError)
  assert.ok(readProjectLaunchOwner(h.project.stateDir))
  assert.equal(existsSync(join(h.project.stateDir, "server.lock")), true)
  await assert.rejects(startupError!.fence.recover(), /status removal failure/u)
  assert.equal(startupError!.fence.ownershipRetained, true)
  await startupError!.fence.recover()
  h.assertClean()
})

test("exported in-process catch-and-retry leaves no prior resource or ownership behind", async (t) => {
  const controls: FixtureControls = { failAfter: "status publication" }
  const h = fixture(t, controls)
  await assert.rejects(startServer({
    project: h.project,
    port: 49_999,
    dev: true,
    requireDevWeb: true,
    installSignalHandlers: false,
    runtime: h.runtime,
  }), ServerStartupError)
  h.assertClean()

  controls.failAfter = undefined
  const server = await startServer({
    project: h.project,
    port: 49_999,
    dev: true,
    requireDevWeb: true,
    installSignalHandlers: false,
    runtime: h.runtime,
  })
  const first = server.close()
  assert.equal(server.close(), first, "repeated close shares one authoritative promise")
  await first
  assert.equal(server.shutdownFence.ownershipRetained, false)
  assert.equal(h.contexts.length, 2)
  h.assertClean()
})
