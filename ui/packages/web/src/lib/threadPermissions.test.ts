import { test } from "node:test"
import assert from "node:assert/strict"
import { canRecoverExistingCodexDraft, threadFollowUpBlocked, threadPermissionBlockedReason, threadPermissionEffectMessage } from "./threadPermissions.ts"

const state = (over: Partial<Parameters<typeof threadPermissionBlockedReason>[0]> = {}) => ({ ...over })

test("thread permission control: only idle or exited owned threads are editable", () => {
  assert.equal(threadPermissionBlockedReason(state({ runtime: "turn-idle" })), null)
  assert.equal(threadPermissionBlockedReason(state({ runtime: "exited" })), null)
  assert.match(threadPermissionBlockedReason(state({ runtime: "running" }))!, /current turn/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", permissionPending: "bypassPermissions" }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", permissionChangePending: true }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", profileChangePending: true }))!, /model and effort change/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", runtimeControlPending: true }))!, /runtime control/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", runtimeControlPending: true, followUpQueueAvailable: true }))!, /runtime control/, "the queue capability unlocks only sending, never profile or permission controls")
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", subAgents: [{ state: "running" }] }))!, /background operation/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", bgShells: [{ state: "stale" }] }))!, /unresolved background operation/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "perm-prompt" }))!, /terminal approval or question/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", nativeInputRequired: { kind: "question" } }))!, /terminal approval or question/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", queuedInputCount: 1 }))!, /queued Codex input/)
})

test("thread permission control: foreign threads remain read-only", () => {
  assert.match(threadPermissionBlockedReason(state({ foreign: true }))!, /Read-only/)
})

test("a Codex queue owner keeps only follow-up submission available", () => {
  assert.equal(threadFollowUpBlocked(state({ runtimeControlPending: true })), true)
  assert.equal(threadFollowUpBlocked(state({ runtimeControlPending: true, followUpQueueAvailable: true })), false)
  assert.equal(threadFollowUpBlocked(state({ runtimeControlPending: true, followUpQueueAvailable: true, permissionPending: "default" })), true)
  assert.equal(threadFollowUpBlocked(state({ runtimeControlPending: true, followUpQueueAvailable: true, profileChangePending: true })), true)
})

test("thread permission control: feedback distinguishes a live apply from next resume", () => {
  assert.equal(threadPermissionEffectMessage("applied", "codex"), "Sandbox applied to the live session")
  assert.equal(threadPermissionEffectMessage("next-resume", "codex"), "Sandbox saved for the next resume")
})

test("draft recovery affordance appears only for the verified existing-composer condition", () => {
  assert.equal(canRecoverExistingCodexDraft("Queued message blocked: submit or clear the existing Codex terminal draft"), true)
  assert.equal(canRecoverExistingCodexDraft("Permission change blocked by the current Codex modal"), false)
  assert.equal(canRecoverExistingCodexDraft(undefined), false)
})
