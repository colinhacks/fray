import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promisify } from "node:util"
import type { AwaitingHint } from "@fray-ui/shared"
import { awaitingFenceIdentity, isActionableAwaitingHint, parsePrRef, prRefKey, type PrRef } from "./awaiting.ts"
import type { Storage, SessionRow } from "./storage.ts"
import type { FenceView, Tailer } from "./tailer.ts"
import { createWakeDeliveryStore, type WakeDelivery } from "./wake-store.ts"
import { ProducerStoppedError } from "./shutdown.ts"

const execFileAsync = promisify(execFile)

export { parsePrRef, type PrRef }

export interface GithubReviewActivity {
  id: string
  actor: string
  actorType?: string
  at?: string
  kind: "review" | "comment"
}

const REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 50) { nodes { id submittedAt author { login __typename } } }
      comments(last: 50) { nodes { id createdAt author { login __typename } } }
    }
  }
}`

export function parseGithubReviewActivities(raw: unknown): GithubReviewActivity[] {
  const pr = (raw as any)?.data?.repository?.pullRequest
  if (!pr || typeof pr !== "object") return []
  const out: GithubReviewActivity[] = []
  const add = (nodes: unknown, kind: "review" | "comment", atKey: "submittedAt" | "createdAt") => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue
      const value = node as Record<string, unknown>
      const author = value.author && typeof value.author === "object"
        ? value.author as Record<string, unknown>
        : undefined
      if (typeof value.id !== "string" || !value.id || typeof author?.login !== "string" || !author.login) continue
      out.push({
        id: `${kind}:${value.id}`,
        actor: author.login,
        actorType: typeof author.__typename === "string" ? author.__typename : undefined,
        at: typeof value[atKey] === "string" ? value[atKey] as string : undefined,
        kind,
      })
    }
  }
  add((pr as any)?.reviews?.nodes, "review", "submittedAt")
  add((pr as any)?.comments?.nodes, "comment", "createdAt")
  return out
}

export function isNonBotGithubActivity(activity: GithubReviewActivity): boolean {
  return activity.actorType?.toLowerCase() !== "bot" && !activity.actor.toLowerCase().endsWith("[bot]")
}

async function defaultFetchGithubReview(ref: PrRef): Promise<GithubReviewActivity[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api", "graphql", "-f", `query=${REVIEW_QUERY}`,
        "-F", `owner=${ref.owner}`, "-F", `repo=${ref.repo}`, "-F", `number=${ref.number}`,
      ],
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const parsed = JSON.parse(stdout) as unknown
    if (!(parsed as any)?.data?.repository?.pullRequest) return undefined
    return parseGithubReviewActivities(parsed)
  } catch {
    return undefined
  }
}

export function wakeDeliveryToken(id: string): string {
  return `<!-- fray-wake:${id} -->`
}

function wakeDeliveryId(slug: string, sessionId: string, registrationId: string): string {
  return createHash("sha256")
    .update(slug).update("\0").update(sessionId).update("\0").update(registrationId)
    .digest("hex")
}

function registrationIdentity(row: Pick<SessionRow, "awaiting_fence_id" | "awaiting_confirmed_at">): string | undefined {
  return row.awaiting_fence_id && row.awaiting_confirmed_at
    ? `${row.awaiting_fence_id}\u0001${row.awaiting_confirmed_at}`
    : undefined
}

interface ReviewCursor {
  key: string
  seen: string[]
  pending?: GithubReviewActivity
}

interface ThreadWake {
  registrationId: string
  lastPollAt: number
  reviewCache?: GithubReviewActivity[]
}

interface Verdict {
  message: string
  reason: string
}

const REVIEW_CURSOR_SETTING = "waker.review-cursors.v1"
const REVIEW_CURSOR_CAP = 500
const REVIEW_SEEN_CAP = 300

export interface SchedulerDeps {
  storage: Storage
  tailer: Tailer
  resume: (slug: string, message: string, deliveryId: string, sessionId: string) => void | Promise<void>
  now?: () => number
  fetchGithubReview?: (ref: PrRef) => Promise<GithubReviewActivity[] | undefined>
  log?: (message: string) => void
  tickMs?: number
  pollMs?: number
  deliveryLeaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  maxDeliveryAttempts?: number
  deliveryBatchSize?: number
  onWaitChange?: () => void
  crashPoint?: (point: SchedulerCrashPoint, delivery: WakeDelivery) => void
}

export type SchedulerCrashPoint = "after-enqueue" | "after-claim" | "after-delivery" | "after-ack"

export interface Scheduler {
  start(): void
  stop(): Promise<void>
  tick(): Promise<void>
  waitChanged(timerAt?: number): void
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  const fetchGithubReview = deps.fetchGithubReview ?? defaultFetchGithubReview
  const log = deps.log ?? ((message: string) => console.log(`[fray-ui] ${message}`))
  const tickMs = deps.tickMs ?? 10_000
  const pollMs = deps.pollMs ?? 60_000
  const deliveryLeaseMs = Math.max(1, deps.deliveryLeaseMs ?? 30_000)
  const retryBaseMs = Math.max(1, deps.retryBaseMs ?? 5_000)
  const retryMaxMs = Math.max(retryBaseMs, deps.retryMaxMs ?? 5 * 60_000)
  const maxDeliveryAttempts = Math.max(1, deps.maxDeliveryAttempts ?? 6)
  const deliveryBatchSize = Math.max(0, deps.deliveryBatchSize ?? 50)
  const deliveryOwner = randomUUID()
  const outbox = createWakeDeliveryStore(deps.storage.db)
  const threads = new Map<string, ThreadWake>()
  const cursors = new Map(loadReviewCursors().map((cursor) => [cursor.key, cursor]))
  let timer: NodeJS.Timeout | null = null
  let deadlineTimer: NodeJS.Timeout | null = null
  let deadlineAt: number | null = null
  let activeTick: Promise<void> | null = null
  let rerunRequested = false
  let started = false
  let stopped = false

  function armDeadline(at?: number): void {
    if (!started || stopped) return
    if (deadlineTimer && deadlineAt === at) return
    if (deadlineTimer) clearTimeout(deadlineTimer)
    deadlineTimer = null
    deadlineAt = null
    if (at === undefined || !Number.isFinite(at)) return
    deadlineAt = at
    // Node clamps larger delays to 1ms. Cap them explicitly and rescan at the cap instead.
    const delay = Math.min(Math.max(0, at - now()), 2_147_483_647)
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null
      deadlineAt = null
      void tick().catch((error) => log(`waker: deadline tick failed: ${error instanceof Error ? error.message : String(error)}`))
    }, delay)
    deadlineTimer.unref?.()
  }

  function loadReviewCursors(): ReviewCursor[] {
    const raw = deps.storage.getSetting(REVIEW_CURSOR_SETTING)
    if (!Array.isArray(raw)) return []
    const result: ReviewCursor[] = []
    for (const item of raw.slice(-REVIEW_CURSOR_CAP)) {
      if (!item || typeof item !== "object") continue
      const value = item as Record<string, unknown>
      if (typeof value.key !== "string" || !value.key || !Array.isArray(value.seen)) continue
      const seen = value.seen.filter((id): id is string => typeof id === "string").slice(0, REVIEW_SEEN_CAP)
      const candidate = value.pending as Record<string, unknown> | undefined
      const pending = candidate && typeof candidate.id === "string" && typeof candidate.actor === "string" &&
        (candidate.kind === "review" || candidate.kind === "comment")
        ? {
            id: candidate.id,
            actor: candidate.actor,
            actorType: typeof candidate.actorType === "string" ? candidate.actorType : undefined,
            at: typeof candidate.at === "string" ? candidate.at : undefined,
            kind: candidate.kind,
          } satisfies GithubReviewActivity
        : undefined
      result.push({ key: value.key, seen, ...(pending && isNonBotGithubActivity(pending) ? { pending } : {}) })
    }
    return result
  }

  function saveReviewCursors(): void {
    deps.storage.setSetting(REVIEW_CURSOR_SETTING, [...cursors.values()].slice(-REVIEW_CURSOR_CAP))
  }

  function saveReviewCursor(key: string, seen: string[], pending?: GithubReviewActivity): void {
    const next: ReviewCursor = { key, seen: [...new Set(seen)].slice(0, REVIEW_SEEN_CAP), ...(pending ? { pending } : {}) }
    if (JSON.stringify(cursors.get(key) ?? null) === JSON.stringify(next)) return
    cursors.set(key, next)
    while (cursors.size > REVIEW_CURSOR_CAP) cursors.delete(cursors.keys().next().value!)
    saveReviewCursors()
  }

  function forgetReviewCursor(key: string): void {
    if (cursors.delete(key)) saveReviewCursors()
  }

  class InjectedSchedulerCrash extends Error {
    constructor(cause: unknown) {
      super("simulated scheduler hard crash", { cause })
    }
  }

  function checkpoint(point: SchedulerCrashPoint, item: WakeDelivery): void {
    if (!deps.crashPoint) return
    try {
      deps.crashPoint(point, item)
    } catch (error) {
      throw new InjectedSchedulerCrash(error)
    }
  }

  function retryDelay(attempts: number): number {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, Math.min(30, attempts - 1)))
  }

  function currentRegistration(row: SessionRow, fence: FenceView | undefined, fenceAt: string | undefined): string | undefined {
    if (fence?.kind !== "awaiting" || !isActionableAwaitingHint(fence.hint) || !fenceAt) return undefined
    const fenceId = awaitingFenceIdentity(fence.hint, fenceAt)
    if (row.awaiting_fence_id !== fenceId) return undefined
    return registrationIdentity(row)
  }

  function finishWait(item: WakeDelivery): void {
    const row = deps.storage.getSession(item.slug)
    if (!row || registrationIdentity(row) !== item.fenceId || !row.awaiting_fence_id) return
    if (deps.storage.clearAwaitingWaitIfCurrent(item.slug, item.sessionId, row.awaiting_fence_id)) {
      forgetReviewCursor(item.fenceId)
      deps.onWaitChange?.()
    }
  }

  type DeliveryContext = "confirmed" | "superseded" | "current-idle" | "current-busy" | "unknown"

  function deliveryContext(item: WakeDelivery): DeliveryContext {
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId || row.state === "archived" || row.archived === 1) return "superseded"
    const tele = deps.tailer.get(item.slug)
    if (!tele) return "unknown"
    if (tele.lastUserText?.includes(wakeDeliveryToken(item.id))) return "confirmed"
    if (currentRegistration(row, tele.lastFence, tele.lastFence?.at) !== item.fenceId) return "superseded"
    return tele.turn === "idle" ? "current-idle" : "current-busy"
  }

  function reviewVerdict(
    registrationId: string,
    hint: AwaitingHint,
    activities: GithubReviewActivity[],
    confirmedAt: string,
  ): Verdict | undefined {
    const ref = parsePrRef(hint.value)
    if (!ref) return undefined
    const prior = cursors.get(registrationId)
    if (prior?.pending) {
      return {
        message: `👤 New human GitHub ${prior.pending.kind} activity on ${prRefKey(ref)} from @${prior.pending.actor}. Re-open the review/comments and continue.`,
        reason: `github review ${prRefKey(ref)} by ${prior.pending.actor}`,
      }
    }
    const human = activities.filter(isNonBotGithubActivity).sort((a, b) => {
      const delta = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
      return Number.isFinite(delta) && delta !== 0 ? delta : b.id.localeCompare(a.id)
    })
    const seen = new Set(prior?.seen ?? [])
    const confirmedMs = Date.parse(confirmedAt)
    const fresh = prior
      ? human.filter((activity) => !seen.has(activity.id))
      : human.filter((activity) => {
          const activityMs = Date.parse(activity.at ?? "")
          // GitHub timestamps are only second-resolution. Bias the first baseline toward never
          // permanently missing an event that landed later in the confirmation's wall-clock second.
          const confirmedSecond = Math.floor(confirmedMs / 1_000) * 1_000
          return Number.isFinite(confirmedMs) && Number.isFinite(activityMs) && activityMs >= confirmedSecond
        })
    if (fresh.length === 0) {
      saveReviewCursor(registrationId, [...human.map((activity) => activity.id), ...(prior?.seen ?? [])])
      return undefined
    }
    const newest = fresh[0]
    saveReviewCursor(registrationId, [...human.map((activity) => activity.id), ...(prior?.seen ?? [])], newest)
    return {
      message: `👤 New human GitHub ${newest.kind} activity on ${prRefKey(ref)} from @${newest.actor}. Re-open the review/comments and continue.`,
      reason: `github review ${prRefKey(ref)} by ${newest.actor}`,
    }
  }

  async function evalThread(row: SessionRow, fence: FenceView, registrationId: string, nowMs: number): Promise<void> {
    const hint = fence.hint
    if (!isActionableAwaitingHint(hint) || !row.awaiting_confirmed_at) return
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, registrationId)
    const existing = outbox.get(deliveryId)
    if (existing) {
      if (existing.state === "delivered") finishWait(existing)
      return
    }

    let verdict: Verdict | undefined
    if (hint.kind === "timer") {
      if (nowMs < Date.parse(hint.value)) return
      const description = fence.body.trim().replace(/\s+/g, " ").slice(0, 200)
      verdict = {
        message: `⏰ Your timer fired${description ? `: ${description}` : ""}. Continue.`,
        reason: `timer ${hint.value}`,
      }
    } else {
      const ref = parsePrRef(hint.value)
      if (!ref) return
      let state = threads.get(row.slug)
      if (!state || state.registrationId !== registrationId) {
        state = { registrationId, lastPollAt: 0 }
        threads.set(row.slug, state)
      }
      const pending = cursors.get(registrationId)?.pending
      if (!pending && (state.lastPollAt === 0 || nowMs - state.lastPollAt >= pollMs)) {
        state.lastPollAt = nowMs
        try {
          const activity = await fetchGithubReview(ref)
          if (activity) state.reviewCache = activity
          else log(`waker: GitHub review check skipped for ${prRefKey(ref)} (${row.slug}) — gh unavailable / not authed / rate-limited`)
        } catch (error) {
          log(`waker: GitHub review check errored for ${prRefKey(ref)} (${row.slug}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!state.reviewCache && !pending) return
      verdict = reviewVerdict(registrationId, hint, state.reviewCache ?? [], row.awaiting_confirmed_at)
    }
    if (!verdict) return
    const item = outbox.enqueue({
      id: deliveryId,
      slug: row.slug,
      sessionId: row.session_id,
      fenceId: registrationId,
      hintKey: `${hint.kind}:${hint.value}`,
      message: verdict.message,
      reason: verdict.reason,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${verdict.reason}`)
    checkpoint("after-enqueue", item)
  }

  function reconcileOutbox(nowMs: number): void {
    for (const item of outbox.listOpen()) {
      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, nowMs)
        finishWait(item)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, nowMs, "the exact confirmed awaiting wait or session was superseded")
        finishWait(item)
        continue
      }
      if (item.state !== "leased" || item.leaseUntil === null || item.leaseUntil > nowMs) continue
      if (context !== "current-idle") continue
      const recovered = outbox.recoverExpired(
        item.id, nowMs, nowMs, maxDeliveryAttempts,
        item.lastError ?? "delivery lease expired before acknowledgement",
      )
      if (recovered?.state === "exhausted") {
        log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
        finishWait(recovered)
      }
    }
  }

  async function deliverDue(): Promise<void> {
    for (let delivered = 0; delivered < deliveryBatchSize; delivered++) {
      const claimedAt = now()
      const item = outbox.claim(deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (!item) return
      checkpoint("after-claim", item)
      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, now())
        finishWait(item)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, now(), "the exact confirmed awaiting wait or session was superseded before delivery")
        finishWait(item)
        continue
      }
      if (context !== "current-idle") {
        const deferredAt = now()
        outbox.deferFailure(
          item.id, deliveryOwner, deferredAt,
          deferredAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          "delivery deferred until exact awaiting telemetry is idle and available",
        )
        continue
      }
      log(`waker: delivering ${item.slug} — ${item.reason} (attempt ${item.attempts})`)
      try {
        await deps.resume(item.slug, item.message, item.id, item.sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failedAt = now()
        if ((error as { terminalDelivery?: unknown })?.terminalDelivery === true) {
          outbox.supersede(item.id, failedAt, message)
          finishWait(item)
          log(`waker: delivery ABANDONED for ${item.slug} (terminal, no retry): ${message}`)
          continue
        }
        outbox.deferFailure(
          item.id, deliveryOwner, failedAt,
          failedAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)), message,
        )
        log(`waker: delivery FAILED for ${item.slug}: ${message}`)
        continue
      }
      checkpoint("after-delivery", item)
      if (!outbox.acknowledge(item.id, deliveryOwner, now())) {
        log(`waker: delivery acknowledgement lost ownership for ${item.slug}; preserving the authoritative terminal state`)
        continue
      }
      const acknowledged = outbox.get(item.id)
      if (acknowledged) checkpoint("after-ack", acknowledged)
      finishWait(item)
    }
  }

  async function runTick(): Promise<void> {
    const nowMs = now()
    const seen = new Set<string>()
    let nearestTimer: number | undefined
    for (const row of deps.storage.allSessions()) {
      const tele = deps.tailer.get(row.slug)
      const registrationId = currentRegistration(row, tele?.lastFence, tele?.lastFence?.at)
      if (row.awaiting_fence_id && !registrationId) {
        if (deps.storage.clearAwaitingWaitIfCurrent(row.slug, row.session_id, row.awaiting_fence_id)) {
          const staleRegistrationId = registrationIdentity(row)
          if (staleRegistrationId) forgetReviewCursor(staleRegistrationId)
          deps.onWaitChange?.()
        }
      }
      if (
        !registrationId || !tele || tele.turn !== "idle" ||
        row.state === "archived" || row.archived === 1 || tele.lastFence?.kind !== "awaiting"
      ) continue
      seen.add(row.slug)
      if (tele.lastFence.hint?.kind === "timer") {
        const target = Date.parse(tele.lastFence.hint.value)
        if (Number.isFinite(target) && target > nowMs && (nearestTimer === undefined || target < nearestTimer)) {
          nearestTimer = target
        }
      }
      try {
        await evalThread(row, tele.lastFence, registrationId, nowMs)
      } catch (error) {
        if (error instanceof InjectedSchedulerCrash) throw error
        log(`waker: tick error for ${row.slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const [slug, state] of [...threads]) {
      if (seen.has(slug)) continue
      forgetReviewCursor(state.registrationId)
      threads.delete(slug)
    }
    reconcileOutbox(now())
    await deliverDue()
    armDeadline(nearestTimer)
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.reject(new ProducerStoppedError("wake scheduler"))
    if (activeTick) {
      rerunRequested = true
      return activeTick
    }
    const task = (async () => {
      do {
        rerunRequested = false
        await runTick()
      } while (rerunRequested && !stopped)
    })()
    activeTick = task
    task.then(
      () => { if (activeTick === task) activeTick = null },
      () => { if (activeTick === task) activeTick = null },
    )
    return task
  }

  return {
    start() {
      if (timer) return
      if (stopped) throw new ProducerStoppedError("wake scheduler")
      started = true
      void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      timer = setInterval(() => {
        void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      }, tickMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      started = false
      if (timer) clearInterval(timer)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      timer = null
      deadlineTimer = null
      deadlineAt = null
      if (activeTick) await activeTick
    },
    tick,
    waitChanged(timerAt) {
      if (stopped) return
      if (timerAt !== undefined && (deadlineAt === null || timerAt < deadlineAt)) armDeadline(timerAt)
      void tick().catch((error) => log(`waker: wait-change tick failed: ${error instanceof Error ? error.message : String(error)}`))
    },
  }
}
