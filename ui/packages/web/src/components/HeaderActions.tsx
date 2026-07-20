import { useState, type ComponentType } from "react"
import { ArrowUpRight, ChevronsDownUp, ChevronsUpDown, FileText, Loader2, Trash2 } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { canDismiss } from "../lib/status.ts"

// THE shared whole-thread action icons, rendered IDENTICALLY by the queue card header and the thread
// header so the two can never drift. Order left→right runs least→most important, so the primary verb
// sits at the far RIGHT. The verbs SPLIT on kind:
//   • SESSION (non-foreign): doc/open navigation; the full thread may additionally expose diagnostic
//     Dismiss for a stalled session. Queue headers suppress it so their whole-thread verbs have one
//     persistent home in ThreadLifecycleFooter. Rename lives next to the title in ThreadHeader.
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
  showDismiss = true,
}: {
  thread: ThreadView
  onOpen?: () => void // present only on queue cards → shows the Open-thread (drawer) icon
  onDoc?: () => void // present only on the thread header → shows the fray-document icon
  onDone: () => void // legacy Mark-as "done" path (parent-owned mutation)
  onCollapse?: () => void // queue cards → collapse/expand the card body to just its header
  collapsed?: boolean
  doneBusy?: boolean
  // Mutation pass-through: LEGACY uses the MarkAsButton choreography; an owned stalled session uses
  // onStatusApplied after Dismiss. Archive/Snooze callbacks belong to ThreadLifecycleFooter.
  onStatusMutate?: () => void
  onStatusApplied?: () => void
  onStatusFailed?: () => void
  // Queue cards keep every lifecycle verb in their footer. Full thread surfaces may still expose
  // Dismiss as the diagnostic escape hatch for an exited/stalled session.
  showDismiss?: boolean
}) {
  const isSession = thread.kind === "session"
  const isForeign = thread.foreign === true

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
        // Foreign sessions are read-only. Dismiss remains a diagnostic/header action for an exited
        // phantom; Snooze and Archive are lifecycle actions and live only in the footer.
        showDismiss && !isForeign && canDismiss(thread) ? <DismissButton slug={thread.id} onDismissed={onStatusApplied} /> : null
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

// The Dismiss verb: hard-delete a stalled/exited session (rpc.forgetThread) — the row is removed and its
// transcript tombstoned so it stays gone across a rescan. On success it fires `onDismissed` so the
// surface closes: a queue card collapses, a thread drawer slides
// out. Rendered iff the owning surface opts in and canDismiss(thread); the server re-checks liveness
// and rejects a live row.
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
