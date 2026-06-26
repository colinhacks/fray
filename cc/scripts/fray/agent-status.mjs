// @ts-check
/**
 * fray — DERIVED agent state. The single shared derivation used by BOTH the Stop-hook
 * liveness helper (`./agent-liveness.mjs`) and the board (`./index.mjs`), so an agent's
 * reported state can never drift between the two.
 *
 * THE PRINCIPLE — compute, don't store (the same rule the board already follows for
 * thread status). The thread↔agent binding (`.fray/.agent-bindings.jsonl`, written
 * AUTOMATICALLY by the agent-bind hook) records ONLY immutable-at-dispatch facts
 * (`agentId → thread`, plus a label); it carries NO per-agent `status`. (The old
 * hand-maintained `agents:` frontmatter is gone; a lingering one is an ignored no-op.)
 * Every liveness/doneness judgement is DERIVED here from ground truth:
 *
 *   - output-file (`tasks/<id>.output`) mtime → how long since the agent last wrote,
 *   - the THREAD's own `status:` (done/dismissed = terminal) → whether the orchestrator
 *     has deliberately reconciled the thread.
 *
 * There is NO durable per-agent COMPLETION signal: a rest (`.rested-agents.jsonl`) records
 * an `agent_id` but a rest is NOT "done" (an agent rests repeatedly). So "done" is INFERRED
 * (terminal-or-stale output + thread status), never read from a stored per-agent flag. That
 * is exactly why the old hand-maintained `status` field drifted and false-flagged a
 * completed agent as idle; deriving it makes that drift class structurally impossible.
 *
 * Derived states (one per dispatched agent — keyed on the thread's NEWEST agent only):
 *   - 'terminal'       — nothing to flag, for ANY of: the THREAD is terminal (done/dismissed);
 *                        the thread is PARKED (non-terminal but not `active`); or the thread is
 *                        DOWNSTREAM (a PR is landing via the merge cascade, so it is
 *                        legitimately active while it merges, not because an agent is stuck).
 *   - 'dropped'        — the conservative, high-confidence "no live agent" signal: an `active`
 *                        thread whose newest agent's output is stale beyond `droppedMin` AND
 *                        which has rested at least once (ended a turn) — so it is quiet at a
 *                        stopping point, not mid-tool-call. Likely finished-but-unreconciled or
 *                        genuinely dropped. THE one signal that matters.
 *   - 'idle'           — quiet, but NOT confidently dropped: output between `idleMin` and
 *                        `droppedMin`, OR stale-but-never-rested (still inside one long tool
 *                        call — a build/test — so alive). Informational only; say it softly.
 *   - 'fresh'          — output recent (<=idleMin): actively working, say nothing.
 *   - 'unknown'        — no readable output file (placeholder id, never-started): can't
 *                        judge; fail-open (say nothing).
 *
 * WHY a generous `droppedMin` (45m, vs the old 25m). Sub-agents now legitimately arm CI
 * watchers and go quiet for long stretches while CI runs (30–40m), so "no output for 25m" is
 * NORMAL, not stuck — the old threshold cried wolf. 45m gives a watcher room to fire and
 * resume the agent (which refreshes its output) before we ever call it dropped; the bar is
 * deliberately "better to miss a soft case than nag a benign one."
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_IDLE_MIN = 10;
export const DEFAULT_DROPPED_MIN = 45;
// Back-compat alias for the old name; repointed to the new, generous default.
export const DEFAULT_FROZEN_MIN = DEFAULT_DROPPED_MIN;

// Env-resolved thresholds, defined ONCE here so EVERY consumer (the Stop-hook liveness helper
// AND the board) reads the same knobs and can never disagree. FRAY_FROZEN_MIN is honored as the
// old alias for FRAY_DROPPED_MIN.
export const IDLE_MIN = parseInt(process.env.FRAY_IDLE_MIN || '', 10) || DEFAULT_IDLE_MIN;
export const DROPPED_MIN = parseInt(process.env.FRAY_DROPPED_MIN || process.env.FRAY_FROZEN_MIN || '', 10) || DEFAULT_DROPPED_MIN;

/**
 * GROUND-TRUTH age of an agent's last activity, in minutes — globbed across ALL local
 * Claude task dirs (`<tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output`). Unlike
 * the Stop hook's `deriveTasksDir` (which has the transcript_path and so knows the exact
 * session), the BOARD runs standalone with no session id, so it must search every session
 * for the agent's output symlink. `statSync` follows the symlink → the TARGET transcript's
 * real last-write (the symlink's own mtime is stale). Returns the freshest match's age, or
 * null when no output file exists (placeholder id / never-started / different machine).
 * Fail-open: any error → null.
 * @param {string} agentId
 * @param {number} [now]
 * @returns {number|null} minutes since last activity, or null
 */
export function findAgentOutputAge(agentId, now = Date.now()) {
  if (!agentId) return null;
  let best = null; // most-recent mtimeMs found
  try {
    for (const base of ['/tmp', '/private/tmp']) {
      let claudeDirs;
      try {
        claudeDirs = readdirSync(base).filter((d) => d.startsWith('claude-'));
      } catch {
        continue;
      }
      for (const cd of claudeDirs) {
        const root = join(base, cd);
        let projects;
        try {
          projects = readdirSync(root);
        } catch {
          continue;
        }
        for (const proj of projects) {
          let sessions;
          try {
            sessions = readdirSync(join(root, proj));
          } catch {
            continue;
          }
          for (const sess of sessions) {
            try {
              const st = statSync(join(root, proj, sess, 'tasks', `${agentId}.output`));
              if (best == null || st.mtimeMs > best) best = st.mtimeMs;
            } catch {
              /* not in this session */
            }
          }
        }
      }
    }
  } catch {
    /* fail-open */
  }
  return best == null ? null : (now - best) / 60000;
}

/**
 * Derive one agent's state PURELY from ground truth. No per-agent stored status is
 * consulted — `ageMin` comes from the output-file mtime and `threadTerminal` from the
 * thread's own `status:` frontmatter.
 *
 * @param {object} a
 * @param {number|null} a.ageMin        minutes since the agent's output last changed, or
 *                                       null when there is no readable output file.
 * @param {boolean} a.threadTerminal    is the owning thread's status done/dismissed?
 * @param {boolean} [a.threadActive]    is the owning thread's status exactly `active`? Only
 *                                       `active` threads are "being worked", so only they
 *                                       can have an UNRECONCILED/idle agent. Deliberately-
 *                                       PARKED phases (plan/todo/needs-decision/blocked/
 *                                       enqueued) with done agents are EXPECTED, not a
 *                                       drift signal — never flagged. (Defaults true for
 *                                       backward-compat when a caller doesn't pass it.)
 * @param {boolean} [a.threadDownstream] does the thread have a PR landing via the merge
 *                                       cascade (`.fray/merge-queue.jsonl`)? Such a thread is
 *                                       legitimately `active` while it merges — the producing
 *                                       agent has finished and reconciled — so it is never a
 *                                       drop. (Defaults false.)
 * @param {boolean} [a.hasRested]        has the agent recorded at least one rest (ended a
 *                                       turn)? Stale output + NO rest = still inside one long
 *                                       tool call (a build/test) → ALIVE, never 'dropped'.
 *                                       (Defaults true for back-compat with callers that don't
 *                                       supply it.)
 * @param {number} [a.idleMin]          idle threshold (min). Default {@link DEFAULT_IDLE_MIN}.
 * @param {number} [a.droppedMin]       dropped/stale threshold (min). Default {@link DEFAULT_DROPPED_MIN}.
 * @param {number} [a.frozenMin]        DEPRECATED alias for `droppedMin` (old callers).
 * @returns {'terminal'|'dropped'|'idle'|'fresh'|'unknown'}
 */
export function deriveAgentState({ ageMin, threadTerminal, threadActive = true, threadDownstream = false, hasRested = true, idleMin = DEFAULT_IDLE_MIN, droppedMin = DEFAULT_DROPPED_MIN, frozenMin }) {
  if (frozenMin != null) droppedMin = frozenMin; // back-compat: old callers passed frozenMin
  // A reconciled thread is the orchestrator's deliberate "I folded this" signal — the
  // only mutable bit in the whole loop, and it lives on the THREAD, not the agent.
  if (threadTerminal) return 'terminal';
  // PARKED (non-terminal but not `active`: plan/todo/needs-decision/blocked/enqueued)
  // is also a deliberate orchestrator state — a stale/done agent on a parked thread is
  // EXPECTED (the work finished, the thread awaits a human/dep), NOT a drop. Only an
  // `active` thread is "being worked right now", so only it can have a drift-signal agent.
  if (!threadActive) return 'terminal';
  // DOWNSTREAM: a PR is landing for this thread via the cascade — it is active for the
  // merge, not a stuck agent. The producing agent has finished + been reconciled; suppress.
  if (threadDownstream) return 'terminal';
  if (ageMin == null) return 'unknown'; // no activity file → can't judge (fail-open)
  if (ageMin > droppedMin) return hasRested ? 'dropped' : 'idle'; // stale + rested = quiet at a stopping point (the signal); stale + never-rested = still in one long tool call → alive
  if (ageMin > idleMin) return 'idle';
  return 'fresh';
}
