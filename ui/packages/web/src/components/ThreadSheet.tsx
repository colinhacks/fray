import { useEffect, useRef, useState } from "react"
import { store, threadBySlug, markDrawerClosing } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { registerDrawerClose } from "../lib/overlays.ts"
import { ThreadView, type ThreadTab } from "./ChatView.tsx"

// One THREAD layer of the side-drawer stack: a right sheet (same slide/backdrop family as settings)
// showing a thread's FULL view as an OVERLAY — the queue (and any layers below) keep their scroll and
// state; closing just reveals what's underneath. Chat/Terminal is LOCAL to the layer. `depth` insets
// each successive layer a step further from the right edge so the stack reads as a stack.
const CLOSE_MS = 210
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export function ThreadSheet({ id, slug, depth, initialTerminal }: { id: number; slug: string; depth: number; initialTerminal?: boolean }) {
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  // INSTANT OPEN: the sheet frame + spinner paint immediately; the heavy body (ChatView — a 100KB+
  // transcript, markdown, diff highlighting) is deferred until AFTER the first paint so click→visible
  // isn't gated on rendering it. The spinner covers the one-frame gap.
  const [bodyReady, setBodyReady] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Opening a thread IS reading it: fire threadSeen (session-first interaction clearance — records
  // seen_at, which clears the thread from the Needs-you queue, AND marks read server-side). RE-FIRE on
  // activity WHILE the drawer is open: the human is looking at it, so new activity must not re-arm the
  // queue underneath them. Gated on the thread being AT REST — mid-turn, lastActivityAt moves every
  // tailer tick but needsYou is already false (not at rest), so per-tick re-fires were pure DB/refresh
  // churn; the queue can only re-arm at the moment the turn ENDS, which flips runtime to turn-idle and
  // re-runs this effect exactly once. Idempotent, fire-and-forget; the board push settles the sections.
  const board = useBoard()
  const t = threadBySlug(board, slug)
  const atRestNow = !t || t.runtime === "turn-idle" || t.runtime === "exited" || t.runtime === "none"
  const activityAt = atRestNow ? t?.lastActivityAt : undefined
  useEffect(() => {
    if (!atRestNow) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [slug, atRestNow, activityAt])

  // Open at the BOTTOM (the conversation tail is what you came for) and stick there as late
  // content streams in — but only while the user is already near the bottom, so scrolling up to
  // read history is never fought. ResizeObserver covers async transcript loading. Re-attaches once
  // the deferred body mounts (bodyReady) so it observes the real content, not the spinner.
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
  // Layer-local Chat/Terminal/Doc tab (independent of any other layer).
  const [tab, setTab] = useState<ThreadTab>(initialTerminal ? "terminal" : "chat")

  // Slide the frame in on the next frame; defer the heavy body one MORE frame so the shell paints
  // first (instant open) and the transcript render doesn't gate click→visible.
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

  function close() {
    if (closing) return
    setClosing(true)
    markDrawerClosing(id) // stop URL/topThreadSlug counting this layer the instant it slides out
    setShown(false)
    window.setTimeout(() => {
      store.drawers = store.drawers.filter((d) => d.id !== id)
    }, prefersReducedMotion() ? 0 : CLOSE_MS)
  }

  // Register the animated close for App's Esc handler (topmost-first unwinding).
  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return (
    <div
      className={`fixed inset-0 flex justify-end bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
      onMouseDown={close}
    >
      <div
        ref={scrollerRef}
        className={`h-full flex flex-col overflow-y-auto border-l border-border bg-panel shadow-2xl shadow-black/50 transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}
        style={{ width: `min(${720 - depth * 28}px, ${80 - depth * 4}vw)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {bodyReady ? (
          // Mark-as CONFIRMED (any status) → the drawer closes: the thread just left the state the
          // human was looking at it for (maintainer directive).
          <ThreadView slug={slug} tab={tab} onTab={setTab} onStatusApplied={close} onClose={close} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}
