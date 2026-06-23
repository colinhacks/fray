#!/usr/bin/env node
// @ts-check
// SessionStart hook — SEEDS the session's orchestrator context. Run directly with node
// (no transpiler — max Node compat; fray's hooks have zero deps).
//
// Fires on EVERY session start (startup/resume/clear/compact — enumerated in hooks.json).
// It injects two layers:
//   1. `core` — the static orchestrator role + hygiene doctrine, on EVERY session start.
//      This used to be re-injected per-message by fray-reminder (UserPromptSubmit); it is
//      static within a session, so it belongs here (once at session start + once after each
//      compaction, exactly the cadence static doctrine wants) — NOT re-paid every turn.
//   2. `grounding` — the fray control-surface re-grounding, ADDITIONALLY when
//      source==="compact". Compaction is the one event that drops the deep working model.
//
// Why SessionStart and not PostCompact: PostCompact is OBSERVE-ONLY — its
// hookSpecificOutput.additionalContext is NOT delivered to the model (verified against the
// Claude Code hooks docs, 2026-06-14), so the old PostCompact wiring was a silent no-op.
// SessionStart additionalContext IS injected into the next turn. Robust: never throws (a
// broken hook must not disrupt the session).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frayActive } from '../scripts/fray/config.mjs';

/**
 * Is Claude Code's EXPERIMENTAL AGENT TEAMS feature enabled for this session?
 *
 * fray's entire steering model (ALWAYS STEER, don't re-dispatch — SendMessage to a
 * RUNNING or COMPLETED sub-agent, warm-resume) depends on this feature; without it the
 * methodology silently degrades to cold re-dispatch. The feature is toggled by the
 * `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` environment variable (the canonical mechanism,
 * the same var fray's docs reference). Claude Code injects the `env:` block from
 * settings.json into every process it spawns — INCLUDING hook processes — so a hook can
 * RELIABLY read the state straight from `process.env` (empirically verified: with the var
 * set in ~/.claude/settings.json `env`, it is present in a hook's `process.env`). Truthy
 * spellings accepted: 1 / true / yes / on (case-insensitive).
 *
 * BELT-AND-SUSPENDERS: process.env is the primary, reliable signal, but we ALSO read the
 * global `~/.claude/settings.json` `env` block as a fallback — so a user who set the var
 * THERE but whose hook env somehow missed it (an unlikely edge case) is never false-prompted.
 * Both checks fail-open (any read/parse error → treated as "not found here").
 * @returns {boolean}
 */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function agentTeamsEnabled() {
  if (truthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)) return true;
  // Fallback: the canonical persistent home is the global settings.json `env` block.
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    return truthy(settings?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS);
  } catch {
    return false; // absent / unreadable / malformed → rely on the env check above
  }
}

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, session_id?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} → proceed (fail-open to inject) */
}
// Skip inside sub-agent contexts (they carry agent_id).
if (input.agent_id ?? input.agentId) process.exit(0);
// fray ACTIVATION GATE — fray ships globally and this hook fires in EVERY project. Seed
// NOTHING unless the project is opted in (`.fray/` exists AND not disabled), so a virgin
// repo gets no fray doctrine. The `/fray` skill bootstraps `.fray/` to activate fray here.
if (!frayActive(process.env.CLAUDE_PROJECT_DIR ?? '.', input.session_id)) process.exit(0);

// The static orchestrator role + hygiene doctrine. Lifted VERBATIM from fray-reminder.mjs
// (the former authoritative copy) — it does not change within a session, so it seeds ONCE
// here instead of being re-injected on every prompt.
const core =
  '⟦orchestrator reminder⟧ You are the ORCHESTRATOR: delegate ALL project work — code/doc edits, GitHub writes (comments/PR edits/resolves), builds, tests, investigations — to BACKGROUND sub-agents; never do them yourself in the foreground. Your foreground = dispatch, synthesize returns, decide, edit your own control surfaces (the fray board/threads + skill/settings), and REVIEW+MERGE the PRs landing agents open. Substantive work lands via a PR from an isolated git WORKTREE (agents open it, you merge); the SHARED main tree is NEVER branched/reset/stashed. Exceptions commit direct to main: control-surface edits and trivial docs. Keep the fray threads (.fray/<thread>.md; globals in .fray/config.yml) synced THIS turn: fold every returned sub-agent\'s facts into its thread, advance its status, surface decisions/questions; scan the board on demand by running `fray`. HYGIENE: keep each thread\'s ## Status + ## Next current so the LIVE state isn\'t buried — but a thread CAN hold a full record (a done/dismissed thread SHOULD have a complete investigation write-up; do NOT wipe detail to keep it lean). Global structured state lives in config.yml. DONE/DISMISSED threads are KEPT, NEVER deleted — each is its own file, excluded from the active board + the pending list by status, so a finished thread is zero bloat (a core benefit of per-file threads; do NOT clean them up). WRITE-OWNERSHIP: the dispatched sub-agent EDITS ITS OWN thread .md directly (in-place ## Status/## Decisions/## Next step/## Steps + a findings sidecar for depth) — it has the full context and best represents its thread\'s truth. You do NOT re-transcribe what it wrote. The orchestrator\'s RESIDUAL thread role: cross-thread linkage + reversals, the human-decision queue, dispatch/synthesis across efforts, config.yml + the agents:[] dispatch binding (record each dispatched agentId in its thread frontmatter). Reconcile EVERY in-flight sub-agent; never drop a thread. ALWAYS STEER — DON\'T RE-DISPATCH (TOP PRIORITY; when agent-teams is ON, SendMessage works on running AND completed sub-agents): to add context / redirect / fold scope into a file an agent owns, answer a question it raised, or RESUME an agent the instant a temporary blocker (a HOLD, a transient CI failure, a now-available input) clears, MESSAGE/RESUME that agent (by name or agentId) — never let it die and cold-redispatch a fresh replacement (loses its runbook + context), never spawn a clobbering sibling, never kill-and-respawn (orphans WIP). Front-load the prompt regardless; fall back to `enqueued` only when work genuinely needs another agent\'s completed output. Before asserting how the codebase is STRUCTURED, ground it in the code you just read — never reason from stale or secondhand framing.';

// Post-compaction re-grounding — injected ADDITIONALLY only when source==="compact".
// Compaction is the one event that drops the deep working model, so re-seed the fray
// control-surface model + the universal "re-read the code before asserting structure" rule.
// (Project-specific architecture grounding belongs in the host repo\'s own CLAUDE.md/AGENTS.md,
// not in the generic fray plugin.)
const grounding = `⟦fray re-grounding (post-compaction)⟧ Context was just compacted. Re-seed the fray control-surface model NOW, and re-read the relevant code before asserting ANY structural claim about the project.

- The control surface is **fray** — independent per-thread files .fray/<slug>.md + globals in .fray/config.yml (autonomous_mode + a state: block). There is NO stored board; COMPUTE it on demand by running \`fray\`.
- Load the \`fray\` skill for the canonical thread structure (Goal · Status · Decisions · Open questions · Steps/follow-up queue · Next step; done/dismissed = terminal + KEPT) and the full methodology.
- The dispatched sub-agent EDITS ITS OWN thread .md in place (+ a .fray/<thread>.findings/<id>.md sidecar only for parallel fan-out); the orchestrator does cross-thread linkage/reversals, the decision queue, dispatch/synthesis, and config.yml + the agents:[] agentId binding — never re-transcribing what the agent wrote.
- You are empowered (merge agents' PRs, create repos, install tooling, land greenlit work — substantive work via PR from a worktree, control-surface/trivial-doc edits direct to main); reversible action > freezing; do NOT build an "awaiting-maintainer" queue from reversible decisions (the #1 repeated correction).`;

// AGENT-TEAMS GATE — fray's steering core needs experimental agent teams. If it's OFF,
// inject a ONE-TIME notice (this session only) telling the user how to enable it, defaulting
// to the GLOBAL enable (it benefits every fray session across every repo). Idempotent /
// non-nagging: SessionStart can fire multiple times per session (startup/resume/clear/
// compact), so a per-session sentinel under .fray/.session-state/ ensures we notify AT MOST
// once per session. Enabled → say nothing. Fail-open: any error → skip the notice.
let teamsNotice = null;
try {
  if (!agentTeamsEnabled()) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? '.';
    const sid = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
    const stateDir = join(projectDir, '.fray', '.session-state');
    // Sentinel keyed on the session id so the notice fires once per session, not per
    // SessionStart event. With no session id we still emit once (no de-dup file to write).
    const marker = sid ? join(stateDir, `${sid}.teams-notified`) : '';
    const alreadyNotified = marker ? existsSync(marker) : false;
    if (!alreadyNotified) {
      teamsNotice =
        '⟦fray setup⟧ Claude Code\'s EXPERIMENTAL AGENT TEAMS feature appears to be OFF (the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var is unset in this session). ' +
        'fray\'s core steering model — ALWAYS STEER, don\'t re-dispatch: SendMessage to a RUNNING or COMPLETED sub-agent, warm-resume — DEPENDS on it; without it fray silently degrades to cold re-dispatch (you lose live steering + warm-resume and fall back to the `enqueued`/`depends_on` sequencing model). ' +
        'ENABLE IT GLOBALLY (recommended — benefits every fray session in every repo): add it to the `env` block of your GLOBAL settings at `~/.claude/settings.json`:\n' +
        '    {\n      "env": {\n        "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"\n      }\n    }\n' +
        'then RESTART Claude Code (env settings load at startup). ' +
        '(Alternative: `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your shell profile.) ' +
        'Tell the user this once and offer to make the settings.json edit for them. It is EXPERIMENTAL + harness-dependent — if it can\'t be enabled, fray still works (board, dispatch enforcement, rest/stop reconciliation, the whole thread model); only live steering + warm-resume are unavailable.';
      // Mark notified for this session so resume/compact within it won't re-nag.
      if (marker) {
        try {
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(marker, new Date().toISOString() + '\n');
        } catch {
          /* best-effort de-dup; a failed write just risks one extra notice */
        }
      }
    }
  }
} catch {
  teamsNotice = null; // fail-open — never block the seed on the teams check
}

// `core` on EVERY session start; `grounding` ADDITIONALLY only after a compaction;
// `teamsNotice` once per session when agent teams is OFF.
const parts = [core];
if (input.source === 'compact') parts.push(grounding);
if (teamsNotice) parts.push(teamsNotice);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }),
);
process.exit(0);
