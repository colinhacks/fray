// Compact session-profile text for the quiet line beneath a thread composer. Missing values are
// expected on pre-migration, foreign, or CLI-default sessions; never invent a value from current
// Settings, because those defaults describe the NEXT dispatch rather than this conversation.
export function threadProfileLabel(model?: string, effort?: string): string | null {
  const m = model?.trim()
  const e = effort?.trim()
  if (m && e) return `${m} · ${e}`
  if (m) return m
  if (e) return `${e} effort`
  return null
}

export type ThreadProfileChoice = {
  model: string
  efforts: readonly string[]
  defaultEffort: string
}

// Exited threads have no live runtime to protect, so a legacy/missing profile may be repaired by
// selecting a provider-owned model. Live threads stay fail-closed unless their complete current pair
// is known: otherwise changing either half could silently relabel an unrelated runtime.
export function threadProfileControlState(
  options: readonly ThreadProfileChoice[],
  currentModel: string | undefined,
  currentEffort: string | undefined,
  exited: boolean,
): {
  selectedProfile: ThreadProfileChoice | undefined
  modelKnown: boolean
  effortKnown: boolean
  profileKnown: boolean
  modelSelectable: boolean
  effortSelectable: boolean
} {
  const selectedProfile = options.find((option) => option.model === currentModel)
  const modelKnown = Boolean(selectedProfile)
  const effortKnown = Boolean(selectedProfile && currentEffort && selectedProfile.efforts.includes(currentEffort))
  const profileKnown = modelKnown && effortKnown
  return {
    selectedProfile,
    modelKnown,
    effortKnown,
    profileKnown,
    modelSelectable: exited || profileKnown,
    effortSelectable: Boolean(selectedProfile) && (exited || profileKnown),
  }
}

// A model click is always converted to one complete provider-owned pair before it reaches RPC.
// Preserve the current effort only when the target model actually supports it; malformed catalog
// entries fail closed instead of sending a partial or invented profile.
export function selectThreadProfileTarget(
  options: readonly ThreadProfileChoice[],
  currentEffort: string | undefined,
  nextModel: string,
): { model: string; effort: string } | null {
  const next = options.find((option) => option.model === nextModel)
  if (!next) return null
  const effort = currentEffort && next.efforts.includes(currentEffort)
    ? currentEffort
    : next.defaultEffort
  return effort && next.efforts.includes(effort) ? { model: next.model, effort } : null
}
