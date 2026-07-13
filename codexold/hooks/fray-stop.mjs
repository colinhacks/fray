#!/usr/bin/env node
import { findProjectDir, loadFray, readStdinJson, returnedUnreconciled } from './fray-hook-lib.mjs';

const input = readStdinJson();
const projectDir = findProjectDir(input.cwd);
const fray = loadFray(projectDir, input.session_id ?? input.sessionId);
if (!fray.enabled) process.exit(0);

// Avoid recursive stop-hook loops. The returned-state ledger still makes the
// missing reconciliation visible to the next turn/session.
if (input.stop_hook_active === true || input.stopHookActive === true) process.exit(0);

const returned = returnedUnreconciled(projectDir);
if (returned.errors.length) process.exit(0);
if (!returned.rows.length) process.exit(0);

const summary = returned.rows
  .slice(0, 8)
  .map((row) => `${row.dispatch_id || row.agent_id || '?'} -> ${row.thread || '?'}${row.packet_present === false ? ' (missing packet)' : ''}`)
  .join('; ');
const suffix = returned.rows.length > 8 ? `; +${returned.rows.length - 8} more` : '';
const reason = [
  'Fray guard: returned sub-agents are not reconciled yet.',
  `Reconcile ledger rows first: ${summary}${suffix}.`,
  'Fold each return into its owning .fray thread, then run `node .agents/plugins/fray-codex/scripts/codex-ledger.mjs mark-reconciled --dispatch-id <id> --thread-updated`.',
].join(' ');

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason,
}));
