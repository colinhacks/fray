import { test } from "node:test"
import assert from "node:assert/strict"
import { beginEagerSubmission } from "./eagerComposerSubmission.ts"

test("eager composer submission clears and paints before its request settles", async () => {
  const order: string[] = []
  let resolve!: () => void
  const request = new Promise<void>((done) => { resolve = done })
  beginEagerSubmission({
    optimistic: () => order.push("cleared-and-queued"),
    request: () => { order.push("request-started"); return request },
    success: () => order.push("success"),
    failure: () => order.push("failure"),
  })
  assert.deepEqual(order, ["cleared-and-queued", "request-started"])
  resolve()
  await request
  await Promise.resolve()
  assert.deepEqual(order, ["cleared-and-queued", "request-started", "success"])
})

test("eager composer submission rolls back after a rejected request", async () => {
  const order: string[] = []
  beginEagerSubmission({
    optimistic: () => order.push("cleared-and-queued"),
    request: async () => { throw new Error("offline") },
    failure: (error) => order.push(`rolled-back:${error.message}`),
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(order, ["cleared-and-queued", "rolled-back:offline"])
})
