import { test } from "node:test"
import assert from "node:assert/strict"
import { parseStandaloneThreadPath, standaloneThreadHref } from "./standaloneThreadRoute.ts"

test("standalone thread links encode slugs and round-trip through the parser", () => {
  const href = standaloneThreadHref("fix queue/spacing")
  assert.equal(href, "/thread/fix%20queue%2Fspacing/full")
  assert.equal(parseStandaloneThreadPath(href), "fix queue/spacing")
})

test("standalone parsing rejects drawer, extra-segment, and malformed routes", () => {
  assert.equal(parseStandaloneThreadPath("/thread/example"), null)
  assert.equal(parseStandaloneThreadPath("/thread/example/full/more"), null)
  assert.equal(parseStandaloneThreadPath("/thread/%/full"), null)
})
