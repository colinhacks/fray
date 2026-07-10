import { watch as fsWatch, existsSync, readdirSync, readFileSync, statSync, type FSWatcher } from "node:fs"
import { join } from "node:path"
import watcher from "@parcel/watcher"
import type { BoardSnapshot, ThreadView, FrayStatus, BlockMechanism, RuntimeState, PlanView } from "@fray-ui/shared"
import { BoardDiffer } from "@fray-ui/shared"
import type { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import type { Storage, SessionRow } from "./storage.ts"
import type { Tailer, SessionTelemetry } from "./tailer.ts"
import { readBoard, frayDirExists, runThreadUpdate, type FrayThread, type FrayErrorItem } from "./fray.ts"
import * as tmux from "./tmux.ts"

// The read model: merges the fray board (source of truth for STATUS, via readBoard) with the
// session registry (runtime overlay — which tmux session backs a thread + unread) and the JSONL
// tailer (turn state + last-activity + assistant preview). Rebuilt on any .fray change (debounced)
// or any tailer state change. Changes fan out on the bus as KEYED PER-THREAD DELTAS (a BoardDiffer
// emits only the threads that changed); the full snapshot is the connect keyframe + the resync frame.

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
  hasRow: boolean,
  turn: "in-flight" | "idle" | undefined,
  permPrompt: boolean,
): RuntimeState {
  if (!hasRow) return "none"
  // Cached (batched list-panes) — this runs per-thread on EVERY overlay refresh; the uncached
  // two-subprocess isLive here starved the event loop whenever an agent was streaming.
  if (!tmux.isLiveCached(slug)) return "exited"
  if (permPrompt) return "perm-prompt"
  return turn === "idle" ? "turn-idle" : "running"
}

// Display fields are ONE-LINERS in every surface that renders them — cap them at the server so a
// thread whose agent wrote an essay into status_text can't fatten every snapshot push (on a large
// board these two fields alone were half a megabyte).
const LINE_CAP = 240
// `activity` is contractually a single ≤100-char gerund label; cap it defensively (tighter than the
// generic LINE_CAP) so a worker that over-writes it can't fatten every snapshot push.
const ACTIVITY_CAP = 100
function capLine(s: string | undefined | null, cap = LINE_CAP): string | undefined {
  if (!s) return undefined
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s
}

function toThreadView(t: FrayThread, storage: Storage, tailer: Tailer): ThreadView {
  const row = storage.getSession(t.id)
  const tele = tailer.get(t.id)
  const runtime = deriveRuntime(t.id, row !== undefined, tele?.turn, tele?.permPrompt ?? false)
  // TERMINAL threads (done/dismissed/archived, not unread, no live session) render as one slim
  // listing row — id/title/status is ALL the client shows, so it's all that ships. On a mature
  // board this is nearly every thread.
  const terminal =
    (row?.archived === 1 || t.status === "done" || t.status === "dismissed") &&
    (row ? row.unread !== 1 : true) &&
    (runtime === "none" || runtime === "exited")
  if (terminal) {
    return {
      id: t.id,
      title: t.title ?? "",
      status: (t.status ?? "done") as FrayStatus,
      hasPlan: Boolean(t.hasPlan), // derived plan-doc marker — cheap boolean, ships even on the slim row
      mechanism: null,
      humanBlocked: false,
      ready: false,
      dependsOn: [],
      externalDeps: [],
      agents: [],
      errors: [],
      warnings: [],
      runtime,
      unread: false,
      archived: row ? row.archived === 1 : false,
      spawnedAt: row?.spawned_at,
      aiTitle: tele?.aiTitle,
      titleAuto: row?.title_auto === 1,
      // Terminal (done/dismissed/archived, no live session): no live sub-agents/shells by definition,
      // and the slim row deliberately ships nothing rich — always empty here (pendingAsk stays absent).
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      // lastUserAt is an ORDERING key (not rich display) — the listing sorts every row incl.
      // terminals by it, so ship it even on the slim row (falls back to spawnedAt in groups.ts).
      lastUserAt: tele?.lastUserAt,
      kind: "legacy", // a .fray-file row — the collapsed Legacy shelf's read-only material
    }
  }
  return {
    id: t.id,
    title: t.title ?? "",
    // Board statuses are canonical; an invalid-status thread passes through as-is and carries
    // an entry in `errors`, so we surface the raw value rather than silently remapping it.
    status: (t.status ?? "active") as FrayStatus,
    statusText: capLine(t.status_text),
    activity: capLine(t.activity, ACTIVITY_CAP),
    next: capLine(t.next),
    hasPlan: Boolean(t.hasPlan), // derived: body has a `## Plan` section → quiet PLAN badge

    mechanism: t.status === "blocked" ? ((t.mechanism ?? "human") as BlockMechanism) : null,
    // `needs-human` is the declared awaiting-you state and THE queue definition. humanBlocked is now
    // re-derived from status alone (the field name is kept — it's read widely by the client's
    // needsAction / indicator logic); the board parser aliases legacy `blocked`+no-machine-field →
    // `needs-human`, so old threads map correctly once the parser change lands. `blocked` is now a pure
    // machine-wait (its mechanism above still drives the timer/threads glyphs) and never humanBlocked.
    humanBlocked: t.status === "needs-human",
    ready: Boolean(t.ready),
    dependsOn: t.threadDeps ?? [],
    externalDeps: (t.externalDeps ?? []).map((d) => d.label),
    owner: t.owner || undefined,
    revalidate: t.revalidate ? new Date(t.revalidate.atMs).toISOString() : undefined,
    agents: (t.agents ?? []).map((a) => ({ id: a.id, label: a.label, state: a.state })),
    errors: t.errors ?? [],
    warnings: t.warnings ?? [],
    runtime,
    sessionId: row?.session_id,
    tmuxName: row?.tmux_name,
    unread: row ? row.unread === 1 : false,
    archived: row ? row.archived === 1 : false,
    lastAssistant: tele?.lastAssistant,
    spawnedAt: row?.spawned_at,
    lastActivityAt: tele?.lastActivityAt,
    aiTitle: tele?.aiTitle,
    titleAuto: row?.title_auto === 1,
    // Live background sub-agents this worker dispatched (empty when none / no session yet).
    subAgents: tele?.subAgents ?? [],
    // Live background shells this worker launched (the anchored ops strip; empty when none).
    bgShells: tele?.bgShells ?? [],
    // A pending native AskUserQuestion the session is frozen on (the safety net; else undefined).
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    // Derived safety net: at rest with a chat-only ```question the worker never encoded as blocked.
    pendingQuestion: tele?.pendingQuestion ?? false,
    // Newest user-role record — the listing's chronological sort key (user answer/steer/dispatch
    // bumps the row to the top). Falls back to spawnedAt in groups.ts when absent.
    lastUserAt: tele?.lastUserAt,
    kind: "legacy", // a .fray-file row — the collapsed Legacy shelf's read-only material
  }
}

// ---- Session threads (2026-07-09): the working rail's unit — one ThreadView per registry row
// (storage.allSessions()) plus one per foreign session (tailer.foreignIds()). The fray board's
// status vocabulary does NOT apply: `status` is synthesized "active" (the field is required but
// UNUSED for session rows — display keys on kind/state/needsYou, not status), and the block/dep
// fields are inert. State + queue membership are derived below.

// Parse an ISO time to epoch-ms, or -Infinity when absent/unparseable (a missing clearance never
// beats a real activity time in the needsYou compare below).
function timeOrNegInf(s: string | null | undefined): number {
  if (!s) return -Infinity
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : -Infinity
}

// EFFECTIVE lifecycle state for a session row (open|archived). An explicit state write wins; else the
// legacy archived flag; else a paired legacy .fray thread at terminal status (a pre-migration session
// must not flood the working rail); else open. Foreign threads are always open (handled at the call site).
function effectiveSessionState(row: SessionRow, legacyTerminal: boolean): "open" | "archived" {
  if (row.state === "open" || row.state === "archived") return row.state
  if (row.archived === 1) return "archived"
  if (legacyTerminal) return "archived"
  return "open"
}

// SERVER-DERIVED queue membership for a REGISTERED session thread (foreign/archived → false at the
// call site). perm-prompt and a pending native ask are PROCESS-level blocks a view can't clear, so they
// force needsYou. Otherwise the thread must be AT REST (turn-idle / exited) and UNEXCUSED (no done/awaiting
// fence), with its last activity strictly newer than the last interaction clearance (max of seen_at,
// last_read_at). No valid lastActivityAt → never in the queue.
export function deriveNeedsYou(row: SessionRow, tele: SessionTelemetry | undefined, runtime: RuntimeState): boolean {
  if (runtime === "perm-prompt") return true
  if (tele?.pendingAsk) return true
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
  // EXPLICIT ASKS ONLY (maintainer 2026-07-10): the queue is a thread that ASKED something — a native
  // ask, a ```question, a permission prompt, or a crash mid-work. A BARE rest (the agent hit end_turn
  // without asking anything — it finished, or it's waiting on machine work it described only in prose)
  // does NOT card. Reason: the earlier "at rest = your move, cards until seen" inversion was noisy in
  // practice — a classic worker that rested with "I'll verify CI when the fixer reports back" (no fence,
  // no live child) showed a loud awaiting-you dot with nothing for the human to do. A thread that truly
  // needs you ASKS (a question fence) or the worker EXCUSES it (a done/awaiting fence); an un-asked rest
  // is idle, shown quietly in the sidebar, never queued. (This makes seen_at/interaction-clearance moot
  // for the queue — a real ask stays until answered, not until glanced at.)
  return false
}

// The scratchpad path for a session, iff the file exists under the project dir (else undefined so the
// client offers no doc tab). Convention: .fray/scratch/<session_id>.md.
function scratchpadPathIfExists(projectDir: string, sessionId: string): string | undefined {
  const rel = `.fray/scratch/${sessionId}.md`
  return existsSync(join(projectDir, rel)) ? rel : undefined
}

// A REGISTERED session thread's view (id = row.slug). Runtime via the shared deriveRuntime (tmux-aware);
// telemetry fields mirror the legacy path exactly. Display prefers aiTitle client-side over row.title.
function sessionThreadView(projectDir: string, row: SessionRow, tele: SessionTelemetry | undefined, legacyTerminal: boolean): ThreadView {
  const runtime = deriveRuntime(row.slug, true, tele?.turn, tele?.permPrompt ?? false)
  const state = effectiveSessionState(row, legacyTerminal)
  const archived = state === "archived"
  const needsYou = archived ? false : deriveNeedsYou(row, tele, runtime)
  return {
    id: row.slug,
    title: row.title ?? "",
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
    aiTitle: tele?.aiTitle,
    titleAuto: row.title_auto === 1,
    subAgents: tele?.subAgents ?? [],
    bgShells: tele?.bgShells ?? [],
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    pendingQuestion: tele?.pendingQuestion ?? false,
    lastUserAt: tele?.lastUserAt,
    kind: "session",
    foreign: false,
    lastFence: tele?.lastFence,
    seenAt: row.seen_at ?? undefined,
    planPath: row.plan_path ?? undefined,
    state,
    needsYou,
    scratchpadPath: scratchpadPathIfExists(projectDir, row.session_id),
  }
}

// A FOREIGN session thread's view (a maintainer terminal — id = session id, no registry row). Read-only:
// runtime is derived WITHOUT tmux (never call tmux for a session we don't own), no queue membership, no
// archive/seen/unread state, no tmux-verb fields.
function foreignThreadView(sessionId: string, tele: SessionTelemetry | undefined): ThreadView {
  const runtime: RuntimeState = tele?.turn === "idle" ? "turn-idle" : "running"
  return {
    id: sessionId,
    title: "",
    status: "active", // synthesized (unused for session rows)
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
    sessionId,
    unread: false,
    archived: false,
    lastAssistant: tele?.lastAssistant,
    lastActivityAt: tele?.lastActivityAt,
    aiTitle: tele?.aiTitle,
    subAgents: tele?.subAgents ?? [],
    bgShells: tele?.bgShells ?? [],
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    pendingQuestion: tele?.pendingQuestion ?? false,
    lastUserAt: tele?.lastUserAt,
    kind: "session",
    foreign: true,
    lastFence: tele?.lastFence,
    state: "open",
    needsYou: false,
    // Deliberately never set for foreign threads: the scratchpad READ RPC resolves through a registry
    // row (rowless → ""), so advertising a path here would offer a doc tab that can't load. Foreign
    // sessions aren't fray-provisioned anyway — no pad exists.
    scratchpadPath: undefined,
  }
}

// Plan artifacts (.fray/plans/*.md): title from the first markdown heading in the head of the file (else
// the filename stem), mtime, and the slugs of any session rows dispatched from it. All fs errors → skip /
// []. Recomputed on rebuild (the recursive .fray watcher fires on .fray/plans changes).
function readPlans(projectDir: string, rows: SessionRow[]): PlanView[] {
  const plansDir = join(projectDir, ".fray", "plans")
  let files: string[]
  try {
    files = readdirSync(plansDir).filter((f) => f.endsWith(".md") && !f.startsWith("."))
  } catch {
    return [] // no plans dir (or unreadable) — no Plans section data
  }
  const out: PlanView[] = []
  for (const file of files) {
    const rel = `.fray/plans/${file}`
    let title = file.replace(/\.md$/, "")
    let updatedAt: string | undefined
    try {
      const full = join(plansDir, file)
      updatedAt = statSync(full).mtime.toISOString()
      const head = readFileSync(full, "utf8").split("\n").slice(0, 50)
      const h = head.find((l) => /^#{1,6}\s+\S/.test(l))
      if (h) title = h.replace(/^#{1,6}\s+/, "").trim() || title
    } catch {
      // unreadable file — keep the filename stem, no mtime
    }
    const threadIds = rows.filter((r) => r.plan_path === rel).map((r) => r.slug)
    out.push({ path: rel, title, updatedAt, threadIds })
  }
  return out
}

export interface BoardManager {
  snapshot(): Promise<BoardSnapshot>
  // The seq the current snapshot corresponds to — the value a connect keyframe must advertise so the
  // client can adopt it and then apply deltas seq+1, seq+2 … (see the /events handler). Read
  // synchronously right after snapshot() so the two are consistent.
  currentSeq(): number
  // Full: re-runs the fray shell-out. Use when .fray/ content changed.
  rebuild(): Promise<BoardSnapshot>
  // Overlay-only: reuses the cached fray board; cheap + sync. Use for tailer/session changes.
  refresh(): BoardSnapshot
  start(): Promise<void>
  stop(): Promise<void>
}

export function createBoard(project: Project, storage: Storage, bus: Bus, tailer: Tailer, bootId: string): BoardManager {
  let cached: BoardSnapshot | null = null
  let parcelSub: watcher.AsyncSubscription | null = null
  let bootstrapWatch: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  const frayDir = join(project.dir, ".fray")
  // Per-slug "was this SESSION thread in the needs-you queue last build?" — drives the needs-decision
  // notify dedupe: we fire only on a false→true edge, and a thread leaving the queue re-arms it.
  const needsYouPrev = new Map<string, boolean>()
  // PRIME GUARD: the first assemble after boot records the baseline WITHOUT notifying, so a post-bounce
  // server doesn't fire a storm for every historical resting thread already in the queue.
  let notifyPrimed = false

  // Fire a needs-decision notify for every SESSION thread that has NEWLY entered the needs-you queue
  // (legacy rows are shelved vestiges — no notifies). Edge-triggered + deduped; primed on the first build.
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

  // Sync Claude's evolving ai-title into the thread FILE for auto-titled dispatches ("rename
  // periodically"): the display already prefers aiTitle live; this makes it durable in fray.
  // Guarded per-slug so each new ai-title writes exactly once (the write itself retriggers the
  // watcher, which would otherwise loop).
  const syncedTitles = new Map<string, string>()
  function syncAutoTitles(threads: ThreadView[]): void {
    for (const t of threads) {
      const ai = t.aiTitle?.trim()
      if (!ai || ai === t.title) continue
      // Only sync into a thread FILE that exists: new session dispatches have no .fray/<slug>.md, and
      // shelling out to fray-update against a missing file just fails and retry-loops. The row title
      // (row.title) plus client-side aiTitle preference already cover fileless session threads.
      if (!existsSync(join(frayDir, `${t.id}.md`))) continue
      const row = storage.getSession(t.id)
      if (!row || row.title_auto !== 1) continue
      if (syncedTitles.get(t.id) === ai) continue
      syncedTitles.set(t.id, ai)
      runThreadUpdate(project.dir, t.id, ["--set", `title=${ai}`]).catch(() => {
        syncedTitles.delete(t.id) // retry on the next build
      })
    }
  }

  // The parsed fray board (from the shell-out) is CACHED: the expensive `readBoard` subprocess
  // runs only when .fray/ actually changes; tailer/session-registry changes reuse the cache and
  // re-run only the cheap in-memory overlay. Before this split, every overlay-ish change (a 1s
  // tailer tick, a markRead) paid the full subprocess — rebuilds queued up and RPC handlers that
  // awaited them stalled for many seconds.
  let frayCache: Awaited<ReturnType<typeof readBoard>> | null = null
  let frayErr: string | null = null
  // Plan artifacts cache — recomputed on rebuild alongside frayCache (the recursive .fray watcher fires
  // on .fray/plans changes). assemble() reads it so an overlay-only refresh doesn't re-stat the dir.
  let plansCache: PlanView[] = []
  let reading: Promise<void> | null = null
  // Self-healing: a failed read is NEVER terminal — it schedules its own retry with backoff, so the
  // board converges without waiting for the next external event. (A truncated shell-out once left a
  // permanently empty board with the error buried in an unrendered field.)
  let retryTimer: NodeJS.Timeout | null = null
  let retryDelay = 1000

  async function refreshFrayCache(): Promise<void> {
    // Coalesce concurrent full reads — one subprocess at a time, everyone awaits the same one.
    if (!reading) {
      reading = readBoard(project.dir)
        .then((b) => {
          frayCache = b
          frayErr = null
          retryDelay = 1000
        })
        .catch((err) => {
          frayErr = `board read failed: ${err instanceof Error ? err.message : String(err)}`
          if (retryTimer) clearTimeout(retryTimer)
          retryTimer = setTimeout(() => void rebuild(), retryDelay)
          retryDelay = Math.min(retryDelay * 2, 15_000)
        })
        .finally(() => {
          reading = null
        })
    }
    await reading
  }

  // Assemble a snapshot from the cached fray data + live overlay (storage/tailer). Cheap and sync.
  // A board-read failure (frayErr) has no single file to name — surface it as a non-repairable
  // structured item so the banner can render one uniform list off `errorItems` alone.
  const readErrItem = (): FrayErrorItem[] => (frayErr ? [{ file: "", kind: "other" as const, message: frayErr }] : [])

  // Build the session-backed threads: one per registry row + one per foreign session. Legacy status (for
  // the effective-state derivation — a pre-migration session paired with a terminal .fray file archives)
  // comes from the cached fray board when present.
  function buildSessionThreads(): ThreadView[] {
    const rows = storage.allSessions()
    const legacyTerminal = new Set<string>()
    if (frayCache) for (const t of frayCache.threads) if (t.status === "done" || t.status === "dismissed") legacyTerminal.add(t.id)
    const registered = new Set<string>()
    const out: ThreadView[] = []
    for (const row of rows) {
      registered.add(row.session_id)
      out.push(sessionThreadView(project.dir, row, tailer.get(row.slug), legacyTerminal.has(row.slug)))
    }
    // Foreign sessions (id = session id). Skip any that already back a registry row (defensive — a
    // registered session's jsonl should never surface in foreignIds, but never render it twice).
    for (const sid of tailer.foreignIds()) {
      if (registered.has(sid)) continue
      out.push(foreignThreadView(sid, tailer.get(sid)))
    }
    return out
  }

  // Assemble a snapshot from the cached fray data + live overlay (storage/tailer) + plans cache. Cheap and
  // sync. Session threads and plans emit REGARDLESS of .fray/ existence; legacy (.fray-file) rows only
  // when the board read has landed. frayActive tracks .fray/ presence (the legacy source of truth).
  //
  // ONE ROW PER ID: a slug with both a registry row and a .fray file emits ONLY the session row.
  // (The earlier "render both by design" call was unsound: registered session threads use the slug
  // as their id, so the legacy twin COLLIDED in the id-keyed BoardDiffer — each rebuild flip-flopped
  // which representation won and the first delta after page load replaced every session row with its
  // legacy twin, emptying the sidebar's working sections. Found live 2026-07-09. The paired file
  // stays reachable through the session thread's doc drawer.)
  function assemble(): BoardSnapshot {
    const base = { projectDir: project.dir, projectName: project.name, projectLabel: project.label }
    const frayActive = frayDirExists(project.dir)
    const sessionThreads = buildSessionThreads()
    const sessionIds = new Set(sessionThreads.map((t) => t.id))
    const legacyThreads =
      frayActive && frayCache
        ? frayCache.threads.map((t) => toThreadView(t, storage, tailer)).filter((t) => !sessionIds.has(t.id))
        : []
    notifyNeedsYou(sessionThreads)
    syncAutoTitles(sessionThreads)
    const errors = frayActive ? [...(frayCache?.errors ?? []), ...(frayErr ? [frayErr] : [])] : []
    const warnings = frayActive ? (frayCache?.warnings ?? []) : []
    const errorItems = frayActive ? [...(frayCache?.errorItems ?? []), ...readErrItem()] : []
    return { ...base, frayActive, threads: [...legacyThreads, ...sessionThreads], errors, warnings, errorItems, plans: plansCache }
  }

  // Recompute the plans cache (full-read grade). Called on rebuild; empty when .fray/ is absent.
  function recomputePlans(): void {
    plansCache = frayDirExists(project.dir) ? readPlans(project.dir, storage.allSessions()) : []
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

  // FULL rebuild: re-read the fray board (subprocess) then assemble. For .fray changes.
  async function rebuild(): Promise<BoardSnapshot> {
    await refreshFrayCache()
    recomputePlans()
    cached = assemble()
    publish(cached)
    return cached
  }

  // OVERLAY-ONLY rebuild: reuse the cached fray data. For tailer/session-registry changes.
  function refresh(): BoardSnapshot {
    cached = assemble()
    publish(cached)
    return cached
  }

  function scheduleRebuild() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void rebuild(), DEBOUNCE_MS)
  }

  async function watchFrayDir() {
    if (parcelSub) return
    parcelSub = await watcher.subscribe(join(project.dir, ".fray"), () => scheduleRebuild())
  }

  return {
    snapshot: async () => cached ?? (await rebuild()),
    currentSeq: () => differ.currentSeq(),
    rebuild,
    refresh,
    async start() {
      await rebuild()
      // LEVEL-TRIGGERED reconciliation: a periodic full rebuild guarantees convergence even if every
      // edge (watcher event, SSE push, mutation hook) is missed or fails — the UI can lag one period,
      // never forever. Edge-triggered paths above make it feel instant; this makes it CORRECT.
      reconcileTimer = setInterval(() => void rebuild(), RECONCILE_MS)
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
              void watchFrayDir()
              scheduleRebuild()
            }
          })
        } catch {
          // repo root unwatchable — board still serves on-demand via snapshot()
        }
      }
    },
    async stop() {
      if (debounce) clearTimeout(debounce)
      if (retryTimer) clearTimeout(retryTimer)
      if (reconcileTimer) clearInterval(reconcileTimer)
      bootstrapWatch?.close()
      await parcelSub?.unsubscribe()
      parcelSub = null
    },
  }
}
