import type {
  Backend,
  CodexModel,
  DispatchPreferences,
  PermissionMode,
  SetDispatchPreferenceInput,
} from "@fray-ui/shared"
import type { SelectGroup, SelectOption } from "../components/ui/Select.tsx"
import type { ProfileGridGroup } from "./profileGrid.ts"
import {
  CLAUDE_MODELS,
  EFFORT_OPTIONS,
  codexEffortOptions,
  modelGroups,
  permValueFor,
} from "./options.ts"

const CLAUDE_EFFORT_OPTIONS = EFFORT_OPTIONS.filter((option) => option.value !== "")

export interface ResolvedDispatchPreferences {
  backend: Backend
  model: string
  effort: string
  permissionMode: PermissionMode
  codexModel?: CodexModel
  modelAvailable: boolean
  effortAvailable: boolean
  effortOptions: SelectOption[]
}

export function applyDispatchPreferenceUpdate(
  current: DispatchPreferences,
  update: SetDispatchPreferenceInput,
): DispatchPreferences {
  if (update.field === "backend") return { ...current, backend: update.value }
  if (update.field === "profile") {
    return {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...current[update.backend],
        model: update.model,
        effort: update.effort,
      },
    }
  }
  return {
    ...current,
    ...(update.field === "model" ? { backend: update.backend } : {}),
    [update.backend]: { ...current[update.backend], [update.field]: update.value },
  }
}

export function dispatchProfileGroups(codexModels: readonly CodexModel[]): ProfileGridGroup[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      options: CLAUDE_MODELS.map((option) => ({
        model: option.value,
        label: option.label,
        defaultEffort: "high",
        efforts: CLAUDE_EFFORT_OPTIONS.map((effort) => effort.value),
      })),
    },
    {
      id: "codex",
      label: "Codex",
      options: codexModels.map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: model.efforts,
      })),
    },
  ]
}

export function resolveDispatchPreferences(
  preferences: DispatchPreferences,
  codexModels: readonly CodexModel[],
): ResolvedDispatchPreferences {
  const backend = preferences.backend
  const profile = preferences[backend]
  const model = profile.model ?? (backend === "claude" ? "opus" : codexModels[0]?.slug ?? "")
  const codexModel = backend === "codex"
    ? codexModels.find((candidate) => candidate.slug === model)
    : undefined
  const modelAvailable = backend === "claude"
    ? CLAUDE_MODELS.some((candidate) => candidate.value === model)
    : codexModels.some((candidate) => candidate.slug === model)
  const defaultEffort = backend === "claude" ? "high" : codexModel?.defaultEffort ?? ""
  const effort = profile.effort ?? defaultEffort
  const baseEfforts = backend === "claude"
    ? CLAUDE_EFFORT_OPTIONS
    : codexEffortOptions(codexModel, { withDefault: false })
  const effortAvailable = baseEfforts.some((option) => option.value === effort)
  const effortOptions = effort && !effortAvailable
    ? [{ value: effort, label: `${effort} (unavailable)`, title: "Saved reasoning level is not available for this model" }, ...baseEfforts]
    : baseEfforts
  const permissionMode = permValueFor(
    backend,
    profile.permissionMode ?? (backend === "claude" ? "auto" : "default"),
  )
  return {
    backend,
    model,
    effort,
    permissionMode,
    codexModel,
    modelAvailable,
    effortAvailable,
    effortOptions,
  }
}

export function dispatchModelGroups(
  codexModels: readonly CodexModel[],
  backend: Backend,
  selectedModel: string,
): SelectGroup[] {
  const groups = modelGroups(codexModels, { withDefault: false })
  if (!selectedModel || groups.some((group) => group.options.some((option) => option.value === selectedModel))) return groups
  const unavailable: SelectGroup = {
    label: backend === "codex" ? "Saved Codex model" : "Saved Claude model",
    options: [{ value: selectedModel, label: `${selectedModel} (unavailable)`, title: "This saved model is no longer in the runtime catalogue" }],
  }
  return [unavailable, ...groups]
}
