import type { TranscriptMessage, TranscriptPage } from "@fray-ui/shared"

export type PaginatedTranscriptData = TranscriptPage & { historyLoaded?: boolean }

// The next click starts at the immediately-previous projected user message. When no earlier user exists
// in the in-memory window, reveal its whole remaining prefix in one step; the caller consults the server
// cursor first when history exists beyond that prefix.
export function previousUserBoundary(messages: readonly TranscriptMessage[], currentStart: number): number | null {
  const start = Math.max(0, Math.min(messages.length, currentStart))
  for (let i = start - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return start > 0 ? 0 : null
}

function firstOverlap(
  previous: readonly TranscriptMessage[],
  incoming: readonly TranscriptMessage[],
): { previousIndex: number; incomingIndex: number } | undefined {
  const priorIds = new Map<string, number>()
  previous.forEach((message, index) => {
    if (message.sourceId) priorIds.set(message.sourceId, index)
  })
  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex++) {
    const id = incoming[incomingIndex].sourceId
    const previousIndex = id ? priorIds.get(id) : undefined
    if (previousIndex !== undefined) return { previousIndex, incomingIndex }
  }
  return undefined
}

// Reconcile a fresh latest-window pull/push with history already fetched by the user. The overlap's
// current server copies win (tool statuses can finalize), while the older prefix and its cursor remain.
// No overlap means a transcript/session replacement: discard the old window instead of splicing worlds.
export function reconcileLatestPage(
  previous: PaginatedTranscriptData | undefined,
  incoming: TranscriptPage,
): PaginatedTranscriptData {
  if (!previous?.historyLoaded || previous.transcriptKey !== incoming.transcriptKey) return incoming
  const overlap = firstOverlap(previous.messages, incoming.messages)
  if (!overlap) return incoming
  return {
    ...incoming,
    messages: [
      ...previous.messages.slice(0, overlap.previousIndex),
      ...incoming.messages.slice(overlap.incomingIndex),
    ],
    beforeCursor: previous.beforeCursor,
    hasEarlier: previous.hasEarlier,
    reachedTurnBoundary: previous.reachedTurnBoundary,
    historyLoaded: true,
  }
}

export function reconcileLiveMessages(
  previous: PaginatedTranscriptData | undefined,
  incoming: readonly TranscriptMessage[],
): PaginatedTranscriptData | { messages: TranscriptMessage[] } {
  if (!previous) return { messages: [...incoming] }
  const overlap = firstOverlap(previous.messages, incoming)
  if (!overlap) return { messages: [...incoming] }
  if (!previous.historyLoaded) {
    return overlap.previousIndex === 0 && overlap.incomingIndex === 0
      ? { ...previous, messages: [...incoming] }
      : { messages: [...incoming] }
  }
  return {
    ...previous,
    messages: [
      ...previous.messages.slice(0, overlap.previousIndex),
      ...incoming.slice(overlap.incomingIndex),
    ],
  }
}

// Apply one earlier response once. Source ids make retries/stale duplicate responses idempotent.
export function prependEarlierPage(
  current: PaginatedTranscriptData,
  earlier: TranscriptPage,
): PaginatedTranscriptData {
  if (current.transcriptKey !== earlier.transcriptKey) return current
  const present = new Set(current.messages.map((message) => message.sourceId).filter(Boolean))
  const prepend = earlier.messages.filter((message) => !message.sourceId || !present.has(message.sourceId))
  return {
    ...current,
    messages: [...prepend, ...current.messages],
    beforeCursor: earlier.beforeCursor,
    hasEarlier: earlier.hasEarlier,
    reachedTurnBoundary: earlier.reachedTurnBoundary,
    historyLoaded: true,
  }
}

export interface TranscriptViewportAnchor {
  sourceId: string
  top: number
}

// Pick the first old message intersecting the viewport. Its top-edge delta after React prepends the
// page is the exact scroll correction, independent of variable-height markdown/tool cards.
export function captureTranscriptViewportAnchor(
  root: HTMLElement | null,
  viewportTop = 0,
): TranscriptViewportAnchor | null {
  if (!root) return null
  // Skip the sticky most-recent-user-message band: once pinned its top is INVARIANT (it stays at
  // the pane top regardless of scroll), so anchoring on it would compute a zero delta and let
  // prepended history shift the real content. Anchor only on natural-flow messages.
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
    .filter((candidate) => candidate.dataset.transcriptSticky !== "true")
  const node = nodes.find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop) ?? nodes[0]
  const sourceId = node?.dataset.transcriptSourceId
  return node && sourceId ? { sourceId, top: node.getBoundingClientRect().top } : null
}

export function transcriptAnchorScrollDelta(beforeTop: number, afterTop: number): number {
  return afterTop - beforeTop
}

export function restoreTranscriptViewportAnchor(
  root: HTMLElement | null,
  anchor: TranscriptViewportAnchor | null,
  scrollBy: (delta: number) => void,
): boolean {
  if (!root || !anchor) return false
  const node = [...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
    .find((candidate) => candidate.dataset.transcriptSourceId === anchor.sourceId)
  if (!node) return false
  scrollBy(transcriptAnchorScrollDelta(anchor.top, node.getBoundingClientRect().top))
  return true
}
