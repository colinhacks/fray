// @ts-check
/**
 * fray — agent-liveness helper for the Stop hook.
 *
 * Background sub-agents are bound to their thread AUTOMATICALLY: the `agent-bind`
 * PostToolUse hook records `agentId → thread` into `.fray/.agent-bindings.jsonl` at
 * dispatch (see `./agent-bindings.mjs`). This module reads that ephemeral binding to learn
 * which agents serve which thread, then DERIVES each one's real liveness from ground truth
 * and returns reminder LINES for the Stop hook to surface. Hooks cannot call
 * SendMessage/Agent, so this is detect-and-remind only — exactly the ask. (The old
 * hand-maintained `agents: [{id, label}]` thread frontmatter is GONE — never read; a
 * lingering one in an old thread file is an ignored no-op.)
 *
 * COMPUTE, DON'T STORE. The binding supplies only the id↔thread mapping; it carries no
 * per-agent state. State comes from `deriveAgentState`
 * (`./agent-status.mjs`) over two ground-truth signals:
 *   1. The session tasks dir, derived from the Stop payload's `transcript_path`
 *      (`~/.claude/projects/<slug>/<session>.jsonl`). The per-agent activity files
 *      live at `<tmp>/claude-<uid>/<slug>/<session>/tasks/<agentId>.output`, where
 *      `<tmp>` is `/tmp` or `/private/tmp` and `<uid>` varies — so we GLOB the
 *      `claude-*` dirs under both bases rather than hard-code the uid. The `.output`
 *      entries are SYMLINKS to the subagent transcript jsonl; we `statSync` (follows
 *      the link) so the age reflects the TARGET's real last-write, not the stale
 *      symlink mtime. The mtime → idle/frozen age.
 *   2. The owning THREAD's own `status:` frontmatter (done/dismissed = terminal) — the
 *      orchestrator's deliberate "I reconciled this" signal, and the ONLY mutable bit.
 *
 * Emitted lines, all DERIVED (never read from a per-agent flag):
 *   - IDLE  (age > IDLE_MIN, thread non-terminal):   poke (SendMessage) or check if frozen.
 *   - UNRECONCILED (age > FROZEN_MIN, thread non-terminal): a likely-finished/stalled
 *     agent the orchestrator never folded → reconcile (fold, drain, flip terminal).
 *   - (thread terminal → say nothing; the orchestrator already reconciled it.)
 *
 * Thresholds (minutes), tunable via env for experimentation:
 *   FRAY_IDLE_MIN   (default 10) — no activity this long → flag as idle/poke.
 *   FRAY_FROZEN_MIN (default 25) — this long → call it likely-stale/unreconciled.
 *      Deliberately generous: a real agent can sit silent inside a long build, test
 *      run, or CI watch for many minutes, so 25 min gives headroom before we cry wolf
 *      and risk a false poke. Tune via the env var for faster- or slower-paced repos.
 *
 * FAIL-OPEN ABSOLUTELY: any error (no tasks dir, no bindings file, unparseable frontmatter,
 * unreadable file) → return [] (no lines). This must NEVER throw or block end-of-turn.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deriveAgentState, DEFAULT_IDLE_MIN, DEFAULT_FROZEN_MIN } from './agent-status.mjs';
import { bindingsByThread } from './agent-bindings.mjs';

const IDLE_MIN = parseInt(process.env.FRAY_IDLE_MIN || '', 10) || DEFAULT_IDLE_MIN;
const FROZEN_MIN = parseInt(process.env.FRAY_FROZEN_MIN || '', 10) || DEFAULT_FROZEN_MIN;

// Thread-level terminal statuses (frontmatter `status:`), matching scripts/fray TERMINAL.
const TERMINAL_THREAD = new Set(['done', 'dismissed']);

/**
 * Derive the session tasks dir from a Stop payload's transcript_path.
 * @param {string|undefined|null} transcriptPath
 * @returns {string|null}
 */
export function deriveTasksDir(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string') return null;
    const parts = transcriptPath.split('/');
    const sessionFile = parts.pop(); // <session>.jsonl
    const slug = parts.pop(); // <project-slug>
    if (!sessionFile || !slug) return null;
    const session = sessionFile.replace(/\.jsonl$/, '');
    if (!session) return null;
    for (const base of ['/tmp', '/private/tmp']) {
      let dirs;
      try {
        dirs = readdirSync(base).filter((d) => d.startsWith('claude-'));
      } catch {
        continue;
      }
      for (const d of dirs) {
        const cand = join(base, d, slug, session, 'tasks');
        if (existsSync(cand)) return cand;
      }
    }
  } catch {
    /* fail-open */
  }
  return null;
}

/**
 * Compute idle/unreconciled reminder lines for all dispatched agents, DERIVED purely
 * from ground truth (output-file mtime + thread status) — never a stored per-agent flag.
 * @param {{transcriptPath?: string|null, projectDir: string, now?: number}} args
 * @returns {string[]} reminder lines (possibly empty)
 */
export function agentLivenessLines({ transcriptPath, projectDir, now = Date.now() }) {
  /** @type {string[]} */
  const lines = [];
  try {
    const tasksDir = deriveTasksDir(transcriptPath);
    if (!tasksDir) return lines; // can't locate activity files → fail-open, say nothing
    const frayDir = join(projectDir, '.fray');

    // AUTOMATIC binding: which agents serve which thread, read from `.agent-bindings.jsonl`
    // (recorded by the agent-bind hook at dispatch). No frontmatter `agents:` is consulted.
    const byThread = bindingsByThread(projectDir);

    let files;
    try {
      files = readdirSync(frayDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
    } catch {
      return lines;
    }

    for (const f of files) {
      let src;
      try {
        src = readFileSync(join(frayDir, f), 'utf8');
      } catch {
        continue;
      }
      const slug = f.replace(/\.md$/, '');
      const threadStatus = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
      const threadTerminal = TERMINAL_THREAD.has(threadStatus);
      const threadActive = threadStatus === 'active'; // only `active` threads can have an UNRECONCILED/idle agent; parked phases (needs-decision/blocked/enqueued/todo) with done agents are EXPECTED, not drift
      const agents = byThread.get(slug) ?? [];

      for (const a of agents) {
        // Age comes from the output-file mtime — the ground truth. No per-agent stored
        // status is consulted. Placeholders (`current`) / never-started ids just miss.
        let ageMin = null;
        try {
          const st = statSync(join(tasksDir, `${a.id}.output`)); // follows the symlink → target mtime
          ageMin = (now - st.mtimeMs) / 60000;
        } catch {
          ageMin = null; // no activity file → can't judge idleness (fail-open per agent)
        }
        const who = `${a.label ? `${a.label} ` : ''}[${a.id.slice(0, 9)}] (thread ${slug})`;

        // DERIVE the state from ground truth only (output age + thread status).
        const state = deriveAgentState({ ageMin, threadTerminal, threadActive, idleMin: IDLE_MIN, frozenMin: FROZEN_MIN });
        if (state === 'unreconciled') {
          // Stale output + non-terminal thread = a likely-finished/stalled agent the
          // orchestrator never folded. THE signal that matters.
          lines.push(`⚠ UNRECONCILED: agent ${who} — no output for ${Math.round(ageMin)}m (> ${FROZEN_MIN}m) but thread status is "${threadStatus || '?'}" (non-terminal). Reconcile: fold findings, drain queue, flip the THREAD terminal — or confirm it's genuinely still running (then poke via SendMessage).`);
        } else if (state === 'idle') {
          lines.push(`⚠ IDLE: agent ${who} — no output for ${Math.round(ageMin)}m. Poke (SendMessage) to continue, or check if it's mid-long-build (then leave it).`);
        }
        // 'terminal' (thread reconciled), 'fresh' (working), 'unknown' (no file) → say nothing.
      }
    }
  } catch {
    /* fail-open: return whatever we have (typically []) */
  }
  return lines;
}
