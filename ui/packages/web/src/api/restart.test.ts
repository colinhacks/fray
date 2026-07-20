import assert from "node:assert/strict"
import { test } from "node:test"
import { canRestart, canUpdateRestart, getFraySupervisorStatus, requestFrayRestart, requestFrayUpdateRestart } from "./restart.ts"

const response = (body: string, status = 200, contentType = "application/json") => new Response(body, { status, headers: { "content-type": contentType } })

test("restart controls negotiate an explicit JSON protocol and reject SPA HTML fallbacks", async () => {
  const html = async () => response("<!doctype html><title>Fray</title>", 200, "text/html")
  assert.equal(await getFraySupervisorStatus(html as typeof fetch), null)
  await assert.rejects(requestFrayUpdateRestart(html as typeof fetch), /unavailable/)
})

test("restart controls reject stale protocol, missing routes, and network failures", async () => {
  const stale = async () => response(JSON.stringify({ protocol: 0, state: "ready" }))
  const missing = async () => response("missing", 404, "text/plain")
  const failed = async () => { throw new Error("network down") }
  assert.equal(await getFraySupervisorStatus(stale as typeof fetch), null)
  assert.equal(await getFraySupervisorStatus(missing as typeof fetch), null)
  assert.equal(await getFraySupervisorStatus(failed as typeof fetch), null)
  assert.equal(canRestart(null), false)
  assert.equal(canRestart({ protocol: 1, state: "ready" }), true)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready" }), false)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready", updateRestart: true }), true)
})

test("ordinary restart remains available without the update capability", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready" }), 202)
  }
  await requestFrayRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_fray/control/restart")
  assert.equal(request?.init?.method, "POST")
})

test("update and restart requires an explicit supervisor capability and uses its one endpoint", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready", artifactDigest: "a".repeat(64), updateRestart: true }))
  }
  assert.equal((await getFraySupervisorStatus(supported as typeof fetch))?.artifactDigest, "a".repeat(64))
  assert.equal((await getFraySupervisorStatus(supported as typeof fetch))?.updateRestart, true)
  await requestFrayUpdateRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_fray/control/update-restart")
  assert.equal(request?.init?.method, "POST")

  const failure = async () => response(JSON.stringify({ protocol: 1, state: "failed", message: "candidate rejected" }), 503)
  await assert.rejects(requestFrayUpdateRestart(failure as typeof fetch), /candidate rejected/)
})

test("an accepted update transition is not misreported as a restart failure", async () => {
  const accepted = async () => response(JSON.stringify({ protocol: 1, state: "restarting" }), 202)
  assert.equal((await requestFrayUpdateRestart(accepted as typeof fetch)).state, "restarting")
})
