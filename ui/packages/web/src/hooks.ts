import { useEffect } from "react"
import { useSnapshot } from "valtio"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView, TranscriptMessage } from "@fray-ui/shared"
import { store, threadBySlug } from "./store.ts"
import { rpc } from "./api/rpc.ts"
import { subscribeTranscript, unsubscribeTranscript } from "./api/socket.ts"
import { mergeOptimistic, isTranscriptStale, newestRenderedAt } from "./lib/transcript-sync.ts"

// A transcript message carrying a transient client-only flag: a follow-up we optimistically appended
// on send that hasn't yet appeared in a server refetch. The flag drives the "queued" affordance and
// is naturally dropped when server truth overwrites the cache — EXCEPT that a blunt overwrite would drop
// it too early (before the server's own copy lands), so overwrites now route through mergeOptimistic.
export type ChatMessage = TranscriptMessage & { queued?: boolean }
type TranscriptData = { messages: ChatMessage[] }

// (mergeToolRuns was DELETED with the ordered-parts fidelity fix. Its whole job was to fold
// consecutive tool-only turns into one band so adjacent collapsed "5 tool calls"/"3 tool calls"
// toggles didn't look broken — moot now that every call renders as a uniform card and each assistant
// message renders its `parts` IN BLOCK ORDER. Folding fought that ordered walk: it hoisted a following
// turn's tools above a lead-in's prose and, under `parts`, would have dropped a folded turn's cards
// entirely. VISUAL ORDER == TURN ORDER is the invariant; the renderer is now dumb and correct — two
// adjacent tool-only turns simply render as two adjacent card runs, which is fine.)

// React-only helpers live here, not in store.ts, because store.ts is also imported by
// non-React code (api/sse.ts) that has no business pulling in React/valtio hooks.

// Valtio's useSnapshot() produces a DeepReadonly view that doesn't structurally match
// BoardSnapshot/ThreadView (readonly arrays vs. the mutable shapes zod infers), so every read
// needs a cast. Centralized here so it happens once instead of scattered `as BoardSnapshot`
// casts across components.
export function useBoard(): BoardSnapshot | null {
  const snap = useSnapshot(store)
  return snap.board as BoardSnapshot | null
}

export function asThreads(threads: readonly unknown[]): ThreadView[] {
  return threads as ThreadView[]
}

// True once the /ws multiplex is the transcript source (server pushes into the cache). Components read
// this to skip pull-based refetch paths that the push now covers.
export function useSocketTranscripts(): boolean {
  return useSnapshot(store).socketTranscripts
}

// Shared transcript query. `poll` controls whether the transcript stays LIVE (chat while the agent is
// running) or is left to refetch only on explicit triggers (the To-dos pager).
//
// Freshness has two transports: with the /ws multiplex live (store.socketTranscripts), a live surface
// SUBSCRIBES and the server PUSHES updates into this same cache — no interval poll. Without it (before the
// socket confirms, or on SSE fallback against a pre-restart server) it falls back to the 1.5s interval —
// exactly today's behavior. Either way the mount fetch (staleTime 0) paints immediately.
// Watchdog cadence + staleness threshold. The board's lastActivityAt can legitimately lead the rendered
// tail by a couple seconds (the two ride different reads of the same JSONL), so only a LARGER lead is a
// real delivery miss. A genuine miss self-heals on the first refetch (it pulls the whole transcript); the
// attempt cap stops us hammering when the lead is a benign tail-advance with nothing new to render.
const WATCHDOG_MS = 7000
const STALE_MS = 5000
const MAX_HEAL_ATTEMPTS = 3

export function useTranscript(slug: string, opts: { poll: boolean }) {
  const qc = useQueryClient()
  const socket = useSnapshot(store).socketTranscripts

  // Subscribe the live surface to server transcript push (ref-counted in socket.ts, so a drawer + the main
  // view on one slug share a single server subscription; unmount / poll→false / socket-flip unsubscribes).
  // Reactive in BOTH `socket` and `opts.poll`: when the socket confirms mid-session the effect re-runs and
  // subscribes (poll turns off in the same render); on SSE fallback it re-runs and unsubscribes (poll turns
  // back on) — the poll and the subscription are exact complements, so exactly one is active at any instant.
  useEffect(() => {
    if (!socket || !opts.poll) return
    subscribeTranscript(slug)
    return () => unsubscribeTranscript(slug)
  }, [slug, opts.poll, socket])

  const query = useQuery({
    queryKey: ["transcript", slug],
    // Preserve optimistic sends across a poll refetch too (not just the socket push) — see mergeOptimistic.
    queryFn: async () => {
      const res = await rpc.threadTranscript({ slug })
      const prev = qc.getQueryData<TranscriptData>(["transcript", slug])
      return { messages: mergeOptimistic(prev?.messages, res.messages as ChatMessage[]) }
    },
    // Poll only when the socket ISN'T the transcript source; in socket mode pushes keep the cache fresh.
    refetchInterval: opts.poll && !socket ? 1500 : false,
  })

  // LEVEL-TRIGGERED freshness watchdog — the self-healing complement to the edge-triggered push/poll. A
  // missed edge (a dropped subscription across a reconnect/HMR, a suppressed broadcast, a mount-order flip)
  // would otherwise wedge a live view FOREVER with no recovery — the class of bug behind "it needed a hard
  // reload". Every WATCHDOG_MS (cheap: one timestamp compare, no network unless stale) we check the board's
  // lastActivityAt for this slug (delivered independently over the board-delta channel) against the newest
  // rendered message; a lead beyond STALE_MS means the transcript is provably behind, so we force a pull
  // refetch (always works — plain HTTP) AND re-establish the subscription (fixes a lost server-side sub for
  // FUTURE pushes), and warn a structured breadcrumb so the underlying delivery bug stays diagnosable. Lives
  // in the hook so every consumer (main ChatView + the drawer's) inherits the invariant.
  useEffect(() => {
    if (!opts.poll) return // only LIVE views self-heal; a settled thread's transcript is intentionally static
    let inFlight = false
    let attempts = 0
    let lastHealNewest: string | undefined
    const tick = () => {
      if (inFlight) return
      const activity = threadBySlug(store.board as BoardSnapshot | null, slug)?.lastActivityAt
      const newest = newestRenderedAt(qc.getQueryData<TranscriptData>(["transcript", slug])?.messages)
      if (!isTranscriptStale(activity, newest, STALE_MS)) {
        attempts = 0 // caught up — re-arm
        return
      }
      // Stale. If the transcript advanced since our last heal, re-arm; otherwise the lead is likely a benign
      // tail-advance (sidecar records with nothing renderable) — cap attempts so we don't hammer forever.
      if (newest !== lastHealNewest) attempts = 0
      if (attempts >= MAX_HEAL_ATTEMPTS) return
      attempts++
      lastHealNewest = newest
      const lagMs = activity ? Date.parse(activity) - (newest ? Date.parse(newest) : 0) : 0
      console.warn("[fray] transcript watchdog: stale view — self-healing", { slug, lagMs, transport: socket ? "socket" : "poll", attempt: attempts })
      if (socket) {
        // Re-establish the server-side subscription (drop→re-add on the ref count) so future pushes resume.
        unsubscribeTranscript(slug)
        subscribeTranscript(slug)
      }
      inFlight = true
      void query.refetch().finally(() => {
        inFlight = false
      })
    }
    const iv = setInterval(tick, WATCHDOG_MS)
    return () => clearInterval(iv)
    // query.refetch is stable across renders (react-query); slug/poll/socket cover the meaningful deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, opts.poll, socket])

  return query
}

// A live/stale sub-agent's OWN transcript, for the drill-in drawer. Keyed by (slug, id) so distinct
// children never collide, and polled ONLY while the child is still running — once the RPC reports
// stale/gone the drawer is showing a settled (or unavailable) transcript, so we stop hammering the
// connection budget. The predicate reads the last result so polling self-cancels as the state flips.
export function useSubAgentTranscript(slug: string, id: string) {
  return useQuery({
    queryKey: ["subAgentTranscript", slug, id],
    queryFn: () => rpc.subAgentTranscript({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2500 : false),
  })
}

// Follow-ups are injected into the agent's terminal stdin and only surface in the transcript once the
// agent's next turn picks them up — so the message would otherwise vanish on send. Optimistically
// append it to the ["transcript", slug] cache as a user bubble tagged `queued`; the next real refetch
// (which never sets `queued`) overwrites the cache and dedupes it against the server's own copy.
export function appendQueuedMessage(qc: QueryClient, slug: string, text: string) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    const messages = prev?.messages ?? []
    return { messages: [...messages, { role: "user", text, tools: [], parts: [], queued: true }] }
  })
  // Sending commits the user to the conversation tail, so force the page to the bottom REGARDLESS of
  // current scroll position. ChatView's auto-stick only fires when you're already near the bottom
  // (so reading history is never yanked), which means a reply sent from up-thread would otherwise
  // leave the new bubble off-screen. This is the single send-path hook shared by the thread composer
  // (ThreadActionBar) and the answering controller (queue card + thread-view answers). The main
  // workpane and queue scroll the WINDOW; the side drawer runs its own bottom-pin. rAF so the new
  // bubble is laid out before we read scrollHeight.
  if (typeof window !== "undefined") {
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }))
  }
}

// Roll back the optimistic bubble appendQueuedMessage added, when the send actually FAILS. Removes
// the LAST still-queued message whose text matches (only optimistic entries carry `queued`, so a
// server-confirmed copy is never touched). Keeps the optimistic UX honest: a failed follow-up no
// longer leaves a phantom "sent" bubble the reload silently erases.
export function removeQueuedMessage(qc: QueryClient, slug: string, text: string) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    if (!prev?.messages?.length) return prev
    const i = prev.messages.findLastIndex((m) => m.queued && m.role === "user" && m.text === text)
    if (i === -1) return prev
    return { messages: prev.messages.filter((_, j) => j !== i) }
  })
}
