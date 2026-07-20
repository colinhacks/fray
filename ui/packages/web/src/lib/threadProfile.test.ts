import { test } from "node:test"
import assert from "node:assert/strict"
import { selectThreadProfileTarget, threadProfileControlState, threadProfileLabel } from "./threadProfile.ts"

test("threadProfileLabel: shows the pinned model and effort compactly", () => {
  assert.equal(threadProfileLabel("opus", "high"), "opus · high")
  assert.equal(threadProfileLabel("gpt-5.6-sol", "ultra"), "gpt-5.6-sol · ultra")
})

test("threadProfileLabel: degrades cleanly for partial and legacy/unknown profiles", () => {
  assert.equal(threadProfileLabel("claude-fable-5", undefined), "claude-fable-5")
  assert.equal(threadProfileLabel(undefined, "high"), "high effort")
  assert.equal(threadProfileLabel("  ", ""), null)
  assert.equal(threadProfileLabel(undefined, undefined), null)
})

test("selectThreadProfileTarget: emits one complete supported pair and fails closed", () => {
  const options = [
    { model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" },
    { model: "opus", efforts: ["high", "max"], defaultEffort: "max" },
  ]
  assert.deepEqual(selectThreadProfileTarget(options, "high", "opus"), { model: "opus", effort: "high" })
  assert.deepEqual(selectThreadProfileTarget(options, "low", "opus"), { model: "opus", effort: "max" })
  assert.equal(selectThreadProfileTarget(options, "high", "unknown"), null)
  assert.equal(selectThreadProfileTarget([{ model: "broken", efforts: ["high"], defaultEffort: "max" }], "low", "broken"), null)
})

test("threadProfileControlState: exited legacy profiles can be repaired without opening an invalid effort", () => {
  const options = [
    { model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" },
    { model: "opus", efforts: ["high", "max"], defaultEffort: "max" },
  ]
  assert.deepEqual(
    threadProfileControlState(options, "retired-model", "retired-effort", true),
    {
      selectedProfile: undefined,
      modelKnown: false,
      effortKnown: false,
      profileKnown: false,
      modelSelectable: true,
      effortSelectable: false,
    },
  )
  const retiredEffort = threadProfileControlState(options, "sonnet", "retired-effort", true)
  assert.equal(retiredEffort.modelSelectable, true)
  assert.equal(retiredEffort.effortSelectable, true)
  assert.equal(retiredEffort.modelKnown, true)
  assert.equal(retiredEffort.effortKnown, false)
})

test("threadProfileControlState: a live unknown or partial profile stays fail closed", () => {
  const options = [{ model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" }]
  for (const state of [
    threadProfileControlState(options, "retired-model", "high", false),
    threadProfileControlState(options, "sonnet", "retired-effort", false),
  ]) {
    assert.equal(state.modelSelectable, false)
    assert.equal(state.effortSelectable, false)
  }
  const known = threadProfileControlState(options, "sonnet", "high", false)
  assert.equal(known.modelSelectable, true)
  assert.equal(known.effortSelectable, true)
})
