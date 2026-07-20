import * as RadixDialog from "@radix-ui/react-dialog"
import { useCallback, useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { store, markDrawerClosing, removeDrawerAfterExit } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { registerDrawerClose, registerDrawerFocus } from "../lib/overlays.ts"
import {
  clampThreadTab,
  readThreadTab,
  resolveThreadTabCapabilities,
  writeThreadTab,
  type ScopedThreadTabCapabilities,
} from "../lib/threadTabState.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { DrawerInitialScrollCoordinator } from "../lib/drawerInitialScroll.ts"
import { ThreadView, type ThreadTab } from "./ChatView.tsx"

// One THREAD layer of the side-drawer stack: a right sheet (same slide/backdrop family as settings)
// showing a thread's FULL view as an OVERLAY — the queue (and any layers below) keep their scroll and
// state; closing just reveals what's underneath. Chat/Terminal is LOCAL to the layer. `depth` insets
// each successive layer a step further from the right edge so the stack reads as a stack.
const CLOSE_MS = 210
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

function useNarrowDrawer(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches)
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)")
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return narrow
}

export function ThreadSheet({ id, slug, depth, widthDepth, initiallyOpen }: { id: number; slug: string; depth: number; widthDepth: number; initiallyOpen?: boolean }) {
  // URL-created sheets exist before the first React paint. They must begin visible: waiting for a
  // post-mount animation frame left a full-screen opacity-0 backdrop mounted indefinitely on a cold
  // page, so the first apparent sidebar click actually closed that invisible sheet. Interaction-
  // created sheets retain the slide-in below.
  const [shown, setShown] = useState(initiallyOpen === true)
  const closingRef = useRef(false)
  // INSTANT OPEN: the sheet frame + spinner paint immediately; the heavy body (ChatView — a 100KB+
  // transcript, markdown, diff highlighting) is deferred until AFTER the first paint so click→visible
  // isn't gated on rendering it. The spinner covers the one-frame gap.
  const [bodyReady, setBodyReady] = useState(initiallyOpen === true)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const initialScrollRef = useRef<DrawerInitialScrollCoordinator | null>(null)
  const drawerSnap = useSnapshot(store)
  const drawerClosing = drawerSnap.drawers.find((drawer) => drawer.id === id)?.closing === true
  const activeDrawer = [...drawerSnap.drawers].reverse().find((drawer) => !drawer.closing)
  const isTopDrawer = activeDrawer?.id === id
  const narrow = useNarrowDrawer()
  // Sheets are store/route-mounted rather than opened by RadixDialog.Trigger. Preserve the focused
  // row/button (or the control in the layer below) so closing this stack layer restores it exactly.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(() => () => {
    const opener = openerRef.current
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }, 0)
  }, [])

  // A rapid second open cancels the exit in the store. Re-arm the mounted sheet and leave its old
  // timeout harmless (removeDrawerAfterExit only removes entries that are still closing).
  useEffect(() => {
    if (drawerClosing || !closingRef.current) return
    closingRef.current = false
    setShown(true)
  }, [drawerClosing])

  // Opening a thread IS reading it: record seen/read telemetry without acknowledging its lifecycle
  // handoff (resting queue cards stay present until follow-up, Snooze, or Archive). Re-fire only when
  // new activity reaches rest while the drawer is open so last_read_at reflects what was actually on
  // screen; mid-turn tailer churn is excluded. Idempotent and fire-and-forget.
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const t = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir
  const capabilityScope = projectDir ? `${projectDir}\0${slug}` : undefined
  const currentCapabilities = t
    ? { scratch: Boolean(t.scratchpadPath) }
    : undefined
  const rememberedCapabilitiesRef = useRef<ScopedThreadTabCapabilities | undefined>(undefined)
  const resolvedCapabilities = resolveThreadTabCapabilities(
    capabilityScope,
    currentCapabilities,
    rememberedCapabilitiesRef.current,
  )
  rememberedCapabilitiesRef.current = resolvedCapabilities.remembered
  const allowScratch = resolvedCapabilities.capabilities.scratch
  const atRestNow = t ? t.runtime === "turn-idle" || t.runtime === "exited" || t.runtime === "none" : false
  const activityAt = atRestNow ? t?.lastActivityAt : undefined
  useEffect(() => {
    if (!t || !atRestNow) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [slug, atRestNow, activityAt])

  // Initial tail focus is a one-shot settling phase. The sheet's direct flex child stays viewport-
  // height even while its scrollHeight grows, so observing that child misses async transcript render.
  // Observe the transcript surface itself plus subtree commits, and yield permanently on user intent.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !bodyReady) return
    const content = () => el.querySelector<HTMLElement>("[data-drawer-scroll-ready]")
    const transcriptScroller = () => el.querySelector<HTMLElement>("[data-drawer-transcript-scroll]")
    const coordinator = new DrawerInitialScrollCoordinator({
      isActive: () => [...store.drawers].reverse().find((drawer) => !drawer.closing)?.id === id,
      isContentReady: () => content()?.dataset.drawerScrollReady === "true",
      scrollToBottom: () => {
        const scroller = transcriptScroller()
        if (!scroller) return false
        scroller.scrollTop = scroller.scrollHeight
        return true
      },
      preserveAnchor: () => location.hash.length > 1,
    })
    initialScrollRef.current = coordinator

    let observedContent: HTMLElement | null = null
    const ro = new ResizeObserver(() => coordinator.layoutChanged())
    const observeContent = () => {
      const next = content()
      if (next !== observedContent) {
        if (observedContent) ro.unobserve(observedContent)
        observedContent = next
        if (next) ro.observe(next)
      }
      coordinator.layoutChanged()
    }
    const mo = new MutationObserver(observeContent)
    mo.observe(el, { attributes: true, attributeFilter: ["data-drawer-scroll-ready"], childList: true, subtree: true })

    const userIntent = () => coordinator.userIntent()
    const keyIntent = (event: KeyboardEvent) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) userIntent()
    }
    el.addEventListener("wheel", userIntent, { capture: true, passive: true })
    el.addEventListener("touchstart", userIntent, { capture: true, passive: true })
    el.addEventListener("pointerdown", userIntent, true)
    el.addEventListener("keydown", keyIntent, true)
    observeContent()

    return () => {
      coordinator.dispose()
      if (initialScrollRef.current === coordinator) initialScrollRef.current = null
      el.removeEventListener("wheel", userIntent, true)
      el.removeEventListener("touchstart", userIntent, true)
      el.removeEventListener("pointerdown", userIntent, true)
      el.removeEventListener("keydown", keyIntent, true)
      ro.disconnect()
      mo.disconnect()
    }
  }, [bodyReady, id])

  useEffect(() => {
    initialScrollRef.current?.activationChanged()
  }, [isTopDrawer])
  // Layer-local Chat/Doc tab (independent of any other layer).
  // A server replacement hard-reloads the client so its protocol/bundle matches the new child. Keep
  // the user's surface intent in sessionStorage: a Terminal user reconnects to Terminal instead of
  // being silently ejected to Chat (which looked exactly like a blank/dead terminal in dogfood).
  const loadedScopeRef = useRef<string | null>(projectDir && t ? capabilityScope ?? null : null)
  const [tab, setTabState] = useState<ThreadTab>(() => {
    // Do not read-and-clamp persisted intent until the concrete row establishes capabilities. During
    // boot, project metadata can precede that row; treating the gap as foreign destroyed `terminal`.
    if (!projectDir || !t) return "chat"
    return readThreadTab(projectDir, slug)
  })
  // Clamp only for rendering. `tab` remains the user's requested surface, so a temporary or
  // ownership-driven fallback cannot silently rewrite Terminal intent to Chat. Do not let an old
  // scope's request flash in a newly opened project/thread while its saved request is loading.
  const requestedTab = loadedScopeRef.current === capabilityScope ? tab : "chat"
  const effectiveTab = clampThreadTab(requestedTab, { scratch: allowScratch })
  const setTab = useCallback(
    (next: ThreadTab) => {
      // ThreadView only offers surfaces the current row owns. Persist explicit user choices; never
      // persist an automatic capability fallback.
      if (projectDir) writeThreadTab(projectDir, slug, next)
      setTabState(next)
    },
    [projectDir, slug],
  )

  useEffect(() => {
    // UNKNOWN capability (initial keyframe/delta gap) is deliberately inert: keep requested state and
    // a same-scope active xterm mounted. A concrete new scope restores its own requested tab. Concrete
    // foreign/legacy rows affect `effectiveTab` only; they do not mutate user intent in storage.
    if (!projectDir || !capabilityScope || !resolvedCapabilities.authoritative) return
    const scopeChanged = loadedScopeRef.current !== capabilityScope
    if (!scopeChanged) return
    loadedScopeRef.current = capabilityScope
    const requested = readThreadTab(projectDir, slug)
    if (requested !== tab) setTabState(requested)
  }, [
    projectDir,
    slug,
    capabilityScope,
    resolvedCapabilities.authoritative,
    tab,
  ])

  // Slide the frame in on the next frame; defer the heavy body one MORE frame so the shell paints
  // first (instant open) and the transcript render doesn't gate click→visible.
  useEffect(() => {
    if (initiallyOpen) return
    let raf2 = 0
    let bodyShown = false
    // Background/occluded Chrome windows can report `visibilityState === "visible"` while starving
    // requestAnimationFrame entirely. Do not leave an interaction-opened sheet as an invisible,
    // click-swallowing backdrop forever; the timer is only a starvation fallback.
    const fallback = window.setTimeout(() => {
      if (bodyShown || closingRef.current) return
      bodyShown = true
      setShown(true)
      setBodyReady(true)
    }, 120)
    const raf1 = requestAnimationFrame(() => {
      if (closingRef.current) return
      setShown(true)
      raf2 = requestAnimationFrame(() => {
        if (closingRef.current) return
        bodyShown = true
        window.clearTimeout(fallback)
        setBodyReady(true)
      })
    })
    return () => {
      window.clearTimeout(fallback)
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [initiallyOpen])

  // Interaction-opened sheets paint their frame before the heavy thread body. Focus the frame for
  // that first paint, then move to the explicit close affordance once the body arrives. For a cold
  // route (body already present), Radix focuses the close affordance immediately.
  useEffect(() => {
    const el = scrollerRef.current
    if (!bodyReady || !el || document.activeElement !== el) return
    const frame = requestAnimationFrame(() => {
      el.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
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

  // Register the animated close for App's Esc handler (topmost-first unwinding).
  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    registerDrawerFocus(id, () => {
      const initial = scrollerRef.current?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? scrollerRef.current
      initial?.focus({ preventScroll: true })
    })
    return () => registerDrawerFocus(id, null)
  }, [id])

  return (
    <RadixDialog.Root modal={narrow} open onOpenChange={(open) => { if (!open) close() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={`fixed inset-0 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
          style={{ zIndex: 50 + depth * 2 }}
        />
        <RadixDialog.Content
          ref={scrollerRef}
          aria-modal={narrow || undefined}
          aria-describedby={undefined}
          tabIndex={-1}
          onEscapeKeyDown={handleDialogEscape}
          // A non-modal Radix layer dismisses on focus-OUTSIDE by default. That fired the self-close
          // bug: opening a second thread from the sidebar dismisses THIS layer via pointer-down-outside
          // (expected), and ~210ms later its close restores focus to its opener row — a focusin OUTSIDE
          // the newly-opened layer, which Radix read as focus-outside and dismissed the new drawer too,
          // leaving nothing open. Focus movement must never close a drawer (modal layers preventDefault
          // this for the same reason); only the backdrop/outside POINTER and Esc do.
          onFocusOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const opener = openerRef.current
            if (opener?.isConnected) opener.focus({ preventScroll: true })
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const el = scrollerRef.current
            const initial = el?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? el
            initial?.focus({ preventScroll: true })
          }}
          className={`fixed right-0 top-0 h-full flex flex-col overflow-hidden border-l border-border bg-panel shadow-2xl shadow-black/50 outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}
          style={{ zIndex: 51 + depth * 2, width: `min(${720 - widthDepth * 28}px, ${80 - widthDepth * 4}vw)` }}
        >
          <RadixDialog.Title className="sr-only">
            {route.kind === "found" ? `Thread: ${displayTitle(route.thread)}` : `Thread: ${slug}`}
          </RadixDialog.Title>
          {bodyReady && route.kind === "found" ? (
            // Mark-as CONFIRMED (any status) → the drawer closes: the thread just left the state the
            // human was looking at it for (maintainer directive).
            <ThreadView slug={slug} tab={effectiveTab} onTab={setTab} onStatusApplied={close} onClose={close} />
          ) : bodyReady && route.kind === "missing" ? (
            <MissingThread slug={slug} onClose={close} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function MissingThread({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
        <span className="min-w-0 flex-1 truncate font-medium">Thread unavailable</span>
        <button type="button" aria-label="Close" data-dialog-initial-focus onClick={onClose} className="p-1 text-muted hover:text-fg">
          ×
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted" role="status">
        Thread “{slug}” was not found in this project.
      </div>
    </div>
  )
}
