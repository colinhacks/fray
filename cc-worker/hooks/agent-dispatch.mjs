#!/usr/bin/env node
// @ts-check
// PreToolUse hook on the `Agent` tool (fray-worker). A worker MAY spin up its own helper
// sub-agents; this hook holds them to the same two rules cc enforces for the orchestrator:
//   1) ENFORCE background dispatch — deny any Agent call lacking run_in_background:true (a
//      foreground agent blocks the worker's turn; a human interjection orphans it).
//   2) STRIP `name`/`team_name` — setting either strands a nested dispatch (its result routes
//      wrong and never returns cleanly), so scrub both silently.
//   3) AUTO-APPEND a worker-flavored ORCHESTRATION EPILOGUE so helpers hand back an
//      orchestration-ready report and run long ops to completion inline.
//
// GATE: inert unless FRAY_UI_THREAD is set (not a fray-ui worker → allow every dispatch unmodified).
//
// DROPPED vs cc's agent-dispatch.mjs (see DECISIONS.md): the `.dispatch-count` bump (it only gates
// cc's SubagentStop rest-recorder, which cc-worker does not ship) and the THREAD:-ledger write +
// thread-existence DENY gate (that guards the orchestrator's "file the thread before dispatching"
// discipline; a worker owns exactly one already-existing thread and its helpers own no thread).
//
// FAIL OPEN: any parse error → allow unmodified. A broken dispatch hook must never halt work.
import { readFileSync } from 'node:fs';

const EPILOGUE = `

---
[ORCHESTRATION EPILOGUE — auto-appended by the fray worker dispatch hook] You are a helper sub-agent for a fray-ui worker. Your final message IS the handoff — make it orchestration-ready: verdict/status; what you did; changed files/artifacts/commit SHA when applicable; verification commands + their results; caveats/risks; one concrete next action. A bare "done" or progress-only final message is an INCOMPLETE handoff (a bug), not success.
RUN LONG OPS TO COMPLETION INLINE. Your final message ENDS this helper task, so never return while your own Monitor/background command is live. Keep a bounded wait in a foreground Bash call when practical; if a watch must outlive this helper, report the current state and exact watch command so the top-level worker can own it. Monitor and background Bash are available, but they are not permission to background-and-rest.
DO NOT edit the dispatcher's scratchpad (\`.fray/threads/<session-id>/scratch.md\`) or any \`.fray/\` state — the fray worker who dispatched you OWNS it and folds your report in. If a scratchpad path is in your prompt, READ it for shared context but never write it. Report your findings/changes in your FINAL MESSAGE; that is the only channel back.
If you COMMITTED: verify the tree COMPILES at your commit. If there are no follow-ups, say "Follow-ups: none."`;

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  // WORKER GATE — inert outside a fray-ui worker session.
  if (!(process.env.FRAY_UI_THREAD ?? '').trim()) emit({});

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const ti = input.tool_input ?? {};

  if (ti.run_in_background !== true) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'fray worker (hook-enforced): Agent sub-agents MUST be dispatched with run_in_background:true — never foreground/blocking. A foreground agent blocks the worker turn and a human interjection orphans its work. Re-send this Agent call with run_in_background:true.',
      },
    });
  }

  // Strip name/team_name (they strand nested dispatches), then append the epilogue once.
  const { name: _droppedName, team_name: _droppedTeam, ...tiStripped } = ti;
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
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
