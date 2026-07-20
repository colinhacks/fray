import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "./promptControlTypography.ts"

export interface ProfileGridOption {
  model: string
  label: string
  efforts: readonly string[]
  defaultEffort?: string
}

export interface ProfileGridGroup {
  id: string
  label: string
  options: readonly ProfileGridOption[]
}

export interface ProfileGridSelection {
  provider: string
  model: string
  effort: string
}

// Kept in the pure profile module so the component and deterministic contract tests share the exact
// class tokens. Apply this directly to every piece of profile text (rather than relying on the
// trigger/menu inheritance): model labels, effort cells, and the selected combined value must remain
// the same readable 12px/16px petite-cap treatment in queue cards, drawers, and narrow layouts.
// Compact changes control density and icon size only; it must never make the text smaller.
export const PROFILE_GRID_TYPOGRAPHY_CLASS = PROMPT_CONTROL_TYPOGRAPHY_CLASS
export const PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS = PROMPT_CONTROL_TYPOGRAPHY_CLASS
export const PROFILE_GRID_CELL_CLASS = `profile-grid-cell relative flex h-6 min-w-[2.75rem] cursor-pointer select-none items-center justify-center rounded border border-transparent px-1 text-center text-muted outline-none transition-colors ${PROFILE_GRID_TYPOGRAPHY_CLASS} data-[highlighted]:border-border data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[highlighted]:outline data-[highlighted]:outline-1 data-[highlighted]:outline-offset-1 data-[highlighted]:outline-fg/55 data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/10 data-[state=checked]:font-medium data-[state=checked]:text-fg data-[state=checked]:ring-1 data-[state=checked]:ring-inset data-[state=checked]:ring-accent/90`

export function profileGridTemplateColumns(effortCount: number): string {
  return `minmax(6rem, 7rem) repeat(${Math.max(0, effortCount)}, minmax(2.75rem, auto))`
}

export type ProfileGridMoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"]

export function profileGridEfforts(groups: readonly ProfileGridGroup[]): string[] {
  const efforts = new Set(groups.flatMap((group) => group.options.flatMap((option) => option.efforts)))
  return [...efforts].sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a)
    const bi = EFFORT_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

export function profileGridSelections(groups: readonly ProfileGridGroup[]): ProfileGridSelection[] {
  return groups.flatMap((group) => group.options.flatMap((option) => option.efforts.map((effort) => ({
    provider: group.id,
    model: option.model,
    effort,
  }))))
}

export function profileGridSelectionKey(selection: ProfileGridSelection): string {
  return JSON.stringify([selection.provider, selection.model, selection.effort])
}

// DropdownMenu's RadioGroup reports only its string value. Resolve that value through the rendered
// catalogue rather than parsing it back into an untrusted selection, so a radio change can only
// commit one complete, supported provider/model/effort pair.
export function profileGridSelectionFromKey(
  groups: readonly ProfileGridGroup[],
  key: string,
): ProfileGridSelection | undefined {
  return profileGridSelections(groups).find((selection) => profileGridSelectionKey(selection) === key)
}

export function profileGridSelectionKnown(
  groups: readonly ProfileGridGroup[],
  selection: Partial<ProfileGridSelection> | undefined,
): boolean {
  if (!selection?.model || !selection.effort) return false
  return groups.some((group) =>
    (!selection.provider || group.id === selection.provider) &&
    group.options.some((option) => option.model === selection.model && option.efforts.includes(selection.effort!)),
  )
}

export function profileGridDisplayLabel(
  groups: readonly ProfileGridGroup[],
  selection: Partial<ProfileGridSelection> | undefined,
  placeholder = "Profile unknown",
): string {
  if (!selection?.model && !selection?.effort) return placeholder
  const option = groups.flatMap((group) => group.options).find((candidate) => candidate.model === selection.model)
  const model = option?.label ?? selection.model ?? "Model unknown"
  // Older Claude sessions record their resolved model in the provider transcript but never the
  // launch effort. Present that incomplete provenance as a legacy state, not as an apparent
  // malformed selection. A concrete effort is always shown verbatim; no default is inferred.
  return selection.effort ? `${model} › ${selection.effort}` : `${model} › Legacy profile`
}

// Arrow keys move through the visual matrix rather than the DOM's flattened menu order. Horizontal
// movement stays on a model and skips unsupported cells; vertical movement preserves the effort
// column when possible, falling back to the nearest supported effort in the destination row.
export function moveProfileGridSelection(
  groups: readonly ProfileGridGroup[],
  current: ProfileGridSelection,
  key: ProfileGridMoveKey,
): ProfileGridSelection | null {
  const columns = profileGridEfforts(groups)
  const rows = groups.flatMap((group) => group.options.map((option) => ({ provider: group.id, option })))
  const rowIndex = rows.findIndex((row) => row.provider === current.provider && row.option.model === current.model)
  if (rowIndex === -1) return null
  const row = rows[rowIndex]!
  const currentEffortIndex = row.option.efforts.indexOf(current.effort)
  if (currentEffortIndex === -1) return null

  if (key === "Home" || key === "End" || key === "ArrowLeft" || key === "ArrowRight") {
    const nextIndex = key === "Home"
      ? 0
      : key === "End"
        ? row.option.efforts.length - 1
        : currentEffortIndex + (key === "ArrowLeft" ? -1 : 1)
    const effort = row.option.efforts[nextIndex]
    return effort ? { provider: row.provider, model: row.option.model, effort } : null
  }

  const nextRow = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)]
  if (!nextRow) return null
  const currentColumn = columns.indexOf(current.effort)
  const effort = nextRow.option.efforts.reduce<string | undefined>((nearest, candidate) => {
    if (!nearest) return candidate
    return Math.abs(columns.indexOf(candidate) - currentColumn) < Math.abs(columns.indexOf(nearest) - currentColumn)
      ? candidate
      : nearest
  }, undefined)
  return effort ? { provider: nextRow.provider, model: nextRow.option.model, effort } : null
}
