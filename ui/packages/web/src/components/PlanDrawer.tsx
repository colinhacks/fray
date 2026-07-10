import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { FilePlus2, X } from "lucide-react"
import { store, openNewThread, markDrawerClosing } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { registerDrawerClose } from "../lib/overlays.ts"
import { mdToHtml } from "../lib/markdown.ts"

// The PLAN drawer: a RIGHT side sheet (same slide/backdrop family as the fray-document and Open-thread
// sheets) rendering a plan artifact's markdown (.fray/plans/*.md — no schema, prompted into existence).
// A quiet header affordance "New thread from plan" opens the New-thread modal seeded with this plan's
// path, so the dispatch carries planPath and the worker is oriented to the plan. Plan content is
// agent-written and thus only semi-trusted — rendered through the shared allowlist sanitizer.
const CLOSE_MS = 210
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export function PlanDrawer({ id, path, title, depth }: { id: number; path: string; title: string; depth: number }) {
  const [shown, setShown] = useState(false)
  const closingRef = useRef(false)
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
      store.drawers = store.drawers.filter((d) => d.id !== id)
    }, prefersReducedMotion() ? 0 : CLOSE_MS)
  }

  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const html = useMemo(() => mdToHtml(body.data?.markdown ?? ""), [body.data?.markdown])

  return (
    <div
      className={`fixed inset-0 flex justify-end bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
      onMouseDown={close}
    >
      <div
        className={`h-full flex flex-col border-l border-border bg-panel shadow-2xl shadow-black/50 transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}
        style={{ width: `min(${720 - depth * 28}px, ${80 - depth * 4}vw)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 border-b border-border px-5 h-12">
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate text-[13px]" title={title}>{title}</div>
            <div className="text-[10px] text-muted/60 truncate">{path}</div>
          </div>
          <button
            onClick={() => openNewThread(path)}
            onMouseDown={(e) => e.preventDefault()}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-panel-2 px-2.5 py-1 text-[11.5px] font-medium text-fg outline-none transition-colors hover:bg-elevated"
            title="Start a new thread from this plan"
          >
            <FilePlus2 size={13} /> New thread from plan
          </button>
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
      </div>
    </div>
  )
}
