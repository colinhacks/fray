export type DrawerInitialScrollPhase = "waiting" | "settling" | "complete" | "suppressed" | "disposed"

export interface DrawerInitialScrollClock {
  schedule(run: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const browserClock: DrawerInitialScrollClock = {
  schedule: (run, delayMs) => window.setTimeout(run, delayMs),
  cancel: (handle) => window.clearTimeout(handle as number),
}

export interface DrawerInitialScrollOptions {
  isActive: () => boolean
  isContentReady: () => boolean
  scrollToBottom: () => boolean
  preserveAnchor?: () => boolean
  clock?: DrawerInitialScrollClock
  settleMs?: number
}

// A drawer owns exactly one initial tail-focus decision. Transcript data and rich content can arrive
// after the fixed-height sheet mounts, so every observed layout change extends a short settling
// window. Once settled, live-message pinning belongs to ChatView; this coordinator never re-arms.
export class DrawerInitialScrollCoordinator {
  #phase: DrawerInitialScrollPhase = "waiting"
  #timer: unknown = null
  readonly #isActive: () => boolean
  readonly #isContentReady: () => boolean
  readonly #scrollToBottom: () => boolean
  readonly #clock: DrawerInitialScrollClock
  readonly #settleMs: number

  constructor(opts: DrawerInitialScrollOptions) {
    this.#isActive = opts.isActive
    this.#isContentReady = opts.isContentReady
    this.#scrollToBottom = opts.scrollToBottom
    this.#clock = opts.clock ?? browserClock
    this.#settleMs = opts.settleMs ?? 120
    if (opts.preserveAnchor?.()) this.#phase = "suppressed"
  }

  get phase(): DrawerInitialScrollPhase {
    return this.#phase
  }

  activationChanged(): void {
    if (this.#terminal) return
    if (!this.#isActive()) {
      this.#clearTimer()
      this.#phase = "waiting"
      return
    }
    this.#settle()
  }

  layoutChanged(): void {
    if (this.#terminal || !this.#isActive()) return
    this.#settle()
  }

  userIntent(): void {
    if (this.#terminal) return
    this.#clearTimer()
    this.#phase = "suppressed"
  }

  dispose(): void {
    this.#clearTimer()
    this.#phase = "disposed"
  }

  get #terminal(): boolean {
    return this.#phase === "complete" || this.#phase === "suppressed" || this.#phase === "disposed"
  }

  #settle(): void {
    if (!this.#isActive() || !this.#isContentReady()) {
      this.#clearTimer()
      this.#phase = "waiting"
      return
    }
    this.#phase = "settling"
    this.#scrollToBottom()
    this.#clearTimer()
    this.#timer = this.#clock.schedule(() => {
      this.#timer = null
      if (!this.#isActive() || !this.#isContentReady()) {
        this.#phase = "waiting"
        return
      }
      if (!this.#scrollToBottom()) {
        this.#settle()
        return
      }
      this.#phase = "complete"
    }, this.#settleMs)
  }

  #clearTimer(): void {
    if (this.#timer === null) return
    this.#clock.cancel(this.#timer)
    this.#timer = null
  }
}
