import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { hasRunningToolIndicator, isRunningOperation, liveBackgroundOperationState, runningOperations } from "../lib/operationIndicators.ts"

test("multiple simultaneous background operations get individual live indicators while terminal states do not", () => {
  const operations = [
    { label: "Inspect logs", state: "running" },
    { label: "Run regression suite", state: "running" },
    { label: "Watch CI", state: "running" },
    { label: "Tail build log", state: "running" },
    { label: "Prior investigation", state: "stale" },
    { label: "Completed build", state: "completed" },
    { label: "Failed build", state: "failed" },
    { label: "Cancelled build", state: "cancelled" },
  ]
  assert.deepEqual(runningOperations(operations).map((operation) => operation.label), ["Inspect logs", "Run regression suite", "Watch CI", "Tail build log"])
  for (const state of ["stale", "completed", "failed", "cancelled", undefined]) assert.equal(isRunningOperation(state), false)
})

test("tool disclosures pulse only while their own call is pending", () => {
  assert.equal(hasRunningToolIndicator("pending", "background"), true)
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(hasRunningToolIndicator(status), false)
  }
  assert.equal(hasRunningToolIndicator("pending", "unknown"), false)
})

test("live background telemetry overrides a completed launch wrapper without borrowing another operation's state", () => {
  const operations = [
    { label: "Watch CI", state: "running" as const },
    { label: "Tail build log", state: "stale" as const },
  ]
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Watch CI" }, operations), "running")
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", detail: "Tail build log" }, operations), "stale")
  assert.equal(liveBackgroundOperationState({ backgroundState: "background", desc: "Unrelated shell" }, operations), undefined)
  assert.equal(liveBackgroundOperationState({ backgroundState: "unknown", desc: "Watch CI" }, operations), undefined)
  assert.equal(liveBackgroundOperationState({ name: "Interrupt process", backgroundState: "background", detail: "session 35985" }, operations), undefined)
})

test("reduced motion keeps live work visible as a static yellow ring", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.fray-live-dot \{ animation: none; background: transparent; border: 2px solid var\(--color-accent\); box-shadow: none; \}/)
})

test("a quiet-but-alive background shell breathes, and stays visible as a static ring under reduced motion", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  // It must ANIMATE (breathe) rather than sit as a dead gray dot…
  assert.match(css, /\.fray-live-dot-quiet \{[^}]*animation: fray-live-breathe/)
  assert.match(css, /@keyframes fray-live-breathe/)
  // …and degrade to a static ring (never fully disappear) when motion is reduced.
  assert.match(css, /\.fray-live-dot-quiet \{ animation: none;[^}]*border: 1\.5px solid/)
})
