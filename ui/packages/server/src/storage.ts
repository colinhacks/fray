import Database from "better-sqlite3"
import { ThreadSlug, tmuxSessionName } from "@fray-ui/shared"
import { createInteractionStore, type InteractionStore } from "./interaction-store.ts"

// The UI-state store (never .fray/): session registry + settings. SQLite at
// stateDir/ui.db, WAL for concurrent read while the watcher writes. Fray thread files stay
// the source of truth for STATUS; this DB holds only runtime overlay (which tmux session
// backs a thread, unread, last-read) and settings.

export interface SessionRow {
  slug: string
  session_id: string
  tmux_name: string
  spawned_at: string // ISO8601
  last_read_at: string | null // ISO8601
  unread: number // 0 | 1
  exited: number // 0 | 1
  archived: number // 0 | 1 — user hid the row from the nav; any respawn/resume un-archives
  rested_at: string | null // ISO8601 — when the agent last came to REST (turn end / pane death); drives nav order
  title_auto: number // 0 | 1 — no explicit user title at dispatch, so ai-title syncs into the file
  // ---- session-first columns (2026-07-09; all nullable — additive migration under a live server) ----
  title: string | null // dispatch title (new dispatches have no thread FILE to hold it); display prefers aiTitle
  // The filename stem of the DISCOVERED transcript when it drifted off the pinned `<session_id>.jsonl`
  // (a worker whose real transcript lives at a different id). NULL in the normal case — the read side
  // then binds `<session_id>.jsonl` directly. Cached by the tailer's discovery fallback so the drifted
  // path survives restarts AND so foreign-discovery doesn't surface the re-linked transcript as a
  // duplicate thread. See tailer.ts / discover.ts. session_id stays the pinned resume/scratchpad key.
  transcript_id: string | null
  // Lifecycle: 'open' | 'archived'. NULL = never explicitly set (pre-migration row) — the board derives
  // an effective state (archived flag ⇒ archived; paired legacy .fray file with terminal status ⇒
  // archived; else open) so historical sessions don't flood the working rail. Written ONLY by explicit
  // Archive/Reopen (the done FENCE mutates nothing — maintainer-settled).
  state: string | null
  // Exact UTC instant chosen by the human. This is lifecycle metadata (like Archive), never inferred
  // from an agent fence. Optional keeps old fixtures/source-compatible; SQLite always returns null or
  // a concrete value after the additive migration.
  snoozed_until?: string | null
  meta: string | null // JSON blob for future annotations (unparsed here)
  seen_at: string | null // ISO8601 — interaction clearance: recorded when the human opens the thread
  plan_path: string | null // project-relative .fray/plans/*.md this thread was dispatched from
  // Which agent backend serves this session (Codex-support epic). Optional in the TS shape (older rows
  // + the many test-fixture literals predate it); the SQLite column carries a "claude" DEFAULT so every
  // existing row and all current behavior are unchanged. Phase 1 only ever writes "claude".
  backend?: string
  // The backend's OWN native session id when it differs from the fray-minted session_id (Codex-support
  // epic, Phase 2). Claude pins session_id via --session-id, so its native id IS session_id and this
  // stays NULL. Codex mints its OWN rollout id (discovered post-spawn), so session_id remains the fray
  // UUID (the sentinel + scratchpad key) and the discovered codex id is pinned HERE — the id the tailer
  // locates the rollout with and resume re-attaches. Readers use `agent_session_id ?? session_id`, so a
  // claude row (NULL) is byte-identical to before.
  agent_session_id?: string | null
  // The resolved model + reasoning-effort values this session was STARTED with. These are deliberately
  // session metadata, not a live read of Settings: changing the global dispatch defaults later must not
  // relabel an existing thread. Nullable/optional keeps migrated, adopted-old, and foreign sessions honest
  // when fray never observed a concrete CLI value.
  model?: string | null
  effort?: string | null
  // A live profile request is armed as one complete pair. The committed model/effort stay visible
  // and rollback-safe until the replacement generation reaches a proven idle composer.
  profile_pending_model?: string | null
  profile_pending_effort?: string | null
  profile_revision?: number
  // Versioned crash journal for an in-flight model/effort reattach. This remains populated while
  // runtime_control='profile'; restart recovery must prove one exact runtime before clearing either.
  profile_handoff?: string | null
  // The concrete permission mode / codex-sandbox mapping selected for THIS session. NULL means a
  // migrated row whose launch argv predates persistence; once explicitly set it always wins over
  // mutable global Settings on every later resume.
  permission_mode?: string | null
  // A requested live permission change that has not yet been observed in backend telemetry. Kept
  // separately from permission_mode so the board never presents an optimistic selection as actual.
  permission_pending?: string | null
  // Durable Codex TUI control state. The queue survives Fray restarts; control_error explains why
  // neither a queued follow-up nor a permission request can safely advance right now.
  codex_input_queue?: string | null
  control_error?: string | null
  // Monotonic process incarnation for this Fray session. Incremented atomically before every
  // respawn/reattach so output or async completion from an older process cannot mutate the new one.
  runtime_generation?: number
  // Durable, mutually-exclusive native runtime control. The revision prevents ABA when one control
  // finishes and another starts with the same kind while an async pane operation is still returning.
  runtime_control?: string | null
  runtime_control_revision?: number
}

export interface RuntimeExpectation {
  sessionId: string
  generation: number
  permissionPending: string | null
  runtimeControl?: string | null
}

export type RuntimeControlKind = "permission" | "profile" | "resume" | "follow-up" | "codex-input" | "ai-rename"

export type ProfileHandoffPhase =
  | "armed"
  | "target-starting"
  | "target-spawned"
  | "target-ready"
  | "rollback-starting"
  | "rollback-spawned"
  | "rollback-ready"

export interface ProfileHandoffBinding {
  kind: "standalone" | "adopted"
  paneId: string
  panePid: number
  sessionCreated: number
  adoptionAttemptToken?: string
  handoffToken?: string
}

export interface ProfileHandoffLeg {
  generation: number
  handoffToken: string
  binding?: ProfileHandoffBinding
}

export interface ProfileHandoffJournal {
  version: 1
  phase: ProfileHandoffPhase
  nativeSessionId: string
  previous: { model: string; effort: string; binding: ProfileHandoffBinding }
  requested: { model: string; effort: string }
  target?: ProfileHandoffLeg
  rollback?: ProfileHandoffLeg
}

export interface ProfileChangeExpectation {
  sessionId: string
  nativeSessionId: string | null
  generation: number
  profileRevision: number
  controlRevision: number
  model: string
  effort: string
  profileHandoff: string
}

export interface AutoTitleExpectation {
  sessionId: string
  nativeSessionId: string | null
  runtimeGeneration: number
}

export type AdoptionClaimState = "reserved" | "spawned" | "recovering" | "finalized"

// A cold-adoption attempt owns its slug in SQLite before it is allowed to create a tmux session.
// The tmux tuple is filled immediately after new-session returns; the attempt token is also embedded
// in the tmux session environment, which lets restart recovery identify the otherwise tiny window
// between tmux creation and this row update without guessing from a reusable slug or PID.
export interface AdoptionClaimRow {
  slug: string
  attempt_token: string
  session_id: string
  state: AdoptionClaimState
  reserved_at_ms: number
  lease_expires_at_ms: number
  recovery_token: string | null
  pane_id: string | null
  pane_pid: number | null
  session_created: number | null
  finalized_at_ms: number | null
}

export interface AdoptionPaneIdentity {
  paneId: string
  panePid: number
  sessionCreated: number
}

export interface AdoptionReservation {
  slug: string
  attemptToken: string
  sessionId: string
  reservedAtMs: number
  leaseExpiresAtMs: number
}

// Tokens are never reusable after an attempt gives up ownership. Keeping the retirement ledger
// durable lets boot recovery find a pane created by an old process that resumed after its lease was
// recovered. New processes are additionally fenced under SQLite's writer lock before spawning.
export interface RetiredAdoptionAttemptRow {
  attempt_token: string
  slug: string
  session_id: string
  retired_at_ms: number
}

export interface ForgetSessionExpectation {
  sessionId: string
  runtimeGeneration: number
  adoptionAttemptToken: string | null
}

export type AdoptionSpawnFenceResult<T> =
  | { acquired: false }
  | { acquired: true; value: T }

export interface Storage {
  db: Database.Database
  interactions: InteractionStore
  getSession(slug: string): SessionRow | undefined
  allSessions(): SessionRow[]
  subscribeSessionLifecycle(listener: (event: SessionLifecycleEvent) => void): () => void
  upsertSession(row: SessionRow): void
  // Claim a previously-unowned slug without ever replacing its current owner. This is the registry
  // compare-and-swap used by cold adoption after spawn: a competing writer either wins atomically or
  // leaves its row byte-for-byte untouched. Unlike the legacy upsert, identity columns are part of the
  // same INSERT so backend/native-session ownership can never be partially updated across backends.
  insertSessionIfAbsent(row: SessionRow): boolean
  getAdoptionClaim(slug: string): AdoptionClaimRow | undefined
  getAdoptionRuntimeSnapshot(slug: string): {
    session: SessionRow | undefined
    claim: AdoptionClaimRow | undefined
  }
  allAdoptionClaims(): AdoptionClaimRow[]
  allRetiredAdoptionAttempts(): RetiredAdoptionAttemptRow[]
  // INSERT ... WHERE no session owner exists. The slug PK and token UNIQUE constraint serialize
  // separate Fray processes/connections; a loser never reaches tmux.
  reserveAdoptionClaim(reservation: AdoptionReservation): boolean
  recordAdoptionPane(
    slug: string,
    attemptToken: string,
    identity: AdoptionPaneIdentity,
    leaseExpiresAtMs: number,
  ): boolean
  // Revalidate the exact token while holding SQLite's write lock across new-session and the first
  // pane bind. Recovery on another connection cannot retire the token in the validation→spawn gap.
  withAdoptionSpawnFence<T>(
    slug: string,
    attemptToken: string,
    leaseExpiresAtMs: number,
    spawn: (bindPane: (identity: AdoptionPaneIdentity, leaseExpiresAtMs: number) => boolean) => T,
  ): AdoptionSpawnFenceResult<T>
  // The session INSERT and claim finalization are one SQLite transaction. False means another row
  // won; the spawned attempt remains recoverable and must be exact-pane cleaned by its owner/restart.
  finalizeAdoptionClaim(slug: string, attemptToken: string, row: SessionRow, finalizedAtMs: number): boolean
  // Reuse the durable binding for a legitimate resume without an unbound gap. While reserved/spawned,
  // every reader sees a conflict and fails closed; recovery restores a finalized no-pane binding.
  rearmFinalizedAdoptionClaim(reservation: AdoptionReservation, previousAttemptToken: string): boolean
  finalizeAdoptionRespawnClaim(
    slug: string,
    attemptToken: string,
    sessionId: string,
    finalizedAtMs: number,
  ): boolean
  // The live owner may abandon only its own non-finalized token after proving its pane is absent.
  abandonAdoptionClaim(slug: string, attemptToken: string): boolean
  // Lease takeover is itself CAS + leased, so two booting servers cannot both clean one attempt and
  // a recovery process killed midway can be safely superseded after its recovery lease expires.
  beginAdoptionRecovery(
    slug: string,
    attemptToken: string,
    recoveryToken: string,
    nowMs: number,
    leaseExpiresAtMs: number,
  ): AdoptionClaimRow | undefined
  finishAdoptionRecovery(slug: string, attemptToken: string, recoveryToken: string): boolean
  retireFinalizedAdoptionClaim(slug: string, sessionId: string, attemptToken: string): boolean
  markRead(slug: string, at?: string): void
  setUnread(slug: string, unread: boolean): void
  setUnreadIfCurrent(slug: string, sessionId: string, generation: number, unread: boolean): boolean
  setExited(slug: string, exited: boolean): void
  setExitedIfCurrent(slug: string, sessionId: string, generation: number, exited: boolean): boolean
  // Completion is one CAS write: a verified stopped runtime becomes exited + Done together, while
  // clearing stale attention/wake state. A replaced owner/generation observes zero changes.
  completeIfCurrent(slug: string, sessionId: string, generation: number): boolean
  setArchived(slug: string, archived: boolean): void
  setRestedAt(slug: string, at: string): void
  setRestedAtIfCurrent(slug: string, sessionId: string, generation: number, at: string): boolean
  setSeenAt(slug: string, at: string): void
  // Cache/clear the discovered transcript filename stem (the read-side discovery fallback's result).
  setTranscriptId(slug: string, transcriptId: string | null): void
  setTranscriptIdIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    transcriptId: string | null,
  ): boolean
  // Explicit lifecycle write (Archive button / Reopen). Keeps the legacy `archived` flag in sync so
  // pre-restart readers of that column stay honest; archiving also clears unread (never badge a
  // deliberately-shelved thread).
  setState(slug: string, state: "open" | "archived"): void
  setStateIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    state: "open" | "archived",
  ): boolean
  setSnoozedUntil(slug: string, until: string | null): void
  // Clears elapsed values atomically and returns the number changed. The board calls this at each
  // refresh and at its exact wake timer so restart/reload cannot leave a stale Held marker behind.
  clearExpiredSnoozes(now: string): number
  // Persist an EXPLICIT human title. The flag flip is atomic with the text write so no board refresh,
  // transcript ai-title, resume upsert, or server restart can see the new title as machine-generated.
  setTitle(slug: string, title: string): void
  // AI rename is asynchronous. Commit only if this is still the same session with the same title
  // provenance captured at start, so a later manual rename/re-dispatch always wins.
  setTitleIfCurrent(
    slug: string,
    title: string,
    expected: { sessionId: string; title: string | null; titleAuto: number },
  ): boolean
  // Persist an automatically-derived title without changing its provenance. The full runtime identity
  // and title_auto guard make a late transcript fold harmless after manual rename, resume, or same-slug
  // replacement; a later trustworthy native auto-title may still supersede this fallback.
  setAutoTitleIfCurrent(slug: string, title: string, expected: AutoTitleExpectation): boolean
  // Hard-delete a session row — the "Dismiss/forget" verb for a phantom the user wants GONE, not merely
  // shelved (Archive only sets state='archived'). DELETEs the registry row AND records a TOMBSTONE on its
  // session_id + transcript_id, so foreign-discovery (which surfaces any fresh unregistered *.jsonl in the
  // log dir) can never resurrect the same transcript as a read-only "foreign" thread after the row is
  // gone. Idempotent: forgetting an absent/already-forgotten slug is a no-op. A fresh dispatch mints a NEW
  // session_id (never tombstoned), so re-dispatching the same slug still works — the tombstone keys on the
  // OLD session id only. Returns the forgotten row (for the caller to tear down its tailer state), or
  // undefined when nothing was there.
  forgetSession(slug: string): SessionRow | undefined
  // Forget only the row/runtime generation and finalized adoption owner the caller stopped. A
  // concurrent resume/replacement wins without having its new row or claim deleted by stale work.
  forgetSessionIfCurrent(slug: string, expected: ForgetSessionExpectation): SessionRow | undefined
  // Every tombstoned transcript id (session_id + any discovered transcript_id of a forgotten row). The
  // tailer's foreign-discovery consults this so a forgotten phantom's transcript stays excluded forever.
  forgottenIds(): Set<string>
  // Codex-support epic (Phase 2): pin the agent backend + its native session id on a row AFTER
  // dispatch. Kept OFF the shared upsert (whose named-param statement every claude caller + test
  // fixture feeds) so the codex path is purely additive — a claude dispatch never calls these, so its
  // `backend` stays the column DEFAULT 'claude' and `agent_session_id` stays NULL.
  setBackend(slug: string, backend: string): void
  setAgentSession(slug: string, agentSessionId: string): void
  setPermissionMode(slug: string, permissionMode: string): void
  setPermissionPending(slug: string, permissionMode: string | null): void
  beginRuntimeControl(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    kind: RuntimeControlKind,
  ): number | null
  releaseRuntimeControl(
    slug: string,
    expected: { sessionId: string; generation: number; kind: RuntimeControlKind; revision: number },
  ): boolean
  setProfileTargetIfCurrent(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    profile: { model: string; effort: string },
  ): boolean
  armProfileChange(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    profile: { model: string; effort: string },
    handoff: ProfileHandoffJournal,
  ): { profileRevision: number; controlRevision: number; profileHandoff: string } | null
  checkpointProfileChange(
    slug: string,
    expected: ProfileChangeExpectation,
    handoff: ProfileHandoffJournal,
  ): string | null
  commitProfileChange(slug: string, expected: ProfileChangeExpectation): boolean
  restoreProfileChange(
    slug: string,
    expected: ProfileChangeExpectation,
    previous: { model: string; effort: string },
    error: string,
  ): boolean
  blockProfileChange(slug: string, expected: ProfileChangeExpectation, error: string): boolean
  failProfileChange(slug: string, expected: ProfileChangeExpectation, error: string): boolean
  setObservedProfileIfCurrent(
    slug: string,
    expected: { sessionId: string; generation: number },
    profile: { model: string; effort: string },
  ): boolean
  // Stamp a new process generation BEFORE spawn. The expected pending value is part of ownership:
  // a different/recovered permission request cannot be overtaken by a late starter.
  beginRuntimeGeneration(slug: string, expected: RuntimeExpectation, spawnedAt: string): number | null
  setPermissionStateIfCurrent(
    slug: string,
    expected: RuntimeExpectation,
    state: { exited: boolean; permissionMode: string; permissionPending: string | null; controlError: string | null },
  ): boolean
  setObservedPermissionIfCurrent(slug: string, sessionId: string, generation: number, permissionMode: string): boolean
  setControlErrorIfCurrent(slug: string, sessionId: string, generation: number, error: string | null): boolean
  setCodexInputQueue(slug: string, queue: string | null): void
  setCodexInputQueueIfCurrent(
    slug: string,
    expected: { sessionId: string; generation: number; queue: string | null },
    queue: string | null,
  ): boolean
  setControlError(slug: string, error: string | null): void
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
  deleteSetting(key: string): void
  close(): void
}

export type SessionLifecycleEvent =
  | { type: "replaced"; previous: SessionRow; current: SessionRow }
  | { type: "deleted"; previous: SessionRow }

export function createStorage(dbPath: string): Storage {
  const db = new Database(dbPath)
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      slug        TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      tmux_name   TEXT NOT NULL,
      spawned_at  TEXT NOT NULL,
      last_read_at TEXT,
      unread      INTEGER NOT NULL DEFAULT 0,
      exited      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Forgotten-transcript graveyard: a transcript id (a session_id or a discovered transcript_id) whose
    -- registry row was hard-deleted via forgetSession. Foreign-discovery excludes these so a dismissed
    -- phantom can never re-surface as a read-only "foreign" thread on a later log-dir rescan.
    CREATE TABLE IF NOT EXISTS tombstone (
      transcript_id TEXT PRIMARY KEY,
      slug          TEXT NOT NULL,
      forgotten_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adoption_claim (
      slug                TEXT PRIMARY KEY,
      attempt_token       TEXT NOT NULL UNIQUE,
      session_id          TEXT NOT NULL UNIQUE,
      state               TEXT NOT NULL CHECK (state IN ('reserved', 'spawned', 'recovering', 'finalized')),
      reserved_at_ms      INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      recovery_token      TEXT,
      pane_id             TEXT,
      pane_pid            INTEGER,
      session_created     INTEGER,
      finalized_at_ms     INTEGER,
      CHECK (
        (pane_id IS NULL AND pane_pid IS NULL AND session_created IS NULL) OR
        (pane_id IS NOT NULL AND pane_pid IS NOT NULL AND session_created IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS adoption_retired_attempt (
      attempt_token TEXT PRIMARY KEY,
      slug          TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      retired_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adoption_retired_attempt_slug_idx
      ON adoption_retired_attempt(slug);
  `)
  // Best-effort inline migration for older DBs. Session-first/profile columns are nullable ADDs
  // (except the existing boolean/backend defaults) — additive + idempotent, safe while another server
  // process holds the db open (the live server never sees a shape it can't read).
  for (const col of [
    "archived INTEGER NOT NULL DEFAULT 0",
    "title_auto INTEGER NOT NULL DEFAULT 0",
    "rested_at TEXT",
    "title TEXT",
    "state TEXT",
    "snoozed_until TEXT",
    "meta TEXT",
    "seen_at TEXT",
    "plan_path TEXT",
    "transcript_id TEXT",
    "backend TEXT NOT NULL DEFAULT 'claude'",
    "agent_session_id TEXT",
    "model TEXT",
    "effort TEXT",
    "profile_pending_model TEXT",
    "profile_pending_effort TEXT",
    "profile_revision INTEGER NOT NULL DEFAULT 0",
    "profile_handoff TEXT",
    "permission_mode TEXT",
    "permission_pending TEXT",
    "codex_input_queue TEXT",
    "control_error TEXT",
    "runtime_generation INTEGER NOT NULL DEFAULT 0",
    "runtime_control TEXT",
    "runtime_control_revision INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE session ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
  // One-time idempotent backfill: rows the user already archived under the boolean flag carry that
  // into the new lifecycle column. Only fills NULLs — an explicit later state write always wins.
  try {
    db.exec("UPDATE session SET state = 'archived' WHERE archived = 1 AND state IS NULL")
  } catch {
    // best-effort
  }
  db.exec("CREATE INDEX IF NOT EXISTS session_snoozed_until_idx ON session(snoozed_until)")

  // The interaction journal is an additive, independently-versioned schema in this same project DB.
  // Construct it before session write statements: replacement/delete transactions below close any
  // pending requests owned by the superseded session atomically with the registry mutation.
  const interactions = createInteractionStore(db)
  const lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>()
  let closed = false
  const emitSessionLifecycle = (event: SessionLifecycleEvent) => {
    for (const listener of [...lifecycleListeners]) listener(event)
  }

  const selOne = db.prepare<[string], SessionRow>("SELECT * FROM session WHERE slug = ?")
  const selAll = db.prepare<[], SessionRow>("SELECT * FROM session")
  const upsertStmt = db.prepare(`
    INSERT INTO session (slug, session_id, tmux_name, spawned_at, last_read_at, unread, exited, title_auto, title, state, snoozed_until, meta, seen_at, plan_path, transcript_id, model, effort, profile_pending_model, profile_pending_effort, profile_revision, profile_handoff, permission_mode, permission_pending, codex_input_queue, control_error, runtime_generation, runtime_control, runtime_control_revision)
    VALUES (@slug, @session_id, @tmux_name, @spawned_at, @last_read_at, @unread, @exited, @title_auto, @title, @state, @snoozed_until, @meta, @seen_at, @plan_path, @transcript_id, @model, @effort, @profile_pending_model, @profile_pending_effort, @profile_revision, @profile_handoff, @permission_mode, @permission_pending, @codex_input_queue, @control_error, @runtime_generation, @runtime_control, @runtime_control_revision)
    ON CONFLICT(slug) DO UPDATE SET
      session_id = excluded.session_id,
      tmux_name  = excluded.tmux_name,
      spawned_at = excluded.spawned_at,
      last_read_at = excluded.last_read_at,
      unread = excluded.unread,
      exited = excluded.exited,
      title_auto = excluded.title_auto,
      title = excluded.title,
      snoozed_until = excluded.snoozed_until,
      plan_path = excluded.plan_path,
      model = excluded.model,
      effort = excluded.effort,
      profile_pending_model = excluded.profile_pending_model,
      profile_pending_effort = excluded.profile_pending_effort,
      profile_revision = excluded.profile_revision,
      profile_handoff = excluded.profile_handoff,
      permission_mode = excluded.permission_mode,
      permission_pending = excluded.permission_pending,
      codex_input_queue = excluded.codex_input_queue,
      control_error = excluded.control_error,
      runtime_generation = CASE
        WHEN session.session_id = excluded.session_id THEN MAX(session.runtime_generation, excluded.runtime_generation)
        ELSE excluded.runtime_generation
      END,
      runtime_control = excluded.runtime_control,
      runtime_control_revision = excluded.runtime_control_revision,
      -- A re-dispatch/adopt carries a FRESH session_id, so the old discovered path is stale → adopt the
      -- incoming value (NULL for a fresh spawn); a resume spreads the existing row, preserving its cache.
      transcript_id = excluded.transcript_id,
      archived = 0,
      state = 'open'
  `)
  const insertSessionIfAbsentStmt = db.prepare(`
    INSERT INTO session (
      slug, session_id, tmux_name, spawned_at, last_read_at, unread, exited, archived, rested_at,
      title_auto, title, transcript_id, state, snoozed_until, meta, seen_at, plan_path, backend, agent_session_id,
      model, effort, profile_pending_model, profile_pending_effort, profile_revision, profile_handoff,
      permission_mode, permission_pending, codex_input_queue, control_error,
      runtime_generation, runtime_control, runtime_control_revision
    )
    VALUES (
      @slug, @session_id, @tmux_name, @spawned_at, @last_read_at, @unread, @exited, @archived,
      @rested_at, @title_auto, @title, @transcript_id, @state, @snoozed_until, @meta, @seen_at, @plan_path,
      @backend, @agent_session_id, @model, @effort, @profile_pending_model,
      @profile_pending_effort, @profile_revision, @profile_handoff, @permission_mode, @permission_pending,
      @codex_input_queue, @control_error, @runtime_generation, @runtime_control,
      @runtime_control_revision
    )
    ON CONFLICT(slug) DO NOTHING
  `)
  const selAdoptionClaim = db.prepare<[string], AdoptionClaimRow>(
    "SELECT * FROM adoption_claim WHERE slug = ?",
  )
  const selAllAdoptionClaims = db.prepare<[], AdoptionClaimRow>("SELECT * FROM adoption_claim")
  const selAllRetiredAdoptionAttempts = db.prepare<[], RetiredAdoptionAttemptRow>(
    "SELECT * FROM adoption_retired_attempt ORDER BY retired_at_ms, attempt_token",
  )
  const selRetiredAdoptionAttempt = db.prepare<[string], RetiredAdoptionAttemptRow>(
    "SELECT * FROM adoption_retired_attempt WHERE attempt_token = ?",
  )
  const putRetiredAdoptionAttempt = db.prepare(`
    INSERT OR IGNORE INTO adoption_retired_attempt (attempt_token, slug, session_id, retired_at_ms)
    VALUES (?, ?, ?, ?)
  `)
  const reserveAdoptionClaimStmt = db.prepare(`
    INSERT INTO adoption_claim (
      slug, attempt_token, session_id, state, reserved_at_ms, lease_expires_at_ms,
      recovery_token, pane_id, pane_pid, session_created, finalized_at_ms
    )
    SELECT @slug, @attempt_token, @session_id, 'reserved', @reserved_at_ms, @lease_expires_at_ms,
           NULL, NULL, NULL, NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM session WHERE slug = @slug)
      AND NOT EXISTS (
        SELECT 1 FROM adoption_retired_attempt WHERE attempt_token = @attempt_token
      )
    ON CONFLICT DO NOTHING
  `)
  const recordAdoptionPaneStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'spawned', pane_id = @pane_id, pane_pid = @pane_pid,
        session_created = @session_created, lease_expires_at_ms = @lease_expires_at_ms
    WHERE slug = @slug AND attempt_token = @attempt_token
      AND state IN ('reserved', 'spawned')
      AND (
        pane_id IS NULL OR
        (pane_id = @pane_id AND pane_pid = @pane_pid AND session_created = @session_created)
      )
  `)
  const renewAdoptionSpawnFenceStmt = db.prepare(`
    UPDATE adoption_claim
    SET lease_expires_at_ms = ?
    WHERE slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
      AND recovery_token IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM adoption_retired_attempt
        WHERE attempt_token = adoption_claim.attempt_token
      )
  `)
  const finalizeAdoptionClaimStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', finalized_at_ms = ?, recovery_token = NULL
    WHERE slug = ? AND attempt_token = ? AND session_id = ? AND state = 'spawned'
      AND pane_id IS NOT NULL AND pane_pid IS NOT NULL AND session_created IS NOT NULL
  `)
  const rearmFinalizedAdoptionClaimStmt = db.prepare(`
    UPDATE adoption_claim
    SET attempt_token = @attempt_token, state = 'reserved', reserved_at_ms = @reserved_at_ms,
        lease_expires_at_ms = @lease_expires_at_ms, recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL, finalized_at_ms = NULL
    WHERE slug = @slug AND session_id = @session_id AND attempt_token = @previous_attempt_token
      AND state = 'finalized'
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const finalizeAdoptionRespawnClaimStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', finalized_at_ms = ?, recovery_token = NULL
    WHERE slug = ? AND attempt_token = ? AND session_id = ? AND state = 'spawned'
      AND pane_id IS NOT NULL AND pane_pid IS NOT NULL AND session_created IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const restoreAdoptionNoPaneStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL,
        finalized_at_ms = COALESCE(finalized_at_ms, reserved_at_ms)
    WHERE slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const deleteAbandonedAdoptionClaimStmt = db.prepare(`
    DELETE FROM adoption_claim
    WHERE slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
  `)
  const beginAdoptionRecoveryStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'recovering', recovery_token = ?, lease_expires_at_ms = ?
    WHERE slug = ? AND attempt_token = ? AND state != 'finalized' AND lease_expires_at_ms <= ?
  `)
  const restoreRecoveredAdoptionNoPaneStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL,
        finalized_at_ms = COALESCE(finalized_at_ms, reserved_at_ms)
    WHERE slug = ? AND attempt_token = ? AND state = 'recovering' AND recovery_token = ?
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const deleteRecoveredAdoptionClaimStmt = db.prepare(`
    DELETE FROM adoption_claim
    WHERE slug = ? AND attempt_token = ? AND state = 'recovering' AND recovery_token = ?
  `)
  const delFinalizedAdoptionClaim = db.prepare(`
    DELETE FROM adoption_claim WHERE slug = ? AND session_id = ? AND state = 'finalized'
  `)
  const retireFinalizedAdoptionClaimStmt = db.prepare(`
    DELETE FROM adoption_claim
    WHERE slug = ? AND session_id = ? AND attempt_token = ? AND state = 'finalized'
  `)
  const readStmt = db.prepare("UPDATE session SET last_read_at = ?, unread = 0 WHERE slug = ?")
  const unreadStmt = db.prepare("UPDATE session SET unread = ? WHERE slug = ?")
  const unreadIfCurrentStmt = db.prepare(`
    UPDATE session SET unread = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const exitedStmt = db.prepare("UPDATE session SET exited = ? WHERE slug = ?")
  const exitedIfCurrentStmt = db.prepare(`
    UPDATE session SET exited = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const completeIfCurrentStmt = db.prepare(`
    UPDATE session
    SET exited = 1, state = 'archived', archived = 1, unread = 0, snoozed_until = NULL
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const archivedStmt = db.prepare("UPDATE session SET archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END, snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END WHERE slug = ?")
  const restedStmt = db.prepare("UPDATE session SET rested_at = ? WHERE slug = ?")
  const restedIfCurrentStmt = db.prepare(`
    UPDATE session SET rested_at = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const seenStmt = db.prepare("UPDATE session SET seen_at = ? WHERE slug = ?")
  const transcriptIdStmt = db.prepare("UPDATE session SET transcript_id = ? WHERE slug = ?")
  const transcriptIdIfCurrentStmt = db.prepare(`
    UPDATE session SET transcript_id = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const stateStmt = db.prepare(
    "UPDATE session SET state = ?, archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END, snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END WHERE slug = ?",
  )
  const stateIfCurrentStmt = db.prepare(`
    UPDATE session SET state = ?, archived = ?,
      unread = CASE WHEN ? = 1 THEN 0 ELSE unread END,
      snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const snoozedUntilStmt = db.prepare("UPDATE session SET snoozed_until = ? WHERE slug = ?")
  const clearExpiredSnoozesStmt = db.prepare(`
    UPDATE session SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
  `)
  const titleStmt = db.prepare("UPDATE session SET title = ?, title_auto = 0 WHERE slug = ?")
  const titleCasStmt = db.prepare(
    "UPDATE session SET title = ?, title_auto = 0 WHERE slug = ? AND session_id = ? AND title IS ? AND title_auto = ?",
  )
  const autoTitleCasStmt = db.prepare(`
    UPDATE session SET title = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ?
      AND runtime_generation = ? AND title_auto = 1
  `)
  const delSession = db.prepare("DELETE FROM session WHERE slug = ?")
  const putTomb = db.prepare("INSERT OR IGNORE INTO tombstone (transcript_id, slug, forgotten_at) VALUES (?, ?, ?)")
  const allTombs = db.prepare<[], { transcript_id: string }>("SELECT transcript_id FROM tombstone")
  // Storage is constructed before the disabled app-server bridge, so this table may appear later in
  // the process. Resolve it lazily inside the same registry transaction. Detaching first makes a
  // matching native binding non-actionable even if the post-commit process cleanup is interrupted.
  const detachCodexBinding = (threadSlug: string, sessionId: string, at: string) => {
    const exists = db.prepare<[], { present: number }>(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'codex_app_server_session'
    `).get()
    if (!exists) return
    db.prepare(`
      UPDATE codex_app_server_session
      SET state = 'detached', current_turn_id = NULL, updated_at = ?
      WHERE thread_slug = ? AND fray_session_id = ?
    `).run(at, threadSlug, sessionId)
  }
  const forgetOwnedRow = (existing: SessionRow): SessionRow => {
    const at = new Date().toISOString()
    interactions.cancelForSession(existing.slug, existing.session_id, "session-deleted")
    detachCodexBinding(existing.slug, existing.session_id, at)
    putTomb.run(existing.session_id, existing.slug, at)
    if (existing.transcript_id) putTomb.run(existing.transcript_id, existing.slug, at)
    if (existing.agent_session_id) putTomb.run(existing.agent_session_id, existing.slug, at)
    const claim = selAdoptionClaim.get(existing.slug)
    if (claim?.state === "finalized" && claim.session_id === existing.session_id) {
      retireAdoptionAttempt(claim)
      delFinalizedAdoptionClaim.run(existing.slug, existing.session_id)
    }
    delSession.run(existing.slug)
    return existing
  }

  // One transaction: drop the row and graveyard its transcript id(s), so a rescan mid-delete can never see
  // a half-forgotten state (row gone but transcript un-tombstoned, or vice-versa).
  const forget = db.transaction((slug: string): SessionRow | undefined => {
    const existing = selOne.get(slug)
    return existing ? forgetOwnedRow(existing) : undefined
  })

  const forgetIfCurrent = db.transaction(
    (slug: string, expected: ForgetSessionExpectation): SessionRow | undefined => {
      const existing = selOne.get(slug)
      if (
        !existing ||
        existing.session_id !== expected.sessionId ||
        (existing.runtime_generation ?? 0) !== expected.runtimeGeneration
      ) return undefined
      const claim = selAdoptionClaim.get(slug)
      if (expected.adoptionAttemptToken === null) {
        if (claim) return undefined
      } else if (
        !claim || claim.state !== "finalized" || claim.session_id !== expected.sessionId ||
        claim.attempt_token !== expected.adoptionAttemptToken
      ) {
        return undefined
      }
      return forgetOwnedRow(existing)
    },
  )
  const backendStmt = db.prepare("UPDATE session SET backend = ? WHERE slug = ?")
  const agentSessionStmt = db.prepare("UPDATE session SET agent_session_id = ? WHERE slug = ?")
  const permissionModeStmt = db.prepare("UPDATE session SET permission_mode = ? WHERE slug = ?")
  const permissionPendingStmt = db.prepare("UPDATE session SET permission_pending = ? WHERE slug = ?")
  const beginRuntimeControlStmt = db.prepare(`
    UPDATE session
    SET runtime_control = ?, runtime_control_revision = runtime_control_revision + 1
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
      AND (? IN ('codex-input', 'follow-up') OR codex_input_queue IS NULL)
  `)
  const releaseRuntimeControlStmt = db.prepare(`
    UPDATE session SET runtime_control = NULL
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
      AND runtime_control = ? AND runtime_control_revision = ?
  `)
  const profileTargetIfCurrentStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_revision = profile_revision + 1, control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
      AND codex_input_queue IS NULL
  `)
  const armProfileChangeStmt = db.prepare(`
    UPDATE session
    SET profile_pending_model = ?, profile_pending_effort = ?,
        profile_revision = profile_revision + 1,
        profile_handoff = ?,
        runtime_control = 'profile', runtime_control_revision = runtime_control_revision + 1,
        control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
      AND codex_input_queue IS NULL
  `)
  const checkpointProfileChangeStmt = db.prepare(`
    UPDATE session SET profile_handoff = ?, control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const commitProfileChangeStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const restoreProfileChangeStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const blockProfileChangeStmt = db.prepare(`
    UPDATE session SET control_error = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const failProfileChangeStmt = db.prepare(`
    UPDATE session
    SET profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const observedProfileIfCurrentStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_revision = profile_revision + 1
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
      AND runtime_control IS NULL AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
      AND (model IS NOT ? OR effort IS NOT ?)
  `)
  const beginRuntimeGenerationStmt = db.prepare(`
    UPDATE session
    SET runtime_generation = runtime_generation + 1, spawned_at = ?, exited = 0
    WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND permission_pending IS ?
      AND runtime_control IS ?
  `)
  const permissionStateIfCurrentStmt = db.prepare(`
    UPDATE session
    SET exited = ?, permission_mode = ?, permission_pending = ?, control_error = ?,
        runtime_control = CASE
          WHEN ? IS NULL AND runtime_control = 'permission' THEN NULL
          ELSE runtime_control
        END
    WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND permission_pending IS ?
      AND runtime_control IS ?
  `)
  const observedPermissionIfCurrentStmt = db.prepare(
    "UPDATE session SET permission_mode = ? WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND permission_mode IS NOT ?",
  )
  const controlErrorIfCurrentStmt = db.prepare(
    "UPDATE session SET control_error = ? WHERE slug = ? AND session_id = ? AND runtime_generation = ?",
  )
  const codexInputQueueStmt = db.prepare("UPDATE session SET codex_input_queue = ? WHERE slug = ?")
  const codexInputQueueIfCurrentStmt = db.prepare(`
    UPDATE session SET codex_input_queue = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND codex_input_queue IS ?
  `)
  const controlErrorStmt = db.prepare("UPDATE session SET control_error = ? WHERE slug = ?")
  const getSet = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
  const putSet = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
  const delSet = db.prepare("DELETE FROM settings WHERE key = ?")

  const normalizeSessionRow = (row: SessionRow) => ({
    ...row,
    backend: row.backend ?? "claude",
    agent_session_id: row.agent_session_id ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    profile_pending_model: row.profile_pending_model ?? null,
    profile_pending_effort: row.profile_pending_effort ?? null,
    profile_revision: row.profile_revision ?? 0,
    profile_handoff: row.profile_handoff ?? null,
    permission_mode: row.permission_mode ?? null,
    permission_pending: row.permission_pending ?? null,
    snoozed_until: row.snoozed_until ?? null,
    codex_input_queue: row.codex_input_queue ?? null,
    control_error: row.control_error ?? null,
    runtime_generation: row.runtime_generation ?? 0,
    runtime_control: row.runtime_control ?? null,
    runtime_control_revision: row.runtime_control_revision ?? 0,
  })

  const getAdoptionRuntimeSnapshot = db.transaction((slug: string) => ({
    // Claim first is intentional: a finalized claim disappearing before the current-row validation
    // must never make a stale adopted row look like an unbound legacy runtime.
    claim: selAdoptionClaim.get(slug),
    session: selOne.get(slug),
  }))

  const validateSessionIdentity = (row: SessionRow) => {
    const slug = ThreadSlug.parse(row.slug)
    if (row.tmux_name !== tmuxSessionName(slug)) throw new Error("invalid session thread identity")
  }

  const validateAdoptionReservation = (reservation: AdoptionReservation) => {
    ThreadSlug.parse(reservation.slug)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservation.attemptToken)) {
      throw new Error("invalid adoption attempt token")
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(reservation.sessionId)) {
      throw new Error("invalid adoption session id")
    }
    if (
      !Number.isSafeInteger(reservation.reservedAtMs) ||
      !Number.isSafeInteger(reservation.leaseExpiresAtMs) ||
      reservation.leaseExpiresAtMs <= reservation.reservedAtMs
    ) {
      throw new Error("invalid adoption lease")
    }
  }

  const validateAdoptionPane = (identity: AdoptionPaneIdentity) => {
    if (
      !/^%\d+$/.test(identity.paneId) ||
      !Number.isSafeInteger(identity.panePid) ||
      identity.panePid <= 0 ||
      !Number.isSafeInteger(identity.sessionCreated) ||
      identity.sessionCreated <= 0
    ) {
      throw new Error("invalid adoption pane identity")
    }
  }

  const retireAdoptionAttempt = (claim: AdoptionClaimRow, retiredAtMs = Date.now()): void => {
    putRetiredAdoptionAttempt.run(claim.attempt_token, claim.slug, claim.session_id, retiredAtMs)
  }

  const withAdoptionSpawnFence = <T>(
    slug: string,
    attemptToken: string,
    leaseExpiresAtMs: number,
    spawn: (bindPane: (identity: AdoptionPaneIdentity, leaseExpiresAtMs: number) => boolean) => T,
  ): AdoptionSpawnFenceResult<T> => {
    ThreadSlug.parse(slug)
    if (!Number.isSafeInteger(leaseExpiresAtMs)) return { acquired: false }
    db.exec("BEGIN IMMEDIATE")
    let bound = false
    try {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        (claim.state !== "reserved" && claim.state !== "spawned") ||
        claim.recovery_token !== null ||
        selRetiredAdoptionAttempt.get(attemptToken)
      ) {
        db.exec("ROLLBACK")
        return { acquired: false }
      }
      if (renewAdoptionSpawnFenceStmt.run(leaseExpiresAtMs, slug, attemptToken).changes !== 1) {
        db.exec("ROLLBACK")
        return { acquired: false }
      }
      // Hold BEGIN IMMEDIATE only through new-session. onCreated calls bindPane, which commits the
      // exact tuple and releases the recovery fence BEFORE remain-on-exit/status setup continues.
      // Thus a pre-bind SIGKILL rolls back to the durable token-only reservation, while every later
      // setup crash retains the exact tuple instead of rolling it back with the spawn fence.
      const bindPane = (identity: AdoptionPaneIdentity, nextLeaseExpiresAtMs: number): boolean => {
        if (bound || !db.inTransaction) return false
        validateAdoptionPane(identity)
        if (!Number.isSafeInteger(nextLeaseExpiresAtMs)) return false
        const changed = recordAdoptionPaneStmt.run({
          slug,
          attempt_token: attemptToken,
          pane_id: identity.paneId,
          pane_pid: identity.panePid,
          session_created: identity.sessionCreated,
          lease_expires_at_ms: nextLeaseExpiresAtMs,
        }).changes === 1
        if (!changed) return false
        db.exec("COMMIT")
        bound = true
        return true
      }
      const value = spawn(bindPane)
      if (!bound) {
        if (db.inTransaction) db.exec("ROLLBACK")
        throw new Error("adoption spawn returned without binding its exact pane")
      }
      return { acquired: true, value }
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK")
      throw error
    }
  }


  const finalizeAdoptionClaimTxn = db.transaction(
    (slug: string, attemptToken: string, row: SessionRow, finalizedAtMs: number): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        claim.session_id !== row.session_id ||
        claim.state !== "spawned" ||
        !claim.pane_id ||
        claim.pane_pid === null ||
        claim.session_created === null
      ) {
        return false
      }
      if (insertSessionIfAbsentStmt.run(normalizeSessionRow(row)).changes !== 1) return false
      if (finalizeAdoptionClaimStmt.run(finalizedAtMs, slug, attemptToken, row.session_id).changes !== 1) {
        throw new Error("adoption claim changed during finalization")
      }
      return true
    },
  )

  const rearmFinalizedAdoptionClaimTxn = db.transaction(
    (reservation: AdoptionReservation, previousAttemptToken: string): boolean => {
      const claim = selAdoptionClaim.get(reservation.slug)
      if (
        !claim ||
        claim.state !== "finalized" ||
        claim.session_id !== reservation.sessionId ||
        claim.attempt_token !== previousAttemptToken ||
        Boolean(selRetiredAdoptionAttempt.get(reservation.attemptToken))
      ) return false
      retireAdoptionAttempt(claim, reservation.reservedAtMs)
      return rearmFinalizedAdoptionClaimStmt.run({
        slug: reservation.slug,
        session_id: reservation.sessionId,
        attempt_token: reservation.attemptToken,
        previous_attempt_token: previousAttemptToken,
        reserved_at_ms: reservation.reservedAtMs,
        lease_expires_at_ms: reservation.leaseExpiresAtMs,
      }).changes === 1
    },
  )

  const abandonAdoptionClaimTxn = db.transaction((slug: string, attemptToken: string): boolean => {
    const claim = selAdoptionClaim.get(slug)
    if (!claim || claim.attempt_token !== attemptToken || (claim.state !== "reserved" && claim.state !== "spawned")) {
      return false
    }
    retireAdoptionAttempt(claim)
    if (restoreAdoptionNoPaneStmt.run(slug, attemptToken).changes === 1) return true
    return deleteAbandonedAdoptionClaimStmt.run(slug, attemptToken).changes === 1
  })

  const finishAdoptionRecoveryTxn = db.transaction(
    (slug: string, attemptToken: string, recoveryToken: string): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        claim.state !== "recovering" ||
        claim.recovery_token !== recoveryToken
      ) return false
      retireAdoptionAttempt(claim)
      if (restoreRecoveredAdoptionNoPaneStmt.run(slug, attemptToken, recoveryToken).changes === 1) return true
      return deleteRecoveredAdoptionClaimStmt.run(slug, attemptToken, recoveryToken).changes === 1
    },
  )

  const retireFinalizedAdoptionClaimTxn = db.transaction(
    (slug: string, sessionId: string, attemptToken: string): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim || claim.state !== "finalized" || claim.session_id !== sessionId ||
        claim.attempt_token !== attemptToken
      ) return false
      retireAdoptionAttempt(claim)
      return retireFinalizedAdoptionClaimStmt.run(slug, sessionId, attemptToken).changes === 1
    },
  )

  const beginAdoptionRecoveryTxn = db.transaction(
    (
      slug: string,
      attemptToken: string,
      recoveryToken: string,
      nowMs: number,
      leaseExpiresAtMs: number,
    ): AdoptionClaimRow | undefined => {
      const changed = beginAdoptionRecoveryStmt.run(
        recoveryToken,
        leaseExpiresAtMs,
        slug,
        attemptToken,
        nowMs,
      ).changes === 1
      return changed ? selAdoptionClaim.get(slug) : undefined
    },
  )

  const upsertSessionTxn = db.transaction((row: SessionRow): SessionLifecycleEvent | undefined => {
    const existing = selOne.get(row.slug)
    upsertStmt.run(normalizeSessionRow(row))
    if (existing && existing.session_id !== row.session_id) {
      interactions.cancelForSession(existing.slug, existing.session_id, "session-replaced")
      detachCodexBinding(existing.slug, existing.session_id, new Date().toISOString())
      const replacedClaim = selAdoptionClaim.get(existing.slug)
      if (replacedClaim?.state === "finalized" && replacedClaim.session_id === existing.session_id) {
        retireAdoptionAttempt(replacedClaim)
      }
      delFinalizedAdoptionClaim.run(existing.slug, existing.session_id)
      return { type: "replaced", previous: existing, current: selOne.get(row.slug)! }
    }
    return undefined
  })

  const upsertSession = (row: SessionRow) => {
    validateSessionIdentity(row)
    const event = upsertSessionTxn(row)
    if (event) emitSessionLifecycle(event)
  }

  const forgetSession = (slug: string) => {
    const previous = forget(slug)
    if (previous) emitSessionLifecycle({ type: "deleted", previous })
    return previous
  }

  return {
    db,
    interactions,
    // Databases created before the canonical guard may contain an overlong or otherwise unsafe id.
    // Keep those legacy/corrupt rows inert so boot reconciliation and pollers never feed them to
    // tmux, filesystem, transcript, or event boundaries.
    getSession: (slug) => ThreadSlug.safeParse(slug).success ? selOne.get(slug) : undefined,
    allSessions: () => selAll.all().filter((row) => ThreadSlug.safeParse(row.slug).success),
    subscribeSessionLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    // Profile fields are optional in SessionRow so pre-migration fixtures/callers still typecheck;
    // normalize them for better-sqlite3, whose named statement requires every referenced parameter.
    upsertSession: (row) => void upsertSession(row),
    insertSessionIfAbsent: (row) => {
      validateSessionIdentity(row)
      return insertSessionIfAbsentStmt.run(normalizeSessionRow(row)).changes === 1
    },
    getAdoptionClaim: (slug) => ThreadSlug.safeParse(slug).success ? selAdoptionClaim.get(slug) : undefined,
    getAdoptionRuntimeSnapshot: (slug) => ThreadSlug.safeParse(slug).success
      ? getAdoptionRuntimeSnapshot.deferred(slug)
      : { session: undefined, claim: undefined },
    allAdoptionClaims: () => selAllAdoptionClaims.all().filter((claim) => ThreadSlug.safeParse(claim.slug).success),
    allRetiredAdoptionAttempts: () => selAllRetiredAdoptionAttempts.all()
      .filter((attempt) => ThreadSlug.safeParse(attempt.slug).success),
    reserveAdoptionClaim: (reservation) => {
      validateAdoptionReservation(reservation)
      return reserveAdoptionClaimStmt.run({
        slug: reservation.slug,
        attempt_token: reservation.attemptToken,
        session_id: reservation.sessionId,
        reserved_at_ms: reservation.reservedAtMs,
        lease_expires_at_ms: reservation.leaseExpiresAtMs,
      }).changes === 1
    },
    recordAdoptionPane: (slug, attemptToken, identity, leaseExpiresAtMs) => {
      ThreadSlug.parse(slug)
      validateAdoptionPane(identity)
      if (!Number.isSafeInteger(leaseExpiresAtMs)) throw new Error("invalid adoption lease")
      return recordAdoptionPaneStmt.run({
        slug,
        attempt_token: attemptToken,
        pane_id: identity.paneId,
        pane_pid: identity.panePid,
        session_created: identity.sessionCreated,
        lease_expires_at_ms: leaseExpiresAtMs,
      }).changes === 1
    },
    withAdoptionSpawnFence,
    finalizeAdoptionClaim: (slug, attemptToken, row, finalizedAtMs) => {
      ThreadSlug.parse(slug)
      validateSessionIdentity(row)
      if (row.slug !== slug || !Number.isSafeInteger(finalizedAtMs)) return false
      return finalizeAdoptionClaimTxn(slug, attemptToken, row, finalizedAtMs)
    },
    rearmFinalizedAdoptionClaim: (reservation, previousAttemptToken) => {
      validateAdoptionReservation(reservation)
      return rearmFinalizedAdoptionClaimTxn(reservation, previousAttemptToken)
    },
    finalizeAdoptionRespawnClaim: (slug, attemptToken, sessionId, finalizedAtMs) =>
      ThreadSlug.safeParse(slug).success &&
      Number.isSafeInteger(finalizedAtMs) &&
      finalizeAdoptionRespawnClaimStmt.run(finalizedAtMs, slug, attemptToken, sessionId).changes === 1,
    abandonAdoptionClaim: (slug, attemptToken) =>
      ThreadSlug.safeParse(slug).success && abandonAdoptionClaimTxn(slug, attemptToken),
    beginAdoptionRecovery: (slug, attemptToken, recoveryToken, nowMs, leaseExpiresAtMs) => {
      if (
        !ThreadSlug.safeParse(slug).success ||
        !/^[0-9a-f-]{36}$/i.test(recoveryToken) ||
        !Number.isSafeInteger(nowMs) ||
        !Number.isSafeInteger(leaseExpiresAtMs) ||
        leaseExpiresAtMs <= nowMs
      ) {
        return undefined
      }
      return beginAdoptionRecoveryTxn(slug, attemptToken, recoveryToken, nowMs, leaseExpiresAtMs)
    },
    finishAdoptionRecovery: (slug, attemptToken, recoveryToken) =>
      ThreadSlug.safeParse(slug).success &&
      finishAdoptionRecoveryTxn(slug, attemptToken, recoveryToken),
    retireFinalizedAdoptionClaim: (slug, sessionId, attemptToken) =>
      ThreadSlug.safeParse(slug).success &&
      retireFinalizedAdoptionClaimTxn(slug, sessionId, attemptToken),
    markRead: (slug, at = new Date().toISOString()) => void readStmt.run(at, slug),
    setUnread: (slug, unread) => void unreadStmt.run(unread ? 1 : 0, slug),
    setUnreadIfCurrent: (slug, sessionId, generation, unread) =>
      unreadIfCurrentStmt.run(unread ? 1 : 0, slug, sessionId, generation).changes === 1,
    setExited: (slug, exited) => void exitedStmt.run(exited ? 1 : 0, slug),
    setExitedIfCurrent: (slug, sessionId, generation, exited) =>
      exitedIfCurrentStmt.run(exited ? 1 : 0, slug, sessionId, generation).changes === 1,
    completeIfCurrent: (slug, sessionId, generation) =>
      completeIfCurrentStmt.run(slug, sessionId, generation).changes === 1,
    setArchived: (slug, archived) => void archivedStmt.run(archived ? 1 : 0, archived ? 1 : 0, archived ? 1 : 0, slug),
    setRestedAt: (slug, at) => void restedStmt.run(at, slug),
    setRestedAtIfCurrent: (slug, sessionId, generation, at) =>
      restedIfCurrentStmt.run(at, slug, sessionId, generation).changes === 1,
    setSeenAt: (slug, at) => void seenStmt.run(at, slug),
    setTranscriptId: (slug, transcriptId) => void transcriptIdStmt.run(transcriptId, slug),
    setTranscriptIdIfCurrent: (slug, sessionId, generation, transcriptId) =>
      transcriptIdIfCurrentStmt.run(transcriptId, slug, sessionId, generation).changes === 1,
    setState: (slug, state) => void stateStmt.run(state, state === "archived" ? 1 : 0, state === "archived" ? 1 : 0, state === "archived" ? 1 : 0, slug),
    setStateIfCurrent: (slug, sessionId, generation, state) =>
      stateIfCurrentStmt.run(
        state,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        slug,
        sessionId,
        generation,
      ).changes === 1,
    setSnoozedUntil: (slug, until) => void snoozedUntilStmt.run(until, slug),
    clearExpiredSnoozes: (now) => clearExpiredSnoozesStmt.run(now).changes,
    setTitle: (slug, title) => void titleStmt.run(title, slug),
    setTitleIfCurrent: (slug, title, expected) =>
      titleCasStmt.run(title, slug, expected.sessionId, expected.title, expected.titleAuto).changes === 1,
    setAutoTitleIfCurrent: (slug, title, expected) =>
      autoTitleCasStmt.run(
        title,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.runtimeGeneration,
      ).changes === 1,
    forgetSession,
    forgetSessionIfCurrent: (slug, expected) => {
      if (!ThreadSlug.safeParse(slug).success || !Number.isSafeInteger(expected.runtimeGeneration)) return undefined
      const previous = forgetIfCurrent(slug, expected)
      if (previous) emitSessionLifecycle({ type: "deleted", previous })
      return previous
    },
    forgottenIds: () => new Set(allTombs.all().map((r) => r.transcript_id)),
    setBackend: (slug, backend) => void backendStmt.run(backend, slug),
    setAgentSession: (slug, agentSessionId) => void agentSessionStmt.run(agentSessionId, slug),
    setPermissionMode: (slug, permissionMode) => void permissionModeStmt.run(permissionMode, slug),
    setPermissionPending: (slug, permissionMode) => void permissionPendingStmt.run(permissionMode, slug),
    beginRuntimeControl: (slug, expected, kind) => {
      const changed = beginRuntimeControlStmt.run(
        kind,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        kind,
      ).changes === 1
      if (!changed) return null
      const current = selOne.get(slug)
      return current?.runtime_control === kind ? current.runtime_control_revision ?? null : null
    },
    releaseRuntimeControl: (slug, expected) =>
      releaseRuntimeControlStmt.run(
        slug,
        expected.sessionId,
        expected.generation,
        expected.kind,
        expected.revision,
      ).changes === 1,
    setProfileTargetIfCurrent: (slug, expected, profile) =>
      profileTargetIfCurrentStmt.run(
        profile.model,
        profile.effort,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1,
    armProfileChange: (slug, expected, profile, handoff) => {
      const serialized = JSON.stringify(handoff)
      const changed = armProfileChangeStmt.run(
        profile.model,
        profile.effort,
        serialized,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1
      if (!changed) return null
      const current = selOne.get(slug)
      if (!current || current.runtime_control !== "profile") return null
      return {
        profileRevision: current.profile_revision ?? 0,
        controlRevision: current.runtime_control_revision ?? 0,
        profileHandoff: serialized,
      }
    },
    checkpointProfileChange: (slug, expected, handoff) => {
      const serialized = JSON.stringify(handoff)
      const changed = checkpointProfileChangeStmt.run(
        serialized,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1
      return changed ? serialized : null
    },
    commitProfileChange: (slug, expected) =>
      commitProfileChangeStmt.run(
        expected.model,
        expected.effort,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    restoreProfileChange: (slug, expected, previous, error) =>
      restoreProfileChangeStmt.run(
        previous.model,
        previous.effort,
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    blockProfileChange: (slug, expected, error) =>
      blockProfileChangeStmt.run(
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    failProfileChange: (slug, expected, error) =>
      failProfileChangeStmt.run(
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    setObservedProfileIfCurrent: (slug, expected, profile) =>
      observedProfileIfCurrentStmt.run(
        profile.model,
        profile.effort,
        slug,
        expected.sessionId,
        expected.generation,
        profile.model,
        profile.effort,
      ).changes === 1,
    beginRuntimeGeneration: (slug, expected, spawnedAt) => {
      const changed = beginRuntimeGenerationStmt.run(
        spawnedAt,
        slug,
        expected.sessionId,
        expected.generation,
        expected.permissionPending,
        expected.runtimeControl ?? null,
      ).changes === 1
      return changed ? expected.generation + 1 : null
    },
    setPermissionStateIfCurrent: (slug, expected, state) =>
      permissionStateIfCurrentStmt.run(
        state.exited ? 1 : 0,
        state.permissionMode,
        state.permissionPending,
        state.controlError,
        state.permissionPending,
        slug,
        expected.sessionId,
        expected.generation,
        expected.permissionPending,
        expected.runtimeControl ?? null,
      ).changes === 1,
    setObservedPermissionIfCurrent: (slug, sessionId, generation, permissionMode) =>
      observedPermissionIfCurrentStmt.run(permissionMode, slug, sessionId, generation, permissionMode).changes === 1,
    setControlErrorIfCurrent: (slug, sessionId, generation, error) =>
      controlErrorIfCurrentStmt.run(error, slug, sessionId, generation).changes === 1,
    setCodexInputQueue: (slug, queue) => void codexInputQueueStmt.run(queue, slug),
    setCodexInputQueueIfCurrent: (slug, expected, queue) =>
      codexInputQueueIfCurrentStmt.run(
        queue,
        slug,
        expected.sessionId,
        expected.generation,
        expected.queue,
      ).changes === 1,
    setControlError: (slug, error) => void controlErrorStmt.run(error, slug),
    getSetting: (key) => {
      const row = getSet.get(key)
      if (!row) return undefined
      try {
        return JSON.parse(row.value)
      } catch {
        return undefined
      }
    },
    setSetting: (key, value) => void putSet.run(key, JSON.stringify(value)),
    deleteSetting: (key) => void delSet.run(key),
    close: () => {
      if (closed) return
      closed = true
      lifecycleListeners.clear()
      interactions.dispose()
      db.close()
    },
  }
}
