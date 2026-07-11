import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { createBoard, type BoardManager } from "./board.ts"
import { Bus } from "./bus.ts"
import { resumeThread, type ResumeTmux } from "./resume.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import type { AgentBackend } from "./backend/types.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import type { Settings, ThreadView, BoardSnapshot } from "@fray-ui/shared"

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

test("resumeThread (codex, dead): pre-arms cwd trust + re-attaches the pinned rollout via `codex resume <id>`", () => {
  const { storage, board, dir } = harness()
  const codexHome = tmpDir("fray-codexhome-")
  const slug = "codex-dead"
  const CODEX_ID = "019f4e0a-cafe-7891-9cbf-00000000feed"
  storage.upsertSession(sessionRow(slug, { exited: 1 }))
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
