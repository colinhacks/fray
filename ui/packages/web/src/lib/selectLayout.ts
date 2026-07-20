// One horizontal-padding contract for BOTH option rows and grouped section labels. The text edge must
// follow the indicator: reserve the indicator gutter on the left for legacy/default selects, or on the
// right for model/effort selects whose checkmark lives at the far edge.
export function selectRowPadding(indicatorPosition: "left" | "right"): string {
  return indicatorPosition === "right" ? "pl-3 pr-7" : "pl-7 pr-3"
}

interface SelectDisplayOption {
  value: string
  label: string
}

interface SelectDisplayGroup {
  options: readonly SelectDisplayOption[]
}

// Radix reserves the empty string for its placeholder state, while Fray also has real empty-value
// rows (for example Settings' "Default"). The Select wrapper maps that value to a sentinel, which
// means Radix cannot decide whether to show a placeholder on its own. Resolve the visible text here:
// an exact option label wins, an unavailable-but-saved value stays visible verbatim, and only a truly
// valueless control uses its loading/unknown placeholder. This prevents the hydration state from
// collapsing to a lone down-chevron without turning a real Default choice into "Loading…".
export function selectDisplayValue(
  value: string,
  options: readonly SelectDisplayOption[] | undefined,
  groups: readonly SelectDisplayGroup[] | undefined,
  placeholder: string | undefined,
): { text: string; placeholder: boolean } {
  const renderedOptions = groups ? groups.flatMap((group) => group.options) : options ?? []
  const selected = renderedOptions.find((option) => option.value === value)
  if (selected) return { text: selected.label, placeholder: false }
  if (value) return { text: value, placeholder: false }
  return { text: placeholder ?? "", placeholder: true }
}
