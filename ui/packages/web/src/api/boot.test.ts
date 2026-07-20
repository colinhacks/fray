import { test } from "node:test"
import assert from "node:assert/strict"
import { noteServerBootId } from "./boot.ts"

test("a changed board-server boot id is adopted without document navigation", () => {
  const originalStorage = globalThis.sessionStorage
  const originalLocation = globalThis.location
  const values = new Map<string, string>()
  let reloads = 0

  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { reload: () => { reloads++ } },
  })

  try {
    noteServerBootId("before-queue-update")
    noteServerBootId("after-queue-update")

    assert.equal(values.get("fray-boot-id"), "after-queue-update")
    assert.equal(reloads, 0, "a transport/keyframe transition must not discard an unsent composer draft")
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalStorage })
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
  }
})
