// @ts-check
/**
 * fray — liveness derivation + binding-join tests. Run with: `node --test cc/scripts/fray/`.
 *
 * Covers the three false-positives the smart-surfacing rework fixes:
 *   1. keys on the NEWEST binding, never a superseded older agent;
 *   2. suppresses a thread whose PR is landing via the merge cascade (downstream);
 *   3. separates a TERMINATED/parked agent (rested + stale) from one mid-long-tool-call
 *      (stale but never rested → alive), and from a watcher-idle agent (generous threshold).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { deriveAgentState, DEFAULT_DROPPED_MIN, DEFAULT_IDLE_MIN } from './agent-status.mjs';
import { newestBindingByThread, downstreamThreads, restedAgentIds } from './agent-bindings.mjs';
import { agentLivenessLines, strandedThreadLines } from './agent-liveness.mjs';

// ── deriveAgentState — the pure derivation ──────────────────────────────────────
test('deriveAgentState: terminal/parked/downstream all suppress', () => {
  const old = { ageMin: 999, hasRested: true };
  assert.equal(deriveAgentState({ ...old, threadTerminal: true, threadActive: true }), 'terminal');
  assert.equal(deriveAgentState({ ...old, threadTerminal: false, threadActive: false }), 'terminal', 'parked thread suppresses');
  assert.equal(deriveAgentState({ ...old, threadTerminal: false, threadActive: true, threadDownstream: true }), 'terminal', 'mid-merge thread suppresses');
});

test('deriveAgentState: dropped requires active + stale + rested', () => {
  const base = { threadTerminal: false, threadActive: true, threadDownstream: false };
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_DROPPED_MIN + 5, hasRested: true }), 'dropped');
  // stale but NEVER rested = still inside one long tool call (a build) → alive, not dropped.
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_DROPPED_MIN + 5, hasRested: false }), 'idle', 'stale + never-rested is a long tool call, never dropped');
});

test('deriveAgentState: idle band and fresh', () => {
  const base = { threadTerminal: false, threadActive: true, hasRested: true };
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_IDLE_MIN + 1 }), 'idle');
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_IDLE_MIN - 1 }), 'fresh');
  assert.equal(deriveAgentState({ ...base, ageMin: null }), 'unknown', 'no output file → unknown, never a flag');
});

test('deriveAgentState: frozenMin is honored as the back-compat alias for droppedMin', () => {
  const s = deriveAgentState({ ageMin: 30, threadTerminal: false, threadActive: true, hasRested: true, frozenMin: 25 });
  assert.equal(s, 'dropped', 'old callers passing frozenMin=25 still drive the dropped threshold');
});

// ── binding joins — fixture-backed ──────────────────────────────────────────────
/** Make a throwaway project dir with a `.fray/`. */
function tmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'fray-livetest-'));
  mkdirSync(join(dir, '.fray'), { recursive: true });
  return dir;
}

test('newestBindingByThread: the newest binding wins, a superseded older agent is dropped', () => {
  const dir = tmpProject();
  try {
    const f = join(dir, '.fray', '.agent-bindings.jsonl');
    writeFileSync(f,
      JSON.stringify({ ts: '2026-06-26T10:00:00.000Z', agent_id: 'OLD_dead_agent', thread: 'gvs', label: 'old' }) + '\n' +
      JSON.stringify({ ts: '2026-06-26T11:00:00.000Z', agent_id: 'NEW_live_agent', thread: 'gvs', label: 'new' }) + '\n');
    const newest = newestBindingByThread(dir);
    assert.equal(newest.get('gvs')?.id, 'NEW_live_agent', 'FP#1: must key on the newest binding, never the superseded one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downstreamThreads + restedAgentIds parse their logs (fail-open on missing)', () => {
  const dir = tmpProject();
  try {
    assert.equal(downstreamThreads(dir).size, 0, 'no merge-queue → empty, suppress nothing');
    assert.equal(restedAgentIds(dir).size, 0, 'no rest log → empty');
    writeFileSync(join(dir, '.fray', 'merge-queue.jsonl'), JSON.stringify({ pr: 182, thread: 'shipping-thread' }) + '\n');
    writeFileSync(join(dir, '.fray', '.rested-agents.jsonl'), JSON.stringify({ agent_id: 'A1', thread: 't' }) + '\nbad json\n');
    assert.ok(downstreamThreads(dir).has('shipping-thread'));
    assert.ok(restedAgentIds(dir).has('A1'), 'parses valid lines, skips malformed ones');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── agentLivenessLines — the full thread-centric join ───────────────────────────
/**
 * Stand up a fixture: a project `.fray/<thread>.md` (status), a newest binding, an optional
 * rest record + merge-queue entry, and a tasks-dir `.output` file with a chosen age. Returns
 * `{ dir, transcriptPath, cleanup }`. The tasks dir lives under a `/tmp/claude-*` path so the
 * hook's `deriveTasksDir` (which globs `claude-*`) finds it from `transcriptPath`.
 */
function fixture({ status = 'active', agentId = 'A_newest', ageMin, rested = false, downstream = false, extraBindings = [], extraOutputs = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'fray-livejoin-'));
  mkdirSync(join(dir, '.fray'), { recursive: true });
  writeFileSync(join(dir, '.fray', 'mythread.md'), `---\ntitle: t\nstatus: ${status}\n---\nbody\n`);

  const bindings = [{ ts: '2026-06-26T09:00:00.000Z', agent_id: agentId, thread: 'mythread', label: 'L' }, ...extraBindings];
  writeFileSync(join(dir, '.fray', '.agent-bindings.jsonl'), bindings.map((b) => JSON.stringify(b)).join('\n') + '\n');
  if (rested) writeFileSync(join(dir, '.fray', '.rested-agents.jsonl'), JSON.stringify({ agent_id: agentId, thread: 'mythread' }) + '\n');
  if (downstream) writeFileSync(join(dir, '.fray', 'merge-queue.jsonl'), JSON.stringify({ pr: 1, thread: 'mythread' }) + '\n');

  // A tasks dir reachable from a transcript_path: /tmp/claude-<rand>/<projslug>/<session>/tasks.
  // deriveTasksDir only globs `/tmp` + `/private/tmp` for `claude-*` dirs, so the claude root
  // MUST live there (not under os.tmpdir(), which is /var/folders/... on macOS).
  const projSlug = 'proj-slug';
  const session = 'sess-123';
  const claudeRoot = mkdtempSync(join('/private/tmp', 'claude-fraytest-'));
  const tasksDir = join(claudeRoot, projSlug, session, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const now = Date.now();
  const writeOutput = (id, mins) => {
    const p = join(tasksDir, `${id}.output`);
    writeFileSync(p, 'x');
    if (mins != null) {
      const t = (now - mins * 60000) / 1000;
      utimesSync(p, t, t);
    }
  };
  if (ageMin != null) writeOutput(agentId, ageMin);
  for (const e of extraOutputs) writeOutput(e.id, e.ageMin);

  const transcriptPath = join('/anything', projSlug, `${session}.jsonl`);
  return { dir, transcriptPath, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(claudeRoot, { recursive: true, force: true }); } };
}

test('agentLivenessLines: active thread, newest agent quiet + rested → ACTIVE THREAD, NO LIVE AGENT', () => {
  const fx = fixture({ status: 'active', ageMin: DEFAULT_DROPPED_MIN + 10, rested: true });
  try {
    const lines = agentLivenessLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ACTIVE THREAD, NO LIVE AGENT: mythread/);
    assert.equal(strandedThreadLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir }).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('agentLivenessLines: FP#1 — a fresh NEWER agent suppresses the stale older one', () => {
  const fx = fixture({
    status: 'active', agentId: 'OLD_dead', ageMin: DEFAULT_DROPPED_MIN + 10, rested: true,
    extraBindings: [{ ts: '2026-06-26T12:00:00.000Z', agent_id: 'NEW_live', thread: 'mythread', label: 'fresh' }],
    extraOutputs: [{ id: 'NEW_live', ageMin: 1 }],
  });
  try {
    const lines = agentLivenessLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir });
    assert.equal(lines.length, 0, 'newest agent is fresh → nothing flagged even though the old one is stale');
  } finally {
    fx.cleanup();
  }
});

test('agentLivenessLines: FP#2 — a downstream (mid-merge) thread is suppressed', () => {
  const fx = fixture({ status: 'active', ageMin: DEFAULT_DROPPED_MIN + 10, rested: true, downstream: true });
  try {
    assert.equal(agentLivenessLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir }).length, 0, 'PR landing via the cascade → no flag');
  } finally {
    fx.cleanup();
  }
});

test('agentLivenessLines: FP#3 — stale but NEVER rested (long tool call) is a soft idle note, not dropped', () => {
  const fx = fixture({ status: 'active', ageMin: DEFAULT_DROPPED_MIN + 10, rested: false });
  try {
    const lines = agentLivenessLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /NO LIVE AGENT/, 'a never-rested stale agent is mid-build, not dropped');
    assert.match(lines[0], /quiet/);
    assert.equal(strandedThreadLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir }).length, 0, 'soft idle is never a per-turn stranded line');
  } finally {
    fx.cleanup();
  }
});

test('agentLivenessLines: a parked (non-active) thread never flags', () => {
  const fx = fixture({ status: 'blocked', ageMin: DEFAULT_DROPPED_MIN + 10, rested: true });
  try {
    assert.equal(agentLivenessLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir }).length, 0);
  } finally {
    fx.cleanup();
  }
});
