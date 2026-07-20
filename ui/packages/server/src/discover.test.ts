import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverTranscriptId, sentinelFor } from "./discover.ts"

function tmp() {
  return mkdtempSync(join(tmpdir(), "fray-discover-"))
}

// Write a transcript whose first user message embeds the scratchpad sentinel for `ownerId` (the ORIGINAL
// pinned id), simulating a worker whose file lives at a DIFFERENT filename `fileId`.
function transcript(dir: string, fileId: string, ownerId: string, mtimeSec?: number) {
  const first = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { role: "user", content: `Your scratchpad is \`.fray/threads/${ownerId}/scratch.md\` — keep state there.` },
  })
  const path = join(dir, `${fileId}.jsonl`)
  writeFileSync(path, first + "\n")
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
  return path
}

test("sentinelFor: the scratchpad path tail embeds the pinned id", () => {
  assert.equal(sentinelFor("abc-123"), "threads/abc-123/scratch.md")
})

test("discoverTranscriptId: finds a drifted transcript by its scratchpad sentinel", () => {
  const dir = tmp()
  transcript(dir, "forked-id", "pinned-id")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), "forked-id")
})

test("discoverTranscriptId: no sentinel match → undefined", () => {
  const dir = tmp()
  transcript(dir, "someone-else", "unrelated-owner")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), undefined)
})

test("discoverTranscriptId: never re-finds the pinned id's OWN file (excluded)", () => {
  const dir = tmp()
  // A file literally named <pinnedId>.jsonl that mentions its own sentinel must not self-match — we're
  // only here because that direct bind missed, so returning it would loop.
  transcript(dir, "pinned-id", "pinned-id")
  assert.equal(discoverTranscriptId(dir, "pinned-id"), undefined)
})

test("discoverTranscriptId: honors the exclude set (a transcript claimed by another row)", () => {
  const dir = tmp()
  transcript(dir, "claimed-by-b", "pinned-id")
  assert.equal(discoverTranscriptId(dir, "pinned-id", { exclude: new Set(["claimed-by-b"]) }), undefined)
})

test("discoverTranscriptId: newest match wins", () => {
  const dir = tmp()
  transcript(dir, "older", "pinned-id", 1_000_000) // ancient-ish but within the fresh window via nowMs
  transcript(dir, "newer", "pinned-id", 2_000_000)
  assert.equal(discoverTranscriptId(dir, "pinned-id", { nowMs: 2_000_000 * 1000 }), "newer")
})

test("discoverTranscriptId: a stale (aged-out) candidate is ignored", () => {
  const dir = tmp()
  transcript(dir, "ancient", "pinned-id", 1000) // mtime ~1970
  // now is far in the future → the only candidate is past the freshness window → no match
  assert.equal(discoverTranscriptId(dir, "pinned-id", { nowMs: Date.parse("2026-07-01T00:00:00Z") }), undefined)
})

test("discoverTranscriptId: a missing/unreadable dir degrades to undefined (never throws)", () => {
  assert.equal(discoverTranscriptId(join(tmpdir(), "fray-nope-does-not-exist-xyz"), "pinned-id"), undefined)
})

test("discoverTranscriptId: non-.jsonl and dotfiles are skipped", () => {
  const dir = tmp()
  writeFileSync(join(dir, "pinned-id.txt"), `.fray/threads/pinned-id/scratch.md`)
  writeFileSync(join(dir, ".hidden.jsonl"), `.fray/threads/pinned-id/scratch.md`)
  assert.equal(discoverTranscriptId(dir, "pinned-id"), undefined)
})
