// @ts-check
/**
 * fray — the AUTOMATIC, ephemeral thread↔agent binding.
 *
 * REPLACES the old hand-maintained `agents: [{id, label}]` thread frontmatter (a
 * drift-prone ledger the orchestrator had to write by hand on every dispatch). The
 * binding is now captured AUTOMATICALLY by the `agent-bind` hook (PostToolUse on the
 * `Agent` tool): the Agent tool's RESULT carries the new `agentId`, the resolved
 * `prompt` (with the `THREAD: <slug>` tag), and the `description` (a human label) — so
 * the moment a background sub-agent is launched, the hook records `agentId → thread`
 * here. The orchestrator records NOTHING by hand; there is no frontmatter to drift.
 *
 * EPHEMERAL ROUTING STATE, NOT DUPLICATED TRUTH. This file (`.fray/.agent-bindings.jsonl`)
 * is transient routing info under the already-gitignored `.fray/` — the same class as
 * `.dispatch-ledger.jsonl` / `.rested-agents.jsonl`. It maps an instance id to the thread
 * it serves so consumers can RECONNECT a return/rest to its thread; it is never the source
 * of a thread's truth (that's the thread's own `status:` + body). Append-only; a binding is
 * immutable once written. Liveness/doneness is still DERIVED from ground truth (output-file
 * mtime + thread status) — the binding only supplies the id↔thread mapping, never a state.
 *
 * FAIL-OPEN ABSOLUTELY: every reader/writer swallows errors. A missing/corrupt bindings
 * file simply yields no bindings — the board and hooks degrade to "no agents to surface,"
 * never an error.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} projectDir */
export function bindingsPath(projectDir) {
  return join(projectDir, '.fray', '.agent-bindings.jsonl');
}

/**
 * Extract the `THREAD: <slug>` tag from a dispatch prompt — the SAME shape the dispatch
 * hook enforces (a `.fray/<slug>.md`-backed tag at the top of the prompt). Returns the
 * normalized slug (no `.fray/` prefix, no `.md` suffix) or null for an untagged one-shot.
 * @param {string} prompt
 * @returns {string|null}
 */
export function threadFromPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/^THREAD:\s*([\w./-]+)/m);
  return m ? m[1].replace(/^\.fray\//, '').replace(/\.md$/, '') : null;
}

/**
 * Record one binding. Called by the `agent-bind` PostToolUse hook. No-ops (returns false)
 * unless BOTH an agent id and a thread slug are present — an untagged one-shot has no thread
 * to bind, so nothing is written. Fail-open: a write error never throws.
 * @param {string} projectDir
 * @param {{ agentId?: string|null, thread?: string|null, label?: string|null, session?: string|null }} b
 * @returns {boolean} whether a line was written
 */
export function recordBinding(projectDir, { agentId, thread, label, session }) {
  try {
    if (!agentId || !thread) return false;
    appendFileSync(
      bindingsPath(projectDir),
      JSON.stringify({
        ts: new Date().toISOString(),
        agent_id: String(agentId),
        thread: String(thread),
        label: label ? String(label) : null,
        session: session ? String(session) : null,
      }) + '\n',
    );
    return true;
  } catch {
    return false; // fail-open — a binding write must never block a dispatch
  }
}

/**
 * Read every recorded binding (newest last). Fail-open: any error → [].
 * @param {string} projectDir
 * @returns {{ts?:string, agent_id:string, thread:string, label:string|null, session:string|null}[]}
 */
export function readBindings(projectDir) {
  /** @type {{ts?:string, agent_id:string, thread:string, label:string|null, session:string|null}[]} */
  const out = [];
  try {
    const raw = readFileSync(bindingsPath(projectDir), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.agent_id && r.thread) out.push(r);
      } catch {
        /* skip a malformed line */
      }
    }
  } catch {
    /* no file → no bindings */
  }
  return out;
}

/**
 * Group bindings by thread slug into the `{id, label}[]` shape the board + liveness hook
 * consume — the AUTOMATIC replacement for parsing `agents:` frontmatter. Dedupes by
 * agent_id (one entry per instance), keeping the LATEST label seen for that id.
 * @param {string} projectDir
 * @returns {Map<string, {id:string, label:string|null}[]>}
 */
export function bindingsByThread(projectDir) {
  /** @type {Map<string, Map<string, string|null>>} thread → (agentId → label) */
  const byThread = new Map();
  for (const b of readBindings(projectDir)) {
    let m = byThread.get(b.thread);
    if (!m) byThread.set(b.thread, (m = new Map()));
    m.set(b.agent_id, b.label ?? m.get(b.agent_id) ?? null); // latest non-null label wins
  }
  /** @type {Map<string, {id:string, label:string|null}[]>} */
  const out = new Map();
  for (const [thread, m] of byThread) {
    out.set(thread, [...m].map(([id, label]) => ({ id, label })));
  }
  return out;
}

/**
 * The thread a given agent id serves (latest binding wins), or null. Used to name the
 * thread when a rest/return is surfaced, so reconciliation points at the right file.
 * @param {string} projectDir
 * @param {string|null|undefined} agentId
 * @returns {string|null}
 */
export function threadForAgent(projectDir, agentId) {
  if (!agentId) return null;
  let found = null;
  for (const b of readBindings(projectDir)) if (b.agent_id === agentId) found = b.thread;
  return found;
}
