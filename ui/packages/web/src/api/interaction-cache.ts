import type { QueryClient } from "@tanstack/react-query"
import type { InteractionRecord, ListInteractionsResult, ServerEvent } from "@fray-ui/shared"

export const pendingInteractionsKey = (slug: string, sessionId: string) =>
  ["interactions", "pending", slug, sessionId] as const

export const interactionRecordKey = (slug: string, sessionId: string, interactionId: string) =>
  ["interactions", "record", slug, sessionId, interactionId] as const

export function reconcileCachedInteraction(qc: QueryClient, interaction: InteractionRecord): void {
  const key = pendingInteractionsKey(interaction.owner.threadSlug, interaction.owner.sessionId)
  qc.setQueryData<ListInteractionsResult>(key, (current) => {
    if (!current) return current
    if (interaction.lifecycle !== "pending") {
      return { interactions: current.interactions.filter((candidate) => candidate.id !== interaction.id) }
    }
    return {
      interactions: current.interactions.map((candidate) => candidate.id === interaction.id ? interaction : candidate),
    }
  })
}

// A lost mutation response is an ambiguous write: it may already be QUEUED/SENT on the server. Mark
// every mounted copy noninteractive immediately. A later scoped read can replace this with proven
// awaiting-user (safe retry), sending, or a terminal record.
export function failClosedAmbiguousInteraction(qc: QueryClient, interaction: InteractionRecord): void {
  reconcileCachedInteraction(qc, { ...interaction, delivery: { effect: "reconnect-required" } })
}

// The push event contains no request payload by design. Invalidate only its exact owner scope and
// record; foreign sessions and other projects never become query keys in this browser.
export async function invalidateInteractionQueries(
  qc: QueryClient,
  event: Extract<ServerEvent, { type: "interactions-invalidated" }>,
): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: pendingInteractionsKey(event.slug, event.sessionId), exact: true }),
    qc.invalidateQueries({
      queryKey: interactionRecordKey(event.slug, event.sessionId, event.interactionId),
      exact: true,
    }),
  ])
}
