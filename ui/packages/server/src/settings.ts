import { Settings } from "@fray-ui/shared"
import type { Storage } from "./storage.ts"

const SETTINGS_KEY = "settings"

// dispatchPreamble is the USER's custom per-project instructions, appended after the fixed
// worker system prompt (ui/WORKER_PROMPT.md, loaded in dispatch.ts — not configurable here).
const DEFAULT_PREAMBLE = ""

export const defaultSettings = (): Settings => ({
  dispatchPreamble: DEFAULT_PREAMBLE,
  // `auto` = the CLI's classifier mode: safe actions auto-approve, risky ones still prompt in
  // the embedded terminal. Fewer invisible permission stalls than acceptEdits/default.
  permissionMode: "auto",
  model: undefined,
  effort: undefined,
  notifications: true,
  font: "sans",
})

// Settings persist as one JSON blob under settings['settings']. Read merges over defaults
// (so a schema addition lands with a sane value on an old DB); a parse/validation miss also
// degrades to defaults rather than throwing.
export function getSettings(storage: Storage): Settings {
  const raw = storage.getSetting(SETTINGS_KEY)
  if (raw === undefined) return defaultSettings()
  const parsed = Settings.safeParse({ ...defaultSettings(), ...(raw as object) })
  return parsed.success ? parsed.data : defaultSettings()
}

export function setSettings(storage: Storage, next: Settings): Settings {
  const validated = Settings.parse(next)
  storage.setSetting(SETTINGS_KEY, validated)
  return validated
}

// Clear the stored blob so getSettings falls back to defaults (incl. the shipped default preamble).
export function resetSettings(storage: Storage): Settings {
  storage.deleteSetting(SETTINGS_KEY)
  return defaultSettings()
}
