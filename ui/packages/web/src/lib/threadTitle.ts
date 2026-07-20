// The server's RenameThreadInput carries the same cap. Kept here too so a pasted title cannot make the
// inline editor appear to accept text the RPC will reject.
export const THREAD_TITLE_MAX_LENGTH = 200

// Resolve an inline-edit draft to a mutation payload. Empty/whitespace and unchanged commits are
// deliberate no-ops: blur/Enter cannot erase a good title, while Escape simply never calls this.
export function threadTitleToCommit(draft: string, current: string): string | undefined {
  const title = draft.trim()
  if (!title || title === current.trim()) return undefined
  return title
}

export function manualThreadTitleSeed(current: string, slug: string): string {
  const title = current.trim()
  return !title || title === slug || title === "Untitled thread" || title === "Spinning up a thread…" ? "" : title
}

export interface AiRenameAvailability {
  show: boolean
  enabled: boolean
  label: string
}

// Claude owns `/rename`; Codex does not. The client only pre-gates states it can know from the board—
// the server re-captures the terminal composer at click time and rejects a hidden draft/modal safely.
export function aiRenameAvailability(thread: {
  kind?: "session" | "legacy"
  foreign?: boolean
  backend?: "claude" | "codex"
  runtime: "none" | "spawning" | "running" | "perm-prompt" | "turn-idle" | "exited"
  pendingAsk?: unknown
  nativeInputRequired?: unknown
}): AiRenameAvailability {
  if (thread.kind !== "session" || thread.foreign || thread.backend === "codex") {
    return { show: false, enabled: false, label: "" }
  }
  if (thread.runtime === "turn-idle") return { show: true, enabled: true, label: "Rename with Claude" }
  if (thread.runtime === "perm-prompt" || thread.pendingAsk || thread.nativeInputRequired) {
    return { show: true, enabled: false, label: "Resolve Claude's terminal prompt before renaming" }
  }
  if (thread.runtime === "running" || thread.runtime === "spawning") {
    return { show: true, enabled: false, label: "Rename with Claude when the current turn finishes" }
  }
  return { show: true, enabled: false, label: "Resume this Claude thread to use AI rename" }
}
