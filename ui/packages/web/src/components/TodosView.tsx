import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Inbox } from "lucide-react"
import type { ThreadView, BoardSnapshot } from "@fray-ui/shared"
import { useMutation } from "@tanstack/react-query"
import { pushDrawer, showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBoard, asThreads, useTranscript } from "../hooks.ts"
import { orderByInteraction, queued, displayTitle } from "../groups.ts"
import { useLiveAnswering } from "../lib/answering.ts"
import { pairAllAnswers } from "../lib/answersMessage.ts"
import { Message, PermPromptBanner, PendingAskCard, VSpace, STEP, messageTailIsTool, messageHeadIsTool, messageRendersNothing } from "./ChatView.tsx"
import { Composer } from "./Composer.tsx"
import { BackgroundOpsStrip } from "./ChatView.tsx"
import { HeaderActions } from "./HeaderActions.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { GithubTrigger } from "./GithubTrigger.tsx"

// The Queue: everything currently waiting on the human, rendered as a SCROLLING LIST of cards — every
// pending item visible at once, one per card, in one vertical column that scrolls when it overflows.
// (This replaced a one-at-a-time pager/stack: with everything visible there is no paging, no peek, and
// no auto-advance — an item simply leaves the list when the board update drops its needs-action flag.)
//
// Each card's own header is STICKY (top-0 within the scroll container, opaque bg + bottom rule) so it
// pins to the viewport top while any part of the card is on screen and the body scrolls under it. The
// whole-item actions (mark done / open / rename) are ICON buttons IN that sticky header, so they stay
// reachable as you scroll through a long card.
//
// Keyboard: a card's inputs are ordinary DOM focus — click in to type, Esc blurs, Enter submits (the
// composer's own handlers). The old focus-machine step-in/arrow-walk was deleted with the mouse-only
// sidebar. The header buttons are mouse-driven (always visible atop each card).
export function TodosView() {
  const board = useBoard()
  // The queue is EXACTLY the server-derived Needs-you session threads (t.needsYou) — legacy .fray rows
  // never card anymore. Ordered by interaction recency (all items share the needs-you band).
  const items = orderByInteraction(asThreads(board?.threads ?? []).filter(queued))
  const itemKey = items.map((i) => i.id).join(",")

  // OPTIMISTIC EXIT: a resolved card (marked done / answered / replied) leaves the list the instant
  // its mutation lands, without waiting for the board push (which can lag seconds behind). We track the
  // "leaving" slugs locally; a leaving card collapses (fade + height) and the ones below slide up. When
  // the board catches up the item is simply gone. SAFETY: if the board STILL reports the thread as
  // needs-action a few seconds later (the mutation didn't actually resolve it), we drop it from the set
  // so the card reappears rather than silently vanishing.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const itemsRef = useRef<ThreadView[]>(items)
  itemsRef.current = items
  // Prune leaving slugs the board has already dropped, so the set never grows unbounded.
  useEffect(() => {
    setLeaving((prev) => {
      if (prev.size === 0) return prev
      const present = new Set(items.map((i) => i.id))
      const next = new Set([...prev].filter((s) => present.has(s)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey])

  // useCallback([]): identity-stable so the memoized QueueCard's props don't churn per render — it
  // closes only over setLeaving (stable) and itemsRef (a ref), and takes the slug as its argument.
  const resolve = useCallback((slug: string) => {
    setLeaving((prev) => new Set(prev).add(slug))
    // Reappear if the board still insists it needs action after the collapse + a grace window. 8s (not
    // 4s): a replied card only clears once the agent's turn STARTS (humanBlocked+running → not
    // actionable, per needsAction), and message-paste → turn-start can lag a couple seconds through the
    // 1s tailer poll — a tighter window would flicker the card back before the board confirmed the exit.
    setTimeout(() => {
      if (itemsRef.current.some((t) => t.id === slug)) {
        setLeaving((prev) => {
          if (!prev.has(slug)) return prev
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    }, 8000)
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

      {items.length > 0 && (
        <div className="flex flex-col [&>*:last-child_hr]:hidden">
          {items.map((item) => (
            <CardSlot key={item.id} slug={item.id} leaving={leaving.has(item.id)}>
              <QueueCard thread={item} onResolve={resolve} />
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
          <DispatchForm autoFocus />
          {/* On a fresh GitHub repo this is the prime moment to batch-dispatch from issues/PRs; the
              trigger self-hides unless gh is authed in a GitHub repo. */}
          <GithubTrigger className="mx-auto max-w-[280px]" />
        </div>
      ) : items.length === 0 && activeCount > 0 ? (
        // Active work exists but nothing's queued: the calm empty-inbox (NO dispatch box — the prompt
        // box lives in the sidebar). Hidden entirely when there are zero active threads.
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

// One card's row in the list. The spacing BELOW the card lives inside the collapsing region (not a flex
// gap) so that when a card leaves, its gap collapses WITH it — the cards below slide up with no residual
// hole and no jump when the board later unmounts the (already-collapsed) row. The grid 1fr→0fr trick
// animates height even though the content height is intrinsic.
// `data-queue-card=<slug>` is the scroll anchor a sidebar row uses to jump to its queue card instead
// of opening a drawer (scrollToQueueCard in store.ts).
function CardSlot({ leaving, slug, children }: { leaving: boolean; slug: string; children: ReactNode }) {
  return (
    // min-w-0 at EVERY level: grid items and flex children default to min-width:auto, so one wide
    // diff line inside a card would otherwise widen the whole queue column and make it pan sideways
    // (~346px of horizontal overflow before this) instead of letting the diff body's own
    // overflow-x:auto engage.
    <div data-queue-card={slug} className={`grid min-w-0 transition-all duration-200 ease-out ${leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}>
      {/* overflow-hidden ONLY while collapsing: an overflow:hidden ancestor establishes a scroll
          container that would neuter the card's sticky header, so it must be absent at rest. */}
      <div className={`min-h-0 min-w-0 ${leaving ? "overflow-hidden" : ""}`}>
        <div className="min-w-0">
          {children}
          {/* Generous inter-card space with a hairline rule; collapses with the card on exit. The
              list container hides the LAST card's rule. */}
          <hr className="my-10 border-0 border-t border-border/60" />
        </div>
      </div>
    </div>
  )
}

// How many older messages each "View more" press reveals.
const PAGE = 5

// MEMOIZED like AgentRow (same replace-semantics safety: an unchanged thread keeps snapshot identity, a
// changed one is a whole new object): a board delta re-renders only the card whose thread actually
// changed, instead of every mounted card — and each card's transcript is further guarded by the
// memoized Message. `onResolve` takes the slug (stable useCallback in TodosView) so this card's props
// never churn identity render-to-render.
const QueueCard = memo(function QueueCard({ thread, onResolve }: { thread: ThreadView; onResolve: (slug: string) => void }) {
  const [message, setMessage] = useState("")
  const [collapsed, setCollapsed] = useState(false)
  // Mark-as choreography: the card DIMS the instant a status mutation starts (immediate visual
  // acknowledgment), then collapses via onResolve once the server confirms. A failure un-dims.
  const [resolving, setResolving] = useState(false)
  // Extra messages revealed beyond the default window ("Load earlier messages" pages back).
  const [extra, setExtra] = useState(0)

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
  const shown = messages.length - lastUserIdx + extra
  const visible = messages.slice(Math.max(0, messages.length - shown))
  const hasMore = shown < messages.length

  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug: thread.id }) })

  // (A doc-body-in-card + adopt-from-card composite was built here and REMOVED the same day: the
  // maintainer ruled session-less threads NEVER card — needsAction gates on runtime !== "none" — so
  // a card can always render its transcript. The composite lives on the SIDEBAR click-through
  // surface, ThreadDrawer. This also mooted a review finding about the adopt path clearing the
  // typed message on failure.)

  // The SHARED answering controller (identical logic to the thread view). onSent runs the queue-only
  // tail: release the keyboard (blur whatever input sent) and collapse the card out optimistically
  // (it reappears if the board still needs it in a few seconds).
  const { liveMsg, answering, answerable, anyAnswered, sendAnswers, sendMessage } = useLiveAnswering(thread.id, messages, () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    onResolve(thread.id)
  })
  const send = () => {
    sendMessage(message)
    setMessage("")
  }

  return (
    // NO overflow-hidden: it would clip the sticky header out of stickiness. The header carries
    // rounded-t so the card's top corners still look clipped; the root's rounded-lg handles the bottom.
    <div className={`flex flex-col min-w-0 max-w-full rounded-lg border border-border-strong bg-panel shadow-lg shadow-black/25 transition-opacity ${resolving ? "opacity-40" : ""}`}>
      {/* STICKY header: title + backing-doc filename + status_text on the left, whole-item icon actions
          on the right. Pins to the scroll container's top (opaque bg + bottom rule) as the body scrolls
          under it, so the actions stay reachable through a long card. COLLAPSED, the header IS the
          whole card: full rounding, no bottom rule (the expanded chrome — rounded-top-only plus a
          border-b — read as squared corners and a doubled bottom edge inside the card shell). */}
      <div className={`sticky top-0 z-10 flex items-start gap-2 bg-panel px-5 py-3.5 ${collapsed ? "rounded-lg" : "rounded-t-lg border-b border-border/60"}`}>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[15px] leading-snug truncate" title={displayTitle(thread)}>
            {displayTitle(thread)}
          </div>
          {/* status_text is worker-authored frontmatter prose — only decision-relevant when the
              thread is actually waiting on the human, so it renders ONLY for needs-human threads (the
              declared awaiting-you state; blocked is now a pure machine-wait and never cards). */}
          {thread.statusText && thread.status === "needs-human" && (
            <div className="text-[11px] text-muted/80 mt-0.5 truncate" title={thread.statusText}>
              {thread.statusText}
            </div>
          )}
        </div>
        {/* SHARED icon actions (parity with the thread header): collapse, rename, open-in-drawer
            (queue-only), dismiss, mark-done at the far right. Open-thread slides in the side drawer —
            an overlay, NOT a nav switch, so the queue scroll/selection stays put. */}
        <HeaderActions
          thread={thread}
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
        {/* A frozen native AskUserQuestion (safety net) renders the REAL question read-only so the human
            knows exactly what's asked without opening anything; it takes precedence over the generic
            perm banner. Otherwise a permission-blocked agent has NO message to show (turn parked
            mid-tool_use) — say so explicitly. Both route the answer to the terminal tab. */}
        {thread.pendingAsk ? (
          <div className="mb-4">
            <PendingAskCard ask={thread.pendingAsk} onTerminal={() => pushDrawer("thread", thread.id, { terminal: true })} />
          </div>
        ) : thread.runtime === "perm-prompt" ? (
          <div className="mb-4">
            <PermPromptBanner onTerminal={() => pushDrawer("thread", thread.id, { terminal: true })} />
          </div>
        ) : null}
        {messages.length === 0 ? (
          <p className="text-[13px] text-muted">{q.isLoading ? "Loading…" : thread.statusText || "No message yet."}</p>
        ) : (
          // Adjacency-based message spacing IDENTICAL to the thread drawer (messageTailIsTool/HeadIsTool
          // → 6px when a tool band abuts a tool band, else STEP) — so a batched vs split tool run reads
          // the same here as in the drawer. No flex gap; explicit spacers between rendered messages.
          <div className="flex flex-col">
            {hasMore && (
              <button
                className="mb-3.5 self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-fg hover:bg-panel-2 outline-none"
                onClick={() => setExtra((n) => n + PAGE)}
                onMouseDown={(e) => e.preventDefault()}
              >
                Load earlier messages
              </button>
            )}
            {(() => {
              const base = messages.length - visible.length
              const out: ReactNode[] = []
              let prevTailIsTool: boolean | null = null
              visible.forEach((m, i) => {
                if (m.queued) return
                if (messageRendersNothing(m)) return
                if (prevTailIsTool !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsTool && messageHeadIsTool(m) ? 6 : STEP} />)
                out.push(<Message key={base + i} m={m} dense answering={m === liveMsg ? answering : undefined} paired={paired[base + i]} />)
                prevTailIsTool = messageTailIsTool(m)
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
      {answerable ? (
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 pb-5 pt-0">
          <button
            disabled={!anyAnswered}
            onClick={sendAnswers}
            onMouseDown={(e) => e.preventDefault()}
            className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
          >
            Send answers
          </button>
        </div>
      ) : (
        <div className="shrink-0 px-5 pb-3 pt-0">
          <Composer
            surface="queueComposer"
            value={message}
            onChange={setMessage}
            onSubmit={send}
            placeholder="Reply to the agent…"
            minHeight={44}
          />
        </div>
      )}
      {/* Background ops (running sub-agents / shells / monitors) UNDERNEATH the composer at the card's
          bottom (maintainer 2026-07-09: same placement as the thread drawer). */}
      <div className="shrink-0 px-5 pb-4">
        <BackgroundOpsStrip slug={thread.id} />
      </div>
      </>
      )}
    </div>
  )
})
