#!/usr/bin/env node
// @ts-check
// fray notify — a DURABLE, human-facing notification queue for the orchestrator.
//
// The problem it fixes: in a long autonomous session, the things the human most needs to
// see — a headline WIN that landed, a DECISION that's genuinely theirs, a BLOCKER — get
// buried under per-turn status churn and scroll out of reach. This queue is written the
// instant something noteworthy happens, persists until DISMISSED, and is re-surfaced when
// the orchestrator goes idle by the companion Stop hook (`hooks/fray-notify-surface.mjs`).
//
// The hook SURFACES each item to the human directly (rich, sectioned markdown via
// `systemMessage`). The orchestrator does NOT relay or regurgitate the queue in chat — the
// human already sees it. The orchestrator's only job is to DISMISS an item once the human
// has addressed it in conversation (the human has no terminal): `fray-notify dismiss <id>`.
//
// Each item carries a short `title` (the heading the human scans) and a prose `body` (the
// context they read to decide) — author BOTH per the prose skill: terse, factual, enough to
// make the call without opening a file. Storage: the PROJECT's `.fray/notify-queue.jsonl`
// (resolved from CLAUDE_PROJECT_DIR, or cwd when run by hand), one JSON object per line:
//   {id, ts, kind, title, body, status: "open"|"dismissed", surfaced: bool}
// kind ∈ WIN | DECISION | BLOCKER | FYI. `surfaced` is stamped by the Stop hook once it has
// shown the item, so a new item interrupts idle exactly once, then persists quietly.
//
// Usage (bare command on PATH via bin/fray-notify while the plugin is enabled):
//   fray-notify add <WIN|DECISION|BLOCKER|FYI> "<title>" "<body>"   # body optional; prints the id
//   fray-notify list [--all]                                        # rendered markdown (open, or all)
//   fray-notify dismiss <id>[ <id> ...] | --all
// Robust: a malformed queue line is skipped, never fatal.
import { join } from 'node:path';
import { KINDS, readQueue, writeQueue, renderMarkdown } from './notify-shared.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const QUEUE = join(PROJECT_DIR, '.fray', 'notify-queue.jsonl');

function newId(items) {
  const n = items.reduce((m, i) => Math.max(m, Number(String(i.id).replace(/\D/g, '')) || 0), 0);
  return 'n' + (n + 1);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const items = readQueue(QUEUE);

  if (cmd === 'add') {
    const kind = (rest[0] || '').toUpperCase();
    const title = (rest[1] || '').trim();
    const body = rest.slice(2).join(' ').trim();
    if (!KINDS.has(kind) || !title) {
      console.error('usage: fray-notify add <WIN|DECISION|BLOCKER|FYI> "<title>" "<body>"');
      process.exit(1);
    }
    const id = newId(items);
    items.push({ id, ts: new Date().toISOString(), kind, title, body, status: 'open', surfaced: false });
    writeQueue(QUEUE, items);
    console.log(id);
  } else if (cmd === 'list') {
    const all = rest.includes('--all');
    const rows = items.filter((i) => all || i.status === 'open');
    console.log(rows.length ? renderMarkdown(rows) : '(no notifications)');
  } else if (cmd === 'dismiss') {
    const all = rest.includes('--all');
    const ids = new Set(rest);
    let n = 0;
    for (const i of items) {
      if (i.status === 'open' && (all || ids.has(i.id))) {
        i.status = 'dismissed';
        n++;
      }
    }
    writeQueue(QUEUE, items);
    console.log(`dismissed ${n}`);
  } else {
    console.error('usage: fray-notify <add|list|dismiss> …');
    process.exit(1);
  }
}

// Run the CLI. This module is the command entry point (invoked directly as `node notify.mjs`
// or via the bin shim's dynamic import); helpers live in notify-shared.mjs, so nothing imports
// this file for its functions — running unconditionally is correct.
main();
