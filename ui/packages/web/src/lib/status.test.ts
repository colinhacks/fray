import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { canDismiss } from "./status.ts"

type DismissInput = Pick<ThreadView, "kind" | "foreign" | "runtime">
const t = (over: Partial<DismissInput>): DismissInput => ({ kind: "session", foreign: false, runtime: "exited", ...over })

test("canDismiss: TRUE only for a non-foreign exited/stalled session", () => {
  assert.equal(canDismiss(t({ runtime: "exited" })), true, "an exited (or Stalled) owned session is dismissable")
})

test("canDismiss: FALSE for a live session (running / turn-idle / perm-prompt)", () => {
  assert.equal(canDismiss(t({ runtime: "running" })), false)
  assert.equal(canDismiss(t({ runtime: "turn-idle" })), false)
  assert.equal(canDismiss(t({ runtime: "perm-prompt" })), false)
})

test("canDismiss: FALSE for a foreign session even when exited", () => {
  assert.equal(canDismiss(t({ foreign: true, runtime: "exited" })), false, "foreign sessions are read-only")
})

test("canDismiss: FALSE for a legacy (.fray-file) thread", () => {
  assert.equal(canDismiss(t({ kind: "legacy", runtime: "exited" })), false)
})
