import { proxy, subscribe } from "valtio"

// Client-only VIEW preferences — persisted in localStorage, never in the server Settings schema
// (that's operator dispatch config; this is how one browser likes to render). Seeded synchronously
// from localStorage so the first paint already reflects the saved choice, then mirrored back on
// every change. Components read via useSnapshot(prefs).
const KEY = "fray.prefs.v1"

interface Prefs {
  // Collapse rendered diff blocks to just their header row (click a header to expand that one).
  compactDiffs: boolean
}

function seed(): Prefs {
  // Compact diffs by DEFAULT — expanded diff bodies are the opt-in.
  const fallback: Prefs = { compactDiffs: true }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<Prefs> & { diffsRedefaulted?: boolean }
    // ONE-TIME migration (2026-07-09): the maintainer settled diffs as collapsed-by-default for
    // card-family consistency. A stored `compactDiffs: false` predating that decision was the OLD
    // default, not a choice — re-default it once. The marker makes a subsequent deliberate
    // Settings-toggle OFF stick forever.
    if (!stored.diffsRedefaulted) {
      stored.compactDiffs = true
      stored.diffsRedefaulted = true
    }
    return { ...fallback, ...stored }
  } catch {
    return fallback
  }
}

export const prefs = proxy<Prefs>(seed())

subscribe(prefs, () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* private mode / quota — the in-memory proxy still drives this session */
  }
})
