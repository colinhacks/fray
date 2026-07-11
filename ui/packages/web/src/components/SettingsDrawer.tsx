import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import { Check, Copy, HelpCircle, X } from "lucide-react"
import { type Settings } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { store } from "../store.ts"
import { prefs } from "../lib/prefs.ts"
import { registerSettingsClose } from "../lib/overlays.ts"
import { queryClient } from "../main.tsx"
import { Field } from "./NewThreadModal.tsx"
import { Select } from "./ui/Select.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { PERMISSION_OPTIONS, MODEL_OPTIONS, EFFORT_OPTIONS_SETTINGS } from "../lib/options.ts"

type NotifPerm = "default" | "granted" | "denied" | "unsupported"
function currentPerm(): NotifPerm {
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission as NotifPerm
}

// Slide-out duration; the panel unmounts (store.showSettings=false) after it elapses. Kept in sync
// with the transition-duration below.
const CLOSE_MS = 210
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export function SettingsDrawer() {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  const [draft, setDraft] = useState<Settings | null>(null)
  const [perm, setPerm] = useState<NotifPerm>(currentPerm())

  // Enter/exit animation. `shown` drives the slide (mount → next frame flips it true → slides in;
  // close flips it false → slides out). App renders <SettingsDrawer> only while showSettings is true,
  // so we keep ourselves mounted through the exit by delaying the store write until the slide ends.
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Let App's window-level Esc handler trigger THIS animated close (slide-out) rather than flipping the
  // store flag and unmounting instantly. `close` is a hoisted declaration, so referencing it here is safe.
  useEffect(() => {
    registerSettingsClose(close)
    return () => registerSettingsClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])

  function close() {
    if (closing) return
    setClosing(true)
    setShown(false)
    window.setTimeout(() => (store.showSettings = false), prefersReducedMotion() ? 0 : CLOSE_MS)
  }

  const save = useMutation({
    mutationFn: (s: Settings) => rpc.settingsSet(s),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settingsGet"] })
      close()
    },
  })

  // Turning notifications on requests browser permission if not yet decided; we keep the toggle
  // truthful about the OS-level grant so a green checkbox can't imply notifications that won't fire.
  async function toggleNotifications(on: boolean) {
    if (!draft) return
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      const result = (await Notification.requestPermission()) as NotifPerm
      setPerm(result)
    }
    setDraft({ ...draft, notifications: on })
  }

  const dirty = !!(draft && settings.data && JSON.stringify(draft) !== JSON.stringify(settings.data))

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`w-[560px] max-w-[94vw] h-full flex flex-col border-l border-border bg-panel shadow-2xl shadow-black/50 transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <header className="px-4 h-11 flex items-center justify-between border-b border-border shrink-0">
          <span className="flex items-center gap-2 text-[13px] font-medium">
            Settings
            {dirty && <span className="text-[11px] font-normal text-accent">● unsaved</span>}
          </span>
          <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg transition-colors" onClick={close}>
            <X size={15} />
          </button>
        </header>

        {!draft ? (
          <div className="p-4 text-[13px] text-muted">Loading…</div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
            <Field label="Permission mode">
              <Select
                variant="bordered"
                value={draft.permissionMode}
                onValueChange={(v) => setDraft({ ...draft, permissionMode: v as Settings["permissionMode"] })}
                options={PERMISSION_OPTIONS}
                ariaLabel="Permission mode"
              />
            </Field>

            <Field label="Model">
              <Select
                variant="bordered"
                value={draft.model ?? ""}
                onValueChange={(v) => setDraft({ ...draft, model: v || undefined })}
                options={MODEL_OPTIONS}
                ariaLabel="Model"
              />
            </Field>

            <Field label="Effort">
              <Select
                variant="bordered"
                value={draft.effort ?? ""}
                onValueChange={(v) => setDraft({ ...draft, effort: (v || undefined) as Settings["effort"] })}
                options={EFFORT_OPTIONS_SETTINGS}
                ariaLabel="Effort"
              />
            </Field>

            <Field label="Font">
              <FontToggle value={draft.font ?? "mono"} onChange={(font) => setDraft({ ...draft, font })} />
            </Field>

            {/* A client-only VIEW preference (localStorage, not server Settings): applies IMMEDIATELY,
                not on Save, so it's wired straight to the prefs proxy rather than the draft. */}
            <Field label="Compact mode">
              <CompactToggle />
            </Field>

            {/* Same segmented Off/On control as every other row (the old bare checkbox matched
                nothing else in the form). Off left, On right — switch convention. */}
            <Field label="Desktop notifications">
              <OnOffToggle value={draft.notifications} onChange={toggleNotifications} />
              {draft.notifications && <PermHint perm={perm} />}
            </Field>

            <PromptsSection draft={draft} setDraft={setDraft} />
          </div>
        )}

        <footer className="px-4 py-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button className="btn-ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn-accent"
            onClick={() => draft && save.mutate(draft)}
            disabled={!draft || save.isPending || !dirty}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  )
}

// A settings label with an instant tooltip on a small HelpCircle — keeps explanatory prose OUT of the
// form body (one control per line reads clean when the "why" lives in the tooltip).
function LabelWithHelp({ label, help }: { label: string; help: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
      {label}
      <Tooltip label={help} side="right">
        <button type="button" aria-label={`About ${label}`} className="text-muted/60 hover:text-fg transition-colors">
          <HelpCircle size={12} />
        </button>
      </Tooltip>
    </span>
  )
}

// The 6 substitution tokens the server fills in a GitHub batch-dispatch template, each with a one-word
// gloss of what it expands to. Kept in lockstep with PROMPT_TOKENS in server/github.ts (there is no
// shared const; this is a display hint only). Surfaced once, via the "?" popover on the token fields.
const GH_PROMPT_TOKENS: { token: string; gloss: string }[] = [
  { token: "repo", gloss: "repository" },
  { token: "n", gloss: "number" },
  { token: "title", gloss: "title" },
  { token: "url", gloss: "link" },
  { token: "labels", gloss: "labels" },
  { token: "body", gloss: "description" },
]

// "Prompts" — every user-editable prompt in one place: the Subagent instructions preamble (appended to
// EVERY dispatched agent) plus the two GitHub-picker investigation templates (Issue, PR). The two
// picker editors PREFILL with the shipped default (fetched from the server, the single source of truth)
// so the user edits from the real prompt; a stored override supersedes it. Empty override = default.
function PromptsSection({ draft, setDraft }: { draft: Settings; setDraft: (s: Settings) => void }) {
  const defaults = useQuery({ queryKey: ["githubPromptDefaults"], queryFn: () => rpc.githubPromptDefaults() })
  return (
    <div className="flex flex-col gap-6 border-t border-border pt-6">
      <DividerLabel label="Prompts" />

      {/* Subagent instructions — the old "Dispatch preamble", now grouped with the picker prompts since
          it is a prompt too. Does NOT use tokens, so no "?" affordance here. */}
      <div className="flex flex-col gap-2">
        <LabelWithHelp
          label="Subagent instructions"
          help="Your custom per-project instructions, appended to every dispatched agent's prompt after the built-in worker contract."
        />
        <textarea
          value={draft.dispatchPreamble}
          onChange={(e) => setDraft({ ...draft, dispatchPreamble: e.target.value })}
          rows={10}
          className="input resize-none text-[12px] leading-relaxed"
          placeholder="e.g. Prefer pnpm. Never touch the generated/ dir. Ask before adding dependencies."
          spellCheck={false}
        />
      </div>

      {/* The two GitHub-picker investigation templates. Tokens apply to BOTH, so the "?" popover lives
          once in this group's intro row rather than being repeated per field. */}
      {!defaults.data ? (
        <div className="text-[12px] text-muted">Loading defaults…</div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-3">
            <span className="text-[11px] leading-relaxed text-muted/70">
              The worker prompt used for each item you dispatch from the GitHub picker. Leave an editor empty to use the
              built-in default.
            </span>
            <TokenHelpPopover />
          </div>
          <GithubPromptField
            label="Issue investigation prompt"
            help="The prompt for each ISSUE dispatched from the picker. The default has the worker classify the issue as a bug or feature and branch: reproduce + fix-plan for a bug, or a plan + impact analysis for a feature."
            value={draft.githubIssuePrompt}
            fallback={defaults.data.issue}
            onChange={(v) => setDraft({ ...draft, githubIssuePrompt: v })}
          />
          <GithubPromptField
            label="PR investigation prompt"
            help="The prompt for each PR dispatched from the picker. The default runs an adversarial review/audit — read the diff, verify correctness/edges/tests/CI, then recommend approve / request-changes."
            value={draft.githubPrPrompt}
            fallback={defaults.data.pr}
            onChange={(v) => setDraft({ ...draft, githubPrPrompt: v })}
          />
        </div>
      )}
    </div>
  )
}

// A section header in the transcript's centered-divider idiom (see ChatView's EventLine): a small
// muted label flanked by faint hairlines, so a settings group reads as a titled band rather than a
// left-aligned caption.
function DividerLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-wide text-muted/70">
      <span aria-hidden className="h-px flex-1 bg-border/60" />
      <span className="shrink-0">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  )
}

// A real click-popover (NOT a hover tooltip) listing the substitution tokens. Opens on click, stays
// open, and dismisses on outside-click or Esc. There is no @radix-ui/react-popover dep, so this is a
// hand-rolled panel: an open flag + an absolutely-positioned panel + document listeners. The Esc
// handler stopPropagation()s so it closes the popover WITHOUT bubbling up to App's window-level Esc
// (which would otherwise close the whole Settings drawer).
function TokenHelpPopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label="Available tokens"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`transition-colors ${open ? "text-accent" : "text-muted/60 hover:text-fg"}`}
      >
        <HelpCircle size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          // Opens UPWARD (bottom-full): the "?" lives low in the scroll body, so a downward panel would
          // clip against the drawer footer / viewport edge. Upward has the roomy Subagent editor above it.
          className="absolute right-0 bottom-full mb-2 z-10 w-56 rounded-md border border-border bg-elevated p-3 shadow-lg shadow-black/40"
        >
          <div className="mb-2 text-[11px] font-medium text-fg">Substitution tokens</div>
          <ul className="flex flex-col gap-1.5">
            {GH_PROMPT_TOKENS.map(({ token, gloss }) => (
              <li key={token} className="flex items-center justify-between gap-3 text-[11px]">
                <code className="font-mono-keep rounded border border-border bg-bg px-1 py-0.5 text-[10px] text-fg/80">
                  {`{${token}}`}
                </code>
                <span className="text-muted/80">{gloss}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// One prompt editor. `value` is the stored override (undefined = "use default"); `fallback` is the
// shipped default shown when there is no override, so the box always renders the effective prompt.
// Typing sets a concrete override; "Reset to default" clears it back to undefined (server default).
function GithubPromptField({
  label,
  help,
  value,
  fallback,
  onChange,
}: {
  label: string
  help: string
  value: string | undefined
  fallback: string
  onChange: (v: string | undefined) => void
}) {
  const customized = value != null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <LabelWithHelp label={label} help={help} />
        {customized && (
          <button
            type="button"
            className="text-[11px] text-muted hover:text-accent transition-colors"
            onClick={() => onChange(undefined)}
          >
            Reset to default
          </button>
        )}
      </div>
      <textarea
        value={value ?? fallback}
        // Emptying the box clears the override (→ undefined), so it snaps back to showing the default
        // and drops the "Reset" affordance — matching the server's blank-means-default semantics
        // instead of leaving a confusing empty box that still reads as "customized".
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        rows={10}
        className="input resize-none text-[12px] leading-relaxed font-mono-keep"
        spellCheck={false}
      />
    </div>
  )
}

// Small segmented control for the mono/sans experiment. Two options, the active one inverted
// (bright-on-panel) like the primary button — quiet, no accent (yellow stays the focus motif). Each
// label previews its own family so the choice reads at a glance.
function FontToggle({ value, onChange }: { value: "mono" | "sans"; onChange: (v: "mono" | "sans") => void }) {
  const opts: { v: "mono" | "sans"; label: string; cls: string }[] = [
    { v: "mono", label: "Mono", cls: "" },
    { v: "sans", label: "Sans", cls: "" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${o.cls} ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// The ONE boolean control shape for the whole form: a segmented Off|On pair, Off always on the LEFT
// (switch convention — right = on). Active segment inverted like the font toggle.
function OnOffToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Off" },
    { v: true, label: "On" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => onChange(o.v)}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Compact-diff preference: client-only (localStorage prefs proxy), applies live — diff blocks across
// the app collapse/expand the instant it flips, no Save round-trip.
function CompactToggle() {
  const { compactDiffs } = useSnapshot(prefs)
  return <OnOffToggle value={compactDiffs} onChange={(v) => (prefs.compactDiffs = v)} />
}

// Quiet, small permission-state line under the notifications toggle. Everything is muted (the old
// loud-red denied line read as an error); the denied state additionally offers a recovery assist,
// since a page can't re-prompt once denied.
function PermHint({ perm }: { perm: NotifPerm }) {
  if (perm === "denied") return <NotifDeniedHelp />
  const text: Record<Exclude<NotifPerm, "denied">, string> = {
    granted: "Browser permission granted — notifications fire when the window is hidden.",
    default: "Browser permission not yet granted — notifications won't fire until you allow them.",
    unsupported: "This browser does not support desktop notifications.",
  }
  return <span className="pl-6 text-[11px] text-muted/70">{text[perm]}</span>
}

type Browser = "chrome" | "edge" | "safari" | "firefox" | "other"
function detectBrowser(): Browser {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Firefox\//.test(ua)) return "firefox"
  if (/Edg\//.test(ua)) return "edge"
  if (/OPR\/|Brave\//.test(ua)) return "other"
  if (/Chrome\//.test(ua)) return "chrome"
  if (/Safari\//.test(ua)) return "safari"
  return "other"
}

// Once a site's notification permission is DENIED, the page can no longer meaningfully re-invoke
// requestPermission, and chrome://about: URLs can't be opened from a web page — so no real deep link
// exists. Best UX: browser-specific one-line instructions, plus (Chromium) the exact site-settings
// address as selectable + copyable mono text. Muted + small; only shown in the denied state.
function NotifDeniedHelp() {
  const browser = useMemo(detectBrowser, [])
  const origin = typeof location !== "undefined" ? location.origin : ""
  const chromiumUrl = `${browser === "edge" ? "edge" : "chrome"}://settings/content/siteDetails?site=${encodeURIComponent(origin)}`

  return (
    <div className="pl-6 flex flex-col gap-1 text-[11px] text-muted/70">
      <span>Notifications are blocked for this site. Re-enable them in your browser, then reload.</span>
      {browser === "chrome" || browser === "edge" ? (
        <CopyableAddress url={chromiumUrl} hint="Paste this into a new tab, set Notifications → Allow:" />
      ) : browser === "safari" ? (
        <span>Safari → Settings → Websites → Notifications → allow {hostOf(origin)}, then reload.</span>
      ) : browser === "firefox" ? (
        <span>Firefox → Settings → Privacy &amp; Security → Permissions → Notifications → Settings → allow this site.</span>
      ) : (
        <span>Open this site's notification permission in your browser's settings and set it to Allow.</span>
      )}
    </div>
  )
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function CopyableAddress({ url, hint }: { url: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the address is still selectable inline */
    }
  }
  return (
    <span className="flex flex-col gap-1">
      <span>{hint}</span>
      <span className="flex items-center gap-1.5">
        <code className="font-mono-keep select-all rounded border border-border bg-bg px-1.5 py-0.5 text-[10.5px] text-fg/90 break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy address"
          title="Copy address"
          className="shrink-0 rounded border border-border p-1 text-muted hover:bg-panel-2 hover:text-fg transition-colors"
        >
          {copied ? <Check size={11} className="text-live" /> : <Copy size={11} />}
        </button>
      </span>
    </span>
  )
}
