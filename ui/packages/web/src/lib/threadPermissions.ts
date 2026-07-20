// Foreign sessions have no Fray-owned terminal. Running registered sessions remain editable because
// the server persists first and uses the backend's in-band control rather than restarting the worker.
export interface ThreadPermissionState {
  foreign?: boolean
  runtime?: string
  pendingAsk?: unknown
  nativeInputRequired?: unknown
  subAgents?: readonly { state: string }[]
  bgShells?: readonly { state: string }[]
  queuedInputCount?: number
  codexInputAmbiguous?: boolean
  permissionPending?: unknown
  permissionChangePending?: boolean
  profileChangePending?: boolean
  runtimeControlPending?: boolean
  followUpQueueAvailable?: boolean
}

export function threadPermissionBlockedReason(thread: ThreadPermissionState): string | null {
  if (thread.foreign) return "Read-only external thread"
  if (thread.permissionChangePending || thread.permissionPending) return "A permission change is already in progress"
  if (thread.profileChangePending) return "A model and effort change is already in progress"
  if (thread.runtimeControlPending) return "Another runtime control is already in progress"
  if (thread.pendingAsk || thread.nativeInputRequired || thread.runtime === "perm-prompt") {
    return "Resolve the current terminal approval or question first"
  }
  const unresolvedOps = [...(thread.subAgents ?? []), ...(thread.bgShells ?? [])].filter((op) => op.state === "running" || op.state === "stale").length
  if (unresolvedOps > 0) return `Wait for ${unresolvedOps} unresolved background operation${unresolvedOps === 1 ? "" : "s"}`
  if ((thread.queuedInputCount ?? 0) > 0) return "Wait for the queued Codex input to finish"
  if (thread.runtime === "running" || thread.runtime === "spawning") return "Wait for the current turn to finish"
  return null
}

// Composer submission is intentionally less restrictive than runtime profile/permission changes.
// Codex owns an in-flight queue with `codex-input`, but its controller can atomically append a
// follow-up. Every other runtime owner remains a hard fence.
export function threadFollowUpBlocked(thread: ThreadPermissionState): boolean {
  return thread.permissionChangePending === true || thread.permissionPending !== undefined ||
    thread.profileChangePending === true ||
    (thread.runtimeControlPending === true && thread.followUpQueueAvailable !== true)
}

export function threadPermissionEffectMessage(effect: "applied" | "next-resume", backend: "claude" | "codex"): string {
  const noun = backend === "codex" ? "Sandbox" : "Permissions"
  return effect === "applied" ? `${noun} applied to the live session` : `${noun} saved for the next resume`
}

export function canRecoverExistingCodexDraft(error?: string): boolean {
  return typeof error === "string" && error.includes("submit or clear the existing Codex terminal draft")
}
