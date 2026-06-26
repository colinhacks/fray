#!/usr/bin/env node
// @ts-check
// PostToolUse hook on the `Agent` tool — the AUTOMATIC thread↔agent binding.
//
// This REPLACES the orchestrator's old hand-maintained `agents: [{id, label}]` thread
// frontmatter. The Agent tool's RESULT (delivered here as `tool_response`) carries
// everything the binding needs and the dispatch hook (PreToolUse) could not see:
//   - the new instance `agentId`            (tool_response.agentId / .toolUseResult.agentId)
//   - the resolved `prompt` with the THREAD tag (tool_response.prompt, else tool_input.prompt)
//   - a human-readable `description` → label (tool_input.description / tool_response.description)
// So the instant a background sub-agent launches, we record `agentId → thread` into the
// EPHEMERAL `.fray/.agent-bindings.jsonl`. The orchestrator records nothing by hand; the
// board + Stop-hook liveness read the binding to reconnect a return/rest to its thread.
//
// Fires only AFTER a successful dispatch (a PreToolUse-denied Agent call never runs, so
// never reaches here) — so only real, allowed background dispatches are bound. Untagged
// one-shots (no THREAD tag) write nothing (recordBinding no-ops without a thread).
//
// FAIL-OPEN ABSOLUTELY: any error → exit 0 with no output. A PostToolUse hook must never
// disturb the turn; a missed binding just means one agent isn't surfaced on the board.
import { readFileSync } from 'node:fs';
import { frayActive } from '../scripts/fray/config.mjs';
import { recordBinding, threadFromPrompt } from '../scripts/fray/agent-bindings.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';

  // fray ACTIVATION GATE — fray ships globally, so this fires on EVERY Agent call in EVERY
  // project. Silent no-op unless the project is opted in (`.fray/` exists AND not disabled).
  if (!frayActive(dir, input.session_id)) process.exit(0);

  const ti = input.tool_input ?? {};
  // tool_response shape varies; the agentId/prompt may sit on it directly or under a
  // `toolUseResult` wrapper (the transcript records the latter). Check both, fail-open.
  const tr = input.tool_response ?? {};
  const trInner = tr.toolUseResult ?? tr;

  const agentId = trInner.agentId ?? tr.agentId ?? null;
  const prompt =
    (typeof trInner.prompt === 'string' && trInner.prompt) ||
    (typeof tr.prompt === 'string' && tr.prompt) ||
    (typeof ti.prompt === 'string' && ti.prompt) ||
    '';
  const thread = threadFromPrompt(prompt);
  const label = (typeof ti.description === 'string' && ti.description) || trInner.description || null;

  if (agentId && thread) {
    recordBinding(dir, { agentId, thread, label, session: input.session_id ?? null });
  }
} catch {
  /* fail-open — never disturb the turn */
}
process.exit(0);
