import {
  DispatchPreferences,
  type Backend,
  type CodexModel,
  type PermissionMode,
  type SetDispatchPreferenceInput,
  type Settings,
} from "@fray-ui/shared"
import type { Storage } from "./storage.ts"

const KEY = "dispatch-preferences.v1"

function permissionFor(backend: Backend, mode: PermissionMode): PermissionMode {
  if (backend === "codex") {
    if (mode === "plan" || mode === "bypassPermissions") return mode
    return "default"
  }
  return mode === "plan" ? "auto" : mode
}

// Migrate the existing single Settings profile without writing anything. This preserves the old
// configured choice on first use while ensuring a merely displayed fallback never becomes stored
// intent. Once a composer selection is changed, the dedicated record becomes authoritative.
export function defaultDispatchPreferences(
  settings: Settings,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  // Older Settings records predate the explicit backend field. Infer those from the same live Codex
  // catalogue the picker uses so a saved GPT choice migrates into the Codex profile instead of being
  // mistaken for an unavailable Claude model.
  const backend: Backend = settings.backend ?? (codexModels.some((model) => model.slug === settings.model) ? "codex" : "claude")
  const selected = {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    permissionMode: permissionFor(backend, settings.permissionMode),
  }
  return {
    backend,
    claude: backend === "claude" ? selected : { permissionMode: "auto" },
    codex: backend === "codex" ? selected : { permissionMode: "default" },
  }
}

export function getDispatchPreferences(
  storage: Storage,
  settings: Settings,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  const parsed = DispatchPreferences.safeParse(storage.getSetting(KEY))
  return parsed.success ? parsed.data : defaultDispatchPreferences(settings, codexModels)
}

export function setDispatchPreference(
  storage: Storage,
  settings: Settings,
  update: SetDispatchPreferenceInput,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  const current = getDispatchPreferences(storage, settings, codexModels)
  let next: DispatchPreferences
  if (update.field === "backend") {
    next = { ...current, backend: update.value }
  } else if (update.field === "profile") {
    next = {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...current[update.backend],
        model: update.model,
        effort: update.effort,
      },
    }
  } else {
    const profile = current[update.backend]
    next = {
      ...current,
      ...(update.field === "model" ? { backend: update.backend } : {}),
      [update.backend]: { ...profile, [update.field]: update.value },
    }
  }
  const validated = DispatchPreferences.parse(next)
  storage.setSetting(KEY, validated)
  return validated
}
