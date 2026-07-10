import type { TranscriptMessage } from "@fray-ui/shared"

// A transcript message that may carry the client-only/queued flag (server pending OR local optimistic).
export type QueuedMessage = TranscriptMessage & { queued?: boolean }

// ── Layer 3: optimistic-merge hardening (the sync audit's S1 finding) ──────────────────────────────────
// A transcript cache OVERWRITE (a poll refetch OR a socket push) must not blunt-replace an optimistic
// "queued" bubble the client appended on send but the incoming server truth doesn't yet carry — that
// blunt replace is exactly what makes a just-sent message VANISH for the window before the server's own
// copy (a pending/delivered queued message — see the server parser) shows up. So: re-append any optimistic
// queued user entry whose text isn't present in the incoming server user messages; drop the ones the
// server has now materialized (matched by trimmed text) so there's never a duplicate. With the server
// now carrying the message within ~a tick this is a short bridge, but it closes the visible swallow.
export function mergeOptimistic(prev: QueuedMessage[] | undefined, incoming: QueuedMessage[]): QueuedMessage[] {
  if (!prev?.length) return incoming
  const optimistic = prev.filter((m) => m.queued && m.role === "user" && m.text.trim())
  if (!optimistic.length) return incoming
  // Any incoming USER text (delivered OR the server's own queued copy) consumes a matching optimistic entry.
  const serverUserTexts = new Set(incoming.filter((m) => m.role === "user").map((m) => m.text.trim()))
  const unconsumed = optimistic.filter((m) => !serverUserTexts.has(m.text.trim()))
  return unconsumed.length ? [...incoming, ...unconsumed] : incoming
}

// ── Level-triggered freshness watchdog (pure decision) ─────────────────────────────────────────────────
// The transport (socket push AND poll) is edge-triggered: a single missed edge — a dropped subscription
// across a reconnect/HMR, a suppressed broadcast, a mount-order flip — wedges a live view forever with no
// self-healing. The watchdog is the level-triggered complement: it compares the board's lastActivityAt for
// a slug (delivered independently over the board-delta channel) against the newest RENDERED message; a lead
// beyond the threshold means the rendered transcript is provably behind. Pure so the decision is unit-tested
// apart from the React timer/heal machinery in useTranscript.
export function isTranscriptStale(lastActivityAt: string | undefined, newestRenderedAt: string | undefined, staleMs: number): boolean {
  if (!lastActivityAt) return false // no activity marker → nothing to be behind
  const activity = Date.parse(lastActivityAt)
  if (!Number.isFinite(activity)) return false
  // No rendered message yet but the board reports activity → treat as maximally behind (rendered = epoch).
  const rendered = newestRenderedAt ? Date.parse(newestRenderedAt) : 0
  if (newestRenderedAt && !Number.isFinite(rendered)) return false // unparseable tail → don't thrash
  return activity - rendered > staleMs
}

// The newest RENDERED message timestamp: the last message that carries an `at` (scanning from the tail, so
// a trailing event/at-less line doesn't mask the real newest). undefined when nothing has a timestamp.
export function newestRenderedAt(messages: QueuedMessage[] | undefined): string | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const at = messages[i].at
    if (at) return at
  }
  return undefined
}
