// @ts-check
/**
 * fray — status-vocab normalization + reconcile forcing-function tests.
 * Run with: `node --test cc/scripts/fray/`.
 *
 * Covers the two coupled changes:
 *   1. The canonical status set + the FOREVER read-aliases (todo/plan → planned,
 *      enqueued/needs-decision → blocked, the UNIFIED waiting model) — at the pure-function
 *      level AND end-to-end through the board's `--json` read path (a legacy `status:` thread
 *      must validate + bucket canonically). A `blocked` thread's RESOLUTION-MECHANISM field
 *      (none → human, `blocking_threads` → threads, `revalidate_at` → timer) decides its
 *      color/urgency/ordering — verified through the board + statusline.
 *   2. The anti-drift reconcile forcing-function — the staleness primitive, the
 *      timestamp round-trip, and the per-turn hook emitting the LOUD instruction when the
 *      last-reconcile is stale (and staying quiet when it is fresh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUS,
  STATUS_ALIASES,
  SURFACED,
  normalizeStatus,
  isValidStatus,
  effectiveStatus,
  readLastReconcile,
  writeLastReconcile,
  shouldNagReconcile,
  reconcileBackstopMin,
  DEFAULT_RECONCILE_BACKSTOP_MIN,
} from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.mjs');
const DECISIONS = join(HERE, 'decisions.mjs');
const REMINDER = join(HERE, '..', '..', 'hooks', 'fray-reminder.mjs');
const STATUSLINE = join(HERE, '..', '..', 'statusline-fray.mjs');

// ── status vocab — pure functions ────────────────────────────────────────────────
test('STATUS is the canonical set — needs-human is first-class; enqueued/needs-decision stay read-aliases', () => {
  assert.deepEqual(STATUS, ['planning', 'planned', 'active', 'needs-human', 'blocked', 'done', 'dismissed']);
  for (const gone of ['enqueued', 'needs-decision', 'todo', 'plan']) {
    assert.ok(!STATUS.includes(gone), `${gone} is a read-alias, NOT canonical`);
  }
});

test('normalizeStatus maps the legacy aliases to their canonical target', () => {
  assert.equal(normalizeStatus('todo'), 'planned');
  assert.equal(normalizeStatus('plan'), 'planned');
  assert.equal(normalizeStatus('enqueued'), 'blocked', 'enqueued → the machine-wait blocked');
  assert.equal(normalizeStatus('needs-decision'), 'needs-human', 'needs-decision → the first-class needs-human');
  for (const s of STATUS) assert.equal(normalizeStatus(s), s, `${s} is canonical → unchanged`);
  assert.equal(normalizeStatus('bogus'), 'bogus', 'unknown passes through for the caller to reject');
  assert.equal(normalizeStatus(undefined), undefined);
});

test('isValidStatus accepts canonical + aliases, rejects everything else', () => {
  for (const s of STATUS) assert.ok(isValidStatus(s));
  for (const a of Object.keys(STATUS_ALIASES)) assert.ok(isValidStatus(a), `${a} alias is accepted`);
  assert.ok(isValidStatus('needs-human'), 'needs-human is canonical');
  assert.ok(!isValidStatus('ready'));
  assert.ok(!isValidStatus('complete'));
  assert.ok(!isValidStatus(undefined));
});

test('effectiveStatus: needs-human is first-class; blocked reclassifies by machine field', () => {
  assert.equal(effectiveStatus('needs-human', {}), 'needs-human');
  assert.equal(effectiveStatus('needs-decision', {}), 'needs-human', 'the string alias maps first');
  assert.equal(effectiveStatus('active', {}), 'active');
  // The ONE contextual alias: a legacy `blocked` thread with NO machine field reads as needs-human.
  assert.equal(effectiveStatus('blocked', {}), 'needs-human', 'blocked + no machine field → needs-human');
  assert.equal(effectiveStatus('blocked', { hasBlockingThreads: true }), 'blocked', 'blocked + deps stays blocked');
  assert.equal(effectiveStatus('blocked', { hasTimer: true }), 'blocked', 'blocked + timer stays blocked');
  assert.equal(effectiveStatus(undefined, {}), undefined);
});

test('SURFACED ranks needs-human first (the ⚖ awaiting-you queue), machine-blocked after active', () => {
  assert.equal(SURFACED[0], 'needs-human', 'needs-human is top priority');
  assert.ok(SURFACED.indexOf('needs-human') < SURFACED.indexOf('active'));
  assert.ok(SURFACED.indexOf('active') < SURFACED.indexOf('blocked'), 'machine-blocked is de-emphasized, after active');
});

// ── reconcile forcing-function — two-trigger gate + round-trip ────────────────────
test('shouldNagReconcile: missing stamp → first reconcile', () => {
  const now = 1_000_000_000_000;
  const r = shouldNagReconcile({ newestNonTerminalMtimeMs: now - 5 * 60_000, lastReconcileMs: null, backstopMin: 120, now });
  assert.deepEqual(r, { nag: true, reason: 'first' });
});

test('shouldNagReconcile: dirty-gate fires when a thread moved AFTER the last reconcile', () => {
  const now = 1_000_000_000_000;
  const last = now - 30 * 60_000;
  // A non-terminal thread edited AFTER the stamp (well inside the backstop) → dirty, not backstop.
  const r = shouldNagReconcile({ newestNonTerminalMtimeMs: last + 60_000, lastReconcileMs: last, backstopMin: 120, now });
  assert.deepEqual(r, { nag: true, reason: 'dirty' });
});

test('shouldNagReconcile: clean board is SILENT (newest thread predates the reconcile, within backstop)', () => {
  const now = 1_000_000_000_000;
  const last = now - 30 * 60_000;
  // Newest non-terminal edit was BEFORE the reconcile, and we're inside the backstop → no nag.
  const r = shouldNagReconcile({ newestNonTerminalMtimeMs: last - 60_000, lastReconcileMs: last, backstopMin: 120, now });
  assert.deepEqual(r, { nag: false, reason: null });
});

test('shouldNagReconcile: backstop fires on long elapsed even with NO thread change', () => {
  const now = 1_000_000_000_000;
  const last = now - 121 * 60_000; // past the 120m backstop
  // Nothing moved (newest edit predates the reconcile), but the long backstop catches file-invisible drift.
  const r = shouldNagReconcile({ newestNonTerminalMtimeMs: last - 5 * 60_000, lastReconcileMs: last, backstopMin: 120, now });
  assert.deepEqual(r, { nag: true, reason: 'backstop' });
});

test('shouldNagReconcile: null newest-mtime (no non-terminal threads) can only trip first/backstop', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(
    shouldNagReconcile({ newestNonTerminalMtimeMs: null, lastReconcileMs: now - 30 * 60_000, backstopMin: 120, now }),
    { nag: false, reason: null },
    'no threads to be dirty + within backstop → silent',
  );
  assert.deepEqual(
    shouldNagReconcile({ newestNonTerminalMtimeMs: null, lastReconcileMs: now - 121 * 60_000, backstopMin: 120, now }),
    { nag: true, reason: 'backstop' },
    'no threads to be dirty but past backstop → backstop fires',
  );
});

test('reconcileBackstopMin: default, config override, and bad values fall back', () => {
  assert.equal(reconcileBackstopMin({ state: {} }), DEFAULT_RECONCILE_BACKSTOP_MIN);
  assert.equal(reconcileBackstopMin({ state: { reconcile_threshold_min: '240' } }), 240);
  assert.equal(reconcileBackstopMin({ state: { reconcile_threshold_min: 'nope' } }), DEFAULT_RECONCILE_BACKSTOP_MIN);
  assert.equal(reconcileBackstopMin({ state: { reconcile_threshold_min: '0' } }), DEFAULT_RECONCILE_BACKSTOP_MIN, 'non-positive falls back');
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

// ── end-to-end: legacy `todo`/`needs-decision` normalize through the board read path ─────
test('board --json: legacy `todo`→planned; `needs-decision`→needs-human (human-blocked)', () => {
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
    assert.equal(byId['legacy-nd'].status, 'needs-human', 'needs-decision normalizes to the first-class needs-human');
    assert.equal(byId['legacy-nd'].humanBlocked, true, 'a needs-human thread is human-blocked (awaiting you)');
    assert.equal(errors.length, 0, 'a legacy/canonical status is NOT a validation error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── needs-human as a first-class status through the board read + validator ──
test('board --json: a canonical needs-human thread emits status needs-human + humanBlocked; missing status_text errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-nh-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'ask.md'), '---\ntitle: a\nstatus: needs-human\nstatus_text: "approve the API shape?"\n---\nbody\n');
    writeFileSync(join(dir, '.fray', 'noask.md'), '---\ntitle: n\nstatus: needs-human\n---\nbody\n');
    const out = execFileSync(process.execPath, [INDEX, '--json'], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    const { threads, errors } = JSON.parse(out);
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
    assert.equal(byId['ask'].status, 'needs-human', 'a canonical needs-human thread emits status needs-human');
    assert.equal(byId['ask'].humanBlocked, true, 'needs-human IS the awaiting-you predicate');
    assert.equal(byId['noask'].humanBlocked, true, 'still humanBlocked even without a status_text');
    assert.ok(errors.some((e) => /noask\.md: .*needs-human requires a status_text/.test(e)), 'needs-human without status_text is a validation ERROR');
    assert.equal(errors.filter((e) => /needs-human requires a status_text/.test(e)).length, 1, 'only the no-status_text thread errors (the one with a status_text is fine)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── block-form deps: board + `fray decisions` agree (parseDeps, not a flat read) ──
test('block-form blocking_threads → machine-blocked (NOT needs-human), excluded from `fray decisions`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-bf-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    // A YAML BLOCK-form dep list (not inline `[..]`) + status blocked → a MACHINE wait.
    writeFileSync(join(dir, '.fray', 'blockform.md'), '---\ntitle: b\nstatus: blocked\nstatus_text: "waiting on dep"\nblocking_threads:\n  - dep-thread\n---\n## Next step\nwait\n');
    writeFileSync(join(dir, '.fray', 'dep-thread.md'), '---\ntitle: d\nstatus: active\nstatus_text: "on it"\n---\n## Next step\ngo\n');
    writeFileSync(join(dir, '.fray', 'ask.md'), '---\ntitle: a\nstatus: needs-human\nstatus_text: "which default?"\n---\n## Next step\nask\n');
    // Board (parseDeps, block-form aware): the block-form thread is machine-`blocked`, not needs-human.
    const board = JSON.parse(execFileSync(process.execPath, [INDEX, '--json'], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' }));
    const byId = Object.fromEntries(board.threads.map((t) => [t.id, t]));
    assert.equal(byId['blockform'].status, 'blocked', 'block-form deps → machine-blocked, not needs-human');
    assert.equal(byId['blockform'].humanBlocked, false);
    // `fray decisions` (decisions.mjs, now parseDeps-based) must AGREE: exclude the block-form thread,
    // include the canonical needs-human one.
    const dec = execFileSync(process.execPath, [DECISIONS], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    assert.doesNotMatch(dec, /\[blockform\]/, 'a block-form machine-blocked thread is NOT a pending decision');
    assert.match(dec, /\[ask\]/, 'the needs-human thread IS a pending decision');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── STRUCTURED errorItems: the --json branch classifies a missing-frontmatter file as REPAIRABLE ──
test('board --json: errorItems classifies a no-frontmatter file as `no-frontmatter`, others as `other`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-erritems-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    // The incident shape: metadata in bold prose, NO YAML frontmatter → repairable.
    writeFileSync(join(dir, '.fray', 'no-fm.md'), '**Status: DONE**\n\nbody with no frontmatter\n');
    // A well-formed thread but with an INVALID status → an error, but NOT frontmatter-repairable.
    writeFileSync(join(dir, '.fray', 'bad-status.md'), '---\ntitle: b\nstatus: bogus\nstatus_text: "x"\n---\nbody\n');
    // A clean thread → no error item at all.
    writeFileSync(join(dir, '.fray', 'ok.md'), '---\ntitle: o\nstatus: active\nstatus_text: "fine"\n---\n## Next step\ngo\n');
    const board = JSON.parse(execFileSync(process.execPath, [INDEX, '--json'], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' }));
    assert.ok(Array.isArray(board.errorItems), 'errorItems is emitted as an array');
    const byFile = Object.fromEntries(board.errorItems.map((e) => [e.file, e]));
    assert.equal(byFile['no-fm.md'].kind, 'no-frontmatter', 'a missing-frontmatter file is repairable');
    assert.match(byFile['no-fm.md'].message, /no YAML frontmatter/);
    assert.equal(byFile['bad-status.md'].kind, 'other', 'an invalid-status file is NOT frontmatter-repairable');
    assert.equal(byFile['ok.md'], undefined, 'a clean thread produces no error item');
    // The legacy string array is untouched (both errors still present, formatted as before).
    assert.ok(board.errors.some((e) => e.includes('no-fm.md') && e.includes('no YAML frontmatter')), 'legacy errors string array preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── `activity` (the UI listing-row gerund gloss) passes through --json, distinct from status_text ──
test('board --json: `activity` frontmatter passes through; absent → undefined; distinct from status_text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-activity-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'has-activity.md'), '---\ntitle: h\nstatus: active\nstatus_text: "full board gloss"\nactivity: "Awaiting CI on PR #391"\n---\nbody\n');
    writeFileSync(join(dir, '.fray', 'no-activity.md'), '---\ntitle: n\nstatus: active\nstatus_text: "just a gloss"\n---\nbody\n');
    const out = execFileSync(process.execPath, [INDEX, '--json'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    const byId = Object.fromEntries(JSON.parse(out).threads.map((t) => [t.id, t]));
    assert.equal(byId['has-activity'].activity, 'Awaiting CI on PR #391', 'activity flows through the --json emit');
    assert.equal(byId['has-activity'].status_text, 'full board gloss', 'status_text is independent of activity');
    assert.equal(byId['no-activity'].activity, undefined, 'a thread without an activity field carries no activity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── derived `hasPlan` (a `## Plan` section) passes through --json — NO frontmatter flag ──
test('board --json: `hasPlan` is derived from a `## Plan` body section; validator ignores it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-hasplan-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    // A design thread with a `## Plan` section → hasPlan true. Heading match is word-bounded.
    writeFileSync(join(dir, '.fray', 'with-plan.md'), '---\ntitle: w\nstatus: planning\nstatus_text: "designing"\n---\n## Goal\ng\n\n## Plan\n1. do a thing\n');
    // No `## Plan` section → hasPlan false. A `## Planning` heading must NOT count (word boundary).
    writeFileSync(join(dir, '.fray', 'no-plan.md'), '---\ntitle: n\nstatus: active\nstatus_text: "building"\n---\n## Planning notes\nnope\n');
    const out = execFileSync(process.execPath, [INDEX, '--json'], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    const byId = Object.fromEntries(JSON.parse(out).threads.map((t) => [t.id, t]));
    assert.equal(byId['with-plan'].hasPlan, true, '`## Plan` section → hasPlan true');
    assert.equal(byId['no-plan'].hasPlan, false, 'no `## Plan` section (a `## Planning` heading does NOT count) → hasPlan false');
    // Derived, not frontmatter: neither thread carries a `plan` field and neither errors on one.
    assert.equal(byId['with-plan'].plan, undefined, 'there is NO plan frontmatter flag — the marker is derived');
    assert.equal(byId['with-plan'].errors.length, 0, 'a `## Plan` section is never a validation error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-07-01 unified model: the ⚖ queue is HUMAN-blocked; machine-blocked renders LAST ──
test('board: ⚖ hoists human-blocked (no machine field); machine-blocked renders LAST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-vocab-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    // human-blocked — no blocking_threads / revalidate_at → the ⚖ awaiting-you queue.
    writeFileSync(join(dir, '.fray', 'decide.md'), '---\ntitle: d\nstatus: blocked\nstatus_text: "which default?"\n---\n## Next step\nask\n');
    writeFileSync(join(dir, '.fray', 'build.md'), '---\ntitle: b\nstatus: active\nstatus_text: "on it"\n---\n## Next step\ngo\n');
    // machine-blocked — waits on a still-active thread → rendered in the blocked group, NOT ⚖.
    writeFileSync(join(dir, '.fray', 'dep.md'), '---\ntitle: dep\nstatus: active\nstatus_text: "running"\n---\n## Next step\ngo\n');
    writeFileSync(join(dir, '.fray', 'wait.md'), '---\ntitle: w\nstatus: blocked\nstatus_text: "waiting on dep"\nblocking_threads: [dep]\n---\n## Next step\nwait\n');
    const out = execFileSync(process.execPath, [INDEX], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    // The ⚖ awaiting-you queue is needs-human only — decide (legacy blocked-no-field) is in, wait is NOT.
    assert.match(out, /⚖ awaiting you \(1\) — needs-human/);
    assert.match(out, /which default\?/, 'the human-blocked thread is surfaced by its status_text');
    assert.doesNotMatch(out, /⚖ awaiting you \(2\)/, 'machine-blocked wait is NOT in the ⚖ queue');
    // Order: ⚖ (human-blocked) before active before the blocked group (machine-blocked, last).
    const iAwaiting = out.indexOf('⚖ awaiting you');
    const iActive = out.indexOf('## active');
    const iBlocked = out.indexOf('## blocked');
    assert.ok(iAwaiting < iActive && iActive < iBlocked, `order awaiting-you → active → blocked (got ${iAwaiting},${iActive},${iBlocked})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statusline: human-blocked YELLOW (33) awaiting-you, active cyan (36), machine-blocked GRAY (90)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-sl-'));
  const sess = 'sess-sl';
  const future = new Date(Date.now() + 3_600_000).toISOString();
  try {
    mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(dir, '.fray', '.session-state', sess), 'on\n');
    // human-blocked (no machine field) → yellow awaiting-you.
    writeFileSync(join(dir, '.fray', 'd.md'), '---\ntitle: d\nstatus: blocked\nstatus_text: x\n---\nb\n');
    writeFileSync(join(dir, '.fray', 'a.md'), '---\ntitle: a\nstatus: active\nstatus_text: x\n---\nb\n');
    // machine-blocked (a timer field) → gray blocked, NOT awaiting-you.
    writeFileSync(join(dir, '.fray', 'w.md'), `---\ntitle: w\nstatus: blocked\nstatus_text: x\nrevalidate_at: ${future}\n---\nb\n`);
    const out = execFileSync(process.execPath, [STATUSLINE], {
      input: JSON.stringify({ workspace: { project_dir: dir, current_dir: dir }, session_id: sess }),
      env: { ...process.env }, encoding: 'utf8',
    });
    assert.match(out, /\x1b\[33m1 awaiting-you\x1b\[0m/, 'human-blocked is yellow (33) awaiting-you');
    assert.match(out, /\x1b\[36m1 active\x1b\[0m/, 'active is cyan (36)');
    assert.match(out, /\x1b\[90m1 blocked\x1b\[0m/, 'machine-blocked is gray (90)');
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

test('fray-reminder: the two-trigger reconcile gate — first / dirty / backstop fire; a clean board is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-hook-'));
  const sess = 'sess-recon';
  const thread = join(dir, '.fray', 't.md');
  const writeThread = () =>
    writeFileSync(thread, 'title: t\nstatus: active\n\n## Status\nworking\n');
  try {
    mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(dir, '.fray', '.session-state', sess), 'on\n'); // activate this session
    writeThread(); // one non-terminal (active) thread on the board

    // No timestamp yet → FIRST reconcile → instruction present.
    assert.match(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'missing timestamp → instruct a first reconcile');

    // Reconcile stamped AFTER the thread's last edit → clean board, within backstop → SILENT.
    writeLastReconcile(dir, Date.now());
    assert.doesNotMatch(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'clean board within backstop → no instruction');

    // A non-terminal thread edited AFTER the reconcile stamp → DIRTY. But DEBOUNCED (change #5):
    // the FIRST sighting starts the window and stays SILENT — a burst of return-folding must not
    // nag every turn. The nudge fires only once the window ages past both thresholds.
    const nagStatePath = join(dir, '.fray', '.reconcile-nag-state.json');
    writeThread(); // bumps the thread's mtime past the stamp
    assert.doesNotMatch(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'dirty first-sight is debounced → silent');
    // Age the debounce window past both thresholds (>3m, >2 turns) → the dirty-gate now fires,
    // and names the drifted thread (scoped staleness, change #3).
    const st = JSON.parse(readFileSync(nagStatePath, 'utf8'));
    writeFileSync(nagStatePath, JSON.stringify({ dirty_since_ms: Date.now() - 10 * 60_000, dirty_since_turn: 0, turns: st.turns }) + '\n');
    const dirtyOut = runReminder(dir, sess);
    assert.match(dirtyOut, /BOARD RECONCILE STALE/, 'dirty persisting past the debounce window fires');
    assert.match(dirtyOut, /\bt\b/, 'the drifted thread `t` is named (scoped staleness)');

    // BACKSTOP is non-bursty → NOT debounced, fires immediately: age the thread OLDER than the
    // stamp (so it is not dirty) and stamp past the 120m backstop, with a clean debounce window.
    const oldT = (Date.now() - 200 * 60_000) / 1000;
    utimesSync(thread, oldT, oldT);
    writeLastReconcile(dir, Date.now() - 121 * 60_000);
    rmSync(nagStatePath, { force: true });
    assert.match(runReminder(dir, sess), /BOARD RECONCILE STALE/, 'long elapsed with no thread change → backstop fires (not debounced)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
