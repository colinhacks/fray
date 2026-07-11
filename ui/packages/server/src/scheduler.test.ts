import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { createScheduler, parsePrRef, evalRollup, type PrRef, type PrStatus } from "./scheduler.ts"
import type { Tailer, SessionTelemetry, FenceView, TurnState } from "./tailer.ts"

// ---- pure helpers ----

test("parsePrRef: owner/repo#N, PR URLs, .git strip; garbage → undefined", () => {
  assert.deepEqual(parsePrRef("acme/app#391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("  acme/app#391  "), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("https://github.com/acme/app/pull/391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("acme/app.git#12"), { owner: "acme", repo: "app", number: 12 })
  assert.equal(parsePrRef("not a ref"), undefined)
  assert.equal(parsePrRef("acme/app#0"), undefined)
  // an actions-run URL carries no PR number → not a PR ref
  assert.equal(parsePrRef("https://github.com/acme/app/actions/runs/12345"), undefined)
})

test("evalRollup: empty → pending; all-complete → done; in-progress → pending; failure → done+failed", () => {
  assert.deepEqual(evalRollup([]), { done: false, ok: false })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), { done: true, ok: true })
  // pending (not yet done): `ok` just means "no failure seen yet" — only consulted once done.
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), { done: true, ok: false })
  // StatusContext shape (legacy): state PENDING → pending; state FAILURE → failed
  assert.deepEqual(evalRollup([{ state: "SUCCESS" }, { state: "PENDING" }]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ state: "SUCCESS" }, { state: "FAILURE" }]), { done: true, ok: false })
  // SHAPE SURPRISE: an entry we can't classify (no recognizable status/state) must read as PENDING,
  // never as done+green — else a `ci:` wait could false-fire "green" on a malformed rollup.
  assert.deepEqual(evalRollup([{}]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, {}]), { done: false, ok: true })
})

// ---- scheduler harness ----

function tmpStorage(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "fray-sched-")), "ui.db"))
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
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
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    ...over,
  }
}

function awaiting(hints: FenceView["hints"], body = ""): FenceView {
  return { kind: "awaiting", body, hints }
}
function tele(fence?: FenceView, turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastFence: fence }
}

function fakeTailer(map: Map<string, SessionTelemetry>): Tailer {
  return {
    get: (slug: string) => map.get(slug),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  }
}

interface Harness {
  storage: Storage
  tele: Map<string, SessionTelemetry>
  resumes: { slug: string; message: string }[]
  clock: { ms: number }
  pr: { result: PrStatus | undefined; calls: PrRef[] }
  make(over?: Partial<Parameters<typeof createScheduler>[0]>): ReturnType<typeof createScheduler>
}

function harness(): Harness {
  const storage = tmpStorage()
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string }[] = []
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const pr: { result: PrStatus | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  return {
    storage,
    tele: teleMap,
    resumes,
    clock,
    pr,
    make(over) {
      return createScheduler({
        storage,
        tailer: fakeTailer(teleMap),
        resume: (slug, message) => resumes.push({ slug, message }),
        now: () => clock.ms,
        fetchPr: async (ref) => {
          pr.calls.push(ref)
          return pr.result
        },
        log: () => {},
        pollMs: 0, // poll every tick in tests
        ...over,
      })
    },
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

// ---- THE SAFETY GUARD: no boot mass-fire ----

test("boot-safety: a long-PAST timer fence never fires (only a witnessed crossing does)", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms - 60_000) }], "re-check")))
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "a fence already elapsed at first sight must never resume")
})

test("boot-safety: an already-MERGED pr fence never fires on boot", async () => {
  const h = harness()
  h.storage.upsertSession(row("p"))
  h.tele.set("p", tele(awaiting([{ kind: "pr", value: "acme/app#391" }])))
  h.pr.result = { state: "MERGED", mergedAt: "2026-07-01T00:00:00Z", rollup: [] }
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "a PR already merged at first sight must never resume")
})

// ---- single-fire on a witnessed transition ----

test("timer: fires exactly once on the witnessed crossing, with the prose in the steer", async () => {
  const h = harness()
  const target = h.clock.ms + 30_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(target) }], "Re-poll the rollout.")))
  const s = h.make()
  await s.tick() // armed (unmet)
  assert.equal(h.resumes.length, 0)
  h.clock.ms = target + 1000
  await s.tick() // crosses → fire
  await s.tick() // fence still present → must NOT re-fire (single-fire)
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].slug, "t")
  assert.equal(h.resumes[0].message, "⏰ Your timer fired: Re-poll the rollout.. Continue.")
})

test("only-at-rest: an in-flight thread with a (stale) awaiting fence never fires", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms + 1000) }]), "in-flight"))
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
})

test("archived thread is skipped entirely", async () => {
  const h = harness()
  h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms + 1000) }])))
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
})

test("session: hint is not actionable — no fire, no crash", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "session", value: "other-thread" }])))
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
})

// ---- re-await after a fence clears arms fresh ----

test("a NEW awaiting rest (after the fence cleared) arms and fires again", async () => {
  const h = harness()
  const t1 = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(t1) }])))
  const s = h.make()
  await s.tick() // arm #1
  h.clock.ms = t1 + 1000
  await s.tick() // fire #1
  assert.equal(h.resumes.length, 1)
  // The agent's turn supersedes the fence → tailer clears it.
  h.tele.set("t", tele(undefined))
  await s.tick() // prune
  // Later the worker re-awaits a NEW timer.
  const t2 = h.clock.ms + 10_000
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(t2) }])))
  await s.tick() // arm #2 (fresh)
  assert.equal(h.resumes.length, 1)
  h.clock.ms = t2 + 1000
  await s.tick() // fire #2
  assert.equal(h.resumes.length, 2)
})

// ---- idempotency across a server restart ----

test("restart idempotency: a fired wake is not re-fired by a fresh scheduler on the same db", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", tele(awaiting([{ kind: "timer", value: iso(target) }])))
  const s1 = h.make()
  await s1.tick() // arm
  h.clock.ms = target + 1000
  await s1.tick() // fire (persists the marker)
  assert.equal(h.resumes.length, 1)
  // Server restarts BEFORE the agent's superseding turn lands — the fence is still present.
  const s2 = h.make()
  await s2.tick()
  await s2.tick()
  assert.equal(h.resumes.length, 1, "the persisted fired-marker must prevent a re-fire after restart")
})

// ---- PR / CI transitions + graceful gh failure ----

test("pr: open→merged transition fires with the merged steer", async () => {
  const h = harness()
  h.storage.upsertSession(row("p"))
  h.tele.set("p", tele(awaiting([{ kind: "pr", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [] }
  await s.tick() // armed (open)
  assert.equal(h.resumes.length, 0)
  h.pr.result = { state: "MERGED", mergedAt: "2026-07-09T12:05:00Z", rollup: [] }
  await s.tick() // merged → fire
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "✅ PR acme/app#391 merged. Continue.")
})

test("ci: pending→(gh failure)→green; a transient gh failure is skipped, never fires early or crashes", async () => {
  const h = harness()
  h.storage.upsertSession(row("c"))
  h.tele.set("c", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }] }
  await s.tick() // armed (pending)
  h.pr.result = undefined // gh unavailable this tick
  await s.tick() // indeterminate → no fire, no crash
  assert.equal(h.resumes.length, 0)
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }
  await s.tick() // checks green → fire
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "✅ CI is green on acme/app#391. Continue.")
})

test("ci: a failing check still wakes the worker (with the failed steer)", async () => {
  const h = harness()
  h.storage.upsertSession(row("c"))
  h.tele.set("c", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }] }
  await s.tick()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "❌ CI failed on acme/app#391. Continue.")
})
