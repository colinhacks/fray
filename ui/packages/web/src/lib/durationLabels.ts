// Compact labels are rendered in small caps in status rows. Spell units out enough that an
// uppercase M cannot be read as "million" (for example, `128 min`, not `128m`).
export function formatToolDuration(ms: number): string {
  if (ms < 1) return "<1 ms"
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${ms < 10_000 ? (ms / 1_000).toFixed(1) : Math.round(ms / 1_000)} sec`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1_000)
  return secs ? `${mins} min ${secs} sec` : `${mins} min`
}

export function formatElapsedMinutes(minutes: number): string {
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

export function formatFixedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "<1 min"
  return formatElapsedMinutes(mins)
}

export function formatCountdownSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} sec`
  return `${Math.floor(seconds / 3600)} hr ${Math.floor((seconds % 3600) / 60)} min`
}
