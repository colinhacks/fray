import { useState, type ComponentType } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Github, Inbox, Loader2, MessageSquare } from "lucide-react"
import { PermissionMode, type GithubItem } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Overlay } from "./NewThreadModal.tsx"
import { Select } from "./ui/Select.tsx"
import { PERMISSION_OPTIONS, MODEL_OPTIONS, EFFORT_OPTIONS, EFFORTS, PERMISSION_COLOR } from "../lib/options.ts"

type Kind = "issues" | "prs"
type Sort = "recent" | "reactions"

// Readout option lists carry no empty "default" row — the footer readouts always show a concrete value
// (the modal defaults model→opus, effort→high, mode→auto unless settings/user override), matching the
// new-thread composer's footer.
const MODEL_OPTIONS_CONCRETE = MODEL_OPTIONS.filter((o) => o.value !== "")
const EFFORT_OPTIONS_CONCRETE = EFFORT_OPTIONS.filter((o) => o.value !== "")

// Mirrors GithubBatchInput.items `.max(20)` in shared/src/index.ts — the picker never lets the
// selection exceed the server's per-batch cap, so a dispatch can't fail the schema with a cryptic
// (client-sliced) Zod error and drop the whole batch.
const MAX_BATCH = 20

// THE GitHub picker: a wider anywhere-modal (reusing NewThreadModal's Overlay) that lists the repo's
// Issues or PRs (tabs), sortable by recency or reactions, with multi-select checkboxes and a
// model/effort/permission footer. "Dispatch N thread(s)" spins up one fray thread per checked item
// (each ISSUE an investigate/reproduce/recommend thread, each PR a review thread) via
// rpc.githubDispatchBatch — the server hydrates + templates each fresh, reusing the normal dispatch
// flow; the new sidebar rows paint via the board SSE. The trigger that opens this is auth-gated, so
// the RPCs are guaranteed serviceable when it's mounted.
export function GithubPickerModal({ onClose }: { onClose: () => void }) {
  const status = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })

  const [kind, setKind] = useState<Kind>("issues")
  const [sort, setSort] = useState<Sort>("recent")
  // Selection is a Set<number> scoped to the CURRENT tab — switching tabs CLEARS it (simplest, and it
  // dodges the issue#N-vs-pr#N number collision a shared set would hit). Documented choice per plan §6.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())

  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState<(typeof EFFORTS)[number] | "">("")
  const effectiveMode = permissionMode || (settings.data?.permissionMode ?? "auto")
  const effectiveModel = model || settings.data?.model || "opus"
  const effectiveEffort = effort || settings.data?.effort || "high"

  // Server order is AUTHORITATIVE (the gh --search sort) — render items exactly as returned, never
  // re-sort client-side. The query re-keys on {kind, sort}, so a tab/sort flip refetches.
  const list = useQuery({ queryKey: ["githubList", kind, sort], queryFn: () => rpc.githubList({ kind, sort }) })
  const items = list.data?.items ?? []

  const dispatch = useMutation({
    mutationFn: () =>
      rpc.githubDispatchBatch({
        items: [...selected].map((number) => ({ kind: kind === "issues" ? "issue" : "pr", number })),
        model: effectiveModel,
        effort: effectiveEffort,
        permissionMode: effectiveMode,
      }),
    onMutate: () => showToast(`Starting ${selected.size} thread${selected.size === 1 ? "" : "s"}…`, { spinner: true, sticky: true }),
    onSuccess: (res) => {
      const ok = res.dispatched.length
      const failed = res.failed.length
      showToast(`Started ${ok} thread${ok === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`)
      onClose()
    },
    onError: (e) => showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`),
  })

  function switchKind(k: Kind) {
    if (k === kind) return
    setKind(k)
    setSelected(new Set())
  }
  function switchSort(s: Sort) {
    if (s === sort) return
    setSort(s)
    // Clear on sort-switch, same as tab-switch: a selection made under one order can scroll out of the
    // other's (limit-truncated) window and then dispatch INVISIBLY, with the count exceeding the
    // visible checks. Clearing keeps "what's checked is what dispatches" honest.
    setSelected(new Set())
  }
  function toggle(n: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else if (next.size < MAX_BATCH) next.add(n) // cap adds at the server's per-batch max (MAX_BATCH)
      return next
    })
  }

  const nameWithOwner = status.data?.nameWithOwner ?? "this repo"
  const n = selected.size

  return (
    <Overlay onClose={onClose}>
      <div
        className="flex max-h-[85vh] w-[720px] max-w-[90vw] flex-col rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50"
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {/* Header */}
        <h2 className="mb-4 flex items-center gap-2 text-[14px] font-medium">
          <Github size={15} className="text-muted" />
          <span>Dispatch from GitHub</span>
          <span className="text-muted/40">—</span>
          <span className="font-mono-keep text-[12.5px] text-muted">{nameWithOwner}</span>
        </h2>

        {/* Controls: tabs (Issues | PRs) left, sort (Recent | Reactions) right */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <Segmented
            value={kind}
            onChange={(v) => switchKind(v)}
            options={[
              { value: "issues", label: "Issues" },
              { value: "prs", label: "PRs" },
            ]}
          />
          <div className="flex items-center gap-2">
            <span className="petite-caps text-[11px] text-muted/70">Sort</span>
            <Segmented
              value={sort}
              onChange={switchSort}
              options={[
                { value: "recent", label: "Recent" },
                { value: "reactions", label: "Reactions" },
              ]}
            />
          </div>
        </div>

        {/* List */}
        <div className="min-h-[240px] flex-1 overflow-y-auto rounded-lg border border-border/70 bg-bg/40">
          {list.isLoading ? (
            <ListSkeleton />
          ) : list.isError ? (
            <Centered>
              <span className="text-[12.5px] text-muted/80">Couldn't load {kind === "issues" ? "issues" : "pull requests"}.</span>
              <span className="max-w-[80%] text-center text-[11px] text-muted/45">{(list.error as Error).message.slice(0, 140)}</span>
            </Centered>
          ) : items.length === 0 ? (
            <Centered>
              <Inbox size={28} strokeWidth={1.25} className="text-muted/30" />
              <span className="text-[12.5px] text-muted/60">No open {kind === "issues" ? "issues" : "pull requests"}</span>
            </Centered>
          ) : (
            items.map((it) => <Row key={it.number} item={it} checked={selected.has(it.number)} onToggle={() => toggle(it.number)} />)
          )}
        </div>

        {/* Footer: model/effort/permission readouts + the batch-dispatch button */}
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-0.5">
            <Select
              variant="readout"
              className={`petite-caps ${PERMISSION_COLOR[effectiveMode]}`}
              value={effectiveMode}
              onValueChange={(v) => setPermissionMode(v as PermissionMode)}
              options={PERMISSION_OPTIONS}
              ariaLabel="Permission mode"
            />
            <Select
              variant="readout"
              className="petite-caps"
              value={effectiveModel}
              onValueChange={setModel}
              options={MODEL_OPTIONS_CONCRETE}
              ariaLabel="Model"
            />
            <Select
              variant="readout"
              className="petite-caps"
              value={effectiveEffort}
              onValueChange={(v) => setEffort(v as (typeof EFFORTS)[number])}
              options={EFFORT_OPTIONS_CONCRETE}
              ariaLabel="Effort"
            />
          </div>
          <div className="flex items-center gap-3">
            {n >= MAX_BATCH && <span className="petite-caps text-[11px] text-muted/60">{MAX_BATCH} max per batch</span>}
            <button
              disabled={n === 0 || dispatch.isPending}
              onClick={() => dispatch.mutate()}
              onMouseDown={(e) => e.preventDefault()}
              className="flex items-center gap-2 rounded-md bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
            >
              {dispatch.isPending && <Loader2 size={13} className="animate-spin" />}
              {n === 1 ? "Start investigation" : "Start investigations"}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// A binary/ternary segmented control in the app's rounded-rect / panel-2 idiom — the selected pill
// lifts to `elevated` with the fg text; the rest read muted until hover. Used for the tabs and sort.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          onMouseDown={(e) => e.preventDefault()}
          className={`rounded-md px-3 py-1 text-[12px] font-medium outline-none transition-colors ${
            value === o.value ? "bg-elevated text-fg shadow-sm shadow-black/20" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// GitHub's own issue/PR state glyph — green open-dot for an open issue, purple merge for a merged PR,
// etc. Mirrors github.com so the row reads the same at a glance. Defaults to the open glyph if state
// is absent (the picker lists OPEN items, so that's the common case).
function StateIcon({ item }: { item: GithubItem }) {
  const st = (item.state ?? "OPEN").toUpperCase()
  if (item.kind === "pr") {
    if (st === "MERGED") return <GitMerge size={15} className="shrink-0 text-purple-400" />
    if (st === "CLOSED") return <GitPullRequestClosed size={15} className="shrink-0 text-red-400" />
    if (item.isDraft) return <GitPullRequestDraft size={15} className="shrink-0 text-muted/70" />
    return <GitPullRequest size={15} className="shrink-0 text-emerald-500" />
  }
  if (st === "CLOSED") return <CircleCheck size={15} className="shrink-0 text-purple-400" />
  return <CircleDot size={15} className="shrink-0 text-emerald-500" />
}

// Compact "opened <ago>" relative time (github-ish: 8h ago, 3d ago). Empty when the timestamp is absent.
function relTime(iso?: string): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, (Date.now() - t) / 1000)
  const mn = s / 60
  const h = mn / 60
  const d = h / 24
  if (s < 45) return "just now"
  if (mn < 60) return `${Math.round(mn)}m ago`
  if (h < 24) return `${Math.round(h)}h ago`
  if (d < 30) return `${Math.round(d)}d ago`
  if (d < 365) return `${Math.round(d / 30)}mo ago`
  return `${Math.round(d / 365)}y ago`
}

// A github-style label chip: the label's own color as outline + text on a faint tint. Truncates long names.
function LabelChip({ name, color }: { name: string; color: string }) {
  const hex = /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : undefined
  return (
    <span
      className="max-w-[130px] shrink-0 truncate rounded-full border px-1.5 py-px text-[9.5px] leading-[13px]"
      style={hex ? { borderColor: `${hex}59`, color: hex, backgroundColor: `${hex}14` } : undefined}
      title={name}
    >
      {name}
    </span>
  )
}

// One issue/PR row, mirroring github.com: the select checkbox, the state glyph, the title (a LINK OUT)
// with its label chips, a metadata line "#N · author opened <ago>", and the comment/reaction badges on
// the right. Clicking the row toggles selection; clicking the title or the #number opens GitHub.
function Row({ item, checked, onToggle }: { item: GithubItem; checked: boolean; onToggle: () => void }) {
  const opened = relTime(item.createdAt)
  const meta = [item.author, opened ? `opened ${opened}` : ""].filter(Boolean).join(" ")
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onToggle()
        }
      }}
      className="group flex w-full cursor-pointer items-start gap-2.5 border-b border-border/40 px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-white/[0.03]"
    >
      <span className="mt-px shrink-0">
        <Checkbox checked={checked} />
      </span>
      <span className="mt-px">
        <StateIcon item={item} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            title={item.title}
            className="min-w-0 truncate text-[13px] font-medium text-fg/90 hover:underline"
          >
            {item.title}
          </a>
          {item.labels.slice(0, 4).map((l) => (
            <LabelChip key={l.name} name={l.name} color={l.color} />
          ))}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted/55">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 tabular-nums hover:text-muted hover:underline"
          >
            #{item.number}
          </a>
          {meta ? <span className="truncate">· {meta}</span> : null}
        </span>
      </span>
      <span className="mt-px flex shrink-0 items-center gap-2.5 text-[11.5px] text-muted/70">
        {item.comments ? <Badge icon={MessageSquare} n={item.comments} label="comments" /> : null}
        {item.reactions ? <Badge emoji="👍" n={item.reactions} label="reactions" /> : null}
      </span>
    </div>
  )
}

// The shared rounded-rect checkbox — same 15px rounded-[4px] box family as Sidebar's StatusBox. Checked
// fills with `fg` (the app's primary-action color, e.g. "Send answers") + a dark check; unchecked is a
// quiet muted outline that brightens on row hover. Deliberately NOT the accent — yellow is reserved for
// the "needs you" rail signal, not selection.
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`inline-flex h-[15px] w-[15px] items-center justify-center rounded-[4px] border transition-colors ${
        checked ? "border-fg bg-fg" : "border-muted/45 group-hover:border-muted/80"
      }`}
    >
      {checked && <Check size={11} strokeWidth={3} className="text-bg" />}
    </span>
  )
}

// A count badge (comments / reactions). Comments use a monochrome message glyph (mirrors github.com);
// reactions use the literal 👍 emoji (maintainer 2026-07-10 — not the old triangle). `title` names it.
function Badge({
  icon: Icon,
  emoji,
  n,
  label,
}: {
  icon?: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>
  emoji?: string
  n: number
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${n} ${label}`}>
      {emoji ? <span aria-hidden className="text-[11px] leading-none">{emoji}</span> : Icon ? <Icon size={12} strokeWidth={2} /> : null}
      {n}
    </span>
  )
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0">
          <span className="h-[15px] w-[15px] shrink-0 rounded-[4px] bg-muted/20" />
          <span className="h-3 w-8 shrink-0 rounded bg-muted/20" />
          <span className="h-3 flex-1 rounded bg-muted/15" style={{ maxWidth: `${55 + ((i * 7) % 35)}%` }} />
        </div>
      ))}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1.5">{children}</div>
}
