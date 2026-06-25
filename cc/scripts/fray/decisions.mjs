#!/usr/bin/env node
// @ts-check
// Decisions view, DERIVED from fray threads (no static store). Scans the project's
// .fray/*.md, selects threads with `status: needs-decision`, and prints each thread's
// slug + its FULL status_text (the decision write-up) — the rich inline-reading view that
// complements the one-line-per-thread board (scripts/fray/index.mjs).
//
// Self-contained + importable: `collectDecisions()` is reused by the thread updater
// (thread-update.mjs) to print the queue after every edit, and by `fray decisions`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// The project root comes from the environment, NOT this script's own path: the tool
// ships inside the fray PLUGIN (and after a marketplace install lives in
// ~/.claude/plugins/cache/…), so a script-relative root would point at the PLUGIN,
// never the project. CLAUDE_PROJECT_DIR is exported to hook + bin processes; when run
// by hand from the repo root, process.cwd() is correct.
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const frayDir = join(root, '.fray');

const STATUS_TEXT_KEY = 'status_text';

// Parse the leading `---` frontmatter block into a flat map. Only single-line
// `key: value` pairs are read (the thread frontmatter is flat scalars + a list).
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const fm = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return fm;
    const m = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  return null; // unterminated frontmatter
}

function unquote(raw) {
  if (raw === undefined) return '';
  let v = raw.trim();
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) v = m[1].replace(/\\(.)/g, '$1');
  return v;
}

export function collectDecisions() {
  let files;
  try {
    files = readdirSync(frayDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    let text;
    try {
      text = readFileSync(join(frayDir, f), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm || fm.status !== 'needs-decision') continue;
    const rawText = fm[STATUS_TEXT_KEY];
    out.push({ slug: basename(f, '.md'), status_text: unquote(rawText) });
  }
  return out;
}

function main() {
  const items = collectDecisions();
  if (items.length === 0) {
    console.log('✓ no pending decisions');
    return;
  }
  console.log(`⚖ ${items.length} decision(s) awaiting you:\n`);
  items.forEach((d, i) => {
    console.log(`[${d.slug}]`);
    console.log(d.status_text || '(no status_text written up)');
    if (i < items.length - 1) console.log('');
  });
}

// Run only when invoked directly (it's also imported by other scripts).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
