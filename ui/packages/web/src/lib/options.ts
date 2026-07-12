import { PermissionMode, type Backend } from "@fray-ui/shared"
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

// Claude Code's own permission color language: red = bypass, yellow = auto, purple = accept-edits,
// cyan = plan. Applied to the dispatch form's mode readout so the risk level reads at a glance.
export const PERMISSION_COLOR: Record<(typeof PERMISSION_MODES)[number], string> = {
  auto: "text-accent",
  default: "text-muted",
  acceptEdits: "text-purple-400",
  plan: "text-cyan-400",
  bypassPermissions: "text-red-400",
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

// Codex (OpenAI) models — the `codex -m <id>` values, from the authoritative local catalogue
// ~/.codex/models_cache.json (visibility="list" entries), ordered by its `priority`. 5.6 ships as
// THREE versioned variants (sol/terra/luna) — NOT a bare "gpt-5.6", which codex 400s ("model not
// supported when using Codex with a ChatGPT account"), silently killing the spawn. gpt-5.6-sol
// (priority 1) is the default; VERIFIED live (`codex exec -m gpt-5.6-sol` replied "OK"). NOTE: effort
// sets differ PER MODEL (5.6 goes to max/ultra; 5.5 stops at xhigh) — the single CODEX_EFFORTS below is
// the safe common subset; the durable fix reads per-model efforts from the cache (codex-model-cache
// thread). gpt-5.3-codex-spark is api=false but TUI-selectable (how fray spawns codex).
export const CODEX_MODELS: SelectOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", title: "GPT-5.6-Sol — newest frontier codex model (default)" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", title: "GPT-5.6-Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", title: "GPT-5.6-Luna" },
  { value: "gpt-5.5", label: "GPT-5.5", title: "GPT-5.5 — frontier coding/research model" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", title: "GPT-5.4 Mini — faster, lighter" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", title: "GPT-5.3-Codex-Spark — TUI only (not in the Responses API)" },
]

const CODEX_MODEL_SET = new Set(CODEX_MODELS.map((m) => m.value))

// The backend a model id runs on — the model→backend derivation the whole picker keys off. A known
// codex id ⇒ "codex"; anything else (a Claude alias, "", or an unknown) ⇒ "claude" (the default).
export function backendForModel(model: string | undefined): Backend {
  return model && CODEX_MODEL_SET.has(model) ? "codex" : "claude"
}

// Settings model dropdown: a leading ungrouped "Default" (claude CLI default), then the two sections.
export const MODEL_GROUPS_SETTINGS: SelectGroup[] = [
  { label: "", options: [{ value: "", label: "Default" }] },
  { label: "Claude Code", options: CLAUDE_MODELS },
  { label: "Codex", options: CODEX_MODELS },
]

// Composer model dropdown: the readout always shows a CONCRETE model, so no "Default" row.
export const MODEL_GROUPS_CONCRETE: SelectGroup[] = [
  { label: "Claude Code", options: CLAUDE_MODELS },
  { label: "Codex", options: CODEX_MODELS },
]

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

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
// Codex accepts low/medium/high/xhigh (per ~/.codex/models_cache.json — every listed model exposes
// these four; corrected 2026-07-12). fray's enum also has "max", which codex lacks → clamped to xhigh.
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const

export const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max" }

export const EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "Effort" },
  ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]

// Effort options for settings, where the empty value reads as "default" rather than a placeholder.
export const EFFORT_OPTIONS_SETTINGS: SelectOption[] = [
  { value: "", label: "Default" },
  ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]

// Codex effort option sets (low/medium/high/xhigh) — composer (concrete) and settings (leading Default).
export const CODEX_EFFORT_OPTIONS: SelectOption[] = CODEX_EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))
export const CODEX_EFFORT_OPTIONS_SETTINGS: SelectOption[] = [{ value: "", label: "Default" }, ...CODEX_EFFORT_OPTIONS]

// Clamp a stored effort into the codex-displayable set: only "max" (which codex lacks) → xhigh; xhigh is
// valid. Keeps the Codex effort dropdown showing what will actually be sent (the server clamps identically).
export function codexEffortValue(effort: string): string {
  return effort === "max" ? "xhigh" : effort
}

// The permission/effort option sets + display-mapper for a backend — one place the two surfaces share
// so Settings and the composer never drift on what each backend offers.
export function permOptionsFor(backend: Backend): SelectOption[] {
  return backend === "codex" ? CODEX_PERMISSION_OPTIONS : PERMISSION_OPTIONS
}
export function permValueFor(backend: Backend, mode: PermissionMode): PermissionMode {
  return backend === "codex" ? codexPermValue(mode) : claudePermValue(mode)
}
