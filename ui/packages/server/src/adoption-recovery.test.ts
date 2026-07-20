import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync, spawn as spawnChild } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  adoptionRuntimeBinding,
  abandonAdoptionAttempt,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
} from "./adoption-recovery.ts"
import { SYSTEM_PROMPT_DIR } from "./session-files.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import {
  TmuxSpawnError,
  spawnWithRunner,
  type AdoptionPaneLookup,
  type ExpectedAdoptionPane,
  type PaneIdentity,
  type PaneSnapshot,
} from "./tmux.ts"

const storageModule = pathToFileURL(join(import.meta.dirname, "storage.ts")).href
const recoveryModule = pathToFileURL(join(import.meta.dirname, "adoption-recovery.ts")).href
const tmuxModule = pathToFileURL(join(import.meta.dirname, "tmux.ts")).href

const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

function sessionRow(slug: string, sessionId: string): SessionRow {
  return {
    slug,
    session_id: sessionId,
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
  }
}

function pane(token: string, over: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    paneId: "%41",
    panePid: 4100,
    sessionCreated: 41000,
    dead: false,
    adoptionAttemptToken: token,
    ...over,
  }
}

class FakeRuntime implements AdoptionRecoveryRuntime {
  readonly bySlug = new Map<string, PaneSnapshot>()
  readonly killed: PaneIdentity[] = []
  lookupUnknown = false
  findUnknown = false
  killWorks = true

  lookupAdoptionPane(slug: string): AdoptionPaneLookup {
    if (this.lookupUnknown) return { kind: "unknown" }
    const current = this.bySlug.get(slug)
    return current ? { kind: "found", pane: current } : { kind: "absent" }
  }

  findAdoptionPane(attemptToken: string): AdoptionPaneLookup {
    if (this.findUnknown) return { kind: "unknown" }
    const matches = [...this.bySlug.values()].filter((current) => current.adoptionAttemptToken === attemptToken)
    return matches.length === 1 ? { kind: "found", pane: matches[0] } : matches.length === 0
      ? { kind: "absent" }
      : { kind: "unknown" }
  }

  findAdoptionPanes(attemptTokens: readonly string[]): Map<string, AdoptionPaneLookup> {
    return new Map(attemptTokens.map((token) => [token, this.findAdoptionPane(token)]))
  }

  findPaneIdentity(identity: PaneIdentity): AdoptionPaneLookup {
    const matches = [...this.bySlug.values()].filter((current) =>
      current.paneId === identity.paneId &&
      current.panePid === identity.panePid &&
      current.sessionCreated === identity.sessionCreated,
    )
    return matches.length === 1 ? { kind: "found", pane: matches[0] } : matches.length === 0
      ? { kind: "absent" }
      : { kind: "unknown" }
  }

  killPane(identity: PaneIdentity): void {
    this.killed.push(identity)
    if (!this.killWorks) return
    for (const [slug, current] of this.bySlug) {
      if (
        current.paneId === identity.paneId &&
        current.panePid === identity.panePid &&
        current.sessionCreated === identity.sessionCreated
      ) {
        this.bySlug.delete(slug)
      }
    }
  }

  killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean {
    const found = this.findAdoptionPane(expected.attempt_token)
    if (
      found.kind !== "found" ||
      found.pane.paneId !== expected.pane_id ||
      found.pane.panePid !== expected.pane_pid ||
      found.pane.sessionCreated !== expected.session_created
    ) return false
    this.killPane(found.pane)
    return this.killWorks
  }
}

function fixture(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), "fray-adoption-recovery-"))
  const dbPath = join(dir, "ui.db")
  const storage = createStorage(dbPath)
  const attemptToken = randomUUID()
  const sessionId = randomUUID()
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken,
    sessionId,
    reservedAtMs: 100,
    leaseExpiresAtMs: 200,
  }), true)
  return { dir, dbPath, storage, slug, attemptToken, sessionId }
}

function writeArtifacts(dir: string, sessionId: string): { scratch: string; staging: string; system: string } {
  const scratchDir = join(dir, ".fray", "threads", sessionId)
  mkdirSync(scratchDir, { recursive: true })
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true })
  const scratch = join(scratchDir, "scratch.md")
  const staging = join(scratchDir, ".scratch.tmp")
  const system = join(SYSTEM_PROMPT_DIR, `${sessionId}.md`)
  writeFileSync(scratch, "scratch")
  writeFileSync(staging, "staging")
  writeFileSync(system, "system")
  return { scratch, staging, system }
}

test("adoption runtime binding rejects stale row snapshots before any legacy slug fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-binding-aba-"))
  const s = createStorage(join(dir, "ui.db"))
  const original = { ...sessionRow("binding-aba", "owner-a"), runtime_generation: 2 }
  s.upsertSession(original)
  assert.equal(adoptionRuntimeBinding(s, original).kind, "unbound")

  s.forgetSession(original.slug)
  assert.equal(adoptionRuntimeBinding(s, original).kind, "conflict", "an absent current row is stale")
  s.upsertSession({ ...sessionRow(original.slug, "owner-b"), runtime_generation: 0 })
  assert.equal(adoptionRuntimeBinding(s, original).kind, "conflict", "a replacement session is stale")

  const sameId = { ...sessionRow("binding-generation", "same-owner"), runtime_generation: 1 }
  s.upsertSession(sameId)
  s.upsertSession({ ...sameId, runtime_generation: 2 })
  assert.equal(adoptionRuntimeBinding(s, sameId).kind, "conflict", "a later process generation is stale")
  s.close()
})

test("retired attempt ledger cleans a token pane created after the live claim was removed", () => {
  const h = fixture("late-retired-pane")
  assert.equal(h.storage.abandonAdoptionClaim(h.slug, h.attemptToken), true)
  assert.equal(h.storage.getAdoptionClaim(h.slug), undefined)
  assert.ok(h.storage.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === h.attemptToken))

  const runtime = new FakeRuntime()
  runtime.bySlug.set("renamed-late-owner", pane(h.attemptToken))
  const result = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 1_000, runtime })
  assert.equal(result.has(h.slug), false, "successful tombstone cleanup needs no active-claim outcome")
  assert.equal(runtime.findAdoptionPane(h.attemptToken).kind, "absent")
  assert.deepEqual(runtime.killed.map(({ paneId, panePid, sessionCreated }) => ({ paneId, panePid, sessionCreated })), [
    { paneId: "%41", panePid: 4100, sessionCreated: 41000 },
  ])
})

test("retired-token cleanup keeps the slug blocked when the token disappears but its exact pane survives", () => {
  const h = fixture("retired-retoken-race")
  assert.equal(h.storage.abandonAdoptionClaim(h.slug, h.attemptToken), true)
  class RetokenRuntime extends FakeRuntime {
    override killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean {
      const current = this.bySlug.get("renamed-retired-owner")
      if (current) this.bySlug.set("renamed-retired-owner", { ...current, adoptionAttemptToken: null })
      return super.killExpectedAdoptionPane(expected)
    }
  }
  const runtime = new RetokenRuntime()
  runtime.bySlug.set("renamed-retired-owner", pane(h.attemptToken))

  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 1_000, runtime })
  assert.equal(outcomes.get(h.slug), "identity-conflict")
  assert.equal(runtime.findAdoptionPane(h.attemptToken).kind, "absent")
  assert.equal(runtime.findPaneIdentity(pane(h.attemptToken)).kind, "found")
  assert.deepEqual(runtime.killed, [])
})

test("token-only stale-claim cleanup cannot retire ownership while its discovered pane tuple survives", () => {
  const h = fixture("claim-retoken-race")
  const discovered = pane(h.attemptToken)
  class RetokenRuntime extends FakeRuntime {
    override killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean {
      const current = this.bySlug.get("renamed-claim-owner")
      if (current) this.bySlug.set("renamed-claim-owner", { ...current, adoptionAttemptToken: null })
      return super.killExpectedAdoptionPane(expected)
    }
  }
  const runtime = new RetokenRuntime()
  runtime.bySlug.set("renamed-claim-owner", discovered)

  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(outcomes.get(h.slug), "identity-conflict")
  assert.equal(runtime.findAdoptionPane(h.attemptToken).kind, "absent")
  assert.equal(runtime.findPaneIdentity(discovered).kind, "found")
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "recovering")
  assert.deepEqual(runtime.killed, [])
})

test("retired attempt reconciliation batches permanent token history into one runtime inventory", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-retired-batch-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "retired-batch"
  for (let index = 0; index < 100; index++) {
    const token = randomUUID()
    assert.equal(storage.reserveAdoptionClaim({
      slug,
      attemptToken: token,
      sessionId: `batch-${index}`,
      reservedAtMs: index * 2 + 1,
      leaseExpiresAtMs: index * 2 + 2,
    }), true)
    assert.equal(storage.abandonAdoptionClaim(slug, token), true)
  }
  class BatchRuntime extends FakeRuntime {
    batches = 0
    individual = 0
    override findAdoptionPane(token: string): AdoptionPaneLookup {
      this.individual++
      return super.findAdoptionPane(token)
    }
    override findAdoptionPanes(tokens: readonly string[]): Map<string, AdoptionPaneLookup> {
      this.batches++
      return new Map(tokens.map((token) => [token, { kind: "absent" as const }]))
    }
  }
  const runtime = new BatchRuntime()
  reconcileAdoptionClaims({ storage, projectDir: dir, runtime })
  assert.equal(runtime.batches, 1)
  assert.equal(runtime.individual, 0)
})

test("periodic reconciliation skips permanent finalized-owner liveness subprocesses", () => {
  const h = fixture("periodic-finalized")
  const identity = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, identity, 300), true)
  assert.equal(h.storage.finalizeAdoptionClaim(
    h.slug,
    h.attemptToken,
    sessionRow(h.slug, h.sessionId),
    150,
  ), true)
  class CountingRuntime extends FakeRuntime {
    tokenLookups = 0
    identityLookups = 0
    override findAdoptionPane(token: string): AdoptionPaneLookup {
      this.tokenLookups++
      return super.findAdoptionPane(token)
    }
    override findPaneIdentity(expected: PaneIdentity): AdoptionPaneLookup {
      this.identityLookups++
      return super.findPaneIdentity(expected)
    }
  }
  const runtime = new CountingRuntime()
  const outcomes = reconcileAdoptionClaims({
    storage: h.storage,
    projectDir: h.dir,
    runtime,
    includeFinalized: false,
  })
  assert.equal(outcomes.has(h.slug), false)
  assert.equal(runtime.tokenLookups, 0)
  assert.equal(runtime.identityLookups, 0)
})

test("stale reservation after process death is released and its deterministic files are cleaned", () => {
  const h = fixture("after-reservation")
  const files = writeArtifacts(h.dir, h.sessionId)
  const outcomes = reconcileAdoptionClaims({
    storage: h.storage,
    projectDir: h.dir,
    now: () => 201,
    runtime: new FakeRuntime(),
  })
  assert.equal(outcomes.get(h.slug), "recovered-stale-attempt")
  assert.equal(h.storage.getAdoptionClaim(h.slug), undefined)
  assert.equal(existsSync(files.scratch), false)
  assert.equal(existsSync(files.staging), false)
  assert.equal(existsSync(files.system), false)
})

test("stale adopted-resume recovery restores a bound no-pane marker without deleting owner files", () => {
  const h = fixture("resume-reservation")
  assert.equal(h.storage.insertSessionIfAbsent(sessionRow(h.slug, h.sessionId)), true)
  const files = writeArtifacts(h.dir, h.sessionId)
  const outcomes = reconcileAdoptionClaims({
    storage: h.storage,
    projectDir: h.dir,
    now: () => 201,
    runtime: new FakeRuntime(),
  })
  assert.equal(outcomes.get(h.slug), "recovered-stale-attempt")
  assert.deepEqual(
    {
      state: h.storage.getAdoptionClaim(h.slug)?.state,
      pane: h.storage.getAdoptionClaim(h.slug)?.pane_id,
      exited: h.storage.getSession(h.slug)?.exited,
    },
    { state: "finalized", pane: null, exited: 1 },
  )
  assert.equal(readFileSync(files.scratch, "utf8"), "scratch")
  assert.equal(readFileSync(files.staging, "utf8"), "staging")
  assert.equal(readFileSync(files.system, "utf8"), "system")
  rmSync(files.system, { force: true })
})

test("restart discovers the token-only orphan from the new-session→SQLite bind window", () => {
  const h = fixture("after-new-session")
  const runtime = new FakeRuntime()
  runtime.bySlug.set("renamed-orphan", pane(h.attemptToken))
  const outcomes = reconcileAdoptionClaims({
    storage: h.storage,
    projectDir: h.dir,
    now: () => 201,
    runtime,
  })
  assert.equal(outcomes.get(h.slug), "recovered-stale-attempt")
  assert.deepEqual(
    runtime.killed.map(({ paneId, panePid, sessionCreated }) => ({ paneId, panePid, sessionCreated })),
    [{ paneId: "%41", panePid: 4100, sessionCreated: 41000 }],
  )
  assert.equal(runtime.bySlug.size, 0)
})

test("the live owner immediately cleans a token-only orphan when tmux output cannot be parsed", () => {
  const h = fixture("unparsed-new-session")
  const runtime = new FakeRuntime()
  runtime.bySlug.set(h.slug, pane(h.attemptToken))
  assert.equal(abandonAdoptionAttempt({
    storage: h.storage,
    projectDir: h.dir,
    slug: h.slug,
    attemptToken: h.attemptToken,
    sessionId: h.sessionId,
    runtime,
  }), true)
  assert.equal(runtime.killed.length, 1)
  assert.equal(h.storage.getAdoptionClaim(h.slug), undefined)
})

test("crash after identity bind and after either setup command always retains exact cleanup identity", () => {
  for (const crashAt of ["created", "remain-on-exit", "status"] as const) {
    const h = fixture(`setup-${crashAt}`)
    const exact = pane(h.attemptToken)
    const commands: readonly string[][] = []
    let thrown: unknown
    try {
      spawnWithRunner(
        h.slug,
        ["worker", "private prompt"],
        h.dir,
        { API_TOKEN: "credential-value" },
        {
          adoptionAttemptToken: h.attemptToken,
          onCreated: (identity) => {
            assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, identity, 200), true)
          },
          onStage: (stage) => {
            if (stage === crashAt) throw new Error("simulated process death")
          },
        },
        (args) => {
          ;(commands as string[][]).push([...args])
          return "%41\t4100\t41000\n"
        },
      )
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof TmuxSpawnError)
    assert.deepEqual(thrown.identity, { paneId: "%41", panePid: 4100, sessionCreated: 41000 })
    assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "spawned")

    const runtime = new FakeRuntime()
    runtime.bySlug.set(h.slug, exact)
    const outcomes = reconcileAdoptionClaims({
      storage: h.storage,
      projectDir: h.dir,
      now: () => 201,
      runtime,
    })
    assert.equal(outcomes.get(h.slug), "recovered-stale-attempt", crashAt)
    assert.equal(runtime.killed.length, 1, crashAt)
    assert.ok(commands.length >= 1)
  }
})

test("a registry CAS loss preserves the winner and recovery kills only the losing exact pane", () => {
  const h = fixture("cas-loss")
  const exact = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, exact, 200), true)
  assert.equal(h.storage.insertSessionIfAbsent(sessionRow(h.slug, "competing-owner")), true)
  assert.equal(h.storage.finalizeAdoptionClaim(h.slug, h.attemptToken, sessionRow(h.slug, h.sessionId), 150), false)
  assert.equal(adoptionRuntimeBinding(h.storage, h.storage.getSession(h.slug)!).kind, "conflict")

  const runtime = new FakeRuntime()
  runtime.bySlug.set(h.slug, exact)
  reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(h.storage.getSession(h.slug)?.session_id, "competing-owner")
  assert.equal(h.storage.getAdoptionClaim(h.slug), undefined)
  assert.deepEqual(
    runtime.killed.map(({ paneId, panePid, sessionCreated }) => ({ paneId, panePid, sessionCreated })),
    [{ paneId: exact.paneId, panePid: exact.panePid, sessionCreated: exact.sessionCreated }],
  )
})

test("crash after atomic finalize preserves the live exact owner and rejects a same-name competitor", () => {
  const live = fixture("finalized-live")
  const livePane = pane(live.attemptToken)
  assert.equal(live.storage.recordAdoptionPane(live.slug, live.attemptToken, livePane, 200), true)
  assert.equal(live.storage.finalizeAdoptionClaim(live.slug, live.attemptToken, sessionRow(live.slug, live.sessionId), 150), true)
  const runtime = new FakeRuntime()
  runtime.bySlug.set("renamed-finalized-owner", livePane)
  runtime.bySlug.set(live.slug, pane(randomUUID(), { paneId: "%98", panePid: 9800, sessionCreated: 98000 }))
  let outcomes = reconcileAdoptionClaims({ storage: live.storage, projectDir: live.dir, now: () => 1000, runtime })
  assert.equal(outcomes.get(live.slug), "live-finalized-owner")
  assert.equal(live.storage.getSession(live.slug)?.exited, 0)
  assert.deepEqual(runtime.killed, [])

  runtime.bySlug.delete("renamed-finalized-owner")
  runtime.bySlug.set(live.slug, pane(randomUUID(), { paneId: "%99", panePid: 9900, sessionCreated: 99000 }))
  outcomes = reconcileAdoptionClaims({ storage: live.storage, projectDir: live.dir, now: () => 1001, runtime })
  assert.equal(outcomes.get(live.slug), "finalized-owner-unavailable")
  assert.equal(live.storage.getSession(live.slug)?.exited, 1)
  assert.deepEqual(runtime.killed, [], "finalized reconciliation never name-kills the competitor")
})

test("failed immediate cleanup keeps the claim until restart can confirm exact-pane absence", () => {
  const h = fixture("before-cleanup")
  const exact = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, exact, 200), true)
  const runtime = new FakeRuntime()
  runtime.bySlug.set(h.slug, exact)
  runtime.killWorks = false
  assert.equal(abandonAdoptionAttempt({
    storage: h.storage,
    projectDir: h.dir,
    slug: h.slug,
    attemptToken: h.attemptToken,
    sessionId: h.sessionId,
    identity: exact,
    runtime,
  }), false)
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "spawned")

  runtime.killWorks = true
  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(outcomes.get(h.slug), "recovered-stale-attempt")
  assert.equal(runtime.killed.length, 2)
})

test("a crash after artifact cleanup but before claim deletion leaves an idempotent recovery marker", () => {
  const h = fixture("cleanup-checkpoint")
  const files = writeArtifacts(h.dir, h.sessionId)
  let checkpointObserved = false
  const interrupted = new Proxy(h.storage, {
    get(target, property, receiver) {
      if (property !== "finishAdoptionRecovery") return Reflect.get(target, property, receiver)
      return () => {
        checkpointObserved = !existsSync(files.scratch) && !existsSync(files.system)
        throw new Error("simulated SIGKILL before claim deletion")
      }
    },
  }) as Storage
  assert.throws(
    () => reconcileAdoptionClaims({ storage: interrupted, projectDir: h.dir, now: () => 201, runtime: new FakeRuntime() }),
    /simulated SIGKILL/,
  )
  assert.equal(checkpointObserved, true)
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "recovering")

  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 30_202, runtime: new FakeRuntime() })
  assert.equal(outcomes.get(h.slug), "recovered-stale-attempt")
  assert.equal(h.storage.getAdoptionClaim(h.slug), undefined)
})

test("active/stale recovery leases serialize cleaners and an expired recovery can be taken over", () => {
  const h = fixture("lease")
  let outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 199, runtime: new FakeRuntime() })
  assert.equal(outcomes.get(h.slug), "active-reservation")
  const firstRecovery = randomUUID()
  assert.ok(h.storage.beginAdoptionRecovery(h.slug, h.attemptToken, firstRecovery, 201, 250))
  assert.equal(h.storage.finishAdoptionRecovery(h.slug, h.attemptToken, randomUUID()), false)

  outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 249, runtime: new FakeRuntime() })
  assert.equal(outcomes.get(h.slug), "active-reservation")
  outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 251, runtime: new FakeRuntime() })
  assert.equal(outcomes.get(h.slug), "recovered-stale-attempt")
})

test("same token with a reused PID/session-created tuple fails closed without a kill", () => {
  const h = fixture("tuple-mismatch")
  const expected = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, expected, 200), true)
  const runtime = new FakeRuntime()
  runtime.bySlug.set(h.slug, pane(h.attemptToken, { panePid: expected.panePid + 1, sessionCreated: expected.sessionCreated + 1 }))
  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(outcomes.get(h.slug), "identity-conflict")
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "recovering")
  assert.deepEqual(runtime.killed, [])
})

test("a persisted exact tuple with missing token metadata is quarantined and never tuple-killed", () => {
  const h = fixture("stale-token")
  const expected = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, expected, 200), true)
  const runtime = new FakeRuntime()
  runtime.bySlug.set(h.slug, { ...expected, adoptionAttemptToken: null })
  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(outcomes.get(h.slug), "identity-conflict")
  assert.equal(runtime.killed.length, 0)
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "recovering")
})

test("a reused exact tuple carrying another valid attempt token is a competitor and is never killed", () => {
  const h = fixture("token-competitor")
  const expected = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, expected, 200), true)
  const runtime = new FakeRuntime()
  runtime.bySlug.set(h.slug, { ...expected, adoptionAttemptToken: randomUUID() })
  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(outcomes.get(h.slug), "identity-conflict")
  assert.deepEqual(runtime.killed, [])
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "recovering")
})

test("recovery cannot kill a pane retokened after discovery but before atomic teardown", () => {
  const h = fixture("recovery-retoken-race")
  const expected = pane(h.attemptToken)
  assert.equal(h.storage.recordAdoptionPane(h.slug, h.attemptToken, expected, 200), true)
  const competitorToken = randomUUID()
  class RetokenRuntime extends FakeRuntime {
    override killExpectedAdoptionPane(claim: ExpectedAdoptionPane): boolean {
      const current = this.bySlug.get(h.slug)
      if (current) this.bySlug.set(h.slug, { ...current, adoptionAttemptToken: competitorToken })
      return super.killExpectedAdoptionPane(claim)
    }
  }
  const runtime = new RetokenRuntime()
  runtime.bySlug.set(h.slug, expected)
  const outcomes = reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime })
  assert.equal(outcomes.get(h.slug), "identity-conflict")
  assert.deepEqual(runtime.killed, [])
  assert.equal(runtime.bySlug.get(h.slug)?.adoptionAttemptToken, competitorToken)
  assert.equal(h.storage.getAdoptionClaim(h.slug)?.state, "recovering")
})

function runChild(script: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, "../../.."),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function runChildAndKillAtCheckpoint(
  script: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, "../../.."),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let killed = false
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`child did not reach its SIGKILL checkpoint; stderr: ${stderr}`))
    }, 10_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (!killed && stdout.includes("FRAY_TEST_CHECKPOINT\n")) {
        killed = true
        child.kill("SIGKILL")
      }
    })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!killed) {
        reject(new Error(`child exited before its SIGKILL checkpoint (code=${code}, signal=${signal}); stderr: ${stderr}`))
        return
      }
      resolve({ code, signal, stdout, stderr })
    })
  })
}

interface RealCrashFixture {
  dir: string
  dbPath: string
  slug: string
  socket: string
  attemptToken: string
  sessionId: string
}

function realCrashFixture(label: string): RealCrashFixture {
  const dir = mkdtempSync(join(tmpdir(), `fray-adoption-${label}-`))
  const dbPath = join(dir, "ui.db")
  createStorage(dbPath).close()
  const unique = randomUUID().replaceAll("-", "")
  return {
    dir,
    dbPath,
    slug: `sigkill-${label}-${unique.slice(0, 8)}`,
    socket: `fray-adoption-test-${process.pid}-${unique}`,
    attemptToken: randomUUID(),
    sessionId: randomUUID(),
  }
}

function cleanupRealCrashFixture(h: RealCrashFixture): void {
  try {
    execFileSync("tmux", ["-L", h.socket, "kill-server"], { stdio: "ignore" })
  } catch {
    // An already-reconciled orphan can remove the last pane and stop the disposable server.
  }
  rmSync(join(SYSTEM_PROMPT_DIR, `${h.sessionId}.md`), { force: true })
  rmSync(h.dir, { recursive: true, force: true })
}

function listDisposablePanes(socket: string): Array<{
  paneId: string
  panePid: number
  sessionCreated: number
  token: string
}> {
  let output: string
  try {
    output = execFileSync(
      "tmux",
      ["-L", socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{session_created}\t#{E:FRAY_ADOPTION_ATTEMPT}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
  } catch {
    return []
  }
  return output.split("\n").filter(Boolean).map((line) => {
    const [paneId = "", panePid = "", sessionCreated = "", token = ""] = line.split("\t")
    return {
      paneId,
      panePid: Number.parseInt(panePid, 10),
      sessionCreated: Number.parseInt(sessionCreated, 10),
      token,
    }
  })
}

type RealSpawnCrashStage = "new-session" | "identity-bind" | "remain-on-exit" | "status" | "finalize"

function spawnCrashScript(h: RealCrashFixture, crashStage: RealSpawnCrashStage): string {
  const row = sessionRow(h.slug, h.sessionId)
  return `
    import { writeSync } from "node:fs";
    import { createStorage } from ${JSON.stringify(storageModule)};
    import { setSocket, spawn } from ${JSON.stringify(tmuxModule)};
    const checkpoint = () => {
      writeSync(1, "FRAY_TEST_CHECKPOINT\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    const storage = createStorage(${JSON.stringify(h.dbPath)});
    setSocket(${JSON.stringify(h.socket)});
    const reserved = storage.reserveAdoptionClaim({
      slug: ${JSON.stringify(h.slug)},
      attemptToken: ${JSON.stringify(h.attemptToken)},
      sessionId: ${JSON.stringify(h.sessionId)},
      reservedAtMs: 100,
      leaseExpiresAtMs: 200,
    });
    if (!reserved) process.exit(81);
    const fenced = storage.withAdoptionSpawnFence(
      ${JSON.stringify(h.slug)},
      ${JSON.stringify(h.attemptToken)},
      200,
      (bindPane) => spawn(
        ${JSON.stringify(h.slug)},
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        ${JSON.stringify(h.dir)},
        undefined,
        {
          adoptionAttemptToken: ${JSON.stringify(h.attemptToken)},
          onCreated(identity) {
            if (${JSON.stringify(crashStage)} === "new-session") checkpoint();
            if (!bindPane(identity, 200)) process.exit(82);
            if (${JSON.stringify(crashStage)} === "identity-bind") checkpoint();
          },
          onStage(stage) {
            if (stage === ${JSON.stringify(crashStage)}) checkpoint();
          },
        },
      ),
    );
    if (!fenced.acquired) process.exit(85);
    if (${JSON.stringify(crashStage)} !== "finalize") process.exit(83);
    const finalized = storage.finalizeAdoptionClaim(
      ${JSON.stringify(h.slug)},
      ${JSON.stringify(h.attemptToken)},
      ${JSON.stringify(row)},
      150,
    );
    if (!finalized) process.exit(84);
    checkpoint();
  `
}

function restartReconcileScript(h: RealCrashFixture, nowMs: number): string {
  return `
    import { createStorage } from ${JSON.stringify(storageModule)};
    import { reconcileAdoptionClaims } from ${JSON.stringify(recoveryModule)};
    import { findAdoptionPane, setSocket } from ${JSON.stringify(tmuxModule)};
    setSocket(${JSON.stringify(h.socket)});
    const storage = createStorage(${JSON.stringify(h.dbPath)});
    const outcomes = reconcileAdoptionClaims({
      storage,
      projectDir: ${JSON.stringify(h.dir)},
      now: () => ${nowMs},
    });
    const claim = storage.getAdoptionClaim(${JSON.stringify(h.slug)});
    const row = storage.getSession(${JSON.stringify(h.slug)});
    const pane = findAdoptionPane(${JSON.stringify(h.attemptToken)});
    process.stdout.write(JSON.stringify({
      outcome: outcomes.get(${JSON.stringify(h.slug)}) ?? null,
      claim: claim ? {
        state: claim.state,
        paneId: claim.pane_id,
        panePid: claim.pane_pid,
        sessionCreated: claim.session_created,
      } : null,
      row: row ? { sessionId: row.session_id, exited: row.exited } : null,
      paneKind: pane.kind,
    }));
    storage.close();
  `
}

test("separate OS processes/connections contend on one durable reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-adoption-process-race-"))
  const dbPath = join(dir, "ui.db")
  createStorage(dbPath).close()
  const barrier = join(dir, "go")
  const makeScript = (attemptToken: string, sessionId: string) => `
    import { existsSync } from "node:fs";
    import { setTimeout as wait } from "node:timers/promises";
    import { createStorage } from ${JSON.stringify(storageModule)};
    const storage = createStorage(${JSON.stringify(dbPath)});
    while (!existsSync(${JSON.stringify(barrier)})) await wait(1);
    const won = storage.reserveAdoptionClaim({slug:"process-race",attemptToken:${JSON.stringify(attemptToken)},sessionId:${JSON.stringify(sessionId)},reservedAtMs:100,leaseExpiresAtMs:200});
    process.stdout.write(String(won));
    storage.close();
  `
  const children = [
    runChild(makeScript(randomUUID(), randomUUID())),
    runChild(makeScript(randomUUID(), randomUUID())),
  ]
  await new Promise((resolve) => setTimeout(resolve, 40))
  writeFileSync(barrier, "go")
  const results = await Promise.all(children)
  assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ["false", "true"])
  assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\n"))
  const storage = createStorage(dbPath)
  assert.equal(storage.allAdoptionClaims().length, 1)
  assert.equal(storage.getSession("process-race"), undefined)
})

test("an OS process paused past its lease cannot spawn after recovery retires its token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-adoption-late-actor-"))
  const dbPath = join(dir, "ui.db")
  createStorage(dbPath).close()
  const slug = "late-actor"
  const attemptToken = randomUUID()
  const sessionId = randomUUID()
  const ready = join(dir, "ready")
  const resume = join(dir, "resume")
  const spawned = join(dir, "spawned")
  const childPromise = runChild(`
    import { existsSync, writeFileSync } from "node:fs";
    import { setTimeout as wait } from "node:timers/promises";
    import { createStorage } from ${JSON.stringify(storageModule)};
    const storage = createStorage(${JSON.stringify(dbPath)});
    if (!storage.reserveAdoptionClaim({
      slug:${JSON.stringify(slug)},attemptToken:${JSON.stringify(attemptToken)},
      sessionId:${JSON.stringify(sessionId)},reservedAtMs:100,leaseExpiresAtMs:200
    })) process.exit(91);
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(resume)})) await wait(1);
    const result = storage.withAdoptionSpawnFence(
      ${JSON.stringify(slug)}, ${JSON.stringify(attemptToken)}, 500,
      () => writeFileSync(${JSON.stringify(spawned)}, "new-session"),
    );
    process.stdout.write(JSON.stringify(result));
    storage.close();
  `)
  const deadline = Date.now() + 5_000
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error("late actor did not reserve before timeout")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  const recovery = createStorage(dbPath)
  const outcomes = reconcileAdoptionClaims({ storage: recovery, projectDir: dir, now: () => 201, runtime: new FakeRuntime() })
  assert.equal(outcomes.get(slug), "recovered-stale-attempt")
  assert.equal(recovery.getAdoptionClaim(slug), undefined)
  assert.ok(recovery.allRetiredAdoptionAttempts().some((attempt) => attempt.attempt_token === attemptToken))
  recovery.close()

  writeFileSync(resume, "resume")
  const child = await childPromise
  assert.equal(child.code, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { acquired: false })
  assert.equal(existsSync(spawned), false, "the stale actor never reaches its external new-session callback")
})

test("SIGKILL after reservation leaves durable state that restart deterministically recovers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-adoption-sigkill-"))
  const dbPath = join(dir, "ui.db")
  createStorage(dbPath).close()
  const attemptToken = randomUUID()
  const sessionId = randomUUID()
  const result = await runChild(`
    import { createStorage } from ${JSON.stringify(storageModule)};
    const storage = createStorage(${JSON.stringify(dbPath)});
    storage.reserveAdoptionClaim({slug:"sigkill",attemptToken:${JSON.stringify(attemptToken)},sessionId:${JSON.stringify(sessionId)},reservedAtMs:100,leaseExpiresAtMs:200});
    process.kill(process.pid, "SIGKILL");
  `)
  assert.equal(result.signal, "SIGKILL", result.stderr)
  const storage = createStorage(dbPath)
  assert.equal(storage.getAdoptionClaim("sigkill")?.attempt_token, attemptToken)
  const outcomes = reconcileAdoptionClaims({ storage, projectDir: dir, now: () => 201, runtime: new FakeRuntime() })
  assert.equal(outcomes.get("sigkill"), "recovered-stale-attempt")
  assert.equal(storage.getAdoptionClaim("sigkill"), undefined)
})

test("real child-process SIGKILL at every tmux spawn boundary is reconciled by a fresh process", { skip: !tmuxAvailable }, async () => {
  const stages: RealSpawnCrashStage[] = ["new-session", "identity-bind", "remain-on-exit", "status", "finalize"]
  for (const stage of stages) {
    const h = realCrashFixture(stage)
    try {
      const crashed = await runChildAndKillAtCheckpoint(spawnCrashScript(h, stage))
      assert.equal(crashed.code, null, `${stage}: child should not exit normally`)
      assert.equal(crashed.signal, "SIGKILL", `${stage}: ${crashed.stderr}`)

      const panes = listDisposablePanes(h.socket).filter((current) => current.token === h.attemptToken)
      assert.equal(panes.length, 1, `${stage}: the token-bearing pane must survive the server-process crash`)
      const storage = createStorage(h.dbPath)
      const claim = storage.getAdoptionClaim(h.slug)
      assert.ok(claim, `${stage}: durable ownership claim must survive`)
      assert.equal(claim.attempt_token, h.attemptToken)
      if (stage === "new-session") {
        assert.equal(claim.state, "reserved")
        assert.equal(claim.pane_id, null, "the pre-bind crash must leave only the attempt token as proof")
      } else {
        assert.equal(claim.state, stage === "finalize" ? "finalized" : "spawned")
        assert.deepEqual(
          { paneId: claim.pane_id, panePid: claim.pane_pid, sessionCreated: claim.session_created },
          { paneId: panes[0].paneId, panePid: panes[0].panePid, sessionCreated: panes[0].sessionCreated },
          `${stage}: SQLite must retain the exact tmux process generation`,
        )
      }
      assert.equal(storage.getSession(h.slug)?.session_id, stage === "finalize" ? h.sessionId : undefined)
      storage.close()

      const restarted = await runChild(restartReconcileScript(h, 201))
      assert.equal(restarted.code, 0, `${stage}: ${restarted.stderr}`)
      const result = JSON.parse(restarted.stdout) as {
        outcome: string | null
        claim: { state: string } | null
        row: { sessionId: string; exited: number } | null
        paneKind: string
      }
      if (stage === "finalize") {
        assert.deepEqual(result, {
          outcome: "live-finalized-owner",
          claim: {
            state: "finalized",
            paneId: panes[0].paneId,
            panePid: panes[0].panePid,
            sessionCreated: panes[0].sessionCreated,
          },
          row: { sessionId: h.sessionId, exited: 0 },
          paneKind: "found",
        })
      } else {
        assert.deepEqual(result, {
          outcome: "recovered-stale-attempt",
          claim: null,
          row: null,
          paneKind: "absent",
        })
        assert.equal(listDisposablePanes(h.socket).some((current) => current.token === h.attemptToken), false)
      }
    } finally {
      cleanupRealCrashFixture(h)
    }
  }
})

test("real SIGKILL during recovery cleanup leaves a takeover marker for the next restart", { skip: !tmuxAvailable }, async () => {
  const h = realCrashFixture("recovery-cleanup")
  try {
    const spawned = await runChildAndKillAtCheckpoint(spawnCrashScript(h, "status"))
    assert.equal(spawned.signal, "SIGKILL", spawned.stderr)
    const files = writeArtifacts(h.dir, h.sessionId)
    assert.equal(listDisposablePanes(h.socket).some((current) => current.token === h.attemptToken), true)

    const interruptedRecovery = await runChildAndKillAtCheckpoint(`
      import { writeSync } from "node:fs";
      import { createStorage } from ${JSON.stringify(storageModule)};
      import { reconcileAdoptionClaims } from ${JSON.stringify(recoveryModule)};
      import { setSocket } from ${JSON.stringify(tmuxModule)};
      const checkpoint = () => {
        writeSync(1, "FRAY_TEST_CHECKPOINT\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      setSocket(${JSON.stringify(h.socket)});
      const underlying = createStorage(${JSON.stringify(h.dbPath)});
      const storage = new Proxy(underlying, {
        get(target, property, receiver) {
          if (property !== "finishAdoptionRecovery") return Reflect.get(target, property, receiver);
          return () => checkpoint();
        },
      });
      reconcileAdoptionClaims({
        storage,
        projectDir: ${JSON.stringify(h.dir)},
        now: () => 201,
      });
      process.exit(85);
    `)
    assert.equal(interruptedRecovery.code, null)
    assert.equal(interruptedRecovery.signal, "SIGKILL", interruptedRecovery.stderr)

    const storage = createStorage(h.dbPath)
    const recovering = storage.getAdoptionClaim(h.slug)
    assert.equal(recovering?.state, "recovering", "claim deletion must remain pending across the cleanup crash")
    assert.ok(recovering?.recovery_token)
    storage.close()
    assert.equal(existsSync(files.scratch), false)
    assert.equal(existsSync(files.staging), false)
    assert.equal(existsSync(files.system), false)
    assert.equal(
      listDisposablePanes(h.socket).some((current) => current.token === h.attemptToken),
      false,
      "the exact orphan must already be gone before artifact cleanup reaches its commit boundary",
    )

    const restarted = await runChild(restartReconcileScript(h, 30_202))
    assert.equal(restarted.code, 0, restarted.stderr)
    assert.deepEqual(JSON.parse(restarted.stdout), {
      outcome: "recovered-stale-attempt",
      claim: null,
      row: null,
      paneKind: "absent",
    })
  } finally {
    cleanupRealCrashFixture(h)
  }
})

test("fixture proof: system-prompt cleanup never reads or rewrites prompt contents", () => {
  // Guard the test itself against accidentally turning recovery into a prompt-reading/logging path.
  const h = fixture("artifact-proof")
  const files = writeArtifacts(h.dir, h.sessionId)
  assert.equal(readFileSync(files.system, "utf8"), "system")
  reconcileAdoptionClaims({ storage: h.storage, projectDir: h.dir, now: () => 201, runtime: new FakeRuntime() })
  assert.equal(existsSync(files.system), false)
  assert.equal(ADOPTION_ATTEMPT_LEASE_MS, 120_000)
})
