import { test } from "node:test"
import assert from "node:assert/strict"
import { queueComposerHandlesOptionEnter } from "./queueComposerKeyboard.ts"

test("Queue composer: macOS Option-Enter (altKey) explicitly inserts a newline", () => {
  assert.equal(queueComposerHandlesOptionEnter("queueComposer", "Enter", true), true)
  assert.equal(queueComposerHandlesOptionEnter("queueComposer", "Enter", false), false)
})

test("Queue composer: Option-Enter does not broaden into other composer surfaces", () => {
  assert.equal(queueComposerHandlesOptionEnter("dispatch", "Enter", true), false)
  assert.equal(queueComposerHandlesOptionEnter("queueComposer", "Escape", true), false)
})
