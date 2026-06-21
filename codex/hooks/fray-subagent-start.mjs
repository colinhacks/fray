#!/usr/bin/env node
import { findProjectDir, loadFray, readStdinJson } from './fray-hook-lib.mjs';

const input = readStdinJson();
const projectDir = findProjectDir(input.cwd);
const fray = loadFray(projectDir);
if (!fray.enabled) process.exit(0);

const additionalContext = [
  'FRAY SUBAGENT CONTEXT: this repo has active Fray orchestration.',
  'Do not edit `.fray/*.md` or `.fray/config.yml`; return findings to the orchestrator.',
  'If durable output is needed, write only a sidecar under `.fray/<thread>.findings/<id>.md`.',
  'Your final response must include a compact `## Fray state packet` section with exactly these fields: thread, dispatch, status, changed, verified, snags, next.',
  'Use the THREAD and FRAY_DISPATCH_ID markers from your prompt when present; if absent, write "unknown" rather than inventing them.',
  'Then include `## Follow-ups`.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext,
  },
}));
