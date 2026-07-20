import React, { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { canRestart, canUpdateRestart, FRAY_SUPERVISOR_STATUS_WAKE_EVENT, getFraySupervisorStatus, requestFrayRestart, requestFrayUpdateRestart } from "../api/restart.ts"
import { showToast, store } from "../store.ts"

// RefreshCw's arrowheads advance clockwise, matching Tailwind's clockwise animate-spin keyframes.
// Keep this exported contract covered by the focused component test when either icon or animation changes.
export const UPDATE_RESTART_ICON_ROTATION = "clockwise"

const updateCopy = "Install the latest version of Fray. Your running threads will not be affected."
const restartCopy = "Restart the Fray UI. Your running threads will not be affected."

export function UpdateRestartPopover({
  open,
  update,
}: {
  open: boolean
  update: boolean
}) {
  if (!open) return null
  const action = update ? "Update Fray" : "Restart Fray"
  return (
    <div
      id="update-restart-popover"
      role="tooltip"
      aria-label={action}
      className="fixed left-3 right-3 top-12 z-50 w-auto rounded-xl border border-border-strong bg-elevated p-3.5 text-left font-sans shadow-xl shadow-black/45 sm:absolute sm:left-auto sm:right-0 sm:top-[calc(100%+0.65rem)] sm:w-[min(23rem,calc(100vw-1.5rem))]"
    >
      <span aria-hidden="true" className="absolute -top-1.5 right-7 h-3 w-3 rotate-45 border-l border-t border-border-strong bg-elevated" />
      <div className="relative flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/10 text-fg">
          <RefreshCw aria-hidden="true" size={14} strokeWidth={2.25} />
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">{action}</span>
      </div>
      <p className="relative mt-2.5 text-[12px] leading-relaxed text-muted">{update ? updateCopy : restartCopy}</p>
    </div>
  )
}

export function RestartActionButton({
  update,
  busy,
  onFocus,
  onBlur,
  onClick,
}: {
  update: boolean
  busy: boolean
  onFocus?: () => void
  onBlur?: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-describedby="update-restart-popover"
      aria-label={update ? "Update Fray" : "Restart Fray"}
      disabled={busy}
      aria-busy={busy || undefined}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg outline-none transition-colors hover:bg-panel focus-visible:ring-2 focus-visible:ring-fg/70 disabled:opacity-55"
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      <RefreshCw size={14} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
    </button>
  )
}

/** Global recovery action. It stays mounted in App chrome even when the app child is unhealthy. */
export function RestartFrayButton() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const controlRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    void getFraySupervisorStatus().then((status) => {
      if (!active) return
      setAvailable(canRestart(status))
      setUpdateAvailable(canUpdateRestart(status))
    })
    return () => { active = false }
  }, [])

  if (available !== true) return null

  const updateAndRestart = async () => {
    if (busy) return
    setOpen(false)
    setBusy(true)
    setError(undefined)
    const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (updateAvailable) {
      // Raise the blocking overlay the instant the click lands — the update-restart POST can round-trip
      // slowly while the supervisor spins up the candidate build, and the user must see the block now,
      // not a second later. `restartPending` holds it across the pre-ack window and withholds the reload
      // destination until the supervisor has actually accepted the transition (armed below), so a stray
      // status poll can neither drop the overlay nor reload onto the still-live old child.
      store.controlPlaneState = "restarting"
      store.controlPlaneMessage = null
      store.controlPlaneRestartPending = true
    }
    try {
      if (updateAvailable) await requestFrayUpdateRestart()
      else await requestFrayRestart()
      // Do not reload onto the same old child while an immutable candidate is still building. App's
      // supervisor monitor reloads this exact route only after the durable owner reports readiness.
      if (updateAvailable) {
        // Arm the reload destination now that the supervisor owns the transition, and ramp the poll.
        // `restartPending` is deliberately NOT cleared here: it must outlive the ack until a poll
        // OBSERVES the server-confirmed transition (a non-"ready" status), so a stale in-flight poll
        // that captured the pre-flip "ready" can't slip past the guard and reload onto the old child.
        sessionStorage.setItem("fray:reload-after-update-restart", destination)
        window.dispatchEvent(new Event(FRAY_SUPERVISOR_STATUS_WAKE_EVENT))
        setBusy(false)
      } else {
        window.location.replace(destination)
      }
    } catch (caught) {
      if (updateAvailable) {
        store.controlPlaneRestartPending = false
        store.controlPlaneState = "ready"
        store.controlPlaneMessage = null
      }
      const message = (caught as Error).message.slice(0, 140)
      setBusy(false)
      setError(message)
      showToast(`${updateAvailable ? "Update & Restart" : "Restart Fray"} failed: ${message}`)
    }
  }

  return (
    <div ref={controlRef} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <RestartActionButton
        update={updateAvailable}
        busy={busy}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => void updateAndRestart()}
      />
      {error && <p role="alert" className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(23rem,calc(100vw-1.5rem))] rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-200">{error}</p>}
      <UpdateRestartPopover open={open && !error} update={updateAvailable} />
    </div>
  )
}
