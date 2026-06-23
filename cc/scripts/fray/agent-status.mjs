// @ts-check
/**
 * fray — DERIVED agent state. The single shared derivation used by BOTH the Stop-hook
 * liveness helper (`./agent-liveness.mjs`) and the board (`./index.mjs`), so an agent's
 * reported state can never drift between the two.
 *
 * THE PRINCIPLE — compute, don't store (the same rule the board already follows for
 * thread status). A thread's `agents:` binding records ONLY immutable-at-dispatch facts
 * (`{id, label}`); it carries NO hand-maintained per-agent `status` field. (A legacy
 * `status:` may still be PRESENT in old frontmatter — it is IGNORED, never trusted.)
 * Every liveness/doneness judgement is DERIVED here from ground truth:
 *
 *   - output-file (`tasks/<id>.output`) mtime → how long since the agent last wrote,
 *   - the THREAD's own `status:` (done/dismissed = terminal) → whether the orchestrator
 *     has deliberately reconciled the thread.
 *
 * There is NO durable per-agent completion signal a hook can read: `.rested-agents.jsonl`
 * records only `{ts, transcript, session}` — NO agent id — so it cannot attribute a rest
 * to a specific agent. "Done" is therefore INFERRED (terminal-or-stale output + thread
 * status), never read from a stored per-agent flag. That absence is exactly why the old
 * hand-maintained `status` field drifted and false-flagged a completed agent as idle;
 * removing it makes that drift class structurally impossible.
 *
 * Derived states (one per dispatched agent):
 *   - 'terminal'       — the THREAD is terminal (done/dismissed). Nothing to flag.
 *   - 'unreconciled'   — output is stale (>frozenMin) BUT the thread is non-terminal:
 *                        a likely-finished agent the orchestrator never folded. THE one
 *                        signal that matters.
 *   - 'frozen'         — output stale (>frozenMin), thread non-terminal, treated the same
 *                        as unreconciled (a stale-output agent IS the unreconciled case);
 *                        kept as a distinct return only for callers that want the wording.
 *   - 'idle'           — output quiet (>idleMin, <=frozenMin), thread non-terminal: poke
 *                        or confirm it's mid-long-build.
 *   - 'fresh'          — output recent (<=idleMin): actively working, say nothing.
 *   - 'unknown'        — no readable output file (placeholder id, never-started): can't
 *                        judge; fail-open (say nothing).
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_IDLE_MIN = 10;
export const DEFAULT_FROZEN_MIN = 25;

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
 *                                       PARKED phases (needs-decision/blocked/
 *                                       enqueued/todo) with done agents are EXPECTED, not a
 *                                       drift signal — never flagged. (Defaults true for
 *                                       backward-compat when a caller doesn't pass it.)
 * @param {number} [a.idleMin]          idle threshold (min). Default {@link DEFAULT_IDLE_MIN}.
 * @param {number} [a.frozenMin]        frozen/stale threshold (min). Default {@link DEFAULT_FROZEN_MIN}.
 * @returns {'terminal'|'unreconciled'|'idle'|'fresh'|'unknown'}
 */
export function deriveAgentState({ ageMin, threadTerminal, threadActive = true, idleMin = DEFAULT_IDLE_MIN, frozenMin = DEFAULT_FROZEN_MIN }) {
  // A reconciled thread is the orchestrator's deliberate "I folded this" signal — the
  // only mutable bit in the whole loop, and it lives on the THREAD, not the agent.
  if (threadTerminal) return 'terminal';
  // PARKED (non-terminal but not `active`: needs-decision/blocked/enqueued/todo)
  // is also a deliberate orchestrator state — a stale/done agent on a parked thread is
  // EXPECTED (the work finished, the thread awaits a human/dep), NOT unreconciled. Only an
  // `active` thread is "being worked right now", so only it can have a drift-signal agent.
  if (!threadActive) return 'terminal';
  if (ageMin == null) return 'unknown'; // no activity file → can't judge (fail-open)
  if (ageMin > frozenMin) return 'unreconciled'; // stale output + ACTIVE thread = the signal that matters
  if (ageMin > idleMin) return 'idle';
  return 'fresh';
}
