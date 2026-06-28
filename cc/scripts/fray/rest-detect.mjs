// @ts-check
/**
 * fray — "rest-on-waiter" detection. PURE, dependency-free, and unit-tested
 * (rest-detect.test.mjs) so the SubagentStop guard (hooks/fray-rest-guard.mjs)
 * can stay a thin I/O shell around this judgment.
 *
 * THE PROBLEM it detects: a background sub-agent backgrounds a long op (a build, a
 * test run, a CI watch, an install) and then RESTS — going idle and handing control
 * back — instead of running the op to completion. The agent's final message is a
 * "parking on a waiter/monitor" tell ("I'll await the monitor's notification", "the
 * background waiter will notify me", "standing by"). That strands the task: the
 * orchestrator must manually resume it. The guard BLOCKS that stop and redirects the
 * agent to poll the op inline and finish.
 *
 * THE DISCRIMINATOR (high-precision by design — a FALSE block is worse than a missed
 * rest, so we only fire on a clear two-signal match): require BOTH
 *   (1) a FUTURE/ONGOING parking intent — "await(ing)", "I'll wait", "holding",
 *       "standing by", "letting it complete", "will notify me", "re-invoke me",
 *       "rather than poll", "until then" — NOT a past-tense "I waited … and it
 *       completed" (that's a genuine done), AND
 *   (2) a BACKGROUND-MECHANISM noun — "monitor", "waiter", "watcher", "background",
 *       "completion notification", "notify", "re-invoke".
 * Both must be present (order-independent). A genuine deliverable ("Done.",
 * "Verdict: …", "PR #N open", "Report: …", "complete — here's the table") carries no
 * parking-intent verb, so it never matches.
 */
import { readFileSync } from 'node:fs';

/**
 * FUTURE/ONGOING parking intent — the agent declaring it will idle and be woken.
 * Deliberately excludes bare "complete"/"waited for" (past tense = done, not parking).
 */
const PARK =
  /\b(?:await(?:ing)?|waiting for|i'?ll wait|i'?ll await|holding(?: here)?|pausing|paused here|standing by|letting it (?:complete|finish|run)|will notify me|notify me when|re-?invoke(?:s|d)? me|holding until|until then|rather than poll(?:ing)?)\b/i;

/** BACKGROUND-MECHANISM noun — the thing it's resting ON. */
const MECH =
  /\b(?:monitor|waiter|watcher|background(?:ed)?|completion notification|notify(?:ing)? me|re-?invoke)\b/i;

/**
 * High-confidence single phrases that ALONE prove a waiter-rest (so a message that
 * trips only one of PARK/MECH but contains one of these still blocks). Kept tight.
 */
const STRONG = [
  /\bthe (?:background )?(?:waiter|monitor|watcher)\b[^.]*\b(?:will|to) (?:notify|re-?invoke|wake)\b/i,
  /\brather than poll(?:ing)?\b/i,
  /\bstanding by\b/i,
  /\bwill (?:notify|re-?invoke|ping|wake) me\b/i,
];

/**
 * Does this final-assistant text read as RESTING ON A WAITER/MONITOR (a false rest
 * that should be blocked) rather than a genuine deliverable?
 * @param {string|null|undefined} text the agent's last assistant message text
 * @returns {boolean} true ONLY on a high-confidence waiter-rest match
 */
export function detectWaiterRest(text) {
  if (!text || typeof text !== 'string') return false;
  // Scan a bounded tail — the parking tell is always at the END of the message, and
  // scanning the whole of a long report risks a stray match in earlier narration.
  const tail = text.length > 1200 ? text.slice(-1200) : text;
  if (STRONG.some((re) => re.test(tail))) return true;
  return PARK.test(tail) && MECH.test(tail);
}

/**
 * Extract the LAST assistant message's joined text from a transcript .jsonl.
 * Each line is a JSON event; an assistant turn has `type:"assistant"` and
 * `message.content` is an array of blocks; text blocks are `{type:"text", text}`.
 * Returns the joined text of the latest assistant turn that HAS any text block, or
 * null if none/unreadable (→ caller fails open).
 * @param {string|null|undefined} transcriptPath
 * @returns {string|null}
 */
export function lastAssistantText(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string') return null;
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      const texts = o.message.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      if (texts.length) return texts.join('\n').trim();
    }
    return null;
  } catch {
    return null;
  }
}
