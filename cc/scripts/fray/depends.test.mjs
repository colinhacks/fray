// @ts-check
/**
 * fray — `depends_on` classification tests: THREAD-slug deps (backward-compatible) vs typed
 * EXTERNAL deps (`pr:`/`issue:`/`ci:`/`external:`). Run with `node --test cc/scripts/fray/`.
 *
 * Covers both layers:
 *   1. The pure `classifyDep` — bare → thread; recognized prefix → external; unrecognized
 *      prefix → thread (so a typo still surfaces as a dangling dep).
 *   2. The board's read path (`--json` / `--validate`): external deps NEVER dangle, they park
 *      the thread (ready=false while pending), and they suppress the enqueued drop-risk;
 *      thread-slug deps keep their existing READY/blocked/dangling behavior byte-for-byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDep, EXTERNAL_DEP_TYPES } from './config.mjs';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

/** Read the board once as JSON against a fixture dir. */
function board(dir) {
  return JSON.parse(execFileSync(process.execPath, [INDEX, '--json'], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8',
  }));
}
const byId = (threads) => Object.fromEntries(threads.map((t) => [t.id, t]));

test('classifyDep: bare entry is a thread slug (backward-compatible default)', () => {
  assert.deepEqual(classifyDep('my-thread'), { kind: 'thread', slug: 'my-thread' });
  assert.deepEqual(classifyDep('  spaced  '), { kind: 'thread', slug: 'spaced' });
});

test('classifyDep: recognized prefixes are external; label is the full entry', () => {
  for (const type of EXTERNAL_DEP_TYPES) {
    assert.deepEqual(classifyDep(`${type}:some/ref#1`), { kind: 'external', type, label: `${type}:some/ref#1` });
  }
  // Case-insensitive on the type; a real GitHub ref round-trips its `#N`.
  assert.deepEqual(classifyDep('PR:vercel/turborepo#13187'),
    { kind: 'external', type: 'pr', label: 'PR:vercel/turborepo#13187' });
});

test('classifyDep: an UNRECOGNIZED prefix stays a thread slug (a typo must still dangle)', () => {
  assert.deepEqual(classifyDep('gh:foo'), { kind: 'thread', slug: 'gh:foo' });
});

test('board: a thread-slug dep keeps existing READY/dangling behavior (backward-compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-dep-thread-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'dep-done.md'), '---\ntitle: d\nstatus: done\nstatus_text: x\n---\nb\n');
    writeFileSync(join(dir, '.fray', 'waiter.md'), '---\ntitle: w\nstatus: enqueued\nstatus_text: x\ndepends_on: [dep-done]\n---\nb\n');
    writeFileSync(join(dir, '.fray', 'dangles.md'), '---\ntitle: g\nstatus: enqueued\nstatus_text: x\ndepends_on: [nope]\n---\nb\n');
    const { threads, errors } = board(dir);
    const t = byId(threads);
    assert.equal(t['waiter'].ready, true, 'all thread deps terminal → READY');
    assert.deepEqual(t['waiter'].blockers, []);
    assert.ok(errors.some((e) => /dangles\.md.*unknown thread "nope"/.test(e)), 'dangling thread slug still errors');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: an EXTERNAL dep parks the thread (ready=false), never dangles, and suppresses drop-risk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-dep-ext-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    // enqueued, thread dep terminal, but a pending external PR gate → NOT ready, NOT drop-risk.
    writeFileSync(join(dir, '.fray', 'dep-done.md'), '---\ntitle: d\nstatus: done\nstatus_text: x\n---\nb\n');
    writeFileSync(join(dir, '.fray', 'parked.md'),
      '---\ntitle: p\nstatus: enqueued\nstatus_text: x\ndepends_on: [dep-done, pr:vercel/turborepo#13187, external:design-signoff]\n---\nb\n');
    const validate = execFileSync(process.execPath, [INDEX, '--validate'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(validate, /frontmatter OK/, 'external deps are not frontmatter errors');
    assert.doesNotMatch(validate, /drop risk/, 'a pending external gate suppresses the enqueued drop-risk warning');

    const { threads, errors } = board(dir);
    const t = byId(threads);
    assert.equal(errors.length, 0, 'no dangling error for pr:/external: deps');
    assert.deepEqual(t['parked'].threadDeps, ['dep-done']);
    assert.deepEqual(t['parked'].externalDeps.map((d) => d.label), ['pr:vercel/turborepo#13187', 'external:design-signoff']);
    assert.deepEqual(t['parked'].blockers, [], 'thread deps are clear');
    assert.equal(t['parked'].ready, false, 'still parked on the external gate → not READY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: a thread whose ONLY deps are external is parked, not a drop-risk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-dep-extonly-'));
  try {
    mkdirSync(join(dir, '.fray'), { recursive: true });
    writeFileSync(join(dir, '.fray', 'ci-wait.md'),
      '---\ntitle: c\nstatus: enqueued\nstatus_text: x\ndepends_on: [ci:release-build]\n---\nb\n');
    const { threads, errors } = board(dir);
    const t = byId(threads);
    assert.equal(errors.length, 0);
    assert.deepEqual(t['ci-wait'].threadDeps, []);
    assert.equal(t['ci-wait'].ready, false, 'no thread deps + external gate → not READY');
    assert.equal(t['ci-wait'].dropRisk, false, 'external-only enqueued thread is legitimately parked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
