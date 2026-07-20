import { test } from "node:test"
import assert from "node:assert/strict"
import { assertMutationAllowedDuringControlPlaneTransition, CONTROL_PLANE_RESTARTING_MESSAGE, parseRpcResponse } from "./rpc.ts"
import { store } from "../store.ts"

test("RPC response: a stale server's plain-text missing route asks for a server restart", async () => {
  await assert.rejects(
    parseRpcResponse(new Response("404 Not Found", { status: 404 }), "setThreadPermission"),
    /Fray server restart required/,
  )
})

test("RPC transition guard holds writes locally while preserving query access", () => {
  const previous = store.controlPlaneState
  try {
    store.controlPlaneState = "restarting"
    assert.throws(
      () => assertMutationAllowedDuringControlPlaneTransition("mutation"),
      new RegExp(CONTROL_PLANE_RESTARTING_MESSAGE),
    )
    assert.doesNotThrow(() => assertMutationAllowedDuringControlPlaneTransition("query"))
  } finally {
    store.controlPlaneState = previous
  }
})

test("RPC response: valid server errors and successful envelopes keep their normal semantics", async () => {
  await assert.rejects(
    parseRpcResponse(new Response(JSON.stringify({ error: "specific failure" }), { status: 500 }), "x"),
    /specific failure/,
  )
  assert.deepEqual(
    await parseRpcResponse(new Response(JSON.stringify({ result: { effect: "next-resume" } }), { status: 200 }), "x"),
    { effect: "next-resume" },
  )
})
