import assert from "node:assert/strict"
import test from "node:test"
import { awaitingHintSentence, awaitingPresentationLine } from "./awaitingPresentation.ts"

const now = Date.parse("2026-07-21T18:00:00.000Z")

test("awaiting hints become one compact plain-English action", () => {
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T21:00:00.000Z" }], now) ?? "",
    /^Snooze until /,
  )
  assert.equal(
    awaitingHintSentence([{ kind: "github-review", value: "owner/repo#42" }], now),
    "Watch owner/repo#42 for new human review activity",
  )
  assert.equal(
    awaitingHintSentence([{ kind: "human", value: "Alice to approve the API shape" }], now),
    "Wait for Alice to approve the API shape",
  )
})

test("actionable hints win and elapsed timers remain stable instead of becoming a live status", () => {
  assert.equal(
    awaitingHintSentence([
      { kind: "timer", value: "not-a-time" },
      { kind: "github-review", value: "owner/repo#42" },
    ], now),
    "Watch owner/repo#42 for new human review activity",
  )
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T17:00:00.000Z" }], now) ?? "",
    /^Scheduled for /,
  )
  assert.equal(awaitingHintSentence([{ kind: "timer", value: "not-a-time" }], now), "Snooze schedule unavailable")
})

test("legacy hints degrade to readable text and an empty hint set stays empty", () => {
  assert.equal(awaitingHintSentence([{ kind: "pr", value: "owner/repo#7" }], now), "Wait for PR owner/repo#7")
  assert.equal(awaitingHintSentence([{ kind: "ci", value: "build 9" }], now), "Wait for CI build 9")
  assert.equal(awaitingHintSentence([{ kind: "session", value: "sub-123" }], now), "Wait for session sub-123")
  assert.equal(awaitingHintSentence([], now), null)
})

test("body and action join as clean prose without period-dash punctuation", () => {
  assert.equal(
    awaitingPresentationLine("Park until the checkpoint.", "Snooze until today at 2:00 PM"),
    "Park until the checkpoint. Snooze until today at 2:00 PM",
  )
  assert.equal(
    awaitingPresentationLine("Park until the checkpoint", "Snooze until today at 2:00 PM"),
    "Park until the checkpoint — Snooze until today at 2:00 PM",
  )
  assert.equal(awaitingPresentationLine("", null), "Waiting for an external update.")
})
