// @ts-check
/**
 * fray — the SHARED, type-safe config + vocab module. Every fray hook
 * (hooks/*.mjs) and the board tool (scripts/fray/index.mjs) import from here, so
 * there is exactly ONE source of truth for: the activation gate, the config schema
 * + parse, and the thread-status vocabulary.
 *
 * Dependency-free by design (no `yaml` package): Node ships no built-in YAML
 * parser, and fray must stay portable + runnable by bare `node` with zero install.
 * We hand-parse the SMALL, FLAT shape of `.fray/config.yml` (top-level scalars
 * plus the one nested `state:` block) — not a general YAML parser, just enough.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PER-SESSION SENTINEL — how fray is toggled on/off for ONE session.
 *
 * Enablement is keyed on the SESSION ID (not a repo-global flag), so it can be scoped to
 * (and toggled mid-) a single session without affecting other concurrent sessions in the
 * same repo. Sentinel path: `.fray/.session-state/<session_id>`; content `off`/`on` is an
 * explicit per-session override, absent → fall back to the default (active when `.fray/`
 * exists). Mirrors the cc harness; the Codex session id comes from the harness's hook
 * payload / env (best-effort — when no id is derivable the default applies).
 *
 * @param {string} projectDir
 * @param {string|undefined|null} sessionId
 * @returns {'on'|'off'|null}
 */
export function sessionOverride(projectDir, sessionId) {
  if (!projectDir || !sessionId) return null;
  try {
    const f = join(projectDir, '.fray', '.session-state', sessionId);
    if (!existsSync(f)) return null;
    const v = readFileSync(f, 'utf8').trim().toLowerCase();
    if (v === 'off' || v === 'false' || v === 'no' || v === '0' || v === 'disabled') return 'off';
    if (v === 'on' || v === 'true' || v === 'yes' || v === '1' || v === 'enabled') return 'on';
    return 'off';
  } catch {
    return null;
  }
}

/**
 * Write the per-session sentinel for `sessionId`. Returns its path.
 * @param {string} projectDir
 * @param {string} sessionId
 * @param {'on'|'off'} state
 * @returns {string}
 */
export function setSessionOverride(projectDir, sessionId, state) {
  const dir = join(projectDir, '.fray', '.session-state');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, sessionId);
  writeFileSync(f, state + '\n');
  return f;
}

/**
 * Remove the per-session sentinel for `sessionId`.
 * @param {string} projectDir
 * @param {string} sessionId
 */
export function clearSessionOverride(projectDir, sessionId) {
  try {
    rmSync(join(projectDir, '.fray', '.session-state', sessionId), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * THE ACTIVATION GATE — is fray active in this project, for this session?
 *   1. `.fray/` EXISTS (bootstrapped) — else dormant.
 *   2. PER-SESSION SENTINEL override (`off`/`on`) when a session id is known.
 *   3. DEFAULT: active when `.fray/` exists (the sentinel is the override).
 *
 * Replaces the former repo-global `enabled:` config flag (repo-wide, un-scopable,
 * not mid-session-toggleable).
 *
 * @param {string} projectDir  The repo root (e.g. `process.env.CLAUDE_PROJECT_DIR`).
 * @param {string} [sessionId]
 * @returns {boolean}
 */
export function frayActive(projectDir, sessionId) {
  if (!projectDir) return false;
  try {
    if (!existsSync(join(projectDir, '.fray'))) return false; // not bootstrapped → dormant
  } catch {
    return false; // unreadable → treat as dormant (silent, fail-safe for a virgin repo)
  }
  const override = sessionOverride(projectDir, sessionId);
  if (override === 'off') return false;
  if (override === 'on') return true;
  return true; // DEFAULT: `.fray/` exists → active
}

/**
 * The thread-status vocabulary.
 * - `todo` — not started; no agent dispatched, nothing blocking it.
 * - `enqueued` — READY to run (work fully scoped + decided) but deliberately held
 *   until a NAMED in-flight agent/thread completes — a sequencing dependency
 *   (same-file serialization, or it needs the prior agent's output). Distinct from
 *   `blocked`: an `enqueued` thread has a concrete auto-trigger (agent X returns →
 *   dispatch it), it is NOT waiting on a human/decision. The thread's `## Next step`
 *   must name the agent/thread it is waiting on. PREFER messaging the in-flight
 *   agent to fold the work in over enqueuing-then-dispatching, when the work fits
 *   that agent's scope (see the fray skill — steer-in-flight beats spawn-fresh).
 * - `blocked` — cannot proceed; waiting on a human decision, an answer, or an
 *   external event with no in-session auto-trigger.
 * - `needs-decision` — surfaced a question the human owns; recommend-only until answered.
 * - `planned` — scoped AND **deliberately DEFERRED** (a human/orchestrator chose
 *   "not now"). NOT a dumping ground for decided-ready work: the `## Next step` MUST
 *   state WHY it's deferred and what un-defers it (e.g. "on hold per Colin, pick up
 *   post-v0.1.1"). Distinct from `todo` ("could start now, just hasn't") and
 *   `needs-decision` (gated on a human call). THE INVARIANT: a thread leaving
 *   `needs-decision` (just decided) transitions to `active` (dispatch this turn) or
 *   `enqueued` (`depends_on` a blocker) — NEVER `planned`, unless deliberately
 *   deferred WITH a stated reason. "Decided-and-ready" is never `planned`.
 * - `done` / `dismissed` — TERMINAL (completed / decided-against): kept, never
 *   deleted, excluded from the active board's pending views.
 * @type {readonly string[]}
 */
export const STATUS = ['todo', 'planned', 'enqueued', 'active', 'blocked', 'needs-decision', 'done', 'dismissed'];

/**
 * The terminal subset of {@link STATUS}: completed OR decided-against. Both are
 * kept on disk and both are excluded from the pending/board views.
 * @type {readonly string[]}
 */
export const TERMINAL = ['done', 'dismissed'];

/**
 * @typedef {Object} FrayConfig
 * @property {boolean} autonomousMode  Whether autonomous mode is on. Default `false`.
 * @property {Record<string, string>} state  The `state:` block — cross-cutting "what's true now" globals. Default `{}`.
 */

/**
 * The type-safe DEFAULTS, returned when `.fray/config.yml` is absent. Individual
 * malformed lines are simply skipped (we keep whatever parsed), so a partially
 * broken file still yields a fully-populated config. Enablement is NOT a config
 * field — it lives in the per-session sentinel (see {@link frayActive}).
 * @returns {FrayConfig}
 */
function defaults() {
  return { autonomousMode: false, state: {} };
}

/**
 * Coerce a YAML-ish scalar to a boolean. Accepts the YAML 1.1 truthy/falsey
 * spellings fray actually uses (`true`/`false`, `on`/`off`, `yes`/`no`).
 * Anything else returns `fallback` so an unparseable value can't flip a default.
 * @param {string} raw
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBool(raw, fallback) {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === 'false' || v === 'off' || v === 'no') return false;
  return fallback;
}

/**
 * Strip surrounding single/double quotes and trailing inline `# …` comments.
 * @param {string} raw
 * @returns {string}
 */
function scalar(raw) {
  // Drop an inline comment only when the `#` is preceded by whitespace (so a `#`
  // inside a quoted value or a bare token isn't clobbered). Then trim + unquote.
  let v = raw.replace(/\s+#.*$/, '').trim();
  return v.replace(/^["']|["']$/g, '');
}

/**
 * Read + parse `.fray/config.yml` from `projectDir` into a fully-populated,
 * type-safe {@link FrayConfig}. The file is absent/unreadable → DEFAULTS.
 * A single malformed line → that line is skipped; everything else still parses.
 *
 * ENABLEMENT is NOT read here — it lives in the per-session sentinel now (see
 * {@link frayActive}). This parses only `autonomous_mode` + the `state:` block.
 *
 * Parser shape (intentionally narrow — matches fray's flat config, NOT general YAML):
 *   - `key: value`         top-level scalar (e.g. `enabled: true`, `autonomous_mode: off`)
 *   - `state:`             opens the one nested block
 *     `  key: "value"`     two-space-indented entries become `state[key] = value`
 *   - `# …` lines + blanks are ignored.
 *
 * @param {string} projectDir  The repo root (e.g. `process.env.CLAUDE_PROJECT_DIR`).
 * @returns {FrayConfig}
 */
export function loadConfig(projectDir) {
  const cfg = defaults();

  let src;
  try {
    src = readFileSync(join(projectDir, '.fray', 'config.yml'), 'utf8');
  } catch {
    return cfg; // absent / unreadable → type-safe defaults
  }

  let inState = false;
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue; // blank / comment

    // A nested `state:` entry: two-or-more leading spaces + `key: value`.
    const nested = line.match(/^[ \t]+([\w-]+):\s*(.*)$/);
    if (inState && nested) {
      cfg.state[nested[1]] = scalar(nested[2]);
      continue;
    }

    // A top-level `key: value` (or bare `key:` opening a block).
    const top = line.match(/^([\w-]+):\s*(.*)$/);
    if (!top) continue; // malformed → skip this line, keep parsing

    const key = top[1];
    const val = top[2];

    if (key === 'state') {
      inState = true; // open the nested block; `val` is empty for `state:`
      continue;
    }
    inState = false; // any other top-level key closes the state block

    // scalar() FIRST — strip any trailing inline `# …` comment before coercing,
    // else `autonomous_mode: on  # note` reads as garbage → silently falls back to
    // the default. (Bug found 2026-06-14: an inline comment flipped autonomous mode
    // back off. The nested `state:` entries already go through scalar(); the
    // top-level bools must too.)
    if (key === 'autonomous_mode') cfg.autonomousMode = toBool(scalar(val), cfg.autonomousMode);
    // unrecognized top-level keys are ignored by design (forward-compatible)
  }

  return cfg;
}
