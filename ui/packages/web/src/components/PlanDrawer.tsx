import { useEffect, useMemo, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { FilePlus2, Loader2, Trash2, X } from "lucide-react"
import { store, openNewThread, markDrawerClosing, removeDrawerAfterExit, showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { registerDrawerClose } from "../lib/overlays.ts"
import { mdToHtml } from "../lib/markdown.ts"
import { Dialog } from "./ui/Dialog.tsx"
import {
  PLAN_DRAWER_ACTION_ARIA_LABEL,
  PLAN_DRAWER_ACTION_LABEL,
  PLAN_DRAWER_ACTION_TITLE,
  PLAN_DRAWER_DELETE_ARIA_LABEL,
  PLAN_DRAWER_DELETE_LABEL,
  PLAN_DRAWER_DELETE_TITLE,
  PLAN_DRAWER_FOOTER_STYLE,
} from "./planDrawerAction.ts"

// The PLAN drawer: a RIGHT side sheet (same slide/backdrop family as the fray-document and Open-thread
// sheets) rendering a plan artifact's markdown (.fray/plans/*.md — no schema, prompted into existence).
// A footer affordance "Implement this" opens the New-thread modal seeded with this plan's path, so
// the dispatch carries planPath and the worker is oriented to the plan. Plan content is
// agent-written and thus only semi-trusted — rendered through the shared allowlist sanitizer.
const CLOSE_MS = 210

// Right-justified footer action, styled like the whole-thread "Mark as done" button (compact, bordered,
// not full width) rather than a full-bleed primary bar.
export function PlanDrawerAction({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
      title={PLAN_DRAWER_ACTION_TITLE}
      aria-label={PLAN_DRAWER_ACTION_ARIA_LABEL}
    >
      <FilePlus2 size={12} aria-hidden="true" /> {PLAN_DRAWER_ACTION_LABEL}
    </button>
  )
}

// A quiet Delete affordance sitting left of "Implement this". Deleting a plan is irreversible, so it
// confirms through a Dialog before the mutation; on success it closes the drawer (the .fray watcher
// drops the plan from the board).
export function PlanDeleteAction({ path, onDeleted }: { path: string; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const apply = () => {
    setBusy(true)
    rpc
      .planDelete({ path })
      .then(() => {
        setConfirmOpen(false)
        showToast("Plan deleted")
        onDeleted()
      })
      .catch((error) => showToast(`Couldn’t delete: ${(error as Error).message.slice(0, 80)}`))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        onMouseDown={(e) => e.preventDefault()}
        className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-muted outline-none transition-colors hover:bg-panel-2 hover:text-red-400 focus-visible:ring-1 focus-visible:ring-red-400/60"
        title={PLAN_DRAWER_DELETE_TITLE}
        aria-label={PLAN_DRAWER_DELETE_ARIA_LABEL}
      >
        <Trash2 size={12} aria-hidden="true" /> {PLAN_DRAWER_DELETE_LABEL}
      </button>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!busy) setConfirmOpen(open)
        }}
        title="Delete this plan?"
        className="w-[390px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={apply}
              className="flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1.5 text-[12px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              Delete plan
            </button>
          </>
        }
      >
        <p className="p-4 text-[12px] leading-relaxed text-muted">
          This permanently deletes the plan file <span className="text-fg/80">{path}</span>. This can’t be undone.
        </p>
      </Dialog>
    </>
  )
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export function PlanDrawer({ id, path, title, depth, widthDepth }: { id: number; path: string; title: string; depth: number; widthDepth: number }) {
  const [shown, setShown] = useState(false)
  const closingRef = useRef(false)
  const snap = useSnapshot(store)
  const body = useQuery({ queryKey: ["planBody", path], queryFn: () => rpc.planBody({ path }) })

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  function close() {
    if (closingRef.current) return
    closingRef.current = true
    markDrawerClosing(id)
    setShown(false)
    window.setTimeout(() => {
      removeDrawerAfterExit(id)
    }, prefersReducedMotion() ? 0 : CLOSE_MS)
  }

  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (snap.drawers.find((drawer) => drawer.id === id)?.closing || !closingRef.current) return
    closingRef.current = false
    setShown(true)
  }, [snap.drawers, id])

  const html = useMemo(() => mdToHtml(body.data?.markdown ?? ""), [body.data?.markdown])

  return (
    <div
      className={`fixed inset-0 flex justify-end bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
      onMouseDown={close}
    >
      <div
        className={`h-full flex flex-col border-l border-border bg-panel shadow-2xl shadow-black/50 transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}
        style={{ width: `min(${720 - widthDepth * 28}px, ${80 - widthDepth * 4}vw)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 border-b border-border px-5 h-12">
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate text-[13px]" title={title}>{title}</div>
            <div className="text-[10px] text-muted/60 truncate">{path}</div>
          </div>
          <button
            aria-label="Close"
            onClick={close}
            className="rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {body.isLoading ? (
            <div className="text-[13px] text-muted">Loading…</div>
          ) : html ? (
            <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <div className="text-[13px] text-muted">Empty plan.</div>
          )}
        </div>
        <div
          className="shrink-0 flex items-center justify-end gap-1.5 border-t border-border/60 bg-panel px-5 pt-3"
          style={PLAN_DRAWER_FOOTER_STYLE}
        >
          <PlanDeleteAction path={path} onDeleted={close} />
          <PlanDrawerAction onClick={() => openNewThread(path)} />
        </div>
      </div>
    </div>
  )
}
