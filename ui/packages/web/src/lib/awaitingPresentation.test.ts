import assert from "node:assert/strict"
import test from "node:test"
import { awaitingCalloutPresentation, awaitingHintSentence } from "./awaitingPresentation.ts"

const now = Date.parse("2026-07-21T18:00:00.000Z")

test("one awaiting hint becomes one compact plain-English action", () => {
  assert.match(
    awaitingHintSentence({ kind: "timer", value: "2026-07-21T21:00:00.000Z" }, now) ?? "",
    /^Until /,
  )
  assert.equal(
    awaitingHintSentence({ kind: "github-review", value: "owner/repo#42" }, now),
    "Watch owner/repo#42 for new human review activity",
  )
})

test("elapsed and malformed single hints remain stable instead of becoming live status", () => {
  assert.match(
    awaitingHintSentence({ kind: "timer", value: "2026-07-21T17:00:00.000Z" }, now) ?? "",
    /^Scheduled for /,
  )
  assert.equal(awaitingHintSentence({ kind: "timer", value: "not-a-time" }, now), "Snooze schedule unavailable")
  assert.equal(awaitingHintSentence({ kind: "github-review", value: "not-a-pr" }, now), null)
  assert.equal(awaitingHintSentence(undefined, now), null)
})

test("callout presentation separates the bold action lead from supporting prose", () => {
  const timer = awaitingCalloutPresentation(
    "Park until the checkpoint.",
    { kind: "timer", value: "2026-07-21T21:00:00.000Z" },
    now,
  )
  assert.equal(timer.lead, "Recommended snooze")
  assert.match(timer.description ?? "", /^Until .*\. Park until the checkpoint\.$/)
  assert.deepEqual(
    awaitingCalloutPresentation(
      "The implementation is ready for review.",
      { kind: "github-review", value: "owner/repo#42" },
      now,
    ),
    {
      lead: "Review watcher",
      description: "Watch owner/repo#42 for new human review activity. The implementation is ready for review.",
    },
  )
  assert.deepEqual(
    awaitingCalloutPresentation("The worker left a plain handoff.", undefined, now),
    { lead: "Wait note", description: "The worker left a plain handoff." },
  )
  assert.deepEqual(
    awaitingCalloutPresentation("", undefined, now),
    { lead: "Wait note", description: "Waiting for an external update." },
  )
})
