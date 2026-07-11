import { test } from "node:test"
import assert from "node:assert/strict"
import {
  backendForModel,
  codexPermValue,
  claudePermValue,
  permValueFor,
  codexEffortValue,
  CODEX_MODELS,
  CLAUDE_MODELS,
} from "./options.ts"

// The model→backend derivation the whole picker keys off (Codex-support epic, Phase 3).
test("backendForModel: a codex model id resolves to the codex backend", () => {
  for (const m of CODEX_MODELS) assert.equal(backendForModel(m.value), "codex")
})
test("backendForModel: a Claude alias, empty, or unknown resolves to claude (the default)", () => {
  for (const m of CLAUDE_MODELS) assert.equal(backendForModel(m.value), "claude")
  assert.equal(backendForModel(""), "claude")
  assert.equal(backendForModel(undefined), "claude")
  assert.equal(backendForModel("some-future-unknown"), "claude")
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

test("permValueFor: dispatches to the codex vs claude mapper by backend", () => {
  assert.equal(permValueFor("codex", "acceptEdits"), "default")
  assert.equal(permValueFor("codex", "plan"), "plan")
  assert.equal(permValueFor("claude", "plan"), "auto")
  assert.equal(permValueFor("claude", "acceptEdits"), "acceptEdits")
})

// Codex accepts only low/medium/high (the wrapper clamps xhigh/max→high); the dropdown reflects that.
test("codexEffortValue: xhigh/max clamp to high, low/medium/high pass through", () => {
  assert.equal(codexEffortValue("xhigh"), "high")
  assert.equal(codexEffortValue("max"), "high")
  assert.equal(codexEffortValue("low"), "low")
  assert.equal(codexEffortValue("medium"), "medium")
  assert.equal(codexEffortValue("high"), "high")
  assert.equal(codexEffortValue(""), "")
})
