import assert from "node:assert/strict"
import test from "node:test"
import { activeSidebarSection, railRevealDelta } from "./sidebarScrollspy.ts"

test("scrollspy chooses the card crossing the queue's 12px reading line", () => {
  assert.equal(activeSidebarSection([
    { id: "one", top: -180, bottom: 10 },
    { id: "two", top: 12, bottom: 420 },
    { id: "three", top: 460, bottom: 810 },
  ]), "two")
})

test("scrollspy stays deterministic across a keyframe reorder and ignores fully past cards", () => {
  assert.equal(activeSidebarSection([
    { id: "old", top: -320, bottom: -4 },
    { id: "reordered", top: 40, bottom: 330 },
    { id: "later", top: 380, bottom: 620 },
  ]), "reordered")
})

test("scrollspy returns no marker when no queue card is currently mounted", () => {
  assert.equal(activeSidebarSection([]), null)
  assert.equal(activeSidebarSection([{ id: "past", top: -400, bottom: 12 }]), null)
})

test("scrollspy chooses the nearest upcoming card when the reading line is in an inter-card gap", () => {
  assert.equal(activeSidebarSection([
    { id: "past", top: -300, bottom: 4 },
    { id: "next", top: 34, bottom: 240 },
    { id: "later", top: 420, bottom: 620 },
  ]), "next")
})

test("scrollspy gives a short final visible card the rail at the true document bottom", () => {
  assert.equal(activeSidebarSection([
    { id: "long", top: -740, bottom: -24 },
    { id: "final", top: 560, bottom: 684 },
  ], 12, true), "final")
})

test("scrollspy does not promote the final card away from the document bottom", () => {
  assert.equal(activeSidebarSection([
    { id: "current", top: -80, bottom: 420 },
    { id: "final", top: 620, bottom: 744 },
  ], 12, false), "current")
})

test("rail reveal scrolls only enough to expose an active item and leaves visible rows alone", () => {
  assert.equal(railRevealDelta(100, 500, 90, 126), -18)
  assert.equal(railRevealDelta(100, 500, 470, 520), 28)
  assert.equal(railRevealDelta(100, 500, 160, 220), 0)
})
