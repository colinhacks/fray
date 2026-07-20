import type Database from "better-sqlite3"

export type WakeDeliveryState = "pending" | "leased" | "delivered" | "superseded" | "exhausted"

export interface WakeDeliveryInput {
  id: string
  slug: string
  sessionId: string
  fenceId: string
  hintKey: string
  message: string
  reason: string
}

export interface WakeDelivery extends WakeDeliveryInput {
  state: WakeDeliveryState
  attempts: number
  nextAttemptAt: number
  leaseOwner: string | null
  leaseUntil: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
  terminalAt: number | null
}

interface WakeDeliveryRow {
  id: string
  thread_slug: string
  session_id: string
  fence_id: string
  hint_key: string
  message: string
  reason: string
  state: WakeDeliveryState
  attempts: number
  next_attempt_at: number
  lease_owner: string | null
  lease_until: number | null
  last_error: string | null
  created_at: number
  updated_at: number
  delivered_at: number | null
  terminal_at: number | null
}

export interface WakeDeliveryStore {
  enqueue(input: WakeDeliveryInput, now: number): { effect: "created" | "existing"; delivery: WakeDelivery }
  get(id: string): WakeDelivery | undefined
  list(): WakeDelivery[]
  listOpen(): WakeDelivery[]
  claim(owner: string, now: number, leaseUntil: number, maxAttempts: number): WakeDelivery | undefined
  deferFailure(id: string, owner: string, now: number, retryAt: number, error: string): boolean
  recoverExpired(id: string, now: number, retryAt: number, maxAttempts: number, error: string): WakeDelivery | undefined
  acknowledge(id: string, owner: string, now: number): boolean
  confirm(id: string, now: number): boolean
  supersede(id: string, now: number, reason: string): boolean
}

const OUTBOX_CAP = 2_000

function delivery(row: WakeDeliveryRow): WakeDelivery {
  return {
    id: row.id,
    slug: row.thread_slug,
    sessionId: row.session_id,
    fenceId: row.fence_id,
    hintKey: row.hint_key,
    message: row.message,
    reason: row.reason,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    terminalAt: row.terminal_at,
  }
}

export function createWakeDeliveryStore(db: Database.Database): WakeDeliveryStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wake_delivery (
      id              TEXT PRIMARY KEY,
      thread_slug     TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      fence_id        TEXT NOT NULL,
      hint_key        TEXT NOT NULL,
      message         TEXT NOT NULL,
      reason          TEXT NOT NULL,
      state           TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'superseded', 'exhausted')),
      attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL,
      lease_owner     TEXT,
      lease_until     INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      delivered_at   INTEGER,
      terminal_at    INTEGER,
      UNIQUE(thread_slug, session_id, fence_id)
    );
    CREATE INDEX IF NOT EXISTS wake_delivery_due
      ON wake_delivery(state, next_attempt_at, created_at);
  `)

  const byId = db.prepare<[string], WakeDeliveryRow>("SELECT * FROM wake_delivery WHERE id = ?")
  const all = db.prepare<[], WakeDeliveryRow>("SELECT * FROM wake_delivery ORDER BY created_at, id")
  const open = db.prepare<[], WakeDeliveryRow>(
    "SELECT * FROM wake_delivery WHERE state IN ('pending', 'leased') ORDER BY created_at, id",
  )
  const insert = db.prepare(`
    INSERT INTO wake_delivery (
      id, thread_slug, session_id, fence_id, hint_key, message, reason, state, attempts,
      next_attempt_at, lease_owner, lease_until, last_error, created_at, updated_at,
      delivered_at, terminal_at
    ) VALUES (
      @id, @slug, @sessionId, @fenceId, @hintKey, @message, @reason, 'pending', 0,
      @now, NULL, NULL, NULL, @now, @now, NULL, NULL
    )
    ON CONFLICT DO NOTHING
  `)
  const terminalCount = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM wake_delivery WHERE state IN ('delivered', 'superseded', 'exhausted')",
  )
  const pruneTerminal = db.prepare(`
    DELETE FROM wake_delivery WHERE id IN (
      SELECT id FROM wake_delivery
      WHERE state IN ('delivered', 'superseded', 'exhausted')
      ORDER BY terminal_at, created_at, id
      LIMIT ?
    )
  `)
  const due = db.prepare<[number, number], WakeDeliveryRow>(`
    SELECT * FROM wake_delivery
    WHERE state = 'pending' AND next_attempt_at <= ? AND attempts < ?
    ORDER BY next_attempt_at, created_at, id
    LIMIT 1
  `)
  const claimStmt = db.prepare(`
    UPDATE wake_delivery SET
      state = 'leased', attempts = attempts + 1, lease_owner = @owner, lease_until = @leaseUntil,
      last_error = NULL, updated_at = @now
    WHERE id = @id AND state = 'pending' AND next_attempt_at <= @now AND attempts < @maxAttempts
  `)
  const deferFailureStmt = db.prepare(`
    UPDATE wake_delivery SET
      lease_until = @retryAt, last_error = @error, updated_at = @now
    WHERE id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const recoverExpiredStmt = db.prepare(`
    UPDATE wake_delivery SET
      state = CASE WHEN attempts >= @maxAttempts THEN 'exhausted' ELSE 'pending' END,
      next_attempt_at = @retryAt,
      lease_owner = NULL,
      lease_until = NULL,
      last_error = @error,
      updated_at = @now,
      terminal_at = CASE WHEN attempts >= @maxAttempts THEN @now ELSE NULL END
    WHERE id = @id AND state = 'leased' AND lease_until <= @now
  `)
  const acknowledgeStmt = db.prepare(`
    UPDATE wake_delivery SET
      state = 'delivered', lease_owner = NULL, lease_until = NULL, last_error = NULL,
      delivered_at = @now, terminal_at = @now, updated_at = @now
    WHERE id = @id AND state = 'leased' AND lease_owner = @owner
  `)
  const confirmStmt = db.prepare(`
    UPDATE wake_delivery SET
      state = 'delivered', lease_owner = NULL, lease_until = NULL, last_error = NULL,
      delivered_at = @now, terminal_at = @now, updated_at = @now
    WHERE id = @id AND state IN ('pending', 'leased')
  `)
  const supersedeStmt = db.prepare(`
    UPDATE wake_delivery SET
      state = 'superseded', lease_owner = NULL, lease_until = NULL, last_error = @reason,
      terminal_at = @now, updated_at = @now
    WHERE id = @id AND state IN ('pending', 'leased')
  `)

  const enqueueTxn = db.transaction((input: WakeDeliveryInput, now: number) => {
    const created = insert.run({ ...input, now }).changes === 1
    const row = byId.get(input.id)
    if (!row) throw new Error("wake delivery disappeared while it was being enqueued")
    if (
      row.thread_slug !== input.slug ||
      row.session_id !== input.sessionId ||
      row.fence_id !== input.fenceId ||
      row.hint_key !== input.hintKey ||
      row.message !== input.message ||
      row.reason !== input.reason
    ) {
      throw new Error(`wake delivery id collision for ${input.id}`)
    }
    const count = terminalCount.get()?.count ?? 0
    if (count > OUTBOX_CAP) pruneTerminal.run(count - OUTBOX_CAP)
    return { effect: created ? "created" as const : "existing" as const, delivery: delivery(row) }
  })

  const claimTxn = db.transaction((owner: string, now: number, leaseUntil: number, maxAttempts: number) => {
    const candidate = due.get(now, maxAttempts)
    if (!candidate) return undefined
    if (claimStmt.run({ id: candidate.id, owner, now, leaseUntil, maxAttempts }).changes !== 1) return undefined
    return delivery(byId.get(candidate.id)!)
  })

  return {
    enqueue: (input, now) => enqueueTxn.immediate(input, now),
    get: (id) => {
      const row = byId.get(id)
      return row ? delivery(row) : undefined
    },
    list: () => all.all().map(delivery),
    listOpen: () => open.all().map(delivery),
    claim: (owner, now, leaseUntil, maxAttempts) => claimTxn.immediate(owner, now, leaseUntil, maxAttempts),
    deferFailure: (id, owner, now, retryAt, error) => deferFailureStmt.run({
      id,
      owner,
      retryAt,
      error: error.slice(0, 500),
      now,
    }).changes === 1,
    recoverExpired: (id, now, retryAt, maxAttempts, error) => {
      if (recoverExpiredStmt.run({ id, now, retryAt, maxAttempts, error: error.slice(0, 500) }).changes !== 1) return undefined
      const row = byId.get(id)
      return row ? delivery(row) : undefined
    },
    acknowledge: (id, owner, now) => acknowledgeStmt.run({ id, owner, now }).changes === 1,
    confirm: (id, now) => confirmStmt.run({ id, now }).changes === 1,
    supersede: (id, now, reason) => supersedeStmt.run({ id, now, reason: reason.slice(0, 500) }).changes === 1,
  }
}
