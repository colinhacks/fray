import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { Check, ChevronRight, CircleDashed, Clock, Ellipsis, FileText, Github, Hourglass, Timer } from "lucide-react"
import type { AwaitingHint, BoardSnapshot, PlanView, ThreadView } from "@fray-ui/shared"
import { store, openThread, scrollToQueueCard, pushSubAgentDrawer, pushPlanDrawer, type ConnectionState } from "../store.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { prefs } from "../lib/prefs.ts"
import { sectionThreads, partitionActive, needsAction, displayTitle, titleIsProvisional, isHeld, parkedAwaitingHint, sessionIndicatorKind, futureSnoozedUntil } from "../groups.ts"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { QuotaBar } from "./QuotaBar.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { ProviderMark } from "./ProviderMark.tsx"
import { STATUS_CHIP } from "../lib/status.ts"
import { formatSnoozedUntil, formatSnoozeWake } from "../lib/snooze.ts"
import { activeSidebarSection, railRevealDelta, type SidebarSectionGeometry } from "../lib/sidebarScrollspy.ts"
import type { ReactElement, ReactNode } from "react"

// THE LEFT SIDEBAR — the thread list as a FLOATING column (no border, no fill: it floats in the
// page's whitespace the way the old ToC nav did). App centers the sidebar + workpane as a PAIR with
// a fixed gutter between them; this column is VERTICALLY CENTERED in the viewport and holds still
// while the workpane scrolls. Width SCALES with the viewport — clamp(240px, 30vw, 600px) — so titles
// get real room on large screens (titles WRAP, never truncate; captions stay one line; NEVER a
// horizontal scrollbar — overflow-x is clipped and unbreakable tokens break).
//
// ENTIRELY MOUSE-DRIVEN: no arrow-walk, no selection chevron. A session row CLICK opens the thread's
// drawer (chat / doc via store.openThread); a plan row opens the plan drawer; a legacy row opens its
// fray doc.
//
// Sections: THREE bands top→bottom — Active, then a labeled DIMMED Held band (every declared
// clock/hourglass/timed wait), then the collapsible
// Done — each split by a bare <hr>. A thread merely awaiting its OWN sub-agents is INTERNAL work
// and stays in Active undimmed; only external waiters drop into the dimmed band (see groups.ts
// isHeld). Needs-you renders as the row INDICATOR + the queue; awaiting as the hint gloss.
// Plans from board.plans; Done = explicitly completed. Legacy .fray rows and foreign terminal
// sessions do not render at all.


export function Sidebar() {
  const snap = useSnapshot(store)
  const board = useBoard()
  const all = asThreads(board?.threads ?? [])
  const sections = sectionThreads(all, useSnapshot(prefs).queueOrder)
  const plans = (board?.plans ?? []) as PlanView[]
  const collapsed = snap.sidebarCollapsed
  const activeThreads = sections.active
  const heldThreads = sections.held
  const inactiveThreads = sections.inactive
  const railRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const pendingNavigation = useRef<string | null>(null)

  const syncActiveSection = useCallback(() => {
    const items = [...document.querySelectorAll<HTMLElement>("[data-queue-card][data-queue-leaving=\"false\"]")]
      .map((element) => {
        const id = element.dataset.queueCard
        if (!id) return null
        const { top, bottom } = element.getBoundingClientRect()
        return { id, top, bottom } satisfies SidebarSectionGeometry
      })
      .filter((item): item is SidebarSectionGeometry => item !== null)
    const pending = pendingNavigation.current
    if (pending) {
      const target = items.find((item) => item.id === pending)
      if (target && target.top <= 12 && target.bottom > 12) pendingNavigation.current = null
      else if (target) {
        setActiveId(pending)
        return
      } else pendingNavigation.current = null
    }
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const atDocumentBottom = maxScrollY > 0 && window.scrollY >= maxScrollY - 1
    const nextActiveId = activeSidebarSection(items, undefined, atDocumentBottom)
    // Scroll/resize observations can fire several times per frame. Preserve the same primitive
    // state value to avoid a needless row-tree update when the selected card has not changed.
    setActiveId((current) => current === nextActiveId ? current : nextActiveId)
  }, [])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncActiveSection)
    }
    schedule()
    // Capture scroll so this also follows an app-level scrolling element if the page's scroll root
    // changes. The rail's own scroll is harmless here (card geometry has not changed), while a
    // programmatic/smooth queue-card scroll is always observed.
    document.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", schedule)
    const workpane = document.getElementById("workpane")
    const observer = workpane ? new ResizeObserver(schedule) : null
    // Transcript expansion, card exits, and keyframe reorders can change which card crosses the
    // reading line without a window scroll. Observe those DOM changes as well as the workpane box.
    const mutations = workpane ? new MutationObserver(schedule) : null
    if (workpane) observer?.observe(workpane)
    if (workpane) mutations?.observe(workpane, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue-card", "data-queue-leaving", "style", "class"] })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [syncActiveSection, snap.view, snap.drawers.length])

  // Reveal a newly active row inside the rail itself. Direct scrollTop adjustment is intentionally
  // local: Element.scrollIntoView could scroll the main document and steal the reader's position.
  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || !activeId || window.matchMedia("(max-width: 800px)").matches) return
    const item = rail.querySelector<HTMLElement>(`[data-sidebar-item="${CSS.escape(activeId)}"]`)
    if (!item) return
    const railBox = rail.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    const delta = railRevealDelta(railBox.top, railBox.bottom, itemBox.top, itemBox.bottom)
    if (Math.abs(delta) > 0.5) rail.scrollTop += delta
  }, [activeId])

  const navigateToQueueCard = useCallback((id: string) => {
    pendingNavigation.current = id
    setActiveId(id)
  }, [])

  return (
    // HEIGHT MODEL: a sticky, exactly viewport-height wrapper that CENTERS the inner column, which
    // grows fit-content to a near-flush cap and scrolls internally only past it. overflow-x is CLIPPED
    // (titles wrap; min-w-0 at every level). No bg/clip on the column itself.
    <aside className="sticky top-0 self-start h-screen w-[clamp(320px,34vw,680px)] shrink-0 flex flex-col justify-center min-[801px]:z-[100] max-[800px]:static max-[800px]:h-auto max-[800px]:w-full max-[800px]:justify-start max-[800px]:pt-16">
      {/* The content column FILLS the aside track (no narrow inner cap). */}
      <div className="flex max-h-[calc(100vh-32px)] min-h-0 min-w-0 w-full flex-col max-[800px]:max-h-none">
        {/* THE PROMPT BOX lives at the sidebar top (it replaced the New-thread pill — maintainer
            2026-07-09): always present, type + Enter dispatches a new thread. A brand-new repo shows
            this same box CENTERED as the whole screen (App hides the sidebar); the first dispatch
            shunts it here to the left. */}
        <div className="mb-5 shrink-0 px-0.5">
          {/* A thin status strip floats directly above the prompt box: live connection dot + remaining
              Claude/Codex subscription quota. */}
          <QuotaBar />
          {/* The GitHub picker's door now lives INSIDE the dispatch composer (a small icon left of the
              send button — see DispatchForm/Composer leftAction); no separate pill here. */}
          <DispatchForm />
        </div>
        <div ref={railRef} data-sidebar-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden max-[800px]:overflow-y-visible">
          {/* ACTIVE — always shown, NEVER collapsible (you can't hide your live work), no label. Split
              into two rule-separated bands (see groups.ts orderActive/partitionActive): live work that
              isn't waiting on you on TOP, then everything at rest below, in the EXACT Needs-you queue
              order so scrolling the queue walks the scroll marker straight down this rail (running
              agents have no queue card — the maintainer's ask: they don't render in the queue). */}
          {activeThreads.length > 0 ? (
            (() => {
              const { running, rested } = partitionActive(activeThreads)
              const renderRow = (t: ThreadView) => (
                <div key={t.id}>
                  <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
                  <SubAgentRows t={t} />
                </div>
              )
              return (
                <>
                  {running.map(renderRow)}
                  {running.length > 0 && rested.length > 0 && <hr className="my-3 border-border/50" />}
                  {rested.map(renderRow)}
                </>
              )
            })()
          ) : (
            <div className="px-1.5 py-1 text-[11.5px] text-muted/50">No active threads</div>
          )}
          {/* HELD — every deliberate clock/hourglass/timed wait, visibly de-emphasized and labeled so
              it cannot read as active work. Always expanded; held work must remain glanceable. */}
          {heldThreads.length > 0 && (
            <section aria-label="Held">
              <hr className="my-3 border-border/50" />
              <div className="flex w-full items-center justify-between px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted/55">
                <span>Held</span>
                <span className="tabular-nums">{heldThreads.length}</span>
              </div>
              {heldThreads.map((t) => (
                <div key={t.id}>
                  <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
                  <SubAgentRows t={t} />
                </div>
              ))}
            </section>
          )}
          {/* DONE — collapsible, OMITTED entirely (with its rule) when empty. */}
          {inactiveThreads.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="Done"
                count={inactiveThreads.length}
                collapsed={collapsed.inactive}
                onToggle={() => (store.sidebarCollapsed.inactive = !store.sidebarCollapsed.inactive)}
              />
              {!collapsed.inactive &&
                inactiveThreads.map((t) => (
                  <div key={t.id}>
                    <ThreadRow t={t} active={activeId === t.id} onQueueNavigate={navigateToQueueCard} />
                    <SubAgentRows t={t} />
                  </div>
                ))}
            </div>
          )}
          {/* PLANS — collapsible, OMITTED (with its rule) when empty. Artifacts, not threads. */}
          {plans.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="Plans"
                count={plans.length}
                collapsed={collapsed.plans}
                onToggle={() => (store.sidebarCollapsed.plans = !store.sidebarCollapsed.plans)}
              />
              {!collapsed.plans && plans.map((p) => <PlanRow key={p.path} plan={p} />)}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

// A collapsible section header: a rotating caret, the label, and a right-justified count.
function SectionHeader({ label, count, collapsed, onToggle }: { label: string; count: number; collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-1 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted/70 transition-colors hover:text-fg"
    >
      <ChevronRight size={11} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
      <span>{label}</span>
      {/* Count rides right next to its label (not floated to the far edge) — it's meaningful data,
          not a margin ornament; raised contrast so it actually reads. */}
      <span className="ml-1.5 tabular-nums text-muted/60">{count}</span>
    </button>
  )
}

// One THREAD row. Session rows (the default): the derived session indicator, the title, a foreign
// read-only tag, an awaiting hint gloss, and the activity + live-sub-agent suffix. NO Mark-as verb —
// session threads use Archive in the persistent thread footer. A LEGACY row
// keeps the vestigial rendering: a status chip + the hover-revealed Mark-as split button (the ONLY
// place it survives). A click opens the thread's drawer (openThread routes chat/doc).
//
// MEMOIZED: board deltas REPLACE a changed thread's whole object, so `t` keeps snapshot identity iff
// unchanged — memo skips exactly the untouched rows.
export const ThreadRow = memo(function ThreadRow({
  t,
  legacy,
  active = false,
  onQueueNavigate,
}: {
  t: ThreadView
  legacy?: boolean
  active?: boolean
  onQueueNavigate?: (id: string) => void
}) {
  const subs = t.subAgents ?? []
  const subLabel = subs.length === 1 ? subs[0].label : subs.length > 1 ? `${subs.length} sub-agents` : null
  const singleType = subs.length === 1 ? subs[0].subagentType : undefined
  const subTooltip = subs.map((s) => (s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label)).join("\n")
  const foreign = !legacy && t.foreign === true
  // Held rows are uniformly grayed as a whole; provisional titles retain their local dim treatment.
  // A thread awaiting its OWN live sub-agent/Monitor is not Held and stays fully active.
  const held = !legacy && isHeld(t)
  const dimLabel = !legacy && titleIsProvisional(t)
  // An awaiting session row glosses its first machine-wait hint (e.g. "PR owner/repo#12").
  const snoozedUntil = !legacy ? futureSnoozedUntil(t) : undefined
  const gloss = snoozedUntil
    ? `SNOOZED · ${formatSnoozeWake(snoozedUntil)}`
    : !legacy && t.lastFence?.kind === "awaiting"
      ? hintGloss(t.lastFence.hints)
      : null
  const hasSubtitle = Boolean(t.activity) || subLabel !== null || gloss !== null
  return (
    <div
      data-sidebar-item={t.id}
      className={`group relative flex min-w-0 items-start rounded-md transition-[color,background-color,opacity] hover:bg-white/[0.04] ${legacy ? "opacity-80" : held ? "opacity-65 hover:opacity-90 focus-within:opacity-90" : ""}`}
    >
      {/* The reading position owns a real, in-row rail rather than borrowing the status-icon column.
          The marker spans the row's complete visual height, including wrapped titles and subtitles,
          while the fixed rail keeps it from shifting content or relying on clipped overflow. */}
      <span aria-hidden="true" data-sidebar-marker-rail className="pointer-events-none absolute inset-y-0 left-0 w-5">
        {active && <span data-sidebar-scroll-marker className="absolute inset-y-0 left-1 w-[2px] rounded-full bg-accent" />}
      </span>
      <button
        onClick={() => {
          // A queued (needsYou) thread already has its full card in the main column. A sidebar click
          // just SCROLLS to that card — it does NOT open a redundant drawer over it (maintainer
          // 2026-07-15: "it should not open the thread drawer, just auto-scroll to the item in the
          // queue"). Only fall through to the drawer when no card is mounted (not queued/not rendered).
          if (t.needsYou && scrollToQueueCard(t.id)) {
            onQueueNavigate?.(t.id)
            return
          }
          openThread(t.id)
        }}
        aria-current={active ? "location" : undefined}
        className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1 text-left"
      >
        {/* h-[19px] so the indicator centers on the title's FIRST line, not the middle of a wrapped row. */}
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <ThreadIndicator t={t} legacy={legacy} />
        </span>
          <span className="min-w-0 flex-1 flex flex-col">
          <span className={`break-words text-[13px] leading-[19px] ${dimLabel ? "text-fg/50" : held ? "text-fg/75" : "text-fg/90"}`}>
            {displayTitle(t)}
            {!legacy && <ProviderMark backend={t.backend} className="ml-1" />}
            {foreign && (
              <span
                className="petite-caps ml-1.5 inline-block rounded border border-border/60 px-1 align-[2px] text-[9.5px] leading-[14px] text-muted/55"
                title="Read-only — running in an external terminal"
              >
                terminal
              </span>
            )}
            {legacy && <StatusChip status={t.archived ? "archived" : t.status} />}
          </span>
          {hasSubtitle && (
            <span className="mt-0.5 flex flex-col gap-0.5 min-w-0 text-[11.5px] leading-[15px]">
              {gloss && (
                <span className="min-w-0 truncate text-muted/70" title={gloss}>{gloss}</span>
              )}
              {t.activity && (
                <span className="min-w-0 truncate text-muted/70" title={t.activity}>{t.activity}</span>
              )}

            </span>
          )}
        </span>
      </button>
      {/* The Mark-as verb survives ONLY on legacy rows (a .fray verb). Session lifecycle controls
          live in the thread footer. */}
      {legacy && (
        <div className="absolute right-1 top-1 hidden group-hover:flex items-stretch rounded-md bg-panel shadow-sm shadow-black/30">
          <MarkAsButton slug={t.id} size="sm" />
        </div>
      )}
      {/* RUNNING SUB-AGENT CHILD ROWS (maintainer 2026-07-09: render running sub-agents in the
          sidebar). One indented row per live child under its parent thread — spinner while running,
          faint when stale; click opens the sub-agent transcript drawer over the parent. Replaces the
          old one-line ⤷ suffix. */}
    </div>
  )
})

function SubAgentRows({ t }: { t: ThreadView }) {
  // id is the drill-in drawer's RPC handle — a child without one (old snapshot shape) can't open, so
  // it doesn't row.
  const subs = (t.subAgents ?? []).filter((s): s is typeof s & { id: string } => Boolean(s.id) && (s.state === "running" || s.state === "stale"))
  if (subs.length === 0) return null
  return (
    <div className="flex flex-col">
      {subs.map((s) => (
        <button
          key={s.id}
          // Marks this row as a drill-in for its parent thread: an open ThreadSheet for t.id sees
          // the pointer-down land here and skips its outside-pointer self-dismiss, so the child
          // sheet STACKS over the parent instead of replacing it (see ThreadSheet).
          data-subagent-parent={t.id}
          onClick={() => pushSubAgentDrawer(t.id, s.id, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt })}
          className="group/sub flex min-w-0 items-center gap-2 rounded-md py-0.5 pl-[26px] pr-1.5 text-left transition-colors hover:bg-white/[0.04]"
          title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label}
        >
          <span aria-hidden className="shrink-0 text-[11px] leading-none text-muted/45">⤷</span>
          <span className="w-3.5 shrink-0 flex items-center justify-center">
            {/* Same rounded-rect spinner SHAPE as the top-level rows, scaled down for the indented child. */}
            {s.state === "running" ? (
              <BoxSpinner size={12} />
            ) : (
              <span className="block h-1.5 w-1.5 rounded-full bg-muted/30" title="stale — no recent output" />
            )}
          </span>
          <span className="min-w-0 truncate text-[11.5px] leading-[16px] text-muted/70">{s.label}</span>
        </button>
      ))}
    </div>
  )
}

// One PLAN row (from board.plans): a doc glyph + the plan title. A click opens the plan drawer (its
// markdown + an "Implement this" affordance). Threads dispatched from the plan are its history —
// the count rides the title tooltip.
function PlanRow({ plan }: { plan: PlanView }) {
  const n = plan.threadIds?.length ?? 0
  return (
    <div className="group relative flex min-w-0 items-start rounded-md transition-colors hover:bg-white/[0.04]">
      <button
        onClick={() => pushPlanDrawer(plan.path, plan.title)}
        className="min-w-0 flex-1 flex items-start gap-2 px-1.5 py-1 text-left"
        title={n ? `${n} thread${n === 1 ? "" : "s"} from this plan` : undefined}
      >
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <FileText size={12} className="text-muted/60" />
        </span>
        <span className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-fg/90">
          {plan.title}
          {n > 0 && <span className="ml-1.5 tabular-nums text-[10.5px] text-muted/45">{n}</span>}
        </span>
      </button>
    </div>
  )
}

// Small-caps bordered status label on legacy rows. Inline so it flows after a wrapped title's last
// word. Colors come from the shared status palette so chips + picker dots speak one language.
function StatusChip({ status }: { status: string }) {
  const label = status === "archived" ? "Done" : status
  return (
    <span className={`petite-caps ml-1.5 inline-block rounded border px-1 align-[2px] leading-[14px] text-[9.5px] ${STATUS_CHIP[status] ?? "text-muted border-border"}`}>
      {label}
    </span>
  )
}

// Format a parked-wait hint as a compact row subtitle. Current human/timer hints take precedence;
// legacy PR/CI remain readable. A `session` hint is NOT glossed — its value is an internal id that reads as
// leaked internals in the row subtitle (maintainer 2026-07-10: "what the fuck is that?! looks bad");
// the CircleDashed indicator + its "Waiting on another session" tooltip already carry that state.
// Null when there's no glossable hint.
export function hintGloss(hints: readonly AwaitingHint[]): string | null {
  const h = parkedAwaitingHint(hints) ?? hints.find((x) => x.kind === "pr" || x.kind === "ci")
  if (!h) return null
  if (h.kind === "timer") return formatSnoozedUntil(h.value) ?? "Timer schedule unavailable"
  const label = h.kind === "pr" ? "PR" : h.kind === "ci" ? "CI" : h.kind === "human" ? "HUMAN" : h.kind === "github-review" ? "REVIEW" : h.kind
  return `${label} ${h.value}`
}

// ── the indicator (one per row) ──────────────────────────────────────────────────────────────────

// One indicator, one diameter: the spinner ring and the machine-wait glyphs occupy the same optical
// size so rows read evenly. ATTENTION marks (needs-you / question) run a touch LARGER and full-accent
// on purpose — "what needs you" must be the most salient pixel on the rail, never the least.
const INDICATOR = 7
const ATTENTION = 9

// Each indicator carries a terse hover tooltip naming the state it signals. The faint "at rest" dot
// gets none. A plain wrapper <span> is the tooltip trigger (a real DOM node Radix can ref).
export function ThreadIndicator({ t, legacy }: { t: ThreadView; legacy?: boolean }) {
  const { node, tip } = legacy ? legacyIndicatorFor(t) : sessionIndicatorFor(t)
  if (!tip) return node
  return (
    <Tooltip label={tip} side="left">
      <span className="flex items-center justify-center">{node}</span>
    </Tooltip>
  )
}

// The SESSION-first row indicator (kind === "session"). A "?" is reserved for a concrete unresolved
// input state: question/ask, typed interaction, native selector, permission prompt, or explicit human
// block. Queue membership by itself is only a handoff: a bare rested thread keeps the ordinary
// ellipsis. Everything the human is not on the hook for remains quieter: a spinner (in motion), a
// muted hourglass (intentional hold), a quiet check (done/archived), or the at-rest ellipsis.
// STATUS = a markdown-task CHECKBOX family (maintainer 2026-07-10, Obsidian-flavored): every state is
// the SAME rounded-rect outer box with a glyph inside, so the rail reads like a to-do list.
//   [ ] idle        — at rest, nothing pending (empty box)
//   [/] in progress — the rounded-RECT spinner (a segment travels the box perimeter)
//   [?] needs input — a question / native ask / permission prompt (accent box + "?")
//   [!] stalled     — the agent EXITED while it still needed you (a crash; accent box + "!")
//   clock waiting   — machine-waiting behind an ```awaiting fence
//   [✓] done        — a ```done fence at rest, OR an archived thread (muted check — NOTHING else)
//   […] at rest     — an ordinary bare rest with no concrete ask
// Attention (needs-input / stalled) wears the accent; everything else is muted.
function sessionIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  const kind = sessionIndicatorKind(t)
  if (kind === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
  if (kind === "needs-input") {
    // Muted "?", same gray as every other glyph — a needs-you thread already carries maximum emphasis
    // by sitting in the ⚖ queue, so the rail indicator adds NO extra color (maintainer 2026-07-10).
    return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip: "Needs your input" }
  }
  if (kind === "working") return { node: <BoxSpinner />, tip: "Working" }
  if (kind === "done") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
  if (kind === "stalled") return { node: <StatusBox accent><Glyph ch="!" /></StatusBox>, tip: "Stalled — the agent exited" }
  if (kind === "held") {
    const snoozedUntil = futureSnoozedUntil(t)
    if (snoozedUntil) {
      return {
        node: <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>,
        tip: `Snoozed until ${formatSnoozeWake(snoozedUntil)}`,
      }
    }
    // Canonical blocked+timer status can arrive from an older/pre-session snapshot without a fence.
    if (t.lastFence?.kind !== "awaiting") {
      return { node: <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting until a scheduled check" }
    }
    // Reserve the hourglass for intentional park states: a specific external human gate, a durable
    // GitHub human-review cursor, or a VALID scheduled instant. Legacy/malformed waits stay readable
    // but do not claim that a working wake is armed.
    const parked = parkedAwaitingHint(t.lastFence.hints)?.kind
    if (parked === "human") return { node: <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting on a human review or approval" }
    if (parked === "github-review") return { node: <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>, tip: "Watching for new non-bot human GitHub review activity" }
    if (parked === "timer") return { node: <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting until a scheduled check" }
    const hk = t.lastFence.hints[0]?.kind
    if (hk === "pr") return { node: <StatusBox><Github size={9} className="text-muted/70" /></StatusBox>, tip: "Legacy PR wait — active monitoring is not armed" }
    if (hk === "ci") return { node: <StatusBox><Clock size={9} className="text-muted/70" /></StatusBox>, tip: "Legacy CI wait — active monitoring is not armed" }
    if (hk === "session") return { node: <StatusBox><CircleDashed size={10} className="text-muted/70" /></StatusBox>, tip: "Waiting on another session" }
    return { node: <StatusBox><Clock size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting on a machine" }
  }
  // Bare at rest (no fence, no live sub, nothing pending) — a worker that came to rest WITHOUT
  // declaring done or a machine-wait. Read it as WAITING (maintainer 2026-07-10: a rested-not-done
  // thread "should be blocked or waiting", never a stark empty box and never a false check). We don't
  // know the reason — the worker didn't fence — so: the clock, with NO hint gloss (vs an ```awaiting
  // fence, which carries pr/ci hints AND dims + sinks the row). The honest fix is the worker emitting
  // ` ```awaiting ` when it's blocked on a machine; until then this is our best-guess "paused/waiting".
  return { node: <StatusBox><Ellipsis size={11} className="text-muted/70" /></StatusBox>, tip: "At rest" }
}

// THE shared rounded-rect checkbox — the ONE outer shape every status glyph sits in.
const BOX = 15
function StatusBox({ accent, children }: { accent?: boolean; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[4px] border ${accent ? "border-accent/90" : "border-muted/45"}`}
      style={{ width: BOX, height: BOX }}
    >
      {children}
    </span>
  )
}
// A bold single-char glyph (?, !) centered in the box. Accent by default; `muted` renders it the same
// gray as every other rail glyph (the "?" needs-you mark — the ⚖ queue already carries the emphasis).
function Glyph({ ch, muted }: { ch: string; muted?: boolean }) {
  return (
    <span aria-hidden className={`font-bold leading-none ${muted ? "text-muted/70" : "text-accent"}`} style={{ fontSize: 10 }}>
      {ch}
    </span>
  )
}
// [/] IN PROGRESS — the rounded-RECT spinner: a faint full outline with a bright segment travelling the
// perimeter (matches the checkbox shape instead of a circle — maintainer 2026-07-10). `size` lets the
// indented sub-agent rows use a smaller one so the two spinners stay the same SHAPE at different scales.
function BoxSpinner({ size = BOX }: { size?: number }) {
  // Geometry MUST match StatusBox exactly (maintainer 2026-07-10: the spinner read "slightly smaller
  // and bolder"). StatusBox is a 15px border-box with a 1px border and rounded-[4px] corners, so the
  // border's outer edge sits at 0/15. To replicate that with a center-drawn SVG stroke: strokeWidth 1,
  // inset the path by 0.5 (x=0.5, w=14) so the stroke's outer edge lands on the box edge, and rx=3.5
  // (4px outer radius minus the 0.5 half-stroke). Perimeter of that rounded rect ≈ 50, so the dash sum
  // stays 50. The faint base outline is toned to the checkbox's border-muted/45 weight.
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" aria-hidden className="text-muted/85">
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeDasharray="11 39">
        <animate attributeName="stroke-dashoffset" from="50" to="0" dur="1.1s" repeatCount="indefinite" />
      </rect>
    </svg>
  )
}

// The LEGACY (.fray status) row indicator — the vestigial status-keyed logic, kept only for the
// read-only Legacy shelf.
function legacyIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  if (t.runtime === "running" || t.runtime === "spawning" || t.runtime === "perm-prompt") return { node: <Spinner />, tip: "Working" }
  const liveSub = (t.subAgents ?? []).some((s) => s.state === "running")
  if (t.runtime === "turn-idle" && liveSub && !t.humanBlocked) return { node: <Spinner />, tip: "Working" }
  if (needsAction(t)) return { node: <BlueDot />, tip: "Needs your input" }
  if (t.status === "needs-human") return { node: <YellowDot />, tip: "Awaiting you — open to read & reply" }
  if (t.status === "blocked" && t.mechanism === "timer") return { node: <Timer size={INDICATOR + 1} className="text-muted/70" />, tip: "Waiting on a timer" }
  if (t.status === "blocked" && t.mechanism === "threads") return { node: <CircleDashed size={INDICATOR + 1} className="text-muted/70" />, tip: "Waiting on other work" }
  return { node: <FaintDot />, tip: null }
}

function Spinner() {
  return (
    <span
      // Matches the sub-agent child-row spinner EXACTLY (8px, 1px border) — the maintainer converged
      // the two after the top-level spinner (was 7px/1.5px) read visibly smaller than the sub-agent's.
      className="block rounded-full border border-muted/70 border-t-transparent animate-spin"
      style={{ width: 8, height: 8 }}
    />
  )
}

// THE attention mark — needs-you at rest. The signature accent (#e8b923) at full strength with a
// soft halo: the app spends its yellow in exactly one place, and this is it. Larger than the machine
// glyphs so it wins the row at a glance.
function AccentDot() {
  return (
    <span
      className="block rounded-full bg-accent shadow-[0_0_5px_rgba(232,185,35,0.45)]"
      style={{ width: ATTENTION, height: ATTENTION }}
    />
  )
}

function BlueDot() {
  return <span className="block rounded-full bg-sky-400" style={{ width: INDICATOR, height: INDICATOR }} />
}

// Awaiting-you without a queue card (legacy session-less needs-human): the status palette's yellow.
function YellowDot() {
  return <span className="block rounded-full bg-yellow-400" style={{ width: INDICATOR, height: INDICATOR }} />
}

function FaintDot() {
  return <span className="block rounded-full bg-muted/30" style={{ width: INDICATOR, height: INDICATOR }} />
}

// The top-left identity is intentionally derived only from the currently adopted board keyframe.
// There is no session/local-storage cache: keeping a stale owner/repo while another project or boot
// is becoming authoritative is worse than showing this small neutral reservation. A transport reset
// leaves the adopted board in the store, so a normal reconnect keeps its known identity in place.
export type ProjectIdentity =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "verified"; label: string; owner: string; repo: string }

export function projectIdentity(board: Pick<BoardSnapshot, "projectLabel"> | null | undefined): ProjectIdentity {
  if (!board) return { state: "loading" }
  const label = board.projectLabel.trim()
  const cut = label.lastIndexOf("/")
  const owner = cut === -1 ? "" : label.slice(0, cut).trim()
  const repo = cut === -1 ? "" : label.slice(cut + 1).trim()
  // `projectLabel` deliberately falls back to the directory basename when there is no origin. That
  // name is useful server metadata, but it is not a verified owner/repo identity and must not guess.
  return owner && repo ? { state: "verified", label, owner, repo } : { state: "unavailable" }
}

// The workspace identity mark, pinned by App to the page's TOP-LEFT corner: verified labels use the
// owner/repo styling — a muted owner, a muted slash, the repo name bright — plus the live SSE dot
// and its state word. Before that identity exists, a static neutral reservation prevents a false
// name and keeps the connection indicator optically anchored without a distracting shimmer.
export function IdentityMark({
  identity,
  state,
  boardFallback,
}: {
  identity: ProjectIdentity
  state: ConnectionState
  boardFallback?: { actualBytes: number; maxBytes: number } | null
}) {
  const map = {
    open: { cls: "bg-live", word: "connected" },
    connecting: { cls: "bg-accent", word: "connecting…" },
    closed: { cls: "bg-red-500", word: "disconnected" },
  } as const
  const m = map[state]
  const usingFallback = state === "open" && !!boardFallback
  const connectionLabel = usingFallback ? "connected through SSE fallback" : m.word
  const accessibleLabel = identity.state === "verified"
    ? `Project: ${identity.label}; ${connectionLabel}`
    : identity.state === "loading"
      ? `Project identity loading; ${connectionLabel}`
      : `Project identity unavailable; ${connectionLabel}`
  return (
    <div
      className="flex items-center gap-2 min-w-0 max-w-full text-[12px]"
      data-project-identity-state={identity.state}
      aria-label={accessibleLabel}
      aria-busy={identity.state === "loading" || undefined}
    >
      <span className={`identity-slot ${identity.state === "verified" ? "identity-slot--resolved" : "identity-slot--placeholder"}`}>
        {identity.state === "verified" ? (
          <span className="block min-w-0 truncate" title={identity.label}>
            <span className="text-muted">{identity.owner}</span>
            <span className="text-muted/60 ml-0.5 mr-1">/</span>
            <span className="font-semibold text-fg/90">{identity.repo}</span>
          </span>
        ) : (
          <span className="identity-placeholder" aria-hidden="true" />
        )}
      </span>
      <span
        // Identity and live state are one compact header cluster. Its content chooses the measure:
        // reserving a fixed status column left a conspicuous blank track after owner/repo resolved.
        className="flex items-center gap-1 shrink-0"
        data-board-sync-fallback={usingFallback || undefined}
        title={usingFallback ? `Board payload exceeded the live socket limit; connected through SSE` : undefined}
      >
        <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${m.cls}`} />
        <span className="text-[10.5px] text-muted/70">{usingFallback ? "connected · SSE fallback" : m.word}</span>
      </span>
    </div>
  )
}
