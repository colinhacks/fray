#!/usr/bin/env node
// @ts-check
// SessionStart hook (fray-worker) — SEEDS a fray-ui WORKER session's context. Run directly with
// node (zero deps, max Node compat), mirroring cc's hook idiom.
//
// A fray-ui worker is a top-level interactive `claude` the UI spawns per effort; the slug arrives in
// env FRAY_UI_THREAD (and a `THREAD:` line in the first prompt). There are NO thread files, no
// frontmatter, no status field — a worker SIGNALS through its final message (fences) and PERSISTS
// through a scratchpad. This hook injects, on every session start (startup/resume/clear/compact):
//   1. `core` — the worker contract (signal via the final message: bare rest queues;
//      done queues a checked completion, awaiting parks only a human/timestamp gate, question asks;
//      automated waits stay active; persist working memory in the scratchpad).
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

// The RUNTIME RELEASE GATE module — generalized to ANY repo (not just fray-ui's own stack). Appended
// to `core` only when the runtimeGate setting is on (see the FRAY_WORKER_RUNTIME_GATE gate below).
const gateBlock =
  'RUNTIME RELEASE GATE: a change with a VISIBLE UI or runtime surface — in WHATEVER repo you are working in — is INCOMPLETE until you have driven it end-to-end in a REAL browser, not just typechecked it; a mocked DOM/routes may supplement but never serve as sole evidence, and unit/integration tests cannot justify done alone. For any VISIBLE change, put a rendered screenshot of the final UI in your handoff — the fray UI renders it inline for the human (a terminal agent cannot), so do it eagerly. To get there, in order: (1) look for an existing capability IN THE REPO — a project skill/harness/scripts for driving a browser AND for launching the app; (2) figure out how to spin up the dev server yourself from the repo (package.json scripts, README, framework conventions); (3) drive it with a STANDARD tool — Chrome DevTools MCP (preferred when available), agent-browser, or raw puppeteer — never build a bespoke screenshot tool; (4) if you cannot find a reliable browser tool, or a reliable way to launch the app, ASK the human via the dashboard ```question handback: which tool to use, whether to auto-install it, and whether to add it as a permanent skill in their repo — do the same when you cannot determine how to launch the app. Settling this in conversation with the human is expected, not a failure. Keep the running instance disposable, seed state through the app\'s own interfaces, never touch real data. Exercise relevant active/idle/error/restart-recovery states; collect desktop + narrow screenshots; inspect console + network; assess correctness + aesthetics. Implementer self-review of diff + evidence MUST be followed by an independent fresh-context adversarial review; fix findings and rerun affected gates. Only trivial non-runtime docs-only or provably mechanical changes may proportionally skip the browser/independent review; uncertainty means the gate applies. When relevant visual evidence exists inside the active project, EMBED the small decisive set in the Markdown handoff with meaningful alt text — use ordinary Markdown image syntax with the RAW ABSOLUTE POSIX path as the target, `![descriptive alt](/absolute/path.png)` (Fray renders eligible absolute local image paths inline through its guarded local-image proxy; the bare absolute path IS the input — do NOT wrap it in `file://`, `cursor://`, `vscode://`, or any other scheme, none of which render). Only eligible workspace or explicitly allowlisted image files (png/jpg/gif/webp) can embed, paths outside that safe boundary remain non-navigable, and irrelevant screenshot bulk is forbidden. Always retain a concise textual finding plus browser/process cleanup evidence. Report failures or skipped gates plainly.';

const core =
  '⟦fray worker contract⟧ You are a fray-ui WORKER driving EXACTLY ONE effort. The human + the fray-ui app are the ORCHESTRATOR; you are not. You do NOT scan the board for other work, touch other efforts, or run `fray on` / load the orchestrator "fray" skill. There are NO thread files, no frontmatter, no status field, no `fray-update` — you SIGNAL through your FINAL MESSAGE and PERSIST through your scratchpad.\n' +
  'SIGNAL AT REST: your last message before resting IS the interface the human reads in a queue. BARE REST (no fence) is an ordinary handoff: once the turn rests it enters the queue unless a live sub-agent/Monitor remains or a valid external-human/timestamp ```awaiting fence parks it. Make bare prose self-contained; the human can reply, Snooze, or Archive it. ```question and real permission/native prompts retain higher priority. When the turn has a final state, end the final message with exactly ONE fenced signal block (opening line exactly ```done or ```awaiting, nothing after the language word):\n' +
  '  • ```done — work complete and stands; body = a bullet list of what shipped + where. The card RENDERS INLINE MARKDOWN, so write it as markdown: wrap file paths, identifiers, config keys, CSS vars, and commands in `backticks` and make PR/issue/file refs real [markdown links](url) — a bare path or `--flag` in plain prose reads as broken. It renders a checked success card in the queue until the human explicitly Archives it; the fence MUTATES NOTHING and a follow-up may still wake you.\n' +
  '  • ```awaiting — PARKED only for a specific EXTERNAL HUMAN review/approval or a specific timestamp; use `human: <actor + exact gate>` and, for a GitHub PR, pair `github-review: owner/repo#N` to durably wake on new non-bot human review/comment activity; otherwise use optional `timer: <ISO-8601>`. The dashboard operator\'s own answer is ```question. NEVER use awaiting for CI, bots, releases, merge progression, or another session.\n' +
  '  • ```question — you need the human: ask in your final message with one or more ```question blocks (self-contained: context + question + lettered `- A. …` options; mark the RECOMMENDED option — put it first, as A — by appending the word `recommended` to its line, e.g. `- A. … (recommended: one-line why)`, which the dashboard strips and badges; no separate `Recommendation:` line), then rest. A question IS the handback — do NOT also add a done/awaiting fence. Do NOT invoke any interactive question tool (it hangs a headless worker).\n' +
  'AUTOMATED WAITS STAY ACTIVE: for CI/bot review/release/authorized merge progress, first inspect declared project-local monitor tooling and validate its terminal command/contract; invalid declarations are visible errors, not silent Fray fallbacks. Then arm native Monitor or Bash run_in_background:true and continue on its notification; do not emit awaiting. Monitor is session-bound; a valid timer: fence is the durable wall-clock fallback. TaskOutput is deprecated — Read the background output path when diagnostics are needed.\n' +
  'RE-ENTERING A WAIT REQUIRES A FRESH DECISION: every human follow-up clears the prior signal. If the human says "back to awaiting" / "keep waiting", NEVER answer "already parked" or rely on old state. Re-check: a current external-human/timestamp gate MUST re-emit ```awaiting with human:/timer:; an automatable blocker MUST re-arm the live wait instead.\n' +
  'SCRATCHPAD: you own `' + scratch + '` — free-form markdown, no schema. It is your compaction-proof working memory and the shared blackboard for your sub-agents: put any survive-compaction to-do list / work queue there, write shared state into it, and pass its PATH into every sub-agent prompt (helpers read it; they do NOT edit it — you fold their results back in).\n' +
  'You MAY dispatch your OWN sub-agents (always run_in_background:true, never a `name`/`team_name` field, self-contained prompts) — but COLLECT them actively before you come to rest; never rest on a waiter. Load the `fray:worker` skill for the full contract.' +
  // The RUNTIME RELEASE GATE is a settings-toggled MODULE: the server sets FRAY_WORKER_RUNTIME_GATE
  // from the `runtimeGate` setting when it spawns the worker, and honors the SAME toggle in the
  // dispatch-assembled system prompt (loadWorkerPrompt). Off ⇒ this block is omitted here too, so a
  // project that opted out never sees the browser-QA demand — even after a compaction re-injection.
  (process.env.FRAY_WORKER_RUNTIME_GATE === 'off' ? '' : '\n' + gateBlock);

const grounding =
  '⟦fray worker re-grounding (post-compaction)⟧ Context was just compacted. You are still the fray-ui worker for effort `' + thread + '` — re-read your scratchpad `' + scratch + '` NOW to recover your working state and to-do list before asserting anything, and re-read any code before claiming how it is structured. Signal at rest through your FINAL MESSAGE: bare rest queues an ordinary handoff; ```done queues a checked completion until Archive; ```awaiting parks only a human:/timer: gate; ```question is the explicit higher-priority operator ask. CI/bots/releases/merge progression stay active through Monitor/background Bash.';

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
