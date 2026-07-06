// @ts-check
/**
 * fray — orchestration-hardening tests (2026-07-06). Run: `node --test 'cc/scripts/fray/*.test.mjs'`.
 *
 * Covers the six anti-treadmill / anti-drop behaviors:
 *   #1 STAMP-ON-AGENT-COMPLETION — an owning-agent thread edit is owner-clean, NOT drift
 *      (ownerCleanMtime / assessDrift / computeBoardDrift), and the SubagentStop hook stamps it.
 *   #2 SELF-SATISFYING STOP — an owner-clean board (⚖ empty, no non-owning drift) lets the stop
 *      through SILENTLY; a genuinely-dirty board blocks.
 *   #3 SCOPED STALENESS — reconcileStampLastInstruction names the drifted thread(s).
 *   #4 STRUCTURED queued detection — only an UNCHECKED `- [ ]` follow-up flags (hasQueuedFollowup).
 *   #5 DEBOUNCE — a `dirty` nag holds until it persists > T min AND > K turns (debounceReconcileNag).
 *   #6 WATCHER/AGENT DROP-GUARD — a long-running still-alive agent with no terminal result gets a
 *      LOUD "VERIFY DIRECTLY" line (longRunningAgentLines), surfaced by the Stop hook.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ownerCleanMtime,
  stampOwnerReconciled,
  readOwnerReconciled,
  assessDrift,
  computeBoardDrift,
  hasQueuedFollowup,
  debounceReconcileNag,
  reconcileStampLastInstruction,
  writeLastReconcile,
  DEFAULT_RECONCILE_DEBOUNCE_MIN,
  DEFAULT_RECONCILE_DEBOUNCE_TURNS,
} from './config.mjs';
import { longRunningAgentLines } from './agent-liveness.mjs';
import { DEFAULT_LONG_RUNTIME_MIN, DEFAULT_DROPPED_MIN } from './agent-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REST_HOOK = join(HERE, '..', '..', 'hooks', 'fray-subagent-rest.mjs');
const STOP_HOOK = join(HERE, '..', '..', 'hooks', 'fray-stop-reminder.mjs');
const BACKSTOP = 120;

/** A throwaway ACTIVATED `.fray/` project (session sentinel ON). */
function activatedProject(sess = 'sess-oh') {
  const dir = mkdtempSync(join(tmpdir(), 'fray-oh-'));
  mkdirSync(join(dir, '.fray', '.session-state'), { recursive: true });
  writeFileSync(join(dir, '.fray', '.session-state', sess), 'on\n');
  return { dir, sess };
}

// ── #1 owner-clean predicate + owner-filtered drift ─────────────────────────────────
test('ownerCleanMtime: a mark ≥ current mtime is clean; no mark / stale mark is not', () => {
  assert.equal(ownerCleanMtime(1000, 1000), true, 'exactly at the mark → owning-agent edit → clean');
  assert.equal(ownerCleanMtime(999, 1000), true, 'below the mark → clean');
  assert.equal(ownerCleanMtime(1001, 1000), false, 'edited AFTER the owner mark → non-owning drift');
  assert.equal(ownerCleanMtime(1000, undefined), false, 'no mark → not clean (never suppress an unmarked thread)');
  assert.equal(ownerCleanMtime(0, 1000), false, 'unreadable mtime (0) → not clean');
});

test('assessDrift: an owning-agent edit is excluded; a non-owning edit is dirty + named', () => {
  const last = 1_000_000;
  const records = [
    { slug: 'owned', status: 'active', mtimeMs: last + 5000 }, // edited after reconcile, BUT owner-clean
    { slug: 'drifted', status: 'active', mtimeMs: last + 9000 }, // edited after reconcile, no owner mark
    { slug: 'done-x', status: 'done', mtimeMs: last + 9999 }, // terminal → never counts
  ];
  const owner = { owned: last + 5000 };
  const d = assessDrift({ records, ownerReconciled: owner, lastReconcileMs: last, backstopMin: BACKSTOP, now: last + 10_000 });
  assert.equal(d.nag, true, 'the non-owning edit trips the dirty-gate');
  assert.equal(d.reason, 'dirty');
  assert.deepEqual(d.dirtySlugs, ['drifted'], 'ONLY the non-owning thread is named — the write-ownership edit is excluded');
});

test('assessDrift: a board whose only change is owning-agent edits is CLEAN (no treadmill)', () => {
  const last = 1_000_000;
  const records = [{ slug: 'owned', status: 'active', mtimeMs: last + 5000 }];
  const d = assessDrift({ records, ownerReconciled: { owned: last + 5000 }, lastReconcileMs: last, backstopMin: BACKSTOP, now: last + 6000 });
  assert.equal(d.nag, false, 'an agent editing its OWN thread does not nag a board re-ground');
  assert.deepEqual(d.dirtySlugs, []);
});

// ── #1 write side: the SubagentStop hook stamps owner-reconciled ─────────────────────
test('fray-subagent-rest: a thread-bound rest stamps .owner-reconciled to the thread mtime', () => {
  const { dir, sess } = activatedProject();
  try {
    writeFileSync(join(dir, '.fray', '.dispatch-count'), '1\n'); // fray HAS dispatched here (attribution gate)
    writeFileSync(join(dir, '.fray', 'mythread.md'), '---\ntitle: t\nstatus: active\n---\nbody\n');
    writeFileSync(join(dir, '.fray', '.agent-bindings.jsonl'),
      JSON.stringify({ ts: '2026-07-06T10:00:00.000Z', agent_id: 'AG1', thread: 'mythread', label: 'L' }) + '\n');
    const threadMtime = statSync(join(dir, '.fray', 'mythread.md')).mtimeMs;

    execFileSync(process.execPath, [REST_HOOK], {
      input: JSON.stringify({ session_id: sess, agent_id: 'AG1', transcript_path: '/x/proj/sess.jsonl' }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: sess }, encoding: 'utf8',
    });

    const marks = readOwnerReconciled(dir);
    assert.ok(Math.abs(marks.mythread - threadMtime) < 5, 'the owning agent reconciled the thread up to its current mtime');
    // And that mark makes the thread owner-clean for the dirty-gate.
    assert.equal(ownerCleanMtime(threadMtime, marks.mythread), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #3 scoped staleness instruction ─────────────────────────────────────────────────
test('reconcileStampLastInstruction: scoped names the threads; unscoped says every non-terminal', () => {
  const scoped = reconcileStampLastInstruction(['alpha', 'beta']);
  assert.match(scoped, /re-ground alpha, beta/, 'the specific drifted threads are named');
  assert.doesNotMatch(scoped, /re-ground EVERY non-terminal/, 'scoped does NOT say "every non-terminal thread"');
  assert.match(reconcileStampLastInstruction(), /re-ground EVERY non-terminal thread/, 'unscoped = full sweep (backstop/first case)');
  assert.match(reconcileStampLastInstruction([]), /re-ground EVERY non-terminal thread/, 'empty scope = full sweep');
});

// ── #4 structured queued-followup detection ─────────────────────────────────────────
test('hasQueuedFollowup: only an UNCHECKED `- [ ]` follow-up flags; checked / prose never do', () => {
  assert.equal(hasQueuedFollowup('- [ ] QUEUED: dispatch review on AG1 return'), true, 'unchecked QUEUED item flags');
  assert.equal(hasQueuedFollowup('- [ ] dispatch the self-review on its return'), true, 'unchecked "dispatch … return" flags');
  assert.equal(hasQueuedFollowup('- [x] QUEUED: dispatch review on AG1 return'), false, 'a CHECKED-OFF item never flags (the false-positive killed)');
  assert.equal(hasQueuedFollowup('We already QUEUED and drained the follow-up.'), false, 'a prose mention of QUEUED never flags');
  assert.equal(hasQueuedFollowup('- [ ] land the PR'), false, 'an unchecked item without the follow-up shape does not flag');
  assert.equal(hasQueuedFollowup('title: t\nstatus: active\n'), false, 'no checkbox → no flag');
});

// ── #5 debounce ─────────────────────────────────────────────────────────────────────
test('debounceReconcileNag: dirty holds for T min AND K turns; first/backstop nag at once; clean resets', () => {
  const min = DEFAULT_RECONCILE_DEBOUNCE_MIN, turns = DEFAULT_RECONCILE_DEBOUNCE_TURNS, now = 5_000_000;
  // clean → no nag, window cleared
  assert.deepEqual(debounceReconcileNag({ reason: null, now, turns: 9, state: { dirty_since_ms: 1, dirty_since_turn: 1 }, debounceMin: min, debounceTurns: turns }), { nag: false, state: {} });
  // first + backstop → immediate, no window
  assert.equal(debounceReconcileNag({ reason: 'first', now, turns: 1, state: {}, debounceMin: min, debounceTurns: turns }).nag, true);
  assert.equal(debounceReconcileNag({ reason: 'backstop', now, turns: 1, state: {}, debounceMin: min, debounceTurns: turns }).nag, true);
  // dirty, first sighting → silent, starts the window
  const first = debounceReconcileNag({ reason: 'dirty', now, turns: 3, state: {}, debounceMin: min, debounceTurns: turns });
  assert.equal(first.nag, false, 'dirty first-sight is debounced');
  assert.deepEqual(first.state, { dirty_since_ms: now, dirty_since_turn: 3 });
  // dirty, aged in turns but NOT in time → still silent (AND, not OR)
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + 60_000, turns: 3 + turns, state: first.state, debounceMin: min, debounceTurns: turns }).nag, false, 'enough turns but < T minutes → still held');
  // dirty, aged in time but NOT in turns → still silent
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + (min + 1) * 60_000, turns: 3 + 1, state: first.state, debounceMin: min, debounceTurns: turns }).nag, false, 'enough time but < K turns → still held');
  // dirty, aged past BOTH → nag
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + (min + 1) * 60_000, turns: 3 + turns, state: first.state, debounceMin: min, debounceTurns: turns }).nag, true, 'past both thresholds → fires');
});

// ── #2 self-satisfying stop + genuine-drift block ───────────────────────────────────
/** Run the Stop hook; return `{ blocked, ctx }` (ctx = additionalContext when it blocked). */
function runStop(dir, sess, payload = {}) {
  const raw = execFileSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify({ session_id: sess, transcript_path: '/x/proj/sess.jsonl', ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: sess }, encoding: 'utf8',
  });
  if (!raw.trim()) return { blocked: false, ctx: '' };
  const j = JSON.parse(raw);
  return { blocked: j.decision === 'block', ctx: j.hookSpecificOutput?.additionalContext ?? '' };
}

test('fray-stop-reminder: an OWNER-CLEAN board lets the stop through SILENTLY (self-satisfying)', () => {
  const { dir, sess } = activatedProject();
  try {
    // One active thread whose latest edit is its OWNING AGENT's (owner-clean), reconcile stamped
    // in the recent past. No decisions, no rests, no bindings → nothing genuine to nag.
    writeFileSync(join(dir, '.fray', 't.md'), '---\ntitle: t\nstatus: active\n---\nbody\n');
    const mt = statSync(join(dir, '.fray', 't.md')).mtimeMs;
    stampOwnerReconciled(dir, 't', mt); // the owning agent reconciled it up to here
    writeLastReconcile(dir, Date.now() - 5 * 60_000); // thread mtime is NEWER than this → dirty WITHOUT the owner-filter
    const r = runStop(dir, sess);
    assert.equal(r.blocked, false, 'owner-clean + no decision/queue/rest → SILENT stop (no treadmill)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray-stop-reminder: a GENUINELY-dirty board (non-owning edit) blocks with a SCOPED reconcile nudge', () => {
  const { dir, sess } = activatedProject();
  try {
    writeFileSync(join(dir, '.fray', 'drift.md'), '---\ntitle: d\nstatus: active\n---\nbody\n');
    writeLastReconcile(dir, Date.now() - 5 * 60_000); // thread edited AFTER; NO owner mark → non-owning drift
    const r = runStop(dir, sess);
    assert.equal(r.blocked, true, 'genuine non-owning drift blocks the idle');
    assert.match(r.ctx, /re-ground drift/, 'the nudge names the drifted thread (scoped)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fray-stop-reminder: an un-drained QUEUED follow-up blocks even when the reconcile stamp is fresh', () => {
  const { dir, sess } = activatedProject();
  try {
    writeFileSync(join(dir, '.fray', 'q.md'), '---\ntitle: q\nstatus: active\n---\n## Steps\n- [ ] QUEUED: dispatch the review on AG1 return\n');
    const mt = statSync(join(dir, '.fray', 'q.md')).mtimeMs;
    stampOwnerReconciled(dir, 'q', mt); // owner-clean (not drift) …
    writeLastReconcile(dir, Date.now()); // … and stamp fresh — the ONLY genuine work is the un-drained queue
    const r = runStop(dir, sess);
    assert.equal(r.blocked, true, 'an un-drained queued follow-up is genuine work → block');
    assert.match(r.ctx, /drain queued follow-ups in q/, 'the queued thread is named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #6 watcher/agent drop-guard ─────────────────────────────────────────────────────
/**
 * Fixture for a long-running-but-still-alive agent: an active thread, a binding dispatched
 * `runtimeMin` ago, and a fresh `.output` (age `outputAgeMin`) under a /private/tmp/claude-* tasks
 * dir reachable from `transcriptPath`. Mirrors liveness.test.mjs's fixture, parametrizing the
 * dispatch time (runtime) which is what the drop-guard keys on.
 */
let fixtureSeq = 0;
function longRunningFixture({ runtimeMin, outputAgeMin, status = 'active' }) {
  // UNIQUE per fixture: `agentAge`'s fallback globs ALL /private/tmp/claude-* task dirs, so two
  // concurrent fixtures sharing an agentId/proj/session would cross-read each other's output.
  const uid = `${process.pid}-${fixtureSeq++}`;
  const agentId = `WATCH_${uid}`;
  const dir = mkdtempSync(join(tmpdir(), 'fray-dropguard-'));
  mkdirSync(join(dir, '.fray'), { recursive: true });
  writeFileSync(join(dir, '.fray', 'watch.md'), `---\ntitle: w\nstatus: ${status}\n---\nbody\n`);
  const now = Date.now();
  const dispatchedIso = new Date(now - runtimeMin * 60_000).toISOString();
  writeFileSync(join(dir, '.fray', '.agent-bindings.jsonl'),
    JSON.stringify({ ts: dispatchedIso, agent_id: agentId, thread: 'watch', label: 'ci-watch' }) + '\n');

  const projSlug = `proj-${uid}`, session = `sess-${uid}`;
  const claudeRoot = mkdtempSync(join('/private/tmp', 'claude-fraytest-'));
  const tasksDir = join(claudeRoot, projSlug, session, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const p = join(tasksDir, `${agentId}.output`);
  writeFileSync(p, 'x');
  if (outputAgeMin != null) {
    const t = (now - outputAgeMin * 60_000) / 1000;
    utimesSync(p, t, t);
  }
  const transcriptPath = join('/anything', projSlug, `${session}.jsonl`);
  return { dir, sess: session, transcriptPath, agentId, outputPath: p, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(claudeRoot, { recursive: true, force: true }); } };
}

/** Rewrite a fixture's binding so its agent's RUNTIME (now − dispatch ts) is `runtimeMin`, and
 *  re-touch its output to `outputAgeMin` (keeps it fresh) — to simulate an idle-wait watcher aging
 *  past a new drop-guard tier without re-creating the whole fixture (state persists across runs). */
function ageFixture(fx, runtimeMin, outputAgeMin) {
  const now = Date.now();
  writeFileSync(join(fx.dir, '.fray', '.agent-bindings.jsonl'),
    JSON.stringify({ ts: new Date(now - runtimeMin * 60_000).toISOString(), agent_id: fx.agentId, thread: 'watch', label: 'ci-watch' }) + '\n');
  const t = (now - outputAgeMin * 60_000) / 1000;
  utimesSync(fx.outputPath, t, t);
}

test('longRunningAgentLines: a long-running STILL-ALIVE agent gets a loud VERIFY DIRECTLY line', () => {
  const fx = longRunningFixture({ runtimeMin: DEFAULT_LONG_RUNTIME_MIN + 10, outputAgeMin: 5 });
  try {
    const lines = longRunningAgentLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].slug, 'watch');
    assert.equal(lines[0].agentId, fx.agentId);
    assert.match(lines[0].line, /VERIFY DIRECTLY — watch/);
    assert.match(lines[0].line, /can HANG on a stuck\/ghost CI check/);
  } finally {
    fx.cleanup();
  }
});

test('longRunningAgentLines: a SHORT-runtime agent, and a long-runtime-but-STALE one, are NOT flagged', () => {
  const fresh = longRunningFixture({ runtimeMin: 10, outputAgeMin: 2 }); // under the runtime threshold
  const stale = longRunningFixture({ runtimeMin: DEFAULT_LONG_RUNTIME_MIN + 30, outputAgeMin: DEFAULT_DROPPED_MIN + 5 }); // stale = the 'dropped' case, not this one
  try {
    assert.equal(longRunningAgentLines({ transcriptPath: fresh.transcriptPath, projectDir: fresh.dir }).length, 0, 'short runtime → no verify flag');
    assert.equal(longRunningAgentLines({ transcriptPath: stale.transcriptPath, projectDir: stale.dir }).length, 0, 'long but STALE is the dropped signal, not the drop-guard (no double-nag)');
  } finally {
    fresh.cleanup();
    stale.cleanup();
  }
});

test('fray-stop-reminder: the drop-guard BLOCKS the idle with VERIFY DIRECTLY (the #327 forcing function)', () => {
  const fx = longRunningFixture({ runtimeMin: DEFAULT_LONG_RUNTIME_MIN + 10, outputAgeMin: 5 });
  try {
    // Activate the fixture's session so the Stop hook is live.
    mkdirSync(join(fx.dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(fx.dir, '.fray', '.session-state', fx.sess), 'on\n');
    const r = runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath });
    assert.equal(r.blocked, true, 'a long-running still-alive agent forces a stop block');
    assert.match(r.ctx, /VERIFY DIRECTLY/, 'the block tells the orchestrator to check the target itself');
    // And it dedups WITHIN a tier: the same agent at the same runtime does not re-block next idle.
    const r2 = runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath });
    assert.doesNotMatch(r2.ctx, /VERIFY DIRECTLY/, 'same tier → no re-block (minimum-nag)');
  } finally {
    fx.cleanup();
  }
});

test('fray-stop-reminder: the drop-guard RE-ARMS at coarse runtime multiples (a hung idle-wait watcher forces a SECOND block)', () => {
  const fx = longRunningFixture({ runtimeMin: DEFAULT_LONG_RUNTIME_MIN + 5, outputAgeMin: 5 }); // tier 1 (~1×)
  try {
    mkdirSync(join(fx.dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(fx.dir, '.fray', '.session-state', fx.sess), 'on\n');

    // 1× → blocks (first crossing).
    assert.match(runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath }).ctx, /VERIFY DIRECTLY/, '1× → first block');
    // Still tier 1 on a subsequent idle → NO re-block (a permanent-per-tier dedup keeps it minimum-nag).
    assert.doesNotMatch(runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath }).ctx, /VERIFY DIRECTLY/, 'still tier 1 → no re-block');
    // The watcher stays hung and crosses ~2× → RE-ARMED → blocks AGAIN (the #327 idle-wait fix).
    ageFixture(fx, 2 * DEFAULT_LONG_RUNTIME_MIN + 5, 5);
    assert.match(runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath }).ctx, /VERIFY DIRECTLY/, '2× → re-armed, blocks again');
    // Still tier 2 → quiet again until ~3×.
    assert.doesNotMatch(runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath }).ctx, /VERIFY DIRECTLY/, 'still tier 2 → no re-block');
    // Crosses ~3× → blocks a THIRD time.
    ageFixture(fx, 3 * DEFAULT_LONG_RUNTIME_MIN + 5, 5);
    assert.match(runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath }).ctx, /VERIFY DIRECTLY/, '3× → re-armed again');
  } finally {
    fx.cleanup();
  }
});

test('fray-stop-reminder: a fresh sub-35m agent NEVER triggers the drop-guard (no VERIFY block)', () => {
  const fx = longRunningFixture({ runtimeMin: 10, outputAgeMin: 2 }); // well under the 1× threshold
  try {
    mkdirSync(join(fx.dir, '.fray', '.session-state'), { recursive: true });
    writeFileSync(join(fx.dir, '.fray', '.session-state', fx.sess), 'on\n');
    // The stop may still block for OTHER reasons (e.g. a first-reconcile baseline), but NEVER with
    // a drop-guard VERIFY line — the agent has not run long enough to be a hung-watcher suspect.
    assert.doesNotMatch(runStop(fx.dir, fx.sess, { transcript_path: fx.transcriptPath }).ctx, /VERIFY DIRECTLY/, 'sub-threshold runtime → no drop-guard');
  } finally {
    fx.cleanup();
  }
});
