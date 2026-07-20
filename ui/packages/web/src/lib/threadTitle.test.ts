import { test } from "node:test"
import assert from "node:assert/strict"
import { aiRenameAvailability, manualThreadTitleSeed, threadTitleToCommit } from "./threadTitle.ts"

test("threadTitleToCommit: trims a human title and preserves empty/unchanged titles as no-ops", () => {
  assert.equal(threadTitleToCommit("  Human-readable thread title  ", "generated-slug"), "Human-readable thread title")
  assert.equal(threadTitleToCommit("   ", "Keep this"), undefined)
  assert.equal(threadTitleToCommit(" Keep this ", "Keep this"), undefined)
})

test("manualThreadTitleSeed: never seeds an editor with an internal slug or placeholder", () => {
  assert.equal(manualThreadTitleSeed("generated-slug", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Untitled thread", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Spinning up a thread…", "generated-slug"), "")
  assert.equal(manualThreadTitleSeed("Readable title", "generated-slug"), "Readable title")
})

test("aiRenameAvailability: Claude idle only; Codex and foreign rows never fake native support", () => {
  assert.deepEqual(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "turn-idle" }), {
    show: true, enabled: true, label: "Rename with Claude",
  })
  assert.match(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "running" }).label, /turn finishes/)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "running" }).enabled, false)
  assert.match(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "perm-prompt" }).label, /terminal prompt/)
  assert.match(aiRenameAvailability({ kind: "session", backend: "claude", runtime: "running", pendingAsk: {} }).label, /terminal prompt/)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "codex", runtime: "turn-idle" }).show, false)
  assert.equal(aiRenameAvailability({ kind: "session", backend: "claude", foreign: true, runtime: "turn-idle" }).show, false)
})
