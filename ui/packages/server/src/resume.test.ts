import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type ProfileHandoffJournal, type Storage, type SessionRow } from "./storage.ts"
import { createBoard, type BoardManager } from "./board.ts"
import { Bus } from "./bus.ts"
import {
  hasUnconfirmedCodexSubmission,
  reattachThreadWithPermission,
  recoverThreadProfileHandoff,
  resumeThread,
  type ResumeTmux,
} from "./resume.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import type { AgentBackend } from "./backend/types.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import type { Settings, ThreadView, BoardSnapshot } from "@fray-ui/shared"
import type { PaneSnapshot } from "./tmux.ts"

// bump-unarchives: BUMPING (followUp/resume) an ARCHIVED thread must UN-ARCHIVE it so it moves from the
// sidebar's Inactive section back to Active. The move is server-driven: resumeThread flips the row's
// `state` back to "open" (clearing the legacy `archived` flag) and refreshes the board; the SSE delta
// re-sections it because the client's sectionOf keys purely on `state`. These tests pin that the SERVER
// side (state flip + board re-emit) fires on both the live-inject and the dead-resume path.

// A local mirror of packages/web/src/groups.ts sectionOf's ONE rule (kept in-package so the server test
// stays hermetic): a session thread is Inactive iff its state is "archived", else Active.
function sectionOf(t: ThreadView): "active" | "inactive" | null {
  if (t.kind !== "session") return null
  return t.state === "archived" ? "inactive" : "active"
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakeProject(dir: string): Project {
  return { dir, id: "test-id", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
}

// A Tailer stub with no telemetry (get → undefined, no foreign ids): the board derives runtime from tmux
// alone, which is fine here — sectioning keys on `state`, not runtime.
const noopTailer: Tailer = {
  get: () => undefined,
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

const settings = { permissionMode: "auto" } as unknown as Settings

function profileHandoff(
  nativeSessionId: string,
  previous: { model: string; effort: string },
  requested: { model: string; effort: string },
): ProfileHandoffJournal {
  return {
    version: 1,
    phase: "armed",
    nativeSessionId,
    previous: {
      ...previous,
      binding: { kind: "standalone", paneId: "%1", panePid: 101, sessionCreated: 1_750_000_000 },
    },
    requested,
  }
}

const PRIOR_PANE = { paneId: "%11", panePid: 111, sessionCreated: 1_750_000_011 }
const TARGET_PANE = { paneId: "%12", panePid: 112, sessionCreated: 1_750_000_012 }
const ROLLBACK_PANE = { paneId: "%13", panePid: 113, sessionCreated: 1_750_000_013 }

function armRecovery(
  storage: Storage,
  slug: string,
  phase: "armed" | "target-spawned" | "target-ready",
): { journal: ProfileHandoffJournal; targetToken?: string } {
  const requested = { model: "sonnet", effort: "max" }
  let journal: ProfileHandoffJournal = {
    version: 1,
    phase: "armed",
    nativeSessionId: `sid-${slug}`,
    previous: { model: "opus", effort: "high", binding: { kind: "standalone", ...PRIOR_PANE } },
    requested,
  }
  const owned = storage.armProfileChange(slug, {
    sessionId: `sid-${slug}`,
    nativeSessionId: null,
    generation: 0,
  }, requested, journal)
  assert.ok(owned)
  if (phase === "armed") return { journal }

  const generation = storage.beginRuntimeGeneration(slug, {
    sessionId: `sid-${slug}`,
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-01T00:01:00.000Z")
  assert.equal(generation, 1)
  const targetToken = randomUUID()
  journal = {
    ...journal,
    phase,
    target: {
      generation: 1,
      handoffToken: targetToken,
      binding: { kind: "standalone", ...TARGET_PANE, handoffToken: targetToken },
    },
  }
  const serialized = storage.checkpointProfileChange(slug, {
    sessionId: `sid-${slug}`,
    nativeSessionId: null,
    generation: 1,
    profileRevision: owned.profileRevision,
    controlRevision: owned.controlRevision,
    model: requested.model,
    effort: requested.effort,
    profileHandoff: owned.profileHandoff,
  }, journal)
  assert.ok(serialized)
  return { journal, targetToken }
}

function harness(): { storage: Storage; board: BoardManager; dir: string } {
  const dir = tmpDir("fray-resume-")
  const storage = createStorage(join(dir, "ui.db"))
  const board = createBoard(fakeProject(dir), storage, new Bus(), noopTailer, "test-boot")
  return { storage, board, dir }
}

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: `Thread ${slug}`,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    ...over,
  }
}

function threadIn(snap: BoardSnapshot, slug: string): ThreadView {
  const t = snap.threads.find((x) => x.id === slug)
  assert.ok(t, `expected thread ${slug} in the board snapshot`)
  return t
}

// A tmux stub. `live` picks the branch: true → the running session gets an inject (early return); false →
// the dead session is re-spawned. Records what it was asked to do so the test can assert the resume fired.
function fakeTmux(live: boolean): ResumeTmux & { keyed: string[]; spawned: string[] } {
  const keyed: string[] = []
  const spawned: string[] = []
  return {
    keyed,
    spawned,
    isLive: () => live,
    sendKeys: (_slug, text) => void keyed.push(text),
    pasteText: (_slug, text) => void keyed.push(text),
    killSession: () => {},
    ensureServer: () => {},
    spawn: (slug) => void spawned.push(slug),
  }
}

function permissionTmux(live: boolean): ResumeTmux & { killed: string[]; spawnedCmds: string[][] } {
  const killed: string[] = []
  const spawnedCmds: string[][] = []
  return {
    killed,
    spawnedCmds,
    isLive: () => live,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: (slug) => void killed.push(slug),
    ensureServer: () => {},
    spawn: (_slug, cmd) => void spawnedCmds.push(cmd),
  }
}

test("resumeThread un-archives a bumped LIVE archived thread (Inactive → Active) and re-emits the row", () => {
  const { storage, board } = harness()
  const slug = "archived-live"
  storage.upsertSession(sessionRow(slug))
  storage.setState(slug, "archived") // maintainer archived it → Inactive
  assert.equal(storage.getSession(slug)?.state, "archived")
  assert.equal(storage.getSession(slug)?.archived, 1)
  // PRECONDITION: the board sections it as Inactive.
  assert.equal(sectionOf(threadIn(board.refresh(), slug)), "inactive")

  const tmux = fakeTmux(true)
  resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux }, slug, "get back to work")

  // The bump reached the live session as an inject…
  assert.deepEqual(tmux.keyed, ["get back to work"])
  assert.deepEqual(tmux.spawned, []) // live path: no respawn
  // …and the row is un-archived: state → open, legacy flag cleared.
  assert.equal(storage.getSession(slug)?.state, "open")
  assert.equal(storage.getSession(slug)?.archived, 0)
  // POSTCONDITION: the board now sections it as Active (the SSE delta re-sections it).
  const after = threadIn(board.refresh(), slug)
  assert.equal(after.state, "open")
  assert.equal(sectionOf(after), "active")
})

test("resumeThread durably excludes a concurrent profile change until live injection finishes", () => {
  const { storage, board } = harness()
  const slug = "resume-profile-interlock"
  storage.upsertSession(sessionRow(slug, { model: "sonnet", effort: "high" }))
  let observedControl: string | null | undefined
  let competingArm: ReturnType<typeof storage.armProfileChange>
  const tx = fakeTmux(true)
  tx.sendKeys = () => {
    const owned = storage.getSession(slug)!
    observedControl = owned.runtime_control
    competingArm = storage.armProfileChange(slug, {
      sessionId: owned.session_id,
      nativeSessionId: owned.agent_session_id ?? null,
      generation: owned.runtime_generation ?? 0,
    }, { model: "opus", effort: "max" }, profileHandoff(
      owned.agent_session_id ?? owned.session_id,
      { model: owned.model ?? "sonnet", effort: owned.effort ?? "high" },
      { model: "opus", effort: "max" },
    ))
  }

  resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux: tx }, slug, "continue")

  assert.equal(observedControl, "follow-up")
  assert.equal(competingArm!, null)
  assert.equal(storage.getSession(slug)?.runtime_control, null)
})

test("resumeThread un-archives a bumped DEAD archived thread on the respawn path", () => {
  const { storage, board } = harness()
  const slug = "archived-dead"
  storage.upsertSession(sessionRow(slug, { exited: 1 }))
  storage.setState(slug, "archived")
  assert.equal(sectionOf(threadIn(board.refresh(), slug)), "inactive")

  const tmux = fakeTmux(false) // dead session → respawn path
  resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux }, slug, "resume please")

  assert.deepEqual(tmux.spawned, [slug]) // dead path: the pinned conversation is re-spawned
  const row = storage.getSession(slug)
  assert.equal(row?.state, "open")
  assert.equal(row?.archived, 0)
  assert.equal(row?.exited, 0) // respawn cleared the exited flag
  assert.equal(sectionOf(threadIn(board.refresh(), slug)), "active")
})

test("resumeThread refuses to duplicate a live same-slug owner left on a legacy socket", () => {
  const { storage, board, dir } = harness()
  const slug = "legacy-socket-owner"
  storage.upsertSession(sessionRow(slug, { exited: 1 }))
  const actions: string[] = []
  const tx: ResumeTmux = {
    isLive: () => false,
    crossSocketLiveOwner: () => "live",
    sendKeys: () => void actions.push("send"),
    pasteText: () => void actions.push("paste"),
    killSession: () => void actions.push("kill"),
    ensureServer: () => void actions.push("server"),
    spawn: () => void actions.push("spawn"),
  }
  assert.throws(
    () => resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx }, slug, "wake"),
    /live matching worker exists on a compatible legacy tmux socket/,
  )
  assert.deepEqual(actions, [], "a migrated socket owner must not be killed, injected, or duplicated")
})

test("resumeThread reuses an exact, empty compatible legacy worker without respawning", () => {
  const { storage, board, dir } = harness()
  const slug = "legacy-exact-owner"
  storage.upsertSession(sessionRow(slug, { exited: 1, session_id: "native-legacy-session" }))
  const actions: string[] = []
  const worker = { socket: "fray", paneId: "%91", panePid: 123, sessionCreated: 456 }
  const tx: ResumeTmux = {
    isLive: () => false,
    findCompatibleLegacyWorker: () => ({ kind: "found", worker }),
    captureCompatibleLegacyWorker: () => ({ kind: "captured", text: "history\n❯ \n────────\n  ⏵⏵ auto mode on" }),
    sendTextToCompatibleLegacyWorker: (_worker, text) => (actions.push(text), true),
    crossSocketLiveOwner: () => "live",
    sendKeys: () => void actions.push("wrong-socket-send"),
    pasteText: () => void actions.push("wrong-socket-paste"),
    killSession: () => void actions.push("kill"),
    ensureServer: () => void actions.push("server"),
    spawn: () => void actions.push("spawn"),
  }
  resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx }, slug, "wake")
  assert.deepEqual(actions, ["wake"])
  assert.equal(storage.getSession(slug)?.exited, 0, "only a successful exact send clears the stale exited artifact")
})

test("resumeThread leaves a compatible legacy worker's draft untouched", () => {
  const { storage, board, dir } = harness()
  const slug = "legacy-draft-owner"
  storage.upsertSession(sessionRow(slug, { exited: 1, session_id: "native-legacy-session" }))
  const actions: string[] = []
  const worker = { socket: "fray", paneId: "%92", panePid: 124, sessionCreated: 457 }
  const tx: ResumeTmux = {
    isLive: () => false,
    findCompatibleLegacyWorker: () => ({ kind: "found", worker }),
    captureCompatibleLegacyWorker: () => ({ kind: "captured", text: "❯ existing provider draft" }),
    sendTextToCompatibleLegacyWorker: () => (actions.push("sent"), true),
    sendKeys: () => void actions.push("wrong-socket-send"),
    pasteText: () => void actions.push("wrong-socket-paste"),
    killSession: () => void actions.push("kill"),
    ensureServer: () => void actions.push("server"),
    spawn: () => void actions.push("spawn"),
  }
  assert.throws(
    () => resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx }, slug, "never replay this"),
    /existing draft; it was left untouched/,
  )
  assert.deepEqual(actions, [])
  assert.equal(storage.getSession(slug)?.exited, 1)
})

test("resumeThread resumes a truly exited session once compatible sockets are absent", () => {
  const { storage, board, dir } = harness()
  const slug = "exited-across-sockets"
  storage.upsertSession(sessionRow(slug, { exited: 1 }))
  const tx = fakeTmux(false)
  tx.crossSocketLiveOwner = () => "absent"
  resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx }, slug, "wake")
  assert.deepEqual(tx.spawned, [slug])
})

test("resumeThread never injects into or name-kills a same-slug competitor of a finalized adoption", () => {
  const { storage, board, dir } = harness()
  const slug = "adopted-competitor"
  const token = randomUUID()
  const row = sessionRow(slug, { session_id: randomUUID() })
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: token,
    sessionId: row.session_id,
    reservedAtMs: 100,
    leaseExpiresAtMs: 200,
  }), true)
  assert.equal(storage.recordAdoptionPane(slug, token, { paneId: "%1", panePid: 100, sessionCreated: 1000 }, 200), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, token, row, 150), true)

  const actions: string[] = []
  const tmux: ResumeTmux = {
    isLive: () => true,
    lookupAdoptionPane: () => ({
      kind: "found",
      pane: {
        paneId: "%2",
        panePid: 200,
        sessionCreated: 2000,
        dead: false,
        adoptionAttemptToken: randomUUID(),
      },
    }),
    findExpectedAdoptionPane: () => ({ kind: "unknown" }),
    sendKeys: () => void actions.push("send"),
    pasteText: () => void actions.push("paste"),
    killSession: () => void actions.push("name-kill"),
    killPane: () => void actions.push("pane-kill"),
    ensureServer: () => {},
    spawn: () => void actions.push("spawn"),
  }
  assert.throws(
    () => resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux }, slug, "continue"),
    /could not be verified/,
  )
  assert.deepEqual(actions, [])
  assert.equal(storage.getAdoptionClaim(slug)?.state, "finalized")
})

test("resumeThread fails closed when its row snapshot is replaced before runtime binding", () => {
  const { storage, board, dir } = harness()
  const slug = "resume-stale-row"
  const stale = sessionRow(slug, {
    session_id: "owner-a",
    runtime_generation: 3,
    archived: 1,
    state: "archived",
  })
  storage.upsertSession(stale)
  storage.upsertSession(sessionRow(slug, {
    session_id: "owner-b",
    runtime_generation: 0,
    archived: 1,
    state: "archived",
  }))
  storage.setState(slug, "archived")
  let first = true
  const staleStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "getSession") {
        return (value: string) => {
          if (value === slug && first) {
            first = false
            return stale
          }
          return target.getSession(value)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const actions: string[] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    pasteText: () => void actions.push("paste"),
    sendKeys: () => void actions.push("send"),
    killSession: () => void actions.push("name-kill"),
    ensureServer: () => {},
    spawn: () => { actions.push("spawn") },
  }
  assert.throws(
    () => resumeThread({ project: fakeProject(dir), storage: staleStorage, board, getSettings: () => settings, tmux: tx }, slug, "do not send"),
    /competing adoption attempt|no worker was contacted/,
  )
  assert.deepEqual(actions, [])
  assert.equal(storage.getSession(slug)?.state, "archived", "stale A cannot unarchive replacement B")
})

test("resumeThread contacts a renamed exact owner atomically and never falls back after replacement", () => {
  const { storage, board, dir } = harness()
  const slug = "adopted-renamed"
  const token = randomUUID()
  const row = sessionRow(slug, { session_id: randomUUID() })
  const exact = { paneId: "%31", panePid: 3100, sessionCreated: 31000, dead: false, adoptionAttemptToken: token }
  assert.equal(storage.reserveAdoptionClaim({ slug, attemptToken: token, sessionId: row.session_id, reservedAtMs: 100, leaseExpiresAtMs: 200 }), true)
  assert.equal(storage.recordAdoptionPane(slug, token, exact, 200), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, token, row, 150), true)

  const actions: string[] = []
  let atomicOwner = true
  const tmux: ResumeTmux = {
    isLive: () => false,
    lookupAdoptionPane: () => ({ kind: "absent" }), // canonical session name was renamed
    findExpectedAdoptionPane: () => ({ kind: "found", pane: exact }),
    sendTextToExpectedAdoptionPane: (_expected, text, submit) => {
      actions.push(`exact:${text}:${submit}`)
      return atomicOwner
    },
    sendKeys: () => void actions.push("name-send"),
    pasteText: () => void actions.push("name-paste"),
    killSession: () => void actions.push("name-kill"),
    ensureServer: () => {},
    spawn: () => void actions.push("spawn"),
  }
  resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux }, slug, "first")
  assert.deepEqual(actions, ["exact:first:true"])

  actions.length = 0
  atomicOwner = false // deterministic replacement inside the exact tmux action
  assert.throws(
    () => resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux }, slug, "second"),
    /changed before the follow-up/,
  )
  assert.deepEqual(actions, ["exact:second:true"])
})

test("resumeThread clears an adopted dead generation and atomically rotates its exact durable binding", () => {
  const { storage, board, dir } = harness()
  const slug = "adopted-dead"
  const token = randomUUID()
  const row = sessionRow(slug, { session_id: randomUUID(), exited: 1 })
  const exact = {
    paneId: "%3",
    panePid: 300,
    sessionCreated: 3000,
    dead: true,
    adoptionAttemptToken: token,
  }
  assert.equal(storage.reserveAdoptionClaim({ slug, attemptToken: token, sessionId: row.session_id, reservedAtMs: 100, leaseExpiresAtMs: 200 }), true)
  assert.equal(storage.recordAdoptionPane(slug, token, exact, 200), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, token, row, 150), true)

  let current: PaneSnapshot | undefined = exact
  const actions: string[] = []
  const findExpected = (expected: { attempt_token: string; pane_id: string | null; pane_pid: number | null; session_created: number | null }) =>
    current && current.adoptionAttemptToken === expected.attempt_token &&
      current.paneId === expected.pane_id && current.panePid === expected.pane_pid &&
      current.sessionCreated === expected.session_created
      ? { kind: "found" as const, pane: current }
      : current ? { kind: "unknown" as const } : { kind: "absent" as const }
  const tmux: ResumeTmux = {
    isLive: () => false,
    lookupAdoptionPane: () => current ? { kind: "found", pane: current } : { kind: "absent" },
    findAdoptionPane: (attemptToken) => current?.adoptionAttemptToken === attemptToken
      ? { kind: "found", pane: current }
      : { kind: "absent" },
    findPaneIdentity: (identity) => current && current.paneId === identity.paneId &&
      current.panePid === identity.panePid && current.sessionCreated === identity.sessionCreated
      ? { kind: "found", pane: current }
      : { kind: "absent" },
    findExpectedAdoptionPane: findExpected,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: () => void actions.push("name-kill"),
    killExpectedAdoptionPane: (expected) => {
      if (!current || current.adoptionAttemptToken !== expected.attempt_token ||
          current.paneId !== expected.pane_id || current.panePid !== expected.pane_pid ||
          current.sessionCreated !== expected.session_created) return false
      actions.push("exact-kill")
      current = undefined
      return true
    },
    killPane: () => {
      current = undefined
    },
    ensureServer: () => {},
    spawn: (_slug, _cmd, _cwd, _env, options) => {
      actions.push("spawn")
      const identity = { paneId: "%4", panePid: 400, sessionCreated: 4000 }
      current = {
        ...identity,
        dead: false,
        adoptionAttemptToken: options?.adoptionAttemptToken ?? null,
      }
      options?.onCreated?.(identity)
      return identity
    },
  }
  resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux }, slug, "continue")
  assert.deepEqual(actions, ["exact-kill", "spawn"])
  const rebound = storage.getAdoptionClaim(slug)
  assert.equal(rebound?.state, "finalized")
  assert.equal(rebound?.pane_id, "%4")
  assert.notEqual(rebound?.attempt_token, token)
  assert.equal(storage.getSession(slug)?.exited, 0)
})

test("resumeThread (codex, dead): pre-arms cwd trust + re-attaches the pinned rollout via `codex resume <id>`", () => {
  const { storage, board, dir } = harness()
  const codexHome = tmpDir("fray-codexhome-")
  const slug = "codex-dead"
  const CODEX_ID = "019f4e0a-cafe-7891-9cbf-00000000feed"
  storage.upsertSession(sessionRow(slug, { exited: 1, model: "gpt-5.5", effort: "high" }))
  storage.setBackend(slug, "codex") // the shared upsert never writes backend/agent_session_id
  storage.setAgentSession(slug, CODEX_ID)

  const spawnedCmds: string[][] = []
  const tmux: ResumeTmux = {
    isLive: () => false, // dead → dead-resume (respawn) path
    sendKeys: () => {},
    pasteText: () => {},
    killSession: () => {},
    ensureServer: () => {},
    spawn: (_slug, cmd) => void spawnedCmds.push(cmd),
  }
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: join(dir, "logs") })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  resumeThread({ project: fakeProject(dir), storage, board, getSettings: () => settings, tmux, backendFor, codexHome }, slug, "keep going")

  // A codex respawn hits the trust modal for an untrusted cwd — resume must pre-arm it too.
  const cfg = readFileSync(join(codexHome, "config.toml"), "utf8")
  assert.ok(cfg.includes('trust_level = "trusted"'), "resume pre-arms the codex cwd trust gate")

  // argv: `codex resume … <CODEX_ID> <message>` — the DISCOVERED rollout id, not the fray session_id.
  const cmd = spawnedCmds[0]
  assert.equal(cmd[0], "codex")
  assert.equal(cmd[1], "resume")
  assert.ok(cmd.includes(CODEX_ID), "resume re-attaches the pinned codex rollout id")
  assert.ok(!cmd.includes(`sid-${slug}`), "the fray session_id is NOT used as the codex resume id")
  assert.equal(storage.getSession(slug)?.exited, 0, "respawn cleared the exited flag")
  assert.equal(storage.getSession(slug)?.model, "gpt-5.5", "resume preserves the session-pinned model")
  assert.equal(storage.getSession(slug)?.effort, "high", "resume preserves the session-pinned effort")
  const resumedView = threadIn(board.refresh(), slug)
  assert.equal(resumedView.model, "gpt-5.5", "the board exposes the pinned model to the thread UI")
  assert.equal(resumedView.effort, "high", "the board exposes the pinned effort to the thread UI")

  // The resume MESSAGE (last argv element) re-carries the backend-aware scratchpad orientation — for a
  // codex row that means the CODEX variant (compaction memory), NOT Claude's sub-agent/blackboard
  // framing. This pins `scratchpadOrientation(..., backend?.kind)` on the resume seam (resume.ts).
  const message = cmd[cmd.length - 1]
  assert.match(message, /compaction-proof working memory/, "codex resume carries the codex scratchpad orientation")
  assert.doesNotMatch(message, /blackboard/, "codex resume never carries the sub-agent blackboard framing")
  assert.doesNotMatch(message, /sub-agent/, "codex resume never carries sub-agent framing")
})

test("resumeThread leaves a non-archived thread's state untouched (no needless flip)", () => {
  const { storage, board } = harness()
  const slug = "already-open"
  storage.upsertSession(sessionRow(slug))
  assert.equal(sectionOf(threadIn(board.refresh(), slug)), "active")

  const tmux = fakeTmux(true)
  resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux }, slug, "hi")

  assert.deepEqual(tmux.keyed, ["hi"])
  assert.equal(storage.getSession(slug)?.state, "open")
  assert.equal(sectionOf(threadIn(board.refresh(), slug)), "active")
})

test("resumeThread: a persisted per-thread permission overrides mutable global Settings", () => {
  const { storage, board } = harness()
  const slug = "pinned-permission"
  storage.upsertSession(sessionRow(slug, { exited: 1, permission_mode: "bypassPermissions" }))
  const tx = permissionTmux(false)
  resumeThread(
    { project: fakeProject("/tmp"), storage, board, getSettings: () => ({ ...settings, permissionMode: "default" }), tmux: tx },
    slug,
    "continue",
  )
  const cmd = tx.spawnedCmds[0]
  assert.deepEqual(cmd.slice(0, 3), ["claude", "--permission-mode", "bypassPermissions"])
  assert.equal(storage.getSession(slug)?.permission_mode, "bypassPermissions")
})

test("resumeThread: a migrated unknown row falls back once, then pins the concrete resumed mode", () => {
  const { storage, board } = harness()
  const slug = "legacy-permission"
  storage.upsertSession(sessionRow(slug, { exited: 1, permission_mode: null }))
  const tx = permissionTmux(false)
  resumeThread(
    { project: fakeProject("/tmp"), storage, board, getSettings: () => ({ ...settings, permissionMode: "acceptEdits" }), tmux: tx },
    slug,
    "continue",
  )
  assert.deepEqual(tx.spawnedCmds[0].slice(0, 3), ["claude", "--permission-mode", "acceptEdits"])
  assert.equal(storage.getSession(slug)?.permission_mode, "acceptEdits")
})

test("resumeThread: a dead Codex session cannot bypass an unconfirmed submitted-input barrier", () => {
  const { storage, board } = harness()
  const slug = "codex-unconfirmed-resume"
  const submitted = JSON.stringify([{
    text: "MAYBE",
    enqueuedAt: "2026-07-12T00:00:00.000Z",
    state: "submitted",
    submittedAt: "2026-07-12T00:00:00.000Z",
  }])
  storage.upsertSession(sessionRow(slug, { backend: "codex", exited: 1, codex_input_queue: submitted }))
  storage.setBackend(slug, "codex")
  storage.setCodexInputQueue(slug, submitted)
  const tx = permissionTmux(false)

  assert.equal(hasUnconfirmedCodexSubmission(storage.getSession(slug)!), true)
  assert.throws(
    () => resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux: tx }, slug, "new follow-up"),
    /unconfirmed submitted message/,
  )
  assert.equal(tx.spawnedCmds.length, 0)
  assert.equal(storage.getSession(slug)?.codex_input_queue, submitted)
})

test("resumeThread blocks every durable permission handoff before live injection or unarchive", () => {
  for (const [pending, slug] of [["bypassPermissions", "pending-bypass-permissions"], ["future-mode", "pending-future-mode"]]) {
    const { storage, board } = harness()
    storage.upsertSession(sessionRow(slug, { permission_pending: pending }))
    storage.setState(slug, "archived")
    const tx = fakeTmux(true)
    assert.throws(
      () => resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux: tx }, slug, "must not overtake"),
      /permission change.*in progress/i,
    )
    assert.deepEqual(tx.keyed, [])
    assert.equal(storage.getSession(slug)?.state, "archived", "a blocked resume has no lifecycle side effect")
  }
})

test("resumeThread reattaches a dead Codex pending queue without consuming it and appends the trigger", () => {
  const { storage, board, dir } = harness()
  const slug = "queued-pending"
  const queued = JSON.stringify([{ text: "WAIT", enqueuedAt: "2026-07-12T00:00:00.000Z", state: "pending" }])
  storage.upsertSession(sessionRow(slug, {
    backend: "codex",
    exited: 1,
    agent_session_id: "codex-native-id",
    codex_input_queue: queued,
  }))
  storage.setBackend(slug, "codex")
  storage.setAgentSession(slug, "codex-native-id")
  storage.setCodexInputQueue(slug, queued)
  const tx = permissionTmux(false)
  const codexBackend = createCodexBackend({ codexHome: tmpDir("fray-codexhome-queued-") })
  const claudeBackend = createClaudeBackend({ logDir: join(dir, "logs") })
  resumeThread(
    {
      project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx,
      backendFor: (kind) => kind === "codex" ? codexBackend : claudeBackend,
    },
    slug,
    "NEW FOLLOWUP",
  )
  assert.equal(tx.spawnedCmds.length, 1)
  assert.equal(tx.spawnedCmds[0].at(-1), "codex-native-id", "recovery is reattach-only; queued text is not duplicated in argv")
  const savedQueue = JSON.parse(storage.getSession(slug)?.codex_input_queue ?? "[]")
  assert.deepEqual(savedQueue.map((item: { text: string; state: string }) => [item.text, item.state]), [
    ["WAIT", "pending"],
    ["NEW FOLLOWUP", "pending"],
  ])
})

test("resumeThread rejects but byte-preserves malformed durable Codex queue state", () => {
  const { storage, board } = harness()
  const slug = "queued-invalid"
  const queued = "malformed-but-durable"
  storage.upsertSession(sessionRow(slug, { backend: "codex", exited: 1, codex_input_queue: queued }))
  storage.setBackend(slug, "codex")
  storage.setCodexInputQueue(slug, queued)
  const tx = permissionTmux(false)
  assert.throws(
    () => resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux: tx }, slug, "new follow-up"),
    /invalid.*Codex input/i,
  )
  assert.equal(tx.spawnedCmds.length, 0)
  assert.equal(storage.getSession(slug)?.codex_input_queue, queued)
})

test("resumeThread stamps a new runtime generation before spawning a dead process", () => {
  const { storage, board } = harness()
  const slug = "dead-generation"
  storage.upsertSession(sessionRow(slug, { exited: 1 }))
  let observed: SessionRow | undefined
  const tx: ResumeTmux = {
    isLive: () => false,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: () => {},
    ensureServer: () => {},
    spawn: () => { observed = storage.getSession(slug) },
  }
  resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => settings, tmux: tx }, slug, "resume")
  assert.equal(observed?.runtime_generation, 1)
  assert.notEqual(observed?.spawned_at, "2026-07-01T00:00:00.000Z")
  assert.equal(storage.getSession(slug)?.runtime_generation, 1)
})

test("reattachThreadWithPermission: Claude reopens the same conversation with the target mode and no user turn", async () => {
  const { storage, board, dir } = harness()
  const slug = "claude-live-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto" }))
  const tx = permissionTmux(true)
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await reattachThreadWithPermission(
    { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend, permissionReady: async () => true },
    slug,
    "auto",
    "bypassPermissions",
  )
  assert.deepEqual(tx.killed, [slug])
  assert.deepEqual(tx.spawnedCmds[0].slice(0, 3), ["claude", "--permission-mode", "bypassPermissions"])
  assert.deepEqual(tx.spawnedCmds[0].slice(-2), ["-r", `sid-${slug}`], "permission-only reattach has no fabricated prompt")
  assert.equal(storage.getSession(slug)?.permission_mode, "bypassPermissions")
  assert.equal(storage.getSession(slug)?.exited, 0)
})

test("reattachThreadWithPermission: adopted live owner rotates its exact claim without a name-kill gap", async () => {
  const { storage, board, dir } = harness()
  const slug = "adopted-live-permission"
  const sessionId = randomUUID()
  const originalToken = randomUUID()
  const saved = sessionRow(slug, { session_id: sessionId, backend: "claude", permission_mode: "auto" })
  const initial: PaneSnapshot = {
    paneId: "%61",
    panePid: 6100,
    sessionCreated: 61000,
    dead: false,
    adoptionAttemptToken: originalToken,
  }
  assert.equal(storage.reserveAdoptionClaim({ slug, attemptToken: originalToken, sessionId, reservedAtMs: 1, leaseExpiresAtMs: 2 }), true)
  assert.equal(storage.recordAdoptionPane(slug, originalToken, initial, 2), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, originalToken, saved, 2), true)

  let current: PaneSnapshot | undefined = initial
  const commands: string[][] = []
  const nameKills: string[] = []
  const matches = (expected: { attempt_token: string; pane_id: string | null; pane_pid: number | null; session_created: number | null }) =>
    current && current.adoptionAttemptToken === expected.attempt_token && current.paneId === expected.pane_id &&
      current.panePid === expected.pane_pid && current.sessionCreated === expected.session_created
  const tx: ResumeTmux = {
    isLive: () => false,
    lookupAdoptionPane: () => ({ kind: "absent" }), // exact owner may be renamed
    findAdoptionPane: (token) => current?.adoptionAttemptToken === token ? { kind: "found", pane: current } : { kind: "absent" },
    findPaneIdentity: (identity) => current && current.paneId === identity.paneId && current.panePid === identity.panePid &&
      current.sessionCreated === identity.sessionCreated ? { kind: "found", pane: current } : { kind: "absent" },
    findExpectedAdoptionPane: (expected) => matches(expected) ? { kind: "found", pane: current! } : current ? { kind: "unknown" } : { kind: "absent" },
    captureExpectedAdoptionPane: () => ({ kind: "captured", text: "history\n❯\u00a0\n────────\n  bypass permissions on" }),
    sendKeys: () => {},
    pasteText: () => {},
    killSession: (name) => void nameKills.push(name),
    killExpectedAdoptionPane: (expected) => {
      if (!matches(expected)) return false
      current = undefined
      return true
    },
    killPane: () => { current = undefined },
    ensureServer: () => {},
    spawn: (_slug, cmd, _cwd, _env, options) => {
      commands.push(cmd)
      const identity = { paneId: "%62", panePid: 6200, sessionCreated: 62000 }
      current = { ...identity, dead: false, adoptionAttemptToken: options?.adoptionAttemptToken ?? null }
      options?.onCreated?.(identity)
      return identity
    },
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await reattachThreadWithPermission(
    { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend, permissionReady: async () => true },
    slug,
    "auto",
    "bypassPermissions",
  )
  assert.deepEqual(nameKills, [])
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0].slice(0, 3), ["claude", "--permission-mode", "bypassPermissions"])
  const claim = storage.getAdoptionClaim(slug)
  assert.equal(claim?.state, "finalized")
  assert.equal(claim?.pane_id, "%62")
  assert.notEqual(claim?.attempt_token, originalToken)
  assert.equal(storage.getSession(slug)?.permission_mode, "bypassPermissions")
})

test("reattachThreadWithPermission: a failed target launch restores the previous mode", async () => {
  const { storage, board, dir } = harness()
  const slug = "rollback-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto" }))
  const commands: string[][] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: () => {},
    ensureServer: () => {},
    spawn: (_slug, cmd) => {
      commands.push(cmd)
      if (commands.length === 1) throw new Error("target launch rejected")
    },
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await assert.rejects(
    reattachThreadWithPermission(
        { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend, permissionReady: async () => true },
        slug,
        "auto",
        "bypassPermissions",
      ),
    /previous mode was restored/,
  )
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[1].slice(0, 3), ["claude", "--permission-mode", "auto"])
  assert.equal(storage.getSession(slug)?.permission_mode, "auto")
  assert.equal(storage.getSession(slug)?.exited, 0)
})

test("reattachThreadWithPermission: an immediately exiting target is rolled back before reporting success", async () => {
  const { storage, board, dir } = harness()
  const slug = "target-exits-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto" }))
  const tx = permissionTmux(true)
  const ready = [false, true]
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })

  await assert.rejects(
    reattachThreadWithPermission(
      {
        project: fakeProject(dir),
        storage,
        board,
        getSettings: () => settings,
        tmux: tx,
        backendFor: () => backend,
        permissionReady: async () => ready.shift() ?? false,
      },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /previous mode was restored: the resumed worker exited during startup/,
  )
  assert.equal(tx.spawnedCmds.length, 2)
  assert.equal(storage.getSession(slug)?.permission_mode, "auto")
  assert.equal(storage.getSession(slug)?.exited, 0)
})

test("reattachThreadWithPermission: target and rollback startup failures leave a precise exited state", async () => {
  const { storage, board, dir } = harness()
  const slug = "both-exit-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto" }))
  const tx = permissionTmux(true)
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })

  await assert.rejects(
    reattachThreadWithPermission(
      {
        project: fakeProject(dir),
        storage,
        board,
        getSettings: () => settings,
        tmux: tx,
        backendFor: () => backend,
        permissionReady: async () => false,
      },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /worker could not be restored: the previous worker mode also exited during startup/,
  )
  assert.equal(tx.spawnedCmds.length, 2)
  assert.equal(storage.getSession(slug)?.exited, 1)
})

test("reattachThreadWithPermission: a same-slug session replacement cannot be overwritten or rolled back", async () => {
  const { storage, board, dir } = harness()
  const slug = "replaced-during-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto" }))
  let panePid = 101
  const killed: string[] = []
  const spawnedCmds: string[][] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    panePid: () => panePid,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: (value) => void killed.push(value),
    ensureServer: () => {},
    spawn: (_slug, cmd) => void spawnedCmds.push(cmd),
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })

  await assert.rejects(
    reattachThreadWithPermission(
      {
        project: fakeProject(dir),
        storage,
        board,
        getSettings: () => settings,
        tmux: tx,
        backendFor: () => backend,
        permissionReady: async () => {
          panePid = 202
          storage.upsertSession(sessionRow(slug, {
            session_id: "sid-replacement",
            title: "Replacement session",
            backend: "claude",
            permission_mode: "acceptEdits",
            permission_pending: null,
          }))
          return true
        },
      },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /replaced this thread|deleted or replaced/,
  )

  const replacement = storage.getSession(slug)!
  assert.equal(replacement.session_id, "sid-replacement")
  assert.equal(replacement.title, "Replacement session")
  assert.equal(replacement.permission_mode, "acceptEdits")
  assert.equal(spawnedCmds.length, 1, "an old request never spawns a rollback over the replacement")
  assert.deepEqual(killed, [slug], "only the original generation is killed")
})

test("reattachThreadWithPermission: an unrelated title/archive edit survives the startup await", async () => {
  const { storage, board, dir } = harness()
  const slug = "metadata-during-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto", title: "Before" }))
  const tx = permissionTmux(true)
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })

  await reattachThreadWithPermission(
    {
      project: fakeProject(dir),
      storage,
      board,
      getSettings: () => settings,
      tmux: tx,
      backendFor: () => backend,
      permissionReady: async () => {
        storage.setTitle(slug, "Renamed while starting")
        storage.setState(slug, "archived")
        return true
      },
    },
    slug,
    "auto",
    "bypassPermissions",
  )

  const saved = storage.getSession(slug)!
  assert.equal(saved.title, "Renamed while starting")
  assert.equal(saved.title_auto, 0)
  assert.equal(saved.state, "archived")
  assert.equal(saved.archived, 1)
  assert.equal(saved.permission_mode, "bypassPermissions")
})

test("reattachThreadWithPermission: a different pane PID cannot masquerade as the requested process", async () => {
  const { storage, board, dir } = harness()
  const slug = "pane-replaced-permission"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto" }))
  let panePid = 301
  const killed: string[] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    panePid: () => panePid,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: (value) => void killed.push(value),
    ensureServer: () => {},
    spawn: () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })

  await assert.rejects(
    reattachThreadWithPermission(
      {
        project: fakeProject(dir),
        storage,
        board,
        getSettings: () => settings,
        tmux: tx,
        backendFor: () => backend,
        permissionReady: async () => {
          panePid = 302
          return true
        },
      },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /another worker process replaced/,
  )
  assert.equal(storage.getSession(slug)?.permission_mode, "auto")
  assert.deepEqual(killed, [slug], "the unknown replacement pane is never killed for rollback")
})

test("reattachThreadWithPermission identifies a target by pane, pid, and tmux session creation", async () => {
  const { storage, board, dir } = harness()
  const slug = "pane-identity-replaced"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto", permission_pending: "bypassPermissions" }))
  let identity = { paneId: "%1", panePid: 401, sessionCreated: 1001 }
  const killed: string[] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    paneIdentity: () => identity,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: (value) => void killed.push(value),
    ensureServer: () => {},
    spawn: () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await assert.rejects(
    reattachThreadWithPermission(
      {
        project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend,
        permissionReady: async () => {
          identity = { ...identity, paneId: "%2" }
          return true
        },
      },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /another worker process replaced/,
  )
  assert.deepEqual(killed, [slug], "the unknown replacement is never killed")
})

test("reattachThreadWithPermission kills only the captured pane identity when the slug is replaced before kill", async () => {
  const { storage, board, dir } = harness()
  const slug = "identity-before-kill"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto", permission_pending: "bypassPermissions" }))
  const original = { paneId: "%old", panePid: 501, sessionCreated: 2001 }
  const replacement = { paneId: "%new", panePid: 502, sessionCreated: 2002 }
  const killed: string[] = []
  let reads = 0
  const tx: ResumeTmux = {
    isLive: () => true,
    paneIdentity: () => (++reads === 1 ? original : replacement),
    killPane: (identity) => void killed.push(identity.paneId),
    sendKeys: () => {},
    pasteText: () => {},
    killSession: () => assert.fail("name-targeted kill must not be used"),
    ensureServer: () => {},
    spawn: () => { throw new Error("replacement owns the slug") },
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await assert.rejects(
    reattachThreadWithPermission(
      { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend, permissionReady: async () => true },
      slug,
      "auto",
      "bypassPermissions",
    ),
  )
  assert.deepEqual(killed, ["%old"])
})

test("reattachThreadWithPermission never adopts a concurrent pane in place of the identity returned by spawn", async () => {
  const { storage, board, dir } = harness()
  const slug = "identity-after-spawn"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto", permission_pending: "bypassPermissions" }))
  const original = { paneId: "%old", panePid: 601, sessionCreated: 3001 }
  const spawned = { paneId: "%spawned", panePid: 602, sessionCreated: 3002 }
  const concurrent = { paneId: "%concurrent", panePid: 603, sessionCreated: 3003 }
  const killed: string[] = []
  let spawnedNow = false
  const tx: ResumeTmux = {
    isLive: () => true,
    paneIdentity: () => spawnedNow ? concurrent : original,
    killPane: (identity) => void killed.push(identity.paneId),
    sendKeys: () => {},
    pasteText: () => {},
    killSession: () => assert.fail("name-targeted kill must not be used"),
    ensureServer: () => {},
    spawn: () => {
      spawnedNow = true
      return spawned
    },
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await assert.rejects(
    reattachThreadWithPermission(
      { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend, permissionReady: async () => true },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /another worker process replaced/,
  )
  assert.deepEqual(killed, ["%old"], "the concurrent pane is neither adopted nor killed")
})

test("reattachThreadWithPermission never kills a target whose tmux identity cannot be read", async () => {
  const { storage, board, dir } = harness()
  const slug = "missing-pane-identity"
  storage.upsertSession(sessionRow(slug, { backend: "claude", permission_mode: "auto", permission_pending: "bypassPermissions" }))
  const killed: string[] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    paneIdentity: () => null,
    sendKeys: () => {},
    pasteText: () => {},
    killSession: (value) => void killed.push(value),
    ensureServer: () => {},
    spawn: () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  await assert.rejects(
    reattachThreadWithPermission(
      { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx, backendFor: () => backend, permissionReady: async () => false },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /identity|pane was not created/i,
  )
  assert.deepEqual(killed, [], "no process is killed when the current pane identity is unavailable")
})

test("reattachThreadWithPermission rollback failure cannot adopt a newer same-pending generation", async () => {
  const { storage, board, dir } = harness()
  const slug = "newer-same-pending"
  storage.upsertSession(sessionRow(slug, {
    backend: "claude",
    permission_mode: "auto",
    permission_pending: "bypassPermissions",
  }))
  const tx = permissionTmux(true)
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  let probe = 0
  await assert.rejects(
    reattachThreadWithPermission(
      {
        project: fakeProject(dir),
        storage,
        board,
        getSettings: () => settings,
        tmux: tx,
        backendFor: () => backend,
        permissionReady: async () => {
          probe++
          if (probe === 1) return false
          const current = storage.getSession(slug)!
          const newer = storage.beginRuntimeGeneration(
            slug,
            {
              sessionId: current.session_id,
              generation: current.runtime_generation ?? 0,
              permissionPending: "bypassPermissions",
            },
            "2026-07-13T13:00:00.000Z",
          )
          assert.equal(newer, 3)
          assert.equal(storage.setPermissionStateIfCurrent(
            slug,
            { sessionId: current.session_id, generation: newer!, permissionPending: "bypassPermissions" },
            {
              permissionMode: "acceptEdits",
              permissionPending: "bypassPermissions",
              controlError: "newer generation owns this failure",
              exited: false,
            },
          ), true)
          return false
        },
      },
      slug,
      "auto",
      "bypassPermissions",
    ),
    /generation|replaced|canceled/i,
  )
  const saved = storage.getSession(slug)!
  assert.equal(saved.runtime_generation, 3)
  assert.equal(saved.permission_mode, "acceptEdits")
  assert.equal(saved.permission_pending, "bypassPermissions")
  assert.equal(saved.control_error, "newer generation owns this failure")
  assert.equal(saved.exited, 0)
})

test("recoverThreadProfileHandoff proves the unchanged prior pane after a crash before spawn", async () => {
  const { storage, board, dir } = harness()
  const slug = "profile-crash-before-spawn"
  storage.upsertSession(sessionRow(slug, { backend: "claude", model: "opus", effort: "high" }))
  const { journal } = armRecovery(storage, slug, "armed")
  let spawnCount = 0
  const tx: ResumeTmux = {
    isLive: () => true,
    findPaneIdentity: (identity) => ({
      kind: "found",
      pane: { ...identity, dead: false, adoptionAttemptToken: null },
    }),
    sendKeys: () => assert.fail("recovery must not send input"),
    pasteText: () => assert.fail("recovery must not paste input"),
    killSession: () => assert.fail("recovery must not name-kill"),
    ensureServer: () => {},
    spawn: () => { spawnCount++; return ROLLBACK_PANE },
  }
  const result = await recoverThreadProfileHandoff(
    { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx },
    storage.getSession(slug)!,
    journal,
    { currentTargetObservation: false },
  )
  assert.equal(result.outcome, "rollback-ready")
  assert.equal(spawnCount, 0)
  assert.equal(JSON.parse(storage.getSession(slug)?.profile_handoff ?? "{}").phase, "rollback-ready")
})

test("recoverThreadProfileHandoff accepts an exact ready target without telemetry and fresh telemetry only with the exact target", async () => {
  for (const scenario of [
    { slug: "profile-ready-before-commit", phase: "target-ready" as const, observed: false },
    { slug: "profile-fresh-observation", phase: "target-spawned" as const, observed: true },
  ]) {
    const { storage, board, dir } = harness()
    storage.upsertSession(sessionRow(scenario.slug, { backend: "claude", model: "opus", effort: "high" }))
    const { journal, targetToken } = armRecovery(storage, scenario.slug, scenario.phase)
    const tx: ResumeTmux = {
      isLive: () => true,
      findPaneIdentity: () => ({ kind: "absent" }),
      findProfileHandoffPane: (token) => token === targetToken
        ? { kind: "found", pane: { ...TARGET_PANE, dead: false, adoptionAttemptToken: null, profileHandoffToken: token } }
        : { kind: "absent" },
      sendKeys: () => assert.fail("recovery must not send input"),
      pasteText: () => assert.fail("recovery must not paste input"),
      killSession: () => assert.fail("recovery must not name-kill"),
      ensureServer: () => {},
      spawn: () => assert.fail("a proven target must not respawn"),
    }
    const result = await recoverThreadProfileHandoff(
      { project: fakeProject(dir), storage, board, getSettings: () => settings, tmux: tx },
      storage.getSession(scenario.slug)!,
      journal,
      { currentTargetObservation: scenario.observed },
    )
    assert.equal(result.outcome, "target-ready")
    assert.equal(JSON.parse(storage.getSession(scenario.slug)?.profile_handoff ?? "{}").phase, "target-ready")
  }
})

test("recoverThreadProfileHandoff rolls stale or absent telemetry back with exact teardown and only the prior profile", async () => {
  const { storage, board, dir } = harness()
  const slug = "profile-stale-rollback"
  storage.upsertSession(sessionRow(slug, { backend: "claude", model: "opus", effort: "high" }))
  const { journal, targetToken } = armRecovery(storage, slug, "target-spawned")
  let targetLive = true
  const killed: unknown[] = []
  const spawned: { argv: string[]; env?: Record<string, string> }[] = []
  const tx: ResumeTmux = {
    isLive: () => true,
    paneIdentity: () => ROLLBACK_PANE,
    findPaneIdentity: () => ({ kind: "absent" }),
    findProfileHandoffPane: (token) => token === targetToken && targetLive
      ? { kind: "found", pane: { ...TARGET_PANE, dead: false, adoptionAttemptToken: null, profileHandoffToken: token } }
      : { kind: "absent" },
    killExpectedProfileHandoffPane: (expected) => {
      killed.push(expected)
      targetLive = false
      return true
    },
    sendKeys: () => assert.fail("recovery must not send input"),
    pasteText: () => assert.fail("recovery must not paste input"),
    killSession: () => assert.fail("recovery must not name-kill"),
    ensureServer: () => {},
    spawn: (_slug, argv, _cwd, env) => {
      spawned.push({ argv, env })
      return ROLLBACK_PANE
    },
  }
  const result = await recoverThreadProfileHandoff(
    {
      project: fakeProject(dir),
      storage,
      board,
      getSettings: () => settings,
      tmux: tx,
      backendFor: () => createClaudeBackend({ logDir: join(dir, "logs") }),
      permissionReady: async () => true,
    },
    storage.getSession(slug)!,
    journal,
    { currentTargetObservation: false },
  )
  assert.equal(result.outcome, "rollback-ready")
  assert.deepEqual(killed, [{ ...TARGET_PANE, handoffToken: targetToken }])
  assert.equal(spawned.length, 1)
  assert.ok(spawned[0].argv.includes("opus") && spawned[0].argv.includes("high"))
  assert.ok(!spawned[0].argv.includes("sonnet") && !spawned[0].argv.includes("max"), "rollback never launches the requested profile")
  assert.ok(spawned[0].env?.FRAY_PROFILE_HANDOFF)
  assert.equal(JSON.parse(storage.getSession(slug)?.profile_handoff ?? "{}").phase, "rollback-ready")
})

test("recoverThreadProfileHandoff stays locked for target replacement and stop or restore failures", async () => {
  const cases = ["replacement", "stop-failure", "restore-failure"] as const
  for (const failure of cases) {
    const { storage, board, dir } = harness()
    const slug = `profile-${failure}`
    storage.upsertSession(sessionRow(slug, { backend: "claude", model: "opus", effort: "high" }))
    const { journal, targetToken } = armRecovery(storage, slug, "target-spawned")
    let targetLive = true
    let killed = 0
    const tx: ResumeTmux = {
      isLive: () => true,
      paneIdentity: () => ROLLBACK_PANE,
      findPaneIdentity: () => ({ kind: "absent" }),
      findProfileHandoffPane: (token) => token === targetToken && targetLive
        ? {
            kind: "found",
            pane: {
              ...(failure === "replacement" ? { ...TARGET_PANE, panePid: TARGET_PANE.panePid + 99 } : TARGET_PANE),
              dead: false,
              adoptionAttemptToken: null,
              profileHandoffToken: token,
            },
          }
        : { kind: "absent" },
      killExpectedProfileHandoffPane: () => {
        killed++
        if (failure === "stop-failure") return false
        targetLive = false
        return true
      },
      sendKeys: () => assert.fail("recovery must not send input"),
      pasteText: () => assert.fail("recovery must not paste input"),
      killSession: () => assert.fail("recovery must not name-kill"),
      ensureServer: () => {},
      spawn: () => {
        if (failure === "restore-failure") throw new Error("prior profile launch failed")
        return ROLLBACK_PANE
      },
    }
    const result = await recoverThreadProfileHandoff(
      {
        project: fakeProject(dir),
        storage,
        board,
        getSettings: () => settings,
        tmux: tx,
        backendFor: () => createClaudeBackend({ logDir: join(dir, "logs") }),
        permissionReady: async () => true,
      },
      storage.getSession(slug)!,
      journal,
      { currentTargetObservation: false },
    )
    assert.equal(result.outcome, "blocked")
    assert.equal(storage.getSession(slug)?.runtime_control, "profile")
    assert.equal(storage.getSession(slug)?.profile_pending_model, "sonnet")
    assert.equal(killed, failure === "replacement" ? 0 : 1)
  }
})

// The runtimeGate setting must survive respawn: an opted-out project must NOT get the RUNTIME RELEASE
// GATE forced back into the resumed worker's prompt or env (the resume-path toggle-consistency bug).
test("resumeThread threads the runtimeGate setting into the respawned worker prompt AND spawn env", () => {
  const check = (runtimeGate: boolean) => {
    const { storage, board } = harness()
    const slug = `gate-${runtimeGate}`
    storage.upsertSession(sessionRow(slug, { exited: 1 })) // dead → respawn via spawnPinnedSession
    let capturedCmd: string[] = []
    let capturedEnv: Record<string, string> = {}
    const tmux: ResumeTmux = {
      isLive: () => false,
      sendKeys: () => {},
      pasteText: () => {},
      killSession: () => {},
      ensureServer: () => {},
      spawn: (_slug, cmd, _cwd, env) => { capturedCmd = cmd; capturedEnv = (env ?? {}) as Record<string, string> },
    }
    resumeThread({ project: fakeProject("/tmp"), storage, board, getSettings: () => ({ ...settings, runtimeGate }), tmux }, slug, "resume")
    // The env the session-seed compaction re-injection reads mirrors the setting.
    assert.equal(capturedEnv.FRAY_WORKER_RUNTIME_GATE, runtimeGate ? "on" : "off")
    // The system prompt written for this respawn (a file referenced in argv) matches the toggle.
    const i = capturedCmd.indexOf("--append-system-prompt-file")
    assert.ok(i >= 0, "resume argv writes a system-prompt file")
    const prompt = readFileSync(capturedCmd[i + 1], "utf8")
    if (runtimeGate) assert.match(prompt, /Runtime release gate/)
    else assert.doesNotMatch(prompt, /Runtime release gate/)
  }
  check(false)
  check(true)
})
