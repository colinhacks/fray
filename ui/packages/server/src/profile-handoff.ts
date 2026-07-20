import type {
  ProfileHandoffBinding,
  ProfileHandoffJournal,
  ProfileHandoffLeg,
  ProfileHandoffPhase,
} from "./storage.ts"

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PHASES = new Set<ProfileHandoffPhase>([
  "armed", "target-starting", "target-spawned", "target-ready",
  "rollback-starting", "rollback-spawned", "rollback-ready",
])

function pair(value: unknown): value is { model: string; effort: string; binding?: unknown } {
  if (!value || typeof value !== "object") return false
  const p = value as Record<string, unknown>
  return typeof p.model === "string" && p.model.length > 0 && typeof p.effort === "string" && p.effort.length > 0
}

export function isProfileHandoffBinding(value: unknown): value is ProfileHandoffBinding {
  if (!value || typeof value !== "object") return false
  const b = value as Record<string, unknown>
  return (b.kind === "standalone" || b.kind === "adopted") &&
    typeof b.paneId === "string" && /^%\d+$/.test(b.paneId) &&
    Number.isSafeInteger(b.panePid) && Number.isSafeInteger(b.sessionCreated) &&
    (b.adoptionAttemptToken === undefined || typeof b.adoptionAttemptToken === "string" && TOKEN.test(b.adoptionAttemptToken)) &&
    (b.handoffToken === undefined || typeof b.handoffToken === "string" && TOKEN.test(b.handoffToken))
}

function leg(value: unknown): value is ProfileHandoffLeg {
  if (!value || typeof value !== "object") return false
  const l = value as Record<string, unknown>
  return Number.isSafeInteger(l.generation) && typeof l.handoffToken === "string" && TOKEN.test(l.handoffToken) &&
    (l.binding === undefined || isProfileHandoffBinding(l.binding))
}

export function parseProfileHandoffJournal(raw: string | null | undefined): ProfileHandoffJournal | null {
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== "object") return null
  const j = value as Record<string, unknown>
  const previous = j.previous as Record<string, unknown> | undefined
  if (j.version !== 1 || typeof j.phase !== "string" || !PHASES.has(j.phase as ProfileHandoffPhase) ||
      typeof j.nativeSessionId !== "string" || !j.nativeSessionId || !pair(previous) ||
      !isProfileHandoffBinding(previous?.binding) || !pair(j.requested) ||
      (j.target !== undefined && !leg(j.target)) || (j.rollback !== undefined && !leg(j.rollback))) return null
  return value as ProfileHandoffJournal
}

export function serializeProfileHandoffJournal(journal: ProfileHandoffJournal): string {
  return JSON.stringify(journal)
}
