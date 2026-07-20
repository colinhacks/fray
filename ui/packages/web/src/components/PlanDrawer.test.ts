import assert from "node:assert/strict"
import test from "node:test"
import {
  PLAN_DRAWER_ACTION_ARIA_LABEL,
  PLAN_DRAWER_ACTION_LABEL,
  PLAN_DRAWER_ACTION_TITLE,
  PLAN_DRAWER_DELETE_ARIA_LABEL,
  PLAN_DRAWER_DELETE_LABEL,
  PLAN_DRAWER_DELETE_TITLE,
  PLAN_DRAWER_FOOTER_STYLE,
} from "./planDrawerAction.ts"

test("plan drawer action uses the implementation label and an explicit accessible name", () => {
  assert.equal(PLAN_DRAWER_ACTION_LABEL, "Implement this")
  assert.equal(PLAN_DRAWER_ACTION_ARIA_LABEL, "Implement this plan")
  assert.equal(PLAN_DRAWER_ACTION_TITLE, "Start a new thread to implement this plan")
  assert.match(PLAN_DRAWER_FOOTER_STYLE.paddingBottom, /safe-area-inset-bottom/)
})

test("plan drawer delete action carries its own label, accessible name, and title", () => {
  assert.equal(PLAN_DRAWER_DELETE_LABEL, "Delete plan")
  assert.equal(PLAN_DRAWER_DELETE_ARIA_LABEL, "Delete this plan")
  assert.equal(PLAN_DRAWER_DELETE_TITLE, "Permanently delete this plan file")
})

test("plan drawer action does not retain the obsolete header copy", () => {
  assert.notEqual(PLAN_DRAWER_ACTION_LABEL, "New thread from plan")
  assert.notEqual(PLAN_DRAWER_ACTION_TITLE, "Start a new thread from this plan")
})
