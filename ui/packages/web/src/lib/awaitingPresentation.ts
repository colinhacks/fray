import { isValidAwaitingTimer, type AwaitingHint } from "@fray-ui/shared"
import { formatSnoozeWake } from "./snooze.ts"

function lowerCalendarLead(value: string): string {
  return value.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

function awaitingHintPresentation(
  hints: readonly AwaitingHint[],
  nowMs = Date.now(),
): { lead: string; sentence: string } | null {
  const timer = hints.find((hint) => hint.kind === "timer" && isValidAwaitingTimer(hint.value))
  if (timer && Date.parse(timer.value) > nowMs) {
    return {
      lead: "Recommended snooze",
      sentence: `Until ${lowerCalendarLead(formatSnoozeWake(timer.value, nowMs))}`,
    }
  }

  const review = hints.find((hint) => hint.kind === "github-review")
  if (review) {
    return {
      lead: "Review watcher",
      sentence: `Watch ${review.value} for new human review activity`,
    }
  }

  const human = hints.find((hint) => hint.kind === "human")
  if (human) return { lead: "Human approval", sentence: `Wait for ${human.value}` }

  if (timer) {
    return {
      lead: "Scheduled checkpoint",
      sentence: `Scheduled for ${lowerCalendarLead(formatSnoozeWake(timer.value, nowMs))}`,
    }
  }
  if (hints.some((hint) => hint.kind === "timer")) {
    return { lead: "Snooze schedule", sentence: "Snooze schedule unavailable" }
  }

  const legacy = hints.find((hint) => hint.kind === "pr" || hint.kind === "ci" || hint.kind === "session")
  if (!legacy) return null
  if (legacy.kind === "pr") return { lead: "PR review", sentence: `Wait for PR ${legacy.value}` }
  if (legacy.kind === "ci") return { lead: "CI check", sentence: `Wait for CI ${legacy.value}` }
  return { lead: "Related session", sentence: `Wait for session ${legacy.value}` }
}

export function awaitingHintSentence(hints: readonly AwaitingHint[], nowMs = Date.now()): string | null {
  return awaitingHintPresentation(hints, nowMs)?.sentence ?? null
}

export function awaitingCalloutPresentation(
  body: string,
  hints: readonly AwaitingHint[],
  nowMs = Date.now(),
): { lead: string; description: string | null } {
  const prose = body.trim()
  const hint = awaitingHintPresentation(hints, nowMs)
  if (hint) {
    const sentence = prose && !/[.!?…]$/.test(hint.sentence) ? `${hint.sentence}.` : hint.sentence
    return { lead: hint.lead, description: prose ? `${sentence} ${prose}` : sentence }
  }
  return {
    lead: "Wait note",
    description: prose || "Waiting for an external update.",
  }
}
