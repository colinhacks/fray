#!/usr/bin/env node
// @ts-check
// PreToolUse hook on the `Agent` tool. Two jobs in one place:
//   1) ENFORCE background dispatch — deny any Agent call lacking run_in_background:true
//      (a foreground agent blocks the orchestrator turn; a human interjection orphans it).
//   2) AUTO-APPEND an ORCHESTRATION EPILOGUE to every backgrounded sub-agent's prompt, so
//      sub-agents always hand back the next links in the chain (follow-ups / self-review /
//      push-to-CI / next-step). This is the multi-agent chaining pattern (2026-06-13:
//      the orchestrator often loses track of a sub-agent's role in a broader implementational plan).
// Run directly with node (no transpiler). Supersedes agent-must-be-background.sh.
// FAIL OPEN: any parse error → allow unmodified. A broken dispatch hook must never halt
// orchestration (the overnight heartbeat itself dispatches through here).
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { frayActive } from '../scripts/fray/config.mjs';

const EPILOGUE = `

---
[ORCHESTRATION EPILOGUE — auto-appended by the dispatch hook] Your final message IS the handoff — make it orchestration-ready: verdict/status; what you did; changed files/artifacts/clone-path/commit SHA when applicable; verification commands + their results; caveats/risks; one concrete next action. A bare "done" or progress-only final message is an INCOMPLETE handoff (a bug), not success.
THREAD WRITE-OWNERSHIP: if a \`THREAD: <slug>\` tag is at the top of this prompt, you OWN \`.fray/<slug>.md\` — edit it IN PLACE (the Edit tool) to reflect what you did: update \`## Status\` / \`## Decisions\` / \`## Next step\` / \`## Steps\`, keeping the single-voice current-truth discipline (no full-file rewrite, no changelog append — git holds the past). Write detailed artifacts (long traces/tables/write-ups) to a \`.fray/<slug>.findings/<id>.md\` sidecar. Edit ONLY your own dispatched thread, never another thread's \`.md\` or \`config.yml\`.
YOU OWN YOUR THREAD'S \`status:\` — SET IT YOURSELF to a VALID value; the orchestrator does NOT clean up after you. The ONLY allowed statuses are EXACTLY: \`todo · enqueued · active · blocked · needs-decision · done · dismissed\` (any other word — "planned"/"ready"/"landing"/"investigated"/"root-caused"/"complete" — is INVALID and breaks the board validator). When your work is genuinely complete, set \`status: done\` (or \`dismissed\` if decided-not-to-pursue); if it now needs a human call, \`needs-decision\`; if blocked on another in-flight thread, \`enqueued\` + \`depends_on:\`. Also update the 1-line \`status_text:\` to the current truth. Do NOT leave the thread \`active\` when you've finished — that strands it. (Per-agent liveness is DERIVED by the board from output freshness + the THREAD status; do NOT hand-maintain any per-agent \`status\` field in \`agents:\` — just set the THREAD status correctly.)
End your final report with a \`## Follow-ups\` section so the orchestrator can chain the next steps:
1. Concrete FOLLOW-UP work your findings/changes imply.
2. If you implemented something substantial → recommend a SELF-REVIEW pass (a fresh adversarial sub-agent reviewing your diff for correctness/regressions).
3. If you added/changed code or tests CI should exercise → recommend cutting a push to \`main\` + a CI-watch follow-up to confirm green.
4. The single most important NEXT STEP, and whether it needs maintainer sign-off (a default/security/product/brand/API-config-env call → recommend-only) or can proceed autonomously.
Your FINAL MESSAGE is your whole report to the orchestrator — there is no mid-run channel back to it, so put everything it needs to chain the next step in that final message.
If you COMMITTED: verify the tree COMPILES at your commit (a parallel agent may share a file — build before committing so you don't ship a broken HEAD). If there are no follow-ups, write "Follow-ups: none."`;

/**
 * Write the hook decision object and exit.
 * @param {unknown} obj
 * @returns {never}
 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const ti = input.tool_input ?? {};
  const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';

  // fray ACTIVATION GATE — fray ships globally, so this hook fires in EVERY project.
  // Stay a SILENT no-op (allow the dispatch unmodified — no bg-enforce / epilogue / ledger)
  // unless the project is opted in: `.fray/` exists AND the per-session sentinel is not
  // forced off. A virgin repo with no `.fray/` is dormant; the `/fray` skill bootstraps it.
  if (!frayActive(dir, input.session_id)) emit({});

  if (ti.run_in_background !== true) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'fray mode (hook-enforced): Agent sub-agents MUST be dispatched with run_in_background:true — never foreground/blocking. A foreground agent blocks the orchestrator turn and a human interjection orphans its work. Re-send this Agent call with run_in_background:true.',
      },
    });
  }

  // fray DISPATCH MARKER — bump a durable counter for EVERY backgrounded fray Agent
  // dispatch (tagged or untagged one-shot), BEFORE the THREAD:-ledger branch below.
  // This is the load-bearing signal the SubagentStop recorder (fray-subagent-rest.mjs)
  // gates on: it only records a rest once fray has actually dispatched a background
  // agent in this repo. Without it, the recorder logged a "rest" for EVERY SubagentStop
  // — including built-in Explore/Plan agents and Skill executions fray never dispatched —
  // tripping the Stop hook's REST guard with phantom agents (2026-06-21). The ledger
  // (.dispatch-ledger.jsonl) is THREAD:-only and so can't cover untagged one-shots; this
  // count does. Fail open: a counter error must never block a dispatch.
  try {
    const countFile = `${dir}/.fray/.dispatch-count`;
    let n = 0;
    try {
      n = parseInt(readFileSync(countFile, 'utf8').trim(), 10) || 0;
    } catch {
      /* absent / unreadable → start at 0 */
    }
    writeFileSync(countFile, String(n + 1) + '\n');
  } catch {
    /* fail open — never block a dispatch on the counter */
  }

  // STRIP the `name`/`team_name` fields from EVERY dispatch. Setting either strands nested
  // dispatches: when an L1 sub-agent dispatches an L2 WITH a name, L2's result routes wrong and
  // never returns cleanly to L1. PreToolUse can rewrite the tool input (the epilogue append below
  // already relies on `updatedInput`), so we silently scrub the fields and let the dispatch run —
  // the orchestrator never has to remember "don't set name." `tiStripped` is the base for the
  // `updatedInput` we emit on every allowed dispatch (with the epilogue appended).
  const { name: _droppedName, team_name: _droppedTeam, ...tiStripped } = ti;

  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';

  // fray pointer-back: if the dispatch names a THREAD (a `THREAD: <name>` line the
  // orchestrator puts at the top of the prompt), log it to the dispatch ledger so the
  // orchestrator has a durable record of which thread each agent serves — survives
  // compaction. Fail open: a ledger error must never block a dispatch.
  const m = prompt.match(/^THREAD:\s*([\w./-]+)/m);
  const thread = m ? m[1].replace(/^\.fray\//, '').replace(/\.md$/, '') : null;
  if (thread) {
    // BULLETPROOF: a THREAD:-tagged dispatch whose .fray/<slug>.md does NOT exist is DENIED.
    // The thread file must be created FIRST (with current context) before any agent runs for it —
    // every new/split-off effort gets its file first, or it gets forgotten (2026-06-14).
    // (A genuine one-shot with no thread should carry no THREAD: tag.)
    if (!existsSync(`${dir}/.fray/${thread}.md`)) {
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `fray (hook-enforced): dispatch is tagged \`THREAD: ${thread}\` but \`.fray/${thread}.md\` does NOT exist. CREATE THE THREAD FILE FIRST — write \`.fray/${thread}.md\` with all current context (Goal · Status · Decisions · Open questions · Steps · Next step), THEN re-send this dispatch. Every new or split-off effort gets its file BEFORE any agent runs for it. (If this is a true one-shot needing no thread, remove the \`THREAD:\` line from the prompt.)`,
        },
      });
    }
    try {
      appendFileSync(
        `${dir}/.fray/.dispatch-ledger.jsonl`,
        JSON.stringify({ ts: new Date().toISOString(), agent_type: ti.subagent_type ?? '', thread, reconciled: false }) + '\n',
      );
    } catch {
      /* fail open — never block a dispatch on the ledger */
    }
  }

  const updatedInput = prompt.includes('[ORCHESTRATION EPILOGUE')
    ? tiStripped
    : { ...tiStripped, prompt: prompt + EPILOGUE };

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  });
} catch {
  emit({}); // fail open — allow unmodified
}
