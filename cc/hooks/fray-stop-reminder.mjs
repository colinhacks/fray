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
 *       session AND THEN to pop the single next `needs-decision` thread off the queue and
 *       present that ONE decision to the human with full context (fray's serialized
 *       one-at-a-time decision rhythm — never a whole-list dump). The ⚖ queue is
 *       `needs-decision` ONLY — `blocked` (a NON-human wait) is never popped, and when there
 *       are no needs-decision threads the hook does NOT nag about blocked ones (nothing for the
 *       human to do). Rate-limited by a cooldown and gated on a thread file actually having been
 *       touched. BOTH nudges HAND the orchestrator the CONTENTS of that next needs-decision
 *       thread inline (nextDecisionBlock → threadExcerpt), so it presents the decision without a
 *       Read tool call; the pick CYCLES the queue (last_surfaced_blocked) so successive stops
 *       surface different ones, one at a time.
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

/** Read the stop_reminder knobs + autonomous_mode straight from the flat config.yml. */
function readKnobs() {
  let enabled = true;
  let cooldownSeconds = 1800;
  let autonomous = false;
  try {
    const src = readFileSync(join(FRAY_DIR, 'config.yml'), 'utf8');
    const onOff = src.match(/^stop_reminder:\s*(\S+)/m);
    if (onOff) {
      const v = onOff[1].toLowerCase();
      if (v === 'off' || v === 'false' || v === 'no') enabled = false;
    }
    const cd = src.match(/^stop_reminder_cooldown_seconds:\s*(\d+)/m);
    if (cd) cooldownSeconds = parseInt(cd[1], 10);
    const am = src.match(/^autonomous_mode:\s*(\S+)/m);
    if (am) {
      const v = am[1].toLowerCase();
      if (v === 'on' || v === 'true' || v === 'yes') autonomous = true;
    }
  } catch {
    /* defaults */
  }
  return { enabled, cooldownSeconds, autonomous };
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
      last_blocked_surfaced: s.last_blocked_surfaced || 0,
    };
  } catch {
    return { last_fired: 0, last_rest_surfaced: 0, surfaced_agents: [], last_surfaced_blocked: '', last_blocked_surfaced: 0 };
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
 * POP-ONE surfacing: pick the single next `needs-decision` thread and return its CONTENTS
 * inline, so the orchestrator can present that ONE decision to the human WITHOUT a Read tool
 * call. This is the pop-one-at-a-time rhythm the nudges instruct — with the thread text
 * actually in the orchestrator's context, matching the rest path's threadExcerptsBlock.
 *
 * "Next" cycles the queue: prefer a needs-decision thread OTHER than the one surfaced last fire
 * (so across successive stops the human sees them one-at-a-time rather than the same one
 * repeatedly); fall back to the first when there's only one or the last isn't found. Returns
 * { block, slug } — block is '' and slug null on an EMPTY queue (no needs-decision threads →
 * nothing to pop, and `blocked` threads are deliberately never popped) or any error (fail-open).
 * @param {string} projectDir
 * @param {string} lastSurfaced
 * @returns {{ block: string, slug: string|null }}
 */
function nextDecisionBlock(projectDir, lastSurfaced) {
  try {
    const q = collectDecisions(); // `needs-decision` threads = threads awaiting the MAINTAINER's decision
    if (!q.length) return { block: '', slug: null };
    const idx = lastSurfaced ? q.findIndex((d) => d.slug === lastSurfaced) : -1;
    // Rotate to the one AFTER last-surfaced (wraps); if last isn't in the queue, take the first.
    const pick = q[idx === -1 ? 0 : (idx + 1) % q.length];
    const ex = threadExcerpt(projectDir, pick.slug);
    if (!ex) return { block: '', slug: pick.slug };
    const n = q.length;
    const others = q.filter((d) => d.slug !== pick.slug).map((d) => d.slug);
    const queueLine = others.length ? ` The other ${others.length} stay queued (not now): ${others.join(', ')}.` : '';
    const header = `\n\nfray ⚖ next needs-decision thread — POP THIS ONE (${n} awaiting you; presenting 1).${queueLine}\nThread file: .fray/${pick.slug}.md — record the human's call in its ## Decisions and flip it out of needs-decision once answered. Contents:\n`;
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
  return `fray: ${n} new sub-agent rest(s) since you last reconciled${where} — reconcile each (oldest first, re-read its thread, drain its queue, verify it actually landed). THEN, if any thread NEEDS A DECISION from the human, POP THE SINGLE next one, re-read it so you fully understand it, and present THAT ONE decision with full context + your rec — one at a time, never a whole-list dump. (\`blocked\` threads are a non-human wait — nothing for the human to action.)`;
}

const CLEANUP_REMINDER =
  'fray: before going idle — (1) reconcile the threads you touched this session (drain follow-ups, flip finished → done); (2) THEN pop the SINGLE next needs-decision thread off the queue, RE-READ it so you fully understand the decision, and present THAT ONE to the user with complete context + your recommendation — one at a time, NEVER a concise dump of the whole queue (that overwhelms, under-informs each item, and scrolls out of the chat). No needs-decision threads / all already surfaced this round → just stop (don\'t nag about `blocked` threads — those wait on non-human work).';

// The POP-ONE nudge — carries the next needs-decision thread's CONTENTS inline (appended by
// the caller). Fires each idle-cycle INDEPENDENT of the cleanup cooldown, so the human can
// churn the decision queue one at a time.
const POP_BLOCKED_REMINDER =
  'fray: before going idle — reconcile any thread you touched (drain its follow-ups, flip finished → done), THEN present the needs-decision thread below to the user IN FULL: what it is, the current state, the alternatives, the exact decision, and your recommendation. One decision at a time. If it carries multiple open questions, BATCH them (up to 4 in one AskUserQuestion, or back-to-back) and synthesize the answers yourself — do not drip one per turn. Contents:';

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

  const { enabled, cooldownSeconds, autonomous } = readKnobs();
  if (!enabled) return allow();

  // Guard 1 (applies to BOTH concerns): never block a stop that is itself a
  // continuation we caused — prevents any no-rest loop.
  if (payload.stop_hook_active === true) return allow();

  const now = Date.now();
  const { last_fired, last_rest_surfaced, surfaced_agents, last_surfaced_blocked, last_blocked_surfaced } = readState();

  // (C) AGENT-LIVENESS lines — idle/frozen/unreaped dispatched sub-agents. Computed
  // once, fail-open ([] on any error). Appended to whichever reminder fires below,
  // and emitted on their own (rate-limited) when neither guard would otherwise fire.
  // Dynamic import so a missing/broken helper can never crash the hook before
  // main()'s catch (a static import failure would).
  let liveness = [];
  let liveCount = 0;
  try {
    const mod = await import('../scripts/fray/agent-liveness.mjs');
    liveness = mod.agentLivenessLines({ transcriptPath: payload.transcript_path, projectDir: PROJECT_DIR, now });
    liveCount = mod.runningAgentCount({ transcriptPath: payload.transcript_path, projectDir: PROJECT_DIR, now });
  } catch {
    liveness = [];
    liveCount = 0;
  }
  const livenessBlock = liveness.length ? '\n\nfray agent-liveness:\n' + liveness.join('\n') : '';
  // Force-nudge-on-live-agents: NO hook fires during the "Waiting for N background agents"
  // idle-wait, so the Stop is the only moment to surface it. When agents are actively in
  // flight, append a gentle steer pointer to whatever block fires — the orchestrator can
  // SendMessage-steer them NOW rather than sit idle. Informational (never its own block).
  const liveAgentsNote = liveCount > 0
    ? `\n\nfray: ${liveCount} background agent(s) still working — you can SendMessage-steer them now (fold in scope / answer a question / redirect) rather than idling; steer, don't cold-redispatch.`
    : '';

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
    const nb = nextDecisionBlock(PROJECT_DIR, last_surfaced_blocked);
    writeState({ last_rest_surfaced: now, last_fired: now, surfaced_agents: merged, ...(nb.slug ? { last_surfaced_blocked: nb.slug, last_blocked_surfaced: now } : {}) });
    return block(restReminder(newRests, newRestThreads) + threadContents + nb.block + livenessBlock + liveAgentsNote, USER_NOTE);
  }

  // (B0) POP-ONE NEEDS-DECISION — surface the next pending human DECISION, STRICTLY rate-limited.
  // THE STORM FIX (1.19.4): the prior gate fired whenever the surfaced slug DIFFERED from last
  // time — but nextDecisionBlock deliberately ROTATES to a different slug each fire, so with ≥2
  // needs-decision threads `isDifferent` was ALWAYS true and this blocked EVERY idle, cycling the
  // whole queue endlessly (the "unnecessary number of stop hooks" the user hit). Now gated on a
  // single hard cooldown: at most ONE decision surface per POP_COOLDOWN, still rotating
  // one-per-fire through the queue. SUPPRESSED entirely in autonomous mode — a self-driving
  // orchestrator sets its own decision cadence and must not be nagged for human input each idle.
  if (!autonomous) {
    const POP_COOLDOWN_MS = 1_200_000; // ≥20 min between decision surfaces
    if (now - last_blocked_surfaced > POP_COOLDOWN_MS) {
      const nb = nextDecisionBlock(PROJECT_DIR, last_surfaced_blocked);
      if (nb.slug) {
        writeState({ last_surfaced_blocked: nb.slug, last_blocked_surfaced: now });
        return block(POP_BLOCKED_REMINDER + nb.block + livenessBlock + liveAgentsNote, USER_NOTE);
      }
    }
  }

  // (B) CLEANUP NUDGE — reconcile threads touched this session (no blocked thread was due
  // above). Rate-limited + activity-gated; liveness piggybacks on the same cooldown.
  if (last_fired > 0 && now - last_fired < cooldownSeconds * 1000) return allow();
  if (last_fired > 0 && !threadTouchedSince(last_fired)) {
    // No thread touched → no cleanup nudge. But idle/unreaped agents (liveness lines) OR
    // still-in-flight agents (liveCount) are worth surfacing on their own — this is the
    // force-nudge that converts a silent "Waiting for N background agents" idle into ONE
    // gentle steer pointer (off the same cooldown above, which we already passed).
    if (liveness.length || liveCount > 0) {
      writeState({ last_fired: now });
      const body = (liveness.length ? 'fray agent-liveness:\n' + liveness.join('\n') : '') + liveAgentsNote;
      return block(body.trimStart(), USER_NOTE);
    }
    return allow();
  }

  writeState({ last_fired: now });
  return block(CLEANUP_REMINDER + livenessBlock + liveAgentsNote, USER_NOTE);
}

main().catch(() => allow());
