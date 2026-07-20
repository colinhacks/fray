import { proxy, subscribe } from "valtio"
import type { QueueDirection } from "../groups.ts"
import { DEFAULT_SNOOZE_PRESET, isSnoozePreset, type SnoozePreset } from "./snooze.ts"

// Client-only VIEW preferences — persisted in localStorage, never in the server Settings schema
// (that's operator dispatch config; this is how one browser likes to render). Seeded synchronously
// from localStorage so the first paint already reflects the saved choice, then mirrored back on
// every change. Components read via useSnapshot(prefs).
const KEY = "fray.prefs.v1"

// Coerce whatever's stored for `stickyUserMessage` to a boolean. Accepts the current boolean form and
// the short-lived earlier enum ("off" → false; "compact"/"full" → true); anything else → the fallback.
function coerceStickyUserMessage(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v
  if (v === "off") return false
  if (v === "compact" || v === "full") return true
  return fallback
}

export interface Prefs {
  // Collapse rendered diff blocks to just their header row (click a header to expand that one).
  compactDiffs: boolean
  // Queue-card split Snooze remembers the operator's last duration choice across every card/reload.
  // A custom date is deliberately one-off and never overwrites this reusable preset.
  snoozePreset: SnoozePreset
  // Whether the most-recent user message sticks to the top of a thread's scroll pane (ChatView + queue
  // card) as a collapsed, hover-to-expand bubble. On by default.
  stickyUserMessage: boolean
  // Direction the Needs-you queue + the sidebar's rested band order by. FIFO (default) surfaces the
  // longest-waiting item first so the human cycles through everything; LIFO surfaces the most recently
  // active first. See groups.ts orderQueue.
  queueOrder: QueueDirection
}

function coerceQueueOrder(v: unknown, fallback: QueueDirection): QueueDirection {
  return v === "fifo" || v === "lifo" ? v : fallback
}

export function parseStoredPrefs(raw: string | null): Prefs {
  // Compact diffs by DEFAULT — expanded diff bodies are the opt-in. Sticky user message ON by default.
  const fallback: Prefs = { compactDiffs: true, snoozePreset: DEFAULT_SNOOZE_PRESET, stickyUserMessage: true, queueOrder: "fifo" }
  try {
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
    return {
      ...fallback,
      ...stored,
      snoozePreset: isSnoozePreset(stored.snoozePreset) ? stored.snoozePreset : fallback.snoozePreset,
      stickyUserMessage: coerceStickyUserMessage(stored.stickyUserMessage, fallback.stickyUserMessage),
      queueOrder: coerceQueueOrder(stored.queueOrder, fallback.queueOrder),
    }
  } catch {
    return fallback
  }
}

function seed(): Prefs {
  try {
    return parseStoredPrefs(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY))
  } catch {
    return parseStoredPrefs(null)
  }
}

export const prefs = proxy<Prefs>(seed())

subscribe(prefs, () => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* private mode / quota — the in-memory proxy still drives this session */
  }
})
