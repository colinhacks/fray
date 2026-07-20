import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { resolveThreadRoute } from "./threadRouteState.ts"

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "owned",
    title: "Owned",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    kind: "session",
    foreign: false,
    ...over,
  }
}

function board(threads: ThreadView[]): BoardSnapshot {
  return { threads } as BoardSnapshot
}

test("resolveThreadRoute distinguishes hydration from an authoritative missing slug", () => {
  assert.deepEqual(resolveThreadRoute(null, "owned"), { kind: "loading" })
  assert.deepEqual(resolveThreadRoute(board([]), "owned"), { kind: "missing" })
})

test("resolveThreadRoute preserves owned, foreign, and legacy ownership", () => {
  assert.equal(resolveThreadRoute(board([thread()]), "owned").kind, "found")
  assert.deepEqual(resolveThreadRoute(board([thread({ id: "foreign", foreign: true })]), "foreign"), {
    kind: "found",
    ownership: "foreign",
    thread: thread({ id: "foreign", foreign: true }),
  })
  assert.deepEqual(resolveThreadRoute(board([thread({ id: "legacy", kind: "legacy" })]), "legacy"), {
    kind: "found",
    ownership: "legacy",
    thread: thread({ id: "legacy", kind: "legacy" }),
  })
})
