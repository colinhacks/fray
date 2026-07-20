import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireProjectLaunchOwner, type ProjectLaunchTarget } from "./project-launch.ts"
import {
  deriveLegacySocket,
  deriveSocket,
  deriveWorktreeSocket,
  parseTmuxSocketInspection,
  readTmuxSocketMigration,
  resolveProjectTmuxSocket,
  resolveProjectTmuxSocketSelection,
  tmuxProjectRootHash,
  tmuxSocketMigrationPath,
  type TmuxSocketObservation,
  type TmuxSocketRuntime,
} from "./tmux-socket.ts"

const PROJECT_ID = "12345678-1234-4234-8234-123456789abc"
const OTHER_ID = "12345678-9999-4999-8999-999999999999"

interface Harness {
  base: string
  target: ProjectLaunchTarget
  legacySocket: string
  fullSocket: string
  calls: Array<{ kind: "inspect" | "label"; socket: string }>
  labels: Array<{
    socket: string
    anchor: { paneId: string; panePid: number; sessionCreated: number }
    marker: { projectId: string; projectRootHash: string }
  }>
  runtime: TmuxSocketRuntime
  set(socket: string, ...observations: TmuxSocketObservation[]): void
  setLabelResult(value: boolean): void
  present(options?: {
    projectId?: string | null
    projectRootHash?: string | null
    currentPath?: string
    sessionName?: string
    extra?: Array<{ currentPath: string; sessionName?: string }>
  }): Extract<TmuxSocketObservation, { kind: "present" }>
  cleanup(): void
}

function harness(): Harness {
  const base = mkdtempSync(join(tmpdir(), "fray tmux migration "))
  const projectDir = join(base, "repo")
  const stateDir = join(base, "home", ".fray", "projects", PROJECT_ID)
  mkdirSync(projectDir, { recursive: true })
  const target: ProjectLaunchTarget = { projectId: PROJECT_ID, projectDir: realpathSync(projectDir), stateDir }
  const sequences = new Map<string, TmuxSocketObservation[]>()
  const calls: Harness["calls"] = []
  const labels: Harness["labels"] = []
  let labelResult = true
  const runtime: TmuxSocketRuntime = {
    inspect(socket) {
      calls.push({ kind: "inspect", socket })
      const sequence = sequences.get(socket)
      if (!sequence || sequence.length === 0) return { kind: "absent" }
      return sequence.length === 1 ? sequence[0]! : sequence.shift()!
    },
    label(socket, anchor, marker) {
      calls.push({ kind: "label", socket })
      labels.push({
        socket,
        anchor: {
          paneId: anchor.paneId,
          panePid: anchor.panePid,
          sessionCreated: anchor.sessionCreated,
        },
        marker,
      })
      return labelResult
    },
  }
  const h: Harness = {
    base,
    target,
    legacySocket: deriveLegacySocket(PROJECT_ID),
    fullSocket: deriveSocket(PROJECT_ID),
    calls,
    labels,
    runtime,
    set(socket, ...observations) {
      sequences.set(socket, observations)
    },
    setLabelResult(value) {
      labelResult = value
    },
    present(options = {}) {
      const rootHash = tmuxProjectRootHash(target.projectDir)
      const panes = [{
        sessionName: options.sessionName ?? "fray-owned-thread",
        paneId: "%1",
        panePid: 10_001,
        sessionCreated: 1_700_000_001,
        dead: false,
        currentPath: options.currentPath ?? target.projectDir,
      }]
      for (const [index, extra] of (options.extra ?? []).entries()) {
        panes.push({
          sessionName: extra.sessionName ?? `fray-owned-extra-${index}`,
          paneId: `%${index + 2}`,
          panePid: 10_002 + index,
          sessionCreated: 1_700_000_002 + index,
          dead: false,
          currentPath: extra.currentPath,
        })
      }
      return {
        kind: "present",
        projectId: options.projectId === undefined ? PROJECT_ID : options.projectId,
        projectRootHash: options.projectRootHash === undefined ? rootHash : options.projectRootHash,
        panes,
      }
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    },
  }
  return h
}

function migration(h: Harness) {
  const value = readTmuxSocketMigration(h.target.stateDir)
  assert.ok(value)
  return value
}

test("new ordinary repositories persist the complete UUID socket without inspecting a colliding legacy server", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.set(h.fullSocket, { kind: "absent" })

  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.fullSocket)
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.fullSocket }])
  assert.deepEqual(migration(h), {
    version: 1,
    projectId: PROJECT_ID,
    projectDir: h.target.projectDir,
    legacySocket: h.legacySocket,
    fullSocket: h.fullSocket,
    selectedSocket: h.fullSocket,
    phase: "full",
    updatedAt: migration(h).updatedAt,
  })
  assert.equal(statSync(tmuxSocketMigrationPath(h.target.stateDir)).mode & 0o777, 0o600)
})

test("an exact-marked full socket accepts a dead pane with tmux's empty current path", () => {
  const rootHash = tmuxProjectRootHash("/repo")
  assert.deepEqual(
    parseTmuxSocketInspection(
      `fray-phase1-dogfood\t%1\t123\t1700000000\t1\t\t${PROJECT_ID}\t${rootHash}\n`,
    ),
    {
      kind: "present",
      projectId: PROJECT_ID,
      projectRootHash: rootHash,
      panes: [{
        sessionName: "fray-phase1-dogfood",
        paneId: "%1",
        panePid: 123,
        sessionCreated: 1_700_000_000,
        dead: true,
        currentPath: "",
      }],
    },
  )
})

test("a new repository fails closed when its complete socket is already markerless or foreign", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.set(h.fullSocket, h.present({ projectId: null, projectRootHash: null }))

  assert.throws(
    () => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }),
    new RegExp(`derived full project tmux socket ${h.fullSocket} has unknown or foreign ownership; no sessions were contacted or mutated\\. This can indicate duplicate or corrupt fray\\.id values, or a canonical-root collision\\.`),
  )
  assert.equal(readTmuxSocketMigration(h.target.stateDir), null)
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.fullSocket }])
})

test("an old repository retains an exactly marked legacy server without relabeling or touching full", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  h.set(h.legacySocket, h.present())

  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.legacySocket)
  assert.equal(migration(h).phase, "legacy")
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.legacySocket }])
})

test("an attributable markerless legacy server is claimed against an exact pane and reverified", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(join(h.target.projectDir, "nested"), { recursive: true })
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  h.set(
    h.legacySocket,
    h.present({ projectId: null, projectRootHash: null, currentPath: join(h.target.projectDir, "nested") }),
    h.present({ currentPath: join(h.target.projectDir, "nested") }),
  )

  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.legacySocket)
  assert.equal(migration(h).phase, "legacy")
  assert.deepEqual(h.calls, [
    { kind: "inspect", socket: h.legacySocket },
    { kind: "label", socket: h.legacySocket },
    { kind: "inspect", socket: h.legacySocket },
  ])
  assert.deepEqual(h.labels, [{
    socket: h.legacySocket,
    anchor: { paneId: "%1", panePid: 10_001, sessionCreated: 1_700_000_001 },
    marker: { projectId: PROJECT_ID, projectRootHash: tmuxProjectRootHash(h.target.projectDir) },
  }])
})

test("markerless legacy attribution rejects foreign paths and non-Fray sessions without writing or labeling", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  h.set(h.legacySocket, h.present({
    projectId: null,
    projectRootHash: null,
    extra: [{ currentPath: join(h.base, "foreign") }],
  }))

  assert.throws(
    () => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }),
    /shared, foreign, or unverified/,
  )
  assert.equal(readTmuxSocketMigration(h.target.stateDir), null)
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.legacySocket }])

  h.calls.length = 0
  h.set(h.legacySocket, h.present({
    projectId: null,
    projectRootHash: null,
    sessionName: "operator-shell",
  }))
  assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), /unverified/)
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.legacySocket }])
})

test("legacy claiming fails closed on label failure and on a pane-set race during confirmation", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  const markerless = h.present({ projectId: null, projectRootHash: null })

  h.setLabelResult(false)
  h.set(h.legacySocket, markerless)
  assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), /atomically claim/)
  assert.equal(migration(h).phase, "claiming")

  h.calls.length = 0
  h.setLabelResult(true)
  h.set(
    h.legacySocket,
    markerless,
    h.present({ extra: [{ currentPath: join(h.base, "foreign-after-inspection") }] }),
  )
  assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), /confirm legacy tmux ownership/)
  assert.equal(migration(h).phase, "claiming")
  assert.deepEqual(h.calls, [
    { kind: "inspect", socket: h.legacySocket },
    { kind: "label", socket: h.legacySocket },
    { kind: "inspect", socket: h.legacySocket },
  ])

  h.calls.length = 0
  h.set(h.legacySocket, h.present({
    extra: [{ currentPath: join(h.base, "persistently-foreign") }],
  }))
  assert.throws(
    () => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }),
    /interrupted legacy tmux ownership claim remains unverified/,
  )
  assert.equal(migration(h).phase, "claiming")
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.legacySocket }])

  h.calls.length = 0
  h.set(h.legacySocket, h.present())
  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.legacySocket)
  assert.equal(migration(h).phase, "legacy")
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.legacySocket }])
})

test("unknown, partial, and foreign legacy observations never advance migration", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  const cases: Array<[TmuxSocketObservation, RegExp]> = [
    [{ kind: "unknown" }, /could not verify/],
    [h.present({ projectId: PROJECT_ID, projectRootHash: null }), /shared, foreign, or unverified/],
    [h.present({ projectId: OTHER_ID }), /shared, foreign, or unverified/],
  ]
  for (const [observation, message] of cases) {
    h.calls.length = 0
    h.set(h.legacySocket, observation)
    assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), message)
    assert.equal(readTmuxSocketMigration(h.target.stateDir), null)
    assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.legacySocket }])
  }
})

test("a durable legacy phase advances once to full only after legacy disappears and full is verified", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  h.set(h.legacySocket, h.present())
  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.legacySocket)

  h.calls.length = 0
  h.set(h.legacySocket, { kind: "absent" })
  h.set(h.fullSocket, { kind: "absent" })
  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.fullSocket)
  assert.equal(migration(h).phase, "full")
  assert.deepEqual(h.calls, [
    { kind: "inspect", socket: h.legacySocket },
    { kind: "inspect", socket: h.fullSocket },
  ])

  h.calls.length = 0
  h.set(h.legacySocket, h.present({ projectId: OTHER_ID }))
  h.set(h.fullSocket, h.present())
  assert.equal(resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), h.fullSocket)
  assert.deepEqual(h.calls, [{ kind: "inspect", socket: h.fullSocket }])
})

test("a disappearing legacy server cannot advance onto a foreign full server", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(join(h.target.stateDir, "ui.db"), "historical")
  h.set(h.legacySocket, { kind: "absent" })
  h.set(h.fullSocket, h.present({ projectId: OTHER_ID }))

  assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), /unknown or foreign ownership/)
  assert.equal(readTmuxSocketMigration(h.target.stateDir), null)
  assert.deepEqual(h.calls, [
    { kind: "inspect", socket: h.legacySocket },
    { kind: "inspect", socket: h.fullSocket },
  ])
})

test("invalid and mismatched durable records fail before any tmux runtime call", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(tmuxSocketMigrationPath(h.target.stateDir), "not json\n")
  assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), /record is invalid/)
  assert.deepEqual(h.calls, [])

  writeFileSync(tmuxSocketMigrationPath(h.target.stateDir), `${JSON.stringify({
    version: 1,
    projectId: OTHER_ID,
    projectDir: h.target.projectDir,
    legacySocket: h.legacySocket,
    fullSocket: h.fullSocket,
    selectedSocket: h.fullSocket,
    phase: "full",
    updatedAt: new Date().toISOString(),
  })}\n`)
  assert.throws(() => resolveProjectTmuxSocket(h.target, { runtime: h.runtime }), /does not match this project/)
  assert.deepEqual(h.calls, [])
})

test("explicit overrides are verbatim unmanaged escape hatches for repository and linked-worktree targets", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(tmuxSocketMigrationPath(h.target.stateDir), "intentionally invalid\n")
  h.set("fray", h.present({ projectId: OTHER_ID }))

  assert.deepEqual(
    resolveProjectTmuxSocketSelection(h.target, { repositoryOverride: "fray", runtime: h.runtime }),
    { socket: "fray", managed: false },
  )
  assert.deepEqual(
    resolveProjectTmuxSocketSelection(
      { ...h.target, identityScope: "worktree" },
      { repositoryOverride: "custom.operator.socket", runtime: h.runtime },
    ),
    { socket: "custom.operator.socket", managed: false },
  )
  assert.deepEqual(h.calls, [])
  assert.throws(
    () => resolveProjectTmuxSocket(h.target, { repositoryOverride: "", runtime: h.runtime }),
    /invalid FRAY_TMUX_SOCKET/,
  )
  assert.deepEqual(h.calls, [])
})

test("a managed linked worktree remains isolated without consulting ordinary-repository migration state", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(tmuxSocketMigrationPath(h.target.stateDir), "irrelevant to linked worktree\n")

  assert.deepEqual(
    resolveProjectTmuxSocketSelection(
      { ...h.target, identityScope: "worktree" },
      { runtime: h.runtime },
    ),
    { socket: deriveWorktreeSocket(PROJECT_ID), managed: true },
  )
  assert.deepEqual(h.calls, [])
})

test("a live launch owner keeps its pinned legacy choice until shutdown", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const ownerTarget = { ...h.target, tmuxSocket: h.legacySocket, tmuxSocketManaged: true }
  const lease = acquireProjectLaunchOwner(ownerTarget, "launcher")
  t.after(() => lease.release())
  h.set(h.legacySocket, h.present({ projectId: OTHER_ID }))

  assert.deepEqual(
    resolveProjectTmuxSocketSelection(h.target, { runtime: h.runtime }),
    { socket: h.legacySocket, managed: true },
  )
  assert.deepEqual(h.calls, [])
})

test("migration records are newline-terminated single JSON documents", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.set(h.fullSocket, { kind: "absent" })
  resolveProjectTmuxSocket(h.target, { runtime: h.runtime })

  const raw = readFileSync(tmuxSocketMigrationPath(h.target.stateDir), "utf8")
  assert.equal(raw.endsWith("\n"), true)
  assert.equal(raw.trim().includes("\n"), false)
  assert.doesNotThrow(() => JSON.parse(raw))
})
