import assert from "node:assert/strict"
import test from "node:test"
import { PROVIDER_MARK_GEOMETRY, providerMarkForBackend } from "./providerMark.ts"

test("provider marks identify only known, backend-backed threads", () => {
  assert.deepEqual(providerMarkForBackend("codex"), { backend: "codex", label: "OpenAI Codex" })
  assert.deepEqual(providerMarkForBackend("claude"), { backend: "claude", label: "Claude Code" })
  assert.equal(providerMarkForBackend(undefined), undefined)
  assert.equal(providerMarkForBackend(null), undefined)
  assert.equal(providerMarkForBackend("future-provider"), undefined)
})

test("provider mark geometry keeps compact monochrome marks optically centered beside a title", () => {
  assert.equal(PROVIDER_MARK_GEOMETRY.codex, "size-[10px]")
  assert.equal(PROVIDER_MARK_GEOMETRY.claude, "size-[11px] translate-y-px")
})
