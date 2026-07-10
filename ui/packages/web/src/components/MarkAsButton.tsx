import { memo, useState } from "react"
import { ChevronDown, Loader2 } from "lucide-react"
import type { FrayStatus } from "@fray-ui/shared"
import { Menu, MenuTrigger, MenuContent, MenuItem } from "./ui/Menu.tsx"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { STATUS_ORDER } from "../lib/status.ts"

// THE status verb, everywhere a thread can be resolved: a GitHub-merge-style split button. The
// caret menu ARMS a status (it does not apply it); the primary segment reads "Mark as <armed>"
// and applies on click. Plain text throughout — no per-status dots (the color language lives in
// the listing chips, not this verb). Defaults to done — the common case. This one
// component replaces every ad-hoc Done/Dismiss icon pair so the verb can never drift between
// the card headers, the thread header, and the agents listing (size="sm" there).
//
// "done" routes through `onDone` when the parent owns that mutation (busy state, optimistic
// exit); with no onDone — and for every other status — it applies via setThreadStatus, whose
// server handler carries dismissal's kill-the-session side effect.
//
// MEMOIZED (measured as the single most expensive steady-state line item — its Radix menu tree
// re-ran on every board delta for every AgentRow): the AgentRow call sites pass only primitives
// (slug/size), so those instances skip entirely; card/thread headers pass an inline onDone and
// keep today's behavior (memo is a no-op there, not a regression).
export const MarkAsButton = memo(function MarkAsButton({
  slug,
  size = "md",
  onDone,
  doneBusy,
  onMutateStart,
  onApplied,
  onFailed,
}: {
  slug: string
  size?: "md" | "sm"
  onDone?: () => void
  doneBusy?: boolean
  // Lifecycle hooks for surface-specific choreography: the queue card DIMS the instant a status is
  // applied and collapses on confirm; a drawer CLOSES on confirm. For the onDone path the PARENT's
  // mutation owns success/failure (wire these into it there); for the internal setThreadStatus path
  // this component fires them.
  onMutateStart?: () => void
  onApplied?: () => void
  onFailed?: () => void
}) {
  const [armed, setArmed] = useState<FrayStatus>("done")
  const [statusBusy, setStatusBusy] = useState(false)
  const busy = (armed === "done" && onDone ? doneBusy : statusBusy) ?? false
  const applyArmed = () => {
    onMutateStart?.()
    if (armed === "done" && onDone) return onDone()
    setStatusBusy(true)
    rpc
      .setThreadStatus({ slug, status: armed })
      .then(() => {
        showToast(`Status → ${armed}`)
        onApplied?.()
      })
      .catch(() => onFailed?.())
      .finally(() => setStatusBusy(false))
  }
  const sm = size === "sm"
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-border-strong">
      <button
        onClick={applyArmed}
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        className={`flex items-center bg-panel-2 font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50 ${
          sm ? "gap-1 px-1.5 text-[11px]" : "gap-1.5 px-2.5 py-1 text-[12px]"
        }`}
      >
        {busy && <Loader2 size={sm ? 11 : 12} className="animate-spin" />}
        Mark as {armed}
      </button>
      <Menu>
        <MenuTrigger
          aria-label="Set status…"
          className={`flex items-center border-l border-border-strong bg-panel-2 text-muted outline-none transition-colors hover:bg-elevated hover:text-fg data-[state=open]:bg-elevated data-[state=open]:text-fg ${
            sm ? "px-1" : "px-1.5"
          }`}
        >
          <ChevronDown size={sm ? 11 : 12} />
        </MenuTrigger>
        <MenuContent>
          {STATUS_ORDER.map((st) => (
            <MenuItem key={st} onSelect={() => setArmed(st)}>
              Mark as {st}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  )
})
