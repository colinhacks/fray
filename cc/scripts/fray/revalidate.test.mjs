// @ts-check
/**
 * fray — Revalidate (time-based recheck) tests. Run with: `node --test 'cc/scripts/fray/*.test.mjs'`.
 *
 * Covers the three layers of the mechanism:
 *   1. The pure timer semantics (`revalidateState` / `formatEta`) — including the robustness
 *      contract: missing/empty/malformed `revalidate_at` → null ("no timer"), never a throw.
 *   2. The board (`index.mjs --json` + the rendered board) — due vs parked status, and the
 *      non-fatal warning for a present-but-unparseable timestamp.
 *   3. The per-turn hook (`fray-reminder.mjs`) — a DUE thread surfaces a LOUD "REVALIDATE DUE"
 *      callout; a FUTURE-dated `blocked` thread is SUPPRESSED from the awaiting-you queue AND
 *      the pending list (parked on a timer, quiet); a thread with no field is unaffected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { revalidateState, formatEta, writeLastReconcile } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.mjs');
const REMINDER = join(HERE, '..', '..', 'hooks', 'fray-reminder.mjs');
const NOW = 1_700_000_000_000;

// ── pure timer semantics ──────────────────────────────────────────────────────────
test('revalidateState: missing / empty / malformed → null (no timer, never throws)', () => {
  assert.equal(revalidateState(undefined, undefined, NOW), null, 'absent → null');
  assert.equal(revalidateState(null, null, NOW), null);
  assert.equal(revalidateState('', '', NOW), null, 'empty → null');
  assert.equal(revalidateState('   ', undefined, NOW), null, 'whitespace → null');
  assert.equal(revalidateState('tomorrow', undefined, NOW), null, 'unparseable → null');
  assert.equal(revalidateState('not-a-date', undefined, NOW), null);
});

test('revalidateState: future is parked (not due), past is due; eta + last_checked carried', () => {
  const future = new Date(NOW + 8 * 3_600_000).toISOString();
  const past = new Date(NOW - 60_000).toISOString();

  const fs = revalidateState(future, undefined, NOW);
  assert.ok(fs && !fs.due, 'future → not due');
  assert.equal(fs.etaMin, 8 * 60, 'eta is +480m');
  assert.equal(fs.lastChecked, null, 'no last_checked → null');

  const ps = revalidateState(past, '2026-06-01T00:00:00Z', NOW);
  assert.ok(ps && ps.due, 'past → due');
  assert.ok(ps.etaMin < 0, 'eta negative once due');
  assert.equal(ps.lastChecked, '2026-06-01T00:00:00Z', 'last_checked surfaced');
});

test('revalidateState: strips surrounding quotes (matches the frontmatter quoter)', () => {
  const v = revalidateState('"2026-06-27T18:00:00Z"', "'2026-06-01T00:00:00Z'", Date.parse('2026-06-27T19:00:00Z'));
  assert.ok(v && v.due, 'quoted past timestamp parses + is due');
  assert.equal(v.lastChecked, '2026-06-01T00:00:00Z', 'quoted last_checked unquoted');
});

test('formatEta: minutes, hours, days; negatives clamp to 0m', () => {
  assert.equal(formatEta(45), '45m');
  assert.equal(formatEta(90), '2h'); // rounds
  assert.equal(formatEta(8 * 60), '8h');
  assert.equal(formatEta(48 * 60), '2d');
  assert.equal(formatEta(-5), '0m', 'an already-due timer clamps to 0m');
});

// ── board: due vs parked status + the malformed-timestamp warning ─────────────────
test('board --json: future thread is parked (due=false), past thread is due (due=true)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-reval-board-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    const future = new Date(Date.now() + 8 * 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(join(dir, '.fray', 'parked.md'), `---\ntitle: p\nstatus: blocked\nstatus_text: "awaiting jdx review on PR #888"\nrevalidate_at: ${future}\n---\nbody\n`);
    writeFileSync(join(dir, '.fray', 'due.md'), `---\ntitle: d\nstatus: blocked\nstatus_text: "awaiting CI"\nrevalidate_at: ${past}\nlast_checked: 2026-06-01T00:00:00Z\n---\nbody\n`);
    const { threads, errors } = JSON.parse(execFileSync(process.execPath, [INDEX, '--json'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8',
    }));
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
    assert.equal(byId['parked'].revalidate.due, false, 'future → parked');
    assert.equal(byId['due'].revalidate.due, true, 'past → due');
    assert.equal(byId['due'].revalidate.lastChecked, '2026-06-01T00:00:00Z');
    assert.equal(errors.length, 0, 'revalidate_at is not a validation error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: a present-but-unparseable revalidate_at surfaces a non-fatal warning, not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-reval-bad-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'typo.md'), '---\ntitle: t\nstatus: blocked\nstatus_text: "x"\nrevalidate_at: tomorrow\n---\nbody\n');
    // --validate exits 0 (warnings never fail the gate) and prints the warning to stderr.
    const out = execFileSync(process.execPath, [INDEX, '--validate'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /frontmatter OK/, 'a bad timestamp is a warning, not a frontmatter error');
    const { threads } = JSON.parse(execFileSync(process.execPath, [INDEX, '--json'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8',
    }));
    const typo = threads.find((t) => t.id === 'typo');
    assert.equal(typo.revalidate, null, 'malformed → no timer');
    assert.ok(typo.warnings.some((w) => /revalidate_at present but not a parseable/.test(w)), 'warning emitted');
    assert.equal(typo.errors.length, 0, 'no validation error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── per-turn hook: due surfaces loudly; future is suppressed from the nag ──────────
/** Stand up an ACTIVATED `.fray/` project (sentinel ON), stamp a fresh reconcile, run the hook. */
function runReminder(dir, sessionId) {
  writeLastReconcile(dir, Date.now()); // keep the reconcile-stale block out of the output
  const raw = execFileSync(process.execPath, [REMINDER], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: '/nope/proj/sess.jsonl' }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: sessionId },
    encoding: 'utf8',
  });
  if (!raw.trim()) return '';
  return JSON.parse(raw).hookSpecificOutput?.additionalContext ?? '';
}

test('fray-reminder: DUE thread surfaces REVALIDATE DUE; FUTURE blocked thread is fully suppressed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-reval-hook-'));
  const sess = 'sess-reval';
  try {
    mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(dir, '.fray', '.session-state', sess), 'on\n');

    const future = new Date(Date.now() + 8 * 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    // DUE: a blocked thread whose timer has fired.
    writeFileSync(join(dir, '.fray', 'pr-due.md'), `---\ntitle: due\nstatus: blocked\nstatus_text: "awaiting jdx review"\nrevalidate_at: ${past}\nlast_checked: 2026-06-01T00:00:00Z\n---\nbody\n`);
    // PARKED: a blocked thread parked on a future timer — must be QUIET this turn.
    writeFileSync(join(dir, '.fray', 'pr-parked.md'), `---\ntitle: parked\nstatus: blocked\nstatus_text: "awaiting other PR"\nrevalidate_at: ${future}\n---\nbody\n`);
    // CONTROL: an ordinary blocked thread with no timer — surfaces in the awaiting-you queue.
    writeFileSync(join(dir, '.fray', 'plain.md'), '---\ntitle: plain\nstatus: blocked\nstatus_text: "needs a human call"\n---\nbody\n');

    const out = runReminder(dir, sess);

    assert.match(out, /REVALIDATE DUE: pr-due/, 'the due thread surfaces loudly by name');
    assert.match(out, /last checked 2026-06-01T00:00:00Z/, 'last_checked is shown');

    // The parked (future) thread is fully quiet: not loud, not in the awaiting-you queue,
    // not in the pending one-liner.
    assert.doesNotMatch(out, /pr-parked/, 'the future-dated thread is suppressed entirely');

    // The due thread is owned by the timer, so it is NOT also in the ⚖ awaiting-you queue.
    assert.doesNotMatch(out, /\[pr-due\]/, 'a due thread is not double-surfaced in the decisions queue');

    // The control thread (no timer) still surfaces normally.
    assert.match(out, /\[plain\] needs a human call/, 'a plain blocked thread is unaffected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
