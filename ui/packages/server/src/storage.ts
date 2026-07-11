import Database from "better-sqlite3"

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
}

export interface Storage {
  db: Database.Database
  getSession(slug: string): SessionRow | undefined
  allSessions(): SessionRow[]
  upsertSession(row: SessionRow): void
  markRead(slug: string, at?: string): void
  setUnread(slug: string, unread: boolean): void
  setExited(slug: string, exited: boolean): void
  setArchived(slug: string, archived: boolean): void
  setRestedAt(slug: string, at: string): void
  setSeenAt(slug: string, at: string): void
  // Cache/clear the discovered transcript filename stem (the read-side discovery fallback's result).
  setTranscriptId(slug: string, transcriptId: string | null): void
  // Explicit lifecycle write (Archive button / Reopen). Keeps the legacy `archived` flag in sync so
  // pre-restart readers of that column stay honest; archiving also clears unread (never badge a
  // deliberately-shelved thread).
  setState(slug: string, state: "open" | "archived"): void
  setTitle(slug: string, title: string): void
  // Hard-delete a session row — the "Dismiss/forget" verb for a phantom the user wants GONE, not merely
  // shelved (Archive only sets state='archived'). DELETEs the registry row AND records a TOMBSTONE on its
  // session_id + transcript_id, so foreign-discovery (which surfaces any fresh unregistered *.jsonl in the
  // log dir) can never resurrect the same transcript as a read-only "foreign" thread after the row is
  // gone. Idempotent: forgetting an absent/already-forgotten slug is a no-op. A fresh dispatch mints a NEW
  // session_id (never tombstoned), so re-dispatching the same slug still works — the tombstone keys on the
  // OLD session id only. Returns the forgotten row (for the caller to tear down its tailer state), or
  // undefined when nothing was there.
  forgetSession(slug: string): SessionRow | undefined
  // Every tombstoned transcript id (session_id + any discovered transcript_id of a forgotten row). The
  // tailer's foreign-discovery consults this so a forgotten phantom's transcript stays excluded forever.
  forgottenIds(): Set<string>
  // Codex-support epic (Phase 2): pin the agent backend + its native session id on a row AFTER
  // dispatch. Kept OFF the shared upsert (whose named-param statement every claude caller + test
  // fixture feeds) so the codex path is purely additive — a claude dispatch never calls these, so its
  // `backend` stays the column DEFAULT 'claude' and `agent_session_id` stays NULL.
  setBackend(slug: string, backend: string): void
  setAgentSession(slug: string, agentSessionId: string): void
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
  deleteSetting(key: string): void
  close(): void
}

export function createStorage(dbPath: string): Storage {
  const db = new Database(dbPath)
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
  `)
  // Best-effort inline migration for pre-archive DBs. The session-first columns (title/state/meta/
  // seen_at/plan_path) are all nullable ADDs — additive + idempotent, safe while another server
  // process holds the db open (the live server never sees a shape it can't read).
  for (const col of [
    "archived INTEGER NOT NULL DEFAULT 0",
    "title_auto INTEGER NOT NULL DEFAULT 0",
    "rested_at TEXT",
    "title TEXT",
    "state TEXT",
    "meta TEXT",
    "seen_at TEXT",
    "plan_path TEXT",
    "transcript_id TEXT",
    "backend TEXT NOT NULL DEFAULT 'claude'",
    "agent_session_id TEXT",
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

  const selOne = db.prepare<[string], SessionRow>("SELECT * FROM session WHERE slug = ?")
  const selAll = db.prepare<[], SessionRow>("SELECT * FROM session")
  const upsert = db.prepare(`
    INSERT INTO session (slug, session_id, tmux_name, spawned_at, last_read_at, unread, exited, title_auto, title, state, meta, seen_at, plan_path, transcript_id)
    VALUES (@slug, @session_id, @tmux_name, @spawned_at, @last_read_at, @unread, @exited, @title_auto, @title, @state, @meta, @seen_at, @plan_path, @transcript_id)
    ON CONFLICT(slug) DO UPDATE SET
      session_id = excluded.session_id,
      tmux_name  = excluded.tmux_name,
      spawned_at = excluded.spawned_at,
      last_read_at = excluded.last_read_at,
      unread = excluded.unread,
      exited = excluded.exited,
      title_auto = excluded.title_auto,
      title = excluded.title,
      plan_path = excluded.plan_path,
      -- A re-dispatch/adopt carries a FRESH session_id, so the old discovered path is stale → adopt the
      -- incoming value (NULL for a fresh spawn); a resume spreads the existing row, preserving its cache.
      transcript_id = excluded.transcript_id,
      archived = 0,
      state = 'open'
  `)
  const readStmt = db.prepare("UPDATE session SET last_read_at = ?, unread = 0 WHERE slug = ?")
  const unreadStmt = db.prepare("UPDATE session SET unread = ? WHERE slug = ?")
  const exitedStmt = db.prepare("UPDATE session SET exited = ? WHERE slug = ?")
  const archivedStmt = db.prepare("UPDATE session SET archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END WHERE slug = ?")
  const restedStmt = db.prepare("UPDATE session SET rested_at = ? WHERE slug = ?")
  const seenStmt = db.prepare("UPDATE session SET seen_at = ? WHERE slug = ?")
  const transcriptIdStmt = db.prepare("UPDATE session SET transcript_id = ? WHERE slug = ?")
  const stateStmt = db.prepare(
    "UPDATE session SET state = ?, archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END WHERE slug = ?",
  )
  const titleStmt = db.prepare("UPDATE session SET title = ? WHERE slug = ?")
  const delSession = db.prepare("DELETE FROM session WHERE slug = ?")
  const putTomb = db.prepare("INSERT OR IGNORE INTO tombstone (transcript_id, slug, forgotten_at) VALUES (?, ?, ?)")
  const allTombs = db.prepare<[], { transcript_id: string }>("SELECT transcript_id FROM tombstone")
  // One transaction: drop the row and graveyard its transcript id(s), so a rescan mid-delete can never see
  // a half-forgotten state (row gone but transcript un-tombstoned, or vice-versa).
  const forget = db.transaction((slug: string): SessionRow | undefined => {
    const existing = selOne.get(slug)
    if (!existing) return undefined
    const at = new Date().toISOString()
    putTomb.run(existing.session_id, slug, at)
    if (existing.transcript_id) putTomb.run(existing.transcript_id, slug, at)
    if (existing.agent_session_id) putTomb.run(existing.agent_session_id, slug, at)
    delSession.run(slug)
    return existing
  })
  const backendStmt = db.prepare("UPDATE session SET backend = ? WHERE slug = ?")
  const agentSessionStmt = db.prepare("UPDATE session SET agent_session_id = ? WHERE slug = ?")
  const getSet = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
  const putSet = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
  const delSet = db.prepare("DELETE FROM settings WHERE key = ?")

  return {
    db,
    getSession: (slug) => selOne.get(slug),
    allSessions: () => selAll.all(),
    upsertSession: (row) => void upsert.run(row),
    markRead: (slug, at = new Date().toISOString()) => void readStmt.run(at, slug),
    setUnread: (slug, unread) => void unreadStmt.run(unread ? 1 : 0, slug),
    setExited: (slug, exited) => void exitedStmt.run(exited ? 1 : 0, slug),
    setArchived: (slug, archived) => void archivedStmt.run(archived ? 1 : 0, archived ? 1 : 0, slug),
    setRestedAt: (slug, at) => void restedStmt.run(at, slug),
    setSeenAt: (slug, at) => void seenStmt.run(at, slug),
    setTranscriptId: (slug, transcriptId) => void transcriptIdStmt.run(transcriptId, slug),
    setState: (slug, state) => void stateStmt.run(state, state === "archived" ? 1 : 0, state === "archived" ? 1 : 0, slug),
    setTitle: (slug, title) => void titleStmt.run(title, slug),
    forgetSession: (slug) => forget(slug),
    forgottenIds: () => new Set(allTombs.all().map((r) => r.transcript_id)),
    setBackend: (slug, backend) => void backendStmt.run(backend, slug),
    setAgentSession: (slug, agentSessionId) => void agentSessionStmt.run(agentSessionId, slug),
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
    close: () => db.close(),
  }
}
