#!/usr/bin/env node
import { contextMessage, findProjectDir, readStdinJson } from './fray-hook-lib.mjs';

const input = readStdinJson();
const projectDir = findProjectDir(input.cwd);
const additionalContext = contextMessage(projectDir, 'user-prompt', input.session_id ?? input.sessionId);

if (!additionalContext) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext,
  },
}));
