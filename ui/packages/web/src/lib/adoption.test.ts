import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { canAdoptThread } from "./adoption.ts"

function legacy(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "legacy-thread",
    title: "Legacy thread",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "none",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    pendingQuestion: false,
    kind: "legacy",
    ...over,
  }
}

test("legacy adoption affordance mirrors the server's conservative eligibility contract", () => {
  for (const status of ["planning", "planned", "active", "needs-human", "blocked"] as const) {
    assert.equal(canAdoptThread(legacy({ status })), true, status)
  }
  assert.equal(canAdoptThread(undefined), false)
  assert.equal(canAdoptThread(legacy({ kind: "session" })), false)
  assert.equal(canAdoptThread(legacy({ kind: undefined })), false)
  assert.equal(canAdoptThread(legacy({ foreign: true })), false)
  assert.equal(canAdoptThread(legacy({ runtime: "exited" })), false)
  assert.equal(canAdoptThread(legacy({ sessionId: "owner" })), false)
  assert.equal(canAdoptThread(legacy({ tmuxName: "fray-legacy-thread" })), false)
  assert.equal(canAdoptThread(legacy({ owner: "external-owner" })), false)
  assert.equal(canAdoptThread(legacy({ agents: [{ id: "agent" }] })), false)
  assert.equal(canAdoptThread(legacy({ errors: ["invalid"] })), false)
  assert.equal(canAdoptThread(legacy({ status: "done" })), false)
  assert.equal(canAdoptThread(legacy({ status: "dismissed" })), false)
})
