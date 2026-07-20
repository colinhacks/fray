import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { threadLifecycleAvailability } from "./threadLifecycle.ts"

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "owned-thread",
    title: "Owned thread",
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
    pendingQuestion: false,
    kind: "session",
    foreign: false,
    state: "open",
    needsYou: true,
    crashed: false,
    actionableInteraction: false,
    ...over,
  }
}

test("thread lifecycle controls have one footer home independent of queue/done presentation", () => {
  assert.deepEqual(threadLifecycleAvailability(thread()), {
    footer: true,
    snooze: true,
    archive: true,
  })
  assert.deepEqual(threadLifecycleAvailability(thread({ lastFence: { kind: "done", body: "Shipped", hints: [] } })), {
    footer: true,
    snooze: true,
    archive: true,
  }, "a done fence cannot move Archive inline or into a header")
  // An archived thread has no lifecycle controls at all — reopening is done by sending it another
  // message, not a Reopen button — so the footer does not render.
  assert.deepEqual(threadLifecycleAvailability(thread({ state: "archived", archived: true })), {
    footer: false,
    snooze: false,
    archive: false,
  })
  assert.equal(threadLifecycleAvailability(thread({ state: undefined, archived: true })).footer, false, "rolling snapshots still suppress the footer once archived")
  assert.equal(threadLifecycleAvailability(thread({ foreign: true })).footer, false)
  assert.equal(threadLifecycleAvailability(thread({ kind: "legacy" })).footer, false)
})

test("every owned open queue reason retains enabled lifecycle actions in the footer", () => {
  for (const state of [
    thread({ pendingQuestion: true }),
    thread({ pendingAsk: { questions: [] } }),
    thread({ nativeInputRequired: { kind: "tool-approval", title: "Approval required" } }),
    thread({ runtime: "perm-prompt" }),
    thread({ actionableInteraction: true }),
    thread({ crashed: true, runtime: "exited" }),
  ]) {
    assert.deepEqual(threadLifecycleAvailability(state), {
      footer: true,
      snooze: true,
      archive: true,
    })
  }
})
