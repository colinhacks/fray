import { PermissionMode, type Backend, type CodexModel } from "@fray-ui/shared"
import type { SelectOption, SelectGroup } from "../components/ui/Select.tsx"

// Shared option sets for the permission / model / effort selects, used by both the New-thread
// composer row and the settings dialog so the two never drift.

const PERMISSION_MODES = PermissionMode.options

// Short trigger labels; the full one-liner rides along as the option's hover title.
const PERMISSION_SHORT: Record<(typeof PERMISSION_MODES)[number], string> = {
  auto: "Auto",
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass",
}

export const PERMISSION_MODE_LABELS: Record<(typeof PERMISSION_MODES)[number], string> = {
  auto: "auto — safe actions auto-approved, risky ones prompt",
  default: "default — prompt for every permission",
  acceptEdits: "accept edits — file edits auto-approved",
  plan: "plan — read-only planning, approval before changes",
  bypassPermissions: "bypass — never prompt (dangerous)",
}

// "plan" is excluded: headless workers have no coherent plan-mode semantics (they plan by writing
// the plan into their thread + needs-human), and dispatch.ts coerces plan → auto at spawn anyway —
// offering a mode that gets silently rewritten would be dishonest UI. The label/color maps keep
// their plan entries (the type covers the full enum; an adopted foreign session could still read it).
export const PERMISSION_OPTIONS: SelectOption[] = PERMISSION_MODES.filter((m) => m !== "plan").map((m) => ({
  value: m,
  label: PERMISSION_SHORT[m],
  title: PERMISSION_MODE_LABELS[m],
}))

// Claude Code-inspired permission accents for the dispatch form's mode readout. Bypass/full access
// intentionally uses the ordinary readout color rather than danger-red: it is the default operating
// mode here, while actual errors and destructive actions retain their dedicated warning styling.
export const PERMISSION_COLOR: Record<(typeof PERMISSION_MODES)[number], string> = {
  auto: "text-accent",
  default: "text-muted",
  acceptEdits: "text-purple-400",
  plan: "text-cyan-400",
  bypassPermissions: "text-muted",
}

// ---- Model selector: two backend sections (Codex-support epic, Phase 3) ----
// Model is the FIRST control and DRIVES the backend: a Claude alias ⇒ backend "claude", a GPT/Codex
// id ⇒ backend "codex". "" = the CLI default (claude). The dependent permission/effort controls then
// present the chosen backend's axis (Claude permission-mode vs Codex sandbox; the codex effort set).

// Claude Code models — the `claude --model` aliases.
export const CLAUDE_MODELS: SelectOption[] = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
]

// Codex (OpenAI) models are NO LONGER hand-listed here — they + their PER-MODEL effort sets come from
// the server's codexModels() RPC, which reads the authoritative ~/.codex/models_cache.json (the fix for
// two live breakages: a bare `gpt-5.6` that codex 400s, and a single effort list that's wrong per-model
// — 5.6 goes to max/ultra, 5.5 stops at xhigh). This is only the DEGRADED fallback for the loading /
// no-cache state — a compact mirror, NOT a second catalogue to maintain. gpt-5.6-sol (codex priority 1)
// leads so it's the natural codex default; a codex spawn 400s on a bare `gpt-5.6`, hence the -sol id.
export const CODEX_MODELS_FALLBACK: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
]

// The set of codex slugs to treat as the "codex" backend when no live RPC list is on hand — the fallback
// models above. backendForModel unions this with whatever live list a caller passes.
const FALLBACK_CODEX_SLUGS = new Set(CODEX_MODELS_FALLBACK.map((m) => m.slug))

// The backend a model id runs on — the model→backend derivation the whole picker keys off. A slug in the
// codex catalogue ⇒ "codex"; anything else (a Claude alias, "", or an unknown) ⇒ "claude" (the default).
// `codexModels` is the live RPC list when available (so a brand-new codex slug resolves correctly the
// instant it appears in the cache); it falls back to the compiled-in slug set while the RPC is loading.
export function backendForModel(model: string | undefined, codexModels?: readonly CodexModel[]): Backend {
  if (!model) return "claude"
  if (FALLBACK_CODEX_SLUGS.has(model)) return "codex"
  return codexModels?.some((m) => m.slug === model) ? "codex" : "claude"
}

// Build the Codex model SelectOptions from a live RPC list (or the degraded fallback while loading).
function codexModelOptions(codexModels: readonly CodexModel[]): SelectOption[] {
  const src = codexModels.length ? codexModels : CODEX_MODELS_FALLBACK
  return src.map((m) => ({ value: m.slug, label: m.displayName, title: `${m.displayName} — codex` }))
}

// The model dropdown groups (Claude Code + Codex), with the Codex section driven by the RPC list.
// `withDefault` prepends the ungrouped "Default" (claude CLI default) row used by Settings; the composer
// readout always shows a concrete model, so it omits it.
export function modelGroups(codexModels: readonly CodexModel[], opts: { withDefault: boolean }): SelectGroup[] {
  const groups: SelectGroup[] = [
    { label: "Claude Code", options: CLAUDE_MODELS },
    { label: "Codex", options: codexModelOptions(codexModels) },
  ]
  return opts.withDefault ? [{ label: "", options: [{ value: "", label: "Default" }] }, ...groups] : groups
}

// The CodexModel a slug resolves to (from the live RPC list, falling back to the compiled-in mirror), or
// undefined for a non-codex / unknown model. Callers use it to gate the effort dropdown to that model's
// supported levels + default.
export function codexModelFor(model: string | undefined, codexModels: readonly CodexModel[]): CodexModel | undefined {
  if (!model) return undefined
  return codexModels.find((m) => m.slug === model) ?? CODEX_MODELS_FALLBACK.find((m) => m.slug === model)
}

// ---- Codex sandbox (the codex analog of Claude's permission mode) ----
// Codex has a `-s <sandbox>` axis, NOT Claude's permission modes. The server's codexSandbox() maps a
// PermissionMode → the -s value (plan→read-only, bypassPermissions→danger-full-access, else→
// workspace-write), so the Codex dropdown is a VIEW over the SAME stored permissionMode field: each
// option's value is the permissionMode that codexSandbox translates into that sandbox. This keeps one
// storage field across both backends and needs no server change.
export const CODEX_PERMISSION_OPTIONS: SelectOption[] = [
  { value: "plan", label: "Read-only", title: "read-only — codex cannot modify the workspace (-s read-only)" },
  { value: "default", label: "Workspace-write", title: "workspace-write — edit inside the repo, denied elsewhere (-s workspace-write)" },
  { value: "bypassPermissions", label: "Full access", title: "danger-full-access — unrestricted (-s danger-full-access)" },
]

// Map an arbitrary stored PermissionMode onto the codex-sandbox option value to DISPLAY (mirrors the
// server's codexSandbox switch), so switching a Claude thread's mode (auto/acceptEdits) to a Codex
// model still shows a coherent sandbox selection instead of an empty dropdown.
export function codexPermValue(mode: PermissionMode): PermissionMode {
  if (mode === "plan") return "plan"
  if (mode === "bypassPermissions") return "bypassPermissions"
  return "default"
}

// The inverse-facing helper for Claude: Claude's dropdown omits "plan" (dispatch coerces plan→auto),
// so a mode of "plan" (set while on a Codex model) DISPLAYS as "auto" when back on a Claude model.
export function claudePermValue(mode: PermissionMode): PermissionMode {
  return mode === "plan" ? "auto" : mode
}

// The CLAUDE effort ladder (the Claude-model effort dropdown). Codex efforts are NOT hardcoded — they
// come per-model from the cache (a codex model can go to max/ultra, another stops at xhigh).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

// Labels span BOTH ladders: Claude's low..max plus codex's "ultra". An unlabeled effort (a future codex
// level) falls back to a Title-cased slug in the option builders below.
export const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max", ultra: "Ultra" }

// The full effort ordering, low→high — used to clamp a stored effort into a codex model's supported set.
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"]

function effortLabel(e: string): string {
  return EFFORT_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1)
}

export const EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "Effort" },
  ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]

// Effort options for settings, where the empty value reads as "default" rather than a placeholder.
export const EFFORT_OPTIONS_SETTINGS: SelectOption[] = [
  { value: "", label: "Default" },
  ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]

// The effort SelectOptions for a specific codex model — exactly its cache `efforts` (so a 5.6 model shows
// max/ultra and a 5.5 model stops at xhigh). `withDefault` prepends the "Default" row (settings), which
// resolves to the model's default_reasoning_level server-side; the composer omits it (always concrete).
export function codexEffortOptions(model: CodexModel | undefined, opts: { withDefault: boolean }): SelectOption[] {
  const efforts = model?.efforts ?? []
  const optionList = efforts.map((e) => ({ value: e, label: effortLabel(e) }))
  return opts.withDefault ? [{ value: "", label: "Default" }, ...optionList] : optionList
}

// Coerce a stored effort into what the SELECTED codex model actually supports, so the dropdown always
// shows a valid option (Radix renders blank otherwise) and the dispatch carries a real value. Replaces
// the old blanket max→xhigh clamp, which WRONGLY downgraded a 5.6 model that supports max/ultra. "" is
// "use the model default" (kept as-is for the settings placeholder). A supported value passes through; an
// unsupported one clamps DOWN the ordered ladder to the highest supported level at or below it (so max →
// xhigh only for a model that stops at xhigh), else the model's default effort.
export function codexEffortForModel(model: CodexModel | undefined, effort: string): string {
  if (!model || !effort) return effort
  if (model.efforts.includes(effort)) return effort
  const idx = EFFORT_ORDER.indexOf(effort)
  const atOrBelow = model.efforts.filter((e) => {
    const i = EFFORT_ORDER.indexOf(e)
    return i !== -1 && idx !== -1 && i <= idx
  })
  if (atOrBelow.length) return atOrBelow.reduce((a, b) => (EFFORT_ORDER.indexOf(b) > EFFORT_ORDER.indexOf(a) ? b : a))
  return model.defaultEffort
}

// The permission/effort option sets + display-mapper for a backend — one place the two surfaces share
// so Settings and the composer never drift on what each backend offers.
export function permOptionsFor(backend: Backend): SelectOption[] {
  return backend === "codex" ? CODEX_PERMISSION_OPTIONS : PERMISSION_OPTIONS
}
export function permValueFor(backend: Backend, mode: PermissionMode): PermissionMode {
  return backend === "codex" ? codexPermValue(mode) : claudePermValue(mode)
}
