import { test } from "node:test"
import assert from "node:assert/strict"
import { deriveSocket, setSocket, socketName } from "./tmux.ts"

test("deriveSocket: per-project socket name from the stable project id", () => {
  // A UUID → fray-<first 8 alnum> (hyphens/non-alnum stripped before the slice).
  assert.equal(deriveSocket("3f2a1b9c-dead-beef-0000-111122223333"), "fray-3f2a1b9c")
  // Non-alnum is stripped, THEN the first 8 taken — so a leading hyphen never eats the id.
  assert.equal(deriveSocket("--ab-cd-ef-gh--"), "fray-abcdefgh")
  // Two distinct ids never collide on the socket name.
  assert.notEqual(deriveSocket("aaaaaaaa-1111"), deriveSocket("bbbbbbbb-2222"))
  // Empty / missing id falls back to the bare "fray" (back-compat, never a "fray-" with empty tail).
  assert.equal(deriveSocket(""), "fray")
  assert.equal(deriveSocket(undefined), "fray")
  assert.equal(deriveSocket(null), "fray")
  // Short ids (< 8 chars) pass through whole.
  assert.equal(deriveSocket("abc"), "fray-abc")
})

test("setSocket/socketName: install the active socket; empty resets to the default", () => {
  const original = socketName()
  try {
    setSocket("fray-deadbeef")
    assert.equal(socketName(), "fray-deadbeef")
    // Empty string coerces back to the bare "fray" (never an invalid empty -L arg).
    setSocket("")
    assert.equal(socketName(), "fray")
  } finally {
    setSocket(original) // restore so socket state can't leak into other tests in this process
  }
})
