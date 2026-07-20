export class ProducerStoppedError extends Error {
  constructor(producer: string) {
    super(`${producer} is shutting down`)
    this.name = "ProducerStoppedError"
  }
}

export class ShutdownTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`server shutdown did not quiesce within ${timeoutMs}ms`)
    this.name = "ShutdownTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

/** Default upper bound on any single shutdown phase's drain. See ShutdownPhase.timeoutMs. */
export const DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS = 6_000

/**
 * A single producer's cleanup exceeded its own drain bound. Unlike ShutdownTimeoutError (the whole
 * barrier's public deadline, which names nothing), this names the exact wedged phase so the operator
 * sees which producer refused to quiesce — and it settles that phase's slot so the authoritative
 * drain completes promptly instead of stalling until the process is hard-killed.
 */
export class ShutdownPhaseTimeoutError extends Error {
  readonly phase: string
  readonly timeoutMs: number

  constructor(phase: string, timeoutMs: number) {
    super(`shutdown phase "${phase}" did not settle within ${timeoutMs}ms`)
    this.name = "ShutdownPhaseTimeoutError"
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export interface ShutdownPhase {
  name: string
  run: () => void | Promise<void>
  /**
   * Upper bound on THIS phase's own drain. A producer that never settles (a wedged tmux/git/gh call,
   * a hung watcher) would otherwise stall the whole barrier until the process is hard-killed. When set
   * — or when the barrier supplies phaseTimeoutMs — an over-running phase is abandoned and surfaced as
   * a NAMED ShutdownPhaseTimeoutError through the same required/optional failure paths (a storage
   * producer's timeout still blocks storage close; a storage-independent one does not). Defaults to
   * the barrier's phaseTimeoutMs; omit both to leave the phase unbounded.
   */
  timeoutMs?: number
  /** A failed optional phase is diagnosed but does not make closing shared storage unsafe. */
  requiredForStorage?: boolean
  /**
   * A storage-independent resource may still have to close before launch ownership is released.
   * Defaults to false for storage-independent phases and true for storage-dependent phases.
   */
  requiredForCompletion?: boolean
}

export interface ShutdownDiagnostic {
  phase: string
  message: string
  error?: unknown
}

export interface ShutdownBarrierOptions {
  phases: ShutdownPhase[]
  closeStorage: () => void | Promise<void>
  timeoutMs: number
  /**
   * Default per-phase drain bound applied to every phase without its own timeoutMs (see
   * ShutdownPhase.timeoutMs). Omit to leave phases unbounded — the whole-barrier timeoutMs is then the
   * only deadline, and a single wedged producer stalls the authoritative drain indefinitely.
   */
  phaseTimeoutMs?: number
  diagnostic?: (event: ShutdownDiagnostic) => void
  /** Deterministic test seam. Production uses the bounded timer below. */
  deadline?: (drained: Promise<void>, timeoutMs: number) => Promise<void>
}

export interface ShutdownBarrier {
  readonly closing: boolean
  close(): Promise<void>
  /** The unbounded authoritative drain, used to retain ownership after the public deadline expires. */
  whenDrained(): Promise<void>
}

/**
 * Makes one resource cleanup safe to share across deadline, retry, and repeated-close paths. A
 * successful cleanup is never run twice; a failed attempt may be retried, and concurrent callers
 * share the same in-flight promise.
 */
export function createRetryableCleanup(run: () => void | Promise<void>): () => Promise<void> {
  let complete = false
  let inFlight: Promise<void> | null = null
  return () => {
    if (complete) return Promise.resolve()
    if (inFlight) return inFlight
    let result: void | Promise<void>
    try {
      result = run()
    } catch (error) {
      return Promise.reject(error)
    }
    const attempt = Promise.resolve(result).then(() => { complete = true })
    inFlight = attempt
    void attempt.finally(() => {
      if (inFlight === attempt) inFlight = null
    }).catch(() => undefined)
    return attempt
  }
}

/**
 * Races one phase's drain against its own bound. On expiry the returned promise rejects with a NAMED
 * ShutdownPhaseTimeoutError, settling this phase's slot so the barrier's required/optional accounting
 * proceeds; the original promise's later settle is still observed (via the attached handler) so a late
 * producer rejection can never surface as an unhandled rejection. Unbounded when no positive bound.
 */
function withPhaseTimeout(name: string, promise: Promise<void>, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (apply: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      apply()
    }
    const timer = setTimeout(() => settle(() => reject(new ShutdownPhaseTimeoutError(name, timeoutMs))), timeoutMs)
    timer.unref?.()
    promise.then(
      () => settle(resolve),
      (error) => settle(() => reject(error)),
    )
  })
}

function defaultDeadline(drained: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ShutdownTimeoutError(timeoutMs)), timeoutMs)
    void drained.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Starts every cancellation/close phase synchronously, then drains them behind one deadline. Starting
 * all phases before awaiting any one phase prevents a wedged producer from delaying socket aborts or
 * timer cancellation. Shared storage closes exactly once, and only after every storage-dependent
 * producer has proved quiescent. Optional, storage-independent cleanup continues behind the same
 * deadline; it may time out after storage is already safely closed.
 */
export function createShutdownBarrier(options: ShutdownBarrierOptions): ShutdownBarrier {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("shutdown timeout must be positive")
  const deadline = options.deadline ?? defaultDeadline
  let closePromise: Promise<void> | null = null
  let drainPromise: Promise<void> | null = null
  let closing = false

  const beginDrain = (): Promise<void> => {
    if (drainPromise) return drainPromise
    closing = true
    drainPromise = (async () => {
      const started = options.phases.map((phase) => {
        const phaseTimeoutMs = phase.timeoutMs ?? options.phaseTimeoutMs
        try {
          return { phase, promise: withPhaseTimeout(phase.name, Promise.resolve(phase.run()), phaseTimeoutMs) }
        } catch (error) {
          return { phase, promise: Promise.reject(error) }
        }
      })
      const required = started.filter(({ phase }) => phase.requiredForStorage !== false)
      const optional = started.filter(({ phase }) => phase.requiredForStorage === false)
      // Construct allSettled for both groups immediately so a deadline or required failure can never
      // leave a later optional rejection unobserved.
      const requiredObserved = Promise.allSettled(required.map(({ promise }) => promise)).then((results) => {
        const failures: { name: string; error: unknown }[] = []
        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          if (result.status === "fulfilled") continue
          const phase = required[i].phase
          options.diagnostic?.({ phase: phase.name, message: `${phase.name} failed during shutdown`, error: result.reason })
          failures.push({ name: phase.name, error: result.reason })
        }
        return failures
      })
      const optionalObserved = Promise.allSettled(optional.map(({ promise }) => promise)).then((results) => {
        const completionFailures: { name: string; error: unknown }[] = []
        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          if (result.status === "fulfilled") continue
          const phase = optional[i].phase
          options.diagnostic?.({ phase: phase.name, message: `${phase.name} failed during shutdown`, error: result.reason })
          if (phase.requiredForCompletion === true) {
            completionFailures.push({ name: phase.name, error: result.reason })
          }
        }
        return completionFailures
      })
      const drained = (async () => {
        const requiredFailures = await requiredObserved
        if (requiredFailures.length > 0) {
          throw new AggregateError(
            requiredFailures.map((failure) => failure.error),
            `server shutdown could not safely close storage: ${requiredFailures.map((failure) => failure.name).join(", ")}`,
          )
        }

        try {
          await options.closeStorage()
        } catch (error) {
          options.diagnostic?.({ phase: "storage", message: "storage close failed", error })
          throw error
        }
        const completionFailures = await optionalObserved
        if (completionFailures.length > 0) {
          throw new AggregateError(
            completionFailures.map((failure) => failure.error),
            `server shutdown left required resources live: ${completionFailures.map((failure) => failure.name).join(", ")}`,
          )
        }
      })()
      await drained
    })()
    // A public deadline may stop awaiting before a late producer failure settles. Keep an explicit
    // observer attached while exposing the same promise through whenDrained() for ownership fencing.
    void drainPromise.catch(() => undefined)
    return drainPromise
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = deadline(beginDrain(), options.timeoutMs).catch((error) => {
      if (error instanceof ShutdownTimeoutError) {
        options.diagnostic?.({ phase: "drain", message: error.message, error })
      }
      throw error
    })
    return closePromise
  }

  return {
      get closing() {
        return closing
      },
      close,
      whenDrained: beginDrain,
    }
}
