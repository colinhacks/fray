import type { ThreadView } from "@fray-ui/shared"

const ADOPTABLE_STATUSES = new Set<ThreadView["status"]>(["planning", "planned", "active", "needs-human", "blocked"])

// Presentation only; the server independently reconstructs the same facts from a fresh raw board.
// Keeping this conservative prevents a stale/owned/broken legacy row from advertising an action the
// authorization boundary must refuse.
export function canAdoptThread(thread: ThreadView | undefined): boolean {
  return Boolean(
    thread &&
    thread.kind === "legacy" &&
    !thread.foreign &&
    thread.runtime === "none" &&
    !thread.sessionId &&
    !thread.tmuxName &&
    !thread.owner &&
    thread.agents.length === 0 &&
    thread.errors.length === 0 &&
    ADOPTABLE_STATUSES.has(thread.status),
  )
}
