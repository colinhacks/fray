import assert from "node:assert/strict"
import test from "node:test"
import { COPY_COMMAND_FEEDBACK_MS, createCopyCommandFeedback } from "./copyCommandFeedback.ts"

function harness() {
  let nextTimer = 0
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  const states: boolean[] = []
  const feedback = createCopyCommandFeedback(
    (copied) => states.push(copied),
    {
      setTimeout: (callback, delay) => {
        assert.equal(delay, COPY_COMMAND_FEEDBACK_MS)
        callbacks.set(++nextTimer, callback)
        return nextTimer
      },
      clearTimeout: (timer) => {
        cleared.push(timer)
        callbacks.delete(timer)
      },
    },
  )
  return { feedback, callbacks, cleared, states }
}

test("copy feedback acknowledges immediately, resets on schedule, and restarts on a repeated click", () => {
  const h = harness()
  const first = h.feedback.begin()
  assert.deepEqual(h.states, [true])
  assert.equal(h.callbacks.size, 1)

  const second = h.feedback.begin()
  assert.notEqual(second, first)
  assert.deepEqual(h.states, [true, true])
  assert.deepEqual(h.cleared, [1])
  assert.equal(h.callbacks.has(2), true)

  h.callbacks.get(2)!()
  assert.deepEqual(h.states, [true, true, false])
})

test("only the current failed copy clears feedback, and disposal cancels the pending reset", () => {
  const h = harness()
  const first = h.feedback.begin()
  const second = h.feedback.begin()

  h.feedback.fail(first)
  assert.deepEqual(h.states, [true, true])

  h.feedback.fail(second)
  assert.deepEqual(h.states, [true, true, false])
  assert.deepEqual(h.cleared, [1, 2])

  h.feedback.begin()
  h.feedback.dispose()
  assert.deepEqual(h.cleared, [1, 2, 3])
  assert.equal(h.callbacks.size, 0)
})
