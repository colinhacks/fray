import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"

function store(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "fray-storage-")), "ui.db"))
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t",
    session_id: "sid",
    tmux_name: "fray-t",
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: null,
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    ...over,
  }
}

test("forgetSession: DELETEs the row and returns it; the slug is gone", () => {
  const s = store()
  s.upsertSession(row({ slug: "phantom", session_id: "sid-1" }))
  assert.ok(s.getSession("phantom"), "row exists before forget")

  const forgotten = s.forgetSession("phantom")
  assert.equal(forgotten?.slug, "phantom")
  assert.equal(forgotten?.session_id, "sid-1")
  assert.equal(s.getSession("phantom"), undefined, "the row is hard-deleted")
  assert.equal(s.allSessions().length, 0)
})

test("forgetSession: tombstones session_id AND any discovered transcript_id", () => {
  const s = store()
  s.upsertSession(row({ slug: "drifted", session_id: "sid-2", transcript_id: "drifted-transcript" }))
  s.forgetSession("drifted")
  const tombs = s.forgottenIds()
  assert.ok(tombs.has("sid-2"), "the pinned session id is tombstoned")
  assert.ok(tombs.has("drifted-transcript"), "the discovered transcript id is tombstoned")
})

test("forgetSession: no transcript_id → only the session id is tombstoned", () => {
  const s = store()
  s.upsertSession(row({ slug: "plain", session_id: "sid-3" }))
  s.forgetSession("plain")
  assert.deepEqual([...s.forgottenIds()], ["sid-3"])
})

test("forgetSession: idempotent — forgetting an absent/already-forgotten slug is a no-op", () => {
  const s = store()
  assert.equal(s.forgetSession("never-existed"), undefined)
  s.upsertSession(row({ slug: "once", session_id: "sid-4" }))
  s.forgetSession("once")
  // A second forget finds no row and adds no new tombstone (the first one stays).
  assert.equal(s.forgetSession("once"), undefined)
  assert.deepEqual([...s.forgottenIds()], ["sid-4"])
})

test("forgetSession: a fresh re-dispatch of the same slug (NEW session_id) is unaffected by the tombstone", () => {
  const s = store()
  s.upsertSession(row({ slug: "reused", session_id: "old-sid" }))
  s.forgetSession("reused")
  // Re-dispatch reuses the freed slug with a brand-new session id — the row comes back, and the old
  // session id stays tombstoned (harmless: nothing points at it).
  s.upsertSession(row({ slug: "reused", session_id: "new-sid" }))
  assert.equal(s.getSession("reused")?.session_id, "new-sid")
  const tombs = s.forgottenIds()
  assert.ok(tombs.has("old-sid"))
  assert.ok(!tombs.has("new-sid"), "the live session's id is never tombstoned")
})
