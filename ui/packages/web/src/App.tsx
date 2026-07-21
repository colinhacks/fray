import { useEffect, useRef } from "react"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { Settings as SettingsIcon } from "lucide-react"
import { closeGithubPicker, store, seedBoard, threadBySlug, pushDrawer, topDrawer, topThreadSlug, showToast } from "./store.ts"
import { useBoard } from "./hooks.ts"
import { displayTitle } from "./groups.ts"
import { closeSettingsAnimated, closeDrawerAnimated } from "./lib/overlays.ts"
import { startRouter } from "./lib/router.ts"
import { dismissOpenSelect } from "./lib/selectOverlay.ts"
import { nextSidebarPresence, type SidebarPresence } from "./lib/sidebarPresence.ts"
import { rpc } from "./api/rpc.ts"
import { Sidebar, IdentityMark, projectIdentity } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { ThreadSheet } from "./components/ThreadSheet.tsx"
import { SubAgentSheet } from "./components/SubAgentSheet.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { NewThreadDialog } from "./components/NewThreadModal.tsx"
import { GithubPickerModal } from "./components/GithubPickerModal.tsx"
import { ThreadDrawer } from "./components/ThreadDrawer.tsx"
import { PlanDrawer } from "./components/PlanDrawer.tsx"
import { SettingsDrawer } from "./components/SettingsDrawer.tsx"
import { CommandPalette } from "./components/CommandPalette.tsx"
import { StatusListView } from "./components/StatusListView.tsx"
import { NoFray } from "./components/EmptyState.tsx"
import { RestartFrayButton } from "./components/RestartFrayButton.tsx"
import { RestartOverlay } from "./components/RestartOverlay.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { FRAY_SUPERVISOR_STATUS_WAKE_EVENT, getFraySupervisorStatus } from "./api/restart.ts"

const RELOAD_AFTER_UPDATE_RESTART = "fray:reload-after-update-restart"

// The not-signed-in hint fires at most once per page load. A module-scoped flag (not React state)
// keeps it from re-firing across re-renders, effect re-runs, or a StrictMode double-invoke.
let signInHintShown = false
function maybeShowSignInHint() {
  if (signInHintShown) return
  signInHintShown = true
  showToast("Sign in to the GitHub CLI (`gh auth login`) to dispatch from issues/PRs.", { duration: 6000 })
}

export function App() {
  const snap = useSnapshot(store)
  const sidebarPresence = useRef<SidebarPresence>({ projectDir: null, hasBeenVisible: false })

  // Seed the board once at startup so the first paint doesn't wait on the SSE connect; SSE keeps it
  // fresh afterward. seedBoard (not setBoard) so a late-resolving seed can't clobber a board the SSE
  // stream has already established + advanced with deltas.
  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [])

  // URL ⇄ view sync (deep links, reload restore, shareable paths).
  useEffect(() => startRouter(), [])

  // The public supervisor survives replacement of the app child. It is consequently the only
  // trustworthy transition signal: an old child can still say ready while the next artifact builds.
  // Poll gently at rest and promptly during a handoff; writes are gated in rpc.ts but drafts remain
  // session-backed and editable throughout.
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let announcedFailure: string | null = null
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      const status = await getFraySupervisorStatus()
      if (!active) { polling = false; return }
      if (status) {
        // An optimistic, user-initiated restart raised the overlay before the supervisor confirmed the
        // transition. HOLD it until a poll actually OBSERVES a server-confirmed non-"ready" status: a
        // "ready" read while pending is either the pre-flip state or a stale in-flight response, and
        // applying it would drop the overlay and (with a destination armed) reload onto the old child.
        // The moment a poll sees "restarting"/"failed", the optimism is server-backed — clear the hold.
        if (store.controlPlaneRestartPending) {
          if (status.state !== "ready") {
            store.controlPlaneRestartPending = false
            store.controlPlaneState = status.state
            store.controlPlaneMessage = status.message ?? null
          }
        } else {
          store.controlPlaneState = status.state
          store.controlPlaneMessage = status.message ?? null
        }
        const destination = sessionStorage.getItem(RELOAD_AFTER_UPDATE_RESTART)
        if (status.state === "ready" && destination && !store.controlPlaneRestartPending) {
          sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
          window.location.replace(destination)
          polling = false
          return
        }
        if (status.state === "failed" && destination) {
          sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
          if (announcedFailure !== status.message) {
            announcedFailure = status.message ?? "Update & Restart failed"
            showToast(`Update & Restart failed: ${announcedFailure}`, { duration: 7000 })
          }
        }
      }
      polling = false
      timer = setTimeout(poll, store.controlPlaneState === "restarting" ? 500 : 8_000)
    }
    const wake = () => {
      if (timer) clearTimeout(timer)
      void poll()
    }
    window.addEventListener(FRAY_SUPERVISOR_STATUS_WAKE_EVENT, wake)
    void poll()
    return () => {
      active = false
      window.removeEventListener(FRAY_SUPERVISOR_STATUS_WAKE_EVENT, wake)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // While ANY overlay is open (thread sheet, doc drawer, settings, new-thread modal, palette), the
  // PAGE must not scroll — only the overlay's own pane does.
  const overlayOpen = snap.drawers.length > 0 || snap.showSettings || snap.showNewThread || snap.showGithubPicker || snap.showPalette
  useEffect(() => {
    // Scroll lock via the body-fixed dance, NOT overflow:hidden on the root — hiding root overflow
    // dropped the scrollbar (and with it the layout width) every time a drawer opened. With the
    // track permanently reserved (html overflow-y: scroll) and the body pinned at its scroll
    // offset, locking is pixel-invisible; unlocking restores the exact scroll position.
    if (!overlayOpen) return
    const y = window.scrollY
    const body = document.body
    body.style.position = "fixed"
    body.style.top = `-${y}px`
    body.style.left = "0"
    body.style.right = "0"
    body.style.width = "100%"
    return () => {
      body.style.position = ""
      body.style.top = ""
      body.style.left = ""
      body.style.right = ""
      body.style.width = ""
      window.scrollTo(0, y)
    }
  }, [overlayOpen])

  // Mirror settings.notifications onto the store so the (React-free) SSE handler can gate desktop
  // notifications. Refetched whenever the settings query is invalidated (e.g. after a save).
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  useEffect(() => {
    store.notificationsEnabled = settings.data?.notifications ?? false
  }, [settings.data?.notifications])

  // GitHub availability drives two things: the picker TRIGGER (in the sidebar / brand-new view, gated
  // in GithubTrigger off this same cached query) and — when the repo IS a GitHub repo but gh is NOT
  // signed in — ONE subtle, self-fading hint on app open nudging the user to `gh auth login`. The hint
  // fires at most once per page load (a module flag survives re-renders / StrictMode double-invoke),
  // stays a beat longer than a normal toast so it's readable, and never nags again.
  const github = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  useEffect(() => {
    if (github.data?.inRepo && !github.data.authed) maybeShowSignInHint()
  }, [github.data?.inRepo, github.data?.authed])

  // THE KEYBOARD MODEL (post-machine): the sidebar is mouse-driven and text surfaces own their own
  // keys, so the app-level keyboard reduces to global chords + Esc unwinding:
  //   ⌘K palette (its "New thread" item opens the modal) · ⌘I fray-doc drawer for the topmost thread
  //   NOTE: no ⌘N binding. ⌘N is the BROWSER's new-window shortcut — reserved, and ours to leave
  //   alone. Hijacking it either loses to the browser outright (a plain tab never delivers the event)
  //   or, in a standalone/PWA window, steals a system shortcut the user expects. New-thread keeps
  //   three doors that cost us nothing: ⌘K → "New thread", the sidebar pill, and the visible composer.
  //   Esc — overlays first (palette/modal/settings), then the drawer stack topmost-first
  //   Enter submits in a composer; Shift/Option-Enter newline (Composer's own handler)
  // (The xstate focus machine — nav selection, arrow-walk, chevron, step-in/out, focus registry — was
  // DELETED when the sidebar went mouse-only: the queue is always visible, clicking a row opens its
  // drawer, and a composer's Esc simply blurs it. No virtual focus, no zombie states.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The terminal is a native TUI surface. Its Escape/arrows/control keys and slash-menu input
      // belong to xterm, never to Fray's drawer/global shortcut layer.
      if (e.target instanceof Element && e.target.closest(".xterm")) return
      const meta = e.metaKey || e.ctrlKey
      if (meta) {
        const key = e.key.toLowerCase()
        if (key === "k") {
          e.preventDefault()
          store.showPalette = !store.showPalette
        } else if (key === "i") {
          // ⌘I: fray document for the topmost open thread (stacks another layer / pops its own).
          const top = topDrawer()
          const target = topThreadSlug()
          if (top?.kind === "doc") {
            e.preventDefault()
            if (!closeDrawerAnimated(top.id)) store.drawers.pop()
          } else if (target) {
            e.preventDefault()
            pushDrawer("doc", target)
          }
        }
        return
      }

      if (e.key === "Escape") {
        // Portaled selectors are not descendants of their owning dialog/drawer. Give the topmost
        // model/effort matrix or Select this physical Escape before unwinding the app overlay stack.
        if (dismissOpenSelect()) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          return
        }
        // Overlays soak up Esc first (outermost wins). A focused composer handles its own Esc (blur)
        // and stops propagation, so reaching here means the page is at rest. Settings + the
        // open-thread sheet route through their OWN animated close (fall back to the store write if
        // nothing registered) so Esc slides them out instead of unmounting instantly.
        if (store.showPalette) store.showPalette = false
        else if (store.showNewThread) store.showNewThread = false
        else if (store.showGithubPicker) closeGithubPicker()
        else if (store.showSettings) { if (!closeSettingsAnimated()) store.showSettings = false }
        // The drawer STACK unwinds topmost-first, one layer per Esc.
        else if (store.drawers.length > 0) {
          const top = store.drawers[store.drawers.length - 1]
          if (!closeDrawerAnimated(top.id)) store.drawers.pop()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const board = useBoard()
  sidebarPresence.current = nextSidebarPresence(sidebarPresence.current, board)
  const showSidebar = board !== null && sidebarPresence.current.hasBeenVisible
  // A missing board is not evidence that this project is named "fray". Keep the header neutral until
  // a board keyframe supplies an actual owner/repo identity; reconnects retain their adopted board.
  const identity = projectIdentity(board)

  // Window title carries the project identity. In the INSTALLED APP window (display-mode:
  // standalone) Chrome prefixes the title bar with the app name itself ("Fray - <title>"), so the
  // page title must NOT repeat the wordmark — just the repo label ("Fray - nubjs/nub"). In an
  // ordinary browser tab there's no prefix, so the title carries the wordmark ("fray · nubjs/nub").
  const projectLabel = board?.projectLabel ?? board?.projectName
  useEffect(() => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    document.title = standalone ? (projectLabel ?? "fray") : projectLabel ? `fray · ${projectLabel}` : "fray"
  }, [projectLabel])

  if (board && !board.frayActive) return (
    <TooltipProvider>
      <RestartOverlay open={snap.controlPlaneState === "restarting"} message={snap.controlPlaneMessage} />
      {/* While restarting, the whole app subtree goes inert so nothing behind the scrim is focusable
          or clickable; the overlay is rendered as a sibling OUTSIDE it so it stays interactive. */}
      <div inert={snap.controlPlaneState === "restarting"}>
        <div className="fixed top-3 right-3 z-20"><RestartFrayButton /></div>
        <NoFray dir={board.projectDir} />
        <Toaster />
      </div>
    </TooltipProvider>
  )

  return (
    <TooltipProvider>
    <RestartOverlay open={snap.controlPlaneState === "restarting"} message={snap.controlPlaneMessage} />
    {/* While restarting, the whole app subtree goes inert so nothing behind the scrim is focusable or
        clickable; the overlay above is a sibling OUTSIDE it so it stays interactive. */}
    <div inert={snap.controlPlaneState === "restarting"} className="relative min-h-screen bg-bg text-fg text-sm">
      {/* Fixed corner chrome, as it always was: workspace identity + the New-thread pill top-left,
          the Settings gear top-right. Everything else flows; the PAGE is the one and only scroll
          container — a tall card simply runs off both edges. */}
      <div className="fixed top-3 left-4 z-20 max-w-[40vw]">
        <IdentityMark
          identity={identity}
          state={snap.connection}
          boardFallback={snap.socketBoardFallback}
        />
      </div>
      {/* (The old fixed "New thread" pill moved INTO the sidebar's top — one entry point, same modal
          flow; the ⌘K palette's "New thread" item and the always-visible dispatch box are the
          other doors — deliberately NOT ⌘N, which belongs to the browser.) */}
      <div className="fixed top-3 right-3 z-20 flex items-center gap-0.5">
        <RestartFrayButton />
        <button
          title="Settings"
          className="p-1.5 rounded text-fg hover:bg-panel"
          onClick={() => (store.showSettings = true)}
        >
          <SettingsIcon size={16} />
        </button>
      </div>

      {/* CENTERED PAIR with a FIXED GUTTER: the floating sidebar column and the workpane sit side by
          side with one constant 52px gap (gap-13 — "space-around looked weird"; a fixed gutter reads
          calmer, and 40px read too tight), and the PAIR as a unit centers horizontally — leftover
          space distributes on the far sides. The sidebar is VERTICALLY CENTERED in the viewport
          (sticky, set in Sidebar.tsx) and scales clamp(240px → 30vw → 600px) so titles get real room
          on large screens; the workpane keeps its readable 720px measure (shrinking first when space
          runs out) and scrolls as normal top-anchored page flow. */}
      <div className="flex min-h-screen justify-center gap-13 max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
        {/* A genuinely fresh project keeps its centered first-task view. Once this project has had a
            Fray-owned thread or plan, the sidebar remains mounted through transient empty keyframes;
            navigation must not vanish while the live board stream reconnects or catches up. */}
        {showSidebar && <Sidebar />}
        <main
          id="workpane"
          // min-h-screen where content is vertically CENTERED: the boot loader and the empty queue's
          // prompt box (TodosView's flex-1 centering needs a full-height parent); populated queues just
          // top-align and grow past. Threads render in DRAWERS, never here.
          className={`w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 max-[800px]:w-full max-[800px]:max-w-none ${
            snap.view === "todos" || !board ? "min-h-screen" : ""
          } ${
            // Queue recedes: the CARD carries its own chrome (a sticky header), so the bordered panel
            // frame drops away. Status lists (URL-only views) keep the panel on main.
            snap.view === "todos" ? "" : "rounded-lg border border-border bg-panel"
          }`}
        >
          {/* Until the first board snapshot lands, show a quiet loader — NEVER a view's empty state
              (which would flash "Nothing pending" on every hard reload). Only board !== null renders
              real views. */}
          {!board ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          ) : (
            <>
              {snap.view.startsWith("status:") && <StatusListView status={snap.view.slice(7)} />}
              {snap.view === "todos" && <TodosView />}
            </>
          )}
        </main>
      </div>

      {/* The side-drawer STACK: each layer above the last, arbitrary depth. Two DIFFERENT depths:
          `depth` = the layer's true stack position (array index) drives z-index — it must stay strictly
          monotonic so a layer always paints above everything below it, including the ~210ms window while
          a lower layer slides OUT. `widthDepth` = the count of layers below that are STAYING (non-closing)
          drives the width/inset (each step 28px narrower). A closing layer keeps its array slot for its
          slide-out, so counting it toward WIDTH made the layer above open one step too narrow, then JUMP
          wider (content reflow) the instant the closer was removed; excluding it lets the new layer render
          at its FINAL width and slide in from off-screen with no end-of-animation reflow. z and width are
          decoupled because ThreadSheet alone is portaled + split-z (overlay/content) while the others are
          single-z inline — tying z to the non-closing count let a closing ThreadSheet outrank a drawer
          opened above it. */}
      {(() => {
        let below = 0
        return snap.drawers.map((d, i) => {
          const widthDepth = below
          if (!d.closing) below++
          return d.kind === "thread" ? (
            <ThreadSheet key={d.id} id={d.id} slug={d.slug} depth={i} widthDepth={widthDepth} initiallyOpen={d.routed} />
          ) : d.kind === "subagent" ? (
            <SubAgentSheet
              key={d.id}
              id={d.id}
              slug={d.slug}
              subId={d.subId ?? ""}
              label={d.label ?? d.slug}
              subagentType={d.subagentType}
              startedAt={d.startedAt}
              depth={i}
              widthDepth={widthDepth}
            />
          ) : d.kind === "plan" ? (
            <PlanDrawer key={d.id} id={d.id} path={d.path ?? d.slug} title={d.label ?? d.slug} depth={i} widthDepth={widthDepth} />
          ) : (
            <ThreadDrawer
              key={d.id}
              id={d.id}
              slug={d.slug}
              depth={i}
              widthDepth={widthDepth}
              title={(() => { const t = threadBySlug(board, d.slug); return t ? displayTitle(t) : d.slug })()}
            />
          )
        })
      })()}
      {snap.showSettings && <SettingsDrawer />}
      {snap.showNewThread && <NewThreadDialog onClose={() => { store.showNewThread = false; store.newThreadPlanPath = null }} />}
      {snap.showGithubPicker && snap.githubDispatchProfile && (
        <GithubPickerModal profile={{ ...snap.githubDispatchProfile }} onClose={closeGithubPicker} />
      )}
      <CommandPalette />
      <Toaster />
    </div>
    </TooltipProvider>
  )
}
