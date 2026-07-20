import type { ThreadView } from "@fray-ui/shared"

export interface ThreadLifecycleAvailability {
  footer: boolean
  snooze: boolean
  archive: boolean
}

// One ownership/lifecycle decision shared by queue cards and full thread surfaces. The controls are
// deliberately not message actions: a done fence, transcript hydration, or selected tab can never
// move or duplicate them.
export function threadLifecycleAvailability(thread: ThreadView): ThreadLifecycleAvailability {
  const owned = thread.kind === "session" && thread.foreign !== true
  // `archived` mirrors the pre-state-column protocol; honor it during a rolling server/client reload.
  const archived = owned && (thread.state === "archived" || thread.archived === true)
  // An archived thread has NO lifecycle controls: there is no Reopen button (reopening is just sending
  // the thread another message), so with Snooze/Archive gone too the footer has nothing to show.
  const footer = owned && !archived
  return {
    footer,
    snooze: footer,
    archive: footer,
  }
}
