import { isValidAwaitingTimer, isValidGithubReviewTarget, type AwaitingHint } from "@fray-ui/shared"
import { formatSnoozeWake } from "./snooze.ts"

function lowerCalendarLead(value: string): string {
  return value.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

function awaitingHintPresentation(
  hint: AwaitingHint | undefined,
  nowMs = Date.now(),
): { lead: string; sentence: string } | null {
  if (hint?.kind === "timer" && isValidAwaitingTimer(hint.value) && Date.parse(hint.value) > nowMs) {
    return {
      lead: "Recommended snooze",
      sentence: `Until ${lowerCalendarLead(formatSnoozeWake(hint.value, nowMs))}`,
    }
  }

  if (hint?.kind === "github-review" && isValidGithubReviewTarget(hint.value)) {
    return {
      lead: "Review watcher",
      sentence: `Watch ${hint.value} for new human review activity`,
    }
  }

  if (hint?.kind === "timer" && isValidAwaitingTimer(hint.value)) {
    return {
      lead: "Scheduled checkpoint",
      sentence: `Scheduled for ${lowerCalendarLead(formatSnoozeWake(hint.value, nowMs))}`,
    }
  }
  if (hint?.kind === "timer") {
    return { lead: "Snooze schedule", sentence: "Snooze schedule unavailable" }
  }
  return null
}

export function awaitingHintSentence(hint: AwaitingHint | undefined, nowMs = Date.now()): string | null {
  return awaitingHintPresentation(hint, nowMs)?.sentence ?? null
}

export function awaitingCalloutPresentation(
  body: string,
  hint: AwaitingHint | undefined,
  nowMs = Date.now(),
): { lead: string; description: string | null } {
  const prose = body.trim()
  const presentation = awaitingHintPresentation(hint, nowMs)
  if (presentation) {
    const sentence = prose && !/[.!?…]$/.test(presentation.sentence) ? `${presentation.sentence}.` : presentation.sentence
    return { lead: presentation.lead, description: prose ? `${sentence} ${prose}` : sentence }
  }
  return {
    lead: "Wait note",
    description: prose || "Waiting for an external update.",
  }
}
