#!/usr/bin/env node
// @ts-check
// fray-notify-surface — Stop hook that surfaces the durable notification queue
// (`.fray/notify-queue.jsonl`, written via `fray-notify`) to the HUMAN the moment the
// orchestrator goes idle, so headline wins / decisions / blockers can't scroll out of
// reach or get buried under status churn.
//
// DESIGN (the point of this hook): the human reads the queue HERE, from a rich, sectioned
// markdown `systemMessage` — NOT from the orchestrator regurgitating it in chat. So:
//   - We do NOT block. `systemMessage` is a universal output field shown to the user even
//     when the hook exits 0 without `decision: block` (confirmed against the hooks docs), so
//     a non-blocking surface reaches the human WITHOUT forcing the orchestrator into another
//     turn — which is exactly what stops it from re-typing the items back at the human.
//   - We surface each open item EXACTLY ONCE: stamp `surfaced:true` after showing, so a new
//     notification interrupts idle one time, then persists quietly (status:open) until the
//     orchestrator dismisses it on the human's behalf.
//   - We emit NO model-facing `additionalContext` and NO "relay this" instruction. The
//     orchestrator's standing rule (in the fray skill) is: do NOT repeat the queue in chat;
//     just `fray-notify dismiss <id>` once the human addresses an item in conversation.
//   - Coexists safely with any other Stop hook (and a project-local copy): they share the
//     queue file's `surfaced` flag, so whichever fires first stamps it and the other no-ops.
//   - Any error → allow the stop (never wedge the session on a notify bug).
import { join } from 'node:path';
import { readQueue, writeQueue, renderMarkdown } from '../scripts/fray/notify-shared.mjs';

function allow() {
  process.exit(0);
}

try {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const queue = join(root, '.fray', 'notify-queue.jsonl');

  const items = readQueue(queue);
  const open = items.filter((i) => i.status === 'open');
  if (!open.length) allow();

  const unsurfaced = open.filter((i) => !i.surfaced);
  if (!unsurfaced.length) allow(); // already shown once; persists quietly until dismissed

  for (const i of items) if (i.status === 'open' && !i.surfaced) i.surfaced = true;
  writeQueue(queue, items);

  // Non-blocking surface: show the human the full open queue (sectioned markdown), let the
  // orchestrator rest. No additionalContext — nothing instructs the model to relay it.
  process.stdout.write(JSON.stringify({ systemMessage: renderMarkdown(open) }) + '\n');
  process.exit(0);
} catch {
  allow();
}
