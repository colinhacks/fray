import { test } from "node:test"
import assert from "node:assert/strict"
import {
  defaultCustomSnoozeValue,
  DEFAULT_SNOOZE_PRESET,
  formatSnoozedUntil,
  formatSnoozeWake,
  isSnoozePreset,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetInstant,
  snoozePresetLabel,
} from "./snooze.ts"

test("snooze preset metadata has a stable one-day default and compact Tomorrow label", () => {
  assert.equal(DEFAULT_SNOOZE_PRESET, "1d")
  assert.equal(snoozePresetLabel(DEFAULT_SNOOZE_PRESET), "1 day")
  assert.equal(snoozePresetLabel("tomorrow"), "Tomorrow")
  assert.equal(isSnoozePreset("1w"), true)
  assert.equal(isSnoozePreset("custom"), false)
})

test("snooze presets distinguish exact duration from tomorrow's local wall clock", () => {
  const now = new Date(2026, 11, 31, 23, 30, 0, 0)
  assert.equal(Date.parse(snoozePresetInstant("1h", now.getTime())) - now.getTime(), 60 * 60 * 1000)
  assert.equal(Date.parse(snoozePresetInstant("1d", now.getTime())) - now.getTime(), 24 * 60 * 60 * 1000)
  const tomorrow = new Date(snoozePresetInstant("tomorrow", now.getTime()))
  assert.deepEqual(
    [tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()],
    [2027, 0, 1, 9, 0],
  )
})

test("calendar tomorrow stays at 9 AM while exact-day snooze crosses a DST boundary", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const beforeSpringForward = new Date(2026, 2, 7, 12, 0, 0, 0)
    const exactDay = new Date(snoozePresetInstant("1d", beforeSpringForward.getTime()))
    const tomorrow = new Date(snoozePresetInstant("tomorrow", beforeSpringForward.getTime()))
    assert.equal(exactDay.getTime() - beforeSpringForward.getTime(), 86_400_000)
    assert.equal(exactDay.getHours(), 13, "24 elapsed hours is 13:00 after the missing spring hour")
    assert.equal(tomorrow.getHours(), 9, "calendar preset preserves the promised local wall clock")
    assert.deepEqual(parseLocalSnooze("2026-03-08T02:30", beforeSpringForward.getTime()), {
      ok: false,
      message: "That local time does not exist",
    })
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("custom local snooze round-trips wall-clock input and rejects normalized/past values", () => {
  const now = new Date(2026, 6, 13, 12, 0, 0, 0)
  assert.equal(localDateTimeInputValue(now), "2026-07-13T12:00")
  assert.equal(defaultCustomSnoozeValue(now.getTime()), localDateTimeInputValue(new Date(now.getTime() + 86_400_000)))
  const parsed = parseLocalSnooze("2026-07-14T08:45", now.getTime())
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    const result = new Date(parsed.until)
    assert.deepEqual(
      [result.getFullYear(), result.getMonth(), result.getDate(), result.getHours(), result.getMinutes()],
      [2026, 6, 14, 8, 45],
    )
  }
  assert.deepEqual(parseLocalSnooze("2026-02-30T09:00", now.getTime()), { ok: false, message: "That local time does not exist" })
  assert.deepEqual(parseLocalSnooze("2026-07-13T11:59", now.getTime()), { ok: false, message: "Choose a time in the future" })
})

test("wake formatting uses the local calendar and locale-aware times", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const now = new Date(2026, 6, 13, 8, 0, 0, 0)
    const today = new Date(2026, 6, 13, 9, 0, 0, 0).toISOString()
    const tomorrow = new Date(2026, 6, 14, 9, 30, 0, 0).toISOString()
    const wednesday = new Date(2026, 6, 15, 21, 0, 0, 0).toISOString()
    const farDate = new Date(2026, 6, 21, 21, 0, 0, 0).toISOString()
    assert.equal(formatSnoozeWake(today, now.getTime()), "Today at 9:00 AM")
    assert.equal(formatSnoozeWake(tomorrow, now.getTime()), "Tomorrow at 9:30 AM")
    assert.equal(formatSnoozeWake(wednesday, now.getTime()), "Wednesday at 9:00 PM")
    assert.equal(formatSnoozeWake(farDate, now.getTime()), "Jul 21 at 9:00 PM")
    assert.equal(formatSnoozedUntil(wednesday, now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    assert.equal(formatSnoozedUntil("not-a-date", now.getTime()), null)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})
