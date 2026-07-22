import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { awaitingFenceIdentity } from "./awaiting.ts"
import { createScheduler, parseGithubReviewActivities, parsePrRef, wakeDeliveryToken, type GithubReviewActivity, type PrRef } from "./scheduler.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { FenceView, SessionTelemetry, Tailer, TurnState } from "./tailer.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

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

function awaiting(hint: NonNullable<FenceView["hint"]>, body = ""): FenceView {
  return { kind: "awaiting", body, hint }
}

function tele(fence?: FenceView, turn: TurnState = "idle", fenceAt?: string): SessionTelemetry {
  return {
    turn,
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    lastFence: fence && fenceAt ? { ...fence, at: fenceAt } : fence,
    lastActivityAt: fenceAt,
    lastAssistantAt: fenceAt,
  }
}

function fakeTailer(map: Map<string, SessionTelemetry>): Tailer {
  return {
    get: (slug) => map.get(slug),
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
  telemetry: Map<string, SessionTelemetry>
  resumes: { slug: string; message: string; deliveryId: string }[]
  review: { result: GithubReviewActivity[] | undefined; calls: PrRef[] }
  clock: { ms: number }
  make(over?: Partial<Parameters<typeof createScheduler>[0]>): ReturnType<typeof createScheduler>
}

function harness(): Harness {
  const storage = tmpStorage()
  const telemetry = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId: string }[] = []
  const review: { result: GithubReviewActivity[] | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  return {
    storage,
    telemetry,
    resumes,
    review,
    clock,
    make(over) {
      return createScheduler({
        storage,
        tailer: fakeTailer(telemetry),
        resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
        now: () => clock.ms,
        fetchGithubReview: async (ref) => {
          review.calls.push(ref)
          return review.result
        },
        pollMs: 0,
        log: () => {},
        ...over,
      })
    },
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

function installWait(
  h: Harness,
  slug: string,
  hint: NonNullable<FenceView["hint"]>,
  body = "",
  confirmedAt = iso(h.clock.ms),
): { fence: FenceView; fenceAt: string; fenceId: string } {
  const fenceAt = iso(h.clock.ms - 1_000)
  const fence = awaiting(hint, body)
  const fenceId = awaitingFenceIdentity(hint, fenceAt)
  h.storage.upsertSession(row(slug))
  h.telemetry.set(slug, tele(fence, "idle", fenceAt))
  assert.equal(
    h.storage.confirmAwaitingWait(
      slug,
      `sid-${slug}`,
      0,
      fenceId,
      confirmedAt,
      hint.kind === "timer" ? hint.value : null,
    ),
    true,
  )
  return { fence, fenceAt, fenceId }
}

test("parsePrRef accepts only canonical PR targets", () => {
  assert.deepEqual(parsePrRef("acme/app#391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("https://github.com/acme/app/pull/391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("acme/app.git#12"), { owner: "acme", repo: "app", number: 12 })
  assert.equal(parsePrRef("https://github.com/acme/app/actions/runs/123"), undefined)
  assert.equal(parsePrRef("acme/app#0"), undefined)
  assert.equal(parsePrRef("prefix acme/app#1 suffix"), undefined)
})

test("GitHub activity normalization preserves actor type for bot filtering", () => {
  const activities = parseGithubReviewActivities({
    data: { repository: { pullRequest: {
      reviews: { nodes: [{ id: "R1", submittedAt: "2026-07-09T12:01:00Z", author: { login: "alice", __typename: "User" } }] },
      comments: { nodes: [{ id: "C1", createdAt: "2026-07-09T12:02:00Z", author: { login: "dependabot[bot]", __typename: "Bot" } }] },
    } } },
  })
  assert.deepEqual(activities.map((activity) => [activity.id, activity.actor, activity.actorType, activity.kind]), [
    ["review:R1", "alice", "User", "review"],
    ["comment:C1", "dependabot[bot]", "Bot", "comment"],
  ])
})

test("an unconfirmed timer proposal never arms or fires", async () => {
  const h = harness()
  const target = h.clock.ms + 1_000
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("timer"))
  h.telemetry.set("timer", tele(awaiting({ kind: "timer", value: iso(target) }), "idle", fenceAt))
  await h.make().tick()
  h.clock.ms = target + 1
  await h.make().tick()
  assert.deepEqual(h.resumes, [])
  assert.equal(createWakeDeliveryStore(h.storage.db).list().length, 0)
})

test("a confirmed timer crosses during downtime, wakes once, and clears the registration", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  installWait(h, "timer", { kind: "timer", value: iso(target) }, "Re-check the rollout.")
  h.clock.ms = target + 60_000
  await h.make().tick()
  await h.make().tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].message, "⏰ Your timer fired: Re-check the rollout.. Continue.")
  const stored = h.storage.getSession("timer")!
  assert.equal(stored.awaiting_fence_id, null)
  assert.equal(stored.awaiting_confirmed_at, null)
  assert.equal(stored.snoozed_until, null)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
})

test("a superseding final message clears a stale confirmation without delivering", async () => {
  const h = harness()
  installWait(h, "stale", { kind: "timer", value: iso(h.clock.ms + 1_000) })
  h.telemetry.set("stale", tele({ kind: "done", body: "Changed course." }, "idle", iso(h.clock.ms + 1)))
  await h.make().tick()
  assert.equal(h.storage.getSession("stale")?.awaiting_fence_id, null)
  assert.deepEqual(h.resumes, [])
})

test("a review proposal does not poll GitHub until it is confirmed", async () => {
  const h = harness()
  const hint = { kind: "github-review" as const, value: "acme/app#391" }
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("review"))
  h.telemetry.set("review", tele(awaiting(hint), "idle", fenceAt))
  h.review.result = []
  await h.make().tick()
  assert.equal(h.review.calls.length, 0)
  assert.equal(h.storage.confirmAwaitingWait("review", "sid-review", 0, awaitingFenceIdentity(hint, fenceAt), iso(h.clock.ms), null), true)
  await h.make().tick()
  assert.equal(h.review.calls.length, 1)
})

test("review confirmation baselines earlier activity, ignores bots, then wakes on a new human event across restart", async () => {
  const h = harness()
  const confirmedAt = iso(h.clock.ms)
  installWait(h, "review", { kind: "github-review", value: "acme/app#391" }, "Alice must review the PR.", confirmedAt)
  const old: GithubReviewActivity = {
    id: "review:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 1_000), kind: "review",
  }
  h.review.result = [old]
  await h.make().tick()
  assert.equal(h.resumes.length, 0)
  h.review.result = [
    { id: "comment:bot", actor: "dependabot[bot]", actorType: "Bot", at: iso(h.clock.ms + 1_000), kind: "comment" },
    old,
  ]
  await h.make().tick()
  assert.equal(h.resumes.length, 0)
  h.clock.ms += 10_000
  h.review.result = [
    { id: "review:new", actor: "bob", actorType: "User", at: iso(h.clock.ms), kind: "review" },
    old,
  ]
  await h.make().tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@bob/)
})

test("review activity that lands after confirmation but before the first poll is not lost", async () => {
  const h = harness()
  installWait(h, "race", { kind: "github-review", value: "acme/app#391" })
  h.review.result = [{
    id: "comment:fresh", actor: "alice", actorType: "User", at: iso(h.clock.ms + 1), kind: "comment",
  }]
  h.clock.ms += 2
  await h.make().tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /comment activity.*@alice/)
})

test("first review poll cannot miss GitHub activity in the confirmation's second", async () => {
  const h = harness()
  h.clock.ms = Date.parse("2026-07-09T12:00:00.500Z")
  installWait(h, "second-resolution", { kind: "github-review", value: "acme/app#391" })
  h.review.result = [{
    id: "review:same-second", actor: "alice", actorType: "User",
    at: "2026-07-09T12:00:00Z", kind: "review",
  }]
  await h.make().tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@alice/)
})

test("a started scheduler arms the exact timer instead of waiting for its reconciliation interval", async () => {
  const h = harness()
  h.clock.ms = Date.now()
  const target = h.clock.ms + 300
  installWait(h, "exact-deadline", { kind: "timer", value: iso(target) })
  const scheduler = h.make({ now: Date.now, tickMs: 60_000 })
  scheduler.start()
  try {
    const timeout = Date.now() + 3_000
    while (h.resumes.length === 0 && Date.now() < timeout) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(h.resumes.length, 1, "the dedicated deadline fires without the 60 second fallback tick")
  } finally {
    await scheduler.stop()
  }
})

test("hard crash after enqueue recovers the pending wake on restart", async () => {
  const h = harness()
  const target = h.clock.ms + 1_000
  installWait(h, "enqueue-crash", { kind: "timer", value: iso(target) })
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-enqueue") throw new Error("SIGKILL after enqueue")
    },
  })
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "pending")
  assert.equal(h.resumes.length, 0)
  await h.make().tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
})

test("a transcript token confirms an ambiguous delivery after a process crash without replay", async () => {
  const h = harness()
  const target = h.clock.ms + 1_000
  const { fence, fenceAt } = installWait(h, "delivery-crash", { kind: "timer", value: iso(target) })
  let deliveredId = ""
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => { deliveredId = deliveryId },
    crashPoint: (point) => {
      if (point === "after-delivery") throw new Error("SIGKILL after terminal input")
    },
  })
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  h.telemetry.set("delivery-crash", {
    ...tele(fence, "idle", fenceAt),
    lastUserText: `accepted ${wakeDeliveryToken(deliveredId)}`,
  })
  h.clock.ms += 101
  await h.make({ deliveryLeaseMs: 100 }).tick()
  assert.equal(createWakeDeliveryStore(h.storage.db).list()[0].state, "delivered")
  assert.equal(h.storage.getSession("delivery-crash")?.awaiting_fence_id, null)
})

test("delivery failures retry on bounded leases and eventually succeed", async () => {
  const h = harness()
  const target = h.clock.ms + 1_000
  installWait(h, "retry", { kind: "timer", value: iso(target) })
  let attempts = 0
  const scheduler = h.make({
    deliveryLeaseMs: 10,
    retryBaseMs: 10,
    resume: (slug, message, deliveryId) => {
      attempts++
      if (attempts === 1) throw new Error("terminal unavailable")
      h.resumes.push({ slug, message, deliveryId })
    },
  })
  h.clock.ms = target + 1
  await scheduler.tick()
  assert.equal(attempts, 1)
  h.clock.ms += 10
  await scheduler.tick()
  assert.equal(attempts, 2)
  assert.equal(h.resumes.length, 1)
})

test("two scheduler instances atomically claim one confirmed timer delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-sched-concurrent-"))
  const path = join(dir, "ui.db")
  const firstStorage = createStorage(path)
  const secondStorage = createStorage(path)
  const telemetry = new Map<string, SessionTelemetry>()
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const target = clock.ms + 1_000
  const hint = { kind: "timer" as const, value: iso(target) }
  const fenceAt = iso(clock.ms)
  firstStorage.upsertSession(row("concurrent"))
  telemetry.set("concurrent", tele(awaiting(hint), "idle", fenceAt))
  assert.equal(firstStorage.confirmAwaitingWait(
    "concurrent", "sid-concurrent", 0, awaitingFenceIdentity(hint, fenceAt), iso(clock.ms), hint.value,
  ), true)
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
    fetchGithubReview: async () => undefined,
    log: () => {},
  })
  const first = make(firstStorage)
  const second = make(secondStorage)
  clock.ms = target + 1
  const firstTick = first.tick()
  const secondTick = second.tick()
  await began
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(deliveries.length, 1)
  release()
  await Promise.all([firstTick, secondTick])
  assert.equal(createWakeDeliveryStore(secondStorage.db).list()[0].state, "delivered")
  secondStorage.close()
  firstStorage.close()
})

test("scheduler stop rejects new ticks and drains an in-flight delivery", async () => {
  const h = harness()
  const target = h.clock.ms + 1_000
  installWait(h, "shutdown", { kind: "timer", value: iso(target) })
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const began = new Promise<void>((resolve) => { started = resolve })
  const scheduler = h.make({
    resume: async () => { started(); await gate },
  })
  h.clock.ms = target + 1
  const tick = scheduler.tick()
  await began
  const stop = scheduler.stop()
  await assert.rejects(scheduler.tick(), /wake scheduler is shutting down/)
  release()
  await Promise.all([tick, stop])
})
