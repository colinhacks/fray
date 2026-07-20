import assert from "node:assert/strict"
import test from "node:test"
import { DRAFT_STORAGE_KEY, DraftStore, draftKey, parseDraftSnapshot } from "./drafts.ts"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

test("draft snapshot rejects corrupt, old and oversized schema entries", () => {
  assert.deepEqual(parseDraftSnapshot("{"), { version: 1, entries: {} })
  assert.deepEqual(parseDraftSnapshot(JSON.stringify({ version: 0, entries: { a: { value: "x", touchedAt: 1 } } })), { version: 1, entries: {} })
  const huge = "x".repeat(513 * 1024)
  assert.deepEqual(parseDraftSnapshot(JSON.stringify({ version: 1, entries: { a: { value: huge, touchedAt: 1 } } })), { version: 1, entries: {} })
})

test("typing across the persistence boundary never blanks the live controlled draft", () => {
  const storage = new MemoryStorage()
  const drafts = new DraftStore(storage)
  const key = "long"
  const atLimit = "x".repeat(512 * 1024)
  const overLimit = `${atLimit}y`
  drafts.set(key, atLimit)
  assert.equal(drafts.get(key), atLimit)
  drafts.set(key, overLimit)
  assert.equal(drafts.get(key), overLimit, "the current tab retains the exact over-limit text")
  assert.equal(new DraftStore(storage).get(key), "", "the bounded reload snapshot omits only the unpersistable value")
})

test("drafts hydrate, clear, evict older values, and remain project/session isolated", () => {
  const storage = new MemoryStorage()
  const first = new DraftStore(storage)
  const a = draftKey.followUp("/one", "thread", "session-a")
  const b = draftKey.followUp("/one", "thread", "session-b")
  const otherProject = draftKey.followUp("/two", "thread", "session-a")
  first.set(a, "keep me")
  first.set(b, "other session")
  first.set(otherProject, "other project")
  assert.equal(new DraftStore(storage).get(a), "keep me")
  assert.equal(new DraftStore(storage).get(b), "other session")
  assert.equal(new DraftStore(storage).get(otherProject), "other project")
  first.clear(a)
  assert.equal(new DraftStore(storage).get(a), "")
  for (let i = 0; i < 100; i++) first.set(`k${i}`, String(i))
  const parsed = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!) as { entries: Record<string, unknown> }
  assert.ok(Object.keys(parsed.entries).length <= 80)
})

test("interaction keys include epoch so an old session cannot receive a new session draft", () => {
  const oldKey = draftKey.interaction("/project", "project", "thread", "session", 1, "ask", "text")
  const newKey = draftKey.interaction("/project", "project", "thread", "session", 2, "ask", "text")
  assert.notEqual(oldKey, newKey)
})

test("answer drafts use the transcript message identity and session, never a queue position", () => {
  const first = draftKey.answer("/project", "thread", "session-a", "message-a", 0)
  const sameQuestionInDrawer = draftKey.answer("/project", "thread", "session-a", "message-a", 0)
  const reorderedQuestion = draftKey.answer("/project", "thread", "session-a", "message-b", 0)
  const replacementSession = draftKey.answer("/project", "thread", "session-b", "message-a", 0)
  assert.equal(first, sameQuestionInDrawer)
  assert.notEqual(first, reorderedQuestion)
  assert.notEqual(first, replacementSession)
})
