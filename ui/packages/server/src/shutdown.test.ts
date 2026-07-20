import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import { createShutdownSignalHandler } from "./index.ts"
import { createRetryableCleanup, createShutdownBarrier, ShutdownPhaseTimeoutError, ShutdownTimeoutError } from "./shutdown.ts"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("shutdown starts every producer cancellation, drains once, and closes storage exactly once", async () => {
  const gate = deferred()
  const order: string[] = []
  let storageCloses = 0
  const barrier = createShutdownBarrier({
    timeoutMs: 1_000,
    phases: [
      { name: "scheduler", run: async () => { order.push("scheduler:start"); await gate.promise; order.push("scheduler:done") } },
      { name: "board", run: () => { order.push("board:start") } },
      { name: "socket", run: () => { order.push("socket:start") } },
    ],
    closeStorage: () => { storageCloses++; order.push("storage") },
  })

  const first = barrier.close()
  const second = barrier.close()
  assert.equal(first, second, "repeated close/signal paths share one authoritative promise")
  assert.equal(barrier.closing, true)
  assert.deepEqual(order, ["scheduler:start", "board:start", "socket:start"], "a hanging drain cannot delay other cancellation starts")
  assert.equal(storageCloses, 0)
  gate.resolve()
  await first
  assert.deepEqual(order, ["scheduler:start", "board:start", "socket:start", "scheduler:done", "storage"])
  assert.equal(storageCloses, 1)
  await barrier.close()
  assert.equal(storageCloses, 1)
})

test("shutdown timeout is bounded, diagnosed, and never closes storage under live work", async () => {
  const gate = deferred()
  const diagnostics: string[] = []
  let storageCloses = 0
  const timeout = new ShutdownTimeoutError(25)
  const barrier = createShutdownBarrier({
    timeoutMs: 25,
    phases: [{ name: "stuck scheduler", run: () => gate.promise }],
    closeStorage: () => { storageCloses++ },
    diagnostic: (event) => diagnostics.push(`${event.phase}:${event.message}`),
    deadline: async () => { throw timeout },
  })

  await assert.rejects(barrier.close(), (error) => error === timeout)
  assert.equal(storageCloses, 0, "unsafe close is skipped; the process force deadline owns final exit")
  assert.ok(diagnostics.some((line) => /drain:server shutdown did not quiesce/.test(line)))
  gate.reject(new Error("late producer rejection"))
  await nextTurn() // allSettled attached before the deadline observes the late rejection
})

test("storage-independent cleanup may time out only after required producers release storage", async () => {
  const optionalGate = deferred()
  const storageClosed = deferred()
  let storageCloses = 0
  const timeout = new ShutdownTimeoutError(25)
  const barrier = createShutdownBarrier({
    timeoutMs: 25,
    phases: [
      { name: "board", run: () => {} },
      { name: "diagnostic flush", requiredForStorage: false, run: () => optionalGate.promise },
    ],
    closeStorage: () => {
      storageCloses++
      storageClosed.resolve()
    },
    deadline: async () => {
      await storageClosed.promise
      throw timeout
    },
  })

  await assert.rejects(barrier.close(), (error) => error === timeout)
  assert.equal(storageCloses, 1, "an unrelated optional hang cannot keep quiescent SQLite open")
  optionalGate.resolve()
  await nextTurn()
})

test("a storage-independent live resource can close storage yet still block ownership completion", async () => {
  let storageCloses = 0
  const barrier = createShutdownBarrier({
    timeoutMs: 1_000,
    phases: [{
      name: "Vite",
      requiredForStorage: false,
      requiredForCompletion: true,
      run: () => { throw new Error("Vite watcher stayed live") },
    }],
    closeStorage: () => { storageCloses++ },
  })
  await assert.rejects(barrier.close(), /required resources live/u)
  assert.equal(storageCloses, 1, "independent failure does not keep quiescent storage open")
  await assert.rejects(barrier.whenDrained(), /required resources live/u)
})

test("a wedged phase is bounded and NAMED, blocks storage, and its late rejection is observed", async () => {
  const gate = deferred()
  const diagnostics: string[] = []
  let storageCloses = 0
  const barrier = createShutdownBarrier({
    timeoutMs: 1_000, // whole-barrier deadline is generous; the per-phase bound must fire first
    phaseTimeoutMs: 20,
    phases: [{ name: "wake scheduler", run: () => gate.promise }],
    closeStorage: () => { storageCloses++ },
    diagnostic: (event) => diagnostics.push(`${event.phase}:${event.message}`),
  })

  await assert.rejects(barrier.close(), (error) => {
    assert.ok(error instanceof AggregateError, "a wedged required phase surfaces as an AggregateError")
    assert.match(error.message, /wake scheduler/, "the AggregateError names the wedged phase")
    assert.ok(
      error.errors.some((e) => e instanceof ShutdownPhaseTimeoutError && e.phase === "wake scheduler" && e.timeoutMs === 20),
      "the cause is a named ShutdownPhaseTimeoutError",
    )
    return true
  })
  assert.equal(storageCloses, 0, "a wedged required producer never closes storage")
  assert.ok(diagnostics.some((line) => /^wake scheduler:wake scheduler failed during shutdown/.test(line)))
  // The producer settles long after we abandoned it: the attached observer must swallow it so it can
  // never surface as an unhandled rejection.
  gate.reject(new Error("late wedged producer rejection"))
  await nextTurn()
})

test("a per-phase timeoutMs overrides the barrier default and a quick sibling is untouched", async () => {
  const slow = deferred()
  let storageCloses = 0
  const barrier = createShutdownBarrier({
    timeoutMs: 1_000,
    phaseTimeoutMs: 1_000, // the impatient phase opts into a much tighter bound than this default
    phases: [
      { name: "quick", run: () => {} },
      { name: "impatient", timeoutMs: 20, run: () => slow.promise },
    ],
    closeStorage: () => { storageCloses++ },
  })
  await assert.rejects(barrier.close(), (error) => error instanceof AggregateError && /impatient/.test(error.message))
  assert.equal(storageCloses, 0)
  slow.reject(new Error("late"))
  await nextTurn()
})

test("a phase that settles within its bound closes storage normally, clearing the phase timer", async () => {
  const gate = deferred()
  let storageCloses = 0
  const barrier = createShutdownBarrier({
    timeoutMs: 1_000,
    phaseTimeoutMs: 500,
    phases: [{ name: "board", run: () => gate.promise }],
    closeStorage: () => { storageCloses++ },
  })
  const closing = barrier.close()
  gate.resolve() // settles well under the 500ms bound — no false abandonment
  await closing
  assert.equal(storageCloses, 1)
})

test("retryable cleanup shares in-flight work, retries failure, and never repeats success", async () => {
  const gate = deferred()
  let calls = 0
  let fail = true
  const cleanup = createRetryableCleanup(async () => {
    calls++
    await gate.promise
    if (fail) throw new Error("first cleanup failed")
  })
  const first = cleanup()
  assert.equal(cleanup(), first)
  gate.resolve()
  await assert.rejects(first, /first cleanup failed/u)
  fail = false
  await cleanup()
  await cleanup()
  assert.equal(calls, 2)
})

test("the production shutdown deadline rejects a hung producer without an injected clock", async () => {
  const gate = deferred()
  let storageCloses = 0
  const startedAt = Date.now()
  const barrier = createShutdownBarrier({
    timeoutMs: 20,
    phases: [{ name: "hung request", run: () => gate.promise }],
    closeStorage: () => { storageCloses++ },
  })

  await assert.rejects(barrier.close(), ShutdownTimeoutError)
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 10 && elapsed < 1_000, `deadline settled outside its bounded window: ${elapsed}ms`)
  assert.equal(storageCloses, 0)
  gate.resolve()
  await nextTurn()
})

test("required producer failure drains siblings but blocks storage; optional cleanup failure does not", async () => {
  const events: string[] = []
  const diagnostics: string[] = []
  let storageCloses = 0
  const failed = createShutdownBarrier({
    timeoutMs: 1_000,
    phases: [
      { name: "scheduler", run: () => { events.push("scheduler"); throw new Error("resume drain failed") } },
      { name: "socket", run: () => { events.push("socket") } },
    ],
    closeStorage: () => { storageCloses++ },
    diagnostic: (event) => diagnostics.push(event.phase),
  })
  await assert.rejects(failed.close(), AggregateError)
  assert.deepEqual(events, ["scheduler", "socket"])
  assert.deepEqual(diagnostics, ["scheduler"])
  assert.equal(storageCloses, 0)

  const optional = createShutdownBarrier({
    timeoutMs: 1_000,
    phases: [{ name: "diagnostic flush", requiredForStorage: false, run: () => { throw new Error("log unavailable") } }],
    closeStorage: () => { storageCloses++ },
  })
  await optional.close()
  assert.equal(storageCloses, 1)
})

test("SIGINT/SIGTERM share one cleanup attempt and one exit decision", async () => {
  const closing = deferred()
  let closeCalls = 0
  const exits: number[] = []
  const handler = createShutdownSignalHandler({
    close: () => { closeCalls++; return closing.promise },
    exit: (code) => exits.push(code),
    forceAfterMs: 60_000,
  })
  handler()
  handler()
  assert.equal(closeCalls, 1)
  closing.resolve()
  await nextTurn()
  assert.deepEqual(exits, [0])
})

test("the signal force deadline emits a diagnostic and cannot race a second exit decision", async () => {
  const closing = deferred()
  const exits: number[] = []
  const errors: string[] = []
  let force!: () => void
  const handler = createShutdownSignalHandler({
    close: () => closing.promise,
    exit: (code) => exits.push(code),
    error: (line) => errors.push(line),
    forceAfterMs: 25,
    scheduleForce: (callback) => {
      force = callback
      return setTimeout(() => {}, 60_000)
    },
  })

  handler()
  force()
  closing.resolve()
  await nextTurn()
  assert.deepEqual(exits, [1])
  assert.match(errors[0] ?? "", /force deadline exceeded after 25ms/)
})
