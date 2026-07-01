// @ts-check
/**
 * fray — `fray-update` (thread-update.mjs) write-time invariant tests.
 * Run with: `node --test cc/scripts/fray/*.test.mjs`.
 *
 * The load-bearing invariant: setting `status: blocked` with NO resolution mechanism (no
 * non-empty `blocking_threads`/`depends_on`/`revalidate_at`) means the thread is HUMAN-blocked,
 * and a human-blocked thread REQUIRES a `status_text` (the ⚖ awaiting-you queue derives from it).
 * The tool must REFUSE to write the malformed thread the unified model is designed to forbid —
 * including the edge where a mechanism key is `--set` to an EMPTY value (`[]`, `[ ]`, empty
 * string), which does NOT count as a machine field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPDATE = join(dirname(fileURLToPath(import.meta.url)), 'thread-update.mjs');

/** Run fray-update against a fixture dir; returns {code, stderr}. Never throws on non-zero. */
function update(dir, argv) {
  try {
    execFileSync(process.execPath, [UPDATE, ...argv], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stderr: String(e.stderr ?? '') };
  }
}

/** Stand up a `.fray/<slug>.md` fixture with the given frontmatter body. */
function seed(dir, slug, fm) {
  mkdirSync(join(dir, '.fray'), { recursive: true });
  writeFileSync(join(dir, '.fray', `${slug}.md`), `---\ntitle: t\n${fm}\n---\nbody\n`);
}

test('fray-update: blocked with no mechanism and no status_text is REFUSED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-upd-'));
  try {
    seed(dir, 't', 'status: active');
    const r = update(dir, ['t', '--status', 'blocked']);
    assert.equal(r.code, 1, 'must exit non-zero');
    assert.match(r.stderr, /HUMAN-blocked.*REQUIRES a write-up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray-update: --set blocking_threads=[] (empty) does NOT satisfy the machine-field exemption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-upd-'));
  try {
    seed(dir, 't', 'status: active');
    // An empty list is "no machine field" → still human-blocked → still needs status_text.
    for (const empty of ['blocking_threads=[]', 'blocking_threads=[ ]', 'revalidate_at=']) {
      const r = update(dir, ['t', '--status', 'blocked', '--set', empty]);
      assert.equal(r.code, 1, `must refuse for --set ${empty}`);
      assert.match(r.stderr, /HUMAN-blocked/, `--set ${empty} must not bypass the invariant`);
    }
    // The thread was never rewritten to the malformed state.
    assert.match(readFileSync(join(dir, '.fray', 't.md'), 'utf8'), /status: active/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray-update: a real machine field OR a status_text satisfies the invariant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-upd-'));
  try {
    // (a) a non-empty blocking_threads exempts it (machine-blocked).
    seed(dir, 'm', 'status: active');
    assert.equal(update(dir, ['m', '--status', 'blocked', '--set', 'blocking_threads=[dep]']).code, 0);
    // (b) a status_text write-up satisfies it (human-blocked, properly).
    seed(dir, 'h', 'status: active');
    assert.equal(update(dir, ['h', '--status', 'blocked', '--status-text', 'which default?']).code, 0);
    assert.match(readFileSync(join(dir, '.fray', 'h.md'), 'utf8'), /status_text: .*which default\?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
