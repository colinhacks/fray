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
 * THREAD-CENTRIC, LOW-NOISE. For each `active` thread we consider ONLY its NEWEST bound agent
 * (a superseded older agent is never flagged) and SUPPRESS the thread entirely when a PR is
 * landing for it via the merge cascade (it's active for the merge, not a stuck agent). The bar
 * is "better to miss a soft case than nag a benign one":
 *   - ⚠ ACTIVE THREAD, NO LIVE AGENT (state 'dropped'): an active, non-downstream thread whose
 *     NEWEST agent is quiet beyond DROPPED_MIN AND has rested (ended a turn) — the
 *     high-confidence "this thread is stuck active with nobody on it" signal. Calm wording.
 *   - a soft idle note (state 'idle'): quiet but not confidently dropped — fine if it's
 *     watching CI or mid-build. Informational only.
 *   - (thread terminal / parked / downstream / fresh agent → say nothing.)
 *
 * Thresholds (minutes), tunable via env for experimentation:
 *   FRAY_IDLE_MIN    (default 10) — quiet this long → soft idle note.
 *   FRAY_DROPPED_MIN (default 45, FRAY_FROZEN_MIN honored as the old alias) — quiet this long
 *      AND rested → call it dropped. Deliberately generous: a real agent legitimately arms a
 *      CI watcher and sits silent for 30–40 min, so 45 min lets the watcher fire and resume it
 *      before we ever flag. Tune via the env var for faster- or slower-paced repos.
 *
 * FAIL-OPEN ABSOLUTELY: any error (no tasks dir, no bindings file, unparseable frontmatter,
 * unreadable file) → return [] (no lines). This must NEVER throw or block end-of-turn.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deriveAgentState, findAgentOutputAge, IDLE_MIN, DROPPED_MIN, LONG_RUNTIME_MIN } from './agent-status.mjs';
import { newestBindingByThread, downstreamThreads, restedAgentIds } from './agent-bindings.mjs';

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
 * GROUND-TRUTH age (minutes) of an agent's last activity. Prefers the exact session's tasks
 * dir (fast, one statSync) when we have it; falls back to the session-independent glob whenever
 * the agent's `.output` isn't in THIS session's tasks dir — either there's no transcript_path,
 * OR the binding is from a PRIOR session (e.g. after a restart), where the cross-session glob is
 * what keeps anti-drop working across restarts. Returns null when no output file exists.
 * @param {string} agentId
 * @param {string|null} tasksDir
 * @param {number} now
 * @returns {number|null}
 */
function agentAge(agentId, tasksDir, now) {
  if (tasksDir) {
    try {
      const st = statSync(join(tasksDir, `${agentId}.output`)); // follows the symlink → target mtime
      return (now - st.mtimeMs) / 60000;
    } catch {
      /* not in this session's tasks dir → fall through to the glob */
    }
  }
  return findAgentOutputAge(agentId, now);
}

/**
 * Compute thread-centric liveness lines, DERIVED purely from ground truth (newest-binding age +
 * rest log + thread status + merge-queue) — never a stored per-agent flag. At most ONE line per
 * thread, keyed on the thread's NEWEST agent only, with downstream (mid-merge) threads
 * suppressed. The loud "ACTIVE THREAD, NO LIVE AGENT" lines come first, then soft idle notes.
 * @param {{transcriptPath?: string|null, projectDir: string, now?: number}} args
 * @returns {string[]} reminder lines (possibly empty)
 */
export function agentLivenessLines({ transcriptPath, projectDir, now = Date.now() }) {
  /** @type {string[]} */
  const dropped = [];
  /** @type {string[]} */
  const idle = [];
  try {
    const tasksDir = deriveTasksDir(transcriptPath); // may be null → agentAge falls back to glob
    const frayDir = join(projectDir, '.fray');

    // AUTOMATIC binding: the NEWEST agent serving each thread (a superseded older agent is
    // never considered). Plus the merge-cascade set (suppress mid-merge threads) and the rest
    // log (separate a parked agent from one still inside a long tool call).
    const newest = newestBindingByThread(projectDir);
    const downstream = downstreamThreads(projectDir);
    const rested = restedAgentIds(projectDir);

    let files;
    try {
      files = readdirSync(frayDir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'));
    } catch {
      return dropped;
    }

    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      const binding = newest.get(slug);
      if (!binding) continue; // no agent ever bound to this thread → nothing to judge

      let src;
      try {
        src = readFileSync(join(frayDir, f), 'utf8');
      } catch {
        continue;
      }
      const threadStatus = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
      const threadTerminal = TERMINAL_THREAD.has(threadStatus);
      const threadActive = threadStatus === 'active'; // ONLY active threads can strand an agent; parked phases holding a done agent are EXPECTED
      if (threadTerminal || !threadActive) continue;
      // PR landing via the cascade → legitimately active, suppress. Skip BEFORE agentAge so a
      // mid-merge thread never pays the (potentially full-/tmp-glob) age lookup just to be
      // dropped by deriveAgentState's downstream short-circuit anyway.
      if (downstream.has(slug)) continue;

      const ageMin = agentAge(binding.id, tasksDir, now);
      const hasRested = rested.has(binding.id);
      const state = deriveAgentState({ ageMin, threadTerminal, threadActive, hasRested, idleMin: IDLE_MIN, droppedMin: DROPPED_MIN }); // downstream already short-circuited above
      const who = `${binding.label ? `${binding.label} ` : ''}[${binding.id.slice(0, 9)}]`;

      if (state === 'dropped') {
        dropped.push(`⚠ ACTIVE THREAD, NO LIVE AGENT: ${slug} — its newest agent ${who} has been quiet ${Math.round(ageMin ?? 0)}m with no PR/merge in flight, so it likely finished or dropped. Fold its report and flip the thread to done, or resume it (SendMessage ${binding.id.slice(0, 9)}) if it's still mid-task.`);
      } else if (state === 'idle') {
        idle.push(`fray: thread ${slug} — agent ${who} quiet ${Math.round(ageMin ?? 0)}m. Fine if it's watching CI or mid-build; check in (SendMessage) if that's unexpected.`);
      }
      // 'terminal' (reconciled / parked / downstream), 'fresh' (working), 'unknown' (no file) → say nothing.
    }
  } catch {
    /* fail-open: return whatever we have */
  }
  return [...dropped, ...idle];
}

/**
 * The SHARED in-flight predicate: is a bound agent still live (not paused/done, not stale)?
 * "Not rested" is the primary signal — a rest is the ONLY completion mark, so its absence
 * means still-in-flight; age is the secondary guard — fresh output (age < DROPPED_MIN) OR no
 * output file yet (age == null → just launched). A quiet-past-DROPPED_MIN + never-rested agent
 * is the 'dropped' case agentLivenessLines flags, so it is NOT counted live here. Terminal-thread
 * exclusion is the caller's job (this predicate only judges the agent). One code path shared by
 * runningAgentCount and liveBoundAgentForThread so the two never drift.
 * @param {string} agentId
 * @param {string|null} tasksDir
 * @param {Set<string>} rested
 * @param {number} now
 * @returns {boolean}
 */
function isAgentInFlight(agentId, tasksDir, rested, now) {
  if (rested.has(agentId)) return false;
  const ageMin = agentAge(agentId, tasksDir, now);
  return ageMin == null || ageMin < DROPPED_MIN;
}

/**
 * The single LIVE agent bound to `slug`, or null. "Live" = the thread's NEWEST binding, on a
 * non-terminal thread, still in flight per {@link isAgentInFlight} (not rested, not stale). Same
 * logic/thresholds as {@link runningAgentCount}, scoped to one thread — the thread-edit-steer
 * hook uses it to decide whether an orchestrator edit needs a SendMessage steer.
 * @param {{slug: string, transcriptPath?: string|null, projectDir: string, now?: number}} args
 * @returns {{id: string, label: string|null} | null}
 */
export function liveBoundAgentForThread({ slug, transcriptPath, projectDir, now = Date.now() }) {
  try {
    const binding = newestBindingByThread(projectDir).get(slug);
    if (!binding) return null;
    let src;
    try {
      src = readFileSync(join(projectDir, '.fray', `${slug}.md`), 'utf8');
    } catch {
      return null; // no thread file → nothing to steer
    }
    const threadStatus = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
    if (TERMINAL_THREAD.has(threadStatus)) return null; // done/dismissed → no live agent
    const tasksDir = deriveTasksDir(transcriptPath);
    if (!isAgentInFlight(binding.id, tasksDir, restedAgentIds(projectDir), now)) return null;
    return { id: binding.id, label: binding.label };
  } catch {
    return null; // fail-open
  }
}

/**
 * Count of dispatched agents currently RUNNING — the "Waiting for N background agents" case.
 * An agent counts as running when: it's the NEWEST binding for its thread, it has NOT rested
 * (no completion recorded → still in flight, not paused/done), its thread isn't terminal, and
 * it isn't a long-dead stale binding. "Not rested" is the primary signal — a rest is the ONLY
 * completion mark, so its absence means the agent is still in flight; age is a secondary guard:
 * count when the output is fresh (age < DROPPED_MIN) OR there's no output file yet (age == null →
 * JUST launched, definitely running), and drop only the clearly-stale (quiet past DROPPED_MIN and
 * never rested → agentLivenessLines already flags that as 'dropped', so we don't double-count it
 * as "working"). This is DISTINCT from agentLivenessLines (which flags STRANDED active threads);
 * here we count live in-flight work so the Stop hook can surface "N still working" before the
 * unhookable idle-wait. Fail-open → 0. Never throws.
 * @param {{transcriptPath?: string|null, projectDir: string, now?: number}} args
 * @returns {number}
 */
export function runningAgentCount({ transcriptPath, projectDir, now = Date.now() }) {
  try {
    const tasksDir = deriveTasksDir(transcriptPath);
    const frayDir = join(projectDir, '.fray');
    const newest = newestBindingByThread(projectDir);
    const rested = restedAgentIds(projectDir);
    let files;
    try {
      files = readdirSync(frayDir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'));
    } catch {
      return 0;
    }
    let count = 0;
    const seen = new Set();
    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      const binding = newest.get(slug);
      if (!binding || seen.has(binding.id)) continue; // one count per agent even if it serves >1 thread
      seen.add(binding.id);
      let src;
      try {
        src = readFileSync(join(frayDir, f), 'utf8');
      } catch {
        continue;
      }
      const threadStatus = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
      if (TERMINAL_THREAD.has(threadStatus)) continue; // done/dismissed → not running
      if (isAgentInFlight(binding.id, tasksDir, rested, now)) count++; // shared predicate (not rested + fresh/just-launched)
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * The high-confidence subset of {@link agentLivenessLines}: ONLY the "ACTIVE THREAD, NO LIVE
 * AGENT" lines. Used by the per-turn reminder, where surfacing the soft idle notes every prompt
 * would be noise — but a genuinely stranded active thread SHOULD nag every turn until reconciled
 * (that is the anti-drop signal), and it's rare by construction, so it won't cry wolf.
 * @param {{transcriptPath?: string|null, projectDir: string, now?: number}} args
 * @returns {string[]}
 */
export function strandedThreadLines(args) {
  return agentLivenessLines(args).filter((l) => l.startsWith('⚠ ACTIVE THREAD'));
}

/**
 * THE WATCHER/AGENT DROP-GUARD (2026-07-06, the #327 forcing function). For each `active`,
 * non-downstream thread whose NEWEST agent was dispatched > LONG_RUNTIME_MIN ago AND is STILL
 * emitting output (age < DROPPED_MIN → looks alive) yet has produced NO terminal thread result,
 * emit a LOUD "VERIFY DIRECTLY" line. This is the case the existing 'dropped' signal CANNOT catch:
 * a `ci-watch` hung on a nameless ghost check keeps polling, so its output stays fresh and it never
 * looks stranded — it just never terminates, and "watcher running = fine" gets trusted for hours
 * (PR #327 sat effectively-green + stranded). The forcing function turns "a watcher can hang" from
 * a RULE into a hook-surfaced nudge: go check the target rollup YOURSELF.
 *
 * Runtime is measured from the binding `ts` (dispatch time), NOT output age — a watcher looks
 * "fresh" precisely because it is polling; the giveaway is the long total RUNTIME with no result.
 * Distinct from 'dropped' (stale + rested): the two bands don't overlap (this requires fresh
 * output, that requires stale). Structured return (slug/agentId/runtimeMin/line) so a consumer can
 * dedupe by agentId. Fail-open → [].
 * @param {{transcriptPath?: string|null, projectDir: string, now?: number}} args
 * @returns {{slug:string, agentId:string, runtimeMin:number, line:string}[]}
 */
export function longRunningAgentLines({ transcriptPath, projectDir, now = Date.now() }) {
  /** @type {{slug:string, agentId:string, runtimeMin:number, line:string}[]} */
  const out = [];
  try {
    const tasksDir = deriveTasksDir(transcriptPath);
    const frayDir = join(projectDir, '.fray');
    const newest = newestBindingByThread(projectDir);
    const downstream = downstreamThreads(projectDir);
    let files;
    try {
      files = readdirSync(frayDir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'));
    } catch {
      return out;
    }
    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      const binding = newest.get(slug);
      if (!binding) continue;
      let src;
      try {
        src = readFileSync(join(frayDir, f), 'utf8');
      } catch {
        continue;
      }
      const threadStatus = src.match(/^status:\s*(\S+)/m)?.[1] ?? '';
      if (threadStatus !== 'active') continue; // only an active thread can strand a running agent
      if (downstream.has(slug)) continue; // PR landing via the cascade → legitimately long, suppress
      const dispatchedMs = Date.parse(binding.ts ?? '');
      if (!Number.isFinite(dispatchedMs)) continue; // no dispatch time → can't judge runtime
      const runtimeMin = (now - dispatchedMs) / 60_000;
      if (runtimeMin <= LONG_RUNTIME_MIN) continue; // not long-running yet
      const ageMin = agentAge(binding.id, tasksDir, now);
      // Must still LOOK alive (fresh output): a STALE agent is the 'dropped' case, not this one; a
      // null age (no output file → likely a dead prior-session binding) can't confirm alive → skip.
      if (ageMin == null || ageMin >= DROPPED_MIN) continue;
      const who = `${binding.label ? `${binding.label} ` : ''}[${binding.id.slice(0, 9)}]`;
      out.push({
        slug,
        agentId: binding.id,
        runtimeMin: Math.round(runtimeMin),
        line:
          `⚠ VERIFY DIRECTLY — ${slug}: agent ${who} has run ${Math.round(runtimeMin)}m with NO terminal result ` +
          `(last output ${Math.round(ageMin)}m ago, so it LOOKS alive). A watcher can HANG on a stuck/ghost CI check ` +
          `(a nameless check-run that never reports) and look alive while stranded — check its PR/target rollup YOURSELF ` +
          `(e.g. \`gh pr view <n> --json statusCheckRollup -q '.statusCheckRollup[]|select(.status!="COMPLETED")'\`) and act; ` +
          `do NOT trust that it's still progressing.`,
      });
    }
  } catch {
    /* fail-open */
  }
  return out;
}
