#!/usr/bin/env node
// @ts-check
/**
 * Codex-facing Fray pulse. Run this at the start of a Fray turn/checkpoint to
 * surface pending threads, validation errors, and the reconciliation reminder.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, frayActive, STATUS, TERMINAL } from '../scripts/fray/config.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const PROJECT_DIR = arg('--project-dir') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FRAY_DIR = join(PROJECT_DIR, '.fray');
const asJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

/**
 * @param {string} path
 * @returns {string}
 */
function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const cfg = loadConfig(PROJECT_DIR);
// Enablement is per-session now (sentinel), not a config flag. Codex passes a session id
// via env when available; absent → the default (active when `.fray/` exists).
const SESSION_ID = arg('--session-id') ?? process.env.CODEX_SESSION_ID ?? process.env.FRAY_SESSION_ID ?? undefined;
const frayEnabled = frayActive(PROJECT_DIR, SESSION_ID);
const pending = [];
const queued = [];
const dropRisk = []; // `enqueued` threads whose depends_on are ALL terminal — should have auto-fired, never dispatched. The canonical silent-stall shape; surfaced BY NAME so it can't be skipped by reflex.
const scanned = []; // {slug,status,deps} for every thread — second pass resolves cross-thread dep statuses for the drop-risk check.
const errors = [];

// Parse a thread's `depends_on:` frontmatter (inline `[a, b]` OR YAML block `- a`) into slugs.
function parseDepends(src) {
  const inline = src.match(/^depends_on:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const block = src.match(/^depends_on:\s*\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  if (block) return block[1].split('\n').map((l) => l.replace(/^[ \t]+-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return [];
}
const returnedDispatches = [];
const unreconciledDispatches = [];
const unattachedDispatches = [];

try {
  for (const file of readdirSync(FRAY_DIR).sort()) {
    if (!file.endsWith('.md') || file.startsWith('_')) continue;
    const slug = file.replace(/\.md$/, '');
    const src = read(join(FRAY_DIR, file));
    const title = src.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const status = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
    const next = (() => {
      const lines = src.split('\n');
      const i = lines.findIndex((line) => /^##\s+Next step\s*$/i.test(line));
      if (i === -1) return '';
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,6}\s/.test(lines[j])) break;
        if (lines[j].trim()) return lines[j].trim();
      }
      return '';
    })();

    if (!title) errors.push(`${slug}: missing title`);
    if (!status) errors.push(`${slug}: missing status`);
    else if (!STATUS.includes(status)) errors.push(`${slug}: invalid status "${status}"`);

    scanned.push({ slug, status, deps: parseDepends(src) });
    if (!TERMINAL.includes(status)) pending.push({ slug, title, status: status || '?', next });
    if (!TERMINAL.includes(status) && /\bQUEUED\b/.test(src)) queued.push(slug);
  }
} catch {
  errors.push('missing or unreadable .fray directory');
}

// DROP-RISK: an `enqueued` thread WITH declared deps, ALL of which are terminal — its
// auto-trigger fired and nothing dispatched it. An unknown-slug dep is NOT terminal →
// not flagged (conservative; avoids crying wolf on a typo).
{
  const statusOf = new Map(scanned.map((t) => [t.slug, t.status]));
  for (const t of scanned) {
    if (t.status === 'enqueued' && t.deps.length > 0 &&
        t.deps.every((d) => TERMINAL.includes(statusOf.get(d) ?? '?'))) {
      dropRisk.push(t.slug);
    }
  }
}

try {
  const ledgerPath = join(FRAY_DIR, '.dispatch-ledger.jsonl');
  if (existsSync(ledgerPath)) {
    const rows = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    for (const row of rows) {
      if (
        row.tool === 'codex.spawn_agent' &&
        row.reconciled !== true
      ) {
        const item = {
          dispatch_id: row.dispatch_id,
          thread: row.thread,
          label: row.label,
          agent_id: row.agent_id,
          nickname: row.nickname || '',
          packet_present: row.packet_present,
        };
        if (row.returned === true) returnedDispatches.push(item);
        else if (row.agent_id) unreconciledDispatches.push(item);
        else unattachedDispatches.push(item);
      }
    }
  }
} catch {
  errors.push('unable to read .fray/.dispatch-ledger.jsonl');
}

const payload = {
  enabled: frayEnabled,
  autonomous_mode: cfg.autonomousMode,
  pending,
  queued_followup_threads: queued,
  drop_risk_threads: dropRisk,
  returned_unreconciled_dispatches: returnedDispatches,
  unreconciled_dispatches: unreconciledDispatches,
  unattached_dispatches: unattachedDispatches,
  errors,
};

const strictErrors = [];
const strictWarnings = [];
if (strict && frayEnabled) {
  if (returnedDispatches.length) {
    strictErrors.push(
      `${returnedDispatches.length} returned dispatch(es) are unreconciled. Fold each return into its .fray thread before answering or advancing unrelated work.`,
    );
  }
  if (unreconciledDispatches.length) {
    strictWarnings.push(
      `${unreconciledDispatches.length} attached dispatch(es) are not reconciled or returned yet. This can include still-running agents.`,
    );
  }
  if (unattachedDispatches.length) {
    strictErrors.push(
      `${unattachedDispatches.length} dispatch ledger row(s) are unattached; attach the spawned agent id or explicitly reconcile stale preflight rows.`,
    );
  }
  if (errors.length) strictErrors.push(...errors);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ...payload, strict_errors: strictErrors, strict_warnings: strictWarnings }, null, 2)}\n`);
  process.exit(strictErrors.length || errors.length ? 1 : 0);
}

if (!frayEnabled) {
  console.log('FRAY disabled for this session (per-session sentinel `.fray/.session-state/<session_id>` = off).');
  process.exit(0);
}

console.log(
  `FRAY pulse for Codex: autonomous_mode=${cfg.autonomousMode ? 'on' : 'off'}; ${pending.length} pending thread(s).`,
);
if (pending.length) {
  for (const item of pending) {
    console.log(`- ${item.slug} [${item.status}] - ${item.title}`);
    if (item.next) console.log(`  next: ${item.next}`);
  }
}
if (errors.length) {
  console.log(`VALIDATION ERRORS: ${errors.join('; ')}`);
  process.exit(1);
}

if (returnedDispatches.length) {
  console.log(`RETURNED BUT UNRECONCILED CODEX DISPATCHES (${returnedDispatches.length}):`);
  for (const item of returnedDispatches) {
    console.log(
      `- ${item.dispatch_id} -> ${item.thread} (${item.nickname || item.agent_id}) ${item.packet_present === false ? '[missing packet] ' : ''}${item.label ? `- ${item.label}` : ''}`,
    );
  }
}
if (unreconciledDispatches.length) {
  console.log(`ATTACHED CODEX DISPATCHES NOT YET RETURNED/RECONCILED (${unreconciledDispatches.length}):`);
  for (const item of unreconciledDispatches) {
    console.log(
      `- ${item.dispatch_id} -> ${item.thread} (${item.nickname || item.agent_id}) ${item.label ? `- ${item.label}` : ''}`,
    );
  }
}
if (unattachedDispatches.length) {
  console.log(`UNATTACHED CODEX DISPATCH LEDGER ROWS (${unattachedDispatches.length}):`);
  for (const item of unattachedDispatches) {
    console.log(
      `- ${item.dispatch_id} -> ${item.thread} ${item.label ? `- ${item.label}` : ''}`,
    );
  }
}
if (queued.length) {
  console.log(`QUEUED FOLLOW-UPS PRESENT in ${queued.length} thread(s): ${queued.join(', ')}`);
}
if (dropRisk.length) {
  console.log(
    `DROP-RISK THREADS in ${dropRisk.length} thread(s): ${dropRisk.join(', ')}. These are \`enqueued\` with ALL their \`depends_on\` now TERMINAL — their auto-trigger fired and they were NEVER dispatched (the exact silent-stall this guard exists to kill). RE-READ each thread .md THIS turn and DISPATCH/ADVANCE it. If one is genuinely not ready, move it back to \`todo\` or fix its \`depends_on\`; leaving it \`enqueued\` with cleared deps is a bug.`,
  );
}

console.log(
  'Reminder: if Fray is enabled, load the Codex fray skill eagerly after startup/resume/clear/compact; never call wait_agent; rely on sub-agent notifications plus codex-reminder/ledger state; when any agent returns, update its .fray thread immediately; mark reconciled only with --thread-updated; use node .agents/plugins/fray-codex/scripts/fray/index.mjs for the board; never use stale hub/board trackers.',
);

if (strictErrors.length) {
  console.error(`FRAY STRICT BLOCK: ${strictErrors.join(' ')}`);
  process.exit(1);
}
if (strictWarnings.length) {
  console.error(`FRAY STRICT WARNING: ${strictWarnings.join(' ')}`);
}
