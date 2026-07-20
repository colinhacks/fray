import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { createScheduler, parsePrRef, ghPrViewArgs, evalRollup, parseGithubReviewActivities, wakeDeliveryToken, type GithubReviewActivity, type PrRef, type PrStatus } from "./scheduler.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
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

test("ghPrViewArgs uses numeric selector + explicit normalized repo (never owner/repo#N)", () => {
  const ref = parsePrRef("acme/app.git#12")
  assert.ok(ref)
  assert.deepEqual(ghPrViewArgs(ref), [
    "pr",
    "view",
    "12",
    "--repo",
    "acme/app",
    "--json",
    "state,mergedAt,statusCheckRollup,headRefOid",
  ])
})

test("GitHub review GraphQL normalization preserves actor type for bot filtering", () => {
  const got = parseGithubReviewActivities({
    data: { repository: { pullRequest: {
      reviews: { nodes: [{ id: "R1", submittedAt: "2026-07-09T12:01:00Z", author: { login: "alice", __typename: "User" } }] },
      comments: { nodes: [{ id: "C1", createdAt: "2026-07-09T12:02:00Z", author: { login: "dependabot[bot]", __typename: "Bot" } }] },
    } } },
  })
  assert.deepEqual(got.map((a) => [a.id, a.actor, a.actorType, a.kind]), [
    ["review:R1", "alice", "User", "review"],
    ["comment:C1", "dependabot[bot]", "Bot", "comment"],
  ])
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
  resumes: { slug: string; message: string; deliveryId?: string }[]
  clock: { ms: number }
  pr: { result: PrStatus | undefined; calls: PrRef[] }
  review: { result: GithubReviewActivity[] | undefined; calls: PrRef[] }
  make(over?: Partial<Parameters<typeof createScheduler>[0]>): ReturnType<typeof createScheduler>
}

function harness(): Harness {
  const storage = tmpStorage()
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId?: string }[] = []
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const pr: { result: PrStatus | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  const review: { result: GithubReviewActivity[] | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  return {
    storage,
    tele: teleMap,
    resumes,
    clock,
    pr,
    review,
    make(over) {
      return createScheduler({
        storage,
        tailer: fakeTailer(teleMap),
        resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
        now: () => clock.ms,
        fetchPr: async (ref) => {
          pr.calls.push(ref)
          return pr.result
        },
        fetchGithubReview: async (ref) => {
          review.calls.push(ref)
          return review.result
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

test("human/session hints are descriptive, not scheduler-actionable — no fire, no crash", async () => {
  const h = harness()
  h.storage.upsertSession(row("human"))
  h.storage.upsertSession(row("session"))
  h.tele.set("human", tele(awaiting([{ kind: "human", value: "Alice must approve fork CI" }])))
  h.tele.set("session", tele(awaiting([{ kind: "session", value: "other-thread" }])))
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

test("restart idempotency: a delivered outbox wake is not re-fired by a fresh scheduler on the same db", async () => {
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
  assert.equal(h.resumes.length, 1, "the delivered outbox terminal state must prevent a re-fire after restart")
})

test("registered future timer crosses during server downtime and fires exactly once after restart", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  h.tele.set("t", { ...tele(awaiting([{ kind: "timer", value: iso(target) }])), lastActivityAt: iso(h.clock.ms) })
  await h.make().tick() // future timer registration is persisted
  h.clock.ms = target + 60_000 // server was down across the crossing
  const restarted = h.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
})

test("github-review baselines existing activity, ignores bots, then wakes once on a new human review across restart", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", {
    ...tele(awaiting([
      { kind: "human", value: "repo maintainer review" },
      { kind: "github-review", value: "acme/app#391" },
    ])),
    lastActivityAt: fenceAt,
  })
  const old: GithubReviewActivity = { id: "review:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1000), kind: "review" }
  h.review.result = [old]
  await h.make().tick() // persist baseline, no wake for existing review
  assert.equal(h.resumes.length, 0)

  h.review.result = [
    { id: "review:bot", actor: "dependabot[bot]", actorType: "Bot", at: iso(h.clock.ms + 1000), kind: "review" },
    old,
  ]
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [
    { id: "review:new", actor: "bob", actorType: "User", at: iso(h.clock.ms), kind: "review" },
    old,
  ]
  const restarted = h.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@bob/)
})

test("github-review retries a failed resume from its durable pending cursor across restart and network loss", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", {
    ...tele(awaiting([
      { kind: "human", value: "repo maintainer review" },
      { kind: "github-review", value: "acme/app#391" },
    ])),
    lastActivityAt: fenceAt,
  })
  const old: GithubReviewActivity = { id: "review:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1000), kind: "review" }
  h.review.result = [old]
  await h.make().tick() // durable baseline

  h.clock.ms += 10_000
  h.review.result = [
    { id: "review:new", actor: "bob", actorType: "User", at: iso(h.clock.ms), kind: "review" },
    old,
  ]
  let attempts = 0
  const failing = h.make({
    resume: () => {
      attempts++
      throw new Error("tmux temporarily unavailable")
    },
  })
  await failing.tick()
  assert.equal(attempts, 1)
  assert.equal(h.resumes.length, 0)

  // A fresh scheduler can deliver the persisted outbox item without another successful GitHub read.
  h.review.result = undefined
  h.clock.ms += 30_001 // the uncertain delivery lease expires before another process may retry
  const restarted = h.make({
    resume: (slug, message) => {
      attempts++
      h.resumes.push({ slug, message })
    },
  })
  await restarted.tick()
  await restarted.tick()
  assert.equal(attempts, 2, "one failed and one successful delivery; the delivered outbox state blocks a third")
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@bob/)
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
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "IN_PROGRESS" }] }
  await s.tick() // armed (pending)
  h.pr.result = undefined // gh unavailable this tick
  await s.tick() // indeterminate → no fire, no crash
  assert.equal(h.resumes.length, 0)
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "SUCCESS" }] }
  await s.tick() // checks green → fire
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "✅ CI is green on acme/app#391. Continue.")
})

test("ci: a failing check still wakes the worker (with the failed steer)", async () => {
  const h = harness()
  h.storage.upsertSession(row("c"))
  h.tele.set("c", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "IN_PROGRESS" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "IN_PROGRESS" }] }
  await s.tick()
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "FAILURE" }], workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "FAILURE" }] }
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "❌ CI failed on acme/app#391. Continue.")
})

test("ci: a partial green rollup remains pending for an exact-head fork gate, then an approved rerun wakes once", async () => {
  const h = harness()
  h.storage.upsertSession(row("fork-gate"))
  h.tele.set("fork-gate", tele(awaiting([{ kind: "ci", value: "acme/app#391" }])))
  const s = h.make()
  h.pr.result = {
    state: "OPEN", mergedAt: null,
    rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    workflowRuns: [{ workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "ACTION_REQUIRED", databaseId: 1, createdAt: "2026-07-14T10:00:00Z" }],
  }
  await s.tick()
  assert.equal(h.resumes.length, 0, "fork approval is pending even when statusCheckRollup is green")
  h.pr.result = {
    state: "OPEN", mergedAt: null,
    // GitHub can retain the old ACTION_REQUIRED check in the rollup after approval.
    rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "ACTION_REQUIRED" }],
    workflowRuns: [
      { workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "ACTION_REQUIRED", databaseId: 1, createdAt: "2026-07-14T10:00:00Z" },
      { workflowName: "CI", event: "pull_request", status: "COMPLETED", conclusion: "SUCCESS", databaseId: 2, createdAt: "2026-07-14T10:02:00Z" },
    ],
  }
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "only the latest approved rerun may satisfy the fence")
  assert.match(h.resumes[0].message, /CI is green/)
})

// ---- durable delivery outbox: crash boundaries, recovery, retries, and concurrency ----

function dueTimer(h: Harness, slug: string, delayMs = 1_000): { target: number; fence: FenceView } {
  const target = h.clock.ms + delayMs
  const fence = awaiting([{ kind: "timer", value: iso(target) }], `Wake ${slug}.`)
  h.storage.upsertSession(row(slug))
  h.tele.set(slug, { ...tele(fence), lastActivityAt: iso(h.clock.ms) })
  return { target, fence }
}

test("hard crash after enqueue recovers the pending wake on restart", async () => {
  const h = harness()
  const { target } = dueTimer(h, "enqueue-crash")
  let crash = true
  const scheduler = h.make({
    crashPoint: (point) => {
      if (crash && point === "after-enqueue") throw new Error("SIGKILL after enqueue")
    },
  })
  await scheduler.tick() // register the future timer
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].state, "pending")
  assert.equal(store.list()[0].attempts, 0)
  assert.equal(h.resumes.length, 0)

  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  crash = false
  const restarted = h.make({ storage: reopened })
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(createWakeDeliveryStore(reopened.db).list()[0].state, "delivered")
  reopened.close()
})

test("hard crash after atomic claim leaves a lease; restart retries only after it expires", async () => {
  const h = harness()
  const { target } = dueTimer(h, "claim-crash")
  let crash = true
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    retryBaseMs: 10,
    crashPoint: (point) => {
      if (crash && point === "after-claim") throw new Error("SIGKILL after claim")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list()[0].state, "leased")
  assert.equal(store.list()[0].attempts, 1)
  assert.equal(h.resumes.length, 0)

  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  crash = false
  const restarted = h.make({ storage: reopened, deliveryLeaseMs: 100, retryBaseMs: 10 })
  await restarted.tick()
  assert.equal(h.resumes.length, 0, "an unexpired claim cannot be stolen by the new scheduler")
  h.clock.ms += 101
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  const recovered = createWakeDeliveryStore(reopened.db).list()[0]
  assert.equal(recovered.state, "delivered")
  assert.equal(recovered.attempts, 2)
  reopened.close()
})

test("hard crash after successful delivery but before ack is confirmed by the stable token, never replayed", async () => {
  const h = harness()
  const { target, fence } = dueTimer(h, "delivery-crash")
  let deliveredId = ""
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => {
      deliveredId = deliveryId
      h.resumes.push({ slug: "delivery-crash", message: "delivered", deliveryId })
    },
    crashPoint: (point) => {
      if (point === "after-delivery") throw new Error("SIGKILL after tmux accepted input")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(h.resumes.length, 1)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list()[0].state, "leased")
  assert.equal(store.list()[0].attempts, 1)
  // The backend transcript consumed the exact idempotency token before the control plane restarted.
  h.tele.set("delivery-crash", {
    ...tele(fence),
    lastActivityAt: iso(target - 1_000),
    lastUserText: `wake input ${wakeDeliveryToken(deliveredId)}`,
  })
  h.clock.ms += 101
  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  const restarted = h.make({ storage: reopened, deliveryLeaseMs: 100 })
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1, "confirmed external delivery must not be duplicated")
  const confirmed = createWakeDeliveryStore(reopened.db).list()[0]
  assert.equal(confirmed.state, "delivered")
  assert.equal(confirmed.deliveredAt, h.clock.ms)
  reopened.close()
})

test("an ambiguous delivery error is not replayed when the transcript already confirms its token", async () => {
  const h = harness()
  const { target, fence } = dueTimer(h, "ambiguous")
  let calls = 0
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => {
      calls++
      h.tele.set("ambiguous", {
        ...tele(fence),
        lastActivityAt: iso(target - 1_000),
        lastUserText: `accepted ${wakeDeliveryToken(deliveryId)}`,
      })
      throw new Error("connection dropped after terminal accepted the input")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick()
  assert.equal(calls, 1)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "leased")

  await h.make({ deliveryLeaseMs: 100 }).tick()
  assert.equal(calls, 1)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
})

test("hard crash after ack leaves an exact delivered terminal state and never replays", async () => {
  const h = harness()
  const { target } = dueTimer(h, "ack-crash")
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-ack") throw new Error("SIGKILL after ack")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(h.resumes.length, 1)

  const store = createWakeDeliveryStore(h.storage.db)
  assert.equal(store.list()[0].state, "delivered")
  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath)
  await h.make({ storage: reopened }).tick()
  assert.equal(h.resumes.length, 1)
  reopened.close()
})

test("a pending wake whose exact fence is replaced becomes superseded without delivery", async () => {
  const h = harness()
  const { target } = dueTimer(h, "human-won")
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-enqueue") throw new Error("stop after durable enqueue")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  h.tele.set("human-won", tele(undefined)) // a human follow-up superseded the awaiting fence

  await h.make().tick()
  const item = createWakeDeliveryStore(h.storage.db).list()[0]
  assert.equal(item.state, "superseded")
  assert.equal(h.resumes.length, 0)
})

test("delivery failures use bounded exponential retry windows and terminate exhausted", async () => {
  const h = harness()
  const { target } = dueTimer(h, "exhaust")
  let attempts = 0
  const scheduler = h.make({
    deliveryLeaseMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 40,
    maxDeliveryAttempts: 3,
    resume: () => {
      attempts++
      throw new Error(`terminal unavailable ${attempts}`)
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick() // attempt 1, retry window 10ms
  assert.equal(attempts, 1)
  h.clock.ms += 9
  await scheduler.tick()
  assert.equal(attempts, 1)
  h.clock.ms += 1
  await scheduler.tick() // attempt 2, retry window 20ms
  assert.equal(attempts, 2)
  h.clock.ms += 20
  await scheduler.tick() // attempt 3, retry window 40ms
  assert.equal(attempts, 3)
  h.clock.ms += 40
  await scheduler.tick() // terminal exhaustion, never a fourth callback
  await scheduler.tick()

  const item = createWakeDeliveryStore(h.storage.db).list()[0]
  assert.equal(item.state, "exhausted")
  assert.equal(item.attempts, 3)
  assert.equal(item.lastError, "terminal unavailable 3")
  assert.equal(attempts, 3)
})

test("two scheduler instances on separate SQLite connections atomically claim one wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-sched-concurrent-"))
  const path = join(dir, "ui.db")
  const firstStorage = createStorage(path)
  const secondStorage = createStorage(path)
  const telemetry = new Map<string, SessionTelemetry>()
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const target = clock.ms + 1_000
  firstStorage.upsertSession(row("concurrent"))
  telemetry.set("concurrent", {
    ...tele(awaiting([{ kind: "timer", value: iso(target) }])),
    lastActivityAt: iso(clock.ms),
  })

  const deliveries: string[] = []
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const began = new Promise<void>((resolve) => { started = resolve })
  const resume = async (_slug: string, _message: string, deliveryId: string) => {
    deliveries.push(deliveryId)
    started()
    await gate
  }
  const make = (storage: Storage) => createScheduler({
    storage,
    tailer: fakeTailer(telemetry),
    resume,
    now: () => clock.ms,
    fetchPr: async () => undefined,
    fetchGithubReview: async () => undefined,
    pollMs: 0,
    log: () => {},
  })
  const first = make(firstStorage)
  const second = make(secondStorage)
  await Promise.all([first.tick(), second.tick()]) // both register the future timer
  clock.ms = target + 1

  const firstTick = first.tick()
  const secondTick = second.tick()
  await began
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(deliveries.length, 1, "the second scheduler observes the lease instead of delivering")
  release()
  await Promise.all([firstTick, secondTick])

  assert.equal(new Set(deliveries).size, 1)
  const items = createWakeDeliveryStore(secondStorage.db).list()
  assert.equal(items.length, 1)
  assert.equal(items[0].state, "delivered")
  assert.equal(items[0].attempts, 1)
  secondStorage.close()
  firstStorage.close()
})

test("a slow condition pass cannot create an already-expired delivery lease", async () => {
  const h = harness()
  const { target } = dueTimer(h, "fresh-lease")
  let claimedLease = 0
  let advanced = false
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    crashPoint: (point, item) => {
      if (point === "after-enqueue" && !advanced) {
        advanced = true
        h.clock.ms += 60_000 // stand in for a slow condition/API pass before outbox delivery
      }
      if (point === "after-claim") claimedLease = item.leaseUntil ?? 0
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick()

  assert.equal(h.resumes.length, 1)
  assert.ok(claimedLease > h.clock.ms, "claim time is sampled at delivery, not inherited from tick start")
})

test("scheduler stop rejects new ticks and drains an in-flight delivery before storage may close", async () => {
  const h = harness()
  const { target } = dueTimer(h, "shutdown-delivery")
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const delivering = new Promise<void>((resolve) => { started = resolve })
  const scheduler = h.make({
    resume: async (slug, message, deliveryId) => {
      h.resumes.push({ slug, message, deliveryId })
      started()
      await gate
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  const tick = scheduler.tick()
  await delivering

  let stopped = false
  const stopping = scheduler.stop().then(() => { stopped = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopped, false, "stop waits at the external delivery boundary")
  await assert.rejects(scheduler.tick(), /shutting down/)

  release()
  await Promise.all([tick, stopping])
  assert.equal(stopped, true)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
  h.storage.close()
})
