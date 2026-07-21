import { isValidAwaitingTimer, type AwaitingHint } from "@fray-ui/shared"
import { formatSnoozeWake } from "./snooze.ts"

function lowerCalendarLead(value: string): string {
  return value.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

export function awaitingHintSentence(hints: readonly AwaitingHint[], nowMs = Date.now()): string | null {
  const timer = hints.find((hint) => hint.kind === "timer" && isValidAwaitingTimer(hint.value))
  if (timer && Date.parse(timer.value) > nowMs) {
    return `Snooze until ${lowerCalendarLead(formatSnoozeWake(timer.value, nowMs))}`
  }

  const review = hints.find((hint) => hint.kind === "github-review")
  if (review) return `Watch ${review.value} for new human review activity`

  const human = hints.find((hint) => hint.kind === "human")
  if (human) return `Wait for ${human.value}`

  if (timer) return `Scheduled for ${lowerCalendarLead(formatSnoozeWake(timer.value, nowMs))}`
  if (hints.some((hint) => hint.kind === "timer")) return "Snooze schedule unavailable"

  const legacy = hints.find((hint) => hint.kind === "pr" || hint.kind === "ci" || hint.kind === "session")
  if (!legacy) return null
  if (legacy.kind === "pr") return `Wait for PR ${legacy.value}`
  if (legacy.kind === "ci") return `Wait for CI ${legacy.value}`
  return `Wait for session ${legacy.value}`
}

export function awaitingCalloutPresentation(
  body: string,
  hints: readonly AwaitingHint[],
  nowMs = Date.now(),
): { lead: string; description: string | null } {
  const prose = body.trim()
  const hint = awaitingHintSentence(hints, nowMs)
  if (hint) return { lead: hint, description: prose || null }
  if (prose) return { lead: prose, description: null }
  return { lead: "Waiting for an external update", description: null }
}
