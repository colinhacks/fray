import { test } from "node:test"
import assert from "node:assert/strict"
import { GithubBatchInput, type CodexModel } from "@fray-ui/shared"
import type { ResolvedDispatchPreferences } from "./dispatchPreferences.ts"
import {
  buildGithubBatchInput,
  captureDispatchProfile,
  dispatchProfileError,
} from "./githubDispatch.ts"
import { closeGithubPicker, openGithubPicker, store } from "../store.ts"

const codexModel: CodexModel = {
  slug: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  defaultEffort: "medium",
  efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
}

function resolved(overrides: Partial<ResolvedDispatchPreferences> = {}): ResolvedDispatchPreferences {
  return {
    backend: "claude",
    model: "opus",
    effort: "high",
    permissionMode: "acceptEdits",
    modelAvailable: true,
    effortAvailable: true,
    effortOptions: [],
    ...overrides,
  }
}

test("prompt-box capture preserves the exact current provider and atomic pair (no permission)", () => {
  const first = captureDispatchProfile(resolved())
  assert.deepEqual(first, {
    ok: true,
    profile: { backend: "claude", model: "opus", effort: "high" },
  })

  const changed = captureDispatchProfile(resolved({
    backend: "codex",
    model: codexModel.slug,
    effort: "ultra",
    codexModel,
  }))
  assert.deepEqual(changed, {
    ok: true,
    profile: { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
  })
})

test("capture and final validation reject unavailable or invalid model/effort pairs without downgrade", () => {
  assert.deepEqual(captureDispatchProfile(resolved({ modelAvailable: false, model: "unknown" })), {
    ok: false,
    error: "Saved model is unavailable — choose a model before opening GitHub",
  })
  assert.match(
    dispatchProfileError(
      { backend: "codex", model: codexModel.slug, effort: "ultra", permissionMode: "default" },
      [{ ...codexModel, efforts: ["low", "medium", "high", "xhigh"] }],
    ) ?? "",
    /ultra is not available/,
  )
})

test("multi-select builds one exact RPC payload with the captured tuple for every item", () => {
  const profile = { backend: "codex", model: codexModel.slug, effort: "ultra" } as const
  const input = buildGithubBatchInput(profile, [
    { kind: "issue", number: 17 },
    { kind: "issue", number: 23 },
  ])
  assert.deepEqual(input, {
    items: [{ kind: "issue", number: 17 }, { kind: "issue", number: 23 }],
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.deepEqual(GithubBatchInput.parse(input), input)
  assert.throws(() => GithubBatchInput.parse({ ...input, backend: undefined }), /backend/)
  assert.throws(() => GithubBatchInput.parse({ ...input, extraDefault: "opus" }), /unrecognized/i)
})

test("picker close clears its capture and reopen takes a fresh prompt-box snapshot", () => {
  const first = { backend: "claude", model: "sonnet", effort: "medium", permissionMode: "auto" } as const
  const second = { backend: "codex", model: codexModel.slug, effort: "xhigh", permissionMode: "default" } as const
  try {
    openGithubPicker(first)
    assert.equal(store.showGithubPicker, true)
    assert.deepEqual({ ...store.githubDispatchProfile! }, first)

    closeGithubPicker()
    assert.equal(store.showGithubPicker, false)
    assert.equal(store.githubDispatchProfile, null)

    openGithubPicker(second)
    assert.deepEqual({ ...store.githubDispatchProfile! }, second)
  } finally {
    closeGithubPicker()
  }
})
