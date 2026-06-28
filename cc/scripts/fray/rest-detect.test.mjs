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
import { detectWaiterRest } from './rest-detect.mjs';

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
