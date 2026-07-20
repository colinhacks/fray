import { test } from "node:test"
import assert from "node:assert/strict"
import type { CodexModel } from "@fray-ui/shared"
import {
  backendForModel,
  codexPermValue,
  claudePermValue,
  permValueFor,
  codexEffortForModel,
  codexEffortOptions,
  codexModelFor,
  modelGroups,
  CODEX_MODELS_FALLBACK,
  CLAUDE_MODELS,
  PERMISSION_COLOR,
} from "./options.ts"

// A live RPC catalogue stub (per-model effort gating: sol → …/ultra, 5.5 → …/xhigh) — proves the
// picker keys off the cache-derived list, not a hardcoded one.
const LIVE_CODEX: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
]

// The model→backend derivation the whole picker keys off (Codex-support epic, Phase 3).
test("backendForModel: a codex model id resolves to the codex backend", () => {
  for (const m of CODEX_MODELS_FALLBACK) assert.equal(backendForModel(m.slug), "codex")
  // A slug present ONLY in the live RPC list (not the compiled-in fallback) still resolves to codex.
  assert.equal(backendForModel("gpt-5.6-terra-future", LIVE_CODEX.concat({ slug: "gpt-5.6-terra-future", displayName: "x", defaultEffort: "low", efforts: ["low"] })), "codex")
})
test("backendForModel: a Claude alias, empty, or unknown resolves to claude (the default)", () => {
  for (const m of CLAUDE_MODELS) assert.equal(backendForModel(m.value), "claude")
  assert.equal(backendForModel(""), "claude")
  assert.equal(backendForModel(undefined), "claude")
  assert.equal(backendForModel("some-future-unknown"), "claude")
})

// The per-model effort gating: the effort dropdown offers EXACTLY the chosen model's cache efforts.
test("codexEffortOptions: a codex model's effort options are exactly its cache efforts", () => {
  const sol = codexModelFor("gpt-5.6-sol", LIVE_CODEX)!
  assert.deepEqual(codexEffortOptions(sol, { withDefault: false }).map((o) => o.value), ["low", "medium", "high", "xhigh", "max", "ultra"])
  const g55 = codexModelFor("gpt-5.5", LIVE_CODEX)!
  assert.deepEqual(codexEffortOptions(g55, { withDefault: false }).map((o) => o.value), ["low", "medium", "high", "xhigh"])
  // withDefault prepends the settings "Default" row (empty value).
  assert.equal(codexEffortOptions(g55, { withDefault: true })[0]!.value, "")
})

// The clamp: a supported effort passes through; an unsupported one clamps DOWN the ladder (never up).
test("codexEffortForModel: keeps a supported effort, clamps an unsupported one down to the model ceiling", () => {
  const sol = codexModelFor("gpt-5.6-sol", LIVE_CODEX)!
  const g55 = codexModelFor("gpt-5.5", LIVE_CODEX)!
  assert.equal(codexEffortForModel(sol, "max"), "max") // 5.6 supports max → kept (the old blanket clamp was WRONG here)
  assert.equal(codexEffortForModel(sol, "ultra"), "ultra")
  assert.equal(codexEffortForModel(g55, "max"), "xhigh") // 5.5 stops at xhigh → clamp down
  assert.equal(codexEffortForModel(g55, "ultra"), "xhigh")
  assert.equal(codexEffortForModel(g55, "high"), "high")
  assert.equal(codexEffortForModel(g55, ""), "") // "" = use model default (settings placeholder)
})

// The picker's Codex section is DRIVEN by the RPC list, ordered as delivered (server sorts by priority).
test("modelGroups: the Codex group reflects the live RPC list; withDefault prepends the Default row", () => {
  const groups = modelGroups(LIVE_CODEX, { withDefault: false })
  const codex = groups.find((g) => g.label === "Codex")!
  assert.deepEqual(codex.options.map((o) => o.value), ["gpt-5.6-sol", "gpt-5.5"])
  const withDefault = modelGroups(LIVE_CODEX, { withDefault: true })
  assert.equal(withDefault[0]!.options[0]!.value, "") // leading "Default" (claude CLI default)
  // Empty live list → the compiled-in fallback keeps the section populated (loading / no-cache state).
  const fallback = modelGroups([], { withDefault: false }).find((g) => g.label === "Codex")!
  assert.deepEqual(fallback.options.map((o) => o.value), CODEX_MODELS_FALLBACK.map((m) => m.slug))
})

// The codex sandbox dropdown is a VIEW over PermissionMode; codexPermValue mirrors the server's
// codexSandbox() mapping so the dispatch carries a mode that maps to the sandbox the user saw.
test("codexPermValue: plan→plan (read-only), bypass→bypass (full), everything else→default (workspace-write)", () => {
  assert.equal(codexPermValue("plan"), "plan")
  assert.equal(codexPermValue("bypassPermissions"), "bypassPermissions")
  assert.equal(codexPermValue("default"), "default")
  assert.equal(codexPermValue("auto"), "default")
  assert.equal(codexPermValue("acceptEdits"), "default")
})

// Claude's dropdown omits "plan" (dispatch coerces plan→auto), so a mode set on codex displays as auto.
test("claudePermValue: plan→auto, everything else passes through", () => {
  assert.equal(claudePermValue("plan"), "auto")
  assert.equal(claudePermValue("auto"), "auto")
  assert.equal(claudePermValue("bypassPermissions"), "bypassPermissions")
  assert.equal(claudePermValue("acceptEdits"), "acceptEdits")
})

test("bypass/full-access uses the ordinary permission readout color", () => {
  assert.equal(PERMISSION_COLOR.bypassPermissions, PERMISSION_COLOR.default)
  assert.equal(PERMISSION_COLOR.bypassPermissions, "text-muted")
})

test("permValueFor: dispatches to the codex vs claude mapper by backend", () => {
  assert.equal(permValueFor("codex", "acceptEdits"), "default")
  assert.equal(permValueFor("codex", "plan"), "plan")
  assert.equal(permValueFor("claude", "plan"), "auto")
  assert.equal(permValueFor("claude", "acceptEdits"), "acceptEdits")
})
