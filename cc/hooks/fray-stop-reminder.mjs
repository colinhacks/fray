// @ts-check
/**
 * fray — Stop hook. Fires when the main agent finishes responding (goes idle).
 * TWO jobs, in priority order:
 *
 *   (A) REST-RECONCILIATION GUARD (the #1 recurring failure). A background sub-agent
 *       coming to REST is recorded by the SubagentStop hook (fray-subagent-rest.mjs)
 *       in `.fray/.rested-agents.jsonl`. If a rest of an agent the ORCHESTRATOR DISPATCHED
 *       has happened since we last surfaced one, REFUSE to let it go idle until it has
 *       reconciled them — fold findings into the thread, drain the queued follow-ups, and
 *       verify the agent is genuinely DONE (a rest is NOT "done": an agent can rest mid-step
 *       and rest repeatedly). Only THREAD-BOUND rests count (`newBoundRestsSince`): anything
 *       with no THREAD binding — a NESTED sub-agent a WORKER spawned (e.g. its own self-review
 *       pass, which folds into the parent's report) OR an untagged orchestrator one-shot (no
 *       thread to reconcile) — is excluded; only an agent dispatched onto a thread can nag.
 *       This bypasses the cleanup cooldown (rests are urgent), but is loop-safe: it fires only
 *       on NOT-YET-SURFACED bound agents (deduped by agent-id, so a resuming agent's repeat
 *       rests don't re-nag), newer than the last surface, and never twice in a row
 *       (stop_hook_active). It ALSO hands the orchestrator the CONTENTS of each just-finished
 *       agent's bound thread (capped excerpt via threadExcerptsBlock) so it can square the
 *       agent's REPORTED results against what the thread now says — the orchestrator's own Stop
 *       hook is the channel that lands thread text in the ORCHESTRATOR's context (a SubagentStop
 *       hook's additionalContext would continue the SUB-AGENT's turn, the wrong surface).
 *
 *   (B) CLEANUP + POP-ONE NUDGE. Otherwise, nudge a reconcile of threads touched this
 *       session AND THEN to pop the single next `blocked` thread off the queue and present
 *       that ONE blockage to the human with full context (fray's serialized one-at-a-time
 *       decision rhythm — never a whole-list dump). Rate-limited by a cooldown and gated on
 *       a thread file actually having been touched. BOTH nudges now HAND the orchestrator the
 *       CONTENTS of that next blocked thread inline (nextBlockedBlock → threadExcerpt), so it
 *       presents the blockage without a Read tool call; the pick CYCLES the blocked queue
 *       (last_surfaced_blocked) so successive stops surface different ones, one at a time.
 *
 * OUTPUT CHANNEL (see `block()`): both jobs BLOCK via `decision: block` but carry the
 * model-facing text in `hookSpecificOutput.additionalContext` (NOT `reason`) plus a calm
 * `systemMessage`, so the user sees a gentle reminder, not a red "Stop hook error:" wall.
 * The nudges are 1-line POINTERS; the full reconcile discipline lives in the `fray` skill.
 *
 * THREE loop-guards (defense in depth): stop_hook_active; a per-concern cooldown/marker
 * in `.fray/.stop-reminder-state.json`; and the activity gate (cleanup nudge only).
 *
 * FAIL-OPEN everywhere: any error / missing file / unparseable input → exit 0
 * (allow the stop). A broken reminder must never trap the user.
 *
 * Config (`.fray/config.yml`): master `enabled` gates it; `stop_reminder: on|off`
 * (default on); `stop_reminder_cooldown_seconds` (default 1800) is the CLEANUP rest window.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { frayActive } from '../scripts/fray/config.mjs';
import { newBoundRestsSince } from '../scripts/fray/agent-bindings.mjs';
import { threadExcerptsBlock, threadExcerpt } from '../scripts/fray/thread-excerpt.mjs';
import { collectDecisions } from '../scripts/fray/decisions.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAY_DIR = join(PROJECT_DIR, '.fray');
const STATE_FILE = join(FRAY_DIR, '.stop-reminder-state.json');

/** Allow the stop (no output = no block). */
function allow() {
  process.exit(0);
}

/**
 * Block the stop and feed the model `modelText`, via the LEAST-ALARMING channel.
 *
 * We carry the model-facing text in `hookSpecificOutput.additionalContext`, NOT the
 * top-level `reason` field. Claude Code renders a blocked Stop hook's `reason` to the
 * USER as a red "Stop hook error: <reason>" line (a known display bug — the block is
 * intentional, not an error: anthropics/claude-code#34600, #62139). Omitting `reason`
 * keeps that alarming red wall off the user's screen while `additionalContext` still
 * delivers the nudge to the model as an ordinary system reminder. `systemMessage` adds
 * one calm user-facing line so the surface reads as a gentle fray reminder.
 */
function block(modelText, userNote) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: modelText },
      systemMessage: userNote,
    }),
  );
  process.exit(0);
}

/** Read the two stop_reminder knobs straight from the flat config.yml. */
function readKnobs() {
  let enabled = true;
  let cooldownSeconds = 1800;
  try {
    const src = readFileSync(join(FRAY_DIR, 'config.yml'), 'utf8');
    const onOff = src.match(/^stop_reminder:\s*(\S+)/m);
    if (onOff) {
      const v = onOff[1].toLowerCase();
      if (v === 'off' || v === 'false' || v === 'no') enabled = false;
    }
    const cd = src.match(/^stop_reminder_cooldown_seconds:\s*(\d+)/m);
    if (cd) cooldownSeconds = parseInt(cd[1], 10);
  } catch {
    /* defaults */
  }
  return { enabled, cooldownSeconds };
}

/**
 * State: { last_fired, last_rest_surfaced, surfaced_agents } — the epoch-ms markers
 * (default 0) plus a SEEN-SET of agent-ids already surfaced. Together they make each
 * BOUND rest count AT MOST ONCE: a single background agent rests (and re-fires its rest
 * record) MANY times, so counting raw lines re-nags for handled work. The seen-set dedupes
 * a resuming agent's repeat rests (capped on write so it can't grow unbounded). Only
 * THREAD-BOUND (orchestrator-dispatched) rests are ever counted — see `newBoundRestsSince`
 * in agent-bindings.mjs — so anon/unbound nested rests need no dedupe track at all.
 */
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      last_fired: s.last_fired || 0,
      last_rest_surfaced: s.last_rest_surfaced || 0,
      surfaced_agents: Array.isArray(s.surfaced_agents) ? s.surfaced_agents : [],
      last_surfaced_blocked: typeof s.last_surfaced_blocked === 'string' ? s.last_surfaced_blocked : '',
    };
  } catch {
    return { last_fired: 0, last_rest_surfaced: 0, surfaced_agents: [], last_surfaced_blocked: '' };
  }
}

function writeState(patch) {
  try {
    const cur = readState();
    writeFileSync(STATE_FILE, JSON.stringify({ ...cur, ...patch }) + '\n');
  } catch {
    /* best-effort */
  }
}

// Counting sub-agent rests lives in `newBoundRestsSince` (agent-bindings.mjs): it counts
// ONLY rests of THREAD-BOUND (orchestrator-dispatched) agents, excluding nested/worker-spawned
// and anon rests the orchestrator never dispatched and cannot reconcile. Imported above.

/** Was any thread file (`.fray/*.md`) touched since `sinceMs`? */
function threadTouchedSince(sinceMs) {
  try {
    const files = readdirSync(FRAY_DIR).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      try {
        if (statSync(join(FRAY_DIR, f)).mtimeMs > sinceMs) return true;
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* no .fray dir → no threads → no nudge */
  }
  return false;
}

/**
 * POP-ONE surfacing: pick the single next `blocked` thread and return its CONTENTS inline,
 * so the orchestrator can present that ONE blockage to the human WITHOUT a Read tool call.
 * This is the pop-one-at-a-time rhythm the nudges instruct — now with the thread text
 * actually in the orchestrator's context, matching the rest path's threadExcerptsBlock.
 *
 * "Next" cycles the queue: prefer a blocked thread OTHER than the one surfaced last fire
 * (so across successive stops the human sees them one-at-a-time rather than the same one
 * repeatedly); fall back to the first when there's only one or the last isn't found.
 * Returns { block, slug } — block is '' and slug null on empty queue / any error (fail-open).
 * @param {string} projectDir
 * @param {string} lastSurfaced
 * @returns {{ block: string, slug: string|null }}
 */
function nextBlockedBlock(projectDir, lastSurfaced) {
  try {
    const q = collectDecisions(); // [{slug, status_text}] of every `blocked` thread
    if (!q.length) return { block: '', slug: null };
    const idx = lastSurfaced ? q.findIndex((d) => d.slug === lastSurfaced) : -1;
    // Rotate to the one AFTER last-surfaced (wraps); if last isn't in the queue, take the first.
    const pick = q[idx === -1 ? 0 : (idx + 1) % q.length];
    const ex = threadExcerpt(projectDir, pick.slug);
    if (!ex) return { block: '', slug: pick.slug };
    const n = q.length;
    const header = `\n\nfray ⚖ next blocked thread — POP THIS ONE (${n} awaiting you; presenting 1, the rest stay queued). Present it in FULL with your recommendation; if it has multiple open questions, batch them (up to 4 in one AskUserQuestion, or back-to-back) and synthesize. Contents:\n`;
    return { block: header + ex, slug: pick.slug };
  } catch {
    return { block: '', slug: null };
  }
}

// TERSE model-facing nudges. The FULL reconcile discipline (drain-oldest-first,
// rest≠done, incomplete-handoff handling) lives in the `fray` skill the model already
// has loaded — repeating it here every fire produced a ~200-word wall that rendered as
// an alarming block. The hook only needs to POINT at the work; the skill carries the how.
function restReminder(n, threads = []) {
  const where = threads.length ? ` (thread(s): ${threads.join(', ')})` : '';
  return `fray: ${n} new sub-agent rest(s) since you last reconciled${where} — reconcile each (oldest first, re-read its thread, drain its queue, verify it actually landed). THEN, if any thread is blocked awaiting the human, POP THE SINGLE next one, re-read it so you fully understand it, and present THAT ONE blockage with full context + your rec — one blockage at a time, never a whole-list dump.`;
}

const CLEANUP_REMINDER =
  'fray: before going idle — (1) reconcile the threads you touched this session (drain follow-ups, flip finished → done); (2) THEN pop the SINGLE next blocked thread off the queue, RE-READ it so you fully understand the blockage, and present THAT ONE to the user with complete context + your recommendation — one blockage at a time, NEVER a concise dump of the whole blocked list (that overwhelms, under-informs each item, and scrolls out of the chat). Nothing blocked / all already surfaced this round → just stop.';

// Calm one-liner shown to the USER (the `systemMessage` channel) alongside whichever
// block fires, so the surface reads as a gentle fray reminder rather than a bare error.
const USER_NOTE = 'fray: nudging a reconcile pass before idle.';

async function main() {
  // Read the Stop payload from stdin FIRST — its session_id drives the per-session gate.
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    /* no/invalid stdin → treat as empty; guards below still apply */
  }

  // fray ACTIVATION GATE — fray ships globally and this hook fires in EVERY project.
  // Allow the stop silently unless the project is opted in (`.fray/` exists AND the
  // per-session sentinel is not forced off), so a virgin repo never gets a fray Stop
  // block. Plus the stop_reminder own switch below.
  try {
    if (!frayActive(PROJECT_DIR, payload.session_id)) return allow();
  } catch {
    return allow();
  }

  const { enabled, cooldownSeconds } = readKnobs();
  if (!enabled) return allow();

  // Guard 1 (applies to BOTH concerns): never block a stop that is itself a
  // continuation we caused — prevents any no-rest loop.
  if (payload.stop_hook_active === true) return allow();

  const now = Date.now();
  const { last_fired, last_rest_surfaced, surfaced_agents, last_surfaced_blocked } = readState();

  // (C) AGENT-LIVENESS lines — idle/frozen/unreaped dispatched sub-agents. Computed
  // once, fail-open ([] on any error). Appended to whichever reminder fires below,
  // and emitted on their own (rate-limited) when neither guard would otherwise fire.
  // Dynamic import so a missing/broken helper can never crash the hook before
  // main()'s catch (a static import failure would).
  let liveness = [];
  try {
    const { agentLivenessLines } = await import('../scripts/fray/agent-liveness.mjs');
    liveness = agentLivenessLines({ transcriptPath: payload.transcript_path, projectDir: PROJECT_DIR, now });
  } catch {
    liveness = [];
  }
  const livenessBlock = liveness.length ? '\n\nfray agent-liveness:\n' + liveness.join('\n') : '';

  // (A) REST-RECONCILIATION GUARD — highest priority, bypasses the cleanup cooldown.
  // Fire only on rests from THREAD-BOUND (orchestrator-dispatched) agents NOT yet surfaced
  // (deduped by agent-id) AND newer than the last surface, so each genuinely-new rest of an
  // agent the orchestrator OWNS forces exactly one reconciliation prompt (loop-safe with
  // Guard 1). Nested/worker-spawned and anon rests are excluded by `newBoundRestsSince`.
  const { count: newRests, agents: newAgentIds, threads: newRestThreads } = newBoundRestsSince(PROJECT_DIR, last_rest_surfaced, surfaced_agents);
  // Cooldown: don't re-block on EVERY rest — under multi-session work the rest log
  // fills with OTHER sessions' subagent stops, which would otherwise block our idle
  // every couple minutes. A real completion of OUR agent re-invokes us via its
  // task-notification regardless of this hook, so a 10-min cooldown is safe: it still
  // catches a genuinely-new rest after a gap, without the constant cross-session churn.
  const REST_COOLDOWN_MS = 600_000;
  if (newRests > 0 && (last_rest_surfaced === 0 || now - last_rest_surfaced > REST_COOLDOWN_MS)) {
    // Grow the seen-set so these agents' repeat rests don't re-nag. Cap it so a
    // long-lived board can't let the persisted set grow without bound (keep the most
    // recent ids — older ones are long-since reconciled).
    const merged = [...surfaced_agents, ...newAgentIds].slice(-200);
    // Hand the orchestrator the CONTENTS of each just-finished agent's bound thread, so it
    // can square the agent's reported results against what the thread now says — instead of
    // re-reading each file by hand. Capped + fail-open: '' when nothing is readable, so the
    // bare rest pointer (which still names the threads) is the floor.
    const threadContents = threadExcerptsBlock(PROJECT_DIR, newRestThreads);
    // After reconciling the rest, also pop the next blocked thread's contents inline (the
    // rest reminder tells the orchestrator to do this; hand it the text so it needn't Read).
    const nb = nextBlockedBlock(PROJECT_DIR, last_surfaced_blocked);
    writeState({ last_rest_surfaced: now, last_fired: now, surfaced_agents: merged, ...(nb.slug ? { last_surfaced_blocked: nb.slug } : {}) });
    return block(restReminder(newRests, newRestThreads) + threadContents + nb.block + livenessBlock, USER_NOTE);
  }

  // (B) CLEANUP NUDGE — original behavior, rate-limited + activity-gated. The
  // liveness lines piggyback on the same cooldown so they can't loop the orchestrator.
  if (last_fired > 0 && now - last_fired < cooldownSeconds * 1000) return allow();
  if (last_fired > 0 && !threadTouchedSince(last_fired)) {
    // No thread touched → no cleanup nudge. But idle/unreaped agents are still worth
    // surfacing on their own (off the same cooldown above, which we already passed).
    if (liveness.length) {
      writeState({ last_fired: now });
      return block('fray agent-liveness:\n' + liveness.join('\n'), USER_NOTE);
    }
    return allow();
  }

  const nb = nextBlockedBlock(PROJECT_DIR, last_surfaced_blocked);
  writeState({ last_fired: now, ...(nb.slug ? { last_surfaced_blocked: nb.slug } : {}) });
  return block(CLEANUP_REMINDER + nb.block + livenessBlock, USER_NOTE);
}

main().catch(() => allow());
