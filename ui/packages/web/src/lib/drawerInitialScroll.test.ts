import { test } from "node:test"
import assert from "node:assert/strict"
import { DrawerInitialScrollCoordinator, type DrawerInitialScrollClock } from "./drawerInitialScroll.ts"

class ManualClock implements DrawerInitialScrollClock {
  #next = 0
  #pending = new Map<number, () => void>()

  schedule(run: () => void): number {
    const id = ++this.#next
    this.#pending.set(id, run)
    return id
  }

  cancel(handle: unknown): void {
    this.#pending.delete(handle as number)
  }

  flush(): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const run of pending) run()
  }
}

function harness(opts: { active?: boolean; ready?: boolean; anchor?: boolean } = {}) {
  const clock = new ManualClock()
  let active = opts.active ?? true
  let ready = opts.ready ?? true
  let height = 0
  const scrolls: number[] = []
  const coordinator = new DrawerInitialScrollCoordinator({
    isActive: () => active,
    isContentReady: () => ready,
    scrollToBottom: () => {
      scrolls.push(height)
      return true
    },
    preserveAnchor: () => opts.anchor === true,
    clock,
  })
  return {
    clock,
    coordinator,
    scrolls,
    setActive(value: boolean) { active = value },
    setReady(value: boolean) { ready = value },
    setHeight(value: number) { height = value },
  }
}

test("drawer initial scroll: long ready content lands at the bottom once settling completes", () => {
  const h = harness()
  h.setHeight(12_000)
  h.coordinator.activationChanged()
  h.clock.flush()

  assert.deepEqual(h.scrolls, [12_000, 12_000])
  assert.equal(h.coordinator.phase, "complete")

  h.setHeight(12_500)
  h.coordinator.layoutChanged()
  h.clock.flush()
  assert.deepEqual(h.scrolls, [12_000, 12_000], "later live growth is left to ChatView's near-bottom policy")
})

test("drawer initial scroll: async transcript growth keeps replacing the pending settle", () => {
  const h = harness({ ready: false })
  h.coordinator.activationChanged()
  h.setHeight(600)
  h.coordinator.layoutChanged()
  assert.deepEqual(h.scrolls, [])

  h.setReady(true)
  h.setHeight(6_000)
  h.coordinator.layoutChanged()
  h.setHeight(9_000)
  h.coordinator.layoutChanged()
  h.clock.flush()

  assert.deepEqual(h.scrolls, [6_000, 9_000, 9_000])
  assert.equal(h.coordinator.phase, "complete")
})

test("drawer initial scroll: an already-mounted drawer waits until it becomes the active selection", () => {
  const h = harness({ active: false })
  h.setHeight(8_000)
  h.coordinator.layoutChanged()
  assert.deepEqual(h.scrolls, [])

  h.setActive(true)
  h.coordinator.activationChanged()
  h.clock.flush()
  assert.deepEqual(h.scrolls, [8_000, 8_000])
})

test("drawer initial scroll: only the top drawer settles in a stack", () => {
  const underneath = harness({ active: false })
  const top = harness({ active: true })
  underneath.setHeight(7_000)
  top.setHeight(4_000)

  underneath.coordinator.layoutChanged()
  top.coordinator.activationChanged()
  top.clock.flush()
  assert.deepEqual(underneath.scrolls, [])
  assert.deepEqual(top.scrolls, [4_000, 4_000])

  underneath.setActive(true)
  underneath.coordinator.activationChanged()
  underneath.clock.flush()
  assert.deepEqual(underneath.scrolls, [7_000, 7_000])
})

test("drawer initial scroll: user intent cancels pending and future initial jumps", () => {
  const h = harness()
  h.setHeight(5_000)
  h.coordinator.activationChanged()
  h.coordinator.userIntent()
  h.setHeight(10_000)
  h.coordinator.layoutChanged()
  h.clock.flush()

  assert.deepEqual(h.scrolls, [5_000])
  assert.equal(h.coordinator.phase, "suppressed")
})

test("drawer initial scroll: a direct fragment anchor suppresses tail focus", () => {
  const h = harness({ anchor: true })
  h.setHeight(10_000)
  h.coordinator.activationChanged()
  h.coordinator.layoutChanged()
  h.clock.flush()

  assert.deepEqual(h.scrolls, [])
  assert.equal(h.coordinator.phase, "suppressed")
})
