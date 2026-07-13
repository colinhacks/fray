#!/usr/bin/env node
// @ts-check
/**
 * Update Codex Fray dispatch ledger metadata after spawn_agent returns.
 *
 * Usage:
 *   node .agents/plugins/fray-codex/scripts/codex-ledger.mjs attach-agent \
 *     --dispatch-id <id> --agent-id <spawned-agent-id> [--nickname "..."]
 *   node .agents/plugins/fray-codex/scripts/codex-ledger.mjs mark-reconciled \
 *     --dispatch-id <id> --thread-updated
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LEDGER = join(PROJECT_DIR, '.fray', '.dispatch-ledger.jsonl');

/**
 * @param {string} name
 * @returns {string | null}
 */
function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const command = process.argv[2] ?? '';

if (!['attach-agent', 'mark-reconciled'].includes(command)) {
  console.error('codex-ledger: expected command attach-agent or mark-reconciled');
  process.exit(2);
}

const dispatchId = arg('--dispatch-id');
const agentId = arg('--agent-id');
const nickname = arg('--nickname') ?? '';
const threadUpdated = process.argv.includes('--thread-updated');

if (!dispatchId) {
  console.error(`codex-ledger ${command}: --dispatch-id is required`);
  process.exit(2);
}

if (command === 'attach-agent' && !agentId) {
  console.error('codex-ledger attach-agent: --dispatch-id and --agent-id are required');
  process.exit(2);
}

if (command === 'mark-reconciled' && !threadUpdated) {
  console.error(
    'codex-ledger mark-reconciled: --thread-updated is required. Fold the return into the owning .fray/<slug>.md thread before marking reconciled.',
  );
  process.exit(2);
}

if (!existsSync(LEDGER)) {
  console.error('codex-ledger: .fray/.dispatch-ledger.jsonl does not exist');
  process.exit(1);
}

const lines = readFileSync(LEDGER, 'utf8').split('\n');
let updated = false;
const out = lines.map((line) => {
  if (!line.trim()) return line;
  try {
    const row = JSON.parse(line);
    if (row.dispatch_id === dispatchId) {
      updated = true;
      if (command === 'attach-agent') return JSON.stringify({ ...row, agent_id: agentId, nickname });
      return JSON.stringify({ ...row, reconciled: true, reconciled_ts: new Date().toISOString() });
    }
  } catch {
    return line;
  }
  return line;
});

if (!updated) {
  console.error(`codex-ledger: no dispatch_id found: ${dispatchId}`);
  process.exit(1);
}

writeFileSync(LEDGER, out.join('\n'));
if (command === 'attach-agent') console.log(`attached agent ${agentId} to ${dispatchId}`);
else console.log(`marked reconciled ${dispatchId}`);
