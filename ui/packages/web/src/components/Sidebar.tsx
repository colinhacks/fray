import { memo } from "react"
import { useSnapshot } from "valtio"
import { Check, ChevronRight, CircleDashed, Clock, Ellipsis, FileText, Github, Hourglass, Timer } from "lucide-react"
import type { AwaitingHint, PlanView, ThreadView } from "@fray-ui/shared"
import { store, openThread, scrollToQueueCard, pushSubAgentDrawer, pushPlanDrawer, type ConnectionState } from "../store.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { sectionThreads, needsAction, displayTitle, titleIsProvisional, isAwaitingExternal } from "../groups.ts"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { STATUS_CHIP } from "../lib/status.ts"
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
// Sections (v3, maintainer 2026-07-10): THREE bands top→bottom — Active, then a DIMMED
// Awaiting-external band (genuinely blocked on an external pr/ci/timer gate), then the collapsible
// Inactive — each split by a bare <hr>. A thread merely awaiting its OWN sub-agents is INTERNAL work
// and stays in Active undimmed; only external waiters drop into the dimmed band (see groups.ts
// isAwaitingExternal). Needs-you renders as the row INDICATOR + the queue; awaiting as the hint gloss.
// Plans from board.plans; Inactive = explicitly archived. Legacy .fray rows and foreign terminal
// sessions do not render at all.


export function Sidebar() {
  const snap = useSnapshot(store)
  const board = useBoard()
  const all = asThreads(board?.threads ?? [])
  const sections = sectionThreads(all)
  const plans = (board?.plans ?? []) as PlanView[]
  const collapsed = snap.sidebarCollapsed
  const activeThreads = sections.active
  const awaitingExternalThreads = sections.awaitingExternal
  const inactiveThreads = sections.inactive

  return (
    // HEIGHT MODEL: a sticky, exactly viewport-height wrapper that CENTERS the inner column, which
    // grows fit-content to a near-flush cap and scrolls internally only past it. overflow-x is CLIPPED
    // (titles wrap; min-w-0 at every level). No bg/clip on the column itself.
    <aside className="sticky top-0 self-start h-screen w-[clamp(320px,34vw,680px)] shrink-0 flex flex-col justify-center">
      {/* The content column FILLS the aside track (no narrow inner cap). */}
      <div className="flex max-h-[calc(100vh-32px)] min-h-0 min-w-0 w-full flex-col">
        {/* THE PROMPT BOX lives at the sidebar top (it replaced the New-thread pill — maintainer
            2026-07-09): always present, type + Enter dispatches a new thread. A brand-new repo shows
            this same box CENTERED as the whole screen (App hides the sidebar); the first dispatch
            shunts it here to the left. */}
        <div className="mb-5 shrink-0 px-0.5">
          {/* The GitHub picker's door now lives INSIDE the dispatch composer (a small icon left of the
              send button — see DispatchForm/Composer leftAction); no separate pill here. */}
          <DispatchForm />
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
          {/* ACTIVE — always shown, NEVER collapsible (you can't hide your live work), no label. */}
          {activeThreads.length > 0 ? (
            activeThreads.map((t) => (
              <div key={t.id}>
                <ThreadRow t={t} />
                <SubAgentRows t={t} />
              </div>
            ))
          ) : (
            <div className="px-1.5 py-1 text-[11.5px] text-muted/50">No active threads</div>
          )}
          {/* AWAITING-EXTERNAL — the DIMMED band for threads genuinely blocked on an external pr/ci/timer
              gate (isAwaitingExternal). A bare <hr> above (no header — the rule matches the other
              dividers); rows self-dim via dimLabel. OMITTED (with its rule) when empty. */}
          {awaitingExternalThreads.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              {awaitingExternalThreads.map((t) => (
                <div key={t.id}>
                  <ThreadRow t={t} />
                  <SubAgentRows t={t} />
                </div>
              ))}
            </div>
          )}
          {/* INACTIVE — collapsible, OMITTED entirely (with its rule) when empty. */}
          {inactiveThreads.length > 0 && (
            <div>
              <hr className="my-3 border-border/50" />
              <SectionHeader
                label="Inactive"
                count={inactiveThreads.length}
                collapsed={collapsed.inactive}
                onToggle={() => (store.sidebarCollapsed.inactive = !store.sidebarCollapsed.inactive)}
              />
              {!collapsed.inactive &&
                inactiveThreads.map((t) => (
                  <div key={t.id}>
                    <ThreadRow t={t} />
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
// session threads use Archive/Reopen/Kill in the thread header (those are .fray verbs). A LEGACY row
// keeps the vestigial rendering: a status chip + the hover-revealed Mark-as split button (the ONLY
// place it survives). A click opens the thread's drawer (openThread routes chat/doc).
//
// MEMOIZED: board deltas REPLACE a changed thread's whole object, so `t` keeps snapshot identity iff
// unchanged — memo skips exactly the untouched rows.
const ThreadRow = memo(function ThreadRow({ t, legacy }: { t: ThreadView; legacy?: boolean }) {
  const subs = t.subAgents ?? []
  const subLabel = subs.length === 1 ? subs[0].label : subs.length > 1 ? `${subs.length} sub-agents` : null
  const singleType = subs.length === 1 ? subs[0].subagentType : undefined
  const subTooltip = subs.map((s) => (s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label)).join("\n")
  const foreign = !legacy && t.foreign === true
  // Dim the label for a de-emphasized row: a PROVISIONAL title ("Spinning up a thread…", no real name
  // yet) or an AWAITING-EXTERNAL thread (the dimmed band — genuinely blocked on an external pr/ci/timer
  // gate). Both read as "not demanding your eyes right now" (maintainer 2026-07-10). A thread awaiting
  // its OWN sub-agents is internal work — NOT dimmed (it stays in Active).
  const dimLabel = !legacy && (titleIsProvisional(t) || isAwaitingExternal(t))
  // An awaiting session row glosses its first machine-wait hint (e.g. "PR owner/repo#12").
  const gloss = !legacy && t.lastFence?.kind === "awaiting" ? hintGloss(t.lastFence.hints) : null
  const hasSubtitle = Boolean(t.activity) || subLabel !== null || gloss !== null
  return (
    <div className={`group relative flex min-w-0 items-start rounded-md transition-colors hover:bg-white/[0.04] ${legacy ? "opacity-80" : ""}`}>
      <button
        onClick={() => {
          // A queued thread's card is already in the main column — scroll to it instead of opening a
          // drawer over it. Falls back to the drawer if no card is mounted (not queued / off-screen).
          if (t.needsYou && scrollToQueueCard(t.id)) return
          openThread(t.id)
        }}
        className="min-w-0 flex-1 flex items-start gap-2 px-1.5 py-1 text-left"
      >
        {/* h-[19px] so the indicator centers on the title's FIRST line, not the middle of a wrapped row. */}
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">
          <ThreadIndicator t={t} legacy={legacy} />
        </span>
        <span className="min-w-0 flex-1 flex flex-col">
          <span className={`break-words text-[13px] leading-[19px] ${dimLabel ? "text-fg/50" : "text-fg/90"}`}>
            {displayTitle(t)}
            {foreign && (
              <span
                className="petite-caps ml-1.5 inline-block rounded border border-border/60 px-1 align-[2px] text-[9.5px] leading-[14px] text-muted/55"
                title="Read-only — running in an external terminal"
              >
                terminal
              </span>
            )}
            {/* Backend badge (Codex-support epic, Phase 3): only a codex-backed thread is marked;
                Claude is the unmarked default. Subtle — same petite-caps pill idiom as `terminal`. */}
            {!legacy && t.backend === "codex" && (
              <span
                className="petite-caps ml-1.5 inline-block rounded border border-emerald-500/30 px-1 align-[2px] text-[9.5px] leading-[14px] text-emerald-400/70"
                title="Runs on the Codex (OpenAI) backend"
              >
                codex
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
      {/* The Mark-as verb survives ONLY on legacy rows (a .fray verb). Session rows resolve via the
          thread header's Archive/Kill. */}
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
// markdown + a "New thread from plan" affordance). Threads dispatched from the plan are its history —
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
  return (
    <span className={`petite-caps ml-1.5 inline-block rounded border px-1 align-[2px] leading-[14px] text-[9.5px] ${STATUS_CHIP[status] ?? "text-muted border-border"}`}>
      {status}
    </span>
  )
}

// Format a machine-wait hint as a compact row subtitle: "PR owner/repo#12", "CI build #4821",
// "timer 5m". A `session` hint is NOT glossed — its value is an internal session id that reads as
// leaked internals in the row subtitle (maintainer 2026-07-10: "what the fuck is that?! looks bad");
// the CircleDashed indicator + its "Waiting on another session" tooltip already carry that state.
// Null when there's no glossable (pr/ci/timer) hint.
function hintGloss(hints: readonly AwaitingHint[]): string | null {
  const h = hints.find((x) => x.kind === "pr" || x.kind === "ci" || x.kind === "timer")
  if (!h) return null
  const label = h.kind === "pr" ? "PR" : h.kind === "ci" ? "CI" : h.kind
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

// The SESSION-first row indicator (kind === "session"). ATTENTION HIERARCHY, brightest → faintest:
// a pending question (the worker asked you something) → the accent "?" mark; a plain needs-you
// (queued follow-up / bare rest) → the filled accent dot; both wear the signature yellow so the
// "what needs you" states are the most salient pixels on the rail. Everything the human is NOT
// on the hook for is demoted below them: a spinner (in motion), MUTED clock/dashed-circle
// (machine-waiting via an awaiting fence — you're not blocking it), a quiet check (done-fenced at
// rest — the fence mutates nothing, so the thread still lists), else the faint at-rest dot.
// STATUS = a markdown-task CHECKBOX family (maintainer 2026-07-10, Obsidian-flavored): every state is
// the SAME rounded-rect outer box with a glyph inside, so the rail reads like a to-do list.
//   [ ] idle        — at rest, nothing pending (empty box)
//   [/] in progress — the rounded-RECT spinner (a segment travels the box perimeter)
//   [?] needs input — a question / native ask / permission prompt (accent box + "?")
//   [!] stalled     — the agent EXITED while it still needed you (a crash; accent box + "!")
//   clock waiting   — machine-waiting behind an ```awaiting fence
//   [✓] done        — a ```done fence at rest, OR an archived thread (muted check — NOTHING else)
//   clock waiting   — an ```awaiting fence (declared machine-wait; +dims/sinks) OR a bare rest with no
//                     signal (a rested-not-done thread reads as WAITING, never a check or empty box)
// Attention (needs-input / stalled) wears the accent; everything else is muted.
function sessionIndicatorFor(t: ThreadView): { node: ReactElement; tip: string | null } {
  if (t.needsYou || t.pendingAsk || t.runtime === "perm-prompt") {
    // A crash (needsYou on an EXITED pane) reads as "!" — the agent died, not a live question.
    if (t.runtime === "exited") return { node: <StatusBox accent><Glyph ch="!" /></StatusBox>, tip: "Stalled — the agent exited" }
    // Muted "?", same gray as every other glyph — a needs-you thread already carries maximum emphasis
    // by sitting in the ⚖ queue, so the rail indicator adds NO extra color (maintainer 2026-07-10).
    return { node: <StatusBox><Glyph ch="?" muted /></StatusBox>, tip: "Needs your input" }
  }
  if (t.runtime === "running" || t.runtime === "spawning") return { node: <BoxSpinner />, tip: "Working" }
  const liveSub = (t.subAgents ?? []).some((s) => s.state === "running")
  if (t.runtime === "turn-idle" && liveSub) return { node: <BoxSpinner />, tip: "Working" }
  const atRest = t.runtime === "turn-idle" || t.runtime === "exited"
  if (t.lastFence?.kind === "awaiting" && atRest) {
    // Icon by the PRIMARY machine-wait hint (maintainer 2026-07-10): a PR block wears the GitHub mark,
    // CI an hourglass, a timer the stopwatch, another-session a dashed circle, everything else the
    // clock. The pr/ci/timer ones split into the dimmed Awaiting-external band (isAwaitingExternal); a
    // `session`/hintless await keeps its glyph here but stays in Active, undimmed.
    const hk = t.lastFence.hints[0]?.kind
    if (hk === "pr") return { node: <StatusBox><Github size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting on a PR" }
    if (hk === "ci") return { node: <StatusBox><Hourglass size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting on CI" }
    if (hk === "timer") return { node: <StatusBox><Timer size={10} className="text-muted/70" /></StatusBox>, tip: "Waiting on a timer" }
    if (hk === "session") return { node: <StatusBox><CircleDashed size={10} className="text-muted/70" /></StatusBox>, tip: "Waiting on another session" }
    return { node: <StatusBox><Clock size={9} className="text-muted/70" /></StatusBox>, tip: "Waiting on a machine" }
  }
  // A CHECK MARK means DONE — and ONLY that (maintainer 2026-07-10: a check on a still-active,
  // fenceless thread "doesn't make sense"). The two things that earn it: the thread is ARCHIVED
  // (terminal), or the worker declared ` ```done ` and is at rest (that card carries the Archive button).
  if (t.state === "archived") return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Archived" }
  if (t.lastFence?.kind === "done" && atRest) return { node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted/75" /></StatusBox>, tip: "Done" }
  // Bare at rest (no fence, no live sub, nothing pending) — a worker that came to rest WITHOUT
  // declaring done or a machine-wait. Read it as WAITING (maintainer 2026-07-10: a rested-not-done
  // thread "should be blocked or waiting", never a stark empty box and never a false check). We don't
  // know the reason — the worker didn't fence — so: the clock, with NO hint gloss (vs an ```awaiting
  // fence, which carries pr/ci hints AND dims + sinks the row). The honest fix is the worker emitting
  // ` ```awaiting ` when it's blocked on a machine; until then this is our best-guess "paused/waiting".
  return { node: <StatusBox><Ellipsis size={11} className="text-muted/70" /></StatusBox>, tip: "At rest — awaiting you" }
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

// The workspace identity mark, pinned by App to the page's TOP-LEFT corner: the project label in
// owner/repo styling — a muted owner, a muted slash, the repo name bright — plus the live SSE dot
// AND its state word.
export function IdentityMark({ label, state }: { label: string; state: ConnectionState }) {
  const cut = label.lastIndexOf("/")
  const owner = cut === -1 ? null : label.slice(0, cut)
  const repo = cut === -1 ? label : label.slice(cut + 1)
  const map = {
    open: { cls: "bg-live", word: "connected" },
    connecting: { cls: "bg-accent", word: "connecting…" },
    closed: { cls: "bg-red-500", word: "disconnected" },
  } as const
  const m = map[state]
  return (
    <div className="flex items-center gap-2 min-w-0 text-[12px]">
      <span className="truncate" title={label}>
        {owner && (
          <>
            <span className="text-muted">{owner}</span>
            <span className="text-muted/60 mx-0.5">/</span>
          </>
        )}
        <span className="font-semibold text-fg/90">{repo}</span>
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${m.cls}`} />
        <span className="text-[10.5px] text-muted/70">{m.word}</span>
      </span>
    </div>
  )
}
