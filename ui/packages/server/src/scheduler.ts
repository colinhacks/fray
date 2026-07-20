import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { isValidAwaitingTimer } from "@fray-ui/shared"
import type { Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import type { FenceView } from "./tailer.ts"
import { createWakeDeliveryStore, type WakeDelivery } from "./wake-store.ts"
import { ProducerStoppedError } from "./shutdown.ts"

const execFileAsync = promisify(execFile)

// ---- DURABLE TIMER WAKER + LEGACY COMPATIBILITY --------------------------------------------------
// New workers reserve `awaiting` for a specific external HUMAN gate (`human:`), an optional durable
// GitHub cursor for that gate (`github-review:`), or a wall-clock checkpoint (`timer:`). A plain human
// gate is descriptive; github-review wakes on NEW non-bot human activity after this fence, while a
// registered timer remains durable across server/worker restarts and resumes when it crosses. Historical transcripts may
// still carry `pr:`/`ci:` hints, so their existing out-of-band wake behavior remains as a compatibility
// bridge. New automated waits should instead stay ACTIVE through Bash/Monitor (Claude) or a blocking
// exec wait (Codex). The resumed turn supersedes the fence, naturally making the wake idempotent.
//
// ---- THE BOOT-MASS-FIRE SAFETY GUARD (critical — the maintainer has ~14 real sessions) ----
// We fire ONLY on a wait registered by this scheduler, or a legacy condition we witness transition
// from UNMET → MET. Future timers and GitHub-review baselines are PERSISTED before they can fire, so a
// crossing/activity during downtime still wakes after restart. An already-past UNREGISTERED timer (an
// old transcript inherited during migration) never fires, preserving the boot no-mass-resume guard.
// Legacy pr/ci hints remain in-memory transition watches only. Once a condition fires, a deterministic
// SQLite outbox row is committed BEFORE terminal delivery. Atomic leases serialize multiple scheduler
// instances; delivery acknowledgement, transcript-token confirmation, and exact-fence supersession
// produce explicit terminal states. A crash leaves pending/leased work recoverable instead of burning
// a fired bit before the wake crossed tmux.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// The distilled PR status we act on (from one `gh pr view … --json state,mergedAt,statusCheckRollup`).
export interface PrStatus {
  state: string // OPEN | CLOSED | MERGED
  mergedAt: string | null
  rollup: RollupEntry[] // statusCheckRollup entries (CheckRun and/or StatusContext shapes)
  // Workflow runs queried by the PR's exact head SHA. statusCheckRollup can omit a fork-gated
  // ACTION_REQUIRED run, so it is never sufficient evidence that a legacy `ci:` fence passed.
  workflowRuns?: WorkflowRun[]
}

export interface WorkflowRun {
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string | null
  databaseId?: number
  event?: string
  createdAt?: string
}

// One review-relevant GitHub activity item. The default fetcher collects submitted PR reviews and PR
// conversation comments. Tests inject this normalized shape directly; ids are source-namespaced and
// stable, so a persisted seen-set is a durable cursor across process restarts.
export interface GithubReviewActivity {
  id: string
  actor: string
  actorType?: string
  at?: string
  kind: "review" | "comment"
}
interface RollupEntry {
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | PENDING | WAITING
  conclusion?: string // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ACTION_REQUIRED | SKIPPED | STALE
  state?: string // StatusContext: PENDING | SUCCESS | FAILURE | ERROR | EXPECTED
}

// Parse a PR reference out of a hint value: `owner/repo#123` or a GitHub PR URL. Undefined when neither
// shape matches (e.g. an actions-run URL with no PR number) → that hint is simply not actionable.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/
export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}
function refKey(r: PrRef): string {
  return `${r.owner}/${r.repo}#${r.number}`
}

// `gh pr view` does not accept owner/repo#N as its positional selector. Pin the CLI-compatible shape:
// numeric selector plus an explicit repository. Kept pure/exported so a regression cannot silently
// turn every healthy legacy PR/CI poll into an "unavailable" result again.
export function ghPrViewArgs(ref: PrRef): string[] {
  return ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,mergedAt,statusCheckRollup,headRefOid"]
}

// Retries preserve obsolete failed/ACTION_REQUIRED runs on the same SHA. Match the plugin monitor:
// the newest run for a workflow/event is the current verdict, not the oldest blocked attempt.
export function latestWorkflowRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>()
  for (const run of runs) {
    if (!run || typeof run !== "object") continue
    const key = `${run.workflowName ?? run.name ?? "unknown"}\u0000${run.event ?? ""}`
    const old = latest.get(key)
    const stamp = String(run.createdAt ?? "")
    const oldStamp = String(old?.createdAt ?? "")
    const id = Number(run.databaseId ?? 0)
    const oldId = Number(old?.databaseId ?? 0)
    if (!old || stamp > oldStamp || (stamp === oldStamp && id > oldId)) latest.set(key, run)
  }
  return [...latest.values()]
}

// Reduce a statusCheckRollup to a terminal verdict. `done` = every check has reached a terminal state
// (nothing queued/in-progress/pending); `ok` = none concluded in failure. An EMPTY rollup is treated
// as still-pending (no checks reported yet) so a `ci:` wait never fires before any check exists.
export function evalRollup(rollup: RollupEntry[]): { done: boolean; ok: boolean } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { done: false, ok: false }
  let pending = false
  let failed = false
  for (const c of rollup) {
    if (!c || typeof c !== "object") continue
    const status = typeof c.status === "string" ? c.status : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    // An entry is terminal ONLY if it AFFIRMATIVELY says so: a CheckRun with status COMPLETED, or a
    // StatusContext whose state is a settled value. An entry we can't classify (no recognizable
    // status/state — a `{}` or a future/unknown shape) is treated as still-PENDING, never as
    // done+green — so a shape surprise can never launder a `ci:` wait into a false "green" fire.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) pending = true
    const bad =
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED" ||
      conclusion === "ACTION_REQUIRED" ||
      conclusion === "STARTUP_FAILURE" ||
      state === "FAILURE" ||
      state === "ERROR"
    if (bad) failed = true
  }
  return { done: !pending, ok: !failed }
}

// Is a hint one this scheduler can act on? A current STRICT ISO `timer:`, a machine-readable
// `github-review:` PR ref, plus legacy `pr:`/`ci:` refs. `human:` is descriptive by definition and
// `session:` has no cross-session liveness signal, so neither is resolved here.
function isActionable(hint: FenceView["hints"][number]): boolean {
  if (hint.kind === "timer") return isValidAwaitingTimer(hint.value)
  if (hint.kind === "github-review" || hint.kind === "pr" || hint.kind === "ci") return parsePrRef(hint.value) !== undefined
  return false
}

// A stable identity for the CURRENT awaiting rest of a thread: the sorted set of its actionable hints.
// A different set (the agent re-awaits something new) is a fresh arming cycle; the same set across ticks
// (and across a restart — hints are derived deterministically from the JSONL) is the same wait.
function fenceIdentity(hints: FenceView["hints"], fenceAt?: string): string {
  const hintId = hints
    .filter(isActionable)
    .map((h) => `${h.kind}:${h.value}`)
    .sort()
    .join("|")
  // The final-message timestamp is the generation id. Re-emitting the SAME hint after a follow-up is
  // a fresh wait/baseline even if the scheduler did not happen to tick while the old fence was clear.
  return `${fenceAt ?? ""}\u0001${hintId}`
}

function wakeDeliveryId(slug: string, sessionId: string, fenceId: string): string {
  return createHash("sha256").update(slug).update("\0").update(sessionId).update("\0").update(fenceId).digest("hex")
}

export function wakeDeliveryToken(id: string): string {
  return `<!-- fray-wake:${id} -->`
}

// A single hint's verdict this tick: met? + the steer to send when it fires. `undefined` = indeterminate
// (a PR fetch we couldn't complete) → neither arm nor fire; try again next poll.
interface Verdict {
  met: boolean
  steer: string
  reason: string
}
function evalHint(hint: FenceView["hints"][number], nowMs: number, prCache: Map<string, PrStatus>, fenceBody: string): Verdict | undefined {
  if (hint.kind === "timer") {
    const target = Date.parse(hint.value)
    if (!isValidAwaitingTimer(hint.value) || !Number.isFinite(target)) return undefined
    const desc = fenceBody.trim().replace(/\s+/g, " ").slice(0, 200)
    return { met: nowMs >= target, steer: `⏰ Your timer fired${desc ? `: ${desc}` : ""}. Continue.`, reason: `timer ${hint.value}` }
  }
  if (hint.kind === "github-review") return undefined // evaluated against its persisted activity cursor below
  const ref = parsePrRef(hint.value)
  if (!ref) return undefined
  const s = prCache.get(refKey(ref))
  if (!s) return undefined // no PR data this window (fetch failed / not yet polled) → indeterminate
  if (hint.kind === "pr") {
    const merged = !!s.mergedAt || s.state === "MERGED"
    const closed = s.state === "CLOSED"
    const steer = merged
      ? `✅ PR ${refKey(ref)} merged. Continue.`
      : `ℹ️ PR ${refKey(ref)} was closed without merging. Continue.`
    return { met: merged || closed, steer, reason: `pr ${refKey(ref)} ${s.state}` }
  }
  // ci
  // Exact-head Actions runs are mandatory evidence for legacy CI. A partial rollup can look green
  // while a fork gate is ACTION_REQUIRED or a matrix job is still queued. An approved rerun replaces
  // its older same-workflow attempt, just as the worker-side CI monitor does.
  if (!Array.isArray(s.workflowRuns)) {
    return { met: false, steer: "", reason: `ci ${refKey(ref)} workflow runs unavailable` }
  }
  const runs = latestWorkflowRuns(s.workflowRuns)
  if (runs.length === 0) return { met: false, steer: "", reason: `ci ${refKey(ref)} no exact-head workflow runs` }
  // An old fork-gated check remains in statusCheckRollup after a maintainer approves a rerun. The
  // exact, deduplicated workflow list is authoritative for that one stale conclusion; other rollup
  // failures/pending contexts still participate in the combined verdict.
  const rollup = s.rollup.map((check) => check?.conclusion === "ACTION_REQUIRED"
    ? { ...check, conclusion: undefined }
    : check)
  const rollupVerdict = evalRollup(rollup)
  const workflowVerdict = evalRollup(runs.map((run) => {
    // GitHub reports an unapproved fork run as COMPLETED/ACTION_REQUIRED. It is semantically a
    // pending approval, not a terminal CI failure, until a newer rerun replaces it.
    if (run.conclusion === "ACTION_REQUIRED") return { status: "IN_PROGRESS" }
    return { status: run.status, conclusion: run.conclusion ?? undefined }
  }))
  const done = rollupVerdict.done && workflowVerdict.done
  const ok = rollupVerdict.ok && workflowVerdict.ok
  const steer = ok ? `✅ CI is green on ${refKey(ref)}. Continue.` : `❌ CI failed on ${refKey(ref)}. Continue.`
  return { met: done, steer, reason: `ci ${refKey(ref)} ${done ? (ok ? "green" : "failed") : "pending"}` }
}

// Default gh-backed PR fetcher. Uses the USER'S `gh` (their auth) via execFile — NO shell. Any failure
// (gh missing → ENOENT, not authed / rate-limited → nonzero exit, malformed JSON) resolves to undefined
// so the tick logs + skips and NEVER crashes. Timeout-bounded so a hung gh can't wedge the scheduler.
async function defaultFetchPr(ref: PrRef): Promise<PrStatus | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ghPrViewArgs(ref),
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const j = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown; headRefOid?: unknown }
    // A SHAPE SURPRISE (valid JSON, but no string `state`) is INDETERMINATE, not "OPEN with no
    // checks" — returning a fabricated `{state:"", rollup:[]}` would read as UNMET and ARM the hint,
    // so a later accurate read could then fire an already-merged PR. Undefined = try again next poll.
    if (typeof j.state !== "string" || !j.state) return undefined
    if (typeof j.headRefOid !== "string" || !j.headRefOid) return undefined
    const runs = await execFileAsync(
      "gh",
      ["run", "list", "--repo", `${ref.owner}/${ref.repo}`, "--commit", j.headRefOid, "--limit", "100", "--json", "name,workflowName,status,conclusion,databaseId,event,createdAt"],
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const workflowRuns = JSON.parse(runs.stdout)
    if (!Array.isArray(workflowRuns)) return undefined
    return {
      state: j.state,
      mergedAt: typeof j.mergedAt === "string" ? j.mergedAt : null,
      rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as RollupEntry[]) : [],
      workflowRuns: workflowRuns as WorkflowRun[],
    }
  } catch {
    return undefined
  }
}

const REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 50) { nodes { id submittedAt author { login __typename } } }
      comments(last: 50) { nodes { id createdAt author { login __typename } } }
    }
  }
}`

// Pure GraphQL-shape normalizer. Missing authors/timestamps are tolerated; an absent PR or malformed
// response yields [] rather than fabricating activity. Source-prefix ids prevent a review/comment id
// collision inside the durable cursor.
export function parseGithubReviewActivities(raw: unknown): GithubReviewActivity[] {
  const pr = (raw as any)?.data?.repository?.pullRequest
  if (!pr || typeof pr !== "object") return []
  const out: GithubReviewActivity[] = []
  const add = (nodes: unknown, kind: "review" | "comment", atKey: "submittedAt" | "createdAt") => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue
      const n = node as Record<string, unknown>
      const rawId = typeof n.id === "string" && n.id ? n.id : undefined
      const author = n.author && typeof n.author === "object" ? (n.author as Record<string, unknown>) : undefined
      const actor = typeof author?.login === "string" && author.login ? author.login : undefined
      if (!rawId || !actor) continue
      const actorType = typeof author?.__typename === "string" ? author.__typename : undefined
      const at = typeof n[atKey] === "string" ? (n[atKey] as string) : undefined
      out.push({ id: `${kind}:${rawId}`, actor, actorType, at, kind })
    }
  }
  add((pr as any)?.reviews?.nodes, "review", "submittedAt")
  add((pr as any)?.comments?.nodes, "comment", "createdAt")
  return out
}

export function isNonBotGithubActivity(a: GithubReviewActivity): boolean {
  const type = a.actorType?.toLowerCase()
  const login = a.actor.toLowerCase()
  return type !== "bot" && !login.endsWith("[bot]")
}

// One GraphQL request per PR/poll supplies both submitted reviews and PR conversation comments. Bot
// filtering happens after normalization so a bot can never satisfy the human-review gate. Any gh,
// auth, rate-limit, or shape failure is indeterminate (undefined) and retried next poll.
async function defaultFetchGithubReview(ref: PrRef): Promise<GithubReviewActivity[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${REVIEW_QUERY}`,
        "-F",
        `owner=${ref.owner}`,
        "-F",
        `repo=${ref.repo}`,
        "-F",
        `number=${ref.number}`,
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

// Per-thread arming state for the CURRENT awaiting rest (reset when the fence identity changes/clears).
interface ThreadWake {
  fenceId: string
  armed: Map<string, boolean> // hintKey → have we witnessed it UNMET at least once?
  fired: boolean // this rest already has a legacy fired marker or durable outbox row
  lastPollAt: number // last gh poll for this thread's pr/ci/review hints (throttle)
  prCache: Map<string, PrStatus> // last-known PR statuses, keyed by refKey (kept between polls)
  reviewCache: Map<string, GithubReviewActivity[]> // current human+bot activity snapshot by ref
}

const FIRED_CAP = 500 // legacy pre-outbox marker cap (read during rolling upgrade, never newly added)
const REGISTRATION_CAP = 500
const REVIEW_SEEN_CAP = 300

interface ReviewCursor {
  baseline: true
  seen: string[]
  // A newly-observed human event is recorded before the wake outbox is enqueued. If GitHub is
  // temporarily unavailable on restart, this cursor still reproduces the exact pending event; the
  // deterministic outbox id prevents a second delivery row for the same fence generation.
  pending?: GithubReviewActivity
}
interface PersistedRegistration {
  key: string
  timers: Record<string, string> // hint key → exact ISO target; presence means durably armed
  reviews: Record<string, ReviewCursor> // hint key → durable activity baseline/cursor
}

export interface SchedulerDeps {
  storage: Storage
  tailer: Tailer
  // Resume/steer a thread (prod: the shared resumeThread; tests: a spy). `deliveryId` is a stable
  // idempotency key for the exact session + awaiting-fence generation. Implementations must carry it
  // through durable downstream queues and append wakeDeliveryToken(id) to terminal input so transcript
  // recovery can prove a crash-window delivery before retrying (the production composition does both).
  resume: (slug: string, message: string, deliveryId: string) => void | Promise<void>
  now?: () => number
  fetchPr?: (ref: PrRef) => Promise<PrStatus | undefined>
  fetchGithubReview?: (ref: PrRef) => Promise<GithubReviewActivity[] | undefined>
  log?: (msg: string) => void
  tickMs?: number // how often to check (timers resolve at this cadence)
  pollMs?: number // minimum spacing between gh polls for a given thread's pr/ci hints
  deliveryLeaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  maxDeliveryAttempts?: number
  deliveryBatchSize?: number
  // Deterministic hard-crash fault injection. Throwing here escapes tick without compensating writes,
  // exactly like process death at the named durability boundary. Never configured in production.
  crashPoint?: (point: SchedulerCrashPoint, delivery: WakeDelivery) => void
}

export type SchedulerCrashPoint = "after-enqueue" | "after-claim" | "after-delivery" | "after-ack"

export interface Scheduler {
  start(): void
  stop(): Promise<void>
  tick(): Promise<void> // exposed for tests + boot
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  const fetchPr = deps.fetchPr ?? defaultFetchPr
  const fetchGithubReview = deps.fetchGithubReview ?? defaultFetchGithubReview
  const log = deps.log ?? ((m: string) => console.log(`[fray-ui] ${m}`))
  const tickMs = deps.tickMs ?? 10_000
  const pollMs = deps.pollMs ?? 60_000
  const deliveryLeaseMs = Math.max(1, deps.deliveryLeaseMs ?? 30_000)
  const retryBaseMs = Math.max(1, deps.retryBaseMs ?? 5_000)
  const retryMaxMs = Math.max(retryBaseMs, deps.retryMaxMs ?? 5 * 60_000)
  const maxDeliveryAttempts = Math.max(1, deps.maxDeliveryAttempts ?? 6)
  const deliveryBatchSize = Math.max(0, deps.deliveryBatchSize ?? 50)
  const deliveryOwner = randomUUID()
  const outbox = createWakeDeliveryStore(deps.storage.db)

  const threads = new Map<string, ThreadWake>() // slug → arming state
  // Compatibility for wakes fired by the pre-outbox scheduler during a rolling upgrade. New wakes
  // never enter this set; the durable wake_delivery table below owns their lifecycle.
  const fired = new Set<string>(loadFired())
  // Future timer registrations + GitHub review baselines. Unlike legacy pr/ci arming, these MUST
  // survive a process restart because their purpose is to own transitions while the worker/server is
  // absent. The exact fence generation (timestamp + hints) is part of each key.
  const registrations = new Map<string, PersistedRegistration>(loadRegistrations().map((r) => [r.key, r]))
  let timer: NodeJS.Timeout | null = null
  let activeTick: Promise<void> | null = null // guard + shutdown drain for a slow poll/delivery
  let stopped = false

  function loadFired(): string[] {
    const raw = deps.storage.getSetting("waker.fired")
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
  }
  function saveFired(): void {
    deps.storage.setSetting("waker.fired", [...fired].slice(-FIRED_CAP))
  }
  function forgetFired(key: string): void {
    if (fired.delete(key)) saveFired()
  }
  function loadRegistrations(): PersistedRegistration[] {
    const raw = deps.storage.getSetting("waker.registrations.v1")
    if (!Array.isArray(raw)) return []
    const out: PersistedRegistration[] = []
    for (const item of raw.slice(-REGISTRATION_CAP)) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>
      if (typeof obj.key !== "string" || !obj.key) continue
      const timers: Record<string, string> = {}
      if (obj.timers && typeof obj.timers === "object" && !Array.isArray(obj.timers)) {
        for (const [k, v] of Object.entries(obj.timers as Record<string, unknown>)) if (typeof v === "string") timers[k] = v
      }
      const reviews: Record<string, ReviewCursor> = {}
      if (obj.reviews && typeof obj.reviews === "object" && !Array.isArray(obj.reviews)) {
        for (const [k, v] of Object.entries(obj.reviews as Record<string, unknown>)) {
          if (!v || typeof v !== "object") continue
          const seen = (v as { seen?: unknown }).seen
          if (!Array.isArray(seen)) continue
          const rawPending = (v as { pending?: unknown }).pending
          let pending: GithubReviewActivity | undefined
          if (rawPending && typeof rawPending === "object") {
            const p = rawPending as Record<string, unknown>
            if (
              typeof p.id === "string" &&
              typeof p.actor === "string" &&
              (p.kind === "review" || p.kind === "comment")
            ) {
              const candidate: GithubReviewActivity = {
                id: p.id,
                actor: p.actor,
                actorType: typeof p.actorType === "string" ? p.actorType : undefined,
                at: typeof p.at === "string" ? p.at : undefined,
                kind: p.kind,
              }
              if (isNonBotGithubActivity(candidate)) pending = candidate
            }
          }
          reviews[k] = {
            baseline: true,
            // Cursors are stored newest-first (saveReviewCursor prepends the current page), so retain
            // the head on load too. Keeping the oldest tail would forget recent activity after a
            // restart and could misclassify it as a fresh human review.
            seen: seen.filter((x): x is string => typeof x === "string").slice(0, REVIEW_SEEN_CAP),
            ...(pending ? { pending } : {}),
          }
        }
      }
      out.push({ key: obj.key, timers, reviews })
    }
    return out
  }
  function saveRegistrations(): void {
    deps.storage.setSetting("waker.registrations.v1", [...registrations.values()].slice(-REGISTRATION_CAP))
  }
  function registration(key: string): PersistedRegistration {
    const existing = registrations.get(key)
    if (existing) return existing
    const created: PersistedRegistration = { key, timers: {}, reviews: {} }
    registrations.set(key, created)
    while (registrations.size > REGISTRATION_CAP) {
      const oldest = registrations.keys().next().value
      if (oldest === undefined) break
      registrations.delete(oldest)
    }
    return created
  }
  function armTimer(key: string, hintKey: string, target: string): void {
    const r = registration(key)
    if (r.timers[hintKey] === target) return
    r.timers[hintKey] = target
    saveRegistrations()
  }
  function saveReviewCursor(key: string, hintKey: string, seen: string[], pending?: GithubReviewActivity): void {
    const r = registration(key)
    const unique = [...new Set(seen)].slice(0, REVIEW_SEEN_CAP)
    const next: ReviewCursor = { baseline: true, seen: unique, ...(pending ? { pending } : {}) }
    if (JSON.stringify(r.reviews[hintKey] ?? null) === JSON.stringify(next)) return
    r.reviews[hintKey] = next
    saveRegistrations()
  }
  function forgetRegistration(key: string): void {
    if (registrations.delete(key)) saveRegistrations()
  }
  // NUL-delimited so no slug/fenceId content can forge a different pair's key (slugs match a
  // space-free regex and actionable hint values carry no NUL, so this is collision-proof).
  const firedKey = (slug: string, fenceId: string) => `${slug}\u0000${fenceId}`

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

  type DeliveryContext = "confirmed" | "superseded" | "current-idle" | "current-busy" | "unknown"

  function deliveryContext(item: WakeDelivery): DeliveryContext {
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return "superseded"
    if (row.state === "archived" || row.archived === 1) return "superseded"
    const tele = deps.tailer.get(item.slug)
    if (!tele) return "unknown"
    if (tele.lastUserText?.includes(wakeDeliveryToken(item.id))) return "confirmed"
    const fence = tele.lastFence
    if (!fence || fence.kind !== "awaiting" || !fence.hints.some(isActionable)) return "superseded"
    if (fenceIdentity(fence.hints, tele.lastActivityAt) !== item.fenceId) return "superseded"
    return tele.turn === "idle" ? "current-idle" : "current-busy"
  }

  function reviewVerdict(
    persistKey: string,
    hint: FenceView["hints"][number],
    activities: GithubReviewActivity[],
    fenceAt: string | undefined,
  ): Verdict | undefined {
    const ref = parsePrRef(hint.value)
    if (!ref) return undefined
    const hintKey = `${hint.kind}:${hint.value}`
    const prior = registrations.get(persistKey)?.reviews[hintKey]
    // A previous delivery attempt failed. Retry the durable outbox item before consulting the latest
    // page; it must not disappear merely because GitHub is down or the item fell off a bounded page.
    if (prior?.pending) {
      return {
        met: true,
        steer: `👤 New human GitHub ${prior.pending.kind} activity on ${refKey(ref)} from @${prior.pending.actor}. Re-open the review/comments and continue.`,
        reason: `github review ${refKey(ref)} by ${prior.pending.actor}`,
      }
    }
    const human = activities
      .filter(isNonBotGithubActivity)
      .sort((a, b) => {
        const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
        return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
      })
    const priorSeen = new Set(prior?.seen ?? [])
    let fresh: GithubReviewActivity[]
    if (prior) {
      fresh = human.filter((a) => !priorSeen.has(a.id))
    } else {
      // A review may land between the final fence and this scheduler's first poll (or while the server
      // is restarting before the baseline is persisted). The fence timestamp lets a brand-new grammar
      // distinguish that real post-fence activity from all pre-existing review history. If timestamp
      // telemetry is unavailable, baseline conservatively and wait for the next unseen id.
      const fenceMs = Date.parse(fenceAt ?? "")
      fresh = Number.isFinite(fenceMs)
        ? human.filter((a) => {
            const at = Date.parse(a.at ?? "")
            return Number.isFinite(at) && at > fenceMs
          })
        : []
    }
    // Persist the cursor BEFORE a possible resume. Union with the prior tail so a temporarily-shorter
    // API page cannot make an old id look new later; newest current ids win the bounded cap.
    if (fresh.length === 0) {
      saveReviewCursor(persistKey, hintKey, [...human.map((a) => a.id), ...(prior?.seen ?? [])])
      return undefined
    }
    const newest = fresh[0]
    saveReviewCursor(persistKey, hintKey, [...human.map((a) => a.id), ...(prior?.seen ?? [])], newest)
    return {
      met: true,
      steer: `👤 New human GitHub ${newest.kind} activity on ${refKey(ref)} from @${newest.actor}. Re-open the review/comments and continue.`,
      reason: `github review ${refKey(ref)} by ${newest.actor}`,
    }
  }

  async function evalThread(slug: string, sessionId: string, fence: FenceView, nowMs: number, fenceAt?: string): Promise<void> {
    const actionable = fence.hints.filter(isActionable)
    if (actionable.length === 0) {
      threads.delete(slug)
      return
    }
    const fenceId = fenceIdentity(fence.hints, fenceAt)
    const persistKey = firedKey(slug, fenceId)
    let st = threads.get(slug)
    if (!st || st.fenceId !== fenceId) {
      // A new/changed awaiting rest: drop the previous rest's persisted marker + arming, start fresh.
      if (st) {
        const oldKey = firedKey(slug, st.fenceId)
        forgetFired(oldKey)
        forgetRegistration(oldKey)
      }
      st = { fenceId, armed: new Map(), fired: false, lastPollAt: 0, prCache: new Map(), reviewCache: new Map() }
      const saved = registrations.get(persistKey)
      for (const h of actionable) {
        if (h.kind !== "timer") continue
        const hintKey = `${h.kind}:${h.value}`
        if (saved?.timers[hintKey] === h.value) st.armed.set(hintKey, true)
      }
      threads.set(slug, st)
    }
    if (fired.has(persistKey)) st.fired = true
    const deliveryId = wakeDeliveryId(slug, sessionId, fenceId)
    if (outbox.get(deliveryId)) st.fired = true
    if (st.fired) return // already queued/resumed for this rest — wait for delivery or fence supersession

    // Refresh PR statuses/review activity on the slow cadence (one fetch per distinct ref per kind).
    const needsPr = actionable.some((h) => h.kind === "pr" || h.kind === "ci")
    const needsReview = actionable.some((h) => h.kind === "github-review")
    if ((needsPr || needsReview) && (st.lastPollAt === 0 || nowMs - st.lastPollAt >= pollMs)) {
      st.lastPollAt = nowMs
      const refs = new Map<string, PrRef>()
      const reviewRefs = new Map<string, PrRef>()
      for (const h of actionable) {
        const ref = parsePrRef(h.value)
        if (!ref) continue
        if (h.kind === "pr" || h.kind === "ci") refs.set(refKey(ref), ref)
        if (h.kind === "github-review") reviewRefs.set(refKey(ref), ref)
      }
      for (const [k, ref] of refs) {
        try {
          const s = await fetchPr(ref)
          if (s) st.prCache.set(k, s) // keep the last-known status on a transient failure
          else log(`waker: gh check skipped for ${k} (${slug}) — gh unavailable / not authed / rate-limited`)
        } catch (err) {
          log(`waker: gh check errored for ${k} (${slug}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      for (const [k, ref] of reviewRefs) {
        try {
          const activity = await fetchGithubReview(ref)
          if (activity) st.reviewCache.set(k, activity)
          else log(`waker: GitHub review check skipped for ${k} (${slug}) — gh unavailable / not authed / rate-limited`)
        } catch (err) {
          log(`waker: GitHub review check errored for ${k} (${slug}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    for (const h of actionable) {
      const key = `${h.kind}:${h.value}`
      const reviewRef = h.kind === "github-review" ? parsePrRef(h.value) : undefined
      const reviewActivity = reviewRef ? st.reviewCache.get(refKey(reviewRef)) : undefined
      const pendingReview = registrations.get(persistKey)?.reviews[key]?.pending
      const verdict = h.kind === "github-review"
        ? reviewActivity || pendingReview
          ? reviewVerdict(persistKey, h, reviewActivity ?? [], fenceAt)
          : undefined
        : evalHint(h, nowMs, st.prCache, fence.body)
      if (!verdict) continue // indeterminate this tick
      if (!verdict.met) {
        st.armed.set(key, true) // WITNESSED unmet → this hint is now eligible to fire on a later met
        if (h.kind === "timer") armTimer(persistKey, key, h.value)
        continue
      }
      // Reviews are eligible once a persisted baseline detects an unseen human id. Timer/legacy
      // conditions still require arming; for timers that arming was restored from durable registration.
      if (h.kind !== "github-review" && !st.armed.get(key)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug,
        sessionId,
        fenceId,
        hintKey: key,
        message: verdict.steer,
        reason: verdict.reason,
      }, nowMs).delivery
      st.fired = true
      log(`waker: queued ${slug} — ${verdict.reason}`)
      checkpoint("after-enqueue", item)
      return // one durable wake per thread per rest
    }
  }

  function reconcileOutbox(nowMs: number): void {
    for (const item of outbox.listOpen()) {
      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, nowMs)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, nowMs, "the exact awaiting fence or session was superseded")
        continue
      }
      if (item.state !== "leased" || item.leaseUntil === null || item.leaseUntil > nowMs) continue
      // An expired lease is an interrupted/uncertain attempt. Re-open it only while the exact session
      // generation is still idly awaiting the exact fence. Busy or not-yet-loaded telemetry is held:
      // retrying there could duplicate an input that crossed tmux just before process death.
      if (context !== "current-idle") continue
      const recovered = outbox.recoverExpired(
        item.id,
        nowMs,
        nowMs,
        maxDeliveryAttempts,
        item.lastError ?? "delivery lease expired before acknowledgement",
      )
      if (recovered?.state === "exhausted") {
        log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
      }
    }
  }

  async function deliverDue(): Promise<void> {
    for (let delivered = 0; delivered < deliveryBatchSize; delivered++) {
      // Condition polling can take seconds. Never derive a lease from the tick-start timestamp: a
      // sufficiently slow GitHub request would make a brand-new claim already expired to another
      // scheduler process. Every external-delivery boundary gets a fresh clock read instead.
      const claimedAt = now()
      const item = outbox.claim(deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (!item) return
      checkpoint("after-claim", item)

      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, now())
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, now(), "the exact awaiting fence or session was superseded before delivery")
        continue
      }
      if (context !== "current-idle") {
        const deferredAt = now()
        outbox.deferFailure(
          item.id,
          deliveryOwner,
          deferredAt,
          deferredAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          "delivery deferred until exact awaiting telemetry is idle and available",
        )
        continue
      }

      log(`waker: delivering ${item.slug} — ${item.reason} (attempt ${item.attempts})`)
      try {
        await deps.resume(item.slug, item.message, item.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failedAt = now()
        // A TERMINAL delivery verdict (a live worker owns this conversation but its exact identity
        // can't be confirmed for safe re-entry) will never change by retrying — retrying only burns
        // every attempt to a silent exhaustion. Abandon the item now, preserving the reason for the
        // human, instead of deferring it back into the retry pool. Duck-typed so the scheduler stays
        // decoupled from resume.ts (see TerminalDeliveryError).
        if ((error as { terminalDelivery?: unknown })?.terminalDelivery === true) {
          outbox.supersede(item.id, failedAt, message)
          log(`waker: delivery ABANDONED for ${item.slug} (terminal, no retry): ${message}`)
          continue
        }
        // A thrown non-terminal operation can still be ambiguous (for example, text crossed tmux before
        // a later storage write failed). Keep the item leased through a confirmation window; recovery
        // checks the token/fence before making it retryable.
        outbox.deferFailure(
          item.id,
          deliveryOwner,
          failedAt,
          failedAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          message,
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
    }
  }

  async function runTick(): Promise<void> {
    const nowMs = now()
    const seen = new Set<string>()
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue // non-archived only
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue // only a thread genuinely AT REST is a waker candidate
      const fence = tele.lastFence
      if (!fence || fence.kind !== "awaiting" || !fence.hints.some(isActionable)) continue
      seen.add(row.slug)
      try {
        await evalThread(row.slug, row.session_id, fence, nowMs, tele.lastActivityAt)
      } catch (err) {
        if (err instanceof InjectedSchedulerCrash) throw err
        log(`waker: tick error for ${row.slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // The awaiting fence vanished (superseded, archived, or no longer at rest): forget its arming +
    // persisted marker so a future re-await arms fresh and can fire again.
    for (const [slug, st] of [...threads]) {
      if (!seen.has(slug)) {
        const key = firedKey(slug, st.fenceId)
        forgetFired(key)
        forgetRegistration(key)
        threads.delete(slug)
      }
    }
    reconcileOutbox(now())
    await deliverDue()
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.reject(new ProducerStoppedError("wake scheduler"))
    if (activeTick) return activeTick
    const task = runTick()
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
      // Derive current state immediately (arms live waits; boot-safe — never fires on first sight).
      void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      timer = setInterval(() => {
        void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      }, tickMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      const draining = activeTick
      if (draining) await draining
    },
    tick,
  }
}
