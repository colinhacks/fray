#!/usr/bin/env node
// @ts-check
/**
 * Codex Fray dispatch preflight.
 *
 * Usage:
 *   printf '%s' "$PROMPT" | node .agents/plugins/fray-codex/scripts/codex-dispatch-preflight.mjs \
 *     --thread <slug> --agent-type <explorer|worker|default> --label "Plain English task"
 *   # Add --dry-run to emit without writing the ledger.
 *   # Add --json to emit {dispatch_id, thread, prompt, ledger_row}.
 *
 * It validates that the thread file exists, prefixes THREAD when needed,
 * adds a durable FRAY_DISPATCH_ID, appends the orchestration epilogue, records
 * the dispatch ledger, and emits the prompt to pass to Codex's sub-agent spawn tool.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { frayActive } from '../scripts/fray/config.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const EPILOGUE = `

---
[ORCHESTRATION EPILOGUE - appended by .agents/plugins/fray-codex/scripts/codex-dispatch-preflight.mjs]
End your final report with a compact \`## Fray state packet\` section before \`## Follow-ups\`. This is the orchestrator's handoff material and must be self-contained:
- \`thread:\` the Fray thread slug.
- \`dispatch:\` the FRAY_DISPATCH_ID.
- \`status:\` done / blocked / needs-decision / partial.
- \`changed:\` paths changed, or "none".
- \`verified:\` commands run and pass/fail/blocker.
- \`snags:\` exact blockers, conflicts, or risks.
- \`next:\` the single next action for the orchestrator.
End your final report with a \`## Follow-ups\` section so the orchestrator can chain the next steps:
1. Concrete follow-up work your findings or changes imply.
2. If you implemented something substantial, recommend a fresh adversarial self-review pass.
3. If you changed code or tests CI should exercise, recommend a push-to-main and CI-watch follow-up.
4. The single most important next step, and whether it needs the maintainer because it is a default/security/product/brand/API-config-env call.
Do not edit canonical Fray thread files (\`.fray/*.md\` or \`.fray/config.yml\`); return findings to the orchestrator, or write a sidecar under \`.fray/<thread>.findings/<id>.md\` only if durable output is needed.
If you committed: verify the tree compiles at your commit. If there are no follow-ups, write "Follow-ups: none."`;

/**
 * @param {string} name
 * @returns {string | null}
 */
function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const threadRaw = arg('--thread');
const agentType = arg('--agent-type') ?? '';
const label = arg('--label') ?? '';
const model = arg('--model') ?? '';
const reasoningEffort = arg('--reasoning-effort') ?? '';
const serviceTier = arg('--service-tier') ?? '';
const forkContext = arg('--fork-context');
const dispatchId = arg('--dispatch-id') ?? `fray-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');

if (!threadRaw) {
  console.error('codex-dispatch-preflight: --thread <slug> is required for thread-scoped dispatches');
  process.exit(2);
}

if (
  forkContext === 'true' &&
  ((agentType && agentType !== 'inherited') || model || reasoningEffort || serviceTier)
) {
  console.error(
    'codex-dispatch-preflight: fork-context=true inherits agent type/model/effort; omit --agent-type/--model/--reasoning-effort/--service-tier, or use --agent-type inherited only for ledger labeling.',
  );
  process.exit(2);
}

const thread = threadRaw.replace(/^\.fray\//, '').replace(/\.md$/, '');
const SESSION_ID = arg('--session-id') ?? process.env.CODEX_SESSION_ID ?? process.env.FRAY_SESSION_ID ?? undefined;

if (!frayActive(PROJECT_DIR, SESSION_ID)) {
  console.error('codex-dispatch-preflight: Fray is disabled for this session (per-session sentinel = off, or no .fray/).');
  process.exit(2);
}

const threadPath = join(PROJECT_DIR, '.fray', `${thread}.md`);
if (!existsSync(threadPath)) {
  console.error(
    `codex-dispatch-preflight: .fray/${thread}.md does not exist. Create the thread file before dispatching.`,
  );
  process.exit(1);
}

let prompt = '';
try {
  prompt = readFileSync(0, 'utf8');
} catch {
  prompt = '';
}

if (!prompt.trim()) {
  console.error('codex-dispatch-preflight: prompt on stdin is empty');
  process.exit(2);
}

const threadLines = [...prompt.matchAll(/^THREAD:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^\.fray\//, '').replace(/\.md$/, ''));
const mismatchedThread = threadLines.find((lineThread) => lineThread !== thread);
if (mismatchedThread) {
  console.error(
    `codex-dispatch-preflight: prompt contains THREAD: ${mismatchedThread}, but --thread is ${thread}. Refuse ambiguous dispatch metadata.`,
  );
  process.exit(2);
}
if (!threadLines.includes(thread)) {
  prompt = `THREAD: ${thread}\n\n${prompt}`;
}

const dispatchLines = [...prompt.matchAll(/^FRAY_DISPATCH_ID:\s*(.+)$/gm)].map((m) => m[1].trim());
const mismatchedDispatch = dispatchLines.find((lineDispatch) => lineDispatch !== dispatchId);
if (mismatchedDispatch) {
  console.error(
    `codex-dispatch-preflight: prompt contains FRAY_DISPATCH_ID: ${mismatchedDispatch}, but --dispatch-id is ${dispatchId}. Refuse ambiguous dispatch metadata.`,
  );
  process.exit(2);
}
if (!dispatchLines.includes(dispatchId)) {
  prompt = prompt.replace(/^(THREAD:\s*.+)$/m, `$1\nFRAY_DISPATCH_ID: ${dispatchId}`);
}

if (!prompt.includes('[ORCHESTRATION EPILOGUE')) {
  prompt += EPILOGUE;
}

const ledgerRow = {
  ts: new Date().toISOString(),
  tool: 'codex.spawn_agent',
  dispatch_id: dispatchId,
  agent_type: agentType,
  label,
  thread,
  model,
  reasoning_effort: reasoningEffort,
  service_tier: serviceTier,
  fork_context: forkContext,
  agent_id: '',
  nickname: '',
  reconciled: false,
};

if (!dryRun) {
  appendFileSync(
    join(PROJECT_DIR, '.fray', '.dispatch-ledger.jsonl'),
    `${JSON.stringify(ledgerRow)}\n`,
  );
}

if (json) {
  process.stdout.write(`${JSON.stringify({ dispatch_id: dispatchId, thread, prompt, ledger_row: ledgerRow }, null, 2)}\n`);
} else {
  process.stdout.write(prompt.endsWith('\n') ? prompt : `${prompt}\n`);
}
