// @ts-check
// Shared storage + rendering for the fray durable notification queue. Imported by both the
// CLI (`notify.mjs`) and the Stop hook (`fray-notify-surface.mjs`) so the on-disk shape and
// the human-facing markdown render are defined in ONE place and can't drift.
//
// Queue item shape (one JSON object per line in `.fray/notify-queue.jsonl`):
//   { id, ts, kind, title, body, status: "open"|"dismissed", surfaced: bool }
// `title` is a short heading; `body` is the prose context the human reads to decide.
// Legacy items carry a single `text` field instead of title/body — the renderer degrades
// gracefully (derives a heading from the first clause, keeps the rest as the body).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const KINDS = new Set(['WIN', 'DECISION', 'BLOCKER', 'FYI']);

// Section order is deliberate: what the human must ACT on first (blockers, decisions),
// then what's purely informational (wins, fyi).
const SECTIONS = [
  ['BLOCKER', 'Blockers'],
  ['DECISION', 'Decisions'],
  ['WIN', 'Wins'],
  ['FYI', 'FYI'],
];

/** @param {string} file @returns {any[]} */
export function readQueue(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
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

/** @param {string} file @param {any[]} items */
export function writeQueue(file, items) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
}

function titleOf(i) {
  if (i.title) return String(i.title).trim();
  const t = String(i.text || '').trim();
  const head = t.split(/ — | – |: |\. /)[0] || t; // legacy: first clause as the heading
  return head.slice(0, 90).trim();
}

function bodyOf(i) {
  if (i.body != null) return String(i.body).trim();
  if (i.title) return '';
  const t = String(i.text || '').trim();
  const ti = titleOf(i);
  return t.startsWith(ti) ? t.slice(ti.length).replace(/^[\s—–:.-]+/, '').trim() : t;
}

/**
 * Render the OPEN items as scannable, sectioned markdown for the human — grouped by kind,
 * each item a `###` heading + its prose body + a subtle id tag. This is the surface the
 * human reads to decide; it is NOT a terse log line. (Authors should write each item's
 * title/body per the prose skill — terse, factual, enough context to decide.)
 * @param {any[]} open @returns {string}
 */
export function renderMarkdown(open) {
  const n = open.length;
  const intro =
    `📌 ${n} item${n === 1 ? '' : 's'} waiting on you — surfaced here so they don't scroll away. ` +
    `Nothing to run in a terminal: just tell me your call in chat and I'll clear each one.`;

  const parts = [intro];
  for (const [kind, heading] of SECTIONS) {
    const rows = open.filter((i) => i.kind === kind);
    if (!rows.length) continue;
    parts.push(`\n## ${heading}`);
    for (const i of rows) {
      const title = titleOf(i);
      const body = bodyOf(i);
      let block = `\n### ${title} · ${i.id}`;
      if (body) block += `\n\n${body}`;
      parts.push(block);
    }
  }
  return parts.join('\n');
}
