#!/usr/bin/env node
// @ts-check
// PreToolUse hook on AskUserQuestion (fray-worker). A fray-ui worker runs under a dashboard, not a
// live chat: an interactive question prompt would hang the session invisibly (nobody is at the
// keyboard to click it). Deny with a redirect to the async pattern: ask in the FINAL MESSAGE via one
// or more ```question fenced blocks, then come to rest; answers arrive as the next user message.
// GATE: inert unless FRAY_UI_THREAD is set. FAIL OPEN on parse errors.
import { readFileSync } from 'node:fs';

const slug = process.env.FRAY_UI_THREAD;
if (!slug) process.exit(0);

try {
  JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // fail open — a broken hook must never halt work
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Interactive prompts freeze headless workers (no one is at the keyboard to answer). Ask in your FINAL MESSAGE instead, using one or more ```question fenced blocks — each self-contained (context + the specific question + lettered `- A. …` options + a Recommendation); the fray-ui Queue renders each as a card and the human replies "A"/"2"/prose in the composer. A ```question block IS the handback: write it and END YOUR TURN (do NOT also add a done/awaiting fence, and do NOT invoke this tool again) — the human answers from the queue.',
    },
  }),
);
process.exit(0);
