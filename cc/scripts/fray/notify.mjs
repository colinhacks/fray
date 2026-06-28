#!/usr/bin/env node
// @ts-check
// fray notify — a DURABLE, human-facing notification queue for the orchestrator.
//
// The problem it fixes: in a long autonomous session, the things the human most needs to
// see — a headline WIN that landed, a DECISION that's genuinely theirs, a BLOCKER — get
// buried under per-turn status churn and scroll out of reach. This queue is written the
// instant something noteworthy happens, persists until DISMISSED, and is re-surfaced every
// time the orchestrator goes idle by the companion Stop hook (`hooks/fray-notify-surface.mjs`).
//
// DISMISSAL is the ORCHESTRATOR's job, not the human's — the human talks to the orchestrator,
// not a terminal. When the human addresses an item in conversation, the orchestrator runs
// `fray-notify dismiss <id>` on their behalf once it's properly handled.
//
// Storage: the PROJECT's `.fray/notify-queue.jsonl` (resolved from CLAUDE_PROJECT_DIR, or
// cwd when run by hand), one JSON object per line:
//   {id, ts, kind, text, status: "open"|"dismissed", surfaced: bool}
// kind ∈ WIN | DECISION | BLOCKER | FYI. `surfaced` is stamped by the Stop hook once it has
// shown the item, so a new item interrupts idle exactly ONCE, then persists quietly.
//
// Usage (bare command on PATH via bin/fray-notify while the plugin is enabled):
//   fray-notify add <WIN|DECISION|BLOCKER|FYI> "text"   # → prints the new id
//   fray-notify list [--all]                            # open items (or all)
//   fray-notify dismiss <id>[ <id> ...] | --all
// Robust: a malformed queue line is skipped, never fatal.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const QUEUE = join(PROJECT_DIR, '.fray', 'notify-queue.jsonl');
const KINDS = new Set(['WIN', 'DECISION', 'BLOCKER', 'FYI']);

function read() {
  if (!existsSync(QUEUE)) return [];
  return readFileSync(QUEUE, 'utf8')
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
}
function write(items) {
  mkdirSync(dirname(QUEUE), { recursive: true });
  writeFileSync(QUEUE, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
}
function newId(items) {
  const n = items.reduce((m, i) => Math.max(m, Number(String(i.id).replace(/\D/g, '')) || 0), 0);
  return 'n' + (n + 1);
}

const [cmd, ...rest] = process.argv.slice(2);
const items = read();

if (cmd === 'add') {
  const kind = (rest[0] || '').toUpperCase();
  const text = rest.slice(1).join(' ').trim();
  if (!KINDS.has(kind) || !text) {
    console.error('usage: fray-notify add <WIN|DECISION|BLOCKER|FYI> "text"');
    process.exit(1);
  }
  const id = newId(items);
  items.push({ id, ts: new Date().toISOString(), kind, text, status: 'open', surfaced: false });
  write(items);
  console.log(id);
} else if (cmd === 'list') {
  const all = rest.includes('--all');
  const rows = items.filter((i) => all || i.status === 'open');
  for (const i of rows) console.log(`${i.id} [${i.kind}]${i.status === 'dismissed' ? ' (dismissed)' : ''} ${i.text}`);
  if (!rows.length) console.log('(no notifications)');
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
  write(items);
  console.log(`dismissed ${n}`);
} else {
  console.error('usage: fray-notify <add|list|dismiss> …');
  process.exit(1);
}
