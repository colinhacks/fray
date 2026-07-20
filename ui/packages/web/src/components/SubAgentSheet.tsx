import { useEffect, useMemo, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { X } from "lucide-react"
import { store, markDrawerClosing, removeDrawerAfterExit } from "../store.ts"
import { registerDrawerClose } from "../lib/overlays.ts"
import { useSubAgentTranscript } from "../hooks.ts"
import { Message } from "./ChatView.tsx"
import { formatElapsedMinutes } from "../lib/durationLabels.ts"

// One SUB-AGENT layer of the side-drawer stack: a right sheet (same slide/backdrop family as the
// thread sheet) showing a live/stale sub-agent's OWN transcript, READ-ONLY — no composer, no answering,
// no action bar. It overlays whatever thread it was drilled into; closing reveals the thread beneath.
// `depth` insets each successive layer so the stack reads as a stack.
//
// INSTANT OPEN: the frame + header + spinner mount and paint IMMEDIATELY; the heavy transcript body is
// deferred one frame (bodyReady) so the click→sheet-visible latency isn't gated on parsing/rendering a
// large transcript. The spinner covers the gap.
const CLOSE_MS = 210
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

// Coarse elapsed since an ISO dispatch time: "just now", "12m", "1h 3m". Empty when unparseable.
function elapsed(startedAt: string | undefined): string {
  if (!startedAt) return ""
  const t = Date.parse(startedAt)
  if (!Number.isFinite(t)) return ""
  const mins = Math.floor((Date.now() - t) / 60_000)
  return formatElapsedMinutes(mins)
}

export function SubAgentSheet({
  id,
  slug,
  subId,
  label,
  subagentType,
  startedAt,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  subId: string
  label: string
  subagentType?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  const [shown, setShown] = useState(false)
  const closingRef = useRef(false)
  // Deferred heavy body — mount the shell first, render the transcript one frame later (see header).
  const [bodyReady, setBodyReady] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const snap = useSnapshot(store)

  const q = useSubAgentTranscript(slug, subId)
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  const state = q.data?.state
  // Unavailable = the RPC errored (e.g. a pre-restart server without this endpoint), the id is unknown
  // ("gone"), or a settled child (done/stale) whose transcript file is empty/cleaned. A RUNNING child
  // with no messages yet is just starting → a spinner, not "unavailable".
  const unavailable = q.isError || state === "gone" || (messages.length === 0 && (state === "done" || state === "stale"))

  // Slide-in on mount; defer the transcript body one MORE frame so the sheet paints instantly.
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      setShown(true)
      raf2 = requestAnimationFrame(() => setBodyReady(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [])

  // Open at the BOTTOM (the child's latest activity) and stick there as new content streams in while
  // the user is already near the bottom — scoped to the sheet's OWN scroller (never the page).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !bodyReady) return
    let pin = true
    const toBottom = () => {
      if (pin) el.scrollTop = el.scrollHeight
    }
    const onScroll = () => {
      pin = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(toBottom)
    for (const child of el.children) ro.observe(child)
    toBottom()
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [bodyReady])

  function close() {
    if (closingRef.current) return
    closingRef.current = true
    markDrawerClosing(id) // stop URL/topThreadSlug counting this layer the instant it slides out
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

  const stateLabel =
    state === "stale"
      ? "stale"
      : state === "gone"
        ? "unavailable"
        : state === "done"
          ? "finished"
          : state === "running"
            ? `running${elapsed(startedAt) ? ` ${elapsed(startedAt)}` : ""}`
            : ""

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
        {/* Header shell paints immediately (part of the instant-open shell). */}
        <header className="shrink-0 flex items-center gap-2.5 px-3 h-12 border-b border-border bg-panel">
          <div className="min-w-0 pl-1 flex-1 flex items-center gap-2">
            {subagentType && <span className="shrink-0 font-mono-keep text-[11px] text-muted/55">[{subagentType}]</span>}
            <span className="font-semibold truncate text-[14px]" title={label}>{label}</span>
            {stateLabel && <span className="shrink-0 text-[11.5px] text-muted/60 whitespace-nowrap">{stateLabel}</span>}
          </div>
          <button
            aria-label="Close"
            onClick={close}
            className="rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        </header>

        <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto">
          {unavailable ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
              Transcript unavailable (agent completed or cleaned up).
            </div>
          ) : !bodyReady || q.isLoading || messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          ) : (
            <div className="flex flex-col gap-3.5 px-6 py-5">
              {messages.map((m, i) => (
                <Message key={i} m={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
