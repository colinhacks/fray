// @ts-check
/**
 * fray — SubagentStop "rest-on-waiter" GUARD. The PREVENTION half of the rest
 * problem (the recorder, fray-subagent-rest.mjs, is the DETECTION half — it still
 * runs and logs every rest; this guard is purely additive alongside it).
 *
 * THE FAILURE it kills (the #1 orchestration friction): a background sub-agent
 * backgrounds a build / test / CI-watch / install / monitor and then RESTS — going
 * idle and handing control back — BEFORE the task is actually done, on the theory
 * that "the waiter will notify me." It won't reliably; the task strands and the
 * orchestrator must manually resume it.
 *
 * Detection is TWO signals, OR-ed (defense in depth; both in rest-detect.mjs):
 *   - STRUCTURAL (primary, high-confidence) — detectStructuralRest: the agent's LAST
 *     tool_use was a BACKGROUND-LAUNCH (a run_in_background Bash/Agent/Task, or a
 *     Monitor/ScheduleWakeup waiter/timer). Keys on what the agent DID (tool name +
 *     run_in_background param), so it is immune to the phrasing drift that makes a
 *     prose matcher fragile.
 *   - PROSE (fallback) — detectWaiterRest: the original phrasing matcher on the final
 *     assistant text, kept as a secondary net for what the structural signal misses.
 * Either fires → this hook BLOCKS the stop and redirects the agent to poll the op
 * INLINE and finish.
 *
 * SubagentStop block contract (verified against Claude Code hooks docs, 2026-06-28):
 * top-level `{ "decision": "block", "reason": "<fed to the subagent>" }`. The reason
 * is delivered to the SUB-AGENT (not the user) to make it continue — so unlike the
 * Stop hook we use plain `reason` (no red-wall display concern: it's the subagent's
 * surface, and the redirect text IS what we want it to read).
 *
 * SAFETY (a bad block traps an agent or loops — these are non-negotiable):
 *   - LOOP GUARD (durable, the load-bearing one): we BLOCK A GIVEN agent_id AT MOST
 *     ONCE, recorded in `.fray/.rest-guard-blocked.jsonl`. `stop_hook_active` is NOT
 *     documented for SubagentStop, so we do not rely on it (we still honor it if
 *     present); the block-once ledger is what actually prevents an infinite
 *     block→stop→block loop. (Belt: the redirect changes the agent's next final
 *     message away from the waiter-tell, so even without the ledger it wouldn't
 *     re-match — but the ledger makes it certain.)
 *   - FAIL-OPEN on ANY uncertainty: no transcript / unreadable / no clear match /
 *     any error → allow the stop. A false block (trapping a genuinely-done agent) is
 *     worse than a missed rest — the recorder + Stop-guard already backstop a slip.
 *   - fray ACTIVATION + dispatch-count attribution gate (same as the recorder): only
 *     act when fray is active AND has actually dispatched a background agent here, and
 *     never on a known harness builtin (Explore/Plan/…). Never block non-fray agents.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { frayActive } from '../scripts/fray/config.mjs';
import { detectWaiterRest, lastAssistantText, detectStructuralRest } from '../scripts/fray/rest-detect.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAY_DIR = join(PROJECT_DIR, '.fray');
const DISPATCH_COUNT = join(FRAY_DIR, '.dispatch-count');
const BLOCKED_LEDGER = join(FRAY_DIR, '.rest-guard-blocked.jsonl');

// Harness builtins fray never dispatches — a SubagentStop carrying one is not a fray rest.
const NON_FRAY_AGENT_TYPES = new Set(['Explore', 'Plan', 'statusline-setup']);

const REDIRECT =
  "You backgrounded an operation and are resting on a waiter/monitor — this strands the task. " +
  "Do NOT rest: poll the operation inline (read its output file / `ps` / the result) until it finishes, " +
  "then complete the task and return your deliverable. If you are GENUINELY blocked on an external thing " +
  "you cannot poll (e.g. a human decision), commit your WIP first, then say so explicitly with the deliverable " +
  "status. Resuming-from-rest wastes an orchestrator round-trip.";

/** Allow the stop (no output). */
function allow() {
  process.exit(0);
}

try {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    allow(); // unreadable input → fail open
  }

  // LOOP GUARD (a): honor stop_hook_active if the harness ever provides it on SubagentStop.
  if (payload.stop_hook_active === true) allow();

  // fray ACTIVATION GATE — do nothing unless this project is opted in (.fray/ exists + on).
  if (!frayActive(PROJECT_DIR, payload.session_id) || !existsSync(FRAY_DIR)) allow();

  // ATTRIBUTION GATE — never block a known builtin, and only act once fray has dispatched
  // a background agent here (count > 0). Unlike the recorder (which fails TOWARD recording),
  // the guard fails TOWARD ALLOWING on any ambiguity — a false block is the worse outcome.
  if (payload.agent_type && NON_FRAY_AGENT_TYPES.has(payload.agent_type)) allow();
  let dispatchCount = 0;
  try {
    const n = parseInt(readFileSync(DISPATCH_COUNT, 'utf8').trim(), 10);
    dispatchCount = Number.isNaN(n) ? 0 : n;
  } catch {
    dispatchCount = 0;
  }
  if (dispatchCount === 0) allow(); // no fray dispatch → not a fray agent → never block

  // LOOP GUARD (b) — the durable one: block a given agent_id at most ONCE.
  const agentId = payload.agent_id || null;
  if (agentId) {
    try {
      if (existsSync(BLOCKED_LEDGER)) {
        const seen = readFileSync(BLOCKED_LEDGER, 'utf8');
        // cheap substring containment is enough — agent ids are opaque unique tokens
        if (seen.includes(`"${agentId}"`)) allow();
      }
    } catch {
      /* unreadable ledger → fall through; the natural redirect still breaks the loop */
    }
  }

  // TWO SIGNALS, OR-ed (defense in depth — see rest-detect.mjs):
  //   STRUCTURAL (primary): the agent's last tool_use was a background-launch
  //     (run_in_background Bash/Agent/Task, or a Monitor/ScheduleWakeup waiter/timer).
  //     Immune to phrasing drift — keys on what the agent DID.
  //   PROSE (fallback): the original phrasing matcher on the final assistant text.
  // Neither fires → allow (fail open).
  const structural = detectStructuralRest(payload.transcript_path);
  const prose = !structural && detectWaiterRest(lastAssistantText(payload.transcript_path));
  if (!structural && !prose) allow();

  // High-confidence waiter-rest → BLOCK and record the block (loop-guard ledger).
  if (agentId) {
    try {
      appendFileSync(
        BLOCKED_LEDGER,
        JSON.stringify({ ts: new Date().toISOString(), agent_id: agentId, agent_type: payload.agent_type || null }) +
          '\n',
      );
    } catch {
      /* recording failure must not stop the block — but with no record we could re-block;
         the redirect changes the next final message away from the waiter-tell, so the
         natural loop-break still holds. */
    }
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason: REDIRECT }));
  process.exit(0);
} catch {
  allow(); // fail open on anything unexpected
}
