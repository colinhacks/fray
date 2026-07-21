import { useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { SnoozeButton } from "./SnoozeButton.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// The sole home for whole-thread lifecycle controls. Queue cards render it at their natural bottom;
// full thread surfaces make it sticky below every tab. Keeping this separate from HeaderActions and
// message/fence rendering prevents the completion action from jumping or duplicating after transcript hydration.
export function ThreadLifecycleFooter({
  thread,
  sticky = false,
  safeArea = false,
  onArchived,
  onSnoozed,
}: {
  thread: ThreadView
  sticky?: boolean
  // The full thread view places this footer at the physical bottom of a drawer. Keep the device
  // inset here, after the lifecycle controls, rather than padding the chat footer below the prompt.
  safeArea?: boolean
  onArchived?: () => void
  onSnoozed?: () => void
}) {
  const available = threadLifecycleAvailability(thread)
  if (!available.footer) return null
  return (
    <footer
      aria-label="Thread lifecycle actions"
      data-thread-lifecycle-footer
      className={`${sticky ? "z-20" : "rounded-b-[7px]"} flex min-h-10 shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/70 bg-panel/95 px-3 pt-2 ${safeArea ? "pb-[max(0.5rem,env(safe-area-inset-bottom))]" : "pb-2"} backdrop-blur-sm`}
    >
      {available.snooze && <SnoozeButton thread={thread} onSnoozed={onSnoozed} />}
      <StateButton thread={thread} onArchived={onArchived} />
    </footer>
  )
}

// Also rendered — deliberately redundant — as a white primary button at the bottom of the in-chat
// ```done card (see FenceCard). Same completion mutation and live-session confirmation flow; only the
// chrome differs, via `className`. There is deliberately NO Reopen state: reopening a thread is done by
// sending it another message, so the button is always "Mark as done".
export function StateButton({
  thread,
  onArchived,
  className = "border border-border-strong bg-panel-2/60 px-2.5 py-1 text-fg/80 hover:bg-panel-2 hover:text-fg",
}: {
  thread: ThreadView
  onArchived?: () => void
  className?: string
}) {
  // Disables the instant it's clicked. On success we DON'T reset it: the card is dissolving, so the
  // button stays disabled (still reading "Mark as done", no spinner) for the whole fade-out rather
  // than flickering back to enabled under the animation. Only a live-session confirmation prompt
  // (re-enables under the dialog) or a failure (re-enables in place) clears it.
  const [pending, setPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const complete = (terminateLive: boolean) => {
    if (!thread.sessionId) {
      showToast("This session changed; refresh before marking it done")
      return
    }
    setPending(true)
    rpc
      .completeThread({ slug: thread.id, sessionId: thread.sessionId, terminateLive })
      .then((result) => {
        if (result.needsConfirmation) {
          setConfirmOpen(true)
          setPending(false)
          return
        }
        setConfirmOpen(false)
        showToast("Done")
        onArchived?.()
      })
      .catch((error) => {
        showToast(`Couldn’t finish: ${(error as Error).message.slice(0, 80)}`)
        setPending(false)
      })
  }
  return (
    <>
      <button
        type="button"
        // The server owns the execution verdict. A live tmux shell can be resting at its provider
        // prompt, in which case Done should immediately stop it and archive the thread.
        onClick={() => complete(false)}
        disabled={pending}
        aria-label="Mark as done"
        title="Mark as done"
        onMouseDown={(event) => event.preventDefault()}
        className={`flex items-center gap-1.5 rounded-md text-[12px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-45 ${className}`}
      >
        <Check size={12} />
        Mark as done
      </button>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open)
        }}
        title="End this session?"
        className="w-[390px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => complete(true)}
              className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {pending && <Loader2 size={12} className="animate-spin" />}
              End session &amp; mark done
            </button>
          </>
        }
      >
        <p className="p-4 text-[12px] leading-relaxed text-muted">
          This thread is still running. Marking it done will stop its agent session, then move it to Done.
        </p>
      </Dialog>
    </>
  )
}
