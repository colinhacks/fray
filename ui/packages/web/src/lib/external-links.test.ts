import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createExternalLinkClickHandler,
  prepareExternalAnchor,
  safeHttpUrl,
} from "./external-links.ts"

class FakeAnchor {
  readonly tagName = "A"
  readonly attributes = new Map<string, string>()

  constructor(href: string, rel?: string) {
    this.attributes.set("href", href)
    if (rel) this.attributes.set("rel", rel)
  }

  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
}

function clickFor(anchor: FakeAnchor, overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    defaultPrevented: false,
    composedPath: () => [{ tagName: "SPAN" }, anchor],
    ...overrides,
  } as unknown as MouseEvent
}

test("safeHttpUrl resolves relative URLs and rejects unsafe or malformed schemes", () => {
  assert.equal(safeHttpUrl("/thread/one", "http://127.0.0.1:4917/"), "http://127.0.0.1:4917/thread/one")
  assert.equal(safeHttpUrl("https://github.com/openai/codex", "http://127.0.0.1:4917/"), "https://github.com/openai/codex")
  assert.equal(safeHttpUrl("javascript:alert(1)", "http://127.0.0.1:4917/"), null)
  assert.equal(safeHttpUrl("not a url", "not a base"), null)
})

test("external anchors use a native safe new tab without canceling the click", () => {
  const anchor = new FakeAnchor("https://github.com/nodejs/node/issues/62720", "nofollow")
  let prevented = false
  const event = clickFor(anchor, { preventDefault: () => { prevented = true } } as Partial<MouseEvent>)
  createExternalLinkClickHandler(() => "http://127.0.0.1:4917/")(event)

  assert.equal(anchor.getAttribute("target"), "_blank")
  assert.equal(anchor.getAttribute("rel"), "nofollow noopener noreferrer")
  assert.equal(prevented, false)
})

test("same-origin, non-http, canceled, and non-left clicks remain untouched", () => {
  for (const href of ["/thread/local", "mailto:hello@example.com", "cursor://file/tmp/a.ts"]) {
    const anchor = new FakeAnchor(href)
    createExternalLinkClickHandler(() => "http://127.0.0.1:4917/")(clickFor(anchor))
    assert.equal(anchor.getAttribute("target"), null)
    assert.equal(anchor.getAttribute("rel"), null)
  }

  const canceled = new FakeAnchor("https://example.com")
  createExternalLinkClickHandler(() => "http://127.0.0.1:4917/")(
    clickFor(canceled, { defaultPrevented: true }),
  )
  assert.equal(canceled.getAttribute("target"), null)

  const middle = new FakeAnchor("https://example.com")
  createExternalLinkClickHandler(() => "http://127.0.0.1:4917/")(
    clickFor(middle, { button: 1 }),
  )
  assert.equal(middle.getAttribute("target"), null)
})

test("prepareExternalAnchor is idempotent and compares the complete origin including port", () => {
  const anchor = new FakeAnchor("http://127.0.0.1:4918/path", "noopener")
  assert.equal(prepareExternalAnchor(anchor, "http://127.0.0.1:4917/"), true)
  assert.equal(prepareExternalAnchor(anchor, "http://127.0.0.1:4917/"), true)
  assert.equal(anchor.getAttribute("rel"), "noopener noreferrer")
})
