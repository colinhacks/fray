import { test } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeObservedThreadModel,
  threadProfileOptions,
  validateThreadProfile,
} from "./thread-profiles.ts"

test("thread profile catalogues expose complete provider-owned pairs", () => {
  for (const backend of ["claude", "codex"] as const) {
    const catalogue = threadProfileOptions(backend)
    assert.equal(catalogue.backend, backend)
    assert.ok(catalogue.options.length > 0)
    for (const option of catalogue.options) {
      assert.ok(option.model)
      assert.ok(option.efforts.length > 0)
      assert.ok(option.efforts.includes(option.defaultEffort))
      assert.doesNotThrow(() => validateThreadProfile(backend, option.model, option.defaultEffort))
    }
  }
})

test("profile validation fails closed across providers and for unknown backends", () => {
  assert.throws(() => validateThreadProfile("claude", "gpt-5.5", "high"), /Unsupported claude/)
  // Claude Code 2.1.209 advertises low..max for --effort. Do not expose a Codex-only
  // value that the Claude CLI would reject at launch or on a profile reattach.
  assert.throws(() => validateThreadProfile("claude", "opus", "ultra"), /Unsupported claude model\/effort pair: opus \/ ultra/)
  assert.throws(() => validateThreadProfile("codex", "sonnet", "high"), /Unsupported codex/)
  assert.throws(() => threadProfileOptions("future-provider"), /unknown backend/)
})

test("observed model normalization accepts only the current provider's identities", () => {
  assert.equal(normalizeObservedThreadModel("claude", "claude-opus-4-6"), "opus")
  assert.equal(normalizeObservedThreadModel("claude", "gpt-5.5"), undefined)
  assert.equal(normalizeObservedThreadModel("codex", "sonnet"), undefined)
})
