import { bootReloadDecision } from "@fray-ui/shared"

// Server-restart detection. The server mints a random boot id per process; it rides every board /
// board-delta SSE frame AND the `x-fray-boot` header on every /rpc response. A new id is adopted in
// place: the transport reconnects and supplies a new keyframe, while React keeps mounted composers,
// focus, selection, and scroll intact. A boot boundary must never turn an ordinary board update into
// document navigation that throws away an unsent draft.
const KEY = "fray-boot-id"

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null // storage unavailable (rare) — degrade to "never reload", never worse than today
  }
}
function write(key: string, val: string): void {
  try {
    sessionStorage.setItem(key, val)
  } catch {
    // ignore — see read()
  }
}

// Feed every server-observed boot id through here (SSE frames + /rpc headers). Idempotent and cheap.
// The caller's transport-level reconnect/keyframe logic owns compatibility recovery; this function
// deliberately owns no navigation.
export function noteServerBootId(incoming: string | null | undefined): void {
  const known = read(KEY)
  switch (bootReloadDecision(known, incoming)) {
    case "noop":
      return
    case "record":
      write(KEY, incoming as string)
      return
    case "adopt":
      write(KEY, incoming as string)
      return
  }
}
