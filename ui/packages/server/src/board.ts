import {
  existsSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs"
import { join } from "node:path"
import watcher from "@parcel/watcher"
import type { BoardSnapshot, ThreadView, RuntimeState, PlanView } from "@fray-ui/shared"
import { BoardDiffer, CODEX_INPUT_CONFIRMATION_TIMEOUT_MS, PermissionMode, SnoozeUntil, ThreadSlug, isValidAwaitingTimer, type PermissionMode as PermissionModeValue } from "@fray-ui/shared"
import type { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import type { Storage, SessionRow } from "./storage.ts"
import { normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import type { Tailer, SessionTelemetry } from "./tailer.ts"
import type { InteractionChange } from "./interaction-store.ts"
import { frayDirExists } from "./fray.ts"
import * as tmux from "./tmux.ts"
import { effectivePermissionMode, resolveLegacyThreadFile } from "./dispatch.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { listPlanFiles } from "./plan-files.ts"
import { awaitingFenceIdentity, isActionableAwaitingHint } from "./awaiting.ts"

// The read model is provenance-bound to the durable session registry. A session row exists only after
// Fray UI dispatches or explicitly adopts a thread, so unrelated legacy `.fray/*.md` files and raw
// terminal transcripts never enter this board (or its queue/error surface). The tailer contributes
// telemetry only for registered rows. Plan documents remain project artifacts and are read separately.

const DEBOUNCE_MS = 150
// Level-triggered reconcile period: a periodic full rebuild that re-publishes if anything drifted.
// NOTE: this bounds SERVER-side staleness, not end-to-end UI staleness. It is the ceiling only WHILE
// the SSE socket is delivering; if the socket dies silently the client keeps its last frame until ITS
// own heartbeat watchdog fires and reconnects — real worst case ≈45-60s (sse.ts HEARTBEAT_TIMEOUT 35s
// + the 10s health tick). See sse.ts.
const RECONCILE_MS = 15_000

// Runtime derivation: no session row → never spawned (none); a row whose tmux session is dead/absent
// → exited; a live session paused on an interactive permission prompt → perm-prompt (pane-sniffed by
// the tailer, no jsonl signal); otherwise the tailer's turn state (running while a turn is in flight,
// turn-idle once it ends).
function deriveRuntime(
  slug: string,
  row: SessionRow | undefined,
  storage: Storage,
  turn: "in-flight" | "idle" | undefined,
  permPrompt: boolean,
): RuntimeState {
  if (!row) return "none"
  const adoption = adoptionRuntimeBinding(storage, row)
  if (adoption.kind === "conflict") return "exited"
  if (adoption.kind === "bound") {
    if (!tmux.isExpectedAdoptionPaneLiveAnywhereCached(adoption.claim)) return "exited"
  } else if (!tmux.isLiveCached(slug)) return "exited"
  // Cached (batched list-panes) — this runs per-thread on EVERY overlay refresh; the uncached
  // two-subprocess isLive here starved the event loop whenever an agent was streaming.
  if (permPrompt) return "perm-prompt"
  return turn === "idle" ? "turn-idle" : "running"
}

// A worker whose transcript never materialized (a boot failure the tailer flagged noTranscript) would
// otherwise read "running" forever — deriveRuntime sees a live tmux pane with no telemetry and defaults
// to running, so the row spins with nothing to tail. Downgrade ONLY that spinner to the degraded "exited"
// affordance ("Stalled", a "!" glyph); with the "in-flight" turn a transcript-less session keeps, this
// also trips deriveNeedsYou's crash-net so it cards for the human. Every other runtime is left as-is (a
// dead pane is already "exited"; a healthily-bound session is never noTranscript). Reused "exited" rather
// than minting a new RuntimeState — see session-transcript-drift (a distinct error enum is a follow-up).
export function degradeIfNoTranscript(runtime: RuntimeState, noTranscript: boolean | undefined): RuntimeState {
  return noTranscript && runtime === "running" ? "exited" : runtime
}

// Display fields are ONE-LINERS in every surface that renders them — cap them at the server so a
// thread whose agent wrote an essay into status_text can't fatten every snapshot push (on a large
// board these two fields alone were half a megabyte).
const LINE_CAP = 240
function capLine(s: string | undefined | null, cap = LINE_CAP): string | undefined {
  if (!s) return undefined
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s
}

// ---- Session threads (2026-07-09): the working rail's unit — exactly one ThreadView per durable
// registry row. The legacy fray status vocabulary does not apply: `status` is synthesized "active"
// (the field is required but display keys on kind/state/needsYou), and block/dep fields are inert.

// Parse an ISO time to epoch-ms, or -Infinity when absent/unparseable (a missing clearance never
// beats a real activity time in the needsYou compare below).
function timeOrNegInf(s: string | null | undefined): number {
  if (!s) return -Infinity
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : -Infinity
}

// EFFECTIVE lifecycle state for a registered session row (open|archived). An explicit state write wins;
// otherwise the historical archived bit migrates older rows without consulting unrelated files.
function effectiveSessionState(row: SessionRow, registeredLegacyTerminal: boolean): "open" | "archived" {
  if (row.state === "open" || row.state === "archived") return row.state
  if (row.archived === 1) return "archived"
  if (registeredLegacyTerminal) return "archived"
  return "open"
}

// Pre-session-first Fray UI rows may have state=NULL and derive their archived state from a paired
// terminal thread document. Preserve that migration behavior without scanning the directory: open
// only the canonical filename selected by a durable session row, reject symlinks at open time, and
// read only whether status is `done`/`dismissed`. Malformed or missing files fail open as an active session and never
// contribute a board parser error.
function registeredLegacyFileIsTerminal(projectDir: string, slug: string): boolean {
  const file = resolveLegacyThreadFile(projectDir, slug)
  if (!file) return false
  const frontmatter = file.contents.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  const raw = frontmatter?.match(/^status:\s*(.*?)\s*$/m)?.[1]
  const status = raw?.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2").trim()
  return status === "done" || status === "dismissed"
}

function futureSnooze(row: Pick<SessionRow, "snoozed_until">, nowMs: number): string | undefined {
  const parsed = SnoozeUntil.safeParse(row.snoozed_until)
  return parsed.success && Date.parse(parsed.data) > nowMs ? parsed.data : undefined
}

function hasLiveBackgroundWork(tele: SessionTelemetry | undefined): boolean {
  return Boolean(
    tele?.subAgents?.some((agent) => agent.state === "running") ||
    tele?.bgShells?.some((shell) => shell.state === "running"),
  )
}

export function hasConfirmedAwaitingWait(
  row: Pick<SessionRow, "awaiting_fence_id" | "awaiting_confirmed_at">,
  tele: SessionTelemetry | undefined,
  nowMs: number,
): boolean {
  const fence = tele?.lastFence
  const fenceAt = fence?.at
  if (fence?.kind !== "awaiting" || !isActionableAwaitingHint(fence.hint) || !fenceAt) return false
  if (fence.hint.kind === "timer" && Date.parse(fence.hint.value) <= nowMs) return false
  return Boolean(
    row.awaiting_confirmed_at &&
    row.awaiting_fence_id === awaitingFenceIdentity(fence.hint, fenceAt),
  )
}

// SERVER-DERIVED queue membership for a REGISTERED session thread (foreign/archived → false at the
// call site). Every otherwise-unexcused owned/open thread enters Queue when its top-level worker comes
// to rest. A user-owned snooze temporarily suppresses every queue reason—including a concrete ask,
// permission prompt, or crash—then the exact deadline restores the still-current reason. Truthful
// external waits place ordinary rest in Held without writing lifecycle state.
export function deriveNeedsYou(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  hasActionableInteraction = false,
  nowMs = Date.now(),
): boolean {
  // Snooze is explicit operator lifecycle state. It must be checked before provider/question/crash
  // gates so choosing Snooze from any queue card actually parks that card until its exact deadline.
  // The underlying telemetry remains intact and is re-derived when the scheduler clears the instant.
  if (futureSnooze(row, nowMs)) return false
  // A typed request is already scoped to this exact registered session by the interaction journal.
  // It is a hard human gate even when the provider is mid-turn: the turn cannot advance until the
  // advertised response is delivered, so at-rest transcript heuristics do not apply.
  if (hasActionableInteraction) return true
  if (runtime === "perm-prompt") return true
  if (tele?.pendingAsk) return true
  // Codex connector/tool approvals and verified native selectors leave the rollout in-flight. They
  // are nevertheless hard human gates, so queue them independently of runtime/at-rest semantics.
  if (tele?.nativeInputRequired) return true
  const atRest = runtime === "turn-idle" || runtime === "exited"
  if (!atRest) return false
  // CRASH/STALL net: the pane EXITED while the turn was still in flight (last record a tool_use, never
  // reached end_turn) — the agent died mid-work. This is a stall the human MUST see, and it is NOT
  // clearable by a prior glance (a dead process produces no new activity to re-arm bare-rest, so
  // interaction-clearance would bury it forever after one view). The legacy needsAction had this net
  // (active/planning + exited/none); deriveNeedsYou dropped it — restored here (found 2026-07-09).
  if (runtime === "exited" && tele?.turn === "in-flight") return true
  // An unanswered ```question fence in the last assistant message is an EXPLICIT ask — a hard queue
  // member exactly like a native pendingAsk, NOT subject to interaction-clearance. VIEWING a question
  // is not ANSWERING it, so seen_at must never drop it off the stack (the whole point is that threads
  // needing input surface automatically and STAY until resolved). The tailer clears pendingQuestion the
  // moment a newer user message lands (an answer/steer supersedes the fence), which is what dequeues it.
  if (tele?.pendingQuestion) return true
  // A top-level turn that is resting only while its own child/Monitor still runs is still in flight,
  // not a human handoff. Once that operation clears, the next board refresh queues the bare rest.
  // This excuse holds ONLY while the parent pane is alive: a child cannot outlive the process that
  // spawned it. The tailer already zeroes bgShells on pane death (bgShellViews), but a dead pane's
  // SUB-AGENTS keep reading "running" until their transcript goes stale — or forever when the child's
  // output file never resolved (subAgentViews has no paneDead guard). So an EXITED parent still showing
  // "running" background work is a crash mid-background-work; surface it rather than bury it on stale
  // child liveness (found 2026-07-21: such a thread silently dangled).
  if (runtime !== "exited" && hasLiveBackgroundWork(tele)) return false
  if (hasConfirmedAwaitingWait(row, tele, nowMs)) return false
  // A final ```done fence is a CHECKED completion handoff: show its success card in the queue until the
  // human explicitly Archives the thread. Like a question, merely viewing it does not resolve it. The
  // at-rest gate above prevents a stale fence from carding while a follow-up turn is still running.
  if (tele?.lastFence?.kind === "done") return true
  // Bare rest is itself the handoff. It remains queued until the human explicitly sends more work,
  // snoozes it, or archives it; merely opening/seeing the thread cannot silently clear the card.
  return true
}

// The scratchpad path for a session, iff the file exists under the project dir (else undefined so the
// client offers no doc tab). Convention: .fray/threads/<session_id>/scratch.md.
function scratchpadPathIfExists(projectDir: string, sessionId: string): string | undefined {
  const rel = `.fray/threads/${sessionId}/scratch.md`
  return existsSync(join(projectDir, rel)) ? rel : undefined
}

// A REGISTERED session thread's view (id = row.slug). Runtime via the shared deriveRuntime (tmux-aware);
// telemetry fields mirror the legacy path; title provenance is resolved before the snapshot is emitted.
export function resolveSessionProfile(
  row: Pick<SessionRow, "backend" | "model" | "effort" | "spawned_at">,
  tele: Pick<SessionTelemetry, "model" | "effort" | "profileAt"> | undefined,
): { model?: string; effort?: string } {
  const persistedModel = row.model?.trim() || undefined
  const persistedEffort = row.effort?.trim() || undefined
  const observedAt = tele?.profileAt ? Date.parse(tele.profileAt) : NaN
  const spawnedAt = Date.parse(row.spawned_at)
  // A transcript is replayed from byte zero whenever a runtime generation changes. A persisted launch
  // target therefore remains authoritative until a genuinely post-spawn profile record arrives; old
  // turn_context/assistant records must not snap the controls back after reattach or server restart.
  const observedIsCurrent = Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt
  const observedModel = tele?.model
    ? normalizeObservedThreadModel(row.backend ?? "claude", tele.model) ?? tele.model.trim()
    : undefined
  const model = (!persistedModel || observedIsCurrent ? observedModel : undefined) || persistedModel
  const effort = (!persistedEffort || observedIsCurrent ? tele?.effort?.trim() : undefined) || persistedEffort
  return { model, effort }
}

export function resolveSessionPermission(
  row: Pick<SessionRow, "backend" | "spawned_at" | "permission_mode" | "permission_pending">,
  tele?: Pick<SessionTelemetry, "permissionMode" | "permissionModeAt">,
): ThreadView["permissionMode"] {
  const saved = PermissionMode.safeParse(row.permission_mode)
  const pending = PermissionMode.safeParse(row.permission_pending)
  const normalize = (mode: PermissionModeValue) => effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", mode)
  // A successful controlled reattach stamps the exact argv mode before its transcript sidecar is
  // tailed. During that short reconciliation window the launched value is already authoritative.
  if (saved.success && pending.success && normalize(saved.data) === normalize(pending.data)) return normalize(saved.data)
  if (row.backend === "codex" && saved.success) {
    // Codex does not append a profile record merely by reopening an idle rollout. Ignore an older
    // turn_context from before this process generation, but accept a later /permissions or turn event.
    const observedAt = tele?.permissionModeAt ? Date.parse(tele.permissionModeAt) : NaN
    const spawnedAt = Date.parse(row.spawned_at)
    if (tele?.permissionMode && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt) {
      return normalize(tele.permissionMode)
    }
    return normalize(saved.data)
  }
  // The tailer writes every observed Claude permission-mode transition back to this row. Prefer the
  // durable value so a just-reattached process cannot be relabeled by the previous in-memory fold.
  if (saved.success) return normalize(saved.data)
  return tele?.permissionMode ? normalize(tele.permissionMode) : undefined
}

export function resolvePendingPermission(row: Pick<SessionRow, "permission_pending">): ThreadView["permissionPending"] {
  const parsed = PermissionMode.safeParse(row.permission_pending)
  return parsed.success ? parsed.data : undefined
}

export function queuedInputCount(value: string | null | undefined): number {
  if (!value) return 0
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

export function codexInputIsAmbiguous(value: string | null | undefined, now = Date.now()): boolean {
  if (!value) return false
  try {
    const first = JSON.parse(value)?.[0]
    if (!first || first.state !== "submitted" || typeof first.submittedAt !== "string") return false
    const submittedAt = Date.parse(first.submittedAt)
    return Number.isFinite(submittedAt) && now - submittedAt >= CODEX_INPUT_CONFIRMATION_TIMEOUT_MS
  } catch {
    return false
  }
}

// Title provenance is resolved server-side as well as in the web display helper. A transcript title
// is eligible only while the registry says the stored fallback was machine-generated; once a human
// commits a title (setTitle atomically clears title_auto), no later tail tick can put aiTitle back on
// the wire as a competing display value.
export function resolveSessionTitle(
  row: Pick<SessionRow, "title" | "title_auto">,
  tele: Pick<SessionTelemetry, "aiTitle"> | undefined,
): Pick<ThreadView, "title" | "titleAuto" | "aiTitle"> {
  const titleAuto = row.title_auto === 1
  return {
    title: row.title ?? "",
    titleAuto,
    aiTitle: titleAuto ? tele?.aiTitle : undefined,
  }
}

function sessionThreadView(
  projectDir: string,
  storage: Storage,
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  registeredLegacyTerminal: boolean,
  interactionPresence: { pending: boolean; needsUser: boolean },
  nowMs: number,
): ThreadView {
  const runtime = degradeIfNoTranscript(deriveRuntime(row.slug, row, storage, tele?.turn, tele?.permPrompt ?? false), tele?.noTranscript)
  const state = effectiveSessionState(row, registeredLegacyTerminal)
  const archived = state === "archived"
  const needsYou = archived ? false : deriveNeedsYou(row, tele, runtime, interactionPresence.needsUser, nowMs)
  // A pane that exited with work still outstanding — a turn in flight, OR a sub-agent still reading
  // "running" (its parent is gone, so it cannot actually be live) — is a crash/stall, not a clean
  // handoff, so it cards as "stalled" not a bare "rest". Mirrors deriveNeedsYou's surfacing above. (The
  // tailer already zeroes bgShells on pane death, so in practice the background-work arm keys on
  // sub-agents; it flips back to bare rest once the child's transcript goes stale.)
  const crashed = runtime === "exited" && (tele?.turn === "in-flight" || hasLiveBackgroundWork(tele))
  const snoozedUntil = futureSnooze(row, nowMs)
  const awaitingWaitConfirmed = hasConfirmedAwaitingWait(row, tele, nowMs)
  const profile = resolveSessionProfile(row, tele)
  const permissionMode = resolveSessionPermission(row, tele)
  const permissionPending = resolvePendingPermission(row)
  const title = resolveSessionTitle(row, tele)
  return {
    id: row.slug,
    ...title,
    status: "active", // synthesized: the field is required but UNUSED for session rows (see note above)
    hasPlan: false,
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime,
    sessionId: row.session_id,
    tmuxName: row.tmux_name,
    unread: row.unread === 1,
    archived,
    lastAssistant: tele?.lastAssistant,
    spawnedAt: row.spawned_at,
    lastActivityAt: tele?.lastActivityAt,
    lastAssistantAt: tele?.lastAssistantAt,
    subAgents: tele?.subAgents ?? [],
    bgShells: tele?.bgShells ?? [],
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    nativeInputRequired: tele?.nativeInputRequired,
    pendingQuestion: tele?.pendingQuestion ?? false,
    lastUserAt: tele?.lastUserAt,
    // Runtime provider-auth rejection (claude-auth plan): only the typed category travels — the raw
    // error/pane text never leaves the server. Drives the trusted sign-in recovery card in ChatView.
    providerFault: tele?.authFault
      ? { backend: row.backend === "codex" ? "codex" as const : "claude" as const, category: tele.authFault }
      : undefined,
    kind: "session",
    foreign: false,
    lastFence: tele?.lastFence,
    seenAt: row.seen_at ?? undefined,
    planPath: row.plan_path ?? undefined,
    state,
    snoozedUntil,
    awaitingWaitConfirmed,
    needsYou,
    crashed,
    pendingInteraction: interactionPresence.pending,
    actionableInteraction: interactionPresence.needsUser,
    scratchpadPath: scratchpadPathIfExists(projectDir, row.session_id),
    // Preserve only a durable, canonical backend identity. In particular, Claude is not inferred
    // from today's dispatch preference: unknown/migrated rows remain unmarked, while rows whose
    // database default was explicitly normalized to "claude" get the same per-thread identity as
    // Codex rows.
    backend: row.backend === "claude" || row.backend === "codex" ? row.backend : undefined,
    // Only a persisted, validated per-session value is exposed. A migrated row stays visibly unknown;
    // never label it with today's global defaults (which may not match its running process).
    permissionMode,
    permissionPending,
    permissionChangePending: row.permission_pending !== null && row.permission_pending !== undefined,
    profilePendingModel: row.profile_pending_model?.trim() || undefined,
    profilePendingEffort: row.profile_pending_effort?.trim() || undefined,
    profileChangePending:
      row.profile_pending_model !== null && row.profile_pending_model !== undefined ||
      row.profile_pending_effort !== null && row.profile_pending_effort !== undefined,
    runtimeControlPending: row.runtime_control !== null && row.runtime_control !== undefined,
    // A queued Codex follow-up deliberately retains the `codex-input` owner until transcript
    // confirmation. The controller accepts another follow-up under that same owner, so expose this
    // exact capability rather than making every runtime control look sendable to the browser.
    followUpQueueAvailable: row.backend === "codex" && row.runtime_control === "codex-input",
    queuedInputCount: queuedInputCount(row.codex_input_queue),
    codexInputAmbiguous: codexInputIsAmbiguous(row.codex_input_queue),
    controlError: row.control_error?.trim() || undefined,
    // Session profile resolved from backend-observed transcript truth first, then pinned launch
    // metadata (which supplies immediate/pre-response values and Claude's unrecorded effort). Never
    // fall back to current Settings; when both durable sources are silent the readout is omitted.
    model: profile.model,
    effort: profile.effort,
  }
}

// Plan artifacts (.fray/plans/*.md): title from the first markdown heading in the securely resolved
// bytes (else the filename stem), mtime, and registered session slugs dispatched from it. Discovery and
// reading share one stable no-follow resolver; indirect or raced files are omitted.
function readPlans(projectDir: string, rows: SessionRow[]): PlanView[] {
  return listPlanFiles(projectDir).map((file) => {
    let title = file.filename.replace(/\.md$/, "")
    const head = file.contents.toString("utf8").split("\n").slice(0, 50)
    const heading = head.find((line) => /^#{1,6}\s+\S/.test(line))
    if (heading) title = heading.replace(/^#{1,6}\s+/, "").trim() || title
    const threadIds = rows
      .filter((row) => row.plan_path === file.relativePath && ThreadSlug.safeParse(row.slug).success)
      .map((row) => row.slug)
    return { path: file.relativePath, title, updatedAt: new Date(file.mtimeMs).toISOString(), threadIds }
  })
}

export interface BoardManager {
  snapshot(): Promise<BoardSnapshot>
  // The seq the current snapshot corresponds to — the value a connect keyframe must advertise so the
  // client can adopt it and then apply deltas seq+1, seq+2 … (see the /events handler). Read
  // synchronously right after snapshot() so the two are consistent.
  currentSeq(): number
  // Full: revalidates registered-file migration state and secure plan discovery.
  rebuild(): Promise<BoardSnapshot>
  // Overlay-only: reuses file-backed caches; cheap + sync. Use for tailer/session changes.
  refresh(): BoardSnapshot
  // A durable typed-interaction transition changes queue membership independently of transcript or
  // .fray files. The board caches per-session presence and refreshes on the journal's post-commit edge.
  interactionChanged?(change: InteractionChange): void
  start(): Promise<void>
  stop(): Promise<void>
}

export interface BoardManagerDeps {
  subscribe?: typeof watcher.subscribe
  now?: () => number
}

export function createBoard(
  project: Project,
  storage: Storage,
  bus: Bus,
  tailer: Tailer,
  bootId: string,
  deps: BoardManagerDeps = {},
): BoardManager {
  const subscribe = deps.subscribe ?? watcher.subscribe
  const now = deps.now ?? Date.now
  let cached: BoardSnapshot | null = null
  let parcelSub: watcher.AsyncSubscription | null = null
  let watchSetup: Promise<void> | null = null
  let bootstrapWatch: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  let snoozeTimer: NodeJS.Timeout | null = null
  let interactionRefreshQueued = false
  let snoozeRefreshQueued = false
  let stopped = false
  let stopPromise: Promise<void> | null = null
  const activeRebuilds = new Set<Promise<BoardSnapshot>>()
  // Pending presence and human actionability, keyed by BOTH slug and current session id. Provider
  // responses remain journal-pending until acknowledgement, but QUEUED/SENT is no longer a human ask:
  // keep its thread card readable while dropping it from Needs You. A replacement session therefore
  // cannot inherit either signal from the prior rollout.
  const pendingInteractionCache = new Map<string, { pending: boolean; needsUser: boolean }>()
  const interactionKey = (slug: string, sessionId: string) => `${slug}\u0000${sessionId}`
  // Per-slug "was this SESSION thread in the needs-you queue last build?" — drives the needs-decision
  // notify dedupe: we fire only on a false→true edge, and a thread leaving the queue re-arms it.
  const needsYouPrev = new Map<string, boolean>()
  // PRIME GUARD: the first assemble after boot records the baseline WITHOUT notifying, so a post-bounce
  // server doesn't fire a storm for every historical resting thread already in the queue.
  let notifyPrimed = false

  // Fire a needs-decision notify for every registered session that newly enters the queue.
  // Edge-triggered + deduped; primed on the first build.
  function notifyNeedsYou(sessionThreads: ThreadView[]): void {
    const seen = new Set<string>()
    for (const t of sessionThreads) {
      seen.add(t.id)
      const now = t.needsYou ?? false
      const was = needsYouPrev.get(t.id) ?? false
      if (notifyPrimed && now && !was) {
        bus.publish({ type: "notify", slug: t.id, kind: "needs-decision", title: t.aiTitle || t.title || t.id, body: capLine(t.lastAssistant) })
      }
      needsYouPrev.set(t.id, now)
    }
    // forget threads that vanished so a reappearance re-notifies
    for (const id of [...needsYouPrev.keys()]) if (!seen.has(id)) needsYouPrev.delete(id)
    notifyPrimed = true
  }

  // File-backed migration/plan caches are recomputed only on a full rebuild (the recursive .fray
  // watcher catches changes). Overlay-only refreshes remain filesystem-free.
  let legacyTerminalCache = new Set<string>()
  let plansCache: PlanView[] = []

  // Build exactly the session-backed threads recorded by Fray UI. The registry is the provenance
  // boundary: historical rows remain valid after migration/restart, and both Claude and Codex use the
  // same durable shape. Raw tailer discoveries never confer ownership.
  function buildSessionThreads(nowMs: number): ThreadView[] {
    // Old/corrupt databases predate the canonical storage guard. Keep such rows inert instead of
    // emitting an invalid board id or allowing it to reach tailer/tmux consumers.
    const rows = storage.allSessions().filter((row) => ThreadSlug.safeParse(row.slug).success)
    const currentInteractionKeys = new Set<string>()
    const out: ThreadView[] = []
    for (const row of rows) {
      const key = interactionKey(row.slug, row.session_id)
      currentInteractionKeys.add(key)
      let interactionPresence = pendingInteractionCache.get(key)
      if (interactionPresence === undefined) {
        try {
          const scope = {
            projectId: project.id,
            threadSlug: row.slug,
            sessionId: row.session_id,
          }
          const pending = storage.interactions.listPending(scope)
          interactionPresence = {
            pending: pending.length > 0,
            needsUser: pending.some((interaction) => {
              const delivery = storage.interactions.providerDelivery(scope, interaction.id)
              return !delivery || (delivery.state !== "queued" && delivery.state !== "sent")
            }),
          }
        } catch {
          // Fail visible. A corrupt/unreadable journal must not silently hide a request that may hold
          // provider authority; the queue card will surface the scoped RPC error instead.
          interactionPresence = { pending: true, needsUser: true }
        }
        pendingInteractionCache.set(key, interactionPresence)
      }
      out.push(sessionThreadView(
        project.dir,
        storage,
        row,
        tailer.get(row.slug),
        legacyTerminalCache.has(row.slug),
        interactionPresence,
        nowMs,
      ))
    }
    for (const key of pendingInteractionCache.keys()) {
      if (!currentInteractionKeys.has(key)) pendingInteractionCache.delete(key)
    }
    return out
  }

  // Assemble a snapshot from registered sessions + plan artifacts. Unregistered legacy files and
  // foreign transcripts are excluded before any legacy parser is invoked, so they cannot contribute a
  // row, queue card, warning, or error. `frayActive` remains a capability bit for plan/scratch storage.
  function assemble(): BoardSnapshot {
    // One clock sample owns every snooze decision in this snapshot: expiry clearing, visibility,
    // needs-you derivation, and timer selection cannot disagree at a deadline boundary.
    const assembledAtMs = now()
    // Canonical UTC strings sort chronologically, so one indexed write clears every elapsed snooze.
    // This runs on every edge-triggered refresh as well as the level-triggered reconcile.
    storage.clearExpiredSnoozes(new Date(assembledAtMs).toISOString())
    const base = { projectDir: project.dir, projectName: project.name, projectLabel: project.label }
    const frayActive = frayDirExists(project.dir)
    const sessionThreads = buildSessionThreads(assembledAtMs)
    armSnoozeWake(sessionThreads, assembledAtMs)
    notifyNeedsYou(sessionThreads)
    return {
      ...base,
      frayActive,
      threads: sessionThreads,
      errors: [],
      warnings: [],
      errorItems: [],
      plans: plansCache,
    }
  }

  // Schedule the exact next user-snooze deadline instead of relying on the 15s reconciliation ceiling.
  // Long waits are chunked at Node's safe timeout limit; restart re-arms from the durable DB value.
  function queueSnoozeRefresh(): void {
    if (snoozeRefreshQueued) return
    snoozeRefreshQueued = true
    queueMicrotask(() => {
      snoozeRefreshQueued = false
      if (stopped) return
      refresh()
    })
  }

  function armSnoozeWake(threads: readonly ThreadView[], assembledAtMs: number): void {
    if (snoozeTimer) clearTimeout(snoozeTimer)
    snoozeTimer = null
    if (stopped) return
    let next = Infinity
    for (const thread of threads) {
      const at = Date.parse(thread.snoozedUntil ?? "")
      if (Number.isFinite(at) && at > assembledAtMs) next = Math.min(next, at)
    }
    if (!Number.isFinite(next)) return
    // Assembly can take long enough to cross the selected deadline. Rebuild immediately in that case
    // instead of dropping the now-due deadline and waiting for the 15s reconcile sweep.
    const schedulingNowMs = now()
    if (next <= schedulingNowMs) {
      queueSnoozeRefresh()
      return
    }
    const delay = Math.max(1, Math.min(next - schedulingNowMs + 1, 2_147_000_000))
    snoozeTimer = setTimeout(() => {
      snoozeTimer = null
      if (!stopped) queueSnoozeRefresh()
    }, delay)
    snoozeTimer.unref?.()
  }

  // Recompute the plans cache (full-read grade). Called on rebuild; empty when .fray/ is absent.
  function recomputePlans(): void {
    plansCache = frayDirExists(project.dir) ? readPlans(project.dir, storage.allSessions()) : []
  }

  function recomputeLegacyTerminalState(): void {
    legacyTerminalCache = new Set(
      storage.allSessions()
        // Auto-titled UI rows are session-first authority: a matching legacy filename is untrusted and
        // must not even be opened. Only a non-auto historical row can use the narrow terminal-status
        // migration bridge while its explicit lifecycle state is still absent.
        .filter((row) => row.state == null && row.archived !== 1 && row.title_auto !== 1 && registeredLegacyFileIsTerminal(project.dir, row.slug))
        .map((row) => row.slug),
    )
  }

  // Publish only what CHANGED. The differ holds the last-broadcast per-thread JSON; on each snapshot it
  // returns just the changed/added/removed threads (+ board-level meta when it moved), or null when
  // nothing moved — which is the dedupe that keeps the 1s tailer tick and 15s reconcile from streaming
  // identical multi-hundred-KB frames. A one-thread status change now ships ONE ThreadView, not 310KB.
  // Clients get the full board as their connect keyframe (see the /events handler), then these deltas.
  const differ = new BoardDiffer()
  function publish(snapshot: BoardSnapshot): void {
    const d = differ.diff(snapshot)
    if (!d) return
    bus.publish({ type: "board-delta", seq: d.seq, bootId, upserts: d.upserts, removed: d.removed, ...(d.meta ? { meta: d.meta } : {}) })
  }

  // FULL rebuild: recompute registered-file migration metadata + plans, then assemble.
  async function rebuildOnce(): Promise<BoardSnapshot> {
    if (stopped) throw new ProducerStoppedError("board")
    // One indexed expiry sweep per level-triggered reconcile keeps queue membership truthful even
    // with no browser mounted. Any transitions publish normal journal invalidations.
    storage.interactions.expireDue()
    recomputeLegacyTerminalState()
    recomputePlans()
    cached = assemble()
    publish(cached)
    return cached
  }

  function rebuild(): Promise<BoardSnapshot> {
    if (stopped) return Promise.reject(new ProducerStoppedError("board"))
    const task = rebuildOnce()
    activeRebuilds.add(task)
    task.then(
      () => activeRebuilds.delete(task),
      () => activeRebuilds.delete(task),
    )
    return task
  }

  // OVERLAY-ONLY rebuild: reuse the cached fray data. For tailer/session-registry changes.
  function refresh(): BoardSnapshot {
    if (stopped) throw new ProducerStoppedError("board")
    cached = assemble()
    publish(cached)
    return cached
  }

  function interactionChanged(change: InteractionChange): void {
    if (stopped) return
    const key = interactionKey(change.threadSlug, change.sessionId)
    // Delivery-only transitions keep lifecycle/revision unchanged, so always evict and re-read the
    // durable join. This prevents awaiting→queued→sent→acknowledged from oscillating the queue based on
    // whichever layer happened to notify last.
    pendingInteractionCache.delete(key)
    // Store observers may fire from within a surrounding SQLite transaction or while listPending is
    // expiring records during assembly. Defer and coalesce the refresh to avoid re-entrant builds.
    if (interactionRefreshQueued) return
    interactionRefreshQueued = true
    queueMicrotask(() => {
      interactionRefreshQueued = false
      if (stopped) return
      refresh()
    })
  }

  function scheduleRebuild() {
    if (stopped) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void rebuild().catch(() => {}), DEBOUNCE_MS)
  }

  function watchFrayDir(): Promise<void> {
    if (parcelSub || stopped) return Promise.resolve()
    if (watchSetup) return watchSetup
    const setup = (async () => {
      const next = await subscribe(join(project.dir, ".fray"), () => scheduleRebuild())
      if (stopped) {
        await next.unsubscribe()
        return
      }
      parcelSub = next
    })()
    watchSetup = setup
    void setup.then(
      () => { if (watchSetup === setup) watchSetup = null },
      () => { if (watchSetup === setup) watchSetup = null },
    )
    return setup
  }

  return {
    snapshot: async () => {
      if (stopped) throw new ProducerStoppedError("board")
      return cached ?? (await rebuild())
    },
    currentSeq: () => differ.currentSeq(),
    rebuild,
    refresh,
    interactionChanged,
    async start() {
      if (stopped) throw new ProducerStoppedError("board")
      await rebuild()
      if (stopped) return
      // LEVEL-TRIGGERED reconciliation: a periodic full rebuild guarantees convergence even if every
      // edge (watcher event, SSE push, mutation hook) is missed or fails — the UI can lag one period,
      // never forever. Edge-triggered paths above make it feel instant; this makes it CORRECT.
      reconcileTimer = setInterval(() => void rebuild().catch(() => {}), RECONCILE_MS)
      if (frayDirExists(project.dir)) {
        await watchFrayDir()
      } else {
        // .fray/ not created yet — watch the repo root (non-recursive) for its appearance,
        // then hand off to the recursive .fray watcher. Avoids recursively watching the whole repo.
        try {
          bootstrapWatch = fsWatch(project.dir, (_e, name) => {
            if (name === ".fray" && frayDirExists(project.dir)) {
              bootstrapWatch?.close()
              bootstrapWatch = null
              void watchFrayDir().catch(() => {})
              scheduleRebuild()
            }
          })
        } catch {
          // repo root unwatchable — board still serves on-demand via snapshot()
        }
      }
    },
    stop() {
      if (stopPromise) return stopPromise
      stopped = true
      stopPromise = (async () => {
        if (debounce) clearTimeout(debounce)
        debounce = null
        if (reconcileTimer) clearInterval(reconcileTimer)
        reconcileTimer = null
        if (snoozeTimer) clearTimeout(snoozeTimer)
        snoozeTimer = null
        bootstrapWatch?.close()
        bootstrapWatch = null
        const subscription = parcelSub
        parcelSub = null
        const pendingWatchSetup = watchSetup
        await Promise.all([
          pendingWatchSetup ?? Promise.resolve(),
          subscription?.unsubscribe() ?? Promise.resolve(),
        ])
        // Rebuilds are registry/plan reads only, but still drain them so a replacement generation never
        // publishes a stale delta after shutdown begins.
        await Promise.allSettled([...activeRebuilds])
      })()
      return stopPromise
    },
  }
}
