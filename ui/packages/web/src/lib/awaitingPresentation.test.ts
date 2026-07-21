import assert from "node:assert/strict"
import test from "node:test"
import { awaitingCalloutPresentation, awaitingHintSentence } from "./awaitingPresentation.ts"

const now = Date.parse("2026-07-21T18:00:00.000Z")

test("awaiting hints become one compact plain-English action", () => {
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T21:00:00.000Z" }], now) ?? "",
    /^Until /,
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

test("callout presentation separates the bold action lead from supporting prose", () => {
  const timer = awaitingCalloutPresentation(
    "Park until the checkpoint.",
    [{ kind: "timer", value: "2026-07-21T21:00:00.000Z" }],
    now,
  )
  assert.equal(timer.lead, "Recommended snooze")
  assert.match(timer.description ?? "", /^Until .*\. Park until the checkpoint\.$/)
  assert.deepEqual(
    awaitingCalloutPresentation(
      "The implementation is ready for review.",
      [{ kind: "github-review", value: "owner/repo#42" }],
      now,
    ),
    {
      lead: "Review watcher",
      description: "Watch owner/repo#42 for new human review activity. The implementation is ready for review.",
    },
  )
  assert.deepEqual(
    awaitingCalloutPresentation(
      "The API shape needs approval.",
      [{ kind: "human", value: "Alice to approve the API shape" }],
      now,
    ),
    {
      lead: "Human approval",
      description: "Wait for Alice to approve the API shape. The API shape needs approval.",
    },
  )
  assert.deepEqual(
    awaitingCalloutPresentation("The worker left a plain handoff.", [], now),
    { lead: "Wait note", description: "The worker left a plain handoff." },
  )
  assert.deepEqual(
    awaitingCalloutPresentation("", [], now),
    { lead: "Wait note", description: "Waiting for an external update." },
  )
})
