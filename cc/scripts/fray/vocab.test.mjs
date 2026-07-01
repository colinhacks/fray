// @ts-check
/**
 * fray — status-vocab normalization + reconcile forcing-function tests.
 * Run with: `node --test cc/scripts/fray/`.
 *
 * Covers the two coupled changes:
 *   1. The canonical status set + the FOREVER read-aliases (todo/plan → planned,
 *      needs-decision → blocked) — at the pure-function level AND end-to-end through the
 *      board's `--json` read path (a legacy `status:` thread must validate + bucket
 *      canonically).
 *   2. The anti-drift reconcile forcing-function — the staleness primitive, the
 *      timestamp round-trip, and the per-turn hook emitting the LOUD instruction when the
 *      last-reconcile is stale (and staying quiet when it is fresh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUS,
  STATUS_ALIASES,
  normalizeStatus,
  isValidStatus,
  readLastReconcile,
  writeLastReconcile,
  isReconcileStale,
  reconcileThresholdMin,
  DEFAULT_RECONCILE_THRESHOLD_MIN,
} from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.mjs');
const REMINDER = join(HERE, '..', '..', 'hooks', 'fray-reminder.mjs');
const STATUSLINE = join(HERE, '..', '..', 'statusline-fray.mjs');

// ── status vocab — pure functions ────────────────────────────────────────────────
test('STATUS is the canonical set in lifecycle order — needs-decision IS canonical; todo/plan are NOT', () => {
  assert.deepEqual(STATUS, ['planning', 'planned', 'enqueued', 'active', 'needs-decision', 'blocked', 'done', 'dismissed']);
  assert.ok(STATUS.includes('needs-decision'), 'needs-decision is canonical again (the human-decision bucket)');
  for (const legacy of ['todo', 'plan']) {
    assert.ok(!STATUS.includes(legacy), `${legacy} must not be canonical`);
  }
});

test('normalizeStatus maps the legacy aliases and passes canonical/unknown through', () => {
  assert.equal(normalizeStatus('todo'), 'planned');
  assert.equal(normalizeStatus('plan'), 'planned');
  assert.equal(normalizeStatus('needs-decision'), 'needs-decision', 'needs-decision is canonical now (not aliased to blocked)');
  for (const s of STATUS) assert.equal(normalizeStatus(s), s, `${s} is canonical → unchanged`);
  assert.equal(normalizeStatus('bogus'), 'bogus', 'unknown passes through for the caller to reject');
  assert.equal(normalizeStatus(undefined), undefined);
});

test('isValidStatus accepts canonical + aliases, rejects everything else', () => {
  for (const s of STATUS) assert.ok(isValidStatus(s));
  for (const a of Object.keys(STATUS_ALIASES)) assert.ok(isValidStatus(a), `${a} alias is accepted`);
  assert.ok(!isValidStatus('ready'));
  assert.ok(!isValidStatus('complete'));
  assert.ok(!isValidStatus(undefined));
});

// ── reconcile forcing-function — pure functions + round-trip ──────────────────────
test('isReconcileStale: null is stale (first reconcile), then threshold math', () => {
  const now = 1_000_000_000_000;
  assert.equal(isReconcileStale(null, 15, now), true, 'no timestamp → treat as stale');
  assert.equal(isReconcileStale(now - 14 * 60_000, 15, now), false, 'within threshold → fresh');
  assert.equal(isReconcileStale(now - 16 * 60_000, 15, now), true, 'past threshold → stale');
});

test('reconcileThresholdMin: default, config override, and bad values fall back', () => {
  assert.equal(reconcileThresholdMin({ state: {} }), DEFAULT_RECONCILE_THRESHOLD_MIN);
  assert.equal(reconcileThresholdMin({ state: { reconcile_threshold_min: '30' } }), 30);
  assert.equal(reconcileThresholdMin({ state: { reconcile_threshold_min: 'nope' } }), DEFAULT_RECONCILE_THRESHOLD_MIN);
  assert.equal(reconcileThresholdMin({ state: { reconcile_threshold_min: '0' } }), DEFAULT_RECONCILE_THRESHOLD_MIN, 'non-positive falls back');
});

test('writeLastReconcile/readLastReconcile round-trip; absent reads null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-reconcile-'));
  try {
    assert.equal(readLastReconcile(dir), null, 'absent → null');
    const ts = 1_700_000_000_000;
    writeLastReconcile(dir, ts);
    assert.equal(readLastReconcile(dir), ts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── end-to-end: legacy `todo` normalizes; `needs-decision` validates as canonical ─────
test('board --json: `status: todo` normalizes to planned; `needs-decision` is canonical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-board-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'legacy-todo.md'), '---\ntitle: t\nstatus: todo\n---\nbody\n');
    writeFileSync(join(dir, '.fray', 'legacy-nd.md'), '---\ntitle: n\nstatus: needs-decision\nstatus_text: "the open question"\n---\nbody\n');
    const out = execFileSync(process.execPath, [INDEX, '--json'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    const { threads, errors } = JSON.parse(out);
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
    assert.equal(byId['legacy-todo'].status, 'planned', 'todo buckets as planned');
    assert.equal(byId['legacy-nd'].status, 'needs-decision', 'needs-decision is canonical (the human-decision bucket)');
    assert.equal(errors.length, 0, 'a legacy/canonical status is NOT a validation error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-07-01 vocab: needs-decision = ⚖ awaiting-you; blocked = de-emphasized non-human wait ──
test('board: ⚖ hoists needs-decision (not blocked); blocked renders LAST among live groups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-vocab-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'decide.md'), '---\ntitle: d\nstatus: needs-decision\nstatus_text: "which default?"\n---\n## Next step\nask\n');
    writeFileSync(join(dir, '.fray', 'build.md'), '---\ntitle: b\nstatus: active\nstatus_text: "on it"\n---\n## Next step\ngo\n');
    writeFileSync(join(dir, '.fray', 'wait.md'), '---\ntitle: w\nstatus: blocked\nstatus_text: "awaiting PR #42"\n---\n## Next step\nwait\n');
    const out = execFileSync(process.execPath, [INDEX], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    // The ⚖ awaiting-you queue is needs-decision, NOT blocked.
    assert.match(out, /⚖ needs-decision \(1\) — awaiting your call/);
    assert.doesNotMatch(out, /⚖ blocked/, 'blocked is no longer the awaiting-you queue');
    // Order: needs-decision (hoisted) before active before blocked (last).
    const iNd = out.indexOf('needs-decision');
    const iActive = out.indexOf('## active');
    const iBlocked = out.indexOf('## blocked');
    assert.ok(iNd < iActive && iActive < iBlocked, `order needs-decision → active → blocked (got ${iNd},${iActive},${iBlocked})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statusline: needs-decision is YELLOW (33), active cyan (36), blocked GRAY (90)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-sl-'));
  const sess = 'sess-sl';
  try {
    mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(dir, '.fray', '.session-state', sess), 'on\n');
    writeFileSync(join(dir, '.fray', 'd.md'), '---\ntitle: d\nstatus: needs-decision\nstatus_text: x\n---\nb\n');
    writeFileSync(join(dir, '.fray', 'a.md'), '---\ntitle: a\nstatus: active\nstatus_text: x\n---\nb\n');
    writeFileSync(join(dir, '.fray', 'w.md'), '---\ntitle: w\nstatus: blocked\nstatus_text: x\n---\nb\n');
    const out = execFileSync(process.execPath, [STATUSLINE], {
      input: JSON.stringify({ workspace: { project_dir: dir, current_dir: dir }, session_id: sess }),
      env: { ...process.env }, encoding: 'utf8',
    });
    assert.match(out, /\x1b\[33m1 needs-decision\x1b\[0m/, 'needs-decision is yellow (33)');
    assert.match(out, /\x1b\[36m1 active\x1b\[0m/, 'active is cyan (36)');
    assert.match(out, /\x1b\[90m1 blocked\x1b\[0m/, 'blocked is gray (90)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── end-to-end: the per-turn hook fires the reconcile-stale instruction ───────────
/** Stand up an ACTIVATED `.fray/` project (sentinel ON for `sess`), run the reminder hook. */
function runReminder(dir, sessionId) {
  const raw = execFileSync(process.execPath, [REMINDER], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: '/nope/proj/sess.jsonl' }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: sessionId },
    encoding: 'utf8',
  });
  if (!raw.trim()) return '';
  return JSON.parse(raw).hookSpecificOutput?.additionalContext ?? '';
}

test('fray-reminder: a stale (and missing) last-reconcile triggers the instruction; a fresh one does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-hook-'));
  const sess = 'sess-recon';
  try {
    mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(dir, '.fray', '.session-state', sess), 'on\n'); // activate this session

    // No timestamp yet → treated as stale → instruction present.
    assert.match(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'missing timestamp → instruct a first reconcile');

    // Stale timestamp (60m ago, default 15m threshold) → instruction present.
    writeLastReconcile(dir, Date.now() - 60 * 60_000);
    assert.match(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'past threshold → stale instruction');

    // Fresh timestamp (now) → instruction absent.
    writeLastReconcile(dir, Date.now());
    assert.doesNotMatch(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'within threshold → no instruction');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
