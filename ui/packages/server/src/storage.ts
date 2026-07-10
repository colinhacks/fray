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
  // Lifecycle: 'open' | 'archived'. NULL = never explicitly set (pre-migration row) — the board derives
  // an effective state (archived flag ⇒ archived; paired legacy .fray file with terminal status ⇒
  // archived; else open) so historical sessions don't flood the working rail. Written ONLY by explicit
  // Archive/Reopen (the done FENCE mutates nothing — maintainer-settled).
  state: string | null
  meta: string | null // JSON blob for future annotations (unparsed here)
  seen_at: string | null // ISO8601 — interaction clearance: recorded when the human opens the thread
  plan_path: string | null // project-relative .fray/plans/*.md this thread was dispatched from
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
  // Explicit lifecycle write (Archive button / Reopen). Keeps the legacy `archived` flag in sync so
  // pre-restart readers of that column stay honest; archiving also clears unread (never badge a
  // deliberately-shelved thread).
  setState(slug: string, state: "open" | "archived"): void
  setTitle(slug: string, title: string): void
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
    INSERT INTO session (slug, session_id, tmux_name, spawned_at, last_read_at, unread, exited, title_auto, title, state, meta, seen_at, plan_path)
    VALUES (@slug, @session_id, @tmux_name, @spawned_at, @last_read_at, @unread, @exited, @title_auto, @title, @state, @meta, @seen_at, @plan_path)
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
      archived = 0,
      state = 'open'
  `)
  const readStmt = db.prepare("UPDATE session SET last_read_at = ?, unread = 0 WHERE slug = ?")
  const unreadStmt = db.prepare("UPDATE session SET unread = ? WHERE slug = ?")
  const exitedStmt = db.prepare("UPDATE session SET exited = ? WHERE slug = ?")
  const archivedStmt = db.prepare("UPDATE session SET archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END WHERE slug = ?")
  const restedStmt = db.prepare("UPDATE session SET rested_at = ? WHERE slug = ?")
  const seenStmt = db.prepare("UPDATE session SET seen_at = ? WHERE slug = ?")
  const stateStmt = db.prepare(
    "UPDATE session SET state = ?, archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END WHERE slug = ?",
  )
  const titleStmt = db.prepare("UPDATE session SET title = ? WHERE slug = ?")
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
    setState: (slug, state) => void stateStmt.run(state, state === "archived" ? 1 : 0, state === "archived" ? 1 : 0, slug),
    setTitle: (slug, title) => void titleStmt.run(title, slug),
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
