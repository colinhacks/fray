#!/usr/bin/env node
import { findProjectDir, loadFray, readStdinJson, returnedUnreconciled } from './fray-hook-lib.mjs';

const input = readStdinJson();
const toolName = String(input.tool_name || input.toolName || input.tool || input.name || '');
if (toolName && toolName !== 'wait_agent') process.exit(0);

const projectDir = findProjectDir(input.cwd);
const fray = loadFray(projectDir);
if (!fray.enabled) process.exit(0);

const returned = returnedUnreconciled(projectDir);
const errorSummary = returned.errors.length ? ` Ledger errors: ${returned.errors.join('; ')}.` : '';

const summary = returned.rows
  .slice(0, 8)
  .map((row) => `${row.dispatch_id || row.agent_id || '?'} -> ${row.thread || '?'}`)
  .join('; ');
const suffix = returned.rows.length > 8 ? `; +${returned.rows.length - 8} more` : '';
const reason = [
  'Fray guard: do not call wait_agent in an active Fray repo.',
  returned.rows.length ? `Returned rows must be reconciled first: ${summary}${suffix}.` : 'Rely on sub-agent notifications, codex-reminder, and the dispatch ledger instead.',
  errorSummary,
].join(' ');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
  decision: 'block',
  reason,
}));
