// Keep the visual live cue tied to the exact operation record, never to a thread-wide aggregate.
// The tailer currently projects background children as running or stale; accepting a string here
// makes terminal/future states safely non-live by default.
export function isRunningOperation(state: string | undefined): boolean {
  return state === "running"
}

export function runningOperations<T extends { state: string }>(operations: readonly T[]): readonly T[] {
  return operations.filter((operation) => isRunningOperation(operation.state))
}

export function hasRunningToolIndicator(status: "pending" | "completed" | "failed" | "cancelled" | undefined, backgroundState?: "background" | "unknown"): boolean {
  return status === "pending" && backgroundState !== "unknown"
}

type BackgroundTool = {
  name?: string
  backgroundState?: "background" | "unknown"
  detail?: string
  desc?: string
  command?: string
}

type LiveBackgroundOperation = {
  label: string
  state: "running" | "stale"
}

// Transcript results describe the launch wrapper, while the board independently tracks the detached
// shell. Match only the stable display labels that both paths derive from the same provider input: a
// model supplied description, or the command's first non-blank line. This lets a still-live watcher
// remain visibly live even if its launch wrapper has already returned "completed".
function operationLabel(value: string | undefined): string | undefined {
  const label = value?.split("\n").find((line) => line.trim())?.trim().replace(/\s+/g, " ")
  return label || undefined
}

export function liveBackgroundOperationState(tool: BackgroundTool, operations: readonly LiveBackgroundOperation[]): "running" | "stale" | undefined {
  // An interrupt receipt may carry the target session id, but it is a completed control action and
  // must never borrow the target's live background telemetry.
  if (tool.name === "Interrupt process") return undefined
  if (tool.backgroundState !== "background") return undefined
  const candidates = new Set([operationLabel(tool.desc), operationLabel(tool.detail), operationLabel(tool.command)].filter((value): value is string => Boolean(value)))
  if (candidates.size === 0) return undefined
  const matches = operations.filter((operation) => candidates.has(operationLabel(operation.label) ?? ""))
  if (matches.some((operation) => operation.state === "running")) return "running"
  return matches.some((operation) => operation.state === "stale") ? "stale" : undefined
}
