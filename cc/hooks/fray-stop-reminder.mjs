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
 *       but is loop-safe: it only fires on rests NEWER than the last time it fired,
 *       and never twice in a row (stop_hook_active).
 *
 *   (B) CLEANUP NUDGE. Otherwise, the original gentle nudge to make sure threads
 *       touched this session reflect current truth — rate-limited by a cooldown and
 *       gated on a thread file actually having been touched.
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

/** State: { last_fired, last_rest_surfaced } — both epoch-ms, default 0. */
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { last_fired: s.last_fired || 0, last_rest_surfaced: s.last_rest_surfaced || 0 };
  } catch {
    return { last_fired: 0, last_rest_surfaced: 0 };
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

/** Count sub-agent rest events recorded with ts (ms) strictly after `sinceMs`. */
function restsSince(sinceMs) {
  let n = 0;
  try {
    const lines = readFileSync(REST_LOG, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ts = Date.parse(JSON.parse(line).ts);
        if (Number.isFinite(ts) && ts > sinceMs) n++;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no log → no rests */
  }
  return n;
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

function restReminder(n) {
  return [
    `⟦fray REST guard⟧ ${n} background sub-agent rest(s) recorded since you last reconciled.`,
    'Treat these as a strict INBOX: drain the OLDEST first, ONE at a time, never batch into one merged summary.',
    'For EACH rested agent, RE-READ its thread .md (not from memory),',
    'fold its findings, and DRAIN its queued follow-ups — OR confirm it is genuinely still running.',
    'A "came to rest" is NOT "done": an agent can rest mid-step and rest repeatedly, so verify the',
    'deliverable actually landed (committed/pushed/CI-green/reported a conclusion) before treating it as complete.',
    'An EMPTY/missing/progress-only final message is an INCOMPLETE handoff (a bug, not success):',
    'do NOT mark such a thread done — record it as incomplete/needs-retry and re-dispatch if still needed.',
    'If every rested agent is already reconciled, just stop.',
  ].join(' ');
}

const CLEANUP_REMINDER = [
  '⟦fray cleanup check⟧ Before going idle: make sure every fray thread you worked on THIS session reflects current truth —',
  'drain any QUEUED follow-ups whose agent has returned, move answered Open questions into Decisions, and flip completed threads to `done` (or `dismissed` if abandoned).',
  'Touch ONLY threads you actually worked on recently; do NOT edit unrelated threads.',
  'If they are ALL already accurate, just stop — do not manufacture work.',
  '(Rate-limited: this will not fire again for a while.)',
].join(' ');

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
  const { last_fired, last_rest_surfaced } = readState();

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
  const livenessBlock = liveness.length ? '\n\n⟦fray agent-liveness⟧\n' + liveness.join('\n') : '';

  // (A) REST-RECONCILIATION GUARD — highest priority, bypasses the cleanup cooldown.
  // Fire only on rests NEWER than the last surface, so each new rest forces exactly
  // one reconciliation prompt (loop-safe with Guard 1).
  const newRests = restsSince(last_rest_surfaced);
  // Cooldown: don't re-block on EVERY rest — under multi-session work the rest log
  // fills with OTHER sessions' subagent stops, which would otherwise block our idle
  // every couple minutes. A real completion of OUR agent re-invokes us via its
  // task-notification regardless of this hook, so a 10-min cooldown is safe: it still
  // catches a genuinely-new rest after a gap, without the constant cross-session churn.
  const REST_COOLDOWN_MS = 600_000;
  if (newRests > 0 && (last_rest_surfaced === 0 || now - last_rest_surfaced > REST_COOLDOWN_MS)) {
    writeState({ last_rest_surfaced: now, last_fired: now });
    process.stdout.write(JSON.stringify({ decision: 'block', reason: restReminder(newRests) + livenessBlock }));
    process.exit(0);
  }

  // (B) CLEANUP NUDGE — original behavior, rate-limited + activity-gated. The
  // liveness lines piggyback on the same cooldown so they can't loop the orchestrator.
  if (last_fired > 0 && now - last_fired < cooldownSeconds * 1000) return allow();
  if (last_fired > 0 && !threadTouchedSince(last_fired)) {
    // No thread touched → no cleanup nudge. But idle/unreaped agents are still worth
    // surfacing on their own (off the same cooldown above, which we already passed).
    if (liveness.length) {
      writeState({ last_fired: now });
      process.stdout.write(JSON.stringify({ decision: 'block', reason: '⟦fray agent-liveness⟧\n' + liveness.join('\n') }));
      process.exit(0);
    }
    return allow();
  }

  writeState({ last_fired: now });
  process.stdout.write(JSON.stringify({ decision: 'block', reason: CLEANUP_REMINDER + livenessBlock }));
  process.exit(0);
}

main().catch(() => allow());
