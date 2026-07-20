import { useCallback, useSyncExternalStore } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"

// Drafts are deliberately session-scoped: they survive React unmounts and a same-tab reload, but never
// escape this browser tab. Keep this schema tiny and text-only; server records, credentials and secret
// interaction fields must never enter this cache.
export const DRAFT_STORAGE_KEY = "fray-drafts:v1"
export const DRAFT_SCHEMA_VERSION = 1
const MAX_ENTRIES = 80
const MAX_VALUE_BYTES = 512 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const encoder = new TextEncoder()

export type DraftSnapshot = { version: 1; entries: Record<string, { value: string; touchedAt: number }> }
type Listener = () => void

function bytes(value: string): number { return encoder.encode(value).byteLength }
function empty(): DraftSnapshot { return { version: DRAFT_SCHEMA_VERSION, entries: {} } }
export function parseDraftSnapshot(raw: string | null): DraftSnapshot {
  if (!raw) return empty()
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== DRAFT_SCHEMA_VERSION) return empty()
    const entries = (value as { entries?: unknown }).entries
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return empty()
    const valid: DraftSnapshot["entries"] = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry?.value !== "string" || typeof entry?.touchedAt !== "number" || !Number.isFinite(entry.touchedAt)) continue
      if (key.length > 512 || bytes(entry.value) > MAX_VALUE_BYTES) continue
      valid[key] = { value: entry.value, touchedAt: entry.touchedAt }
    }
    return { version: DRAFT_SCHEMA_VERSION, entries: valid }
  } catch { return empty() }
}

function bounded(snapshot: DraftSnapshot): DraftSnapshot {
  const kept = Object.entries(snapshot.entries)
    .filter(([, entry]) => entry.value && bytes(entry.value) <= MAX_VALUE_BYTES)
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt)
  const entries: DraftSnapshot["entries"] = {}
  for (const [key, entry] of kept) {
    if (Object.keys(entries).length >= MAX_ENTRIES) break
    entries[key] = entry
    if (bytes(JSON.stringify({ version: DRAFT_SCHEMA_VERSION, entries })) > MAX_SNAPSHOT_BYTES) delete entries[key]
  }
  return { version: DRAFT_SCHEMA_VERSION, entries }
}

export class DraftStore {
  // `snapshot` is the current tab's complete controlled-input source of truth. Persistence is a
  // bounded projection of it: quota or a hard persisted-value cap must never blank a textarea that
  // the user is actively editing.
  private snapshot: DraftSnapshot
  private listeners = new Set<Listener>()
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined
  constructor(storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage) {
    this.storage = storage
    let raw: string | null = null
    try { raw = storage?.getItem(DRAFT_STORAGE_KEY) ?? null } catch {}
    this.snapshot = bounded(parseDraftSnapshot(raw))
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get(key: string): string { return this.snapshot.entries[key]?.value ?? "" }
  set(key: string, value: string): void {
    const entries = { ...this.snapshot.entries }
    if (!value) delete entries[key]
    else entries[key] = { value, touchedAt: Date.now() }
    this.commit({ version: DRAFT_SCHEMA_VERSION, entries })
  }
  clear(key: string): void { if (this.snapshot.entries[key]) this.commit({ version: DRAFT_SCHEMA_VERSION, entries: Object.fromEntries(Object.entries(this.snapshot.entries).filter(([candidate]) => candidate !== key)) }) }
  private commit(next: DraftSnapshot): void {
    this.snapshot = next
    // A too-large value remains in this tab's memory and subscribers see it immediately. `bounded`
    // excludes it from the reload snapshot, instead of replacing the controlled input with "".
    try { this.storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(bounded(next))) } catch {}
    for (const listener of this.listeners) listener()
  }
}

export const draftStore = new DraftStore()

export function projectDraftScope(projectDir: string | undefined): string {
  return encodeURIComponent(projectDir || "unresolved-project")
}
export const draftKey = {
  dispatch: (projectDir: string | undefined, planPath?: string) => `dispatch:${projectDraftScope(projectDir)}:${encodeURIComponent(planPath ?? "new")}`,
  followUp: (projectDir: string | undefined, slug: string, sessionId?: string) => `followup:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId ?? "unowned")}`,
  adopt: (projectDir: string | undefined, slug: string) => `adopt:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}`,
  answer: (projectDir: string | undefined, slug: string, sessionId: string | undefined, messageId: string, block: number) => `answer:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId ?? "unowned")}:${encodeURIComponent(messageId)}:${block}`,
  interaction: (projectDir: string | undefined, projectId: string, slug: string, sessionId: string, epoch: number, id: string, field: string) => `interaction:${projectDraftScope(projectDir)}:${encodeURIComponent(projectId)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId)}:${epoch}:${encodeURIComponent(id)}:${encodeURIComponent(field)}`,
  settings: (projectDir: string | undefined, field: string) => `settings:${projectDraftScope(projectDir)}:${field}`,
}

export function useProjectDir(): string | undefined { return useSnapshot(store).board?.projectDir }
export function useThreadSessionId(slug: string): string | undefined {
  return useSnapshot(store).board?.threads.find((thread) => thread.id === slug)?.sessionId
}
export function useDraft(key: string): readonly [string, (value: string) => void, () => void] {
  const snapshot = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot, draftStore.getSnapshot)
  const value = snapshot.entries[key]?.value ?? ""
  const set = useCallback((next: string) => draftStore.set(key, next), [key])
  const clear = useCallback(() => draftStore.clear(key), [key])
  return [value, set, clear] as const
}

// A form can expose several independently addressed text fields. One subscription keeps duplicate
// representations (queue card + drawer) coherent without serializing the form object itself.
export function useDraftValues(keys: readonly string[]): ReadonlyMap<string, string> {
  const snapshot = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot, draftStore.getSnapshot)
  return new Map(keys.map((key) => [key, snapshot.entries[key]?.value ?? ""]))
}
