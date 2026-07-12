import { useState, type ComponentType } from "react"
import { Archive, ArrowUpRight, ChevronsDownUp, ChevronsUpDown, FileText, Loader2, RotateCcw, Trash2 } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { canDismiss } from "../lib/status.ts"

// THE shared whole-thread action icons, rendered IDENTICALLY by the queue card header and the thread
// header so the two can never drift. Order left→right runs least→most important, so the primary verb
// sits at the far RIGHT. The verbs SPLIT on kind:
//   • SESSION (non-foreign): doc/open nav · Kill (live) · Archive / Reopen. NO Mark-as —
//     completing/dismissing/adopting are .fray verbs. Archive is the ui.db lifecycle write (the done
//     fence mutates nothing); Reopen un-archives. Rename now lives next to the title in ThreadHeader
//     (ChatView.tsx) instead of here — it is no longer part of the shared icon row.
//   • SESSION (foreign): read-only. Only the doc/open NAVIGATION affordances — no kill/archive.
//   • LEGACY (kind !== "session"): the vestigial Mark-as split button, exactly as before.
export function HeaderActions({
  thread,
  onOpen,
  onDoc,
  onDone,
  onCollapse,
  collapsed,
  doneBusy,
  onStatusMutate,
  onStatusApplied,
  onStatusFailed,
}: {
  thread: ThreadView
  onOpen?: () => void // present only on queue cards → shows the Open-thread (drawer) icon
  onDoc?: () => void // present only on the thread header → shows the fray-document icon
  onDone: () => void // legacy Mark-as "done" path (parent-owned mutation)
  onCollapse?: () => void // queue cards → collapse/expand the card body to just its header
  collapsed?: boolean
  doneBusy?: boolean
  // Lifecycle pass-through: for LEGACY this drives the MarkAsButton choreography; for a SESSION thread
  // `onStatusApplied` doubles as "archived — resolve me" (queue card collapses / drawer closes).
  onStatusMutate?: () => void
  onStatusApplied?: () => void
  onStatusFailed?: () => void
}) {
  const isSession = thread.kind === "session"
  const isForeign = thread.foreign === true
  const archived = thread.state === "archived"

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onCollapse && (
        <IconBtn
          label={collapsed ? "Expand" : "Collapse"}
          icon={collapsed ? ChevronsUpDown : ChevronsDownUp}
          size={13}
          onClick={onCollapse}
        />
      )}
      {onDoc && <IconBtn label="Fray document" icon={FileText} size={14} onClick={onDoc} />}
      {onOpen && <IconBtn label="Open thread" icon={ArrowUpRight} size={14} onClick={onOpen} />}
      {isSession ? (
        // Session verbs — a foreign session is read-only → no Archive. NO Kill button (the maintainer
        // never approved one; Archive/Reopen is the lifecycle verb). Dismiss (hard-delete) sits left of
        // Archive and shows ONLY for a stalled/exited row — the escape hatch for a phantom that Archive
        // would only shelve into Inactive, never remove.
        !isForeign && (
          <>
            {canDismiss(thread) && <DismissButton slug={thread.id} onDismissed={onStatusApplied} />}
            <StateButton slug={thread.id} archived={archived} onArchived={onStatusApplied} />
          </>
        )
      ) : (
        <div className="ml-1">
          <MarkAsButton
            slug={thread.id}
            onDone={onDone}
            doneBusy={doneBusy}
            onMutateStart={onStatusMutate}
            onApplied={onStatusApplied}
            onFailed={onStatusFailed}
          />
        </div>
      )}
    </div>
  )
}

// The session lifecycle verb: Archive (open → archived) / Reopen (archived → open) via setThreadState —
// the ONLY writer of that state. On a successful ARCHIVE it fires `onArchived` so the surface can
// resolve (a queue card collapses out; a thread drawer closes). Reopen keeps the surface where it is.
function StateButton({ slug, archived, onArchived }: { slug: string; archived: boolean; onArchived?: () => void }) {
  const [busy, setBusy] = useState(false)
  const apply = () => {
    setBusy(true)
    rpc
      .setThreadState({ slug, state: archived ? "open" : "archived" })
      .then(() => {
        showToast(archived ? "Reopened" : "Archived")
        if (!archived) onArchived?.()
      })
      .catch((e) => showToast(`Failed: ${(e as Error).message.slice(0, 60)}`))
      .finally(() => setBusy(false))
  }
  const Icon = archived ? RotateCcw : Archive
  return (
    <button
      onClick={apply}
      disabled={busy}
      onMouseDown={(e) => e.preventDefault()}
      className="ml-1 flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2 px-2.5 py-1 text-[12px] font-medium text-fg outline-none transition-colors hover:bg-elevated disabled:opacity-50"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
      {archived ? "Reopen" : "Archive"}
    </button>
  )
}

// The Dismiss verb: hard-delete a stalled/exited session (rpc.forgetThread) — the row is removed and its
// transcript tombstoned so it stays gone across a rescan. On success it fires `onDismissed` (the same
// resolve callback Archive uses) so the surface closes: a queue card collapses, a thread drawer slides
// out. Rendered iff canDismiss(thread); the server re-checks liveness and rejects a live row.
function DismissButton({ slug, onDismissed }: { slug: string; onDismissed?: () => void }) {
  const [busy, setBusy] = useState(false)
  const apply = () => {
    setBusy(true)
    rpc
      .forgetThread({ slug })
      .then(() => {
        showToast("Dismissed")
        onDismissed?.()
      })
      .catch((e) => showToast(`Failed: ${(e as Error).message.slice(0, 60)}`))
      .finally(() => setBusy(false))
  }
  return (
    <Tooltip label="Dismiss — permanently remove this stalled session">
      <button
        onClick={apply}
        disabled={busy}
        aria-label="Dismiss session"
        onMouseDown={(e) => e.preventDefault()}
        className="ml-1 flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2 px-2.5 py-1 text-[12px] font-medium text-muted outline-none transition-colors hover:bg-elevated hover:text-red-400 disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        Dismiss
      </button>
    </Tooltip>
  )
}

// A quiet icon button with an immediate dark tooltip. onMouseDown-preventDefault keeps DOM focus off the
// button so a click never steals the keyboard from a card's composer. `busy` swaps in a spinner.
function IconBtn({
  label,
  icon: Icon,
  size,
  busy,
  ...rest
}: { label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; size: number; busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip label={label}>
      <button
        {...rest}
        aria-label={label}
        onMouseDown={(e) => e.preventDefault()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-muted disabled:opacity-40"
      >
        {busy ? <Loader2 size={size} strokeWidth={2} className="animate-spin" /> : <Icon size={size} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}
