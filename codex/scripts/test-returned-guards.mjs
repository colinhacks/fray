#!/usr/bin/env node
// @ts-check
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(ROOT, 'hooks');
const SCRIPTS = join(ROOT, 'scripts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runHook(name, input) {
  const result = spawnSync(process.execPath, [join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function runScript(name, args = []) {
  const result = spawnSync(process.execPath, [join(SCRIPTS, name), ...args], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function readLedger(projectDir) {
  return readFileSync(join(projectDir, '.fray', '.dispatch-ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeLedger(projectDir, rows) {
  writeFileSync(join(projectDir, '.fray', '.dispatch-ledger.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

const projectDir = mkdtempSync(join(tmpdir(), 'fray-returned-guards-'));
try {
  mkdirSync(join(projectDir, '.fray'));
  writeFileSync(join(projectDir, '.fray', 'config.yml'), 'enabled: true\nautonomous_mode: off\n');
  writeFileSync(
    join(projectDir, '.fray', 'fray.md'),
    [
      '---',
      'title: "Fray test"',
      'status: active',
      '---',
      '## Goal',
      'test',
      '## Status',
      'test',
      '## Decisions',
      'none',
      '## Open questions',
      'none',
      '## Steps / follow-up queue',
      '- [ ] test',
      '## Next step',
      'test',
      '',
    ].join('\n'),
  );
  writeLedger(projectDir, [
    { tool: 'codex.spawn_agent', dispatch_id: 'd-valid', thread: 'fray', agent_id: 'agent-valid', reconciled: false },
    { tool: 'codex.spawn_agent', dispatch_id: 'd-missing', thread: 'fray', agent_id: 'agent-missing', reconciled: false },
    { tool: 'codex.spawn_agent', dispatch_id: 'd-active', thread: 'fray', agent_id: 'agent-active', reconciled: false },
    { tool: 'codex.spawn_agent', dispatch_id: 'd-same-old', thread: 'fray', agent_id: 'agent-same', reconciled: false, ts: '2026-01-01T00:00:00.000Z' },
    { tool: 'codex.spawn_agent', dispatch_id: 'd-same-new', thread: 'fray', agent_id: 'agent-same', reconciled: false, ts: '2026-01-01T00:00:01.000Z' },
    { tool: 'codex.spawn_agent', dispatch_id: 'd-exact-old', thread: 'fray', agent_id: 'agent-exact', reconciled: false, ts: '2026-01-01T00:00:00.000Z' },
    { tool: 'codex.spawn_agent', dispatch_id: 'd-exact-new', thread: 'fray', agent_id: 'agent-exact', reconciled: false, ts: '2026-01-01T00:00:01.000Z' },
  ]);

  const valid = runHook('fray-subagent-stop.mjs', {
    cwd: projectDir,
    agent_id: 'agent-valid',
    last_assistant_message: '## Fray state packet\nthread: fray\ndispatch: d-valid\nstatus: done\nchanged: none\nverified: dry-run\nsnags: none\nnext: reconcile\n\n## Follow-ups\nFollow-ups: none.',
  });
  assert(valid.status === 0, 'valid packet hook should exit 0');
  assert(valid.stdout.trim() === '', 'valid packet hook should not block');
  let rows = readLedger(projectDir);
  assert(rows.find((row) => row.dispatch_id === 'd-valid')?.returned === true, 'valid packet row should be returned');
  assert(rows.find((row) => row.dispatch_id === 'd-valid')?.packet_present === true, 'valid packet row should record packet_present true');
  assert(rows.find((row) => row.dispatch_id === 'd-valid')?.packet_hash, 'valid packet row should record packet_hash');

  const missing = runHook('fray-subagent-stop.mjs', {
    cwd: projectDir,
    agent_id: 'agent-missing',
    last_assistant_message: 'No packet here.',
  });
  assert(missing.status === 0, 'missing packet hook command should exit 0 after emitting block JSON');
  const missingJson = JSON.parse(missing.stdout);
  assert(missingJson.decision === 'block', 'missing packet hook should block');
  assert(!missingJson.hookSpecificOutput, 'SubagentStop block output should use Codex top-level shape only');
  rows = readLedger(projectDir);
  assert(rows.find((row) => row.dispatch_id === 'd-missing')?.returned === true, 'missing packet row should be returned');
  assert(rows.find((row) => row.dispatch_id === 'd-missing')?.packet_present === false, 'missing packet row should record packet_present false');

  const active = runHook('fray-subagent-stop.mjs', {
    cwd: projectDir,
    agent_id: 'agent-active',
    stop_hook_active: true,
    last_assistant_message: '## Fray state packet\nthread: fray\ndispatch: d-active\nstatus: done\nchanged: none\nverified: second-stop\nsnags: none\nnext: reconcile\n\n## Follow-ups\nFollow-ups: none.',
  });
  assert(active.status === 0, 'stop_hook_active hook should exit 0');
  assert(active.stdout.trim() === '', 'stop_hook_active hook should not continue-loop');
  rows = readLedger(projectDir);
  assert(rows.find((row) => row.dispatch_id === 'd-active')?.returned === true, 'stop_hook_active row should be returned');
  assert(rows.find((row) => row.dispatch_id === 'd-active')?.packet_present === true, 'stop_hook_active with valid packet should record packet_present true');

  const same = runHook('fray-subagent-stop.mjs', {
    cwd: projectDir,
    agent_id: 'agent-same',
    last_assistant_message: 'No packet for a same-agent multi-dispatch return.',
  });
  assert(JSON.parse(same.stdout).decision === 'block', 'same-agent missing packet should block for packet recovery');
  rows = readLedger(projectDir);
  assert(rows.find((row) => row.dispatch_id === 'd-same-new')?.returned === true, 'missing packet should mark newest same-agent row');
  assert(rows.find((row) => row.dispatch_id === 'd-same-old')?.returned !== true, 'missing packet should not mark older same-agent row');
  assert(rows.find((row) => row.dispatch_id === 'd-same-new')?.return_ambiguity, 'missing packet same-agent targeting should surface ambiguity');

  const exact = runHook('fray-subagent-stop.mjs', {
    cwd: projectDir,
    agent_id: 'agent-exact',
    last_assistant_message: '## Fray state packet\nthread: fray\nFRAY_DISPATCH_ID: d-exact-old\nstatus: done\nchanged: none\nverified: exact\nsnags: none\nnext: reconcile\n\n## Follow-ups\nFollow-ups: none.',
  });
  assert(exact.status === 0, 'exact packet hook should exit 0');
  assert(exact.stdout.trim() === '', 'exact packet hook should not block');
  rows = readLedger(projectDir);
  assert(rows.find((row) => row.dispatch_id === 'd-exact-old')?.returned === true, 'packet dispatch id should target exact old row');
  assert(rows.find((row) => row.dispatch_id === 'd-exact-new')?.returned !== true, 'packet dispatch id should not mark newer same-agent row');

  const stop = runHook('fray-stop.mjs', { cwd: projectDir });
  assert(stop.status === 0, 'stop hook command should exit 0 after emitting block JSON');
  const stopJson = JSON.parse(stop.stdout);
  assert(stopJson.decision === 'block', 'stop hook should block returned unreconciled rows');
  assert(!stopJson.hookSpecificOutput, 'Stop block output should use Codex top-level shape only');

  const waitGuard = runHook('fray-pre-tool-use.mjs', { cwd: projectDir, tool_name: 'wait_agent' });
  assert(waitGuard.status === 0, 'wait guard command should exit 0 after emitting block JSON');
  assert(JSON.parse(waitGuard.stdout).decision === 'block', 'wait guard should block wait_agent when returned rows exist');

  for (const row of rows) row.reconciled = true;
  writeLedger(projectDir, rows);
  const waitGuardClean = runHook('fray-pre-tool-use.mjs', { cwd: projectDir, tool_name: 'wait_agent' });
  assert(waitGuardClean.status === 0, 'wait guard command should exit 0 after emitting block JSON without returned rows');
  assert(JSON.parse(waitGuardClean.stdout).decision === 'block', 'wait guard should block wait_agent whenever Fray is enabled');

  const reminder = runScript('codex-reminder.mjs', ['--project-dir', projectDir, '--json', '--strict']);
  assert(reminder.status === 0, 'strict reminder should pass after returned rows are reconciled');
  const reminderJson = JSON.parse(reminder.stdout);
  assert(reminderJson.returned_unreconciled_dispatches.length === 0, 'reminder should report no returned unreconciled rows after reconciliation');

  const otherTool = runHook('fray-pre-tool-use.mjs', { cwd: projectDir, tool_name: 'exec_command' });
  assert(otherTool.status === 0, 'non-wait tool guard should exit 0');
  assert(otherTool.stdout.trim() === '', 'non-wait tool guard should not block');

  const preCompact = runHook('fray-pre-compact.mjs', { cwd: projectDir });
  const preCompactJson = JSON.parse(preCompact.stdout);
  assert(preCompactJson.continue === true, 'pre-compact should emit common continue field');
  assert(!preCompactJson.hookSpecificOutput, 'pre-compact should not emit hookSpecificOutput additionalContext');

  console.log('returned guard dry-runs OK');
} finally {
  rmSync(projectDir, { recursive: true, force: true });
}
