import assert from "node:assert/strict"
import test from "node:test"
import { scrollToQueueCard } from "./store.ts"

test("sidebar queue navigation lands immediately at the card reading line", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const scrolls: ScrollToOptions[] = []
  const flashes: string[] = []
  let top = 418

  try {
    // No `[data-queue-card-root]` child: this pins the FALLBACK, where the slot itself is the ring
    // target. Only fixtures render a rootless slot — every production card emits one (see test 3).
    const card = {
      getBoundingClientRect: () => ({ top }),
      querySelector: () => null,
      setAttribute: (name: string) => flashes.push(`+${name}`),
      removeAttribute: (name: string) => flashes.push(`-${name}`),
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: (selector: string) => {
        assert.equal(selector, '[data-queue-card="queued-thread"]')
        return card
      },
    } as unknown as Document
    globals.window = {
      scrollY: 0,
      scrollTo: (options: ScrollToOptions) => {
        scrolls.push(options)
        top -= options.top ?? 0
      },
      clearTimeout: () => {},
      setTimeout: (fn: () => void) => {
        fn()
        return 0
      },
    } as unknown as Window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(scrolls, [{ top: 406, left: 0, behavior: "auto" }])
    // The leading removal is the animation RESTART (see test 4), then the ring, then its teardown.
    assert.deepEqual(flashes, ["-data-queue-flash", "+data-queue-flash", "-data-queue-flash"])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

test("sidebar queue navigation uses an absolute reading-line target after a narrow-layout drawer close", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const scrolls: ScrollToOptions[] = []
  let top = -4680

  try {
    const card = {
      getBoundingClientRect: () => ({ top }),
      querySelector: () => null,
      setAttribute: () => {},
      removeAttribute: () => {},
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: () => card,
    } as unknown as Document
    globals.window = {
      scrollY: 5941,
      scrollTo: (options: ScrollToOptions) => {
        scrolls.push(options)
        top = 12
      },
      clearTimeout: () => {},
      setTimeout: () => 0,
    } as unknown as Window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(scrolls, [{ top: 1249, left: 0, behavior: "auto" }])
    assert.equal(top, 12)
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

// The arrival ring belongs to the BORDERED CARD ROOT. The outer `[data-queue-card]` slot also wraps the
// inter-card hairline rule and its my-10 margins, so ringing the slot drew the card AND ~80px of gutter
// plus the rule below it as one highlighted box (maintainer, 2026-07-21: "the ordered area also includes
// the horizontal rule beneath the card").
test("the queue arrival ring lands on the bordered card root, never the slot that wraps the inter-card rule", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const rootRinged: boolean[] = []
  const slotRinged: boolean[] = []
  const removals: (() => void)[] = []

  try {
    const root = {
      getBoundingClientRect: () => ({ top: 300 }),
      setAttribute: () => rootRinged.push(true),
      removeAttribute: () => rootRinged.push(false),
    }
    const slot = {
      getBoundingClientRect: () => ({ top: 300 }),
      querySelector: (selector: string) => (selector === '[data-queue-card-root="queued-thread"]' ? root : null),
      setAttribute: () => slotRinged.push(true),
      removeAttribute: () => slotRinged.push(false),
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: () => slot,
    } as unknown as Document
    globals.window = {
      scrollY: 0,
      scrollTo: () => {},
      clearTimeout: () => {},
      setTimeout: (fn: () => void) => { removals.push(fn); return 0 },
    } as unknown as Window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(rootRinged, [false, true], "restart-clear, then the ring")
    assert.deepEqual(slotRinged, [], "the slot must never carry the ring — it wraps the inter-card rule")

    // …and the scheduled teardown clears the ring from the same element it was set on.
    for (const fn of removals) fn()
    assert.deepEqual(rootRinged, [false, true, false])
    assert.deepEqual(slotRinged, [])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})

// Clicking the SAME queued row twice inside the 1.1s window must replay the ring. Re-setting an already
// present attribute does not restart a CSS animation, and the card is already at the landing so no
// scroll happens and (by design) no drawer opens — without a restart the second click is a total no-op.
test("re-clicking a queued row inside the flash window replays the ring and reschedules one teardown", () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window
    document?: Document
    CSS?: typeof CSS
  }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const events: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1

  try {
    const root = {
      getBoundingClientRect: () => ({ top: 12 }),
      setAttribute: () => events.push("set"),
      removeAttribute: () => events.push("clear"),
    }
    const slot = {
      getBoundingClientRect: () => ({ top: 12 }),
      querySelector: () => root,
      setAttribute: () => assert.fail("the slot must never carry the ring"),
      removeAttribute: () => {},
    }
    globals.CSS = { escape: (value: string) => value } as typeof CSS
    globals.document = {
      body: { style: { position: "" } },
      querySelector: () => slot,
    } as unknown as Document
    globals.window = {
      scrollY: 0,
      scrollTo: () => assert.fail("an already-landed card must not be re-scrolled"),
      setTimeout: (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id },
      clearTimeout: (id: number) => { events.push(`cancel:${id}`); timers.delete(id) },
    } as unknown as Window

    assert.equal(scrollToQueueCard("re-clicked"), true)
    assert.equal(scrollToQueueCard("re-clicked"), true)
    // Second click: cancels the first teardown, then clears + re-sets to restart the animation.
    assert.deepEqual(events, ["clear", "set", "cancel:1", "clear", "set"])

    // Exactly ONE teardown survives, and firing it leaves no stale timer behind.
    assert.deepEqual([...timers.keys()], [2])
    timers.get(2)!()
    assert.equal(events.at(-1), "clear")

    // A later click after the window closed schedules cleanly — no stale id to cancel.
    events.length = 0
    assert.equal(scrollToQueueCard("re-clicked"), true)
    assert.deepEqual(events, ["clear", "set"])
  } finally {
    globals.window = previous.window
    globals.document = previous.document
    globals.CSS = previous.CSS
  }
})
