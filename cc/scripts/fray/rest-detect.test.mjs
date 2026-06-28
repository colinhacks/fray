// @ts-check
/**
 * fray — rest-on-waiter detection tests. Run with: `node --test cc/scripts/fray/`.
 *
 * The contract: detectWaiterRest MUST block every real waiter-rest final message
 * captured from production (false rests that strand a task) and MUST allow every
 * genuine deliverable. A false positive (blocking a done agent) is the worse failure,
 * so the allow-set is the load-bearing half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectWaiterRest,
  isBackgroundLaunch,
  detectStructuralRestFromToolUses,
  detectStructuralRest,
  lastToolUse,
} from './rest-detect.mjs';

// The six REAL resting messages from production — all FALSE rests that must BLOCK.
const REAL_RESTS = [
  "I'll wait for the test to complete before landing the changes. The waiter will notify me.",
  "nub relink in progress. I'll await the monitor's completion notification rather than poll.",
  'The background waiter b96ur29ys will notify me when target/release/nub exists. Standing by.',
  'The background CI watcher is running and will re-invoke me when the Release run reaches a terminal state. Holding here until then.',
  'Awaiting the install to complete. The blocking waiter will notify me.',
  'Letting it complete — the Monitor will notify.',
];

// Genuine completions / deliverables — must ALL be ALLOWED (not blocked).
const GENUINE = [
  'Done.',
  'Verdict: the bug is a race in the linker; fix pushed in PR #412.',
  'PR #221 open: https://github.com/nubjs/nub/pull/221',
  'Report: 3 of 4 prongs reproduced; table below.',
  "complete — here's the table of results.",
  'Build succeeded; all tests green. Committed as a1b2c3d and pushed.',
  'I waited for the build earlier and it completed; here are the results.',
  'Follow-ups: none. The CI watcher already confirmed the run is green and the PR merged.',
  'Investigated the install path; the cache hit count is 412. No code change needed.',
  'Implemented the guard and added a test. Final message: all assertions pass.',
];

test('blocks every real production waiter-rest', () => {
  for (const msg of REAL_RESTS) {
    assert.equal(detectWaiterRest(msg), true, `should BLOCK: ${msg}`);
  }
});

test('allows every genuine completion / deliverable', () => {
  for (const msg of GENUINE) {
    assert.equal(detectWaiterRest(msg), false, `should ALLOW: ${msg}`);
  }
});

test('fails open on empty / non-string input', () => {
  assert.equal(detectWaiterRest(''), false);
  assert.equal(detectWaiterRest(null), false);
  assert.equal(detectWaiterRest(undefined), false);
  // @ts-expect-error — intentional wrong type
  assert.equal(detectWaiterRest({}), false);
});

test('only the tail is judged — a long, clearly-done report that merely MENTIONED a watcher earlier does not block', () => {
  const longReport =
    'I set up a background CI watcher earlier to monitor the run. '.repeat(20) +
    '\n\nVerdict: the run finished green; PR #99 merged. Follow-ups: none. Done.';
  assert.equal(detectWaiterRest(longReport), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL signal — keys on the TOOL-USE history (real transcript schemas).
// ─────────────────────────────────────────────────────────────────────────────

// Block shapes grounded in REAL transcripts (verified 2026-06-28).
const bgBash = { type: 'tool_use', name: 'Bash', input: { command: 'cargo build &', run_in_background: true } };
const bgAgent = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'x', prompt: 'go', run_in_background: true } };
const monitor = { type: 'tool_use', name: 'Monitor', input: { command: 'until grep ...; do sleep 5; done', timeout_ms: 600000 } };
const wakeup = { type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 1800, reason: 'backstop', prompt: '<<x>>' } };
const fgBash = { type: 'tool_use', name: 'Bash', input: { command: 'cat out.txt', run_in_background: false } };
const fgRead = { type: 'tool_use', name: 'Read', input: { file_path: '/x' } };
const fgEdit = { type: 'tool_use', name: 'Edit', input: { file_path: '/x', old_string: 'a', new_string: 'b' } };

test('isBackgroundLaunch — classifies real bg-launch tool_use shapes', () => {
  for (const b of [bgBash, bgAgent, monitor, wakeup]) {
    assert.equal(isBackgroundLaunch(b), true, `should be a bg-launch: ${b.name}`);
  }
  for (const b of [fgBash, fgRead, fgEdit]) {
    assert.equal(isBackgroundLaunch(b), false, `should NOT be a bg-launch: ${b.name}`);
  }
  // fail-closed on junk
  for (const b of [null, undefined, {}, { type: 'text', text: 'hi' }, { type: 'tool_use' }]) {
    assert.equal(isBackgroundLaunch(b), false);
  }
});

test('structural — BLOCKS when the LAST tool_use is a background-launch', () => {
  // backgrounded a build and then ended the turn
  assert.equal(detectStructuralRestFromToolUses([fgRead, fgEdit, bgBash]), true);
  // armed a Monitor as the last action
  assert.equal(detectStructuralRestFromToolUses([fgBash, monitor]), true);
  // armed a ScheduleWakeup as the last action
  assert.equal(detectStructuralRestFromToolUses([wakeup]), true);
  // dispatched a background sub-agent and rested
  assert.equal(detectStructuralRestFromToolUses([fgEdit, bgAgent]), true);
});

test('structural — ALLOWS a genuine finish (last tool_use is foreground work)', () => {
  // backgrounded EARLY, then polled inline + committed → last action is a foreground Bash
  assert.equal(detectStructuralRestFromToolUses([bgBash, fgBash, fgBash]), false);
  // finished on an Edit / Read
  assert.equal(detectStructuralRestFromToolUses([bgAgent, fgEdit]), false);
  assert.equal(detectStructuralRestFromToolUses([monitor, fgRead]), false);
  // no tool_use at all (pure text deliverable) → never blocks
  assert.equal(detectStructuralRestFromToolUses([]), false);
  assert.equal(detectStructuralRestFromToolUses(null), false);
});

test('lastToolUse + detectStructuralRest — read a real-shaped transcript .jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fray-rest-'));
  try {
    // Transcript schema mirrors production: each assistant content-block is its own
    // event line; an assistant turn carries message.content as an array; the bg-launch
    // is the last tool_use, followed by tool_result + a final text "rest" message.
    const ev = (o) => JSON.stringify(o);
    const blocked = join(dir, 'blocked.jsonl');
    writeFileSync(
      blocked,
      [
        ev({ type: 'assistant', message: { role: 'assistant', content: [fgEdit] } }),
        ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
        ev({ type: 'assistant', message: { role: 'assistant', content: [bgBash] } }),
        ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'started bg' }] } }),
        ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Kicked off the build; standing by.' }] } }),
      ].join('\n') + '\n',
    );
    assert.equal(isBackgroundLaunch(lastToolUse(blocked)), true);
    assert.equal(detectStructuralRest(blocked), true);

    // A genuine finish: bg-launch early, then inline poll (foreground) is the last tool_use.
    const allowed = join(dir, 'allowed.jsonl');
    writeFileSync(
      allowed,
      [
        ev({ type: 'assistant', message: { role: 'assistant', content: [bgBash] } }),
        ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'started' }] } }),
        ev({ type: 'assistant', message: { role: 'assistant', content: [fgBash] } }),
        ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'BUILD DONE' }] } }),
        ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Build green. Done.' }] } }),
      ].join('\n') + '\n',
    );
    assert.equal(detectStructuralRest(allowed), false);

    // Fail-open: missing / unreadable transcript → false (no block).
    assert.equal(detectStructuralRest(join(dir, 'nope.jsonl')), false);
    assert.equal(detectStructuralRest(null), false);
    assert.equal(detectStructuralRest(undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
