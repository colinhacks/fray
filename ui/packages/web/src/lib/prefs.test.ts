import assert from "node:assert/strict"
import test from "node:test"
import { parseStoredPrefs } from "./prefs.ts"

test("client preferences persist a validated snooze preset across reloads", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "tomorrow", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("missing, malformed, and stale snooze preferences fall back to one day", () => {
  assert.equal(parseStoredPrefs(null).snoozePreset, "1d")
  assert.equal(parseStoredPrefs("not-json").snoozePreset, "1d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "custom", diffsRedefaulted: true })).snoozePreset, "1d")
})

test("sticky user message defaults on and coerces stored values to a boolean", () => {
  // Default (nothing stored / malformed) → on.
  assert.equal(parseStoredPrefs(null).stickyUserMessage, true)
  assert.equal(parseStoredPrefs("not-json").stickyUserMessage, true)
  // Boolean round-trips.
  assert.equal(parseStoredPrefs(JSON.stringify({ stickyUserMessage: false, diffsRedefaulted: true })).stickyUserMessage, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ stickyUserMessage: true, diffsRedefaulted: true })).stickyUserMessage, true)
  // The short-lived earlier enum coerces: "off" → false; "compact"/"full" → true.
  assert.equal(parseStoredPrefs(JSON.stringify({ stickyUserMessage: "off", diffsRedefaulted: true })).stickyUserMessage, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ stickyUserMessage: "compact", diffsRedefaulted: true })).stickyUserMessage, true)
})

test("queue order defaults to FIFO and only accepts fifo/lifo", () => {
  // Default (nothing stored / malformed) → fifo.
  assert.equal(parseStoredPrefs(null).queueOrder, "fifo")
  assert.equal(parseStoredPrefs("not-json").queueOrder, "fifo")
  // Both valid values round-trip; anything else falls back to fifo.
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo", diffsRedefaulted: true })).queueOrder, "lifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "fifo", diffsRedefaulted: true })).queueOrder, "fifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "sideways", diffsRedefaulted: true })).queueOrder, "fifo")
})
