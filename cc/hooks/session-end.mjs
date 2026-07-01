#!/usr/bin/env node
// @ts-check
// SessionEnd hook — the EAGER liveness-clear for session ownership. Run directly with node
// (no transpiler — max Node compat; fray's hooks have zero deps).
//
// Fires when a session terminates (clear / logout / prompt_input_exit / resume / other). It
// deletes this session's liveness HEARTBEAT (`.fray/.session-state/<id>.seen`) so the session
// reads as DEAD immediately — its owned threads surface as ORPHANED (claimable) on the very
// next board render, without waiting out the staleness window.
//
// DELIBERATELY it does NOT rewrite any thread `.md`: ownership (`owner_session:`) is left inert
// in frontmatter and derivation reads it as orphaned via the missing heartbeat. That keeps the
// no-hook-ever-rewrites-a-thread-body safety guarantee (no clobber race). The lingering owner
// string is cleaned up lazily by the next `fray claim` or an explicit `fray owners --gc`.
//
// SessionEnd is NOT guaranteed on a hard crash / kill / terminal-close (per the Claude Code
// hooks docs), so it is a best-effort ACCELERATOR, not the authoritative signal — the heartbeat
// staleness window is the crash-safe fallback. Robust: never throws, never blocks (SessionEnd
// cannot block anyway); any error → silent no-op.
import { readFileSync } from 'node:fs';
import { frayActive, currentSessionId, clearSessionHeartbeat } from '../scripts/fray/config.mjs';

/** @type {{ session_id?: string, agent_id?: unknown, agentId?: unknown }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} */
}
// Skip inside sub-agent contexts (they carry agent_id) — a sub-agent ending is not the
// orchestrator session ending.
if (input.agent_id ?? input.agentId) process.exit(0);

try {
  const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';
  // Only act for a fray-active session — a virgin/dormant repo gets no side effects.
  if (frayActive(dir, input.session_id)) {
    clearSessionHeartbeat(dir, currentSessionId(input.session_id));
  }
} catch {
  /* fail-open — never disrupt session teardown */
}
process.exit(0);
