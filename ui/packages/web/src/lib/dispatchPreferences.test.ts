import { test } from "node:test"
import assert from "node:assert/strict"
import type { CodexModel, DispatchPreferences } from "@fray-ui/shared"
import { applyDispatchPreferenceUpdate, dispatchModelGroups, dispatchProfileGroups, resolveDispatchPreferences } from "./dispatchPreferences.ts"

const models: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "ultra"] },
  { slug: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
]

const preferences: DispatchPreferences = {
  backend: "claude",
  claude: { model: "sonnet", effort: "max", permissionMode: "acceptEdits" },
  codex: { model: "gpt-5.5", effort: "xhigh", permissionMode: "plan" },
}

test("provider switching restores each runtime's exact model, effort, and permission profile", () => {
  assert.deepEqual(resolveDispatchPreferences(preferences, models), {
    backend: "claude",
    model: "sonnet",
    effort: "max",
    permissionMode: "acceptEdits",
    codexModel: undefined,
    modelAvailable: true,
    effortAvailable: true,
    effortOptions: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "X-high" },
      { value: "max", label: "Max" },
    ],
  })
  const codex = applyDispatchPreferenceUpdate(preferences, { field: "backend", value: "codex" })
  const resolved = resolveDispatchPreferences(codex, models)
  assert.equal(resolved.model, "gpt-5.5")
  assert.equal(resolved.effort, "xhigh")
  assert.equal(resolved.permissionMode, "plan")
  assert.deepEqual(codex.claude, preferences.claude, "switching provider leaves Claude intent untouched")
})

test("choosing a model switches runtime atomically without replacing the other runtime profile", () => {
  const next = applyDispatchPreferenceUpdate(preferences, { field: "model", backend: "codex", value: "gpt-5.6-sol" })
  assert.equal(next.backend, "codex")
  assert.equal(next.codex.model, "gpt-5.6-sol")
  assert.deepEqual(next.claude, preferences.claude)
})

test("choosing a matrix cell writes one complete provider profile atomically", () => {
  const next = applyDispatchPreferenceUpdate(preferences, {
    field: "profile",
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.equal(next.backend, "codex")
  assert.deepEqual(next.codex, { ...preferences.codex, model: "gpt-5.6-sol", effort: "ultra" })
  assert.deepEqual(next.claude, preferences.claude)
})

test("dispatch profile groups keep provider catalogues and per-model effort sets scoped", () => {
  const groups = dispatchProfileGroups(models)
  assert.deepEqual(groups.map((group) => group.id), ["claude", "codex"])
  assert.deepEqual(
    groups[0]?.options.find((option) => option.model === "opus")?.efforts,
    ["low", "medium", "high", "xhigh", "max"],
    "the Claude selector must not offer Codex-only ultra",
  )
  assert.deepEqual(groups[1]?.options[0], {
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "ultra"],
  })
  assert.equal(groups[1]?.options.some((option) => option.model === "opus"), false)
})

test("a renamed/unavailable saved model remains visible and invalid instead of becoming Opus or a catalogue default", () => {
  const saved: DispatchPreferences = {
    ...preferences,
    backend: "codex",
    codex: { model: "gpt-renamed", effort: "ultra", permissionMode: "bypassPermissions" },
  }
  const resolved = resolveDispatchPreferences(saved, models)
  assert.equal(resolved.model, "gpt-renamed")
  assert.equal(resolved.effort, "ultra")
  assert.equal(resolved.modelAvailable, false)
  assert.equal(resolved.effortAvailable, false)
  assert.equal(dispatchModelGroups(models, "codex", "gpt-renamed")[0]?.options[0]?.value, "gpt-renamed")
  assert.deepEqual(saved.codex, { model: "gpt-renamed", effort: "ultra", permissionMode: "bypassPermissions" }, "resolution is read-only")
})

test("an incompatible saved effort is surfaced for explicit correction rather than silently clamped", () => {
  const saved: DispatchPreferences = {
    ...preferences,
    backend: "codex",
    codex: { model: "gpt-5.5", effort: "ultra", permissionMode: "default" },
  }
  const resolved = resolveDispatchPreferences(saved, models)
  assert.equal(resolved.modelAvailable, true)
  assert.equal(resolved.effort, "ultra")
  assert.equal(resolved.effortAvailable, false)
  assert.equal(resolved.effortOptions[0]?.value, "ultra")
})
