import { PermissionMode } from "@fray-ui/shared"
import type { SelectOption } from "../components/ui/Select.tsx"

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

// Model is a select over the CLI aliases; "" = the CLI default.
export const MODEL_OPTIONS: SelectOption[] = [
  { value: "", label: "Default" },
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
]

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max" }

export const EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "Effort" },
  ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]

// Effort options for settings, where the empty value reads as "default" rather than a placeholder.
export const EFFORT_OPTIONS_SETTINGS: SelectOption[] = [
  { value: "", label: "Default" },
  ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]
