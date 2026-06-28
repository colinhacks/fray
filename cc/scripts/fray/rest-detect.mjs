// @ts-check
/**
 * fray — "rest-on-waiter" detection. PURE, dependency-free, and unit-tested
 * (rest-detect.test.mjs) so the SubagentStop guard (hooks/fray-rest-guard.mjs)
 * can stay a thin I/O shell around this judgment.
 *
 * THE PROBLEM it detects: a background sub-agent backgrounds a long op (a build, a
 * test run, a CI watch, an install) and then RESTS — going idle and handing control
 * back — instead of running the op to completion. That strands the task: the
 * orchestrator must manually resume it. The guard BLOCKS that stop and redirects the
 * agent to poll the op inline and finish.
 *
 * TWO SIGNALS, OR-ed (defense in depth). A stop is blocked if EITHER fires:
 *
 *   1. STRUCTURAL (primary, high-confidence) — {@link detectStructuralRest}: keyed on
 *      what the agent DID, not how it phrased it. The agent's LAST meaningful tool_use
 *      in the transcript was a BACKGROUND-LAUNCH (a `run_in_background` Bash/Agent/Task,
 *      or a Monitor/ScheduleWakeup waiter/timer) and nothing substantive ran after it —
 *      i.e. it kicked off a background op and ended its turn. This keys on the tool name
 *      + the `run_in_background` param, so it is immune to phrasing drift (the failure
 *      mode of the prose matcher below). See `isBackgroundLaunch`.
 *
 *   2. PROSE (fallback) — {@link detectWaiterRest}: the original phrasing matcher on the
 *      final assistant TEXT. Catches a waiter-rest the structural signal misses (e.g. the
 *      bg-launch was an earlier turn, or the harness shape changed). Demoted to secondary
 *      because string-matching the prose is fragile; kept because it costs nothing and the
 *      two signals fail in different directions.
 *
 * Why structural beats prose: the prose matcher hinges on the agent SAYING "I'll await
 * the monitor"; an agent that backgrounds-and-rests SILENTLY (no tell) slips it, and a
 * reworded tell slips it. The structural signal sees the bg-launch tool call regardless.
 *
 * (A fully-deterministic "is the launched bg task STILL RUNNING?" signal was investigated
 * and is NOT feasible from a hook: the harness `tasks/<id>.output` files are raw stdout
 * streams / jsonl symlinks with no authoritative running-vs-terminal status or exit-code
 * sidecar, and the SubagentStop stdin carries no task registry. mtime-liveness is
 * load-dependent and non-deterministic. So we rely on the tool-use structure, which is
 * deterministic from the transcript the hook already reads.)
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

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL SIGNAL — key on the agent's TOOL-USE history, not its prose.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BACKGROUND-LAUNCH tool names that are ALWAYS a waiter/timer launch by their very
 * nature — no parameter check needed. A Monitor (poll-until loop) or a ScheduleWakeup
 * (timer) IS, definitionally, "kick off a background wait." (Verified against real
 * transcripts: `{name:"Monitor", input:{command,timeout_ms,persistent}}` and
 * `{name:"ScheduleWakeup", input:{delaySeconds,reason,prompt}}`.)
 * @type {ReadonlySet<string>}
 */
const ALWAYS_BG_TOOLS = new Set(['Monitor', 'ScheduleWakeup']);

/**
 * Is this content block a BACKGROUND-LAUNCH tool_use — the structural tell that the
 * agent kicked off a background op rather than running it to completion inline?
 *
 * Two ways a tool_use qualifies:
 *   - it is an ALWAYS_BG tool (Monitor / ScheduleWakeup), OR
 *   - it carries `input.run_in_background === true` (the param real Bash/Agent/Task
 *     background launches set — verified against transcripts: a backgrounded `Bash`
 *     has `input.run_in_background:true`, and a backgrounded `Agent` dispatch likewise).
 *
 * The `run_in_background` check is GENERIC (any tool name) so a future background-capable
 * tool is covered without a code change; the named set covers the waiter/timer tools that
 * take no such flag.
 * @param {any} block a transcript content block
 * @returns {boolean}
 */
export function isBackgroundLaunch(block) {
  if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') return false;
  if (ALWAYS_BG_TOOLS.has(block.name)) return true;
  const input = block && typeof block.input === 'object' && block.input ? block.input : {};
  return input.run_in_background === true;
}

/**
 * The STRUCTURAL waiter-rest judgment, as a PURE function of the agent's ordered
 * tool_use blocks (so it is unit-testable with synthetic inputs, no transcript file).
 *
 * Fires when the LAST tool_use the agent made was a background-launch. Because it is the
 * LAST tool_use, nothing substantive ran after it — the agent kicked off a background op
 * and then ended its turn (emitting at most a final text message). That is exactly the
 * "backgrounded-and-rested" pathology. A genuine finish polls the op inline first, so its
 * last tool_use is a FOREGROUND read/commit (run_in_background falsy) — not a bg-launch —
 * and this returns false.
 *
 * @param {any[]} toolUseBlocks ordered (transcript-order) list of tool_use content blocks
 * @returns {boolean} true ONLY when the last tool_use is a background-launch
 */
export function detectStructuralRestFromToolUses(toolUseBlocks) {
  if (!Array.isArray(toolUseBlocks) || toolUseBlocks.length === 0) return false;
  return isBackgroundLaunch(toolUseBlocks[toolUseBlocks.length - 1]);
}

/**
 * Read a transcript .jsonl and return the LAST tool_use content block the agent made
 * (across the whole transcript), or null when there is none / it is unreadable. Scans
 * from the END backward for efficiency (we only need the final tool_use) and stops at
 * the first assistant turn that carries any tool_use, returning that turn's LAST
 * tool_use block (a turn may batch several). Fail-CLOSED to null on any error so the
 * caller fails open (no block).
 * @param {string|null|undefined} transcriptPath
 * @returns {any|null}
 */
export function lastToolUse(transcriptPath) {
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
      const tus = o.message.content.filter((b) => b && b.type === 'tool_use');
      if (tus.length) return tus[tus.length - 1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * STRUCTURAL waiter-rest detection straight from a transcript path: true when the agent's
 * last tool_use was a background-launch. Fail-open (false) on any read/parse failure.
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function detectStructuralRest(transcriptPath) {
  const last = lastToolUse(transcriptPath);
  return isBackgroundLaunch(last);
}
