import { FrayStatus, type ThreadView } from "@fray-ui/shared"

// The Dismiss (hard-delete/forget) verb is offered ONLY on an owned session that is NOT live — a
// stalled/exited row. A "Stalled" phantom (a worker whose transcript never materialized) and a
// normally-exited session both derive runtime "exited"; a running / turn-idle / perm-prompt session is
// live and must be Archived, never forgotten out from under itself (the server re-checks this too).
// Foreign sessions are read-only. Pure predicate so the gate is unit-tested without rendering React.
export function canDismiss(thread: Pick<ThreadView, "kind" | "foreign" | "runtime">): boolean {
  return thread.kind === "session" && thread.foreign !== true && thread.runtime === "exited"
}

// Lifecycle order for status pickers: planning → planned → active → blocked → done → dismissed.
// This is the shared FrayStatus enum's own declaration order — single-sourced, never re-listed.
export const STATUS_ORDER: readonly FrayStatus[] = FrayStatus.options

// One HUE per status, shared by the picker dots and the listing chips so the color language is a
// single vocabulary. Every status must be tellable apart at a dot's glance — an earlier palette
// gave planned/done/dismissed three near-identical grays. done is deliberately the ONLY gray
// (settled, nothing to see); dismissed reads as "rejected" (rose); YELLOW is reserved for exactly
// `needs-human` — the awaiting-you state — since that is the app's focus/attention motif. `blocked`
// (now a pure machine-wait) keeps its warm orange, adjacent but distinct from the needs-human yellow.
export const STATUS_DOT: Record<string, string> = {
  planning: "bg-sky-400",
  planned: "bg-violet-400",
  active: "bg-emerald-400",
  "needs-human": "bg-yellow-400",
  blocked: "bg-orange-400",
  done: "bg-zinc-400",
  dismissed: "bg-rose-400",
}

// Chip variant of the same hues (text + border), plus the UI-level "archived" pseudo-status,
// which only ever appears as a chip in the inactive listing.
export const STATUS_CHIP: Record<string, string> = {
  planning: "text-sky-400 border-sky-400/40",
  planned: "text-violet-400 border-violet-400/40",
  active: "text-emerald-400 border-emerald-400/40",
  "needs-human": "text-yellow-400 border-yellow-400/40",
  blocked: "text-orange-400 border-orange-400/40",
  done: "text-zinc-400 border-zinc-400/40",
  dismissed: "text-rose-400 border-rose-400/40",
  archived: "text-slate-500 border-slate-500/40",
}
