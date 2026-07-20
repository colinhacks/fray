import assert from "node:assert/strict"
import test from "node:test"
import { THREAD_HEADER_CLASS, THREAD_HEADER_CONTROLS_CLASS, THREAD_HEADER_TITLE_CLASS } from "../lib/threadHeaderLayout.ts"

test("drawer thread header reserves a separate, unbroken control row before the sheet becomes cramped", () => {
  assert.match(THREAD_HEADER_CLASS, /max-\[640px\]:flex-wrap/)
  assert.match(THREAD_HEADER_CLASS, /max-\[640px\]:gap-y-2/)
  assert.match(THREAD_HEADER_TITLE_CLASS, /min-w-0/)
  assert.match(THREAD_HEADER_TITLE_CLASS, /max-\[640px\]:basis-full/)
  assert.match(THREAD_HEADER_CONTROLS_CLASS, /max-\[640px\]:w-full/)
  assert.match(THREAD_HEADER_CONTROLS_CLASS, /max-\[640px\]:justify-between/)
  assert.doesNotMatch(THREAD_HEADER_CLASS, /provider/i)
})
