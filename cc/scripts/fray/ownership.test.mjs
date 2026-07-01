// @ts-check
/**
 * fray — per-thread SESSION OWNERSHIP tests. Run with `node --test cc/scripts/fray/`.
 *
 * Covers the three layers:
 *   1. Pure functions — `isValidSessionId`, `effectiveOwnership`, `setOwner`/`readOwner`
 *      round-trip (incl. byte-preservation + removal), and heartbeat-derived `sessionLive`.
 *   2. The `fray claim / disown / owners` CLI — the claim policy: EASY on unowned/orphaned,
 *      REFUSED on a different LIVE owner unless `--force`.
 *   3. The board annotation — another live session's thread + an orphaned thread.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidSessionId, effectiveOwnership, setOwner, readOwner } from './ownership.mjs';
import { touchSessionHeartbeat, sessionLive, setSessionOverride, DEFAULT_OWNER_STALE_MIN } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.mjs');
const SID_A = 'sess-aaaaaaaa-1111';
const SID_B = 'sess-bbbbbbbb-2222';

/** Run the board CLI in a fixture dir as a given session; returns {stdout, status}. */
function fray(dir, args, sid = SID_A) {
  try {
    const stdout = execFileSync(process.execPath, [INDEX, ...args], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: sid },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (e) {
    // execFileSync throws on non-zero exit; surface stdout+stderr+status.
    return { stdout: (e.stdout || '') + (e.stderr || ''), status: e.status ?? 1 };
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fray-own-'));
  mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
  return dir;
}
function thread(dir, slug, extraFm = '') {
  writeFileSync(join(dir, '.fray', `${slug}.md`), `---\ntitle: ${slug}\nstatus: active\nstatus_text: x\n${extraFm}---\n## Next step\ngo\n`);
}

test('isValidSessionId: accepts uuid-ish tokens, rejects injection', () => {
  assert.ok(isValidSessionId('sess-1234.abcd-EF'));
  assert.ok(!isValidSessionId('has space'));
  assert.ok(!isValidSessionId('bad\nnewline'));
  assert.ok(!isValidSessionId(''));
});

test('effectiveOwnership: unowned / mine / other-live / orphaned', () => {
  assert.equal(effectiveOwnership(null, SID_A, false), 'unowned');
  assert.equal(effectiveOwnership(SID_A, SID_A, false), 'mine');
  assert.equal(effectiveOwnership(SID_B, SID_A, true), 'other-live');
  assert.equal(effectiveOwnership(SID_B, SID_A, false), 'orphaned');
});

test('setOwner/readOwner: round-trip, removal, and byte-preservation of the rest', () => {
  const dir = fixture();
  try {
    const body = '---\ntitle: t\nstatus: active\nstatus_text: "a note"\ndepends_on: [x]\n---\n## Body\nline1\nline2\n';
    writeFileSync(join(dir, '.fray', 't.md'), body);
    assert.equal(readOwner(dir, 't'), null, 'absent → null');

    setOwner(dir, 't', SID_A);
    assert.equal(readOwner(dir, 't'), SID_A, 'set → read back');
    const withOwner = readFileSync(join(dir, '.fray', 't.md'), 'utf8');
    assert.ok(withOwner.includes(`owner_session: ${SID_A}`));
    assert.ok(withOwner.includes('## Body\nline1\nline2'), 'body preserved');
    assert.ok(withOwner.includes('depends_on: [x]'), 'other frontmatter preserved');

    setOwner(dir, 't', SID_B); // update in place
    assert.equal(readOwner(dir, 't'), SID_B);

    setOwner(dir, 't', null); // remove
    assert.equal(readOwner(dir, 't'), null);
    assert.equal(readFileSync(join(dir, '.fray', 't.md'), 'utf8'), body, 'clearing restores the exact original bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionLive: fresh heartbeat is live; stale/absent/off is dead', () => {
  const dir = fixture();
  try {
    assert.equal(sessionLive(dir, SID_A, DEFAULT_OWNER_STALE_MIN), false, 'no heartbeat → dead');
    touchSessionHeartbeat(dir, SID_A);
    assert.equal(sessionLive(dir, SID_A, DEFAULT_OWNER_STALE_MIN), true, 'fresh → live');
    touchSessionHeartbeat(dir, SID_A, Date.now() - (DEFAULT_OWNER_STALE_MIN + 10) * 60_000);
    assert.equal(sessionLive(dir, SID_A, DEFAULT_OWNER_STALE_MIN), false, 'stale → dead');
    // An `off` sentinel makes even a fresh heartbeat read dead (session opted out).
    touchSessionHeartbeat(dir, SID_A);
    setSessionOverride(dir, SID_A, 'off');
    assert.equal(sessionLive(dir, SID_A, DEFAULT_OWNER_STALE_MIN), false, 'off sentinel → dead');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray claim: EASY on unowned; already-yours is a no-op', () => {
  const dir = fixture();
  try {
    thread(dir, 'task');
    let r = fray(dir, ['claim', 'task'], SID_A);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CLAIMED task.*was unowned/);
    assert.equal(readOwner(dir, 'task'), SID_A);
    r = fray(dir, ['claim', 'task'], SID_A);
    assert.match(r.stdout, /already yours/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray claim: a DIFFERENT LIVE owner is REFUSED without --force, taken WITH --force', () => {
  const dir = fixture();
  try {
    thread(dir, 'task', `owner_session: ${SID_B}\n`);
    touchSessionHeartbeat(dir, SID_B); // B is live
    let r = fray(dir, ['claim', 'task'], SID_A);
    assert.equal(r.status, 1, 'refused');
    assert.match(r.stdout, /owned by a DIFFERENT, LIVE session/);
    assert.equal(readOwner(dir, 'task'), SID_B, 'still B');
    r = fray(dir, ['claim', 'task', '--force'], SID_A);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /FORCE-taken from LIVE session/);
    assert.equal(readOwner(dir, 'task'), SID_A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray claim: an ORPHANED thread (dead owner) is EASILY claimable, no --force', () => {
  const dir = fixture();
  try {
    thread(dir, 'task', `owner_session: ${SID_B}\n`); // B owns but never heartbeats → dead
    const r = fray(dir, ['claim', 'task'], SID_A);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CLAIMED task.*was DEAD/);
    assert.equal(readOwner(dir, 'task'), SID_A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray owners --gc clears orphaned owners but leaves live + mine', () => {
  const dir = fixture();
  try {
    thread(dir, 'orph', `owner_session: ${SID_B}\n`); // dead owner
    thread(dir, 'live', `owner_session: ${SID_B}\n`);
    thread(dir, 'mine', `owner_session: ${SID_A}\n`);
    touchSessionHeartbeat(dir, SID_B); // makes BOTH orph+live "live"... so heartbeat only for live
    // Re-do: only `live` should be live. Since heartbeat is per-session, both B-owned threads share
    // B's liveness. Make them distinguishable: give `orph` a distinct dead session.
    setOwner(dir, 'orph', 'sess-dead-9999');
    const r = fray(dir, ['owners', '--gc'], SID_A);
    assert.equal(r.status, 0);
    assert.equal(readOwner(dir, 'orph'), null, 'orphaned cleared');
    assert.equal(readOwner(dir, 'live'), SID_B, 'live owner kept');
    assert.equal(readOwner(dir, 'mine'), SID_A, 'mine kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: annotates another-live-owner and orphaned threads', () => {
  const dir = fixture();
  try {
    thread(dir, 'busy', `owner_session: ${SID_B}\n`);
    touchSessionHeartbeat(dir, SID_B); // B live
    thread(dir, 'dead', `owner_session: sess-gone-0000\n`); // owner never beats → orphaned
    const r = fray(dir, ['--all'], SID_A);
    assert.match(r.stdout, /busy[\s\S]*owned by another LIVE session/);
    assert.match(r.stdout, /dead[\s\S]*orphaned — owner session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
