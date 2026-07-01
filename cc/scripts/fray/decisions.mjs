#!/usr/bin/env node
// @ts-check
// Decisions view, DERIVED from fray threads (no static store). Scans the project's
// .fray/*.md, selects threads with canonical `status: blocked` (which absorbs the legacy
// `needs-decision` — a thread still carrying `status: needs-decision` normalizes to blocked
// and is still selected), and prints each thread's slug + its FULL status_text (the blocker /
// decision write-up) — the rich inline-reading view that complements the one-line-per-thread
// board (scripts/fray/index.mjs).
//
// Self-contained + importable: `collectDecisions()` is reused by the thread updater
// (thread-update.mjs) to print the queue after every edit, and by `fray decisions`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { normalizeStatus } from './config.mjs';

// The project root comes from the environment, NOT this script's own path: the tool
// ships inside the fray PLUGIN (and after a marketplace install lives in
// ~/.claude/plugins/cache/…), so a script-relative root would point at the PLUGIN,
// never the project. CLAUDE_PROJECT_DIR is exported to hook + bin processes; when run
// by hand from the repo root, process.cwd() is correct.
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const frayDir = join(root, '.fray');

const STATUS_TEXT_KEY = 'status_text';

// A `blocked` thread can be waiting on the MAINTAINER (a decision only they can make) or on a
// THIRD PARTY (an upstream PR review/merge, a CI run, an external service) with no in-session
// trigger. Both are validly `blocked`, but only the former is "⚖ awaiting YOU" — lumping an
// awaiting-upstream thread into the human decision queue is the exact confusion that made the
// board read as noise. The optional `blocked_on:` frontmatter field disambiguates; absent → human
// (back-compat: an untagged blocked thread is treated as a maintainer decision).
export function isExternalBlock(blockedOn) {
  return /^\s*(external|upstream|third.?party|review|ci)\b/i.test(String(blockedOn ?? ''));
}

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
    if (!fm || normalizeStatus(fm.status) !== 'blocked') continue;
    const rawText = fm[STATUS_TEXT_KEY];
    out.push({ slug: basename(f, '.md'), status_text: unquote(rawText), blocked_on: unquote(fm.blocked_on) });
  }
  return out;
}

/**
 * The awaiting-YOU subset of {@link collectDecisions} — blocked threads that need a MAINTAINER
 * decision, EXCLUDING those `blocked_on:` an external party. This is what the board's "⚖ awaiting
 * you" queue and the Stop-hook pop-blocked should surface; an awaiting-upstream thread is tracked
 * but never presented as the human's decision.
 * @returns {{slug: string, status_text: string, blocked_on: string}[]}
 */
export function humanDecisions() {
  return collectDecisions().filter((d) => !isExternalBlock(d.blocked_on));
}

function main() {
  const all = collectDecisions();
  const human = all.filter((d) => !isExternalBlock(d.blocked_on));
  const external = all.filter((d) => isExternalBlock(d.blocked_on));
  if (human.length === 0 && external.length === 0) {
    console.log('✓ no pending decisions');
    return;
  }
  if (human.length) {
    console.log(`⚖ ${human.length} decision(s) awaiting you:\n`);
    human.forEach((d, i) => {
      console.log(`[${d.slug}]`);
      console.log(d.status_text || '(no status_text written up)');
      if (i < human.length - 1) console.log('');
    });
  } else {
    console.log('✓ no decisions awaiting you');
  }
  if (external.length) {
    console.log(`\n⏳ ${external.length} awaiting external (upstream/CI — NOT your call, tracked only):`);
    external.forEach((d) => console.log(`  [${d.slug}] ${d.blocked_on ? `(${d.blocked_on}) ` : ''}${d.status_text || ''}`.trimEnd()));
  }
}

// Run only when invoked directly (it's also imported by other scripts).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
