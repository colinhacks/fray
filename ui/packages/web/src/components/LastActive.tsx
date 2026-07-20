import { useSyncExternalStore } from "react"
import { activityTimestamp, formatLastActive } from "../lib/activityTime.ts"

const TICK_MS = 30_000
const listeners = new Set<() => void>()
let nowMs = Date.now()
let timer: ReturnType<typeof setTimeout> | undefined

function tick(): void {
  nowMs = Date.now()
  for (const listener of listeners) listener()
  schedule()
}

function schedule(): void {
  if (listeners.size === 0) return
  const delay = TICK_MS - (nowMs % TICK_MS)
  timer = setTimeout(tick, delay || TICK_MS)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // A newly mounted label must not inherit the clock value from the last time this singleton was used.
    nowMs = Date.now()
    schedule()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

function getNow(): number {
  return nowMs
}

export function LastActive({ at, fallbackAt, className = "" }: { at: string | undefined; fallbackAt?: string; className?: string }) {
  const now = useSyncExternalStore(subscribe, getNow, getNow)
  const timestamp = activityTimestamp(at, fallbackAt)
  const label = formatLastActive(timestamp, now)
  if (!label || !timestamp) return null
  return (
    <time dateTime={timestamp} className={className}>
      {label}
    </time>
  )
}
