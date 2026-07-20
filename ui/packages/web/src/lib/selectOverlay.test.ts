import assert from "node:assert/strict"
import test from "node:test"
import { dismissOpenSelect, handleDialogEscape, registerOpenSelect } from "./selectOverlay.ts"

test("the newest open Select owns one dialog Escape", () => {
  const dismissed: string[] = []
  const unregisterFirst = registerOpenSelect(() => dismissed.push("first"))
  const unregisterSecond = registerOpenSelect(() => dismissed.push("second"))
  let prevented = 0
  let stopped = 0

  handleDialogEscape({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  })

  assert.deepEqual(dismissed, ["second"])
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  assert.equal(dismissOpenSelect(), false)
  unregisterSecond()
  unregisterFirst()
})

test("a dialog Escape propagates to Radix dismissal when no Select is open", () => {
  let prevented = 0
  let stopped = 0
  handleDialogEscape({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  })
  assert.equal(prevented, 0)
  assert.equal(stopped, 1)
})
