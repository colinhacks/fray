export type PersistedThreadTab = "chat" | "scratch"

export interface ThreadTabCapabilities {
  scratch: boolean
}

export interface ScopedThreadTabCapabilities {
  scope: string
  capabilities: ThreadTabCapabilities
}

const PREFIX = "fray-thread-tab:"

export function parseThreadTab(value: string | null | undefined): PersistedThreadTab | null {
  return value === "chat" || value === "scratch" ? value : null
}

export function clampThreadTab(value: string | null | undefined, capabilities: ThreadTabCapabilities): PersistedThreadTab {
  const parsed = parseThreadTab(value)
  if (parsed === "scratch" && !capabilities.scratch) return "chat"
  return parsed ?? "chat"
}

// Board transport can briefly know the project/drawer scope before its thread row is available. A
// missing row in that gap is UNKNOWN, not an authoritative revocation: retain the last capabilities
// for this exact project+slug so an active xterm is not unmounted and the user's persisted Terminal
// intent is not overwritten with Chat. A concrete row always wins (foreign/legacy/lost-scratch clamps
// immediately), and a different project/slug can never inherit the prior scope's capabilities.
export function resolveThreadTabCapabilities(
  scope: string | undefined,
  current: ThreadTabCapabilities | undefined,
  previous: ScopedThreadTabCapabilities | undefined,
): { capabilities: ThreadTabCapabilities; remembered?: ScopedThreadTabCapabilities; authoritative: boolean } {
  if (!scope) return { capabilities: { scratch: false }, authoritative: false }
  if (current) return { capabilities: current, remembered: { scope, capabilities: current }, authoritative: true }
  if (previous?.scope === scope) return { capabilities: previous.capabilities, remembered: previous, authoritative: false }
  return { capabilities: { scratch: false }, authoritative: false }
}

// sessionStorage is origin-scoped, not project-scoped. Fray commonly reuses the same localhost port
// for another repository in the same tab, so the project identity must be part of the key; otherwise
// a matching slug can inherit Terminal/Doc intent from a different tmux universe.
export function threadTabStorageKey(projectDir: string, slug: string): string {
  return `${PREFIX}${encodeURIComponent(projectDir)}:${slug}`
}

// Storage is the user's requested surface, not the currently renderable surface. Capability changes
// are often temporary (boot keyframes, reconnects, ownership refreshes), so clamping while reading or
// writing would turn an incidental fallback into a permanent preference change.
export function readThreadTab(projectDir: string, slug: string): PersistedThreadTab {
  try {
    return parseThreadTab(sessionStorage.getItem(threadTabStorageKey(projectDir, slug))) ?? "chat"
  } catch {
    return "chat"
  }
}

export function writeThreadTab(projectDir: string, slug: string, tab: PersistedThreadTab): void {
  try {
    sessionStorage.setItem(threadTabStorageKey(projectDir, slug), tab)
  } catch {
    // Storage can be disabled; the current React state still works for this page lifetime.
  }
}
