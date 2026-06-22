#!/usr/bin/env node
import {
  extractFrayPacket,
  findProjectDir,
  getAgentId,
  getAssistantMessage,
  loadFray,
  markReturnedByAgentId,
  readStdinJson,
} from './fray-hook-lib.mjs';

const input = readStdinJson();
const projectDir = findProjectDir(input.cwd);
const fray = loadFray(projectDir, input.session_id ?? input.sessionId);
if (!fray.enabled) process.exit(0);

const msg = getAssistantMessage(input);
const agentId = getAgentId(input);
const stopHookActive = input.stop_hook_active === true || input.stopHookActive === true;
const packet = extractFrayPacket(msg);
const mark = markReturnedByAgentId(projectDir, agentId, msg);

if (stopHookActive) process.exit(0);
if (packet.present) process.exit(0);

const reason = [
  'Before stopping, produce a compact `## Fray state packet` for the orchestrator.',
  'Include: thread, dispatch, status, changed paths, verification, snags/blockers, and the single next action.',
  'Then include `## Follow-ups`.',
  mark.errors.length ? `Ledger note: ${mark.errors.join('; ')}` : '',
].filter(Boolean).join(' ');

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason,
}));
