#!/usr/bin/env node
// @ts-check
// PostToolUse hook on the file-writing tools (Edit / Write / MultiEdit) — fires after the
// ORCHESTRATOR edits a fray thread file (`.fray/<slug>.md`) and reminds it to SendMessage-STEER
// any live agent bound to that thread.
//
// WHY THIS EXISTS: editing a thread file does NOT reach a running sub-agent — the agent keeps
// working off its ORIGINAL dispatch prompt and never re-reads the `.md`. A repeated real failure:
// the orchestrator edits a thread to change direction and wrongly assumes the in-flight agent
// will pick it up. The only channel that reaches a running agent is SendMessage (by agentId).
// So on an orchestrator thread-edit while a live agent is bound, we inject a one-line steer nudge.
//
// THE CORRECTNESS BAR — never nag a SUB-AGENT editing its OWN thread. A dispatched sub-agent owns
// and edits its own `.fray/<slug>.md`; that edit ALSO fires this PostToolUse hook, but in the
// SUB-AGENT's context — and telling that agent to "go steer the agent bound to this thread"
// (itself) is noise. We must only fire when the editor is the ORCHESTRATOR steering a DIFFERENT
// live agent. THE SIGNAL: the hook stdin carries `agent_id` (aka `agentId`) ONLY inside a
// sub-agent context — the main/orchestrator session has none. This is the SAME signal
// fray-reminder.mjs uses to skip sub-agent contexts (`if (hi.agent_id ?? hi.agentId) exit`).
// Secondary belt-and-suspenders: a sub-agent transcript lives under a `/tasks/` segment
// (see agent-liveness.deriveTasksDir); the orchestrator's transcript sits at the project root.
// Either positive sub-agent signal → SKIP. Absence of both → treat as the orchestrator. This is
// the lower-noise default: both signals only ever say "positively a sub-agent," so a miss (no
// nag) is the failure mode, never a false nag of a self-edit — the correct bias for this hook.
//
// OUTPUT: inject via hookSpecificOutput.additionalContext (+ a calm systemMessage). NEVER blocks
// (no `decision: block`) — a PostToolUse hook must not trap the edit.
//
// NOISE CONTROL: a per-(slug, agentId) 5-min repeat guard in `.fray/.thread-edit-steer-state.json`
// so rapid successive edits to one thread don't re-nag every keystroke.
//
// FAIL-OPEN ABSOLUTELY: any error / missing file / unparseable stdin → exit 0, no output. Never
// throw, never block an edit.
// GATE: a fray-ui WORKER session (FRAY_UI_THREAD set) is owned by the cc-worker plugin — the
// orchestrator hooks must stay silent there, or their injected pulses pollute the worker's
// transcript (and the fray-ui chat rendering of it). Exit 0 with no output = inert.
if ((process.env.FRAY_UI_THREAD ?? '').trim()) process.exit(0);

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { frayActive } from '../scripts/fray/config.mjs';

const STATE_FILE = '.thread-edit-steer-state.json';
const REPEAT_MS = 300_000; // 5 min per (slug, agentId) — don't re-nag rapid successive edits
const STATE_CAP = 200; // bound the state map so a long-lived board can't grow it without limit

/**
 * Is the EDITOR a sub-agent (not the orchestrator)? Any positive sub-agent signal → true.
 * @param {Record<string, any>} payload
 * @returns {boolean}
 */
function editorIsSubagent(payload) {
  if (payload.agent_id ?? payload.agentId) return true; // present only in a sub-agent context
  const tp = payload.transcript_path;
  if (typeof tp === 'string' && tp.includes('/tasks/')) return true; // agent transcript lives under tasks/
  return false;
}

/**
 * Resolve `file_path` to a TOP-LEVEL fray thread slug, or null. Only `<projectDir>/.fray/<slug>.md`
 * qualifies: excludes config.yml (not `.md`), `.fray/*.findings/` sidecars (nested dir), dotfiles
 * / `_`-prefixed meta, and any path not directly in `.fray/`.
 * @param {unknown} filePath
 * @param {string} projectDir
 * @returns {string|null}
 */
function threadSlug(filePath, projectDir) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = resolve(projectDir, filePath); // absolute passes through; relative resolves off root
  if (dirname(abs) !== resolve(projectDir, '.fray')) return null; // must be DIRECTLY in .fray/
  const base = basename(abs);
  if (!base.endsWith('.md') || base.startsWith('.') || base.startsWith('_')) return null;
  const slug = base.slice(0, -3);
  return slug || null;
}

/** @param {string} statePath @returns {Record<string, number>} */
function readState(statePath) {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/** @param {string} statePath @param {Record<string, number>} state */
function writeState(statePath, state) {
  try {
    let out = state;
    const keys = Object.keys(state);
    if (keys.length > STATE_CAP) {
      // keep the most recent (highest ts) STATE_CAP entries — older ones long past the guard window
      out = Object.fromEntries(
        Object.entries(state)
          .sort((a, b) => b[1] - a[1])
          .slice(0, STATE_CAP),
      );
    }
    writeFileSync(statePath, JSON.stringify(out) + '\n');
  } catch {
    /* best-effort — a state write must never disturb the edit */
  }
}

async function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    return; // no/invalid stdin → nothing to do
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!frayActive(projectDir, payload.session_id)) return; // dormant here → silent

  if (editorIsSubagent(payload)) return; // a sub-agent (incl. self-edit) — never nag
  const slug = threadSlug(payload?.tool_input?.file_path, projectDir);
  if (!slug) return; // not a top-level thread file

  // Live bound agent for this thread — dynamic import so a broken helper can never crash the
  // hook before main()'s catch (matches the other hooks' import discipline).
  let agent = null;
  try {
    const { liveBoundAgentForThread } = await import('../scripts/fray/agent-liveness.mjs');
    agent = liveBoundAgentForThread({ slug, transcriptPath: payload.transcript_path, projectDir });
  } catch {
    return; // fail-open
  }
  if (!agent) return; // no live agent bound to this thread → nothing to steer

  const statePath = join(projectDir, '.fray', STATE_FILE);
  const state = readState(statePath);
  const key = `${slug}::${agent.id}`;
  const now = Date.now();
  const last = state[key];
  if (typeof last === 'number' && now - last < REPEAT_MS) return; // within the repeat window → quiet

  state[key] = now;
  writeState(statePath, state);

  const shortId = agent.id.slice(0, 9);
  const who = `${agent.label ? `${agent.label} ` : ''}[${shortId}]`;
  const ctx =
    `fray: you just edited .fray/${slug}.md, but ${who} — the live agent bound to this thread — will NOT see that edit; ` +
    `it keeps working off its original dispatch prompt and won't re-read the file. If this change redirects or rescopes it, ` +
    `SendMessage-STEER it now by agentId (${agent.id}) to fold the change in. Do NOT cold-redispatch a replacement and do NOT ` +
    `spawn a clobbering sibling — steer the running agent.`;
  const sys = `fray: ${slug} edited while ${who} is live — SendMessage-steer it to pick up the change.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx },
      systemMessage: sys,
    }),
  );
}

main().catch(() => process.exit(0));
