export interface RestartFrayResult {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface FraySupervisorStatus {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
  artifactDigest?: string
  /** Only fray-dev's durable supervisor can safely build and promote a replacement artifact. */
  updateRestart?: boolean
}

/** Wakes the app-level status monitor immediately after a control action is accepted. */
export const FRAY_SUPERVISOR_STATUS_WAKE_EVENT = "fray:supervisor-status-wake"

/** Every supervisor that speaks the control protocol can restart its disposable application child. */
export function canRestart(status: FraySupervisorStatus | null): boolean {
  return status !== null
}

/** Legacy/static supervisors intentionally omit this capability, so their recovery endpoint is not surfaced as an update action. */
export function canUpdateRestart(status: FraySupervisorStatus | null): boolean {
  return status?.updateRestart === true
}

export async function getFraySupervisorStatus(fetcher: typeof fetch = fetch): Promise<FraySupervisorStatus | null> {
  try {
    const response = await fetcher("/_fray/control/status", { headers: { "cache-control": "no-store" } })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null
    const status = await response.json() as Partial<FraySupervisorStatus>
    return status.protocol === 1 && (status.state === "ready" || status.state === "restarting" || status.state === "failed") ? status as FraySupervisorStatus : null
  } catch {
    return null
  }
}

async function requestFrayRestartAction(path: "/_fray/control/restart" | "/_fray/control/update-restart", fetcher: typeof fetch): Promise<RestartFrayResult> {
  const response = await fetcher(path, {
    method: "POST",
    headers: { "cache-control": "no-store" },
  })
  let result: RestartFrayResult | undefined
  try {
    result = await response.json() as RestartFrayResult
  } catch {
    // Keep the failure leg actionable even if an old/non-supervised server returned HTML.
  }
  if (!response.headers.get("content-type")?.includes("application/json") || !result || result.protocol !== 1 || (result.state !== "ready" && result.state !== "restarting" && result.state !== "failed")) {
    throw new Error("Fray restart controls are unavailable for this server")
  }
  if (!response.ok) {
    throw new Error(result.message ?? `Restart request failed (${response.status})`)
  }
  if (result.state === "failed") throw new Error(result.message ?? "Fray did not become ready")
  return result
}

/** Restarts the currently promoted artifact through any protocol-compatible supervisor. */
export function requestFrayRestart(fetcher: typeof fetch = fetch): Promise<RestartFrayResult> {
  return requestFrayRestartAction("/_fray/control/restart", fetcher)
}

/** Reaches the durable fray-dev supervisor, never the disposable Fray application child directly. */
export function requestFrayUpdateRestart(fetcher: typeof fetch = fetch): Promise<RestartFrayResult> {
  return requestFrayRestartAction("/_fray/control/update-restart", fetcher)
}
