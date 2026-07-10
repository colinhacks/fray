import type { BoardSnapshot, ThreadView, BoardMeta, BoardDelta } from "./index.ts"

// Keyed thread-level delta engine — the server side of the /events delta protocol. Type-only imports
// above (erased at compile time) so this file has NO runtime dependency on index.ts and can't form an
// import cycle with it, even though index.ts re-exports these symbols.
//
// The board's only heavy field is `threads: ThreadView[]`, keyed by `id`. So the right diff here is NOT
// generic JSON-patch — it is a trivial keyed compare of per-thread serialized JSON. The differ holds the
// last-BROADCAST state (per-thread JSON + a serialized copy of the board-level fields) and, on a fresh
// snapshot, emits only what changed. Because each upsert carries the WHOLE ThreadView (not a sub-field
// patch), a client applying deltas in order reproduces server state exactly — no drift to accumulate;
// the only failure a delta stream can suffer is a DROPPED delta, which the seq counter makes detectable.

function metaOf(b: BoardSnapshot): BoardMeta {
  return {
    projectDir: b.projectDir,
    projectName: b.projectName,
    projectLabel: b.projectLabel,
    frayActive: b.frayActive,
    errors: b.errors,
    warnings: b.warnings,
    // Normalize undefined→[] so metaS serialization is stable (an absent vs empty errorItems never
    // reads as a spurious meta change) and the structured repair list survives every delta.
    errorItems: b.errorItems ?? [],
    // Same normalization for plan artifacts — the Plans section must survive every delta.
    plans: b.plans ?? [],
  }
}

// The shape the differ hands back — the payload of a `board-delta` event minus the type/bootId envelope.
export type BoardDiff = { seq: number; upserts: ThreadView[]; removed: string[]; meta?: BoardMeta }

export class BoardDiffer {
  // id -> serialized ThreadView JSON, for the last snapshot we emitted a diff for.
  private threads = new Map<string, string>()
  // serialized BoardMeta of the last snapshot (empty = never emitted).
  private meta = ""
  private seq = 0

  // The seq the last emitted diff carried (= the seq a fresh connect keyframe must advertise, since the
  // keyframe reflects the same committed state). 0 before anything has been diffed.
  currentSeq(): number {
    return this.seq
  }

  // Compute the delta of `next` vs. the last-emitted state. Returns null when NOTHING changed — the
  // caller must then NOT publish (this is the dedupe that keeps a 1s tailer tick from streaming
  // identical frames). On a real change it COMMITS the new state, bumps seq, and returns the diff.
  diff(next: BoardSnapshot): BoardDiff | null {
    const upserts: ThreadView[] = []
    const nextThreads = new Map<string, string>()
    for (const t of next.threads) {
      const s = JSON.stringify(t)
      nextThreads.set(t.id, s)
      if (this.threads.get(t.id) !== s) upserts.push(t)
    }
    const removed: string[] = []
    for (const id of this.threads.keys()) if (!nextThreads.has(id)) removed.push(id)

    const meta = metaOf(next)
    const metaS = JSON.stringify(meta)
    const metaChanged = metaS !== this.meta

    if (upserts.length === 0 && removed.length === 0 && !metaChanged) return null

    // Commit: swap in the freshly-serialized thread map (implicitly drops removed ids) + new meta.
    this.threads = nextThreads
    this.meta = metaS
    this.seq += 1
    return metaChanged ? { seq: this.seq, upserts, removed, meta } : { seq: this.seq, upserts, removed }
  }
}

// Apply a delta to a board IN PLACE — the client side. Mutates `board.threads` (upsert / splice) and
// the board-level fields directly, which works identically on a plain BoardSnapshot (tests) and on a
// valtio proxy (the store): the in-place ops trigger valtio's fine-grained reactivity, which is the
// audit's S2 fix (no wholesale replace → no full-list re-render churn). Render ORDER is unaffected —
// the client re-sorts every render (sortThreads/listedThreads), so array position is immaterial.
export function applyBoardDelta(board: BoardSnapshot, delta: Pick<BoardDelta, "upserts" | "removed" | "meta">): void {
  if (delta.upserts.length) {
    const pos = new Map<string, number>()
    board.threads.forEach((t, i) => pos.set(t.id, i))
    for (const t of delta.upserts) {
      const i = pos.get(t.id)
      if (i === undefined) board.threads.push(t)
      else board.threads[i] = t
    }
  }
  if (delta.removed.length) {
    const rm = new Set(delta.removed)
    for (let i = board.threads.length - 1; i >= 0; i--) if (rm.has(board.threads[i].id)) board.threads.splice(i, 1)
  }
  if (delta.meta) {
    board.projectDir = delta.meta.projectDir
    board.projectName = delta.meta.projectName
    board.projectLabel = delta.meta.projectLabel
    board.frayActive = delta.meta.frayActive
    board.errors = delta.meta.errors
    board.warnings = delta.meta.warnings
    board.errorItems = delta.meta.errorItems
    board.plans = delta.meta.plans
  }
}

// Client seq-gap decision (pure, so it is unit-tested without a DOM). Given the last-applied seq
// (-1 = no keyframe adopted yet) and an incoming delta's seq:
//   - IGNORE  a delta the keyframe already covers (a buffered duplicate: seq ≤ currentSeq).
//   - APPLY   the exact next delta (seq === currentSeq + 1).
//   - RESYNC  when there is no keyframe yet, or a delta was dropped (seq > currentSeq + 1) — incremental
//             state can no longer be trusted, so the client reconnects for a fresh keyframe.
export function deltaAction(currentSeq: number, deltaSeq: number): "apply" | "ignore" | "resync" {
  if (currentSeq < 0) return "resync"
  if (deltaSeq <= currentSeq) return "ignore"
  if (deltaSeq === currentSeq + 1) return "apply"
  return "resync"
}

// Pure boot-id reload decision (unit-tested). `known` = the boot id this page first recorded (null if
// none yet); `incoming` = the boot id on a fresh server frame/response.
//   - NOOP   when there's no incoming id (pre-restart server / unknown), or it matches what we know.
//   - RECORD the id on first sight (nothing to compare against yet).
//   - RELOAD once when it differs — the server restarted under a stale page. The caller records the new
//     id BEFORE reloading, so the reloaded page sees known===incoming → NOOP → no reload loop.
export function bootReloadDecision(known: string | null, incoming: string | null | undefined): "record" | "noop" | "reload" {
  if (!incoming) return "noop"
  if (known === null) return "record"
  if (known === incoming) return "noop"
  return "reload"
}
