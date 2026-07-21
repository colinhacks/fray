import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ChevronsUpDown, Inbox } from "lucide-react"
import type { ThreadView, BoardSnapshot } from "@fray-ui/shared"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { pushDrawer, queueCardTargetY, showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBoard, asThreads, useTranscript } from "../hooks.ts"
import { orderQueue, queued, displayTitle, lastActiveLabelAt } from "../groups.ts"
import { useLiveAnswering } from "../lib/answering.ts"
import { pairAllAnswers } from "../lib/answersMessage.ts"
import { Message, NativeInputRequiredCard, PermPromptBanner, PendingAskCard, StickyUserBand, VSpace, STEP, messageTailIsMeta, messageHeadIsMeta, messageRendersNothing, messageHasRenderableText } from "./ChatView.tsx"
import { prefs } from "../lib/prefs.ts"
import { Composer } from "./Composer.tsx"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { BackgroundOpsStrip, ThreadSlugContext } from "./ChatView.tsx"
import { HeaderActions } from "./HeaderActions.tsx"
import { ThreadLifecycleFooter } from "./ThreadLifecycleFooter.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { InteractionStack } from "./InteractionCards.tsx"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"
import { LastActive } from "./LastActive.tsx"
import { CopyTerminalCommandButton, useCopyTerminalCommand } from "./ExternalTerminalCommand.tsx"
import {
  captureTranscriptViewportAnchor,
  prependEarlierPage,
  previousUserBoundary,
  restoreTranscriptViewportAnchor,
  type TranscriptViewportAnchor,
} from "../lib/transcriptPagination.ts"
import type { TranscriptData } from "../hooks.ts"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"

// The Queue: everything currently waiting on the human, rendered as a SCROLLING LIST of cards — every
// pending item visible at once, one per card, in one vertical column that scrolls when it overflows.
// (This replaced a one-at-a-time pager/stack: with everything visible there is no paging, no peek, and
// no auto-advance — an item simply leaves the list when the board update drops its needs-action flag.)
//
// Each card's own header is STICKY (top-0 within the scroll container, opaque bg + bottom rule) so it
// pins to the viewport top while any part of the card is on screen and the body scrolls under it. The
// navigation/diagnostic actions remain in that header. Snooze and Archive have one compact,
// persistent footer row so completion hydration never moves or duplicates them.
//
// The exit budget (styles.css .fray-card-slot). A resolved card FADES + recedes (scale/blur) at full
// height, then TodosView UNMOUNTS it and adjusts the viewport (user dismissal → auto-scroll the next
// card to the top; board departure → pin a visible neighbour so nothing on screen shifts). There is
// no height-collapse phase (it drifted the neighbour — see styles.css). Keep in sync with the CSS fade.
const QUEUE_DISSOLVE_MS = 200
// How long a resolved card is KEPT MOUNTED after the board has dropped it, so the fade can finish before
// the unmount + neighbour pin. completeThread / setThreadStatus call ctx.board.refresh() SYNCHRONOUSLY
// (board.ts publish()), so the board delta that removes the thread races the RPC response — without this
// retention the card unmounts the instant the delta lands and no fade ever plays. 120ms of slack past the
// fade leaves margin in both exit paths (board-drop, or the next-frame arm when the board hasn't dropped).
const QUEUE_EXIT_MS = QUEUE_DISSOLVE_MS + 120

// Pick the on-screen neighbour whose position we hold fixed across a card's unmount — the PURE BOARD
// DEPARTURE path only (a card the agent/another client resolved, not a local action): a reader mid-card
// elsewhere must not have their viewport moved. Prefer the card IMMEDIATELY BEFORE the departing one
// (keeps the top of the reader's view stable while the cards below rise to fill), else the card
// IMMEDIATELY AFTER (the top-card case: nothing precedes it, so hold the successor). Only a
// currently-visible, non-leaving card qualifies; null when neither neighbour is on screen (e.g. the
// departing card fills the viewport) — then there is nothing to keep from shifting.
function captureNeighborPin(removingSlug: string): { slug: string; top: number } | null {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-queue-card]")]
  const i = cards.findIndex((el) => el.dataset.queueCard === removingSlug)
  if (i < 0) return null
  const vh = window.innerHeight
  const stableVisible = (el: HTMLElement | undefined): el is HTMLElement => {
    if (!el || el.dataset.queueLeaving === "true" || !el.dataset.queueCard) return false
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < vh
  }
  const anchor = stableVisible(cards[i - 1]) ? cards[i - 1] : stableVisible(cards[i + 1]) ? cards[i + 1] : null
  if (!anchor) return null
  return { slug: anchor.dataset.queueCard!, top: anchor.getBoundingClientRect().top }
}

// Pick the card the USER-INITIATED dismissal auto-scroll lands at the viewport top (maintainer
// 2026-07-21: "some card should be at the top of the screen after any action that dismisses a card").
// SUCCESSOR first — the nearest non-leaving card after the departing one, i.e. the card that rises to
// fill its place — else the nearest predecessor (end-of-list case). Deliberately NOT limited to
// visible cards: when the departing card filled the viewport there is no visible neighbour, and the
// old hold-in-place pin left the reader stranded mid-card; the off-screen successor must still be
// brought to the top. null → queue emptied.
function captureScrollTarget(removingSlug: string): string | null {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-queue-card]")]
  const i = cards.findIndex((el) => el.dataset.queueCard === removingSlug)
  if (i < 0) return null
  const eligible = (el: HTMLElement): boolean => el.dataset.queueLeaving !== "true" && !!el.dataset.queueCard
  for (let j = i + 1; j < cards.length; j++) if (eligible(cards[j])) return cards[j].dataset.queueCard!
  for (let j = i - 1; j >= 0; j--) if (eligible(cards[j])) return cards[j].dataset.queueCard!
  return null
}

// THE one owner of the document's overflow-anchor suspension. TWO machineries in this file suspend
// Chrome's native scroll anchoring around a deliberate viewport correction (the dismissal landing in
// TodosView, the load-earlier anchor dance in QueueCard); if each captured the prior style value with
// its own ref, one could catch the other's "none" as the value to restore and leave anchoring off
// document-wide for the rest of the session. Reference-counted instead: the FIRST suspend captures the
// real prior policy, the LAST release restores it. Every suspend must be paired with exactly one release.
let anchorSuspendCount = 0
let anchorPrevPolicy = ""
function suspendNativeAnchoring(): void {
  if (anchorSuspendCount++ === 0) {
    anchorPrevPolicy = document.documentElement.style.overflowAnchor
    document.documentElement.style.overflowAnchor = "none"
  }
}
function resumeNativeAnchoring(): void {
  if (anchorSuspendCount > 0 && --anchorSuspendCount === 0) {
    document.documentElement.style.overflowAnchor = anchorPrevPolicy
  }
}

// Keyboard: a card's inputs are ordinary DOM focus — click in to type, Esc blurs, Enter submits (the
// composer's own handlers). The old focus-machine step-in/arrow-walk was deleted with the mouse-only
// sidebar. The header buttons are mouse-driven (always visible atop each card).
export function TodosView() {
  const board = useBoard()
  // The queue is EXACTLY the server-derived Needs-you session threads (t.needsYou) — legacy .fray rows
  // never card anymore. Concrete unresolved asks/crashes lead passive rest/done handoffs, with
  // interaction recency providing deterministic order inside each priority band.
  const items = orderQueue(asThreads(board?.threads ?? []).filter(queued), useSnapshot(prefs).queueOrder)
  const itemKey = items.map((i) => i.id).join(",")

  // The queue does NO passive/observer-driven scrolling — no on-mount focus, no re-anchor machine
  // (maintainer 2026-07-15: "go back to the drawing board, use the classic approach"). The ONLY viewport
  // adjustments are one-shot and deterministic: (1) at a card's unmount (the useLayoutEffect below) — a
  // USER-INITIATED dismissal auto-scrolls the next card to the viewport top (maintainer 2026-07-21),
  // while a pure board departure only holds a visible neighbour in place — and (2) the sidebar's
  // scroll-to-card (scrollToQueueCard in store.ts), a direct response to a click. Neither is a background
  // auto-scroll or a running observer; the browser's native scroll anchoring handles ordinary reflow.

  // OPTIMISTIC EXIT: a dismissed card leaves the list the instant the human acts, without waiting for the
  // board push (which lags seconds behind on some paths — a sent message clears the queue only once the
  // agent's turn starts). EVERY dismissal funnels here: Mark-as-done, Snooze, an awaiting-card confirm,
  // and steering the agent by sending a message all set `leaving` (via resolve()), and a card the board
  // drops on its own is caught by the departed path below — both run the IDENTICAL board-independent exit
  // (fade → unmount + neighbour pin on a QUEUE_EXIT_MS timer). SAFETY: if the board STILL reports the
  // thread as needs-action a few seconds later (the mutation didn't actually resolve it), resolve()'s 8s
  // guard un-hides it rather than leaving it silently vanished.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const itemsRef = useRef<ThreadView[]>(items)
  itemsRef.current = items
  // Latest-ref mirror so the finalize timer (armed in an effect whose closure may predate a resolve())
  // reads the CURRENT leaving set when deciding user-initiated vs board-departed at unmount time.
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving
  const presentIds = new Set(items.map((i) => i.id))

  // DEPARTED path — a card the board drops WITHOUT (or before) an optimistic resolve(): a confirm-snooze
  // that only publishes server-side, or a thread that resolves a tick before `leaving` records it. If the
  // card unmounted in that gap it would never play its fade (it "just disappears"). So we (1) snapshot each
  // departed thread's frozen view + last position by diffing the previous board against the current one —
  // independent of `leaving` timing — and (2) keep rendering it for one opaque frame, then arm its fade on
  // the next frame so the opacity 1→0 transition has a real from-state. A card already mid-fade when it
  // departs (the optimistic path, board catching up) is armed immediately so it never snaps back to opaque.
  // The finalize timer (below) then unmounts + pins it exactly as the optimistic path does. Bounded FIFO so
  // a long session can't grow the snapshot without limit.
  // (These refs are advanced in the render body — the same pattern as itemsRef above — because the
  // departure must be detected in the SAME render the board drops the thread; deferring to a commit-time
  // effect would give one render where the card is already unmounted, reopening the exact gap this fixes.
  // Idempotent under a StrictMode double-invoke. The one caveat is concurrent Suspense/transitions, which
  // this queue path does not use.)
  const prevItemsRef = useRef<ThreadView[]>([])
  const prevRenderRef = useRef<string[]>([]) // ids of the PREVIOUS render's order (board + still-held cards)
  const departedRef = useRef<Map<string, { view: ThreadView; index: number }>>(new Map())
  const armedRef = useRef<Set<string>>(new Set()) // departed slugs whose fade is armed (leaving=true)
  const goneRef = useRef<Set<string>>(new Set()) // slugs whose fade elapsed → excluded from render (unmounted)
  const finalizeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const reappearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map()) // resolve()'s per-slug 8s guard
  // A dismissed card is unmounted INSTANTLY (no height collapse). We pick an anchor card the instant
  // BEFORE the unmount (in the finalize callback) and adjust the viewport the instant AFTER (the layout
  // effect below). Two modes: "top" (user-initiated dismissal) lands the successor at the viewport-top
  // landing; "hold" (pure board departure) re-pins a visible neighbour exactly where it was, using its
  // pre-unmount `top`. One-shot, at the unmount frame — never a running observer.
  const pinRef = useRef<{ kind: "hold"; slug: string; top: number } | { kind: "top"; slug: string } | null>(null)
  const [exitTick, forceExitRender] = useState(0)
  {
    prevItemsRef.current.forEach((it) => {
      // A board departure snapshots the card so its fade still plays even though the board dropped it.
      // Skip a slug that already finished its exit (goneRef) — it must not be resurrected as a held card.
      if (!presentIds.has(it.id) && !goneRef.current.has(it.id)) {
        // Capture the slot from the PREVIOUS RENDER order (which still holds any earlier-departed cards),
        // NOT from the shrinking board — else two cards departing in separate renders both resolve to the
        // same board index and swap while fading.
        const at = prevRenderRef.current.indexOf(it.id)
        departedRef.current.delete(it.id) // re-insert at the tail so eviction is by most-recent departure
        departedRef.current.set(it.id, { view: it, index: at >= 0 ? at : prevRenderRef.current.length })
        if (leaving.has(it.id)) armedRef.current.add(it.id) // already fading → keep it fading
      }
    })
    prevItemsRef.current = items
    // goneRef housekeeping. (a) Board dropped a gone card that was NOT optimistically dismissed
    // (departed/awaiting-confirm — never in `leaving`): fully retire it. (b) Board dropped a gone card that
    // IS still in `leaving` (a slow-board optimistic dismiss the board just confirmed): keep it hidden here
    // and let the prune effect below drain it — retiring it here would let the exit effect re-arm a second
    // finalize for the same slug. (c) Board still lists a gone card that was NOT dismissed: the board
    // RE-ADDED it after its exit (a spurious drop, or a thread that went actionable again) — un-hide it.
    for (const slug of [...goneRef.current]) {
      if (!presentIds.has(slug)) {
        if (!leaving.has(slug)) {
          goneRef.current.delete(slug)
          departedRef.current.delete(slug)
          armedRef.current.delete(slug)
        }
      } else if (!leaving.has(slug)) {
        goneRef.current.delete(slug)
        armedRef.current.delete(slug)
      }
    }
    while (departedRef.current.size > 32) {
      const oldest = departedRef.current.keys().next().value
      if (oldest === undefined) break
      departedRef.current.delete(oldest)
      armedRef.current.delete(oldest)
      const orphan = finalizeTimersRef.current.get(oldest)
      if (orphan) { clearTimeout(orphan); finalizeTimersRef.current.delete(oldest) }
    }
  }
  // A card's data-queue-leaving: on-board cards read the optimistic set; departed (held) cards read the
  // arm set so their first held frame is full-height and the transition can run.
  const isLeaving = (slug: string) => (presentIds.has(slug) ? leaving.has(slug) : armedRef.current.has(slug))

  // Render list = the board's queue, PLUS any held (departed, mid-fade) card re-inserted at its
  // last-known position so it stays mounted and fades in place instead of vanishing. Cards that finished
  // their exit (goneRef) are excluded whether or not the board has caught up — that instant removal is
  // what the neighbour pin compensates. Spliced low-index-first so each stored index still addresses the
  // right slot as the list grows.
  const renderItems = useMemo(() => {
    const list = items.filter((it) => !goneRef.current.has(it.id))
    const held = [...departedRef.current.entries()]
      .filter(([s]) => !presentIds.has(s) && !goneRef.current.has(s))
      .map(([, v]) => v)
      .sort((a, b) => a.index - b.index)
    for (const { view, index } of held) list.splice(Math.min(index, list.length), 0, view)
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, leaving, exitTick])
  // Remember this render's exact order (board + held) so the NEXT departure captures a stable slot.
  prevRenderRef.current = renderItems.map((i) => i.id)

  // Drive EVERY exiting card through the SAME board-independent exit, so all dismissal paths (Mark done,
  // Snooze, an awaiting-confirm snooze, or steering the agent by sending a message) behave identically:
  // (1) ARM a board-departed card's fade on the next frame (one opaque frame must paint first, else there
  // is no transition), (2) FINALIZE — pin a neighbour, then un-mount — QUEUE_EXIT_MS after the card BEGAN
  // exiting. "Exiting" = optimistically dismissed (in `leaving`, the board may still list it) OR
  // board-departed. Gating finalize on the timer (not the board drop) is what stopped a slow-board path
  // (a sent message clears the queue only once the agent's turn starts) from leaving a lingering blank.
  useEffect(() => {
    const departedHeld = [...departedRef.current.keys()].filter((s) => !presentIds.has(s) && !goneRef.current.has(s))
    const toArm = departedHeld.filter((s) => !armedRef.current.has(s))
    let raf: number | undefined
    if (toArm.length) {
      raf = requestAnimationFrame(() => {
        // Re-check membership: a slug whose finalize timer already fired (rare — rAF starved past
        // QUEUE_EXIT_MS in a backgrounded tab) must not be re-added as a stale arm entry.
        toArm.forEach((s) => { if (departedRef.current.has(s)) armedRef.current.add(s) })
        forceExitRender((n) => n + 1)
      })
    }
    const exiting = new Set<string>()
    for (const s of leaving) if (!goneRef.current.has(s)) exiting.add(s)
    for (const s of departedHeld) exiting.add(s)
    for (const slug of exiting) {
      if (finalizeTimersRef.current.has(slug)) continue
      const timer = setTimeout(() => {
        finalizeTimersRef.current.delete(slug)
        // Snapshot the anchor BEFORE the unmount renders — consumed in the layout effect below. A
        // user-initiated dismissal (`leaving` is fed ONLY by resolve(), i.e. a local action on the
        // card) auto-scrolls the next card to the viewport top; a pure board departure keeps the
        // hold-in-place neighbour pin so a reader mid-card elsewhere is never yanked.
        if (leavingRef.current.has(slug)) {
          const target = captureScrollTarget(slug)
          pinRef.current = target ? { kind: "top", slug: target } : null
        } else {
          const pin = captureNeighborPin(slug)
          pinRef.current = pin ? { kind: "hold", ...pin } : null
        }
        goneRef.current.add(slug) // exclude from render → unmount, regardless of whether the board dropped it
        armedRef.current.delete(slug)
        // Deliberately do NOT drain `leaving` here — keep the slug in it (goneRef hides the card) so
        // resolve()'s 8s guard can still reappear it if the mutation never actually resolved. The single
        // drain is the prune effect below, once the board CONFIRMS the drop.
        forceExitRender((n) => n + 1)
      }, QUEUE_EXIT_MS)
      finalizeTimersRef.current.set(slug, timer)
    }
    return () => { if (raf !== undefined) cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, leaving, exitTick])
  // The SINGLE drain for optimistically-dismissed cards: once a gone slug has also LEFT the board (the
  // mutation resolved), retire every trace of it and drop it from `leaving`. This is what keeps the
  // optimistic set from growing across a long session; a still-listed gone slug stays (hidden) so the 8s
  // guard can rescue a never-resolving dismiss. A departed (never-in-`leaving`) card is retired inline in
  // the render body instead, so it is not handled here.
  useEffect(() => {
    const stale = [...leaving].filter((slug) => goneRef.current.has(slug) && !presentIds.has(slug))
    if (stale.length === 0) return
    for (const slug of stale) {
      goneRef.current.delete(slug)
      departedRef.current.delete(slug)
      armedRef.current.delete(slug)
    }
    setLeaving((prev) => {
      const next = new Set(prev)
      for (const slug of stale) next.delete(slug)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, exitTick])
  useEffect(() => () => {
    for (const t of finalizeTimersRef.current.values()) clearTimeout(t)
    for (const t of reappearTimersRef.current.values()) clearTimeout(t)
  }, [])

  // The UNMOUNT-FRAME viewport adjustment: runs after every exit render (keyed on exitTick), but only
  // acts when the finalize callback just armed a pin. Both modes are one instant correction
  // (`behavior:"auto"` — the queue's idiom is deterministic one-shot moves, never an animation):
  //   • "hold" (pure board departure): restore the visible neighbour to its pre-unmount viewport top.
  //     Anchoring-COMPATIBLE — the browser's anchor node ends up exactly where it was, so Chrome's
  //     native scroll anchoring (which settles AFTER layout effects) computes a no-op.
  //   • "top" (user-initiated dismissal): land the successor at the standard viewport-top landing —
  //     the deliberate auto-scroll (maintainer 2026-07-21: "some card should be at the top of the
  //     screen after any action that dismisses a card"). Anchoring-HOSTILE — we MOVE the content the
  //     browser's anchor was tracking, and native anchoring would silently scroll it right back (the
  //     observed bug: the viewport "landed mid-card" at its old offset). So suspend overflow-anchor
  //     and re-assert the landing across the two settle frames, exactly like the load-earlier anchor
  //     dance in QueueCard below.
  useLayoutEffect(() => {
    const pin = pinRef.current
    if (!pin) return
    pinRef.current = null
    const el = document.querySelector<HTMLElement>(`[data-queue-card="${CSS.escape(pin.slug)}"]`)
    if (!el) return
    if (pin.kind === "hold") {
      const delta = el.getBoundingClientRect().top - pin.top
      if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, left: 0, behavior: "auto" })
      return
    }
    suspendNativeAnchoring()
    const land = () => {
      const targetY = queueCardTargetY(pin.slug)
      if (targetY !== null && Math.abs(window.scrollY - targetY) > 0.5) window.scrollTo({ top: targetY, left: 0, behavior: "auto" })
    }
    land()
    requestAnimationFrame(() => {
      land()
      requestAnimationFrame(() => {
        land()
        resumeNativeAnchoring()
      })
    })
  }, [exitTick])

  // useCallback([]): identity-stable so the memoized QueueCard's props don't churn per render — it
  // closes only over stable refs + setLeaving, and takes the slug as its argument.
  // Resolving flags the slug as leaving → the card FADES + recedes in place, then unmounts. resolve()
  // itself does NOT scroll: the viewport adjustment is the one-shot unmount effect above, which (for
  // this user-initiated path) auto-scrolls the next card to the viewport top once the fade completes.
  const resolve = useCallback((slug: string) => {
    setLeaving((prev) => new Set(prev).add(slug))
    // Reappear if the board still insists it needs action after the exit + a grace window. 8s (not
    // 4s): a replied card only clears once the agent's turn STARTS (humanBlocked+running → not
    // actionable, per needsAction), and message-paste → turn-start can lag a couple seconds through the
    // 1s tailer poll — a tighter window would flicker the card back before the board confirmed the exit.
    // Tracked per slug and REPLACED on a re-dismiss of the same slug: a stale guard from an earlier dismiss
    // must not fire and un-hide a card the human just dismissed again.
    const prior = reappearTimersRef.current.get(slug)
    if (prior) clearTimeout(prior)
    const guard = setTimeout(() => {
      reappearTimersRef.current.delete(slug)
      if (itemsRef.current.some((t) => t.id === slug)) {
        // Still needed → un-hide (goneRef) and un-fade (leaving) so the card returns opaque.
        goneRef.current.delete(slug)
        armedRef.current.delete(slug)
        setLeaving((prev) => {
          if (!prev.has(slug)) return prev
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
        forceExitRender((n) => n + 1)
      }
    }, 8000)
    reappearTimersRef.current.set(slug, guard)
  }, [])

  // The thread LISTING moved out of this column into the left SIDEBAR (Active / Plans / Inactive
  // sections — see Sidebar.tsx + groups.ts sectionThreads). The queue keeps only the cards + the
  // dispatch box. An empty queue over a populated board just shows the dispatch box (top-anchored).
  // Only a BRAND-NEW board — zero threads of ANY status (a board with only done/dismissed threads is
  // NOT a new user) — centers the prompt box as the whole screen; App hides the sidebar in lockstep
  // on this same predicate, so the fresh-user experience is just the prompt + corner chrome.
  // Foreign (terminal) sessions don't count — only fray-originated threads/plans make a board "real".
  const nothingAtAll = !board?.threads.some((t) => t.foreign !== true) && (board?.plans?.length ?? 0) === 0
  // Active = the sidebar's Active section (non-foreign, non-archived session threads). The empty-inbox
  // only shows when there IS active work but nothing's queued; with zero active threads it's hidden, so
  // a fresh repo is just the centered prompt (the prompt box lives in the sidebar now, not this column).
  const activeCount = asThreads(board?.threads ?? []).filter((t) => t.kind === "session" && t.foreign !== true && t.state !== "archived").length

  return (
    // The queue column, top to bottom: queue cards (or the empty-inbox state) → rule → dispatch box.
    // NO scroll container here — the PAGE scrolls. my-auto (NOT justify-center, whose top overflow
    // would be unreachable): the column vertically CENTERS in the viewport while its content is
    // shorter (App's <main> is a min-h-screen flex column), and degrades safely to normal
    // top-anchored flow the moment it grows past — margins collapse to 0, nothing clips.
    <div className="my-auto w-full min-w-0 flex flex-col py-8">
      {/* Source-of-truth failures are LOUD: a board that can't be read renders as this banner, never
          as a silently empty listing (a truncated shell-out once blanked a 700-thread board with the
          error hidden in an unrendered field). */}
      <BoardErrorsBanner board={board} />

      {renderItems.length > 0 && (
        <div className="flex flex-col [&>*:last-child_hr]:hidden">
          {renderItems.map((item) => (
            <CardSlot key={item.id} slug={item.id} leaving={isLeaving(item.id)}>
              <QueueCard thread={item} leaving={isLeaving(item.id)} onResolve={resolve} />
            </CardSlot>
          ))}
        </div>
      )}

      {nothingAtAll ? (
        // BRAND-NEW repo (zero threads of any status; the sidebar is hidden in lockstep): the prompt
        // box IS the whole screen, centered. The FIRST dispatch adds an active thread → the sidebar
        // appears and this same box shunts to its top; this column then holds only the queue.
        <div className="w-full flex flex-col gap-3">
          <h2 className="text-[15px] font-medium text-center">What should the agent do?</h2>
          {/* The GitHub picker's door rides inside DispatchForm's composer now (a small icon left of
              the send button), so no separate trigger here. */}
          <DispatchForm autoFocus />
        </div>
      ) : renderItems.length === 0 && activeCount > 0 ? (
        // Active work exists but nothing's queued: the calm empty-inbox (NO dispatch box — the prompt
        // box lives in the sidebar). Hidden entirely when there are zero active threads. Gated on
        // renderItems (not items) so the empty state can't flash UNDER the last card while it dissolves.
        <div className="flex flex-col items-center gap-2 pt-2">
          <Inbox size={40} strokeWidth={1.25} className="text-muted/30" />
          <div className="text-[13px] text-muted/80">No threads awaiting human input</div>
        </div>
      ) : null}
    </div>
  )
}

// The board-errors banner: source-of-truth failures rendered LOUD (never a silently empty listing).
// A REPAIRABLE error (a thread .md with no YAML frontmatter — invisible to the queue/status system)
// gets a one-click Repair button that prepends minimal frontmatter and rebuilds the board; the entry
// clears on the next snapshot. Non-repairable errors render exactly as before. Falls back to the plain
// `errors` strings when the structured `errorItems` is absent (a pre-restart server).
function BoardErrorsBanner({ board }: { board: BoardSnapshot | null }) {
  const items = board?.errorItems ?? []
  const legacy = board?.errors ?? []
  if (items.length === 0 && legacy.length === 0) return null
  return (
    <div className="mb-6 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] text-amber-200/90">
      <div className="font-medium mb-0.5">Board errors</div>
      {items.length > 0
        ? items.slice(0, 6).map((it, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate" title={`${it.file ? `${it.file}: ` : ""}${it.message}`}>
                {it.file ? `${it.file}: ` : ""}
                {it.message}
              </span>
              {it.kind === "no-frontmatter" && <RepairButton file={it.file} />}
            </div>
          ))
        : legacy.slice(0, 3).map((e, i) => (
            <div key={i} className="truncate" title={e}>
              {e}
            </div>
          ))}
    </div>
  )
}

// The per-error Repair action. Each button owns its own mutation so its pending/disabled state is
// isolated. On success the fix has landed on disk + a board rebuild is in flight — the banner entry
// disappears on the next snapshot; a toast confirms. On refusal (server-side guard) the toast carries
// the reason.
function RepairButton({ file }: { file: string }) {
  const repair = useMutation({
    mutationFn: () => rpc.repairThread({ file }),
    onSuccess: ({ slug }) => showToast(`Repaired ${slug} — verify its status`),
    onError: (err) => showToast(err instanceof Error ? err.message : "Repair failed"),
  })
  return (
    <button
      onClick={() => repair.mutate()}
      disabled={repair.isPending}
      className="shrink-0 rounded border border-amber-400/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
      title="Prepend minimal frontmatter (title + status: active) so this thread becomes visible again"
    >
      {repair.isPending ? "Repairing…" : "Repair"}
    </button>
  )
}

// (AgentRow / StatusChip / InactiveSection moved OUT of this column: the left Sidebar's ThreadRow +
// sections replaced the in-column listing wholesale — see Sidebar.tsx.)

// One card's row in the list. On exit the card FADES + recedes (content blurs + scales from its centre,
// fading out AT FULL HEIGHT), then TodosView unmounts it. There is no height-collapse phase: the row is
// removed instantly and TodosView's one-shot unmount effect adjusts the viewport (auto-scroll next card
// to top, or hold a neighbour in place). The `.fray-card-slot` rules in styles.css carry the
// fade/scale/blur. `data-queue-card=<slug>` is the anchor a sidebar row uses to jump to its queue card
// instead of opening a drawer (scrollToQueueCard in store.ts), and the unmount anchors use it too;
// `data-queue-leaving` drives the fade CSS.
function CardSlot({ leaving, slug, children }: { leaving: boolean; slug: string; children: ReactNode }) {
  return (
    // min-w-0 at EVERY level: grid items and flex children default to min-width:auto, so one wide
    // diff line inside a card would otherwise widen the whole queue column and make it pan sideways
    // (~346px of horizontal overflow before this) instead of letting the diff body's own
    // overflow-x:auto engage.
    <div data-queue-card={slug} data-queue-leaving={leaving} className="fray-card-slot min-w-0">
      {/* .fray-card-clip: a plain min-h-0/min-w-0 wrapper (no overflow:hidden — an overflow ancestor at
          rest would establish a scroll container that neuters the sticky header). */}
      <div className="fray-card-clip min-h-0 min-w-0">
        {/* .fray-card-body carries the fade's blur/scale (transform-origin: centre — it recedes uniformly). */}
        <div className="fray-card-body min-w-0">
          {children}
          {/* Generous inter-card space with a hairline rule; removed with the card on exit. The
              list container hides the LAST card's rule. */}
          <hr className="my-10 border-0 border-t border-border/60" />
        </div>
      </div>
    </div>
  )
}

// The higher-level, turn-level collapse bar: ONE row standing in for the entire intermediate run
// between the pinned user ask and the agent's final message. Shares the per-message ToolCalls toggle's
// petite-caps readout, but is deliberately distinct as a bordered, full-width affordance (the toggle is
// borderless) carrying the stacked-chevron ChevronsUpDown expand glyph. Clicking is ONE-WAY: it reveals the full log and the
// bar unmounts; there is no re-collapse (the maintainer's ask).
function IntermediateSummary({ toolCount, stepCount, onExpand }: { toolCount: number; stepCount: number; onExpand: () => void }) {
  const pieces: string[] = []
  if (toolCount > 0) pieces.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`)
  if (stepCount > 0) pieces.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`)
  // Never empty: the bar only renders when at least one of the two is > 0 (see collapseIntermediate).
  const summary = pieces.join(" · ")
  return (
    <button
      type="button"
      data-intermediate-summary
      onClick={onExpand}
      onMouseDown={(e) => e.preventDefault()}
      aria-label={`Expand ${summary} of intermediate agent activity`}
      className="petite-caps group flex w-full items-center gap-2 rounded-md border border-border/60 bg-panel-2/40 px-3 py-2 text-left text-[12px] text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
    >
      <ChevronsUpDown aria-hidden="true" size={13} className="shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
      <span className="tabular-nums">{summary}</span>
      <span className="ml-auto text-[11px] opacity-60 transition-opacity group-hover:opacity-100">Show</span>
    </button>
  )
}

// MEMOIZED like AgentRow (same replace-semantics safety: an unchanged thread keeps snapshot identity, a
// changed one is a whole new object): a board delta re-renders only the card whose thread actually
// changed, instead of every mounted card — and each card's transcript is further guarded by the
// memoized Message. `onResolve` takes the slug (stable useCallback in TodosView) so this card's props
// never churn identity render-to-render.
const QueueCard = memo(function QueueCard({ thread, leaving, onResolve }: { thread: ThreadView; leaving: boolean; onResolve: (slug: string) => void }) {
  const projectDir = useProjectDir()
  const messageKey = draftKey.followUp(projectDir, thread.id, thread.sessionId)
  const [message, setMessage, clearMessage] = useDraft(messageKey)
  const [collapsed, setCollapsed] = useState(false)
  // Higher-level (turn-level) collapse: the whole run of INTERMEDIATE steps between the pinned last
  // user message and the final agent message is hidden behind a single summary bar by default, so a
  // triage card shows "what I asked" + "what the agent is saying NOW" without the wall of tool calls
  // in between. Deliberately ONE-WAY — expanding is a commitment to read the full log; there is no
  // re-collapse (the maintainer's ask). Distinct from the per-message ToolCalls collapse, which is
  // unaffected. Reset when a replacement session swaps the transcript out (see the transcriptKey effect).
  const [intermediateExpanded, setIntermediateExpanded] = useState(false)
  // Mark-as choreography: the card DIMS the instant a status mutation starts (immediate visual
  // acknowledgment), then collapses via onResolve once the server confirms. A failure un-dims.
  const [resolving, setResolving] = useState(false)
  const [visibleStartId, setVisibleStartId] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [bottomScrollReserve, setBottomScrollReserve] = useState(0)
  const messageListRef = useRef<HTMLDivElement>(null)
  // The card header is sticky at the page top; the pinned user message (StickyUserBand) must stick
  // just BELOW it. Its height is dynamic (title + timestamp + optional status line), so measure it and
  // feed the pixel offset into the band's sticky `top`. (The header's own top offset — 0, or 40px under
  // 800px where a fixed nav bar sits — is added by the band's own responsive class.)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerH, setHeaderH] = useState(0)
  const pendingViewportAnchor = useRef<{ anchor: TranscriptViewportAnchor; targetStartId: string } | null>(null)
  // True while THIS card holds one suspension of the shared native-anchoring owner (see
  // suspendNativeAnchoring at module top) for its load-earlier viewport-anchor dance.
  const anchoringHeld = useRef(false)
  const anchorSettlementScheduled = useRef(false)
  const transcriptKeyRef = useRef<string | null>(null)
  const queryClient = useQueryClient()
  const copyTerminalCommand = useCopyTerminalCommand(thread.id)
  const controls = useThreadComposerControls(thread.id)
  // Client view pref: how (or whether) to pin the current ask to the pane top. `off` → plain flow.
  const { stickyUserMessage } = useSnapshot(prefs)

  // Track the sticky header's height so the pinned user message can stick directly beneath it.
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const measure = () => setHeaderH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

  // The queue card is a simplified thread: by default the most recent messages, with "View more"
  // revealing progressively older ones above. statusText is the fallback before any transcript exists.
  const q = useTranscript(thread.id, { poll: false })
  // Raw server order — each message renders its `parts` in block order (fidelity). Memoized so the
  // windowing/useLiveAnswering below line up on identity.
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  // Question↔answer pairing for "Answers:" user messages, precomputed over the FULL list (the lookback
  // may need messages above the visible window). Indexed by GLOBAL message index — the same one the
  // Message key uses. null at ordinary indices keeps the memoized Message's props stable.
  const paired = useMemo(() => pairAllAnswers(messages), [messages])
  // Default window: everything back to (and INCLUDING) the most recent user message — a built-in
  // reminder of what the human last asked for. No user message yet → the whole transcript.
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i
    return 0
  }, [messages])
  // Which message gets pinned to the pane top (StickyUserBand). The most recent LANDED user message —
  // queued/optimistic follow-ups pin to the card bottom and aren't the "current ask", and are skipped
  // by the first render pass anyway, so anchoring the band on one would drop it entirely. -1 → none.
  const stickyUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && !messages[i].queued) return i
    return -1
  }, [messages])
  // The last TEXT-BEARING agent message — the agent's CURRENT standing signal, shown (text only) below
  // the collapse bar. Requires renderable PROSE (messageHasRenderableText), not just "renders something":
  // because this anchor is rendered `textOnly`, a trailing TOOLS-ONLY message (text "") has nothing to
  // show, so it must NOT become the anchor. Requiring text also keeps this in lockstep with liveMsg
  // (answering.ts: last assistant with non-empty text) — the live ```question that carries the answer
  // chips. If this admitted a tools-only trailing message, that message would become `lastRenderedIdx`
  // while the real question fell into the collapsed middle → its chips would vanish. queued sends and
  // punctuation kinds (event / reasoning) are all text-less, so messageHasRenderableText excludes them.
  const lastRenderedIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.queued || !messageHasRenderableText(m)) continue
      return i
    }
    return -1
  }, [messages])
  // The agent's FIRST TEXT-BEARING message after the pinned ask — its opening narration. Its text is
  // shown (text only) so the card reads: what I asked → what the agent set out to do → [collapsed work]
  // → where it landed. Requires prose for the same reason as lastRenderedIdx: a leading tools-only
  // message (agent dove straight into a tool) has nothing to show text-only, so the anchor skips past it
  // to the real narration (which would otherwise fall into the collapsed middle and be hidden). -1 → no
  // agent prose yet.
  const firstRenderedIdx = useMemo(() => {
    for (let g = stickyUserIdx + 1; g < messages.length; g++) {
      const m = messages[g]
      if (m.queued || !messageHasRenderableText(m)) continue
      return g
    }
    return -1
  }, [messages, stickyUserIdx])
  // What the summary bar hides. The first and last agent messages render TEXT ONLY (the maintainer: the
  // tool calls batched into them "are almost never useful"), so EVERYTHING between them collapses — the
  // fully-hidden middle messages AND the tool bands batched into the first/last messages themselves.
  //   hiddenToolCount = every tool call across [firstRenderedIdx .. lastRenderedIdx] inclusive.
  //   hiddenStepCount = the middle messages hidden in their entirety (strictly between first and last).
  // Zero when the agent answered in a single message (firstRenderedIdx === lastRenderedIdx → nothing
  // intermediate). The pinned ask and loaded-earlier history sit outside this range.
  const { hiddenStepCount, hiddenToolCount } = useMemo(() => {
    if (firstRenderedIdx < 0 || firstRenderedIdx === lastRenderedIdx) return { hiddenStepCount: 0, hiddenToolCount: 0 }
    let steps = 0
    let tools = 0
    for (let g = firstRenderedIdx; g <= lastRenderedIdx; g++) {
      const m = messages[g]
      if (!m || m.queued || messageRendersNothing(m)) continue
      tools += m.tools.length
      if (g > firstRenderedIdx && g < lastRenderedIdx) steps++
    }
    return { hiddenStepCount: steps, hiddenToolCount: tools }
  }, [messages, firstRenderedIdx, lastRenderedIdx])
  // Collapse the intermediate run behind ONE summary bar unless the reader has opted into the full log.
  // Gated on a real pinned ask (stickyUserIdx >= 0) and a distinct first/last agent message so a single
  // agent turn (nothing intermediate) never hides its own batched tools behind an anchorless bar. Fires
  // when there is ANYTHING to hide — middle steps OR tool calls batched into the first/last message.
  const collapseIntermediate =
    !intermediateExpanded && stickyUserIdx >= 0 && firstRenderedIdx !== lastRenderedIdx && (hiddenStepCount >= 1 || hiddenToolCount >= 1)
  const explicitStart = visibleStartId
    ? messages.findIndex((message) => message.sourceId === visibleStartId)
    : -1
  const visibleStart = explicitStart >= 0 ? explicitStart : lastUserIdx
  const visible = messages.slice(visibleStart)
  const hasMore = visibleStart > 0 || q.data?.hasEarlier === true

  useLayoutEffect(() => {
    const pending = pendingViewportAnchor.current
    const root = messageListRef.current
    if (!pending || !root) return
    const targetIsRendered = [...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
      .some((node) => node.dataset.transcriptSourceId === pending.targetStartId)
    // React Query's external-store update and this component's visible-start state can commit
    // separately. Wait for the commit that actually renders the requested prefix; consuming the anchor
    // on the cache-only intermediate commit is the exact race that caused the viewport jump.
    if (!targetIsRendered) return
    const correct = () => {
      restoreTranscriptViewportAnchor(root, pending.anchor, (delta) => {
        if (delta !== 0) window.scrollBy({ top: delta, left: 0, behavior: "auto" })
      })
      let remaining = 0
      restoreTranscriptViewportAnchor(root, pending.anchor, (delta) => { remaining = delta })
      return remaining
    }
    const remaining = correct()
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    if (remaining > 0.5 && window.scrollY >= maxScrollY - 1) {
      // A short queue is vertically centered by `my-auto`; once prepended history makes it taller than
      // the viewport those auto margins collapse. At the document's new maximum scroll position there
      // may therefore be no physical space left to keep the old message at its original screen Y. Keep
      // an equivalent external reserve below this card, then the next layout pass can restore exactly.
      setBottomScrollReserve((current) => current + Math.ceil(remaining))
      return
    }
    if (anchorSettlementScheduled.current) return
    anchorSettlementScheduled.current = true
    // Chrome's native scroll anchoring settles after React's layout effects. It is suspended while the
    // prefix changes, then two pre-paint corrections cover that browser phase plus late font/layout
    // resolution before restoring the document's prior policy.
    requestAnimationFrame(() => {
      correct()
      requestAnimationFrame(() => {
        correct()
        pendingViewportAnchor.current = null
        anchorSettlementScheduled.current = false
        if (anchoringHeld.current) {
          anchoringHeld.current = false
          resumeNativeAnchoring()
        }
      })
    })
  }, [bottomScrollReserve, messages, visibleStartId])

  useEffect(() => {
    const transcriptKey = q.data?.transcriptKey
    if (!transcriptKey) return
    const priorKey = transcriptKeyRef.current
    transcriptKeyRef.current = transcriptKey
    if (!priorKey || priorKey === transcriptKey) return

    // A replacement session deliberately discards the old transcript projection. Discard its local
    // reveal point and any exact-anchor reserve too, so view-only pagination state cannot leak into the
    // new session that now owns this card.
    setVisibleStartId(null)
    setBottomScrollReserve(0)
    // The one-way intermediate expand is view-only too — a new session starts collapsed again.
    setIntermediateExpanded(false)
    pendingViewportAnchor.current = null
    anchorSettlementScheduled.current = false
    if (anchoringHeld.current) {
      anchoringHeld.current = false
      resumeNativeAnchoring()
    }
  }, [q.data?.transcriptKey])

  useEffect(() => () => {
    if (anchoringHeld.current) {
      anchoringHeld.current = false
      resumeNativeAnchoring()
    }
  }, [])

  const armViewportAnchor = (targetStartId: string | undefined) => {
    const anchor = captureTranscriptViewportAnchor(messageListRef.current)
    if (!targetStartId || !anchor) return
    if (!anchoringHeld.current) {
      anchoringHeld.current = true
      suspendNativeAnchoring()
    }
    pendingViewportAnchor.current = { anchor, targetStartId }
  }

  const loadEarlier = async () => {
    if (loadingEarlier || !hasMore) return
    const boundary = previousUserBoundary(messages, visibleStart)
    const localUserBoundary = boundary !== null && messages[boundary]?.role === "user" ? boundary : null
    if (localUserBoundary !== null) {
      const targetStartId = messages[localUserBoundary].sourceId
      armViewportAnchor(targetStartId)
      setVisibleStartId(targetStartId ?? null)
      return
    }

    const cursor = q.data?.beforeCursor
    if (!cursor) {
      if (visibleStart > 0) {
        const targetStartId = messages[0]?.sourceId
        armViewportAnchor(targetStartId)
        setVisibleStartId(targetStartId ?? null)
      }
      return
    }

    const expectedKey = q.data?.transcriptKey
    if (!expectedKey) return
    setLoadingEarlier(true)
    try {
      const earlier = await rpc.threadTranscriptEarlier({ slug: thread.id, cursor })
      const current = queryClient.getQueryData<TranscriptData>(["transcript", thread.id])
      if (!current?.transcriptKey || current.transcriptKey !== expectedKey || earlier.transcriptKey !== expectedKey) {
        await q.refetch()
        setVisibleStartId(null)
        showToast("Transcript changed while loading history; refreshed the current session")
        return
      }
      const targetStartId = earlier.messages[0]?.sourceId ?? messages[0]?.sourceId
      armViewportAnchor(targetStartId)
      const next = prependEarlierPage(current as Parameters<typeof prependEarlierPage>[0], earlier)
      queryClient.setQueryData(["transcript", thread.id], next)
      setVisibleStartId(targetStartId ?? null)
    } catch (error) {
      await q.refetch()
      setVisibleStartId(null)
      showToast(error instanceof Error ? error.message : "Could not load earlier transcript history")
    } finally {
      setLoadingEarlier(false)
    }
  }

  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug: thread.id }) })

  // (A doc-body-in-card + adopt-from-card composite was built here and REMOVED the same day: the
  // maintainer ruled session-less threads NEVER card — needsAction gates on runtime !== "none" — so
  // a card can always render its transcript. The composite lives on the SIDEBAR click-through
  // surface, ThreadDrawer. This also mooted a review finding about the adopt path clearing the
  // typed message on failure.)

  // The SHARED answering controller (identical logic to the thread view). Queue sends deliberately
  // suppress the generic chat bottom-pin: it fights card exit/reorder. Both keyboard and button submits
  // run this same onSent, which dissolves the card in place — TodosView's unmount effect then
  // auto-scrolls the next card to the viewport top (like every user-initiated dismissal).
  const { liveMsg, answering, answerable, anyAnswered, sending, sendAnswers, sendMessage } = useLiveAnswering(thread.id, messages, () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    onResolve(thread.id)
  }, { scrollToBottom: false })
  const send = () => {
    sendMessage(message, {
      onOptimistic: clearMessage,
      onRollback: () => { if (!draftStore.get(messageKey)) setMessage(message) },
    })
  }

  return (
    // Provide the thread slug so this card's transcript matches the thread view: sub-agent blocks go
    // live (spinner + drill-in) and a done/awaiting fence card resolves its thread to show the confirm button.
    <ThreadSlugContext.Provider value={thread.id}>
    {/* NO overflow-hidden: it would clip the sticky header out of stickiness. The header carries
        rounded-t so the card's top corners still look clipped; the root's rounded-lg handles the bottom. */}
    <div
      data-queue-card-root={thread.id}
      data-queue-leaving={leaving}
      style={bottomScrollReserve ? { marginBottom: bottomScrollReserve } : undefined}
      className={`flex flex-col min-w-0 max-w-full rounded-lg border border-border-strong bg-panel shadow-lg shadow-black/25 transition-opacity ${resolving ? "opacity-40" : ""}`}
    >
      {/* Sticky-header CONTAINING BLOCK, deliberately EXCLUDING the footer: position:sticky is clamped
          to its containing block, so wrapping only the header + body here stops the header at the
          footer's top edge as the card scrolls off. Without it the header rides all the way to the
          card-root bottom, where its square bottom corners jut past the root's rounded-lg border — the
          sticky header "breaking out" of the card border during the scroll-off unstick. The footer sits
          BELOW this wrapper, so the root's rounded bottom corners are always the footer's, never the
          square-cornered header's. (No overflow here — that would neuter the header's stickiness.) */}
      <div className="flex flex-col min-w-0">
      {/* STICKY header: title + backing-doc filename + status_text on the left, whole-item icon actions
          on the right. Pins to the scroll container's top (opaque bg + bottom rule) as the body scrolls
          under it, so the actions stay reachable through a long card. Rounding is STATE-DEPENDENT:
          collapsed with no footer (a foreign/archived card) the header IS the whole card and takes full
          rounded-lg; otherwise it is rounded-top-only + a border-b, the root's rounded-lg carrying the
          bottom corners (a rounded-top + border-b would read as squared/doubled edges inside the shell). */}
      <div ref={headerRef} className={`sticky top-0 z-10 flex items-center gap-2 bg-panel px-5 py-3.5 max-[800px]:top-10 ${collapsed ? "rounded-lg" : "rounded-t-lg border-b border-border/60"}`}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 flex-1 truncate font-semibold text-[15px] leading-snug" title={displayTitle(thread)}>
              {displayTitle(thread)}
            </div>
          </div>
          <LastActive at={lastActiveLabelAt(thread)} fallbackAt={thread.spawnedAt} className="mt-0.5 block truncate text-[11px] leading-tight text-muted/75" />
          {/* status_text is worker-authored frontmatter prose — only decision-relevant when the
              thread is actually waiting on the human, so it renders ONLY for needs-human threads (the
              declared awaiting-you state; blocked is now a pure machine-wait and never cards). */}
          {thread.statusText && thread.status === "needs-human" && (
            <div className="text-[11px] text-muted/80 mt-0.5 truncate" title={thread.statusText}>
              {thread.statusText}
            </div>
          )}
        </div>
        {/* SHARED navigation actions: collapse and open-in-drawer. Diagnostic Dismiss is intentionally
            absent from queue headers; lifecycle actions stay in the footer. (Rename lives by the title
            in the thread drawer, not here — the queue is a triage surface.) Open-thread slides in the side drawer — an overlay,
            NOT a nav switch, so the queue scroll/selection stays put. */}
        {/* Every Fray-owned card carries the copy-resume-command affordance: queue cards are at rest
            by default, so opening the same session in your own terminal is entirely safe (and both CLIs
            allow it live too). Foreign/legacy rows have no Fray-owned provider session to resume. */}
        {thread.kind === "session" && thread.foreign !== true && <CopyTerminalCommandButton slug={thread.id} />}
        <HeaderActions
          thread={thread}
          showDismiss={false}
          collapsed={collapsed}
          onCollapse={() => setCollapsed((c) => !c)}
          onOpen={() => pushDrawer("thread", thread.id)}
          onDone={() =>
            markComplete.mutate(undefined, {
              onSuccess: () => onResolve(thread.id),
              onError: () => setResolving(false),
            })
          }
          doneBusy={markComplete.isPending}
          onStatusMutate={() => setResolving(true)}
          onStatusApplied={() => onResolve(thread.id)}
          onStatusFailed={() => setResolving(false)}
        />
      </div>

      {collapsed ? null : (
      <>
      {/* Message body — the same chat renderer ChatView uses, tail-first with "Load earlier messages"
          above. The card grows to its content; the PAGE is what scrolls. */}
      <div className="px-5 py-5">
        <InteractionStack
          thread={thread}
          className="mb-4"
        />
        {/* A frozen native AskUserQuestion (safety net) renders the REAL question read-only so the human
            knows exactly what's asked without opening anything; it takes precedence over the generic
            perm banner. Otherwise a permission-blocked agent has NO message to show (turn parked
            mid-tool_use) — say so explicitly. Both route the answer to the terminal tab. */}
        {thread.pendingAsk ? (
          <div className="mb-4">
            <PendingAskCard ask={thread.pendingAsk} onTerminal={copyTerminalCommand} />
          </div>
        ) : thread.nativeInputRequired ? (
          <div className="mb-4">
            <NativeInputRequiredCard input={thread.nativeInputRequired} onTerminal={copyTerminalCommand} />
          </div>
        ) : thread.runtime === "perm-prompt" ? (
          <div className="mb-4">
            <PermPromptBanner onTerminal={copyTerminalCommand} />
          </div>
        ) : null}
        {messages.length === 0 ? (
          <p className="text-[13px] text-muted">{q.isLoading ? "Loading…" : thread.statusText || "No message yet."}</p>
        ) : (
          // Adjacency-based message spacing IDENTICAL to the thread drawer (messageTailIsMeta/HeadIsMeta
          // → 6px when two meta rows — tool band or "Thought for Ns"/reasoning label — abut, else STEP) —
          // so a batched vs split tool run reads the same here as in the drawer. No flex gap; explicit
          // spacers between rendered messages.
          <div ref={messageListRef} className="flex flex-col">
            {hasMore && (
              <button
                className="mb-3.5 self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-fg hover:bg-panel-2 outline-none"
                onClick={() => void loadEarlier()}
                onMouseDown={(e) => e.preventDefault()}
                disabled={loadingEarlier}
              >
                {loadingEarlier
                  ? "Loading earlier messages…"
                  : q.data?.reachedTurnBoundary === false
                    ? "Continue loading this turn"
                    : "Load earlier messages"}
              </button>
            )}
            {(() => {
              const base = visibleStart
              const out: ReactNode[] = []
              let prevTailIsMeta: boolean | null = null
              // Higher-level turn collapse. The first and last agent messages render TEXT ONLY; the whole
              // span [firstRenderedIdx .. lastRenderedIdx] between their prose — the fully-hidden middle
              // messages plus the tool bands batched into the first/last messages — is replaced by ONE
              // summary bar. The pinned ask and loaded-earlier history still render in full around it.
              let intermediateBarEmitted = false
              visible.forEach((m, i) => {
                if (m.queued) return
                if (messageRendersNothing(m)) return
                const globalIdx = base + i
                if (collapseIntermediate && globalIdx >= firstRenderedIdx && globalIdx <= lastRenderedIdx) {
                  const isFirst = globalIdx === firstRenderedIdx
                  const isLast = globalIdx === lastRenderedIdx
                  // Fully-hidden middle message.
                  if (!isFirst && !isLast) return
                  // The bar sits between the first message's prose and the last message's prose — emit it
                  // once, just before the last message (firstRenderedIdx !== lastRenderedIdx here, so the
                  // two are distinct rows and the bar always lands after any first-message text).
                  if (isLast && !intermediateBarEmitted) {
                    if (prevTailIsMeta !== null) out.push(<VSpace key="im-space" h={STEP} />)
                    out.push(
                      <IntermediateSummary
                        key="intermediate-summary"
                        toolCount={hiddenToolCount}
                        stepCount={hiddenStepCount}
                        onExpand={() => setIntermediateExpanded(true)}
                      />,
                    )
                    intermediateBarEmitted = true
                    prevTailIsMeta = false
                  }
                  // A first/last message that is pure batched tool calls (no prose) contributes no row —
                  // its calls are already folded into the bar — so skip it and leave no dangling spacer.
                  if (!messageHasRenderableText(m)) return
                  if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={STEP} />)
                  const textKey = m.sourceId ?? `legacy-${globalIdx}`
                  out.push(
                    <div key={textKey} data-transcript-source-id={textKey} className="flex flex-col">
                      <Message m={m} dense textOnly answering={m === liveMsg ? answering : undefined} paired={paired[globalIdx]} />
                    </div>,
                  )
                  // Text-only → the row ends in prose (tool band dropped), so the next gap is a full STEP.
                  prevTailIsMeta = false
                  return
                }
                if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsMeta && messageHeadIsMeta(m) ? 6 : STEP} />)
                const sourceKey = m.sourceId ?? `legacy-${base + i}`
                // The most recent user message sticks just below the header (StickyUserBand carries the
                // source-id + sticky marker itself) unless the pref is off, and collapses as a hover-to-
                // expand bubble; everything else — and the ask when sticky is off — flows in a plain wrapper.
                const isSticky = base + i === stickyUserIdx && stickyUserMessage
                const msg = (
                  <Message
                    m={m}
                    dense
                    answering={m === liveMsg ? answering : undefined}
                    paired={paired[base + i]}
                    sticky={isSticky}
                  />
                )
                out.push(
                  isSticky ? (
                    <StickyUserBand key={sourceKey} sourceId={sourceKey} stickyTopPx={headerH}>
                      {msg}
                    </StickyUserBand>
                  ) : (
                    <div key={sourceKey} data-transcript-source-id={sourceKey} className="flex flex-col">
                      {msg}
                    </div>
                  ),
                )
                prevTailIsMeta = messageTailIsMeta(m)
              })
              // Queued (optimistic) messages pinned to the bottom, same as the drawer.
              visible.forEach((m, i) => {
                if (!m.queued) return
                out.push(<VSpace key={`qs${i}`} />)
                out.push(<Message key={`q${base + i}`} m={m} dense paired={paired[base + i]} />)
              })
              return out
            })()}
          </div>
        )}
      </div>

      {/* Bottom of the card. With answerable question blocks: a single "Send answers" action that
          composes the per-block answers into one reply. Otherwise: the free-form steering composer. */}
      <div className="shrink-0 px-5 pb-3 pt-0">
      {answerable ? (
        <div className="flex items-center justify-end gap-2">
          <button
            disabled={!anyAnswered}
            onClick={() => sendAnswers()}
            onMouseDown={(e) => e.preventDefault()}
            className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
          >
            Send answers
          </button>
        </div>
      ) : (
        <>
          <Composer
            surface="queueComposer"
            value={message}
            onChange={setMessage}
            onSubmit={send}
            placeholder="Reply to the agent…"
            minHeight={44}
            busy={controls.busy || sending}
            footer={controls.footer}
          />
          {controls.status}
        </>
      )}
        <QueueSubAgentLines slug={thread.id} subAgents={thread.subAgents ?? []} />
        {/* Background shells / Monitors remain a runtime strip below the reply area. Live sub-agents are
            intentionally excluded here because their compact ↳ child lines sit directly above it.
            It HANGS off the composer at the same pt-1.5 as those child lines — the prompt box's own
            bottom padding already supplies the optical air, so a larger gap here reads as a break —
            and carries its own pb so the last row still breathes before the lifecycle footer. */}
        <BackgroundOpsStrip slug={thread.id} includeAgents={false} className="px-1 pb-2 pt-1.5" />
      </div>
      </>
      )}
      </div>
      <ThreadLifecycleFooter
        thread={thread}
        onArchived={() => onResolve(thread.id)}
        onSnoozed={() => onResolve(thread.id)}
      />
    </div>
    </ThreadSlugContext.Provider>
  )
}, queueCardPropsEqual)

// Board keyframes can replace every ThreadView object even when a card did not change. Keep that card
// mounted (and its draft/collapse/transcript state intact) unless its actual server payload changed.
// Deltas retain identity for untouched rows, so the JSON path is only the reconnect/keyframe fallback.
function queueCardPropsEqual(
  previous: Readonly<{ thread: ThreadView; leaving: boolean; onResolve: (slug: string) => void }>,
  next: Readonly<{ thread: ThreadView; leaving: boolean; onResolve: (slug: string) => void }>,
): boolean {
  return previous.leaving === next.leaving && previous.onResolve === next.onResolve && (previous.thread === next.thread || JSON.stringify(previous.thread) === JSON.stringify(next.thread))
}
