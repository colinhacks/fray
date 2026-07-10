import { useState, type ComponentType } from "react"
import { useMutation } from "@tanstack/react-query"
import { Archive, ArrowUpRight, Ban, ChevronsDownUp, ChevronsUpDown, FileText, Loader2, RefreshCw, RotateCcw } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"
import { MarkAsButton } from "./MarkAsButton.tsx"

// THE shared whole-thread action icons, rendered IDENTICALLY by the queue card header and the thread
// header so the two can never drift. Order left→right runs least→most important, so the primary verb
// sits at the far RIGHT. The verbs SPLIT on kind:
//   • SESSION (non-foreign): rename (live) · doc/open nav · Kill (live) · Archive / Reopen. NO Mark-as —
//     completing/dismissing/adopting are .fray verbs. Archive is the ui.db lifecycle write (the done
//     fence mutates nothing); Reopen un-archives.
//   • SESSION (foreign): read-only. Only the doc/open NAVIGATION affordances — no rename/kill/archive.
//   • LEGACY (kind !== "session"): the vestigial Mark-as split button + rename, exactly as before.
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
  const live = thread.runtime === "running" || thread.runtime === "spawning" || thread.runtime === "turn-idle" || thread.runtime === "perm-prompt"
  const renameLive = thread.runtime !== "none" && thread.runtime !== "exited"

  const kill = useMutation({
    mutationFn: () => rpc.killAgent({ slug: thread.id }),
    onSuccess: () => showToast("Killing session…"),
    onError: (e) => showToast(`Kill failed: ${(e as Error).message.slice(0, 60)}`),
  })

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
      {/* Rename: registered threads only (a foreign session has no session we own to rename). */}
      {!isForeign && (
        <IconBtn
          label="Regenerate name"
          icon={RefreshCw}
          size={13}
          disabled={!renameLive}
          onClick={() => rpc.renameThread({ slug: thread.id }).then(() => showToast("Renaming…")).catch(() => {})}
        />
      )}
      {onDoc && <IconBtn label="Fray document" icon={FileText} size={14} onClick={onDoc} />}
      {onOpen && <IconBtn label="Open thread" icon={ArrowUpRight} size={14} onClick={onOpen} />}
      {isSession ? (
        // Session verbs. A foreign session is read-only → no Kill/Archive.
        !isForeign && (
          <>
            {live && (
              <IconBtn
                label="Kill session"
                icon={Ban}
                size={14}
                busy={kill.isPending}
                onClick={() => kill.mutate()}
              />
            )}
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
