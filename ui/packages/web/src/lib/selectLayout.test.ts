import { test } from "node:test"
import assert from "node:assert/strict"
import { selectDisplayValue, selectRowPadding } from "./selectLayout.ts"

test("selectRowPadding: reserves the check gutter on its side and keeps the text edge deterministic", () => {
  assert.equal(selectRowPadding("right"), "pl-3 pr-7")
  assert.equal(selectRowPadding("left"), "pl-7 pr-3")
})

test("selectDisplayValue: hydration and unavailable values never collapse to a caret-only trigger", () => {
  assert.deepEqual(selectDisplayValue("", [], undefined, "Loading…"), { text: "Loading…", placeholder: true })
  assert.deepEqual(selectDisplayValue("retired-model", [], undefined, "Loading…"), { text: "retired-model", placeholder: false })
})

test("selectDisplayValue: a real empty-value option wins over the placeholder and groups share the same lookup", () => {
  assert.deepEqual(selectDisplayValue("", [{ value: "", label: "Default" }], undefined, "Loading…"), {
    text: "Default",
    placeholder: false,
  })
  assert.deepEqual(
    selectDisplayValue("opus", undefined, [{ options: [{ value: "opus", label: "Opus" }] }], "Loading…"),
    { text: "Opus", placeholder: false },
  )
})
