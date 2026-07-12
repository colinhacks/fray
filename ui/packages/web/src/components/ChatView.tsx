import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { AlertTriangle, Archive, ArrowUpRight, Check, ChevronRight, Clock, HelpCircle, KeyRound, ListChecks, ShieldCheck, X } from "lucide-react"
import type { AwaitingHint, PendingAsk, TranscriptEdit, TranscriptMessage } from "@fray-ui/shared"
import { store, threadBySlug, pushDrawer, pushSubAgentDrawer, showToast } from "../store.ts"
import { useBoard, useTranscript, useSocketTranscripts, type ChatMessage } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { mdToHtml, stripFrontmatter } from "../lib/markdown.ts"
import { splitProseImages } from "../lib/imagePaths.ts"
import { DiffBlock, PathLink } from "./DiffBlock.tsx"
import { splitQuestionBlocks, parseQuestionBlock, type QuestionKind, type BlockAnswer, type MessageAnswering } from "../lib/questionBlocks.ts"
import { splitFenceBlocks, type FenceKind } from "../lib/fenceBlocks.ts"
import { parseAnswersMessage, pairAllAnswers, type PairedAnswer } from "../lib/answersMessage.ts"
import { useLiveAnswering } from "../lib/answering.ts"
import { TerminalPane } from "./TerminalPane.tsx"
import { ThreadActionBar } from "./ThreadActionBar.tsx"
import { HeaderActions } from "./HeaderActions.tsx"

// Answer types moved to lib/questionBlocks.ts (shared by the queue card, the thread view, and the
// answering controller). Re-exported here so existing importers keep working.
export type { BlockAnswer, MessageAnswering }

// The thread slug the current message tree belongs to — set by ChatView so a nested AgentBlock can
// resolve its live tracked sub-agent (for the "running Nm" header + drill-in drawer) without threading
// the slug through every intermediate. Null in surfaces that don't provide it (the queue card, a
// sub-agent's own transcript) → AgentBlocks there render as plain (non-live) prompt cards.
const ThreadSlugContext = createContext<string | null>(null)

// The nearest scrollable ANCESTOR of `start`, or null when the page itself is the scroller. Used to
// scope auto-scroll to the ACTUAL container: in the main workpane there is no overflow ancestor (the
// PAGE scrolls → null → window), but inside the ThreadSheet drawer the sheet's own overflow-y-auto
// scroller is found first — so ChatView never yanks the whole page when it lives in a drawer.
function nearestScroller(start: HTMLElement | null): HTMLElement | null {
  let node = start?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = getComputedStyle(node).overflowY
    if (oy === "auto" || oy === "scroll") return node
    node = node.parentElement
  }
  return null // page-level scroll (window / documentElement)
}

// The default thread surface: the session transcript (parsed server-side from the JSONL) rendered
// as a conversation — assistant prose as markdown, tool calls as compact one-liners, a spinner
// while the turn is in flight. The raw terminal is the ⌘T power-user toggle.
//
// LAYOUT: the whole thing is ONE scroll container (the work column itself scrolls) — the chat has NO
// inner overflow region. Content flows at its natural height; the header STICKS to the top and the
// composer STICKS to the bottom (both opaque, so content scrolls cleanly under/over them and replying
// never means scrolling to the end). The scrollbar is hidden. Auto-scroll drives THIS container.
// A thread's full view — the shared composition used BOTH by the main workpane (App, terminal driven by
// the focus machine) and the Open-thread side drawer (ThreadSheet, terminal driven by its own local
// state). Chat is a single scroll column (sticky header + composer); terminal is a fixed-box pane.
// The thread's active surface tab: the conversation, the raw terminal (⌘T power-user), or the
// scratchpad doc (a session thread's compaction-proof working memory — read-only).
export type ThreadTab = "chat" | "terminal" | "scratch"

export function ThreadView({ slug, tab, onTab, onStatusApplied, onClose }: { slug: string; tab: ThreadTab; onTab: (t: ThreadTab) => void; onStatusApplied?: () => void; onClose?: () => void }) {
  if (tab === "terminal") {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <ThreadHeader slug={slug} tab={tab} onTab={onTab} onStatusApplied={onStatusApplied} onClose={onClose} />
        <TerminalPane slug={slug} />
        <ThreadActionBar slug={slug} />
      </div>
    )
  }
  if (tab === "scratch") {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <ThreadHeader slug={slug} tab={tab} onTab={onTab} onStatusApplied={onStatusApplied} onClose={onClose} />
        <ScratchpadPane slug={slug} />
      </div>
    )
  }
  return <ChatView slug={slug} tab={tab} onTab={onTab} onStatusApplied={onStatusApplied} onClose={onClose} />
}

function ChatView({ slug, tab, onTab, onStatusApplied, onClose }: { slug: string; tab: ThreadTab; onTab: (t: ThreadTab) => void; onStatusApplied?: () => void; onClose?: () => void }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"

  const q = useTranscript(slug, { poll: running })
  // Raw server order — each message renders its `parts` in block order (fidelity). Memoized so
  // useLiveAnswering's `liveMsg` identity check compares objects from THIS same list.
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  // Question↔answer pairing for "Answers:" user messages, precomputed at the LIST level (the lookback
  // needs the whole list; Message renders per-message). null — a stable primitive — at every ordinary
  // index, so the memoized Message only sees a `paired` prop change on actual answers-messages.
  const paired = useMemo(() => pairAllAnswers(messages), [messages])
  // LIVE question-block interactivity in the thread view (parity with the queue card): the last blocked
  // message gets clickable chips + per-block inputs + a composed reply; historical blocks stay read-only.
  const { liveMsg, answering, answerable, anyAnswered, sendAnswers } = useLiveAnswering(slug, messages)

  // The done-fence Archive button lands on the FINAL message of a NON-archived, registered (non-foreign)
  // session thread. On success it CLOSES the drawer (via onStatusApplied — the thread just left the
  // state you were looking at it for) and toasts, instead of leaving the drawer open on an archived
  // thread while the button silently vanishes (the bug the maintainer hit 2026-07-10). Historical fences
  // render the same cards but without this button.
  const archivable = thread?.kind === "session" && thread.state !== "archived" && !thread.foreign
  const archive = useMutation({ mutationFn: () => rpc.setThreadState({ slug, state: "archived" }) })
  const archiveMutate = archive.mutate
  const onArchive = useCallback(
    () =>
      archiveMutate(undefined, {
        onSuccess: () => {
          showToast("Archived")
          onStatusApplied?.()
        },
        onError: (e) => showToast(`Archive failed: ${(e as Error).message.slice(0, 80)}`),
      }),
    [archiveMutate, onStatusApplied],
  )

  // Board pushes are a cheap signal that the transcript may have grown, but pushing on EVERY board push
  // over-fetches (the board changes for reasons unrelated to this thread). Only refetch when this thread's
  // own activity marker actually moved since the last push. SKIPPED in /ws socket mode: the server pushes
  // transcript updates directly into the cache (on the tailer's offset-advance, strictly more sensitive
  // than this lastActivityAt edge), so a pull here would be a redundant fetch.
  const socketPush = useSocketTranscripts()
  const lastActivityRef = useRef(thread?.lastActivityAt)
  useEffect(() => {
    if (socketPush) return
    if (thread?.lastActivityAt !== lastActivityRef.current) {
      lastActivityRef.current = thread?.lastActivityAt
      q.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.lastActivityAt, socketPush])

  // Stick to the bottom like a terminal, but only when the user is already near it.
  const rootRef = useRef<HTMLDivElement>(null)
  const count = q.data?.messages.length ?? 0
  useEffect(() => {
    // Scope auto-scroll to the ACTUAL scroll container. In the main workpane the PAGE scrolls
    // (nearestScroller → null → window). Inside a drawer this ChatView lives in the sheet's OWN
    // overflow-y-auto scroller — scroll THAT, never the page (scrolling window here is what yanked the
    // whole queue on drawer-open). Gated on near-bottom so reading history is never fought.
    const scroller = nearestScroller(rootRef.current)
    if (scroller) {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240) scroller.scrollTop = scroller.scrollHeight
    } else {
      const doc = document.documentElement
      if (doc.scrollHeight - window.scrollY - window.innerHeight < 240) window.scrollTo({ top: doc.scrollHeight })
    }
  }, [count, running])

  return (
    <ThreadSlugContext.Provider value={slug}>
    <div ref={rootRef} className="flex-1 flex flex-col">
      <ThreadHeader slug={slug} tab={tab} onTab={onTab} onStatusApplied={onStatusApplied} onClose={onClose} />
      {/* flex-1 so short conversations still push the composer to the bottom; a long transcript just
          grows the card past the viewport and the page scrolls (sticky header pins to the viewport).
          gap-3.5 = 14px = STEP (the in-message VSpace unit): inter-message spacing MUST equal the
          between-block spacing or the rhythm looks uneven. Tailwind can't reference the JS STEP const —
          keep this in sync with STEP by hand (same value mirrored on the queue card's list in TodosView). */}
      {/* No flex GAP: between-message spacing is adjacency-based explicit spacers (two tool-only
          messages → the tight 6px run; anything involving prose/a bubble/an event → STEP 14px), so a
          tool-card column reads uniformly no matter how the turns were chunked. */}
      <div className="flex-1 flex flex-col px-6 py-5">
        {count === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">
            {running ? (
              <span className="flex items-center gap-2"><Dots /> Session starting…</span>
            ) : thread && thread.runtime === "none" ? (
              // A thread fray-ui never originated (pre-existing .fray board): no session, no
              // transcript. Cold-adopt it — a fresh worker reads the thread FILE and continues;
              // per the fray contract the doc, not the conversation, is the durable context.
              // (Session language, not "agent": the thing that attaches IS an agent process, but the
              // UI's thread/session vocabulary keeps "agent" for genuine child sub-agents only.)
              <div className="text-center">
                <p className="mb-3">No session is attached to this thread yet.</p>
                <button
                  className="btn-ghost border border-border text-[12px]"
                  onClick={() => rpc.adoptThread({ slug }).catch(() => {})}
                >
                  Start a session on this thread
                </button>
              </div>
            ) : (
              "No conversation yet."
            )}
          </div>
        ) : (
          <>
            {(() => {
              // Interleave messages with adjacency-based spacers (see isToolOnlyMessage): SKIP messages
              // that render nothing (so no orphan/double gap), 6px between two tool-only messages, STEP
              // otherwise. `prevToolOnly === null` marks "no rendered message yet" → no leading spacer.
              const out: ReactNode[] = []
              let prevTailIsTool: boolean | null = null
              messages.forEach((m, i) => {
                // QUEUED (optimistic, not-yet-in-the-log) messages are pinned to the very BOTTOM
                // (rendered after the working/pending indicators, below) — not interleaved here.
                if (m.queued) return
                if (messageRendersNothing(m)) return
                // 6px when a tool band ABUTS a tool band across the boundary (see messageTailIsTool).
                if (prevTailIsTool !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsTool && messageHeadIsTool(m) ? 6 : STEP} />)
                out.push(
                  <Message
                    key={i}
                    m={m}
                    answering={m === liveMsg ? answering : undefined}
                    paired={paired[i]}
                    onArchive={archivable && i === messages.length - 1 ? onArchive : undefined}
                  />,
                )
                prevTailIsTool = messageTailIsTool(m)
              })
              return out
            })()}
            {(thread?.pendingAsk || thread?.runtime === "perm-prompt" || running) && <VSpace />}
            {/* A frozen native AskUserQuestion takes precedence over the generic perm banner and the
                Working… spinner — it's the salient state (the safety net). Background sub-agents/shells
                are NOT surfaced here anymore: they live in the anchored ops strip (below), which is
                visible even mid-turn. */}
            {thread?.pendingAsk ? (
              <PendingAskCard ask={thread.pendingAsk} onTerminal={() => onTab("terminal")} />
            ) : thread?.runtime === "perm-prompt" ? (
              <PermPromptBanner onTerminal={() => onTab("terminal")} />
            ) : running ? (
              <WorkingIndicator since={thread?.lastUserAt} />
            ) : null}
            {/* Parity with the queue card: when the live message is answerable, a composed-reply button
                (the block inputs' ⌘-Enter also submits). Historical blocks aren't answerable. */}
            {answerable && <VSpace />}
            {answerable && (
              <div className="flex justify-end">
                <button
                  disabled={!anyAnswered}
                  onClick={sendAnswers}
                  onMouseDown={(e) => e.preventDefault()}
                  className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
                >
                  Send answers
                </button>
              </div>
            )}
            {/* QUEUED (optimistic) messages pinned to the VERY BOTTOM — below the working/pending
                indicators — until the server echoes them into the transcript (maintainer 2026-07-09:
                "queued messages render underneath everything until they become un-queued and show up
                in the logs"). mergeOptimistic keeps them at the tail of `messages`; here they render
                as a group after everything. Once confirmed, the optimistic copy is consumed and the
                real message renders in its natural place above. */}
            {messages.some((m) => m.queued) && <VSpace />}
            {messages.map((m, i) =>
              m.queued ? (
                // flex flex-col MIRRORS the parent scroll container (line ~162) so the Message root's
                // `self-end` engages here exactly as it does for a landed message. Without it this
                // wrapper is a plain block, self-end is inert, and a multi-line bubble stretches to 85%
                // and floats center-right — the center-then-snap-right jump on materialize.
                <div key={`q${i}`} className={`flex flex-col ${i > 0 && messages[i - 1]?.queued ? "mt-3.5" : ""}`}>
                  <Message m={m} paired={paired[i]} />
                </div>
              ) : null,
            )}
          </>
        )}
      </div>
      {/* Sticky bottom: the persistent BACKGROUND-OPS strip rides directly above the composer (both
          opaque, so the tail scrolls under them). The strip is visible whenever ops are live — even
          mid-turn, unlike the old at-rest banner. */}
      {/* Prompt box FIRST, then the background-ops strip UNDERNEATH it at the very bottom (maintainer
          2026-07-09): running sub-agents / shells / monitors sit below the composer, not above it. */}
      <div className="sticky bottom-0 z-10">
        <ThreadActionBar slug={slug} />
        <BackgroundOpsStrip slug={slug} />
      </div>
    </div>
    </ThreadSlugContext.Provider>
  )
}

// The thread's top bar: title, the Chat/Terminal/Doc tab toggle, and — at the far right — the SHARED
// HeaderActions (the kind-split verbs: session Archive/Kill or legacy Mark-as). The tab is CONTROLLED
// (tab/onTab) so the drawer drives its own copy. A FOREIGN session hides the Terminal tab (no tmux to
// attach). The Doc tab appears only when the thread has a provisioned scratchpad. STICKY top-0 so it
// pins to the top of the chat scroll; above the fixed terminal pane it behaves as a normal top bar.
export function ThreadHeader({ slug, tab, onTab, onStatusApplied, onClose }: { slug: string; tab: ThreadTab; onTab: (t: ThreadTab) => void; onStatusApplied?: () => void; onClose?: () => void }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug }) })
  // The "Fray document" header affordance opens .fray/<slug>.md (threadBody). Many session threads have
  // no such file — their working doc is the scratchpad (the Doc tab) — so the button would dead-end on
  // "No thread file found". Gate it on the doc actually having body content (same stripFrontmatter the
  // drawer renders through), so it shows iff there's a real doc to open. Shares the drawer's cached query
  // (identical key), so opening the drawer adds no extra round-trip.
  const docQ = useQuery({ queryKey: ["threadBody", slug], queryFn: () => rpc.threadBody({ slug }) })
  const hasDoc = stripFrontmatter(docQ.data?.markdown ?? "").trim().length > 0
  if (!thread) return null
  const showTerminal = thread.foreign !== true // no tmux session we own to attach for a foreign thread
  const showScratch = !!thread.scratchpadPath
  return (
    <header className="sticky top-0 z-10 shrink-0 flex items-center gap-2.5 px-3 h-12 border-b border-border bg-panel">
      <div className="min-w-0 pl-1 flex-1">
        <div className="font-semibold truncate text-[15px]" title={displayTitle(thread)}>
          {displayTitle(thread)}
        </div>
      </div>
      <div className="flex items-center gap-1 rounded-lg bg-panel-2 p-0.5 text-[11px]">
        <Tab active={tab === "chat"} onClick={() => onTab("chat")} label="Chat" />
        {showTerminal && <Tab active={tab === "terminal"} onClick={() => onTab("terminal")} label="Terminal" />}
        {showScratch && <Tab active={tab === "scratch"} onClick={() => onTab("scratch")} label="Doc" />}
      </div>
      <HeaderActions
        thread={thread}
        onDoc={hasDoc ? () => pushDrawer("doc", thread.id) : undefined}
        onDone={() => markComplete.mutate(undefined, { onSuccess: onStatusApplied })}
        doneBusy={markComplete.isPending}
        onStatusApplied={onStatusApplied}
      />
      {/* Close-X for the DRAWER context (onClose passed by ThreadSheet) — parity with the Settings,
          sub-agent, and Doc drawers, all of which carry a corner "Close". Wired to the SAME animated
          close() as the backdrop/Esc path (markDrawerClosing + the 210ms slide-out), never an instant
          unmount. Absent in the main workpane (no onClose → no drawer to close). */}
      {onClose && (
        <button
          aria-label="Close"
          onClick={onClose}
          className="ml-0.5 shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <X size={15} />
        </button>
      )}
    </header>
  )
}

// Chat | Terminal | Doc — the segmented toggle in the thread header.
function Tab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 transition-colors ${
        active ? "bg-elevated text-fg shadow-sm shadow-black/20" : "text-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  )
}

// The scratchpad doc tab: a session thread's compaction-proof working memory (.fray/scratch/<id>.md),
// rendered read-only as markdown. Refetched on open (a simple query); the worker rewrites the file as
// it works, so a re-open picks up the latest. Empty when never provisioned.
function ScratchpadPane({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ["threadScratchpad", slug], queryFn: () => rpc.threadScratchpad({ slug }) })
  const html = useMemo(() => mdToHtml(q.data?.markdown ?? ""), [q.data?.markdown])
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      {q.isLoading ? (
        <div className="text-[13px] text-muted">Loading…</div>
      ) : html ? (
        <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="text-[13px] text-muted">No scratchpad yet.</div>
      )}
    </div>
  )
}

// BETWEEN-BLOCK RHYTHM is expressed as explicit spacer ELEMENTS, never margins/padding/gap on the
// blocks themselves. An explicit element is visible in the tree, one uniform size, and can't collapse
// or double the way adjacent margins silently do. Padding INSIDE a block (its own chrome) is fine;
// the space BETWEEN sibling blocks is always a VSpace. STEP is the single between-block unit.
export const STEP = 14
// Adjacent tool cards must read at the SAME tight 6px run whether they're batched in one message or
// split across messages (the tailer chunks a burst of tool calls arbitrarily). The gap between two
// messages is 6px iff the FIRST ends with a tool band AND the SECOND begins with one (tool-tail →
// tool-head) — so a "let me check:" text-then-tool message sits 6px above the next message's leading
// tool, exactly like two batched tools. Any prose at the boundary keeps STEP (14px). messageTailIsTool
// / messageHeadIsTool inspect the LAST / FIRST rendered block; the legacy (no-parts) path renders the
// tool band FIRST then prose, so its head is tools-if-any and its tail is tools-only-if-no-prose.
export function messageTailIsTool(m: ChatMessage): boolean {
  if (m.kind === "event" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) {
    for (let i = m.parts.length - 1; i >= 0; i--) {
      const p = m.parts[i]
      if (p.kind === "tools" ? p.tools.length > 0 : p.text.trim()) return p.kind === "tools"
    }
    return false
  }
  return (m.tools?.length ?? 0) > 0 && !m.text.trim()
}
export function messageHeadIsTool(m: ChatMessage): boolean {
  if (m.kind === "event" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) {
    for (const p of m.parts) {
      if (p.kind === "tools" ? p.tools.length > 0 : p.text.trim()) return p.kind === "tools"
    }
    return false
  }
  return (m.tools?.length ?? 0) > 0
}
// Matches exactly when Message returns null (an empty/thinking-only assistant turn) — such a message
// takes no slot, so the adjacency-spacer walk must SKIP it (else two spacers stack into a double gap).
export function messageRendersNothing(m: ChatMessage): boolean {
  if (m.kind === "event" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.every((p) => (p.kind === "tools" ? p.tools.length === 0 : !p.text.trim()))
  return (m.tools?.length ?? 0) === 0 && !m.text.trim()
}
export function VSpace({ h = STEP }: { h?: number }) {
  return <div aria-hidden className="shrink-0" style={{ height: h }} />
}

// Interleave a list of block-level nodes with explicit spacers. Nullish entries (e.g. an empty prose
// run) are dropped BEFORE interleaving so a spacer never leads, trails, or doubles.
function withSpacers(blocks: ReactNode[], h = STEP): ReactNode[] {
  const real = blocks.filter((b) => b !== null && b !== undefined && b !== false)
  const out: ReactNode[] = []
  real.forEach((b, i) => {
    if (i > 0) out.push(<VSpace key={`vs${i}`} h={h} />)
    out.push(b)
  })
  return out
}

interface CollapsedTool {
  name: string
  detail?: string
  // Set for Edit/Write/MultiEdit entries: the (same-file) edits merged into one diff block. Distinct
  // files never merge; a plain tool call has no edits.
  edits?: TranscriptEdit[]
  // Set for a multi-line / long Bash call: the raw command, rendered as its own code block. Like
  // edits, a command entry stands alone (never folds into a repeat count).
  command?: string
  // The model-authored one-line description for a Bash command block (the collapsed block's header).
  // Falls back to `detail` (the command's first line) when the model gave no description.
  desc?: string
  // A shell command's captured stdout/stderr (codex's exec_command/shell ships its result in the
  // rollout; Claude Bash results aren't recorded). Rendered as a second pane below the command in the
  // BashBlock. Absent for Claude Bash calls → the command shows alone (the prior behavior).
  output?: string
  // Set for a Read call whose result shipped an excerpt: the (capped) file content, rendered as its
  // own collapsed card. Like edits/command, a read entry stands alone (never folds into a repeat
  // count). Absent pre-restart / for older transcripts → the Read renders as a header-only card.
  read?: string
  // Set for an Agent dispatch that shipped a prompt: the AgentBlock card (expands to the dispatch
  // prompt; live/finished state + drill-in in the header). Stands alone — never folds into a ×N count.
  prompt?: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
  // Set for a SendMessage (peer/agent-to-agent) call: the SendMessageCard. Like the prompt/read/command
  // entries it stands alone — never folds into a ×N count.
  sendTo?: string
  sendSummary?: string
  sendBody?: string
  sendType?: string
  count: number
}

// Fold runs of identical (name, detail) tool calls into one entry carrying a repeat count, so a
// burst of e.g. 5 identical Reads renders as one line with a ×5 suffix rather than five rows. Edit
// calls don't fold that way; instead, consecutive edits to the SAME file merge into one entry so a
// MultiEdit fan-out (or adjacent Edits to one file) renders as a single diff block, not a stack of
// near-touching ones. A different file breaks the run.
function collapseTools(tools: TranscriptMessage["tools"]): CollapsedTool[] {
  const out: CollapsedTool[] = []
  for (const t of tools) {
    const last = out[out.length - 1]
    if (t.edit) {
      if (last && last.edits && last.edits[0].file === t.edit.file) last.edits.push(t.edit)
      else out.push({ name: t.name, detail: t.detail, edits: [t.edit], count: 1 })
    } else if (t.command) {
      out.push({ name: t.name, detail: t.detail, command: t.command, desc: t.desc, output: t.output, count: 1 })
    } else if (t.read) {
      // A Read that shipped an excerpt renders as its own expandable card — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, read: t.read, count: 1 })
    } else if (t.prompt) {
      // An Agent dispatch renders as its own expandable card — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, prompt: t.prompt, subagentType: t.subagentType, agentId: t.agentId, agentStatus: t.agentStatus, agentElapsedMs: t.agentElapsedMs, count: 1 })
    } else if (t.sendTo !== undefined || t.sendBody !== undefined) {
      // A SendMessage (peer message) renders as its own SendMessageCard — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, sendTo: t.sendTo, sendSummary: t.sendSummary, sendBody: t.sendBody, sendType: t.sendType, count: 1 })
    } else if (last && !last.edits && !last.command && !last.read && !last.prompt && last.sendTo === undefined && last.sendBody === undefined && last.name === t.name && last.detail === t.detail) {
      last.count++
    } else {
      out.push({ name: t.name, detail: t.detail, count: 1 })
    }
  }
  return out
}

// Tool calls render as a SUBORDINATE activity band — never as status. The green ● was retired
// because a filled dot reads as a pending/success indicator; the transcript carries no per-tool
// status, so we imply none. Each call is one quiet mono line: a per-tool lucide icon + the
// Claude-Code grammar `Name(target)`, dimmer and smaller than prose, all consecutive calls bundled
// under one hairline left rule so a burst reads as a single column of activity beside the response.

// Prettify the raw tool name: MCP tools arrive as `mcp__Server__do_thing` — show the last segment.
function prettyToolName(name: string): string {
  const seg = name.split("__").pop() || name
  return seg
}

// Shorten a target for the one-liner: absolute paths collapse to their last two segments (full path
// stays in the title tooltip); commands / patterns / queries pass through (already ≤80 chars from the
// server). Keeps the line scannable without dumping a 60-char absolute path inline.
// Repo-relative display: strip the project prefix (pure noise — every path shares it) but keep the
// REST intact; the line has the card's full width and CSS-ellipsizes only when genuinely too long.
function shortenTarget(detail: string): string {
  const root = store.board?.projectDir
  if (root && detail.startsWith(root + "/")) return detail.slice(root.length + 1)
  return detail
}

// A run of >4 tool lines collapses behind a single "N tool calls" chevron toggle so a long tail of
// activity doesn't dwarf the prose it belongs to.
const COLLAPSE_AT = 4

function ToolCalls({ tools, dense }: { tools: CollapsedTool[]; dense?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const total = tools.reduce((n, t) => n + t.count, 0)
  // Dense surfaces (queue cards) condense ANY run of more than one call behind the summary toggle;
  // the full thread view keeps the higher threshold.
  const collapsible = tools.length > (dense ? 1 : COLLAPSE_AT)
  const showItems = !collapsible || expanded

  // Peer blocks in call order: a run of plain tool lines coalesces into ONE tight column (they're
  // sub-lines of a single activity band, not separate blocks), while each diff block stands alone.
  // Peers — the toggle, each line-run, each diff — are separated by explicit spacers (withSpacers).
  const blocks: ReactNode[] = []
  if (collapsible) {
    blocks.push(
      // Small-caps summary label (same treatment as the AGENTS section headings), chevron on the
      // RIGHT, flush-left with the tool lines it reveals.
      <button
        key="toggle"
        onClick={() => setExpanded((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        className="petite-caps flex items-center gap-1 self-start text-[12.5px] leading-6 text-muted/70 outline-none transition-colors hover:text-fg"
      >
        {/* Label stays "N tool calls" in BOTH states — the rotating chevron alone signals open/closed. */}
        <span className="tabular-nums">{total} tool calls</span>
        <ChevronRight size={12} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>,
    )
  }
  if (showItems) {
    // EVERY tool call is a card now (the plain `Name(detail)` one-liner rendering was retired). ONE
    // accumulator, ZERO kind-dependent flushing: ADJACENT CARDS ARE ALWAYS 6px APART — Edit next to
    // Bash next to a header-only card all sit at the same tight rhythm — while the whole band sits a
    // full STEP (14px) from surrounding prose. No other spacing values exist inside a tool band.
    const cards = tools.map((t, i) => <ToolCardRouter key={i} t={t} />)
    blocks.push(
      <div key="cards" className="flex flex-col">
        {withSpacers(cards, 6)}
      </div>,
    )
  }

  return <div className="flex flex-col">{withSpacers(blocks)}</div>
}

// Route a collapsed tool entry to its card. Edit/Bash/Read/Agent get expandable bodies (chevron);
// everything else (Grep, Glob, Read-without-excerpt, MCP, Monitor, a pre-restart Bash with no command)
// is a header-only card. All share the same bordered card family so no call ever reads as bare text.
function ToolCardRouter({ t }: { t: CollapsedTool }) {
  if (t.edits) return <DiffBlock edits={t.edits} />
  if (t.command) return <BashBlock command={t.command} desc={t.desc ?? t.detail} output={t.output} />
  if (t.read) return <ReadBlock detail={t.detail} read={t.read} />
  if (t.prompt) return <AgentBlock detail={t.detail} prompt={t.prompt} subagentType={t.subagentType} agentId={t.agentId} agentStatus={t.agentStatus} agentElapsedMs={t.agentElapsedMs} />
  if (t.sendTo !== undefined || t.sendBody !== undefined) return <SendMessageCard to={t.sendTo} summary={t.sendSummary} body={t.sendBody ?? ""} type={t.sendType} />
  return <ToolCard name={t.name} detail={t.detail} count={t.count} />
}

// A tool detail reads as a file path we can open in the editor when it's a single absolute-path
// token (starts with "/", no spaces, and not the server's 80-char "…" truncation). Commands like
// "git status" and truncated details stay plain text.
function isFilePath(detail: string): boolean {
  return detail.startsWith("/") && !detail.includes(" ") && !detail.includes("…")
}

// A header-only tool card: the IDENTICAL bordered card chrome as Bash/Read/Edit/Agent (same .fray-bash
// container + .fray-bash-header — border, bg, radius, padding, the label↔detail gap, 12.5px mono) but
// with NO expandable body, so it drops only the chevron. This is the fallback for every call without a
// payload — Grep, Glob, a pre-restart command-less Bash / excerpt-less Read, MCP tools, Monitor — the
// COMMON case pre-restart, so it must be indistinguishable from a real card header. petite-caps label
// left, repo-relative detail middle (an editor deep-link for a plain absolute path), ×N fold right. No
// call ever reads as bare `Name(detail)` text again.
function ToolCard({ name, detail, count }: { name: string; detail?: string; count: number }) {
  const short = detail ? shortenTarget(detail) : undefined
  const linkPath = detail && isFilePath(detail) ? detail : undefined
  return (
    <div className="fray-bash" title={detail}>
      <div className="fray-bash-header">
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{prettyToolName(name)}</span>
          {short &&
            (linkPath ? (
              // The path link swallows its own click so opening the file doesn't select the card.
              <span className="min-w-0 truncate" onClick={(e) => e.stopPropagation()}>
                <PathLink path={linkPath} className="text-[11.5px] text-muted">
                  {short}
                </PathLink>
              </span>
            ) : (
              <span className="min-w-0 truncate text-[11.5px] text-muted">{short}</span>
            ))}
        </span>
        {count > 1 && <span className="shrink-0 tabular-nums text-[11px] text-muted/45">×{count}</span>}
      </div>
    </div>
  )
}

// A multi-line / long Bash command rendered as its own block, COLLAPSED by default: the header is
// the model-authored `description` of the command (falling back to its first line), and clicking
// the header reveals the raw command in mono — pre-wrapped so long lines wrap (wide unbreakable
// content scrolls INSIDE the block, never the page). Past ~16 lines the open body clamps too.
const BASH_MAX_LINES = 16
function BashBlock({ command, desc, output }: { command: string; desc?: string; output?: string }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [outExpanded, setOutExpanded] = useState(false)
  const lineCount = useMemo(() => command.split("\n").length, [command])
  const long = lineCount > BASH_MAX_LINES
  // Codex ships the command's stdout/stderr in the same rollout (Claude doesn't), so a codex Bash card
  // carries an `output` pane below the command — clamped + independently expandable like the command.
  const outLineCount = useMemo(() => (output ? output.split("\n").length : 0), [output])
  const outLong = outLineCount > BASH_MAX_LINES
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        className="fray-bash-header w-full text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">Bash</span>
          <span className="min-w-0 truncate text-[11.5px] text-muted">{desc ?? ""}</span>
        </span>
        <ChevronRight size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <>
          <pre className={`fray-bash-body${long && !expanded ? " fray-bash-clamp" : ""}`}>{command}</pre>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              className="fray-bash-expand petite-caps px-2.5 pb-1.5"
            >
              {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </button>
          )}
          {output && (
            <>
              <div className="fray-bash-output-label petite-caps">output</div>
              <pre className={`fray-bash-body fray-bash-output-body${outLong && !outExpanded ? " fray-bash-clamp" : ""}`}>{output}</pre>
              {outLong && (
                <button
                  type="button"
                  onClick={() => setOutExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="fray-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {outExpanded ? "Collapse" : `Show all ${outLineCount} lines`}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// A Read call rendered as a sibling of BashBlock/DiffBlock: a bordered card, COLLAPSED by default,
// whose header is the petite-caps "Read" label + the repo-relative path (an editor deep-link when the
// detail is a plain absolute path). Expanding reveals WHAT was read — the (server-capped) file excerpt
// in mono, with the same clamp + "Show all N lines" affordance as a long Bash body. Reuses the
// fray-bash card classes so Bash / Edit / Read read as one system.
const READ_MAX_LINES = 16
function ReadBlock({ detail, read }: { detail?: string; read: string }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lineCount = useMemo(() => read.split("\n").length, [read])
  const long = lineCount > READ_MAX_LINES
  const short = detail ? shortenTarget(detail) : undefined
  const linkPath = detail && isFilePath(detail) ? detail : undefined
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        className="fray-bash-header w-full text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">Read</span>
          {short &&
            (linkPath ? (
              // The path link swallows its own click so opening the file doesn't also toggle the card.
              <span className="min-w-0 truncate" onClick={(e) => e.stopPropagation()}>
                <PathLink path={linkPath} className="text-[11.5px] text-muted">
                  {short}
                </PathLink>
              </span>
            ) : (
              <span className="min-w-0 truncate text-[11.5px] text-muted">{short}</span>
            ))}
        </span>
        <ChevronRight size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <>
          <pre className={`fray-bash-body${long && !expanded ? " fray-bash-clamp" : ""}`}>{read}</pre>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              className="fray-bash-expand petite-caps px-2.5 pb-1.5"
            >
              {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// An Agent dispatch rendered as a sibling of BashBlock/ReadBlock: a bordered card COLLAPSED by default,
// header = petite-caps "Agent" + the dispatch description + a dim "[subagent_type]" tag; the chevron
// expands the dispatch PROMPT. TWO affordances, kept distinct: the chevron toggles the prompt body,
// while the DESCRIPTION itself is an underlined link (PathLink treatment) that drills INTO that
// sub-agent's own transcript in a new drawer — for LIVE and COMPLETED children alike (the drawer
// resolves both; an aged-out one degrades to "unavailable"). The header also carries the child's state
// — "running Nm" (+ a spinner) while live, or "finished 35m" / "failed 12m" once completed.
const AGENT_MAX_LINES = 16
function AgentBlock({
  detail,
  prompt,
  subagentType,
  agentId,
  agentStatus,
  agentElapsedMs,
}: {
  detail?: string
  prompt: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lineCount = useMemo(() => prompt.split("\n").length, [prompt])
  const long = lineCount > AGENT_MAX_LINES
  const slug = useContext(ThreadSlugContext)
  const board = useBoard()
  const thread = slug ? threadBySlug(board, slug) : undefined
  // The live tracked sub-agent for this dispatch (matched by tool_use id) — drives the "running Nm"
  // header + spinner. Only present before the transcript records a completion (a finished child has
  // left the live set). The DRAWER, though, resolves live AND completed children, so the title links
  // regardless — it just needs the correlation id + a slug to resolve against.
  const live = !agentStatus && agentId ? (thread?.subAgents ?? []).find((s) => s.id === agentId) : undefined
  const running = !!live && live.state !== "stale"
  const canDrill = !!(slug && agentId)
  const title = detail ?? "sub-agent"

  let stateLabel: string | null = null
  if (agentStatus) {
    const verb = agentStatus === "completed" ? "finished" : agentStatus
    const dur = agentElapsedMs !== undefined ? fmtDurationMs(agentElapsedMs) : ""
    stateLabel = `${verb}${dur ? ` ${dur}` : ""}`
  } else if (live) {
    const e = elapsed(live.startedAt)
    stateLabel = live.state === "stale" ? "stale" : `running${e ? ` ${e}` : ""}`
  }

  function openDrawer() {
    if (!slug || !agentId) return
    pushSubAgentDrawer(slug, agentId, { label: title, subagentType, startedAt: live?.startedAt })
  }

  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        className="fray-bash-header w-full text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">Agent</span>
          {canDrill ? (
            // The description IS the drawer link (PathLink hover treatment). stopPropagation so opening
            // the sub-agent doesn't also toggle the prompt body.
            <span
              role="button"
              tabIndex={0}
              title="Open sub-agent transcript"
              onClick={(e) => { e.stopPropagation(); openDrawer() }}
              onMouseDown={(e) => e.stopPropagation()}
              className="min-w-0 truncate text-[11.5px] text-muted cursor-pointer hover:underline hover:text-fg/80"
            >
              {title}
            </span>
          ) : (
            <span className="min-w-0 truncate text-[11.5px] text-muted">{title}</span>
          )}
          {subagentType && <span className="shrink-0 font-mono-keep text-[11px] text-muted/45">[{subagentType}]</span>}
          {stateLabel && <span className="shrink-0 text-[11px] text-muted/55 whitespace-nowrap">{stateLabel}</span>}
          {running && <LiveSpinner />}
        </span>
        <ChevronRight size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <>
          <pre className={`fray-bash-body${long && !expanded ? " fray-bash-clamp" : ""}`}>{prompt}</pre>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              className="fray-bash-expand petite-caps px-2.5 pb-1.5"
            >
              {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// A SendMessage (peer / agent-to-agent messaging) rendered as a sibling of AgentBlock/BashBlock: the
// SAME quiet bordered card family, but purpose-built to read as "this agent sent a message to that
// agent" rather than a generic SendMessage(...) tool line. The header leads with the petite-caps kind
// label ("Sent", or "Shutdown" for a shutdown_request) then the RECIPIENT prominently as "→ <name>"
// (near-fg, so it's the salient token), then the model's one-line `summary` (muted, truncated). The
// chevron expands the MESSAGE BODY, rendered as markdown in a quiet indented block (long bodies clamp
// with a "Show all N lines" affordance, exactly like the Bash/Read/Agent bodies). Default state mirrors
// AgentBlock: COLLAPSED when a summary already conveys the gist, OPEN when there's no summary so a
// bodied message isn't hidden behind a chevron showing nothing but the recipient.
const SEND_MAX_LINES = 16
function SendMessageCard({ to, summary, body, type }: { to?: string; summary?: string; body: string; type?: string }) {
  const isShutdown = type === "shutdown_request"
  const [open, setOpen] = useState(!summary)
  const [expanded, setExpanded] = useState(false)
  const html = useMemo(() => mdToHtml(body), [body])
  const lineCount = useMemo(() => body.split("\n").length, [body])
  const long = lineCount > SEND_MAX_LINES
  const hasBody = !!body.trim()
  const label = isShutdown ? "Shutdown" : "Sent"
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        className="fray-bash-header w-full text-left"
        disabled={!hasBody}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{label}</span>
          {to && <span className="shrink-0 whitespace-nowrap text-[11.5px] text-fg/75">→ {to}</span>}
          {summary && <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>}
        </span>
        {hasBody && <ChevronRight size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
      </button>
      {open && hasBody && (
        <>
          {/* Quiet indented body: the border-top + 10px/8px padding mirror .fray-bash-body, but the
              content is MARKDOWN (md-body — sans, 14px) so a peer message reads like prose, not a code
              dump. The clamp caps a long body at ~320px until "Show all" expands it. */}
          <div className={`border-t border-border px-2.5 py-2${long && !expanded ? " fray-bash-clamp" : ""}`}>
            <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              className="fray-bash-expand petite-caps px-2.5 pb-1.5"
            >
              {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// Exported so the Queue card reuses the exact same message rendering (user bubble right, agent prose
// left, compact tool lines) — no duplicate renderer. `answering` (Queue-only, for the live message)
// makes each ```question block answerable in place; without it the blocks render read-only.
//
// MEMOIZED (the render-perf thread's chip-click fix): a queue card re-renders on EVERY chip click /
// composer keystroke (answer + draft state live at card level) and on every board delta (TodosView's
// snapshot scope), and each such render used to re-run every visible Message's whole subtree —
// markdown/diff/tool cards included. Props are memo-friendly by construction: `m` keeps identity for
// unchanged messages (TanStack Query's structural sharing on both the poll and socket write paths),
// `answering` is undefined for all but the live message (and identity-stable via useLiveAnswering's
// useMemo unless answers/blocks actually changed), `dense` is a constant. So only the message whose
// inputs really changed re-renders; everything else bails out at the memo boundary.
// `paired` is the precomputed question↔answer pairing for an "Answers:" user message (see
// pairAllAnswers — computed at the LIST level because the lookback needs the whole message list, which
// a per-message component deliberately doesn't get). Memo-friendly by construction: it's null (a stable
// primitive) for every ordinary message, so only actual answers-messages ever see a prop change.
// undefined (a consumer that doesn't precompute, e.g. the sub-agent sheet) → internal unpaired fallback.
// `onArchive` (ChatView-only, passed to the FINAL message of an archivable session thread) surfaces
// the Archive button on a ```done fence card; undefined everywhere else (historical fences, the queue
// card, the sub-agent sheet) → the same card renders sans button.
export const Message = memo(function Message({ m, answering, dense, paired, onArchive }: { m: ChatMessage; answering?: MessageAnswering; dense?: boolean; paired?: PairedAnswer[] | null; onArchive?: () => void }) {
  // An event line (a sub-agent completion) is transcript PUNCTUATION — a quiet full-width line, not a
  // bubble or a tool band. Rendered before the role branches (its role field is nominal).
  if (m.kind === "event") return <EventLine text={m.text} />
  // User messages: right-justified chat bubble; agent output stays left-aligned prose. A follow-up
  // that's been sent but not yet echoed by the transcript shows as a grayed-out bubble — the dimming
  // alone signals queued (a "queued" tag under the bubble caused layout shift when it cleared).
  if (m.role === "user") {
    // CR/CRLF → LF: a terminal-injected follow-up round-trips carriage-return-separated, and the pre-wrap
    // bubble honors \n but not a lone \r → the breaks collapse into a run-on. Normalize for BOTH render
    // paths (the server does this too, but this is the definitive per-surface guarantee for user text).
    const text = m.text.replace(/\r\n?/g, "\n")
    // OUR OWN composed multi-block answer ("Answers:\n1. …\n2. …", from useLiveAnswering.sendAnswers)
    // renders as a structured answers card echoing the question component — not a flat run-on bubble.
    // Non-matching text (and a parse hiccup → null) falls back to the plain bubble; text is never lost.
    const answers = paired !== undefined ? paired : parseAnswersMessage(text)
    if (answers) return <AnswersCard answers={answers} queued={m.queued} />
    return (
      <div className="self-end flex flex-col items-end gap-0.5 max-w-[85%]">
        {/* WHITE bubble, BLACK text — the human's words POP against the dark page + agent prose
            (maintainer-settled: consistency, and the ONE component both the chat drawer and the queue
            cards render, so they match by construction). 14px to match the assistant prose (.md-body).
            whitespace-pre-wrap is load-bearing: user text is verbatim, so its line breaks must survive. */}
        <div className={`rounded-2xl rounded-br-sm bg-fg px-3.5 py-2 text-[14px] whitespace-pre-wrap text-bg ${m.queued ? "opacity-50" : ""}`}>
          {text}
        </div>
      </div>
    )
  }

  // Build ONE ordered list of block-level children, then interleave with explicit spacers. The
  // FIDELITY invariant: visual order == turn order. We render `m.parts` in block order — a "Let me
  // draft the notes:" text lead-in sits directly above the tool band it introduces, never hoisted
  // above earlier prose. A question-block index (`qi`) threads across all text parts so the answering
  // controller (which numbers ```question blocks over the flat text, same order) lines up.
  const blocks: ReactNode[] = []
  const qi = { n: -1 }
  const renderText = (text: string, keyBase: string) => {
    // Split SIGNAL fences (```done / ```awaiting) out first — each renders as a card in place of the
    // raw block — then run the remaining prose runs through the question/image pipeline. Fences never
    // contain a ```question block, so the question-block index (qi) still lines up with the answering
    // controller (which numbers ```question blocks over the flat text in the same order).
    for (const [fi, fseg] of splitFenceBlocks(text).entries()) {
      if (fseg.kind === "fence") {
        blocks.push(
          <FenceCard
            key={`${keyBase}-f${fi}`}
            fenceKind={fseg.fenceKind}
            body={fseg.body}
            hints={fseg.hints}
            wrap={dense}
            onArchive={fseg.fenceKind === "done" ? onArchive : undefined}
          />,
        )
        continue
      }
      for (const [si, seg] of splitQuestionBlocks(fseg.text).entries()) {
        if (seg.kind === "prose") {
          for (const [j, p] of splitProseImages(seg.text).entries()) {
            blocks.push(p.kind === "image" ? <BlockImage key={`${keyBase}-${fi}-p${si}-${j}`} path={p.path} /> : <ProseHtml key={`${keyBase}-${fi}-p${si}-${j}`} md={p.text} wrap={dense} />)
          }
          continue
        }
        qi.n += 1
        const bi = qi.n
        const interactive = answering
          ? {
              answer: answering.answerFor(bi),
              onChip: (optIdx: number, optText: string) => answering.onChip(bi, optIdx, optText),
              onText: (text: string) => answering.onText(bi, text),
              onSubmit: answering.onSubmit,
            }
          : undefined
        blocks.push(<QuestionBlockCard key={`${keyBase}-${fi}-q${si}`} raw={seg.text} questionKind={seg.questionKind} danger={seg.danger} interactive={interactive} wrap={dense} />)
      }
    }
  }

  if (m.parts && m.parts.length > 0) {
    // Ordered walk (the fix): each part renders where it belongs. A tools part → a card band over its
    // CONTIGUOUS run (collapseTools folds ×N + merges same-file edits within the run); a text part →
    // its prose + question cards.
    m.parts.forEach((part, pi) => {
      if (part.kind === "tools") {
        const collapsed = collapseTools(part.tools)
        if (collapsed.length) blocks.push(<ToolCalls key={`t${pi}`} tools={collapsed} dense={dense} />)
      } else {
        renderText(part.text, `x${pi}`)
      }
    })
  } else {
    // LEGACY fallback (a pre-restart server ships no `parts`): the old flat layout — tool band first,
    // then all prose. Degrades to today's (order-lossy) rendering until the server bounce.
    const collapsed = collapseTools(m.tools)
    if (collapsed.length > 0) blocks.push(<ToolCalls key="tools" tools={collapsed} dense={dense} />)
    renderText(m.text, "leg")
  }

  // An assistant turn that produced no renderable block (empty/whitespace-only) contributes NOTHING —
  // a bare <div> would still take a slot in the parent's gap stack and double the surrounding gap.
  if (blocks.length === 0) return null
  // No gap on the container — between-block spacing is entirely the explicit VSpace elements.
  return <div className="flex flex-col text-[13px] min-w-0">{withSpacers(blocks)}</div>
})

// A user's composed multi-block answer, rendered as a structured card that MIRRORS the question
// component's answered state: the quiet uppercase label + the neutral elevated card of QuestionBlockCard,
// with each chosen answer in the same accent chip the option chips use when selected (border-accent
// bg-accent/10). Right-aligned + the user-bubble corner (rounded-br-sm) mark it as a human artifact.
// Each row leads with ITS QUESTION (compact, muted, clamped to two lines — the full text rides the
// title tooltip) so the answers read in context, not as bare numbered rows; a row whose pairing failed
// (count mismatch / no question message found — `question` undefined) degrades to the numbered layout,
// where the number still points a scrolled-up reader at the right block. Answers keep
// whitespace-pre-wrap so a multi-line answer's breaks survive.
function AnswersCard({ answers, queued }: { answers: PairedAnswer[]; queued?: boolean }) {
  return (
    <div className={`self-end flex w-full max-w-[85%] flex-col items-end ${queued ? "opacity-50" : ""}`}>
      <div className="w-full rounded-2xl rounded-br-sm border border-border-strong bg-elevated px-3.5 py-3">
        <div className="mb-2 flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wide text-muted/70">
          <ListChecks size={11} className="shrink-0" />
          answers
        </div>
        <div className="flex flex-col gap-2.5">
          {answers.map((a, i) => (
            <div key={i} className="flex flex-col gap-1">
              {a.question && (
                <div className="flex items-start gap-2">
                  <span className="mt-px shrink-0 text-[10px] uppercase tabular-nums tracking-wide text-muted/70">{a.n}</span>
                  <span title={a.question} className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-snug text-muted">
                    {a.question}
                  </span>
                </div>
              )}
              <div className="flex items-start gap-2">
                {/* With a question line the number lives up there; an invisible twin keeps the chip aligned. */}
                <span className={`mt-1.5 shrink-0 text-[10px] uppercase tabular-nums tracking-wide text-muted/70 ${a.question ? "invisible" : ""}`}>
                  {a.n}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap rounded-md border border-accent bg-accent/10 px-2.5 py-1.5 text-[12px] leading-snug text-fg">
                  {a.answer}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Queue cards live in the narrow needs-you rail, so a worker message carrying a long UNBREAKABLE token
// — a Windows path, a box-drawing error dump — must wrap at the character level rather than bleed past
// the card edge (maintainer 2026-07-10: it "looks so bad"). Applied ONLY in the dense (queue) surface:
// `overflow-wrap:anywhere` breaks unbreakable PROSE runs to fit, and code fences additionally get
// `whitespace-pre-wrap` + `break-all` so their long lines wrap INSIDE the <pre> instead of forcing the
// horizontal scroll/overflow. The roomier thread view keeps its scroll-on-overflow default (wrap=false).
const QUEUE_WRAP = "[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:break-all"

function ProseHtml({ md, wrap }: { md: string; wrap?: boolean }) {
  const html = useMemo(() => mdToHtml(md), [md])
  if (!html) return null
  return <div className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
}

// A local absolute image path rendered inline via the gated /local-image route: rounded, bordered,
// contained, with a muted mono basename caption. A load failure (route 4xx, missing file) falls back
// to showing the plain path text so nothing is silently swallowed.
function BlockImage({ path }: { path: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <div className="font-mono-keep text-[12px] text-muted/70 break-all">{path}</div>
  const base = path.split("/").filter(Boolean).pop() || path
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={`/local-image?path=${encodeURIComponent(path)}`}
        alt={base}
        onError={() => setBroken(true)}
        className="max-w-full max-h-[420px] w-auto rounded-lg border border-border object-contain"
      />
      <figcaption className="font-mono-keep text-[11px] text-muted/60 break-all">{base}</figcaption>
    </figure>
  )
}

interface BlockInteractive {
  answer: BlockAnswer
  onChip: (optIdx: number, optText: string) => void
  onText: (text: string) => void
  onSubmit: () => void
}

// A ```question block, set off from the surrounding prose: rounded neutral border + slightly elevated
// bg + a muted label (NOT yellow — that's the focus motif). The label + icon track the kind: a plain
// question shows a help glyph, an approval shows a shield, a `multi` block shows a checklist. A `danger`
// block (the destructive approval gate — force-merge, deletion, rollback) layers the app's red risk
// language (the same text-red-400 family the bypass permission mode uses) with a warning glyph.
// The context renders as markdown; the convention-parsed trailing options render as choice chips (radio
// feel for single-select, toggleable checkboxes for `multi`) and the "Recommendation:" line as a muted
// note. When `interactive` is present (the live message), chips are clickable and a one-line freetext
// input appears; otherwise everything is read-only.
function QuestionBlockCard({
  raw,
  questionKind,
  danger,
  interactive,
  wrap,
}: {
  raw: string
  questionKind: QuestionKind
  danger?: boolean
  interactive?: BlockInteractive
  wrap?: boolean
}) {
  const parsed = useMemo(() => parseQuestionBlock(raw, questionKind, danger), [raw, questionKind, danger])
  const html = useMemo(() => mdToHtml(parsed.contextMd), [parsed.contextMd])
  const trailingHtml = useMemo(() => (parsed.trailingMd ? mdToHtml(parsed.trailingMd) : ""), [parsed.trailingMd])
  const recIdx = useMemo(() => recommendedIndex(parsed.recommendation, parsed.options), [parsed])
  const isApproval = parsed.kind === "approval"
  const isMulti = parsed.kind === "multi"
  const isDanger = parsed.danger
  const chosen = interactive?.answer.chosen ?? null
  const chosenSet = interactive?.answer.chosenSet ?? []
  const freetext = interactive?.answer.text ?? ""
  // The free-text answer is an AUTO-EXPANDING textarea (not a fixed one-line input): reset to `auto`
  // so it can SHRINK when text is deleted, then lock to the content height so the box grows line-by-line
  // as the answer is typed. Runs on every freetext change (incl. an external clear via a chip-click).
  const taRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    // box-sizing is border-box (Tailwind preflight), so the style height must INCLUDE the borders —
    // else clientHeight lands a couple px short of scrollHeight and the last line clips (overflow is
    // hidden). `offsetHeight - clientHeight` is the vertical border delta measured at height:auto.
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
  }, [freetext])
  const KindIcon = isDanger ? AlertTriangle : isMulti ? ListChecks : isApproval ? ShieldCheck : HelpCircle
  const kindLabel = isMulti ? "select multiple" : isApproval ? "approval" : "question"
  return (
    <div className={`rounded-lg border px-4 py-3 ${isDanger ? "border-red-500/40 bg-red-500/[0.05]" : "border-border-strong bg-elevated"}`}>
      <div className={`mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide ${isDanger ? "text-red-400" : "text-muted/70"}`}>
        <KindIcon size={11} className="shrink-0" />
        {kindLabel}
      </div>
      {html && <div className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />}
      {(parsed.options.length > 0 || interactive) && (
        // Options stack in a SINGLE full-width column (maintainer 2026-07-10: a 2-col grid read as
        // ragged, uneven columns with dead whitespace once option text got long). One chip per row;
        // the free-text row keeps col-span-full so the "something else…" answer gets the whole line.
        <div className="mt-2 grid grid-cols-1 gap-1.5">
          {parsed.options.map((opt, i) => (
            <Chip
              key={i}
              label={opt}
              multi={isMulti}
              // The recommendation renders INSIDE its option as a badge (not as a caption below);
              // the full recommendation line rides the chip's title for the rationale.
              recommended={recIdx === i}
              recTitle={recIdx === i ? parsed.recommendation : undefined}
              // MULTI: selected == toggled in the set (coexists with freetext). SINGLE: selected only
              // while it's the effective answer — a freetext override clears it.
              selected={isMulti ? chosenSet.includes(i) : chosen === i && !freetext.trim()}
              disabled={!interactive}
              onClick={() => {
                interactive?.onChip(i, opt)
                // SINGLE only: choosing a chip takes the selection WITH the focus — if the free-text
                // input still holds DOM focus (its mousedown is prevented, so clicking won't blur it),
                // its accent focus border would sit next to the chip's, so blur it. MULTI keeps both
                // live at once (chips + a color note coexist), so leave the input focused there.
                if (isMulti) return
                const ae = document.activeElement as HTMLElement | null
                if (ae?.tagName === "TEXTAREA" && ae.dataset.surface === "queueComposer") ae.blur()
              }}
            />
          ))}
          {/* The free-text answer IS the final option — but it SPANS THE FULL WIDTH (col-span-full)
              below the multi-column options, and is an auto-growing textarea (see taRef effect above)
              rather than a one-line input, so a long "something else…" answer stays fully visible. */}
          {interactive && (
            <textarea
              ref={taRef}
              rows={1}
              // Tagged so the chip-click blur above can identify this box. Escape BLURS (climb out,
              // same semantics as the shared Composer) and must NOT bubble — the window handler would
              // pop the enclosing drawer mid-answer. Every key stops here.
              data-surface="queueComposer"
              value={freetext}
              onChange={(e) => interactive.onText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Escape") {
                  e.preventDefault()
                  e.currentTarget.blur()
                  return
                }
                if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                  e.preventDefault()
                  interactive.onSubmit()
                }
              }}
              // SINGLE: clicking into the input MOVES the selection here — any chosen chip deselects (its
              // accent border must not linger once the user commits to typing). MULTI keeps its toggled
              // set (the freetext only appends color), so don't disturb it on focus. Keeps typed text.
              onFocus={() => {
                if (!isMulti && chosen !== null) interactive.onText(freetext)
              }}
              placeholder={
                isMulti ? "Add a note…" : parsed.options.length ? `${nextOptionId(parsed.options)} Something else…` : "Type your answer…"
              }
              // Styled as the FINAL option row (same shape as a chip) that SPANS both grid columns.
              // resize-none + overflow-hidden hand height control to the auto-grow effect (no manual
              // drag handle, no inner scrollbar). Focus or content = the accent border (the selection
              // lives HERE now); the tinted bg marks an actual answer.
              className={`col-span-full w-full resize-none overflow-hidden rounded-md border px-2.5 py-1.5 text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted/80 transition-colors ${
                freetext.trim() ? "border-accent bg-accent/10" : "border-border bg-transparent hover:bg-panel-2 focus:border-accent"
              }`}
            />
          )}
        </div>
      )}
      {/* A "Note: …" footnote the worker wrote AFTER the options — rendered below the chips (muted) so
          the choices stay answerable instead of swallowing them (the old parser dropped the chips). */}
      {parsed.trailingMd && (
        <div className={`mt-2 md-body text-[12px] text-muted/70${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: trailingHtml }} />
      )}
      {/* The caption fallback survives ONLY when the recommendation didn't match an option. */}
      {parsed.recommendation && recIdx === null && (
        <div className="mt-1.5 text-[11px] text-muted/70">{parsed.recommendation}</div>
      )}
    </div>
  )
}

// A SIGNAL fence rendered as a card in place of the raw ```done / ```awaiting block (the fence
// language IS the state; the body is the message). `done` → a compact success card whose Archive
// button (present ONLY on the final message of a non-archived registered session thread) is the ONLY
// archiver — the fence itself mutates nothing. `awaiting` → a quiet machine-wait card: the body prose
// plus hint chips (pr/ci/timer/session) parsed from the fence body. Historical fences render the same
// cards without the Archive button (onArchive undefined).
function FenceCard({ fenceKind, body, hints, wrap, onArchive }: { fenceKind: FenceKind; body: string; hints: AwaitingHint[]; wrap?: boolean; onArchive?: () => void }) {
  const html = useMemo(() => (body ? mdToHtml(body) : ""), [body])
  if (fenceKind === "done") {
    return (
      // NEUTRAL chrome (same quiet card family as the awaiting card / permission banner) — the green
      // splash stood out as the only saturated color in the UI (maintainer 2026-07-10). The Check +
      // "Done" label carries the meaning; no color needed.
      <div className="rounded-lg border border-border-strong bg-panel-2 px-4 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted/70">
          <Check size={12} className="shrink-0" /> Done
        </div>
        {html && <div className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />}
        {onArchive && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={onArchive}
              onMouseDown={(e) => e.preventDefault()}
              className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95"
            >
              <Archive size={12} /> Archive
            </button>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-border-strong bg-panel-2 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted/70">
        <Clock size={12} className="shrink-0" /> Awaiting
      </div>
      {html && <div className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />}
      {hints.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {hints.map((h, i) => (
            <span key={i} className="flex items-center gap-1 rounded-md border border-border bg-panel px-2 py-0.5 text-[11px] text-fg/80">
              {/* petite-caps sit on the baseline → ~1px low under items-center (see styles.css); lift the
                  label onto the value's optical midline so "ci"/"pr" and the ref read on one line. */}
              <span className="petite-caps relative -top-px text-[9.5px] text-muted/60">{h.kind}</span>
              <span className="font-mono-keep">{h.value}</span>
              {/* A live countdown to a timer wait — fray-ui OWNS the wake (it resumes the session when
                  this fires), so the card shows the human exactly when that happens. */}
              {h.kind === "timer" && <TimerCountdown iso={h.value} />}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// A permission-blocked agent is INVISIBLE in the transcript (the turn is parked mid-tool_use, so no
// message exists yet) — without this banner the card looks like a quietly-working agent. Rendered by
// the queue card and the thread view whenever runtime is perm-prompt; the action lands the user in
// the terminal, the only place the prompt can be answered.
export function PermPromptBanner({ onTerminal }: { onTerminal: () => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong bg-panel-2 px-3 py-2 text-[12px]">
      <KeyRound size={13} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 text-fg/90">
        The agent is waiting on a <span className="font-medium">permission approval</span> — respond in its terminal.
      </span>
      <button
        onClick={onTerminal}
        onMouseDown={(e) => e.preventDefault()}
        className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel hover:border-border-strong"
      >
        Open terminal
      </button>
    </div>
  )
}

// The persistent BACKGROUND-OPS strip, anchored above the composer: one quiet row per LIVE op the
// worker is running across rests — sub-agents (drill-in) and background shells (display-only) — so a
// worker that "launched a CI watcher then came to rest" never reads as idle, and a final message like
// "waiting for the watcher to complete" has a visible home. Visible whenever ops are live, INCLUDING
// mid-turn (it folds in the old at-rest SubAgentBanner — one surface beats two, and the anchored
// position under the composer reads as ambient status rather than transcript content). A 30s tick keeps
// elapsed fresh even when no board push arrives (a steadily-running op changes nothing to re-push).
export function BackgroundOpsStrip({ slug }: { slug: string }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const agents = thread?.subAgents ?? []
  const shells = thread?.bgShells ?? []
  const total = agents.length + shells.length
  const [, force] = useState(0)
  useEffect(() => {
    if (total === 0) return
    const id = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [total])
  if (total === 0) return null
  return (
    <div className="flex flex-col gap-0.5 px-4 pb-2 pt-1">
      {agents.map((s, i) => (
        <OpRow
          key={`a${i}`}
          kind="AGENT"
          label={s.label}
          state={s.state}
          startedAt={s.startedAt}
          onOpen={s.id ? () => pushSubAgentDrawer(slug, s.id!, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt }) : undefined}
        />
      ))}
      {shells.map((s, i) => (
        <OpRow key={`s${i}`} kind="SHELL" label={s.label} state={s.state} startedAt={s.startedAt} />
      ))}
    </div>
  )
}

// One row of the ops strip: spinner (running) + petite-caps kind tag + label + elapsed. AGENT rows
// drill into the child's transcript (a hover arrow signals it); SHELL rows are display-only.
function OpRow({ kind, label, state, startedAt, onOpen }: { kind: "AGENT" | "SHELL"; label: string; state: "running" | "stale"; startedAt: string; onOpen?: () => void }) {
  const when = elapsed(startedAt)
  const clickable = !!onOpen
  return (
    <div
      onClick={onOpen}
      onMouseDown={clickable ? (e) => e.stopPropagation() : undefined}
      title={clickable ? "Open sub-agent transcript" : undefined}
      className={`group flex items-center gap-1.5 min-w-0 text-[11.5px] ${clickable ? "cursor-pointer" : ""}`}
    >
      {/* ⤷ the SAME down-right arrow as the sidebar's sub-agent rows — a subtle, borderless list that
          reads as ambient status hanging under the composer, not chrome (maintainer 2026-07-11). */}
      <span aria-hidden className="shrink-0 text-[11px] leading-none text-muted/40">⤷</span>
      <span className="flex w-[9px] shrink-0 justify-center">
        {state !== "stale" ? <LiveSpinner /> : <span className="block h-1.5 w-1.5 rounded-full bg-muted/25" title="stale — no recent output" />}
      </span>
      <span className="petite-caps shrink-0 text-[9.5px] text-muted/45">{kind}</span>
      <span className={`min-w-0 truncate text-muted/70 ${clickable ? "group-hover:text-fg/80 group-hover:underline" : ""}`}>{label}</span>
      {when && <span className="shrink-0 text-muted/40">{when}</span>}
      {clickable && <ArrowUpRight size={11} className="shrink-0 text-transparent transition-colors group-hover:text-muted/50" />}
    </div>
  )
}

// The read-only render of a PENDING native AskUserQuestion (the safety net for a session that bypassed
// the thread-file ask channel). Shows the REAL question(s) + options as NON-interactive rows —
// deliberately NOT answer-chips: answering a native TUI dialog by keystroke injection is too fragile, so
// the ONE affordance flips this thread to its terminal tab, where the dialog can actually be answered.
export function PendingAskCard({ ask, onTerminal }: { ask: PendingAsk; onTerminal: () => void }) {
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/[0.06] px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-accent/80">
        <HelpCircle size={11} className="shrink-0" /> Waiting on your answer — in the terminal
      </div>
      <div className="flex flex-col gap-3">
        {ask.questions.map((q, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {q.header && <div className="text-[10px] uppercase tracking-wide text-muted/55">{q.header}</div>}
            <div className="text-[13px] font-medium text-fg/90">{q.question}</div>
            {q.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {q.options.map((o, j) => (
                  // A non-interactive OPTION ROW (clearly display-only — no hover, no cursor-pointer).
                  <div key={j} className="rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-[12px] text-fg/80">
                    <span className="font-medium text-fg/90">{o.label}</span>
                    {o.description && <span className="text-muted/70"> — {o.description}</span>}
                  </div>
                ))}
                {q.multiSelect && <div className="text-[10px] text-muted/50">select one or more</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        onClick={onTerminal}
        onMouseDown={(e) => e.preventDefault()}
        className="mt-3 flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95"
      >
        <KeyRound size={12} /> Answer in Terminal
      </button>
    </div>
  )
}

// A live countdown to a timer wait's ISO instant, rendered inside the awaiting card's `timer` chip.
// fray-ui's wakers scheduler OWNS this wake — it resumes the session when `now >= iso` — so the human
// sees exactly how long until that happens. Ticks once a second (cheap; unmounts with the card). Past
// due → "firing…" (the scheduler resumes within a tick; the fence then clears and this card vanishes).
function TimerCountdown({ iso }: { iso: string }) {
  const target = useMemo(() => Date.parse(iso), [iso])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!Number.isFinite(target)) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [target])
  if (!Number.isFinite(target)) return null
  const remain = Math.floor((target - now) / 1000)
  if (remain <= 0) return <span className="ml-0.5 text-[10px] text-muted/60 italic">firing…</span>
  const label =
    remain < 60
      ? `${remain}s`
      : remain < 3600
        ? `${Math.floor(remain / 60)}m ${String(remain % 60).padStart(2, "0")}s`
        : `${Math.floor(remain / 3600)}h ${Math.floor((remain % 3600) / 60)}m`
  return <span className="ml-0.5 tabular-nums text-[10px] text-muted/60">in {label}</span>
}

// Human-friendly elapsed since an ISO timestamp: "just now", "12m", "1h 3m". Empty when unparseable.
function elapsed(startedAt: string): string {
  const t = Date.parse(startedAt)
  if (!Number.isFinite(t)) return ""
  const mins = Math.floor((Date.now() - t) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// Coarse duration for a FIXED span (a dispatch→completion elapsed, in ms): "<1m", "42m", "1h 3m".
// Distinct from elapsed(), which measures an ISO start against now for a still-running child.
function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "<1m"
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// A sub-agent completion event — transcript PUNCTUATION between message bands. Quiet and muted (~12px,
// no bubble, no icon chrome): a centered label flanked by faint hairlines so it reads as a timeline
// marker, sitting at the same message rhythm as everything around it.
function EventLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[12px] text-muted/55">
      <span aria-hidden className="h-px flex-1 bg-border/60" />
      <span className="shrink-0">{text}</span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  )
}

// The exact Nav row-indicator spinner (7px, 1.5px stroke) — pairs with any LIVE (running, not stale)
// sub-agent so its activity reads at a glance. Stale / finished children get no spinner.
function LiveSpinner() {
  return (
    <span
      aria-hidden
      className="block shrink-0 rounded-full border-[1.5px] border-muted/70 border-t-transparent animate-spin"
      style={{ width: 7, height: 7 }}
    />
  )
}

// The free-text row's identifier: one past the last option ("A. B. C." → "D.", "1. 2." → "3.").
function nextOptionId(options: string[]): string {
  const last = options[options.length - 1]?.match(/^\s*([A-Za-z]|\d+)([.)])\s/)
  if (!last) return `${String.fromCharCode(65 + options.length)}.`
  const [, id, punct] = last
  return /\d/.test(id) ? `${Number(id) + 1}${punct}` : `${String.fromCharCode(id.toUpperCase().charCodeAt(0) + 1)}${punct}`
}

// Match a "Recommendation: B — …" line to its option by leading identifier ("B." / "B)" / "2." …).
// Null when nothing matches (free-form recommendations keep the caption rendering).
function recommendedIndex(recommendation: string | undefined, options: string[]): number | null {
  if (!recommendation) return null
  const m = recommendation.replace(/^\s*recommendation\s*:?\s*/i, "").match(/^([A-Za-z]|\d+)\b/)
  if (!m) return null
  const id = m[1].toUpperCase()
  const idx = options.findIndex((o) => {
    const om = o.match(/^\s*([A-Za-z]|\d+)[.)]\s/)
    return om ? om[1].toUpperCase() === id : false
  })
  return idx === -1 ? null : idx
}

// A single answer choice: a left-aligned neutral button; when selected it takes the subtle accent
// border (focus-adjacent selection). A `multi` chip additionally carries a checkbox square (empty →
// checked) so the "toggle several" affordance reads unmistakably as multi-select vs the single-select
// chips' bare border highlight. Read-only (no interactive controller) → muted and non-clickable.
function Chip({
  label,
  selected,
  disabled,
  multi,
  recommended,
  recTitle,
  onClick,
}: {
  label: string
  selected: boolean
  disabled: boolean
  multi?: boolean
  recommended?: boolean
  recTitle?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      title={recTitle}
      className={`text-left rounded-md border px-2.5 py-1.5 text-[12px] leading-snug outline-none transition-colors flex items-start gap-2 ${
        selected
          ? "border-accent bg-accent/10 text-fg"
          : disabled
            ? "cursor-default border-border text-muted/80"
            : "border-border text-fg/90 hover:bg-panel-2 hover:border-border-strong"
      }`}
    >
      {multi && (
        <span
          aria-hidden
          className={`mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
            selected ? "border-accent bg-accent text-bg" : "border-border-strong"
          }`}
        >
          {selected && <Check size={10} strokeWidth={3} />}
        </span>
      )}
      <span className="min-w-0 flex-1">{label}</span>
      {recommended && (
        <span className="shrink-0 self-center rounded-full border border-border-strong px-1.5 py-px text-[9.5px] uppercase tracking-wide text-muted">
          Recommended
        </span>
      )}
    </button>
  )
}

function Dots() {
  return <span className="inline-block w-2.5 h-2.5 rounded-full border border-muted/70 border-t-transparent animate-spin" />
}

// The turn-in-flight banner: shimmering "Working…" (the ambient AI-at-work treatment) followed by a
// dimmed elapsed timer. The baseline is the last real user interaction (server-derived, so it reads
// as true turn duration and survives reloads); a thread with no usable timestamp falls back to
// mount time. Ticks once a second — cheap, and unmounts with the banner.
function WorkingIndicator({ since }: { since?: string }) {
  const [baseline] = useState(() => {
    const t = Date.parse(since ?? "")
    return Number.isFinite(t) && t <= Date.now() ? t : Date.now()
  })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((now - baseline) / 1000))
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="shimmer-text">Working…</span>
      <span className="tabular-nums text-[12px] text-muted/60">{label}</span>
    </div>
  )
}
