import { proxy } from "valtio"
import type { BoardSnapshot, ThreadView, BoardDelta } from "@fray-ui/shared"
import { applyBoardDelta } from "@fray-ui/shared"
import { closeDrawerAnimated } from "./lib/overlays.ts"

export type ConnectionState = "connecting" | "open" | "closed"

// What the workpane (the centered main column) shows: "todos" (the queue — cards + dispatch box, the
// resting page) or "status:<s>" (URL-only per-status lists). THREADS render in the side-drawer stack
// over the queue; there is no main-view thread surface and no nav selection (the focus machine and
// the sidebar arrow-walk were deleted — the sidebar is mouse-driven). The router is the writer.
export type View = "todos" | `status:${string}`

// The whole app renders off this single valtio proxy. Board is a full snapshot
// pushed over SSE (no diff protocol); everything else is local UI state.
export const store = proxy({
  board: null as BoardSnapshot | null,
  view: "todos" as View,
  connection: "connecting" as ConnectionState,
  showSettings: false,
  showPalette: false,
  // The anywhere-modal behind the "New thread" pill (Gmail-compose style).
  showNewThread: false,
  // The GitHub picker modal (Issues/PRs tabs → multi-select → batch dispatch). Its trigger appears
  // only when gh is authed AND the project is a GitHub repo; see GithubTrigger + openGithubPicker.
  showGithubPicker: false,
  // When the New-thread modal was opened FROM a plan ("New thread from plan"), the plan's path — passed
  // as dispatch.planPath so the worker is oriented to the plan. Null for an ordinary new thread. Cleared
  // when the modal closes.
  newThreadPlanPath: null as string | null,
  // Left-sidebar section collapse (true = collapsed). Needs-you + Working lead expanded; Awaiting,
  // Plans, Archive, Legacy start collapsed. Session-scoped UI state (deliberately not persisted).
  sidebarCollapsed: { active: false, inactive: true, plans: true } as Record<"active" | "inactive" | "plans", boolean>,
  // The SIDE-DRAWER STACK — arbitrary depth. `thread` layers are full thread views (the Open-thread
  // sheet); `doc` layers are the fray-document markdown; `subagent` layers are a live/stale sub-agent's
  // read-only transcript (the drill-in that overlays a thread). Each new layer stacks OVER the previous
  // (higher z, slight inset); Esc / backdrop / browser-Back unwind the TOP layer first. There is no
  // standalone thread page — this stack is the only thread surface. The subagent-only fields (subId /
  // label / subagentType / startedAt) ride the same entry so App can render its sheet without a lookup.
  drawers: [] as {
    id: number
    kind: "thread" | "doc" | "subagent" | "plan"
    slug: string
    terminal?: boolean
    subId?: string // subagent: the dispatch tool_use id (the RPC handle + dedupe key)
    label?: string // subagent: the dispatch description (header title) / plan: the plan title
    path?: string // plan: the PlanView.path (.fray/plans/*.md) the drawer renders + dispatches from
    subagentType?: string // subagent: the model+effort cell tag
    startedAt?: string // subagent: ISO8601 dispatch time (drives the header's running elapsed)
    closing?: boolean // set the instant this layer's slide-OUT begins, so URL/topThreadSlug stop
    // counting it before its 210ms removal (prevents a phantom /thread history push when a view
    // change races the close — see markDrawerClosing).
  }[],
  // Mirrors settings.notifications so the (React-free) SSE handler can gate desktop
  // notifications without reaching into TanStack Query. Kept in sync from App.
  notificationsEnabled: false,
  // True once the /ws multiplex confirms it's live (server pushes transcript updates into the query
  // cache). useTranscript reads this to DROP its 1.5s poll + subscribe instead; false before the socket
  // confirms and on SSE fallback (a pre-restart server without /ws), where polling stays exactly as today.
  socketTranscripts: false,
  // Transient bottom-center toast (e.g. "Steered" on an eager queue reply). `id` bumps per call so
  // repeat toasts re-trigger the fade. Rendered by <Toaster>; null when nothing is showing.
  toast: null as { id: number; text: string; spinner?: boolean; sticky?: boolean; duration?: number; link?: { label: string; slug: string } } | null,
})

// Open the New-thread modal, optionally seeded from a plan (the dispatch will carry planPath).
export function openNewThread(planPath?: string): void {
  store.newThreadPlanPath = planPath ?? null
  store.showNewThread = true
}

// Open the GitHub picker modal (batch-dispatch from issues/PRs). The trigger that calls this is
// itself gated on gh being authed + in a GitHub repo, so the modal only opens when the RPCs can serve.
export function openGithubPicker(): void {
  store.showGithubPicker = true
}

let toastSeq = 0
export function showToast(text: string, opts?: { spinner?: boolean; sticky?: boolean; duration?: number; link?: { label: string; slug: string } }) {
  store.toast = { id: ++toastSeq, text, ...opts }
}

// ── drawer stack ─────────────────────────────────────────────────────────────────────────────────
let drawerSeq = 0
export function pushDrawer(kind: "thread" | "doc", slug: string, opts?: { terminal?: boolean }): void {
  // Re-pushing the slug already on top is a no-op (double-click, repeated toast link).
  const top = store.drawers[store.drawers.length - 1]
  if (top && top.kind === kind && top.slug === slug) return
  store.drawers.push({ id: ++drawerSeq, kind, slug, terminal: opts?.terminal })
}

// Open a sub-agent's transcript as a new drawer layer OVER whatever's on top (typically the thread it
// was dispatched from). `slug` is the PARENT thread; `subId` is the dispatch tool_use id (the RPC
// handle). Deduped on subId so a double-click / re-click doesn't stack duplicates.
export function pushSubAgentDrawer(slug: string, subId: string, opts: { label: string; subagentType?: string; startedAt?: string }): void {
  const top = store.drawers[store.drawers.length - 1]
  if (top && top.kind === "subagent" && top.subId === subId) return
  store.drawers.push({ id: ++drawerSeq, kind: "subagent", slug, subId, label: opts.label, subagentType: opts.subagentType, startedAt: opts.startedAt })
}

// Open a thread from a listing/notification click-through. Routing by runtime: a thread with NO
// session ever spawned (runtime "none" — no transcript, the chat drawer would be an empty
// placeholder) opens its fray DOCUMENT drawer instead — for a Plans-section thread the doc IS the
// substance. Anything with a session (live or exited — exited transcripts are worth seeing) opens
// the chat drawer. The doc drawer carries the adopt ("Start a session") affordance for the rest.
export function openThread(slug: string): void {
  const t = store.board?.threads.find((x) => x.id === slug)
  pushDrawer(t && t.runtime === "none" ? "doc" : "thread", slug)
}

// A thread that's ALREADY in the queue (needsYou) has its full card in the main column — clicking its
// sidebar row should SCROLL to that card, not open a redundant drawer over it (maintainer 2026-07-09:
// "the queue is how you know"). Returns false if no card is mounted (not queued / not rendered), so the
// caller falls back to opening the drawer.
export function scrollToQueueCard(slug: string): boolean {
  if (typeof document === "undefined") return false
  const el = document.querySelector(`[data-queue-card="${CSS.escape(slug)}"]`)
  if (!el) return false
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.classList.add("queue-flash")
  window.setTimeout(() => el.classList.remove("queue-flash"), 1100)
  return true
}

// Open a plan artifact (.fray/plans/*.md) as a doc-style drawer layer. `path` is the PlanView.path (the
// planBody RPC handle + the dispatch's planPath); `title` is the plan's display title. Deduped on path
// so a re-click doesn't stack duplicates. Uses the path as the entry `slug` too (a stable key for the
// layer) — plan layers never resolve a thread, so the slug is only an identity handle here.
export function pushPlanDrawer(path: string, title: string): void {
  const top = store.drawers[store.drawers.length - 1]
  if (top && top.kind === "plan" && top.path === path) return
  store.drawers.push({ id: ++drawerSeq, kind: "plan", slug: path, path, label: title })
}

export function popDrawer(): void {
  const top = store.drawers[store.drawers.length - 1]
  if (top) closeDrawersById([top.id])
}

export function topDrawer() {
  return store.drawers[store.drawers.length - 1]
}

// Mark a drawer-stack entry as animating-OUT the instant its slide begins, so the URL sync and
// topThreadSlug stop counting it BEFORE the ~210ms removal lands. Without this, a synchronous view
// change during the close window (e.g. browser-Back into a status list, or the palette's Queue
// action) would still see the present-but-closing layer and push a phantom /thread history entry.
export function markDrawerClosing(id: number): void {
  const d = store.drawers.find((x) => x.id === id)
  if (d) d.closing = true
}

// Unwind drawer-stack entries by id THROUGH their registered animated closers (the slide-out plays)
// instead of an instant `store.drawers = …` splice — the fix for "drawers animate in but not out"
// on the non-component close paths (router back/forward unwind, palette Queue). Any id whose drawer
// isn't mounted (no registered closer — e.g. at boot before components mount) is raw-filtered so the
// stack still settles correctly.
export function closeDrawersById(ids: number[]): void {
  const orphans: number[] = []
  for (const id of ids) if (!closeDrawerAnimated(id)) orphans.push(id)
  if (orphans.length) {
    const drop = new Set(orphans)
    store.drawers = store.drawers.filter((d) => !drop.has(d.id))
  }
}

// The slug of the topmost THREAD layer (for ⌘I, the URL, and other "current thread" consumers).
// Layers mid-close are skipped: they're sliding out and must not keep the URL pinned to /thread.
export function topThreadSlug(): string | null {
  for (let i = store.drawers.length - 1; i >= 0; i--) {
    const d = store.drawers[i]
    if (d.kind === "thread" && !d.closing) return d.slug
  }
  return null
}

// A full board KEYFRAME arrives from SSE (React-free) — on connect and on resync. Just store it;
// every surface derives its own view of the thread list per render (there is no selection state to
// reconcile — the focus machine that needed one is gone).
export function setBoard(board: BoardSnapshot) {
  store.board = board
}

// STARTUP seed only (App fires an rpc.board() to paint before SSE connects). Unlike setBoard this must
// NOT clobber a board the SSE stream has already established + advanced with deltas — a late-resolving
// seed would otherwise revert applied deltas (the seq keeps advancing but the content rolls back). So
// it lands only when nothing is there yet; once the SSE keyframe has set the board, the seed is a no-op.
export function seedBoard(board: BoardSnapshot) {
  if (store.board === null) store.board = board
}

// Apply a per-thread delta IN PLACE (upsert/remove threads, patch board-level meta) — valtio's
// fine-grained reactivity means only the changed rows re-render (the audit's S2 fix), vs. setBoard's
// wholesale replace. Returns false when there's no base board to apply onto (caller must resync).
export function applyDelta(delta: BoardDelta): boolean {
  if (store.board === null) return false
  applyBoardDelta(store.board, delta)
  return true
}

export function threadBySlug(board: BoardSnapshot | null, slug: string | null): ThreadView | undefined {
  if (!board || !slug) return undefined
  return board.threads.find((t) => t.id === slug)
}
