import { randomUUID } from "node:crypto"
import type { AdoptionClaimRow, SessionRow, Storage } from "./storage.ts"
import * as tmux from "./tmux.ts"
import { cleanupAdoptionSessionFiles } from "./session-files.ts"

export const ADOPTION_ATTEMPT_LEASE_MS = 120_000
export const ADOPTION_RECOVERY_LEASE_MS = 30_000
export const ADOPTION_RECONCILE_INTERVAL_MS = 5_000

export type AdoptionReconcileOutcome =
  | "active-reservation"
  | "live-finalized-owner"
  | "finalized-owner-unavailable"
  | "recovered-stale-attempt"
  | "recovery-in-progress"
  | "identity-conflict"

export interface AdoptionRecoveryRuntime {
  lookupAdoptionPane(slug: string): tmux.AdoptionPaneLookup
  findAdoptionPane(attemptToken: string): tmux.AdoptionPaneLookup
  findAdoptionPanes?(attemptTokens: readonly string[]): Map<string, tmux.AdoptionPaneLookup>
  findPaneIdentity(identity: tmux.PaneIdentity): tmux.AdoptionPaneLookup
  killExpectedAdoptionPane(expected: tmux.ExpectedAdoptionPane): boolean
}

const productionRuntime: AdoptionRecoveryRuntime = {
  lookupAdoptionPane: tmux.lookupAdoptionPane,
  findAdoptionPane: tmux.findAdoptionPane,
  findAdoptionPanes: tmux.findAdoptionPanes,
  findPaneIdentity: tmux.findPaneIdentity,
  killExpectedAdoptionPane: tmux.killExpectedAdoptionPane,
}

function claimIdentity(claim: AdoptionClaimRow): tmux.PaneIdentity | null {
  if (claim.pane_id === null || claim.pane_pid === null || claim.session_created === null) return null
  return { paneId: claim.pane_id, panePid: claim.pane_pid, sessionCreated: claim.session_created }
}

function sameIdentity(a: tmux.PaneIdentity, b: tmux.PaneIdentity): boolean {
  return a.paneId === b.paneId && a.panePid === b.panePid && a.sessionCreated === b.sessionCreated
}

function findExpectedRuntime(
  claim: AdoptionClaimRow,
  runtime: AdoptionRecoveryRuntime,
): tmux.AdoptionPaneLookup {
  const byToken = runtime.findAdoptionPane(claim.attempt_token)
  const expected = claimIdentity(claim)
  if (!expected) return byToken.kind === "absent" ? { kind: "absent" } : { kind: "unknown" }
  const byIdentity = runtime.findPaneIdentity(expected)
  if (
    byToken.kind === "found" &&
    byIdentity.kind === "found" &&
    sameIdentity(expected, byToken.pane) &&
    sameIdentity(expected, byIdentity.pane) &&
    byToken.pane.adoptionAttemptToken === claim.attempt_token &&
    byIdentity.pane.adoptionAttemptToken === claim.attempt_token
  ) {
    return { kind: "found", pane: byToken.pane }
  }
  if (byToken.kind === "absent" && byIdentity.kind === "absent") return { kind: "absent" }
  return { kind: "unknown" }
}

export type AdoptionRuntimeBinding =
  | { kind: "unbound" }
  | { kind: "bound"; claim: AdoptionClaimRow }
  | { kind: "conflict"; claim?: AdoptionClaimRow }

// Any non-finalized claim alongside a session row is precisely the CAS-loss window: the row and pane
// may belong to different contenders. Readers must fail closed until recovery removes the loser.
export function adoptionRuntimeBinding(
  storage: Pick<Storage, "getAdoptionClaim"> & Partial<Pick<Storage, "getSession" | "getAdoptionRuntimeSnapshot">>,
  row: Pick<SessionRow, "slug" | "session_id" | "runtime_generation">,
): AdoptionRuntimeBinding {
  const snapshot = storage.getAdoptionRuntimeSnapshot?.(row.slug) ?? {
    // Compatibility for focused test doubles; production always uses the transactional snapshot.
    claim: storage.getAdoptionClaim(row.slug),
    session: storage.getSession?.(row.slug),
  }
  const claim = snapshot.claim
  const current = snapshot.session
  if (
    current && (
      current.session_id !== row.session_id ||
      (current.runtime_generation ?? 0) !== (row.runtime_generation ?? 0)
    )
  ) return { kind: "conflict", ...(claim ? { claim } : {}) }
  if (!current && (storage.getSession || storage.getAdoptionRuntimeSnapshot)) {
    return { kind: "conflict", ...(claim ? { claim } : {}) }
  }
  if (!claim) return { kind: "unbound" }
  if (claim.state === "finalized" && claim.session_id === row.session_id) return { kind: "bound", claim }
  return { kind: "conflict", claim }
}

export interface ReconcileAdoptionOptions {
  storage: Storage
  projectDir: string
  now?: () => number
  runtime?: AdoptionRecoveryRuntime
  slug?: string
  // Periodic level-triggered enforcement needs tombstones and unfinished attempts, not a liveness
  // poll of every permanent finalized owner. Boot/retry keep the default full reconciliation.
  includeFinalized?: boolean
}

// Boot and retry share this exact state machine. It never targets a tmux name for teardown: a stale
// attempt is killed only after its unguessable token discovers one pane, and a persisted tuple must
// match that pane before cleanup. A same-name competitor is therefore observed, never attached/killed.
export function reconcileAdoptionClaims(options: ReconcileAdoptionOptions): Map<string, AdoptionReconcileOutcome> {
  const now = options.now ?? Date.now
  const runtime = options.runtime ?? productionRuntime
  const selectedClaims = options.slug
    ? [options.storage.getAdoptionClaim(options.slug)].filter((claim): claim is AdoptionClaimRow => Boolean(claim))
    : options.storage.allAdoptionClaims()
  const claims = options.includeFinalized === false
    ? selectedClaims.filter((claim) => claim.state !== "finalized")
    : selectedClaims
  const outcomes = new Map<string, AdoptionReconcileOutcome>()
  const blockedSlugs = new Set<string>()

  // Retirements are a durable backstop for a pre-upgrade/stale process that creates its token pane
  // after recovery gave up the claim. The normal spawn fence makes this impossible for current code,
  // but retaining and reconciling the token ledger makes the protocol safe across process versions.
  const retired = options.storage.allRetiredAdoptionAttempts()
    .filter((attempt) => !options.slug || attempt.slug === options.slug)
  const retiredLookups = runtime.findAdoptionPanes?.(retired.map((attempt) => attempt.attempt_token))
  for (const attempt of retired) {
    const found = retiredLookups?.get(attempt.attempt_token) ?? runtime.findAdoptionPane(attempt.attempt_token)
    if (found.kind === "absent") continue
    if (found.kind === "unknown") {
      blockedSlugs.add(attempt.slug)
      outcomes.set(attempt.slug, "recovery-in-progress")
      continue
    }
    runtime.killExpectedAdoptionPane({
      attempt_token: attempt.attempt_token,
      pane_id: found.pane.paneId,
      pane_pid: found.pane.panePid,
      session_created: found.pane.sessionCreated,
    })
    const afterToken = runtime.findAdoptionPane(attempt.attempt_token)
    const afterExact = runtime.findPaneIdentity(found.pane)
    if (afterToken.kind !== "absent" || afterExact.kind !== "absent") {
      blockedSlugs.add(attempt.slug)
      outcomes.set(
        attempt.slug,
        afterToken.kind === "unknown" || afterExact.kind === "unknown"
          ? "recovery-in-progress"
          : "identity-conflict",
      )
    }
  }

  for (const initial of claims) {
    if (blockedSlugs.has(initial.slug)) continue
    if (initial.state === "finalized") {
      const row = options.storage.getSession(initial.slug)
      const lookup = findExpectedRuntime(initial, runtime)
      if (
        row?.session_id === initial.session_id &&
        lookup.kind === "found" &&
        lookup.pane.adoptionAttemptToken === initial.attempt_token
      ) {
        if (lookup.pane.dead) {
          if (row.exited !== 1) options.storage.setExitedIfCurrent(
            row.slug, row.session_id, row.runtime_generation ?? 0, true,
          )
          outcomes.set(initial.slug, "finalized-owner-unavailable")
        } else {
          if (row.exited !== 0) options.storage.setExitedIfCurrent(
            row.slug, row.session_id, row.runtime_generation ?? 0, false,
          )
          outcomes.set(initial.slug, "live-finalized-owner")
        }
      } else {
        // Unknown is fail-closed too: until exact ownership can be re-proven no reader may treat a
        // reusable slug as this row's process. The durable binding remains for a later retry.
        if (row && row.exited !== 1) options.storage.setExitedIfCurrent(
          row.slug, row.session_id, row.runtime_generation ?? 0, true,
        )
        outcomes.set(initial.slug, "finalized-owner-unavailable")
      }
      continue
    }

    const nowMs = now()
    if (initial.lease_expires_at_ms > nowMs) {
      const competing = options.storage.getSession(initial.slug)
      if (competing && competing.session_id !== initial.session_id && competing.exited !== 1) {
        options.storage.setExitedIfCurrent(
          competing.slug, competing.session_id, competing.runtime_generation ?? 0, true,
        )
      }
      outcomes.set(initial.slug, "active-reservation")
      continue
    }

    const recoveryToken = randomUUID()
    const claimed = options.storage.beginAdoptionRecovery(
      initial.slug,
      initial.attempt_token,
      recoveryToken,
      nowMs,
      nowMs + ADOPTION_RECOVERY_LEASE_MS,
    )
    if (!claimed) {
      outcomes.set(initial.slug, "recovery-in-progress")
      continue
    }

    const foundByToken = runtime.findAdoptionPane(claimed.attempt_token)
    const expected = claimIdentity(claimed)
    const foundExact = expected ? runtime.findPaneIdentity(expected) : undefined
    if (foundByToken.kind === "unknown" || foundExact?.kind === "unknown") {
      outcomes.set(claimed.slug, "recovery-in-progress")
      continue
    }
    if (expected) {
      if (
        (foundByToken.kind === "found" && !sameIdentity(expected, foundByToken.pane)) ||
        (foundExact?.kind === "found" && (
          !sameIdentity(expected, foundExact.pane) ||
          foundExact.pane.adoptionAttemptToken !== claimed.attempt_token
        ))
      ) {
        outcomes.set(claimed.slug, "identity-conflict")
        continue
      }
      if (foundExact?.kind === "found") {
        runtime.killExpectedAdoptionPane(claimed)
      }
      const afterExact = runtime.findPaneIdentity(expected)
      const afterToken = runtime.findAdoptionPane(claimed.attempt_token)
      if (afterExact.kind !== "absent" || afterToken.kind !== "absent") {
        outcomes.set(
          claimed.slug,
          afterExact.kind === "unknown" || afterToken.kind === "unknown" ? "recovery-in-progress" : "identity-conflict",
        )
        continue
      }
    } else if (foundByToken.kind === "found") {
      runtime.killExpectedAdoptionPane({
        attempt_token: claimed.attempt_token,
        pane_id: foundByToken.pane.paneId,
        pane_pid: foundByToken.pane.panePid,
        session_created: foundByToken.pane.sessionCreated,
      })
      const afterToken = runtime.findAdoptionPane(claimed.attempt_token)
      const afterExact = runtime.findPaneIdentity(foundByToken.pane)
      if (afterToken.kind !== "absent" || afterExact.kind !== "absent") {
        outcomes.set(
          claimed.slug,
          afterToken.kind === "unknown" || afterExact.kind === "unknown"
            ? "recovery-in-progress"
            : "identity-conflict",
        )
        continue
      }
    }

    // Cleanup precedes the final claim deletion. A SIGKILL anywhere in file cleanup leaves the
    // recovering row as an idempotent retry marker; there is never a "claim gone, artifacts lost"
    // window. (The files are inert, but keeping even that boundary durable makes the protocol total.)
    const existingOwner = options.storage.getSession(claimed.slug)
    const restoringExistingBinding = existingOwner?.session_id === claimed.session_id
    if (!restoringExistingBinding && !cleanupAdoptionSessionFiles(options.projectDir, claimed.session_id)) {
      outcomes.set(claimed.slug, "recovery-in-progress")
      continue
    }
    if (!options.storage.finishAdoptionRecovery(claimed.slug, claimed.attempt_token, recoveryToken)) {
      outcomes.set(claimed.slug, "recovery-in-progress")
      continue
    }
    if (restoringExistingBinding && existingOwner.exited !== 1) options.storage.setExitedIfCurrent(
      existingOwner.slug,
      existingOwner.session_id,
      existingOwner.runtime_generation ?? 0,
      true,
    )
    outcomes.set(claimed.slug, "recovered-stale-attempt")
  }
  return outcomes
}

// Synchronous failure rollback for the still-live attempt owner. If exact kill cannot be confirmed,
// keep the claim + files so boot recovery can retry; never trade a possible orphan for a clean toast.
export function abandonAdoptionAttempt(options: {
  storage: Storage
  projectDir: string
  slug: string
  attemptToken: string
  sessionId: string
  identity?: tmux.PaneIdentity
  runtime?: AdoptionRecoveryRuntime
  cleanupFiles?: boolean
}): boolean {
  const runtime = options.runtime ?? productionRuntime
  let identity = options.identity
  if (!identity) {
    const discovered = runtime.findAdoptionPane(options.attemptToken)
    if (discovered.kind === "unknown") return false
    if (discovered.kind === "found") identity = discovered.pane
  }
  if (identity) {
    runtime.killExpectedAdoptionPane({
      attempt_token: options.attemptToken,
      pane_id: identity.paneId,
      pane_pid: identity.panePid,
      session_created: identity.sessionCreated,
    })
  }
  const remaining = runtime.findAdoptionPane(options.attemptToken)
  const remainingExact = identity ? runtime.findPaneIdentity(identity) : { kind: "absent" as const }
  if (remaining.kind !== "absent" || remainingExact.kind !== "absent") return false
  if (options.cleanupFiles !== false && !cleanupAdoptionSessionFiles(options.projectDir, options.sessionId)) return false
  return options.storage.abandonAdoptionClaim(options.slug, options.attemptToken)
}
