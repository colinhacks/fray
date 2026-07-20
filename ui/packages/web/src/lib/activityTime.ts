export function activityTimestamp(lastActivityAt: string | undefined, spawnedAt?: string): string | undefined {
  for (const at of [lastActivityAt, spawnedAt]) {
    if (at && Number.isFinite(Date.parse(at))) return at
  }
  return undefined
}

export function formatLastActive(at: string | undefined, nowMs = Date.now()): string | null {
  const activityMs = at ? Date.parse(at) : NaN
  if (!Number.isFinite(activityMs) || !Number.isFinite(nowMs)) return null

  const seconds = Math.max(0, Math.floor((nowMs - activityMs) / 1_000))
  if (seconds === 0) return "Last active just now"
  if (seconds < 60) return `Last active ${seconds} ${seconds === 1 ? "second" : "seconds"} ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Last active ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Last active ${hours} ${hours === 1 ? "hour" : "hours"} ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `Last active ${days} ${days === 1 ? "day" : "days"} ago`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `Last active ${weeks} ${weeks === 1 ? "week" : "weeks"} ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `Last active ${months} ${months === 1 ? "month" : "months"} ago`

  const years = Math.floor(days / 365)
  return `Last active ${years} ${years === 1 ? "year" : "years"} ago`
}
