import assert from "node:assert/strict"
import test from "node:test"
import { formatCountdownSeconds, formatElapsedMinutes, formatFixedDuration, formatToolDuration } from "./durationLabels.ts"

test("duration labels use unambiguous spelled compact units", () => {
  assert.equal(formatToolDuration(128 * 60_000), "128 min")
  assert.equal(formatToolDuration(128 * 60_000 + 3_000), "128 min 3 sec")
  assert.equal(formatElapsedMinutes(128), "2 hr 8 min")
  assert.equal(formatFixedDuration(128 * 60_000), "2 hr 8 min")
  assert.equal(formatCountdownSeconds(128), "2 min 08 sec")
})
