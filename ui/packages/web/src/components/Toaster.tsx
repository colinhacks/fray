import { useEffect, useState } from "react"
import { useSnapshot } from "valtio"
import { Loader2 } from "lucide-react"
import { store, pushDrawer } from "../store.ts"

// Minimal toast (no dep): rises in at the BOTTOM RIGHT, holds, then sinks back down and fades.
// Each showToast bumps the id, which re-arms the timer so a repeat message ("Steered", "Steered")
// flashes again. Variants: `spinner` (in-flight feel), `sticky` (no auto-hide — replaced by the
// next toast, e.g. "Starting agent…" → the started confirmation), and `link` (a button that opens
// the named thread in the side drawer).
export function Toaster() {
  const snap = useSnapshot(store)
  const toast = snap.toast
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!toast) return
    setVisible(true)
    if (toast.sticky) return
    const t = setTimeout(() => setVisible(false), toast.duration ?? (toast.link ? 5000 : 1600))
    return () => clearTimeout(t)
  }, [toast?.id])

  if (!toast) return null
  return (
    <div className={`fixed bottom-4 right-4 z-[70] flex justify-end ${toast.link ? "" : "pointer-events-none"}`}>
      <div
        className={`flex items-center gap-2.5 rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[13px] font-medium text-fg shadow-xl shadow-black/40 transition-all duration-200 ease-out ${
          visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        }`}
      >
        {toast.spinner && <Loader2 size={13} className="animate-spin text-muted" />}
        {toast.text}
        {toast.link && (
          <button
            onClick={() => {
              pushDrawer("thread", toast.link!.slug)
              store.toast = null
            }}
            className="rounded-md border border-border px-2 py-0.5 text-[12px] text-fg/90 transition-colors hover:bg-panel-2"
          >
            {toast.link.label}
          </button>
        )}
      </div>
    </div>
  )
}
