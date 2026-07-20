import assert from "node:assert/strict"
import test from "node:test"
import { nextSidebarPresence } from "./lib/sidebarPresence.ts"

function board(projectDir: string, options: { owned?: boolean; plans?: number } = {}) {
  return {
    projectDir,
    threads: options.owned === false ? [{ foreign: true }] : options.owned === true ? [{ foreign: false }] : [],
    plans: Array.from({ length: options.plans ?? 0 }, () => ({})),
  }
}

test("desktop sidebar persists through empty live keyframes, drawer lifecycle, routes, reconnects, and viewport changes", () => {
  let presence = { projectDir: null, hasBeenVisible: false }

  // First populated keyframe mounts the rail. The remaining transitions intentionally do not alter
  // the board's project identity, so none may unmount it merely because a snapshot is temporarily empty.
  presence = nextSidebarPresence(presence, board("/work/fray", { owned: true }))
  assert.deepEqual(presence, { projectDir: "/work/fray", hasBeenVisible: true })
  for (const transition of ["board delta", "drawer open", "drawer close/reopen", "route change", "reconnect", "desktop/mobile media change"]) {
    presence = nextSidebarPresence(presence, board("/work/fray"))
    assert.equal(presence.hasBeenVisible, true, transition)
  }
})

test("a different project still receives the intentional fresh-workspace shell", () => {
  const populated = nextSidebarPresence({ projectDir: null, hasBeenVisible: false }, board("/work/old", { plans: 1 }))
  const fresh = nextSidebarPresence(populated, board("/work/new"))

  assert.deepEqual(fresh, { projectDir: "/work/new", hasBeenVisible: false })
})
