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

// No drawer components are mounted in this environment, so closeDrawersById's animated path has no
// registered closers and displaced layers are removed synchronously — the policy's end state is
// directly observable.
function shape() {
  return store.drawers.map(({ kind, slug, subId }) => ({ kind, slug, subId }))
}

test("a lateral thread open replaces the previous drawer (one drawer at a time)", () => {
  resetStore()
  pushDrawer("thread", "one")
  pushDrawer("thread", "two")
  assert.deepEqual(shape(), [{ kind: "thread", slug: "two", subId: undefined }])
})

test("a sub-agent stacks over its open parent; a sibling sub-agent swaps in place", () => {
  resetStore()
  pushDrawer("thread", "parent")
  pushSubAgentDrawer("parent", "tool-a", { label: "child a" })
  assert.deepEqual(shape(), [
    { kind: "thread", slug: "parent", subId: undefined },
    { kind: "subagent", slug: "parent", subId: "tool-a" },
  ])

  pushSubAgentDrawer("parent", "tool-b", { label: "child b" })
  assert.deepEqual(shape(), [
    { kind: "thread", slug: "parent", subId: undefined },
    { kind: "subagent", slug: "parent", subId: "tool-b" },
  ])
})

test("a sub-agent opened without its parent on the stack replaces everything", () => {
  resetStore()
  pushDrawer("thread", "other")
  pushSubAgentDrawer("parent", "tool-a", { label: "child a" })
  assert.deepEqual(shape(), [{ kind: "subagent", slug: "parent", subId: "tool-a" }])

  // Sibling sub-agents with no parent layer swap too — the reported bug: they used to pile up.
  pushSubAgentDrawer("parent", "tool-b", { label: "child b" })
  assert.deepEqual(shape(), [{ kind: "subagent", slug: "parent", subId: "tool-b" }])
})

test("a thread's own doc and sub-agent stack as one family; a plan replaces it all", () => {
  resetStore()
  pushDrawer("thread", "same")
  pushDrawer("doc", "same")
  pushSubAgentDrawer("same", "tool-1", { label: "child" })
  assert.deepEqual(shape(), [
    { kind: "thread", slug: "same", subId: undefined },
    { kind: "doc", slug: "same", subId: undefined },
    { kind: "subagent", slug: "same", subId: "tool-1" },
  ])

  pushPlanDrawer(".fray/plans/same.md", "Plan")
  assert.deepEqual(shape(), [{ kind: "plan", slug: ".fray/plans/same.md", subId: undefined }])
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

test("reopening an already open plan or sub-agent reuses its entry", () => {
  resetStore()
  pushPlanDrawer(".fray/plans/a.md", "A")
  pushPlanDrawer(".fray/plans/a.md", "A renamed")
  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.label, "A renamed")

  resetStore()
  pushDrawer("thread", "parent")
  pushSubAgentDrawer("parent", "tool-1", { label: "child" })
  pushSubAgentDrawer("parent", "tool-1", { label: "child renamed" })
  assert.equal(store.drawers.length, 2)
  assert.equal(store.drawers[1]?.label, "child renamed")
})

test("re-clicking the open parent thread closes the child stacked over it", () => {
  resetStore()
  pushDrawer("thread", "parent")
  const parentId = store.drawers[0]?.id
  pushSubAgentDrawer("parent", "tool-a", { label: "child a" })
  pushDrawer("thread", "parent")
  assert.deepEqual(shape(), [{ kind: "thread", slug: "parent", subId: undefined }])
  assert.equal(store.drawers[0]?.id, parentId)
})
