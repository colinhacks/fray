import assert from "node:assert/strict"
import test from "node:test"
import {
  moveProfileGridSelection,
  PROFILE_GRID_CELL_CLASS,
  PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS,
  PROFILE_GRID_TYPOGRAPHY_CLASS,
  profileGridDisplayLabel,
  profileGridEfforts,
  profileGridSelectionFromKey,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  profileGridSelections,
  profileGridTemplateColumns,
  type ProfileGridGroup,
} from "./profileGrid.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "./promptControlTypography.ts"

const groups: ProfileGridGroup[] = [
  {
    id: "claude",
    label: "Claude Code",
    options: [
      { model: "sonnet", label: "Sonnet", defaultEffort: "high", efforts: ["low", "high", "max"] },
      { model: "opus", label: "Opus with a deliberately long display name", defaultEffort: "max", efforts: ["high", "max"] },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    options: [
      { model: "gpt-5.6-sol", label: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "ultra"] },
    ],
  },
]

test("profile grid emits complete pairs and omits unsupported cells", () => {
  const cells = profileGridSelections(groups)
  assert.ok(cells.some((cell) => cell.provider === "codex" && cell.model === "gpt-5.6-sol" && cell.effort === "ultra"))
  assert.equal(cells.some((cell) => cell.model === "opus" && cell.effort === "low"), false)
  assert.deepEqual(profileGridEfforts(groups), ["low", "medium", "high", "xhigh", "max", "ultra"])
})

test("profile grid resolves a radio value only to a complete supported pair", () => {
  const expected = { provider: "codex", model: "gpt-5.6-sol", effort: "low" }
  assert.deepEqual(profileGridSelectionFromKey(groups, profileGridSelectionKey(expected)), expected)
  assert.equal(
    profileGridSelectionFromKey(groups, JSON.stringify(["codex", "gpt-5.6-sol", "max"])),
    undefined,
    "a cell absent from the model's effort row must not be committed",
  )
})

test("profile grid represents recovered, legacy-partial, retired, and pending labels honestly", () => {
  const current = { provider: "claude", model: "sonnet", effort: "high" }
  assert.equal(profileGridSelectionKnown(groups, current), true)
  assert.equal(profileGridDisplayLabel(groups, current), "Sonnet › high")
  assert.equal(profileGridSelectionKnown(groups, { provider: "claude", model: "retired", effort: "max" }), false)
  assert.equal(profileGridDisplayLabel(groups, { model: "retired", effort: "max" }), "retired › max")
  assert.equal(
    profileGridDisplayLabel(groups, { model: "sonnet" }),
    "Sonnet › Legacy profile",
    "a provider-observed model without launch effort is truthful but not a broken-looking pair",
  )
  assert.equal(profileGridDisplayLabel(groups, undefined, "Profile loading…"), "Profile loading…")
  assert.equal(profileGridDisplayLabel(groups, { model: "gpt-5.6-sol", effort: "ultra" }, "Pending profile"), "GPT-5.6 Sol › ultra")
})

test("profile grid keyboard movement follows rows and supported effort columns", () => {
  assert.deepEqual(
    moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "high" }, "ArrowRight"),
    { provider: "claude", model: "sonnet", effort: "max" },
  )
  assert.deepEqual(
    moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "low" }, "ArrowDown"),
    { provider: "claude", model: "opus", effort: "high" },
    "vertical movement lands on the nearest supported cell instead of an absent one",
  )
  assert.deepEqual(
    moveProfileGridSelection(groups, { provider: "claude", model: "opus", effort: "max" }, "ArrowDown"),
    { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
  )
  assert.equal(moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "low" }, "ArrowLeft"), null)
})

test("profile grid triggers match the adjacent prompt-control type scale in every context", () => {
  const promptBoxContexts = [
    "new-thread",
    "sidebar",
    "queue-card",
    "thread-desktop",
    "thread-390px",
  ]
  const typographyFor = (context: string) => context.startsWith("thread") || context === "queue-card"
    ? PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS
    : PROFILE_GRID_TYPOGRAPHY_CLASS

  for (const context of promptBoxContexts) {
    const typography = typographyFor(context)
    assert.match(typography, /petite-caps/, `${context} keeps petite caps`)
    assert.equal(typography, PROMPT_CONTROL_TYPOGRAPHY_CLASS, `${context} uses the shared prompt-control type scale`)
    assert.doesNotMatch(typography, /max-|min-|sm:|md:|lg:/i, `${context} has no responsive type scale`)
    assert.doesNotMatch(typography, /text-\[(?:9\.5|11)px\]/, `${context} cannot regress to the tiny compact type`)
    assert.doesNotMatch(typography, /scale(?:-|\[)/, `${context} cannot scale profile text down`)
  }
  assert.equal(PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS, PROFILE_GRID_TYPOGRAPHY_CLASS)
})

test("profile grid cells use pointer affordance and icon-free selection ring/tint classes", () => {
  assert.match(PROFILE_GRID_CELL_CLASS, /cursor-pointer/)
  assert.match(PROFILE_GRID_CELL_CLASS, /data-\[state=checked\]:ring-accent/)
  assert.match(PROFILE_GRID_CELL_CLASS, /data-\[state=checked\]:bg-accent/)
  assert.match(PROFILE_GRID_CELL_CLASS, /data-\[highlighted\]:outline-fg/)
  assert.match(PROFILE_GRID_CELL_CLASS, /prompt-control-type/)
  assert.doesNotMatch(PROFILE_GRID_CELL_CLASS, /pl-/)
})

test("profile grid keeps the model column bounded beside a five-level effort row", () => {
  assert.equal(profileGridTemplateColumns(5), "minmax(6rem, 7rem) repeat(5, minmax(2.75rem, auto))")
})
