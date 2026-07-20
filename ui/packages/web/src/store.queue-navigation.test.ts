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
    const card = {
      getBoundingClientRect: () => ({ top }),
      querySelector: () => null,
      classList: {
        add: (name: string) => flashes.push(`+${name}`),
        remove: (name: string) => flashes.push(`-${name}`),
      },
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
      setTimeout: (fn: () => void) => {
        fn()
        return 0
      },
    } as unknown as Window

    assert.equal(scrollToQueueCard("queued-thread"), true)
    assert.deepEqual(scrolls, [{ top: 406, left: 0, behavior: "auto" }])
    assert.deepEqual(flashes, ["+queue-flash", "-queue-flash"])
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
      classList: { add: () => {}, remove: () => {} },
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
