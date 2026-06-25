// @ts-check
/**
 * fray — Stop hook. Fires when the main agent finishes responding (goes idle).
 * TWO jobs, in priority order:
 *
 *   (A) REST-RECONCILIATION GUARD (the #1 recurring failure). A background sub-agent
 *       coming to REST is recorded by the SubagentStop hook (fray-subagent-rest.mjs)
 *       in `.fray/.rested-agents.jsonl`. If any rest has happened since we last
 *       surfaced one, REFUSE to let the orchestrator go idle until it has reconciled
 *       them — fold findings into the thread, drain the queued follow-ups, and verify
 *       the agent is genuinely DONE (a rest is NOT "done": an agent can rest mid-step
 *       and rest repeatedly). This bypasses the cleanup cooldown (rests are urgent),
 *       but is loop-safe: it fires only on NOT-YET-SURFACED agents (deduped by agent-id,
 *       so a resuming agent's repeat rests don't re-nag), newer than the last surface,
 *       and never twice in a row (stop_hook_active).
 *
 *   (B) CLEANUP NUDGE. Otherwise, the original gentle nudge to make sure threads
 *       touched this session reflect current truth — rate-limited by a cooldown and
 *       gated on a thread file actually having been touched.
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

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAY_DIR = join(PROJECT_DIR, '.fray');
const STATE_FILE = join(FRAY_DIR, '.stop-reminder-state.json');
const REST_LOG = join(FRAY_DIR, '.rested-agents.jsonl');

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
 * State: { last_fired, last_rest_surfaced, surfaced_agents, last_anon_ts } — the epoch-ms
 * markers (default 0), a SEEN-SET of agent-ids already surfaced, and an anon-rest timestamp
 * high-water mark. Together they make each rest count AT MOST ONCE: a single background agent
 * rests (and re-fires its rest record) MANY times, so counting raw lines re-nags for handled
 * work. id'd rests dedupe via the seen-set (capped on write so it can't grow unbounded);
 * rests with no agent-id dedupe via `last_anon_ts` (only anon rests newer than the mark count).
 */
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      last_fired: s.last_fired || 0,
      last_rest_surfaced: s.last_rest_surfaced || 0,
      surfaced_agents: Array.isArray(s.surfaced_agents) ? s.surfaced_agents : [],
      last_anon_ts: s.last_anon_ts || 0,
    };
  } catch {
    return { last_fired: 0, last_rest_surfaced: 0, surfaced_agents: [], last_anon_ts: 0 };
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

/**
 * Find sub-agent rests recorded strictly after `sinceMs` whose agent-id has NOT yet
 * been surfaced (`surfacedAgents`). Returns the count plus the DISTINCT new agent-ids,
 * so the caller can both nag with a real number and grow the seen-set.
 *
 * DEDUPE on two tracks so a rest is counted at most ONCE:
 *   - id'd rests: a line whose `agent_id` is already in `surfacedAgents` is skipped, so a
 *     resuming agent's repeat rests don't re-nag; only genuinely-new agent-ids count.
 *   - anon rests (no `agent_id` — untagged one-shots, payloads that omit the id): can't be
 *     keyed by id, so they're deduped by a TIMESTAMP high-water mark (`lastAnonTs`). Only
 *     anon rests strictly newer than the last surfaced anon ts count; the newest such ts is
 *     returned so the caller can advance the mark. Without this, an anon rest re-counts on
 *     every fire until the time window rolls past it — the exact re-nag dedupe exists to kill.
 * A real rest is never silently dropped: a not-yet-seen id or a newer-than-mark anon both count.
 */
function newRestsSince(sinceMs, surfacedAgents, lastAnonTs) {
  const seen = new Set(surfacedAgents);
  const newAgents = new Set();
  let anonCount = 0;
  let maxAnonTs = lastAnonTs; // advance the anon high-water mark to the newest anon rest seen
  try {
    const lines = readFileSync(REST_LOG, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const ts = Date.parse(rec.ts);
        if (!Number.isFinite(ts) || ts <= sinceMs) continue;
        const id = rec.agent_id;
        if (id) {
          if (!seen.has(id)) newAgents.add(id);
        } else if (ts > lastAnonTs) {
          anonCount++;
          if (ts > maxAnonTs) maxAnonTs = ts;
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no log → no rests */
  }
  return { count: newAgents.size + anonCount, agents: [...newAgents], maxAnonTs };
}

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

// TERSE model-facing nudges. The FULL reconcile discipline (drain-oldest-first,
// rest≠done, incomplete-handoff handling) lives in the `fray` skill the model already
// has loaded — repeating it here every fire produced a ~200-word wall that rendered as
// an alarming block. The hook only needs to POINT at the work; the skill carries the how.
function restReminder(n) {
  return `fray: ${n} new sub-agent rest(s) since you last reconciled — reconcile each (oldest first, re-read its thread, drain its queue, verify it actually landed) or stop if all are already handled.`;
}

const CLEANUP_REMINDER =
  'fray: before going idle, make sure the threads you worked on this session reflect current truth (drain returned follow-ups, flip finished threads to done) — or just stop if they already do.';

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
  const { last_fired, last_rest_surfaced, surfaced_agents, last_anon_ts } = readState();

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
  // Fire only on rests from agents NOT yet surfaced (deduped by agent-id) AND newer
  // than the last surface, so each genuinely-new rest forces exactly one reconciliation
  // prompt (loop-safe with Guard 1) without re-nagging a resuming agent's repeat rests.
  const { count: newRests, agents: newAgentIds, maxAnonTs } = newRestsSince(last_rest_surfaced, surfaced_agents, last_anon_ts);
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
    writeState({ last_rest_surfaced: now, last_fired: now, surfaced_agents: merged, last_anon_ts: maxAnonTs });
    return block(restReminder(newRests) + livenessBlock, USER_NOTE);
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

  writeState({ last_fired: now });
  return block(CLEANUP_REMINDER + livenessBlock, USER_NOTE);
}

main().catch(() => allow());
