import { bootReloadDecision } from "@fray-ui/shared"

// Server-restart detection. The server mints a random boot id per process; it rides every board /
// board-delta SSE frame AND the `x-fray-boot` header on every /rpc response. This page records the
// FIRST id it sees and, the moment it sees a DIFFERENT one, hard-reloads ONCE to pick up the freshest
// bundle — closing the stale-bundle / zombie-reconnect class (a page left open across a server restart
// otherwise reconnects transparently to a server whose protocol/bundle it no longer matches).
const KEY = "fray-boot-id"
const RELOADED_KEY = "fray-boot-reloaded"

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
export function noteServerBootId(incoming: string | null | undefined): void {
  const known = read(KEY)
  switch (bootReloadDecision(known, incoming)) {
    case "noop":
      return
    case "record":
      write(KEY, incoming as string)
      return
    case "reload": {
      const id = incoming as string
      // Loop guard: if we ALREADY reloaded for this exact id and STILL see a mismatch, adopt it and
      // stop — reloading again would spin. (Normally impossible: we record the new id below before
      // reloading, so the reloaded page sees known===id → noop.) NOTE: this dedupes re-reloading for
      // the SAME id, so it assumes ONE server process per origin (fray is a single local :4917) —
      // strictly alternating ids from a load-balanced pool (A,B,A,B…) could reload repeatedly, which
      // fray's single-process model never produces.
      if (read(RELOADED_KEY) === id) {
        write(KEY, id)
        return
      }
      write(RELOADED_KEY, id)
      write(KEY, id)
      try {
        location.reload()
      } catch {
        // no window (tests) — recording above is enough
      }
      return
    }
  }
}
