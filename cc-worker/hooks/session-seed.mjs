#!/usr/bin/env node
// @ts-check
// SessionStart hook (fray-worker) — SEEDS a fray-ui WORKER session's context. Run directly with
// node (zero deps, max Node compat), mirroring cc's hook idiom.
//
// A fray-ui worker is a top-level interactive `claude` the UI spawns per effort; the slug arrives in
// env FRAY_UI_THREAD (and a `THREAD:` line in the first prompt). There are NO thread files, no
// frontmatter, no status field — a worker SIGNALS through its final message (fences) and PERSISTS
// through a scratchpad. This hook injects, on every session start (startup/resume/clear/compact):
//   1. `core` — a runtime re-grounding + pointer, NOT a second copy of the contract: the full worker
//      contract lives ONCE in the system prompt (workerPrompt.ts) the server injects at spawn. This
//      carries only what a static system prompt can't: the runtime scratchpad PATH + an essential
//      signal-at-rest anchor + a pointer to the system prompt / `fray:worker` skill.
//   2. the SCRATCHPAD PATH — `.fray/threads/<session_id>/scratch.md`, the worker's compaction-proof memory.
//   3. on `compact` — a short re-grounding (compaction drops the deep model + the scratchpad reminder).
//
// GATE: everything is gated on FRAY_UI_THREAD being set, so the plugin is completely inert when
// loaded outside a fray-ui worker (e.g. a plain `claude --plugin-dir cc-worker` smoke run).
//
// DOUBLE-HOOK DEFENSE: if the user ALSO has the orchestrator `cc` (fray) plugin globally enabled,
// its hooks fire in every repo but are gated on cc's opt-IN sentinel — dormant until a session runs
// `fray on`. A fresh worker never runs `fray on`, so cc is already dormant here. To make that
// GUARANTEED (and survive an accidental `fray on`/orchestrator-skill load inside a worker), we write
// cc's OWN per-session `off` sentinel for this session id via cc's shared API — belt-and-suspenders,
// overridable by an explicit later `fray on`. See DECISIONS.md.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setSessionOverride, currentSessionId } from '../scripts/fray/config.mjs';

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, session_id?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} → proceed (fail-open to inject) */
}
// Skip inside sub-agent contexts (they carry agent_id) — the seed is for the top-level worker.
if (input.agent_id ?? input.agentId) process.exit(0);

// WORKER GATE — inert unless this is a fray-ui worker session.
const thread = (process.env.FRAY_UI_THREAD ?? '').trim();
if (!thread) process.exit(0);

const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';

// Neutralize the orchestrator cc plugin for THIS session (defensive; see header + DECISIONS.md).
// The session id also names the worker's scratchpad (`.fray/threads/<session_id>/scratch.md`).
let sid = null;
try {
  sid = currentSessionId(input.session_id);
  if (sid) setSessionOverride(dir, sid, 'off');
} catch {
  /* best-effort — a failed sentinel write just leaves cc at its dormant default */
}
const scratch = sid
  ? '.fray/threads/' + sid + '/scratch.md'
  : '.fray/threads/<session-id>/scratch.md';

// A RUNTIME re-grounding + pointer, NOT a second copy of the contract. The full worker contract
// (signal fences, scratchpad rules, sub-agent rules, the settings-toggled runtime release gate) lives
// ONCE in the system prompt fray-ui injects at spawn (workerPrompt.ts / loadWorkerPrompt) — which is
// re-applied on every resume and survives compaction. This hook adds only what a static system prompt
// CANNOT carry: the runtime-derived scratchpad PATH, an essential signal-at-rest anchor, and (below)
// the compaction re-read nudge, gh guidance, and the defensive cc-orchestrator off-sentinel.
const core =
  '⟦fray worker contract⟧ You are a fray-ui WORKER driving EXACTLY ONE effort. Your FULL operating contract — the end-of-turn signal fences, scratchpad rules, sub-agent rules, and the runtime release gate — lives in your SYSTEM PROMPT; follow it there (this is a runtime re-grounding, not a second copy). The human + the fray-ui app are the ORCHESTRATOR; you drive ONE effort and never scan the board, touch other efforts, or run `fray on` / load the orchestrator "fray" skill.\n' +
  'SCRATCHPAD: `' + scratch + '` — your compaction-proof working memory and your sub-agents\' shared blackboard. Put any survive-compaction to-do list / state there, and pass its PATH into every sub-agent prompt.\n' +
  'SIGNAL AT REST through your FINAL MESSAGE: BARE REST = an ordinary handoff (queues for the human); ```done = a checked completion card, only when the effort\'s real work is COMPLETE (code modified — even uncommitted — a plan/doc written, or a commissioned research/audit report finished) — a bug/issue investigation headed for a fix bare-rests instead so the human can read and act; ```awaiting = park ONLY a specific external-human (`human:`) or timestamp (`timer:`) gate, never CI/bots/releases/another session; ```question = the operator ask (a question IS the handback — no second fence). Automatable waits (CI/bot review/release/merge) stay ACTIVE via Monitor/background Bash, not awaiting.\n' +
  'SPAWN A SEPARATE THREAD: the `spawn_fray_thread` MCP tool (server `fray_spawn`) dispatches a NEW independent top-level fray thread (its own board card/session/scratchpad — NOT a sub-agent you collect); it returns a `[title](/thread/<slug>)` link — put it in your handoff so the human can open that thread in the drawer. See the "Spawning a separate fray thread" section of your system-prompt contract. Load the `fray:worker` skill for the full contract.';

const grounding =
  '⟦fray worker re-grounding (post-compaction)⟧ Context was just compacted. You are still the fray-ui worker for effort `' + thread + '` — re-read your scratchpad `' + scratch + '` NOW to recover your working state and to-do list before asserting anything, and re-read any code before claiming how it is structured. Signal at rest through your FINAL MESSAGE: bare rest queues an ordinary handoff; ```done queues a checked completion until Archive (completed work only — a pre-fix investigation bare-rests); ```awaiting parks only a human:/timer: gate; ```question is the explicit higher-priority operator ask. CI/bots/releases/merge progression stay active through Monitor/background Bash.';

// AUTH-GATED gh guidance — teach the worker to use `gh` well, but ONLY when signed in.
// Shell `gh auth status --active`: exit 0 = an active gh account is authenticated. The whole gate is
// wrapped so it can NEVER throw into SessionStart, and it fails CLOSED — no gh binary, not authed, a
// stall past the timeout, or any other error → we inject NOTHING (guidance is absent, not stale/wrong).
// It re-evaluates on every start/resume/clear/compact, so a later `gh auth login` starts injecting on
// the next turn boundary (and a `gh auth logout` stops it). See DECISIONS.md / plan §8.
const ghBlock =
  '⟦gh available⟧ You are signed into the `gh` CLI and in a GitHub repo. Use `gh` EAGERLY and well — it is the fastest path to issue/PR/CI/release context, and you should reach for it before guessing:\n' +
  '• READ freely: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`, `gh run list`/`gh run view`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping human text.\n' +
  '• SEARCH across the repo (and GitHub) with `gh search issues`/`gh search prs` when hunting related work, duplicates, or prior art.\n' +
  '• READ-ONLY BOUNDARY: never comment, label, assign, close, review, approve, or merge — no mutation of any kind — UNLESS the human explicitly asks in this session. Default to producing your findings/review as your final message, not as a GitHub post.\n' +
  '• TOON: pipe LARGE, FLAT `gh … --json` output through `toon` when `command -v toon` finds it. Skip it when unavailable, for tiny payloads, or for deeply-nested output — the savings are noise and nesting defeats tabularization.\n' +
  'Load the `fray:gh` skill for the full playbook (recipes + explicit project-local monitor selection + native Monitor/background-Bash CI/PR watches).';

let ghAuthed = false;
try {
  execFileSync('gh', ['auth', 'status', '--active'], { stdio: 'ignore', timeout: 4000 });
  ghAuthed = true;
} catch {
  /* no gh / not authed / stalled → fail CLOSED: leave ghAuthed false, inject nothing */
}

const parts = [core];
if (input.source === 'compact') parts.push(grounding);
if (ghAuthed) parts.push(ghBlock);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }),
);
process.exit(0);
