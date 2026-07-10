// @ts-check
/**
 * fray — SubagentStop hook. Fires when a background sub-agent comes to REST
 * (stops with no live children of its own; it may be resumed, so this can fire
 * MORE THAN ONCE for the same agent, and a rest does NOT mean the agent's
 * deliverable is finished).
 *
 * Its ONE job: append a timestamped line to `.fray/.rested-agents.jsonl` so the
 * Stop hook (fray-stop-reminder) can refuse to let the orchestrator go idle while
 * a rest sits un-reconciled. This is the mechanism backstop for the #1 recurring
 * failure — a rested agent's findings never getting folded + its queue drained.
 *
 * fray-ATTRIBUTION GATE (2026-06-21): SubagentStop fires for EVERY subagent stop —
 * built-in Explore/Plan agents, Skill executions (`fray:fray` itself!), and other
 * harness-internal subagents — NOT only fray's backgrounded `Agent` dispatches.
 * Recording all of them logged phantom rests in repos where fray dispatched ZERO
 * agents, tripping the Stop hook's REST guard against agents that never existed.
 * So we only record a rest once fray has ACTUALLY dispatched a background agent in
 * this repo: the dispatch hook (agent-dispatch.mjs) bumps `.fray/.dispatch-count` on
 * every backgrounded dispatch (tagged or untagged one-shot), and we gate on it.
 *   - NO false POSITIVES: count == 0 (no fray dispatch) → never record. Kills the bug.
 *   - NO false NEGATIVES: once fray has dispatched, EVERY rest is recorded — including
 *     an agent that rests repeatedly (resume) and untagged one-shots (which write no
 *     ledger entry). The count is a "has fray ever dispatched here" gate, NOT a cap,
 *     so a real rest is never suppressed. (A `agent_type` denylist of known builtins
 *     is layered on as cheap defense-in-depth, but the count is the load-bearing gate.)
 *
 * FAIL-OPEN: any error → exit 0. A sub-agent must NEVER be blocked from stopping
 * by this recorder, and a write failure must not surface as an error. Likewise, if
 * the gate signal is unreadable we FAIL TOWARD RECORDING (a missed rest is the worse
 * failure — it silently hides exactly what the REST guard exists to catch).
 */
// GATE: a fray-ui WORKER session (FRAY_UI_THREAD set) is owned by the cc-worker plugin — the
// orchestrator hooks must stay silent there, or their injected pulses pollute the worker's
// transcript (and the fray-ui chat rendering of it). Exit 0 with no output = inert.
if ((process.env.FRAY_UI_THREAD ?? '').trim()) process.exit(0);

import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { frayActive, stampOwnerReconciled } from '../scripts/fray/config.mjs';
import { threadForAgent } from '../scripts/fray/agent-bindings.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAY_DIR = join(PROJECT_DIR, '.fray');
const REST_LOG = join(FRAY_DIR, '.rested-agents.jsonl');
const DISPATCH_COUNT = join(FRAY_DIR, '.dispatch-count');

// Known harness-internal / built-in agent_type values that fray NEVER dispatches as a
// background effort. A SubagentStop carrying one of these is definitively not a fray rest.
// Cheap, conservative defense-in-depth: the dispatch-count gate already covers the bug;
// this just suppresses the obvious builtins even if a count race ever let one through.
// Keep CONSERVATIVE — only list types that can NEVER be a real fray dispatch, so this can
// never introduce a false negative.
const NON_FRAY_AGENT_TYPES = new Set(['Explore', 'Plan', 'statusline-setup']);

try {
  // fray ACTIVATION GATE — fray ships globally and this hook fires on EVERY subagent stop
  // in EVERY project. Do NOTHING unless the project is opted in (`.fray/` exists AND not
  // disabled). Critically, this hook must NOT create `.fray/` in a virgin repo: recording a
  // rest is meaningless when there's no thread board to reconcile against, and silently
  // materializing `.fray/` would break the dormant-until-bootstrapped DX. So we only ever
  // append to an ALREADY-EXISTING, opted-in `.fray/` — the `/fray` skill creates it, never us.
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    /* no/invalid stdin → record the bare event anyway (fail toward recording) */
  }

  if (!frayActive(PROJECT_DIR, payload.session_id) || !existsSync(FRAY_DIR)) process.exit(0);

  // ATTRIBUTION GATE — only record a rest that is plausibly a fray-dispatched background
  // agent. Two checks, both fail TOWARD recording (a missed real rest is the worse bug):
  //   1) agent_type denylist — a known harness builtin (Explore/Plan/…) is never a fray rest.
  //   2) dispatch-count gate — fray must have dispatched ≥1 background agent in this repo.
  //      count == 0 → no fray agent exists to rest → this stop is non-fray noise → skip.
  if (payload.agent_type && NON_FRAY_AGENT_TYPES.has(payload.agent_type)) process.exit(0);
  let dispatchCount = 0;
  try {
    // A present-but-unparseable count (NaN) is NOT "fray never dispatched" — it's a
    // corrupt/garbage existing file, so fail TOWARD recording (treat as ≥1). Only a
    // cleanly-parsed integer is trusted (the sole writer, agent-dispatch.mjs, always
    // writes `String(n+1)`, so NaN is unreachable in practice — this is belt-and-suspenders).
    const n = parseInt(readFileSync(DISPATCH_COUNT, 'utf8').trim(), 10);
    dispatchCount = Number.isNaN(n) ? 1 : n;
  } catch {
    // Count file absent/unreadable. Distinguish "fray never dispatched" (file truly
    // absent → the bug case → skip) from "transient read error on an existing file"
    // (fail toward recording). existsSync settles it.
    dispatchCount = existsSync(DISPATCH_COUNT) ? 1 : 0;
  }
  if (dispatchCount === 0) process.exit(0); // no fray dispatch → not a fray rest → no record

  // Resolve the thread this agent serves from the AUTOMATIC binding (agentId → thread),
  // so the Stop-hook rest reminder can point reconciliation at the right thread file.
  // Fail-open: an unresolved id just records `thread: null`.
  let thread = null;
  try {
    thread = threadForAgent(PROJECT_DIR, payload.agent_id);
  } catch {
    /* fail-open */
  }
  const rec = {
    ts: new Date().toISOString(),
    // best-effort identifiers — payload shape varies; record whatever is present
    transcript: payload.transcript_path || null,
    session: payload.session_id || null,
    agent_type: payload.agent_type || null,
    agent_id: payload.agent_id || null,
    thread: thread || null,
  };
  appendFileSync(REST_LOG, JSON.stringify(rec) + '\n');

  // STAMP-ON-AGENT-COMPLETION (write-ownership treadmill fix): the owning agent just edited its
  // OWN thread, bumping its mtime. Record that mtime as "reconciled by its owner up to here" so the
  // dirty-gate does NOT nag the orchestrator to re-ground a thread the agent itself just reconciled
  // — only NON-owning drift (an orchestrator edit / a referenced PR-CI moving) should nag. Reading
  // the thread's mtime NOW captures the post-edit state (the rest fires after the agent's turn).
  if (thread) {
    try {
      stampOwnerReconciled(PROJECT_DIR, thread, statSync(join(FRAY_DIR, `${thread}.md`)).mtimeMs);
    } catch {
      /* fail-open — a missed stamp just risks one spurious reconcile nag */
    }
  }
} catch {
  /* fail-open */
}
process.exit(0);
