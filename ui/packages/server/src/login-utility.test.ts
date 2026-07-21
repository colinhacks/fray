import { test } from "node:test"
import assert from "node:assert/strict"
import { ThreadSlug, tmuxSessionName } from "@fray-ui/shared"
import { createLoginUtility } from "./login-utility.ts"
import type { AdoptionPaneLookup, PaneIdentity } from "./tmux.ts"

function harness(over: { paneDead?: boolean; paneLookup?: AdoptionPaneLookup } = {}) {
  const spawned: { slug: string; cmd: string[]; cwd: string }[] = []
  const killed: string[] = []
  const live = new Set<string>()
  const utility = createLoginUtility({
    claudeBin: "/stub/claude",
    cwd: "/project",
    lifetimeMs: 60_000,
    spawn: (slug, cmd, cwd) => {
      spawned.push({ slug, cmd, cwd })
      live.add(slug)
      return { paneId: "%1", panePid: 1, sessionCreated: 1 } satisfies PaneIdentity
    },
    ensureServer: () => {},
    killSession: (slug) => {
      killed.push(slug)
      live.delete(slug)
    },
    hasSession: (slug) => live.has(slug),
    lookupPane: () =>
      over.paneLookup ?? { kind: "found", pane: { paneId: "%1", panePid: 1, sessionCreated: 1, dead: over.paneDead ?? false, adoptionAttemptToken: null } },
  })
  return { utility, spawned, killed, live }
}

test("start spawns exactly the provider login argv, no shell, addressed by a slug-shaped opaque id", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  assert.match(attemptId, /^login-[0-9a-f]{16}$/)
  assert.equal(ThreadSlug.safeParse(attemptId).success, true, "the id must ride the /term slug transport")
  assert.equal(h.spawned.length, 1)
  assert.deepEqual(h.spawned[0].cmd, ["/stub/claude", "auth", "login"])
  assert.equal(h.spawned[0].cwd, "/project")
})

test("one live attempt per provider: a second start reuses the live session", () => {
  const h = harness()
  const first = h.utility.start("claude")
  const second = h.utility.start("claude")
  assert.equal(second.attemptId, first.attemptId)
  assert.equal(h.spawned.length, 1)
})

test("a vanished session is replaced rather than reused", () => {
  const h = harness()
  const first = h.utility.start("claude")
  h.live.delete(first.attemptId) // killed externally
  const second = h.utility.start("claude")
  assert.notEqual(second.attemptId, first.attemptId)
  assert.equal(h.spawned.length, 2)
})

test("attachArgs gates on a live attempt and targets its exact tmux session", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  assert.deepEqual(h.utility.attachArgs(attemptId), ["attach-session", "-t", tmuxSessionName(attemptId)])
  assert.equal(h.utility.attachArgs("login-0000000000000000"), null, "an unknown id never attaches")
  assert.equal(h.utility.attachArgs("some-thread"), null)
})

test("status: live pane → running; dead pane (CLI finished) → exited; unknown lookup → unknown", () => {
  const running = harness({ paneDead: false })
  const a = running.utility.start("claude")
  assert.deepEqual(running.utility.status(a.attemptId), { state: "running", backend: "claude" })

  const done = harness({ paneDead: true })
  const b = done.utility.start("claude")
  assert.deepEqual(done.utility.status(b.attemptId), { state: "exited", backend: "claude" })

  const opaque = harness({ paneLookup: { kind: "unknown" } })
  const c = opaque.utility.start("claude")
  assert.deepEqual(opaque.utility.status(c.attemptId), { state: "unknown", backend: "claude" })

  assert.deepEqual(running.utility.status("login-ffffffffffffffff"), { state: "exited" })
})

test("cancel and stop tear the tmux session down; teardown is idempotent", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  h.utility.cancel(attemptId)
  assert.deepEqual(h.killed, [attemptId])
  h.utility.cancel(attemptId)
  assert.deepEqual(h.killed, [attemptId], "second cancel is a no-op")
  const again = h.utility.start("claude")
  h.utility.stop()
  assert.ok(h.killed.includes(again.attemptId))
})
