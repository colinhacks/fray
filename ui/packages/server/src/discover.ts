import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { join } from "node:path"

// ---- Read-side transcript DISCOVERY (the fallback for a drifted/missing `<session_id>.jsonl`) ----
//
// The tailer and the transcript renderer bind a thread to `<session_id>.jsonl` — the pinned id. That
// binding is reliable in the normal case (proven: neither compaction nor resume re-ids a session), but
// when the file is ABSENT (a worker that failed to write it) or, hypothetically, MOVED (a `--fork-session`
// re-id, which fray does not use today), the read side has no recovery and the row strands.
//
// Every fray worker's transcript CONTENT carries a built-in discovery key: its scratchpad path
// `scratch/<pinnedId>.md`, baked into the first user message (dispatch.ts composePrompt) AND re-injected
// in the per-turn system prompt (scratchpadOrientation), so it survives compaction and would survive a
// fork. The pinnedId there is the ORIGINAL session id regardless of any filename drift. So to find a
// session's real transcript we scan the project log dir for a *.jsonl whose HEAD contains that sentinel;
// newest match wins.
//
// TELEMETRY-GRADE: every fs op is guarded — a discovery miss / unreadable dir / malformed file degrades
// to `undefined` (no match), NEVER throws.

// Only the file HEAD is read: the scratchpad sentinel appears in the FIRST user message (the very top of
// the transcript) and again in the re-injected system prompt near each turn, so the opening chunk is
// sufficient and bounds the per-file cost — critical since a live transcript can be tens of MB.
const HEAD_BYTES = 128 * 1024
// Never consider a transcript older than this — discovery is for a LIVE thread whose file drifted, and
// scanning ancient logs only invites a false match. Generous vs. a real session's activity cadence.
const DISCOVER_FRESH_MS = 24 * 60 * 60_000
// Defensive cap on candidate files inspected per scan (newest-first), so a log dir holding thousands of
// historical sessions can't turn one discovery into thousands of head-reads.
const DISCOVER_MAX_SCAN = 40

// How long after dispatch we tolerate a MISSING/EMPTY `<session_id>.jsonl` before treating it as drift
// and engaging discovery. A healthy worker writes its transcript within ~1s of boot; a slow boot can
// lag. Aligns with the web spin-up window (groups.ts SPIN_UP_MS). Shared by BOTH read-side callers (the
// tailer's per-tick resolve AND the transcript renderer's per-view fallback) so neither pays a
// directory scan for an ordinary just-spawned thread whose file simply isn't written yet.
export const DISCOVERY_GRACE_MS = 60_000

// The content sentinel for a session: its scratchpad path tail. Embeds the ORIGINAL pinned id, so it is
// stable across filename drift. `/` and `.` are not JSON-escaped, so this matches the raw JSONL bytes.
export function sentinelFor(sessionId: string): string {
  return `scratch/${sessionId}.md`
}

// Read up to HEAD_BYTES from the top of a file as UTF-8. Any error → "" (caller treats as no-match).
function readHead(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.toString("utf8", 0, n)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

export interface DiscoverOptions {
  nowMs?: number // injectable clock (tests); defaults to Date.now()
  exclude?: Set<string> // ids to skip (other rows' session_id/transcript_id) so we never steal a claimed transcript
}

// Discover the transcript for `sessionId` by content: the newest *.jsonl in `logDir` (excluding
// `exclude`, and `sessionId` itself — its direct file is why we're here) whose HEAD carries the
// scratchpad sentinel. Returns the matching file's stem (its transcript id), or undefined if none.
// Pure fs + string work; degrades to undefined on any surprise.
export function discoverTranscriptId(logDir: string, sessionId: string, opts: DiscoverOptions = {}): string | undefined {
  const nowMs = opts.nowMs ?? Date.now()
  const exclude = opts.exclude
  const sentinel = sentinelFor(sessionId)
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return undefined
  }
  // Gather fresh candidates (id + mtime), newest-first, then head-scan at most DISCOVER_MAX_SCAN of them.
  const cands: { id: string; path: string; mtime: number }[] = []
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".jsonl")) continue
    const id = name.slice(0, -".jsonl".length)
    if (!id || id === sessionId || exclude?.has(id)) continue
    const path = join(logDir, name)
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (nowMs - mtime > DISCOVER_FRESH_MS) continue
    cands.push({ id, path, mtime })
  }
  cands.sort((a, b) => b.mtime - a.mtime)
  for (const c of cands.slice(0, DISCOVER_MAX_SCAN)) {
    if (readHead(c.path).includes(sentinel)) return c.id
  }
  return undefined
}
