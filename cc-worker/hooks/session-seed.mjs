#!/usr/bin/env node
// @ts-check
// SessionStart hook (fray-worker) — SEEDS a fray-ui WORKER session's context. Run directly with
// node (zero deps, max Node compat), mirroring cc's hook idiom.
//
// A fray-ui worker is a top-level interactive `claude` the UI spawns per effort; the slug arrives in
// env FRAY_UI_THREAD (and a `THREAD:` line in the first prompt). There are NO thread files, no
// frontmatter, no status field — a worker SIGNALS through its final message (fences) and PERSISTS
// through a scratchpad. This hook injects, on every session start (startup/resume/clear/compact):
//   1. `core` — the worker contract (signal via the final message: bare rest = "your move";
//      the done/awaiting/question fences excuse you or ask; persist working memory in the scratchpad).
//   2. the SCRATCHPAD PATH — `.fray/scratch/<session_id>.md`, the worker's compaction-proof memory.
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
// The session id also names the worker's scratchpad (`.fray/scratch/<session_id>.md`).
let sid = null;
try {
  sid = currentSessionId(input.session_id);
  if (sid) setSessionOverride(dir, sid, 'off');
} catch {
  /* best-effort — a failed sentinel write just leaves cc at its dormant default */
}
const scratch = sid ? '.fray/scratch/' + sid + '.md' : '.fray/scratch/<session-id>.md';

const core =
  '⟦fray worker contract⟧ You are a fray-ui WORKER driving EXACTLY ONE effort. The human + the fray-ui app are the ORCHESTRATOR; you are not. You do NOT scan the board for other work, touch other efforts, or run `fray on` / load the orchestrator "fray" skill. There are NO thread files, no frontmatter, no status field, no `fray-update` — you SIGNAL through your FINAL MESSAGE and PERSIST through your scratchpad.\n' +
  'SIGNAL AT REST: your last message before resting IS the interface the human reads in a queue. BARE REST (no fence) = "your move" — it puts you in their Needs-you queue; correct when you have answered, finished a conversational exchange, or delivered something needing their reaction. To EXCUSE yourself, end the final message with exactly ONE fenced signal block (opening line exactly ```done or ```awaiting, nothing after the language word):\n' +
  '  • ```done — work complete and stands; body = 1–4 lines of what shipped + where (PR links, paths). It renders a success card; it MUTATES NOTHING and a follow-up may still wake you.\n' +
  '  • ```awaiting — waiting on a MACHINE (CI/PR check/timer/another session); body may lead with hint lines `kind: value`, kind ∈ pr|ci|timer|session, then prose. NEVER for a human wait.\n' +
  '  • ```question — you need the human: ask in your final message with one or more ```question blocks (self-contained: context + question + lettered `- A. …` options + a Recommendation), then rest. A question IS the handback — do NOT also add a done/awaiting fence. Do NOT invoke any interactive question tool (it hangs a headless worker).\n' +
  'SCRATCHPAD: you own `' + scratch + '` — free-form markdown, no schema. It is your compaction-proof working memory and the shared blackboard for your sub-agents: put any survive-compaction to-do list / work queue there, write shared state into it, and pass its PATH into every sub-agent prompt (helpers read it; they do NOT edit it — you fold their results back in).\n' +
  'You MAY dispatch your OWN sub-agents (always run_in_background:true, never a `name`/`team_name` field, self-contained prompts) — but COLLECT them actively before you come to rest; never rest on a waiter. Load the `fray:worker` skill for the full contract.\n' +
  'VERIFY + REPORT FAITHFULLY: exercise what you changed and report what actually happened — if a test fails, say so; if you skipped a step, say so; never launder an unverified claim into a ```done fence.';

const grounding =
  '⟦fray worker re-grounding (post-compaction)⟧ Context was just compacted. You are still the fray-ui worker for effort `' + thread + '` — re-read your scratchpad `' + scratch + '` NOW to recover your working state and to-do list before asserting anything, and re-read any code before claiming how it is structured. Signal at rest through your FINAL MESSAGE: bare rest = "your move"; ```done / ```awaiting excuse you; ```question asks the human.';

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
  '• TOON: pipe LARGE, FLAT `gh … --json` output through toon to cut tokens ~30–40%. toon is NOT on PATH — use the absolute path:\n' +
  '    gh issue list -R OWNER/REPO --json number,title,url --limit 50 | "$HOME/.nvm/versions/node/v24.14.0/bin/toon"\n' +
  '  (or `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"` once at the start of a shell). Skip toon for tiny or deeply-nested payloads — the savings are noise and nesting defeats tabularization.\n' +
  'Load the `fray:gh` skill for the full playbook (recipes + the CI/PR watch that ties into your ```awaiting fence).';

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
