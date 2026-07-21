import { useEffect, useRef } from "react"
import { RefreshCw } from "lucide-react"

// The default copy shown while the supervisor rebuilds and promotes a fresh Fray artifact. The
// supervisor may hand us a more specific `message`; when it does we show that as the sub-line.
const RESTART_HEADING = "Updating and restarting Fray"
const RESTART_BODY =
  "This may take a moment while the new build is being prepared. All of your threads will continue running normally."

// Keys swallowed while the overlay is up, so no background control can be reached or activated:
//  • Tab / Shift+Tab — the crux. Focus is parked on the overlay card and Tab is killed, so keyboard
//    focus can NEVER land on a control behind the scrim (a native <button> fires its click on the
//    Space keyup, which no keydown guard sees — the only durable seal is to keep it unfocusable).
//    This covers portaled surfaces (Radix dialogs/menus) that live outside the inert app subtree too.
//  • Enter — a composer submit, belt-and-suspenders with the blur/focus move.
//  • ⌘/Ctrl + K/I — the global palette/doc chords (App.tsx), which would otherwise open surfaces
//    behind the scrim. NOT N: ⌘N is the browser's new-window shortcut and fray no longer binds it,
//    so swallowing it here would hijack the browser for no gain.
// The rpc-layer mutation gate remains as a final backstop; between these, the "Fray is restarting"
// red error is unreachable through ordinary interaction.
function swallowsInteractionKey(event: KeyboardEvent): boolean {
  if (event.key === "Tab" || event.key === "Enter") return true
  const meta = event.metaKey || event.ctrlKey
  if (meta) {
    const key = event.key.toLowerCase()
    if (key === "k" || key === "i") return true
  }
  return false
}

/**
 * Full-viewport blocking modal shown for the entire rebuild+reload window. Unlike the frosted
 * dialogs, this is a HARD block: it grays out the whole app, intercepts every pointer path through
 * its scrim, parks focus on itself and neutralizes the focus/activation keys — the user simply
 * cannot act until Fray is ready, at which point App reloads this exact route. Sits at z-[300], above
 * ALL app chrome and every modal (the tallest of which — the shared Radix Dialog — is z-[200]).
 */
export function RestartOverlay({ open, message }: { open: boolean; message?: string | null }) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Move focus off any composer/textarea onto the overlay itself, so a stray Enter/Space can't
    // reach a background control before the key guard sees it, and screen readers land in-dialog.
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    cardRef.current?.focus({ preventScroll: true })
    const guard = (event: KeyboardEvent) => {
      if (!swallowsInteractionKey(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener("keydown", guard, { capture: true })
    return () => window.removeEventListener("keydown", guard, { capture: true })
  }, [open])

  if (!open) return null

  // A cleaned-up supervisor message reads as a status sub-line under the default body; drop anything
  // that is empty or just repeats the heading noise.
  const detail = message?.trim() ? message.trim() : null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={RESTART_HEADING}
      // z-[300] beats the shared Radix Dialog (z-[200]) so a dialog already open when a
      // supervisor-initiated restart begins is covered, not tied. A heavier black wash than the
      // frosted dialogs (black/55 vs /30) reads as a genuine block; the scrim captures pointer events.
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/55 px-4 backdrop-blur-md backdrop-saturate-150"
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        className="w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-border-strong bg-elevated p-6 text-center shadow-2xl shadow-black/60 outline-none"
      >
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-fg/10 text-fg">
          <RefreshCw size={20} strokeWidth={2.25} className="animate-spin" aria-hidden="true" />
        </span>
        <h2 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-fg">{RESTART_HEADING}</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{RESTART_BODY}</p>
        {/* Only the supervisor's changing status line is a live region, so a screen reader isn't
            re-read the whole dialog each poll; alertdialog already announces the rest once on open. */}
        {detail && <p aria-live="polite" className="mt-2 text-[11.5px] leading-relaxed text-muted/80">{detail}</p>}
      </div>
    </div>
  )
}
