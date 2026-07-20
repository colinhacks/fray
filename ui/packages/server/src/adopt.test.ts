import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AdoptThreadInput, DispatchInput, THREAD_SLUG_MAX_CHARS, ThreadSlug, tmuxSessionName } from "@fray-ui/shared"
import { createDispatcher, resolveLegacyThreadFile, resolveSlug, slugify } from "./dispatch.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import { ADOPTION_ATTEMPT_ENV, type PaneIdentity, type PaneSnapshot, type TmuxSpawnOptions } from "./tmux.ts"
import { readBoard, type FrayBoard, type FrayThread } from "./fray.ts"
import type { AdoptionRecoveryRuntime } from "./adoption-recovery.ts"

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `${slug}-owner`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-13T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    transcript_id: null,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    backend: "claude",
    agent_session_id: null,
    ...over,
  }
}

interface SpawnRecord {
  slug: string
  cmd: string[]
  cwd: string
  env?: Record<string, string>
  identity: PaneIdentity
}

function harness(options: {
  hasSession?: (slug: string) => boolean
  onSpawn?: (storage: Storage, spawn: SpawnRecord) => void
  readBoard?: (threads: readonly FrayThread[], dir: string) => FrayBoard | Promise<FrayBoard>
  adoptionRuntime?: AdoptionRecoveryRuntime
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fray-adopt-"))
  const storage = createStorage(join(dir, "ui.db"))
  const project: Project = {
    dir,
    id: "adopt-test",
    name: "adopt-test",
    label: "o/adopt-test",
    stateDir: dir,
    cwdSlug: cwdSlug(dir),
  }
  const spawned: SpawnRecord[] = []
  const killedPanes: PaneIdentity[] = []
  const killedNames: string[] = []
  let ensureCalls = 0
  let hasSessionCalls = 0
  let rebuilds = 0
  let boardReads = 0
  const legacyThreads = new Map<string, FrayThread>()
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => void rebuilds++,
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    readBoard: async () => {
      boardReads++
      const threads = [...legacyThreads.values()]
      return options.readBoard?.(threads, dir) ?? {
        config: {},
        threads,
        errors: [],
        warnings: [],
        errorItems: [],
      }
    },
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high" }),
    ensureServer: () => void ensureCalls++,
    hasSession: (slug) => {
      hasSessionCalls++
      return options.hasSession?.(slug) ?? false
    },
    spawn: (slug, cmd, cwd, env, spawnOptions: TmuxSpawnOptions = {}) => {
      const identity = { paneId: `%${spawned.length + 1}`, panePid: 1000 + spawned.length, sessionCreated: 2000 + spawned.length }
      const effectiveEnv = spawnOptions.adoptionAttemptToken
        ? { ...env, [ADOPTION_ATTEMPT_ENV]: spawnOptions.adoptionAttemptToken }
        : env
      const record = { slug, cmd, cwd, env: effectiveEnv, identity }
      spawned.push(record)
      options.onSpawn?.(storage, record)
      spawnOptions.onCreated?.(identity)
      return identity
    },
    killPane: (identity) => void killedPanes.push(identity),
    killExpectedAdoptionPane: (expected) => {
      if (expected.pane_id === null || expected.pane_pid === null || expected.session_created === null) return false
      killedPanes.push({
        paneId: expected.pane_id,
        panePid: expected.pane_pid,
        sessionCreated: expected.session_created,
      })
      return true
    },
    // Adoption must never reach its legacy name-targeted cleanup seam.
    killSession: (slug) => void killedNames.push(slug),
    adoptionRuntime: options.adoptionRuntime,
  })

  const discoverLegacy = (slug: string, over: Partial<FrayThread> = {}) => {
    legacyThreads.set(slug, {
      id: slug,
      title: slug,
      status: "active",
      owner: null,
      agents: [],
      errors: [],
      warnings: [],
      ...over,
    })
  }
  const addLegacyFile = (slug: string, over: Partial<FrayThread> = {}) => {
    mkdirSync(join(dir, ".fray"), { recursive: true })
    writeFileSync(
      join(dir, ".fray", `${slug}.md`),
      `---\ntitle: ${slug}\nstatus: active\n---\n\n## Goal\n\nContinue ${slug}.\n`,
    )
    discoverLegacy(slug, over)
  }

  return {
    dir,
    storage,
    dispatcher,
    spawned,
    killedPanes,
    killedNames,
    addLegacyFile,
    discoverLegacy,
    ensureCalls: () => ensureCalls,
    hasSessionCalls: () => hasSessionCalls,
    rebuilds: () => rebuilds,
    boardReads: () => boardReads,
  }
}

const HOSTILE_SLUGS = [
  "",
  ".",
  "..",
  "../outside",
  "/tmp/outside",
  "a/b",
  "a\\b",
  "C:\\outside",
  "%2e%2e",
  "Uppercase",
  "with_underscore",
  "with.dot",
  "é",
  "a\nb",
  "a\rb",
  "a\0b",
  "`touch-pwned`",
  "-leading-option",
  "a".repeat(THREAD_SLUG_MAX_CHARS + 1),
]

test("one canonical thread slug contract rejects path, control, option, Unicode, and oversized identities", () => {
  for (const valid of ["a", "0", "thread-2", "a".repeat(THREAD_SLUG_MAX_CHARS)]) {
    assert.equal(ThreadSlug.safeParse(valid).success, true, valid)
    assert.equal(DispatchInput.safeParse({ prompt: "safe", slug: valid }).success, true, valid)
    assert.equal(AdoptThreadInput.safeParse({ slug: valid }).success, true, valid)
    assert.equal(tmuxSessionName(valid), `fray-${valid}`)
  }
  for (const invalid of HOSTILE_SLUGS) {
    assert.equal(ThreadSlug.safeParse(invalid).success, false, JSON.stringify(invalid))
    assert.equal(DispatchInput.safeParse({ prompt: "safe", slug: invalid }).success, false, JSON.stringify(invalid))
    assert.equal(AdoptThreadInput.safeParse({ slug: invalid }).success, false, JSON.stringify(invalid))
    assert.throws(() => tmuxSessionName(invalid))
  }
  assert.equal(AdoptThreadInput.safeParse({ slug: "safe", extra: true }).success, false, "adoption input is strict")
  assert.equal(AdoptThreadInput.safeParse({ slug: "safe", message: "x".repeat(64 * 1024 + 1) }).success, false)
})

test("derived and collision slugs remain canonical at the maximum length", () => {
  const max = slugify("a".repeat(THREAD_SLUG_MAX_CHARS + 50))
  assert.equal(max.length, THREAD_SLUG_MAX_CHARS)
  assert.equal(ThreadSlug.safeParse(max).success, true)
  const dir = mkdtempSync(join(tmpdir(), "fray-slug-bound-"))
  writeFileSync(join(dir, `${max}.md`), "taken")
  const collision = resolveSlug(dir, max)
  assert.equal(collision.length, THREAD_SLUG_MAX_CHARS)
  assert.match(collision, /-2$/)
  assert.equal(ThreadSlug.safeParse(collision).success, true)
})

test("direct dispatcher entry points reject hostile slugs before board, tmux, scratch, or storage", async () => {
  const h = harness()
  for (const invalid of HOSTILE_SLUGS) {
    await assert.rejects(h.dispatcher.adopt(invalid), /thread is not available for adoption/)
    await assert.rejects(h.dispatcher.dispatch({ prompt: "safe", slug: invalid }))
  }
  assert.equal(h.boardReads(), 0)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.hasSessionCalls(), 0)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.allSessions().length, 0)
  assert.equal(existsSync(join(h.dir, ".fray")), false)
})

test("storage rejects a noncanonical thread/tmux identity at its direct mutation boundary", () => {
  const h = harness()
  assert.throws(() => h.storage.insertSessionIfAbsent(sessionRow("../escape")))
  assert.throws(() => h.storage.upsertSession(sessionRow("-option")))
  assert.throws(() => h.storage.upsertSession(sessionRow("safe", { tmux_name: "fray-someone-else" })))
  assert.equal(h.storage.allSessions().length, 0)
})

test("the real board reader omits unsafe ids and never follows markdown symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-board-safe-"))
  mkdirSync(join(dir, ".fray"))
  writeFileSync(join(dir, ".fray", "safe.md"), "---\ntitle: safe\nstatus: active\n---\n\n## Goal\n\nsafe\n")
  writeFileSync(join(dir, ".fray", "Upper.md"), "---\ntitle: Upper\nstatus: active\n---\n")
  const outside = join(mkdtempSync(join(tmpdir(), "fray-board-outside-")), "outside.md")
  writeFileSync(outside, "---\ntitle: linked\nstatus: active\n---\n")
  symlinkSync(outside, join(dir, ".fray", "linked.md"))

  const board = await readBoard(dir)
  assert.deepEqual(board.threads.map((thread) => thread.id), ["safe"])
  assert.ok(board.errors.some((error) => error.includes("unsafe filename stem") && error.includes("Upper")))

  const linkedRoot = mkdtempSync(join(tmpdir(), "fray-board-linked-root-"))
  symlinkSync(join(dir, ".fray"), join(linkedRoot, ".fray"))
  await assert.rejects(readBoard(linkedRoot), /unsafe or missing \.fray directory/)
})

test("a file that is absent from the fresh board is stale and cannot be adopted", async () => {
  const h = harness({
    readBoard: () => ({ config: {}, threads: [], errors: [], warnings: [], errorItems: [] }),
  })
  h.addLegacyFile("stale")

  await assert.rejects(h.dispatcher.adopt("stale"), /thread is not available for adoption/)
  assert.equal(h.boardReads(), 1)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.hasSessionCalls(), 0)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("stale"), undefined)
  assert.equal(existsSync(join(h.dir, ".fray", "threads")), false)
})

test("fresh-board ownership, agents, errors, and terminal or unknown statuses all fail closed", async () => {
  const cases: [string, Partial<FrayThread>][] = [
    ["owned", { owner: "another-session" }],
    ["agent-bound", { agents: [{ id: "agent-1", state: "working" }] }],
    ["invalid", { errors: ["invalid frontmatter"] }],
    ["done", { status: "done" }],
    ["dismissed", { status: "dismissed" }],
    ["unknown", { status: "future-status" }],
    ["missing-agents", { agents: undefined }],
    ["missing-errors", { errors: undefined }],
  ]

  for (const [slug, override] of cases) {
    const h = harness()
    h.addLegacyFile(slug, override)
    await assert.rejects(h.dispatcher.adopt(slug), /thread is not available for adoption/, slug)
    assert.equal(h.boardReads(), 1, slug)
    assert.equal(h.ensureCalls(), 0, slug)
    assert.equal(h.hasSessionCalls(), 0, slug)
    assert.equal(h.spawned.length, 0, slug)
    assert.equal(h.storage.getSession(slug), undefined, slug)
  }
})

test("legacy source resolution rejects a symlinked file and a symlinked .fray root", async () => {
  const externalDir = mkdtempSync(join(tmpdir(), "fray-adopt-outside-"))
  const externalFile = join(externalDir, "outside.md")
  writeFileSync(externalFile, "---\ntitle: outside\nstatus: active\n---\n")

  const fileLink = harness()
  mkdirSync(join(fileLink.dir, ".fray"))
  symlinkSync(externalFile, join(fileLink.dir, ".fray", "linked.md"))
  fileLink.discoverLegacy("linked")
  assert.equal(resolveLegacyThreadFile(fileLink.dir, "linked"), null)
  await assert.rejects(fileLink.dispatcher.adopt("linked"), /thread is not available for adoption/)
  assert.equal(fileLink.boardReads(), 0)
  assert.equal(fileLink.ensureCalls(), 0)
  assert.equal(fileLink.spawned.length, 0)

  const frayLink = harness()
  const externalFray = join(externalDir, "fray-root")
  mkdirSync(externalFray)
  writeFileSync(join(externalFray, "linked-root.md"), "---\ntitle: linked-root\nstatus: active\n---\n")
  symlinkSync(externalFray, join(frayLink.dir, ".fray"))
  frayLink.discoverLegacy("linked-root")
  assert.equal(resolveLegacyThreadFile(frayLink.dir, "linked-root"), null)
  await assert.rejects(frayLink.dispatcher.adopt("linked-root"), /thread is not available for adoption/)
  assert.equal(frayLink.boardReads(), 0)
  assert.equal(frayLink.ensureCalls(), 0)
  assert.equal(frayLink.spawned.length, 0)
})

test("a threads directory symlink cannot redirect adoption writes outside the project", async () => {
  const h = harness()
  h.addLegacyFile("scratch-link")
  const external = mkdtempSync(join(tmpdir(), "fray-scratch-outside-"))
  symlinkSync(external, join(h.dir, ".fray", "threads"))

  await assert.rejects(h.dispatcher.adopt("scratch-link"), /thread is not available for adoption/)
  assert.deepEqual(readdirSync(external), [])
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("scratch-link"), undefined)
})

test("a source replaced while its fresh board is read fails the identity recheck", async () => {
  const h = harness({
    readBoard: (threads, dir) => {
      writeFileSync(join(dir, ".fray", "changed.md"), "---\ntitle: changed\nstatus: active\n---\n\nchanged during scan\n")
      return { config: {}, threads: [...threads], errors: [], warnings: [], errorItems: [] }
    },
  })
  h.addLegacyFile("changed")

  await assert.rejects(h.dispatcher.adopt("changed"), /thread is not available for adoption/)
  assert.equal(h.boardReads(), 1)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.hasSessionCalls(), 1)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("changed"), undefined)
  assert.equal(existsSync(join(h.dir, ".fray", "threads")), false)
})

test("adopt claims a fresh slug once and stores an exact Claude identity", async () => {
  let observedReservation = false
  const h = harness({
    onSpawn: (storage) => {
      const claim = storage.getAdoptionClaim("fresh")
      observedReservation = claim?.state === "reserved" && storage.getSession("fresh") === undefined
    },
  })
  h.addLegacyFile("fresh")
  assert.ok(resolveLegacyThreadFile(h.dir, "fresh"))

  const result = await h.dispatcher.adopt("fresh", "continue")
  const saved = h.storage.getSession("fresh")
  assert.equal(saved?.session_id, result.sessionId)
  assert.equal(saved?.backend, "claude")
  assert.equal(saved?.agent_session_id, null)
  assert.equal(saved?.model, "sonnet")
  assert.equal(saved?.effort, "high")
  assert.equal(observedReservation, true, "the unique durable reservation exists before external spawn")
  const claim = h.storage.getAdoptionClaim("fresh")
  assert.equal(claim?.state, "finalized")
  assert.equal(claim?.session_id, result.sessionId)
  assert.equal(claim?.pane_id, h.spawned[0].identity.paneId)
  assert.equal(claim?.pane_pid, h.spawned[0].identity.panePid)
  assert.equal(claim?.session_created, h.spawned[0].identity.sessionCreated)
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].slug, "fresh")
  assert.equal(h.spawned[0].env?.FRAY_UI_THREAD, "fresh")
  assert.equal(h.spawned[0].env?.[ADOPTION_ATTEMPT_ENV], claim?.attempt_token)
  assert.equal(h.spawned[0].cwd, h.dir)
  const systemFlag = h.spawned[0].cmd.indexOf("--append-system-prompt-file")
  assert.notEqual(systemFlag, -1)
  const systemPromptPath = h.spawned[0].cmd[systemFlag + 1]
  const systemPrompt = readFileSync(systemPromptPath, "utf8")
  assert.match(systemPrompt, /ADOPTION: this thread predates you/)
  assert.match(systemPrompt, /\.fray\/fresh\.md/)
  assert.doesNotMatch(systemPrompt, /\.\.\//)
  assert.equal(h.boardReads(), 1)
  assert.equal(h.ensureCalls(), 1)
  assert.equal(h.hasSessionCalls(), 1)
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedNames, [])
  assert.equal(h.rebuilds(), 1)
})

test("two adoption requests for the same slug produce one worker and one owner", async () => {
  const h = harness()
  h.addLegacyFile("double")

  const results = await Promise.allSettled([
    h.dispatcher.adopt("double", "first"),
    h.dispatcher.adopt("double", "second"),
  ])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  const failure = results.find((result) => result.status === "rejected")
  assert.ok(failure && failure.status === "rejected")
  assert.match(String(failure.reason), /thread is not available for adoption/)
  assert.equal(h.spawned.length, 1)
  assert.equal(h.storage.allSessions().length, 1)
  assert.equal(h.storage.getSession("double")?.session_id, results.find((result) => result.status === "fulfilled")?.value.sessionId)
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedNames, [])
})

test("an unexpired durable adoption reservation blocks retry before tmux or file provisioning", async () => {
  const h = harness()
  h.addLegacyFile("reserved")
  const now = Date.now()
  assert.equal(h.storage.reserveAdoptionClaim({
    slug: "reserved",
    attemptToken: randomUUID(),
    sessionId: randomUUID(),
    reservedAtMs: now,
    leaseExpiresAtMs: now + 60_000,
  }), true)

  await assert.rejects(h.dispatcher.adopt("reserved"), /thread is not available for adoption/)
  assert.equal(h.hasSessionCalls(), 0)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.spawned.length, 0)
  assert.equal(existsSync(join(h.dir, ".fray", "threads")), false)
})

test("a blocked retired-token orphan remains authoritative without a live row or claim", async () => {
  const token = randomUUID()
  let orphan: PaneSnapshot = {
    paneId: "%77",
    panePid: 7700,
    sessionCreated: 77_000,
    dead: false,
    adoptionAttemptToken: token,
  }
  const h = harness({
    adoptionRuntime: {
      lookupAdoptionPane: () => ({ kind: "absent" }),
      findAdoptionPane: (candidate) => candidate === token && orphan.adoptionAttemptToken === token
        ? { kind: "found", pane: orphan }
        : { kind: "absent" },
      findAdoptionPanes: (tokens) => new Map(tokens.map((candidate) => [
        candidate,
        candidate === token && orphan.adoptionAttemptToken === token
          ? { kind: "found", pane: orphan }
          : { kind: "absent" },
      ])),
      findPaneIdentity: (identity) =>
        identity.paneId === orphan.paneId &&
        identity.panePid === orphan.panePid &&
        identity.sessionCreated === orphan.sessionCreated
          ? { kind: "found", pane: orphan }
          : { kind: "absent" },
      killExpectedAdoptionPane: () => {
        orphan = { ...orphan, adoptionAttemptToken: null }
        return false
      },
    },
  })
  h.addLegacyFile("retired-orphan")
  assert.equal(h.storage.reserveAdoptionClaim({
    slug: "retired-orphan",
    attemptToken: token,
    sessionId: randomUUID(),
    reservedAtMs: 1,
    leaseExpiresAtMs: 2,
  }), true)
  assert.equal(h.storage.abandonAdoptionClaim("retired-orphan", token), true)
  assert.equal(h.storage.getAdoptionClaim("retired-orphan"), undefined)

  await assert.rejects(h.dispatcher.adopt("retired-orphan"), /thread is not available for adoption/)
  assert.equal(h.hasSessionCalls(), 0)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("retired-orphan"), undefined)
  assert.equal(orphan.adoptionAttemptToken, null, "the renamed exact pane survived after losing its token")
})

test("a registered active worker owns its slug and adoption never touches tmux", async () => {
  const h = harness({ hasSession: () => true })
  h.addLegacyFile("registered")
  assert.equal(h.storage.insertSessionIfAbsent(sessionRow("registered", {
    session_id: "registered-codex",
    backend: "codex",
    agent_session_id: "registered-native",
  })), true)

  await assert.rejects(h.dispatcher.adopt("registered"), /thread is not available for adoption/)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.hasSessionCalls(), 0)
  assert.equal(h.spawned.length, 0)
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedNames, [])
  assert.equal(h.storage.getSession("registered")?.session_id, "registered-codex")
  assert.equal(h.storage.getSession("registered")?.backend, "codex")
  assert.equal(h.storage.getSession("registered")?.agent_session_id, "registered-native")
})

test("an unregistered tmux worker collision is refused without kill or registry mutation", async () => {
  const h = harness({ hasSession: (slug) => slug === "unregistered" })
  h.addLegacyFile("unregistered")

  await assert.rejects(h.dispatcher.adopt("unregistered"), /thread is not available for adoption/)
  assert.equal(h.ensureCalls(), 0)
  assert.equal(h.hasSessionCalls(), 1)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.storage.getSession("unregistered"), undefined)
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedNames, [])
  assert.equal(existsSync(join(h.dir, ".fray", "threads")), false)
})

test("exited and archived rows still own their slugs and cannot be adopted over", async () => {
  const h = harness()
  const cases = [
    sessionRow("exited", { session_id: "exited-codex", backend: "codex", agent_session_id: "exited-native", exited: 1 }),
    sessionRow("archived", {
      session_id: "archived-codex",
      backend: "codex",
      agent_session_id: "archived-native",
      exited: 1,
      archived: 1,
      state: "archived",
    }),
  ]
  for (const existing of cases) {
    h.addLegacyFile(existing.slug)
    assert.equal(h.storage.insertSessionIfAbsent(existing), true)
    await assert.rejects(h.dispatcher.adopt(existing.slug), /thread is not available for adoption/)
    const saved = h.storage.getSession(existing.slug)
    assert.equal(saved?.session_id, existing.session_id)
    assert.equal(saved?.backend, "codex")
    assert.equal(saved?.agent_session_id, existing.agent_session_id)
    assert.equal(saved?.exited, existing.exited)
    assert.equal(saved?.archived, existing.archived)
    assert.equal(saved?.state, existing.state)
  }
  assert.equal(h.spawned.length, 0)
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedNames, [])
})

test("a registry owner that wins after spawn is preserved and only the exact losing pane is stopped", async () => {
  let attemptedSessionId = ""
  const competing = sessionRow("race", {
    session_id: "race-codex-winner",
    backend: "codex",
    agent_session_id: "race-native-winner",
    exited: 1,
    archived: 1,
    state: "archived",
  })
  const h = harness({
    onSpawn: (storage, spawn) => {
      attemptedSessionId = spawn.cmd[spawn.cmd.indexOf("--session-id") + 1] ?? ""
      assert.ok(attemptedSessionId)
      assert.equal(storage.insertSessionIfAbsent(competing), true, "the competing registry writer wins the CAS gap")
    },
  })
  h.addLegacyFile("race")

  await assert.rejects(h.dispatcher.adopt("race"), /thread is not available for adoption/)
  assert.equal(h.spawned.length, 1)
  assert.deepEqual(h.killedPanes, [h.spawned[0].identity], "cleanup is bound to the pane returned by this spawn")
  assert.deepEqual(h.killedNames, [], "there is no slug-targeted fallback")
  assert.equal(h.rebuilds(), 0)
  assert.equal(existsSync(join(h.dir, ".fray", "threads", attemptedSessionId, "scratch.md")), false)
  const saved = h.storage.getSession("race")
  assert.equal(saved?.session_id, "race-codex-winner")
  assert.equal(saved?.backend, "codex")
  assert.equal(saved?.agent_session_id, "race-native-winner")
  assert.equal(saved?.exited, 1)
  assert.equal(saved?.archived, 1)
  assert.equal(saved?.state, "archived")
})
