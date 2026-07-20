export type SnoozePreset = "1h" | "tomorrow" | "1d" | "3d" | "1w"
export const DEFAULT_SNOOZE_PRESET: SnoozePreset = "1d"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const SNOOZE_PRESETS: readonly { value: SnoozePreset; label: string; detail: string }[] = [
  { value: "1h", label: "1 hour", detail: "60 minutes" },
  { value: "tomorrow", label: "Tomorrow", detail: "9am" },
  { value: "1d", label: "1 day", detail: "24 hours" },
  { value: "3d", label: "3 days", detail: "72 hours" },
  { value: "1w", label: "1 week", detail: "7 days" },
]

const SNOOZE_PRESET_VALUES = new Set<SnoozePreset>(SNOOZE_PRESETS.map((preset) => preset.value))

export function isSnoozePreset(value: unknown): value is SnoozePreset {
  return typeof value === "string" && SNOOZE_PRESET_VALUES.has(value as SnoozePreset)
}

export function snoozePresetLabel(preset: SnoozePreset): string {
  return SNOOZE_PRESETS.find((candidate) => candidate.value === preset)?.label ?? "1 day"
}

export function snoozePresetInstant(preset: SnoozePreset, nowMs = Date.now()): string {
  if (preset === "tomorrow") {
    const now = new Date(nowMs)
    // Calendar arithmetic is intentional: tomorrow 09:00 remains 09:00 across a DST transition,
    // while 1d below means an exact 24-hour delay. The two useful semantics stay distinct.
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)
    return tomorrow.toISOString()
  }
  const delta = preset === "1h" ? HOUR : preset === "1d" ? DAY : preset === "3d" ? 3 * DAY : 7 * DAY
  return new Date(nowMs + delta).toISOString()
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

export function localDateTimeInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function defaultCustomSnoozeValue(nowMs = Date.now()): string {
  return localDateTimeInputValue(new Date(nowMs + DAY))
}

export type ParsedLocalSnooze = { ok: true; until: string } | { ok: false; message: string }

export function parseLocalSnooze(value: string, nowMs = Date.now()): ParsedLocalSnooze {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return { ok: false, message: "Choose a local date and time" }
  const [, y, mo, d, h, mi] = match
  const parts = [y, mo, d, h, mi].map(Number)
  const local = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], 0, 0)
  // Date normalizes impossible dates and daylight-saving gaps. Compare every local component so a
  // nonexistent 02:30 does not silently become 03:30 in time zones that spring forward.
  if (
    !Number.isFinite(local.getTime()) ||
    local.getFullYear() !== parts[0] ||
    local.getMonth() !== parts[1] - 1 ||
    local.getDate() !== parts[2] ||
    local.getHours() !== parts[3] ||
    local.getMinutes() !== parts[4]
  ) {
    return { ok: false, message: "That local time does not exist" }
  }
  if (local.getTime() <= nowMs) return { ok: false, message: "Choose a time in the future" }
  return { ok: true, until: local.toISOString() }
}

export function formatSnoozeWake(until: string, nowMs = Date.now()): string {
  const date = new Date(until)
  if (!Number.isFinite(date.getTime())) return ""
  const now = new Date(nowMs)
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const calendarDays = Math.round((startTarget - startToday) / DAY)
  // Leave both locale and time zone to the browser. A snooze is a local-calendar promise, so a
  // server-formatted UTC timestamp would be misleading as soon as the operator travels.
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
  if (calendarDays === 0) return `Today at ${time}`
  if (calendarDays === 1) return `Tomorrow at ${time}`
  if (calendarDays > 1 && calendarDays < 7) {
    return `${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date)} at ${time}`
  }
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric"
  return `${new Intl.DateTimeFormat(undefined, options).format(date)} at ${time}`
}

/** A complete, user-facing snooze sentence. Invalid scheduler input deliberately has no display value. */
export function formatSnoozedUntil(until: string, nowMs = Date.now()): string | null {
  if (!isValidAwaitingTimer(until)) return null
  const wake = formatSnoozeWake(until, nowMs)
  if (!wake) return null
  return `Snoozed until ${wake.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())}`
}
import { isValidAwaitingTimer } from "@fray-ui/shared"
