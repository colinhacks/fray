#!/usr/bin/env node
import { contextMessage, findProjectDir, readStdinJson } from './fray-hook-lib.mjs';

const input = readStdinJson();
const projectDir = findProjectDir(input.cwd);
const additionalContext = contextMessage(projectDir, input.source || input.hook_event_name || 'session');

if (!additionalContext) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext,
  },
}));
