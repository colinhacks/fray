#!/usr/bin/env node
// @ts-check
// fray-notify-surface — Stop hook that surfaces the durable notification queue
// (`.fray/notify-queue.jsonl`, written via `fray-notify`) to the HUMAN the moment the
// orchestrator goes idle, so headline wins / decisions / blockers can't scroll out of
// reach or get buried under status churn.
//
// Contract (mirrors fray-stop-reminder, the known-good channel):
//   - User-facing text rides `systemMessage` (a calm line, not a red "Stop hook error:" wall).
//   - Model-facing text rides `hookSpecificOutput.additionalContext`.
//   - We BLOCK (decision:block) ONLY when there are OPEN items not yet surfaced, so a new
//     notification interrupts idle exactly ONCE to guarantee the human sees it; we then stamp
//     surfaced:true so it never loops. Items persist (status:open) until DISMISSED.
//   - DISMISSAL IS THE ORCHESTRATOR'S JOB, not the human's: the human talks to the
//     orchestrator, not a terminal. When the human addresses an item in conversation, the
//     orchestrator runs `fray-notify dismiss <id>` on their behalf once it's properly handled.
//   - Coexists safely with any other Stop hook (and a project-local copy): they share the
//     queue file's `surfaced` flag, so whichever fires first stamps it and the other no-ops.
//   - Any error → allow the stop (never wedge the session on a notify bug).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function allow() {
  process.exit(0);
}

try {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const queue = join(root, '.fray', 'notify-queue.jsonl');
  if (!existsSync(queue)) allow();

  const items = readFileSync(queue, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const open = items.filter((i) => i.status === 'open');
  if (!open.length) allow();

  const unsurfaced = open.filter((i) => !i.surfaced);
  if (!unsurfaced.length) allow(); // already shown once; persists quietly until dismissed

  for (const i of items) if (i.status === 'open' && !i.surfaced) i.surfaced = true;
  writeFileSync(queue, items.map((i) => JSON.stringify(i)).join('\n') + '\n');

  const line = (i) => `• [${i.kind}] ${i.text}  (id ${i.id})`;
  const userMsg =
    `📌 ${open.length} pending notification${open.length > 1 ? 's' : ''} for you ` +
    `(I'll dismiss each once you've addressed it):\n` +
    open.map(line).join('\n');
  const modelMsg =
    `Durable notification queue has ${unsurfaced.length} NEW item(s). Relay them to the human ` +
    `verbatim in your next message (they're surfaced via systemMessage already), then you may rest. ` +
    `DISMISSAL IS YOUR JOB: the human has no terminal — when they address an item in conversation, ` +
    `run \`fray-notify dismiss <id>\` on their behalf once it's properly handled. Open items:\n` +
    open.map(line).join('\n');

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: modelMsg },
      systemMessage: userMsg,
    }) + '\n',
  );
  process.exit(0);
} catch {
  allow();
}
