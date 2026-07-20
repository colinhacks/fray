import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { defaultDispatchPreferences, getDispatchPreferences, setDispatchPreference } from "./dispatch-preferences.ts"

test("dispatch preferences migrate the selected Settings runtime without contaminating the other provider", () => {
  const settings = {
    ...defaultSettings(),
    backend: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "ultra" as const,
    permissionMode: "bypassPermissions" as const,
  }
  assert.deepEqual(defaultDispatchPreferences(settings), {
    backend: "codex",
    claude: { permissionMode: "auto" },
    codex: { model: "gpt-5.6-sol", effort: "ultra", permissionMode: "bypassPermissions" },
  })
})

test("dispatch preferences infer an old Settings record's Codex backend from the live catalogue", () => {
  const settings = {
    ...defaultSettings(),
    backend: undefined,
    model: "gpt-new-from-cache",
    effort: "xhigh" as const,
  }
  assert.deepEqual(
    defaultDispatchPreferences(settings, [
      { slug: "gpt-new-from-cache", displayName: "GPT New", defaultEffort: "medium", efforts: ["medium", "xhigh"] },
    ]),
    {
      backend: "codex",
      claude: { permissionMode: "auto" },
      codex: { model: "gpt-new-from-cache", effort: "xhigh", permissionMode: "default" },
    },
  )
})

test("dispatch preferences persist provider-specific selections across a database restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "fray-dispatch-preferences-")), "ui.db")
  const settings = defaultSettings()
  let storage = createStorage(path)

  setDispatchPreference(storage, settings, { field: "model", backend: "claude", value: "sonnet" })
  setDispatchPreference(storage, settings, { field: "effort", backend: "claude", value: "max" })
  setDispatchPreference(storage, settings, { field: "permissionMode", backend: "claude", value: "acceptEdits" })
  setDispatchPreference(storage, settings, { field: "model", backend: "codex", value: "gpt-5.5" })
  setDispatchPreference(storage, settings, { field: "effort", backend: "codex", value: "xhigh" })
  setDispatchPreference(storage, settings, { field: "permissionMode", backend: "codex", value: "plan" })
  setDispatchPreference(storage, settings, { field: "backend", value: "claude" })
  storage.close()

  storage = createStorage(path)
  assert.deepEqual(getDispatchPreferences(storage, settings), {
    backend: "claude",
    claude: { model: "sonnet", effort: "max", permissionMode: "acceptEdits" },
    codex: { model: "gpt-5.5", effort: "xhigh", permissionMode: "plan" },
  })
  storage.close()
})

test("a profile cell persists model and effort in one provider-scoped mutation", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-dispatch-profile-")), "ui.db"))
  const settings = defaultSettings()
  const next = setDispatchPreference(storage, settings, {
    field: "profile",
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.equal(next.backend, "codex")
  assert.deepEqual(next.codex, { model: "gpt-5.6-sol", effort: "ultra", permissionMode: "default" })
  assert.deepEqual(next.claude, { permissionMode: "auto" })
  storage.close()
})

test("an invalid saved record degrades in memory and never silently persists a fallback", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-dispatch-preferences-invalid-")), "ui.db"))
  storage.setSetting("dispatch-preferences.v1", { backend: "codex", codex: { model: "" } })
  const settings = defaultSettings()
  assert.deepEqual(getDispatchPreferences(storage, settings), defaultDispatchPreferences(settings))
  assert.deepEqual(
    storage.getSetting("dispatch-preferences.v1"),
    { backend: "codex", codex: { model: "" } },
    "read-time validation must not rewrite user storage",
  )
  storage.close()
})
