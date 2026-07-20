import { test } from "node:test"
import assert from "node:assert/strict"
import { markDrawerClosing, store } from "../store.ts"
import { primeRoute } from "./router.ts"

function resetStore(): void {
  store.drawers = []
  store.view = "todos"
}

test("primeRoute synchronously seeds a direct thread drawer before React renders", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  assert.deepEqual(
    store.drawers.map(({ kind, slug, routed }) => ({ kind, slug, routed })),
    [{ kind: "thread", slug: "cold-load", routed: true }],
  )
  assert.equal(store.view, "todos")
})

test("primeRoute is idempotent for the current direct thread and decodes its slug", () => {
  resetStore()
  primeRoute("/thread/a%20thread")
  primeRoute("/thread/a%20thread")
  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.slug, "a thread")
})

test("priming the queue unwinds a routed drawer without leaving a phantom", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  primeRoute("/")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.view, "todos")
})

test("a direct route reopens the closing layer instead of appending a duplicate", () => {
  resetStore()
  primeRoute("/thread/rapid-forward")
  const closingId = store.drawers[0]?.id
  assert.ok(closingId)
  markDrawerClosing(closingId)

  primeRoute("/thread/rapid-forward")

  assert.equal(store.drawers.length, 1)
  assert.deepEqual(
    Object.fromEntries(Object.entries(store.drawers[0] ?? {}).filter(([key]) => ["kind", "slug", "routed", "closing"].includes(key))),
    { kind: "thread", slug: "rapid-forward", routed: true },
  )
})

test("malformed percent escapes fall back to Queue instead of throwing before mount", () => {
  resetStore()
  primeRoute("/thread/existing")
  assert.doesNotThrow(() => primeRoute("/thread/%"))
  assert.equal(store.drawers.length, 0)
  assert.equal(store.view, "todos")

  assert.doesNotThrow(() => primeRoute("/status/%"))
  assert.equal(store.view, "todos")
})
