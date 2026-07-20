import { test } from "node:test"
import assert from "node:assert/strict"
import {
  markDrawerClosing,
  pushDrawer,
  pushPlanDrawer,
  pushSubAgentDrawer,
  removeDrawerAfterExit,
  store,
} from "../store.ts"

function resetStore(): void {
  store.drawers = []
  store.view = "todos"
}

test("opening the same logical drawer twice reuses and raises one entry", () => {
  resetStore()
  pushDrawer("thread", "one")
  const id = store.drawers[0]?.id
  pushDrawer("thread", "two")
  pushDrawer("thread", "one")

  assert.deepEqual(store.drawers.map(({ id: currentId, kind, slug }) => ({ id: currentId, kind, slug })), [
    { id: store.drawers.find((drawer) => drawer.slug === "two")?.id, kind: "thread", slug: "two" },
    { id, kind: "thread", slug: "one" },
  ])
})

test("rapid open during exit cancels removal of the same layer", () => {
  resetStore()
  pushDrawer("thread", "rapid")
  const id = store.drawers[0]?.id
  assert.ok(id)
  markDrawerClosing(id)

  pushDrawer("thread", "rapid")
  removeDrawerAfterExit(id)

  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.id, id)
  assert.equal(store.drawers[0]?.closing, undefined)
})

test("different drawer identities still stack, including the same slug across kinds", () => {
  resetStore()
  pushDrawer("thread", "same")
  pushDrawer("doc", "same")
  pushPlanDrawer(".fray/plans/same.md", "Plan")
  pushSubAgentDrawer("same", "tool-1", { label: "child" })

  assert.deepEqual(store.drawers.map(({ kind, slug, path, subId }) => ({ kind, slug, path, subId })), [
    { kind: "thread", slug: "same", path: undefined, subId: undefined },
    { kind: "doc", slug: "same", path: undefined, subId: undefined },
    { kind: "plan", slug: ".fray/plans/same.md", path: ".fray/plans/same.md", subId: undefined },
    { kind: "subagent", slug: "same", path: undefined, subId: "tool-1" },
  ])
})

test("reopening an already open plan or subagent does not duplicate it", () => {
  resetStore()
  pushPlanDrawer(".fray/plans/a.md", "A")
  pushPlanDrawer(".fray/plans/a.md", "A renamed")
  pushSubAgentDrawer("parent", "tool-1", { label: "child" })
  pushSubAgentDrawer("parent", "tool-1", { label: "child renamed" })

  assert.equal(store.drawers.length, 2)
  assert.equal(store.drawers[0]?.label, "A renamed")
  assert.equal(store.drawers[1]?.label, "child renamed")
})
