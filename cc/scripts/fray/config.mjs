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
 * THE PER-SESSION SENTINEL — how fray is toggled on/off for ONE Claude Code session.
 *
 * fray enablement is keyed on the Claude Code SESSION ID, not a repo-global flag, so
 * it can be scoped to (and toggled mid-) a single session without affecting other
 * concurrent sessions in the same repo. The session id is the same value the hooks
 * receive in their stdin JSON (`session_id`) AND that a Bash/Write tool call reads from
 * `process.env.CLAUDE_CODE_SESSION_ID` — verified equal — so an agent or human can flip
 * the current session by writing/removing the sentinel via a single tool call.
 *
 * Sentinel path: `.fray/.session-state/<session_id>`. Its presence + content encodes an
 * EXPLICIT per-session override:
 *   - file contains `off` (or `false`/`no`/`0`/`disabled`) → fray FORCED OFF this session
 *   - file contains `on`  (or `true`/`yes`/`1`/`enabled`)  → fray FORCED ON  this session
 *   - file ABSENT → no override → fall back to the default (DORMANT — opt-in: a session
 *     is active only after it explicitly runs `fray on`)
 *
 * @param {string} projectDir
 * @param {string|undefined|null} sessionId
 * @returns {'on'|'off'|null} explicit override, or null when none is set
 */
export function sessionOverride(projectDir, sessionId) {
  if (!projectDir || !sessionId) return null;
  try {
    const f = join(projectDir, '.fray', '.session-state', sessionId);
    if (!existsSync(f)) return null;
    const v = readFileSync(f, 'utf8').trim().toLowerCase();
    if (v === 'off' || v === 'false' || v === 'no' || v === '0' || v === 'disabled') return 'off';
    if (v === 'on' || v === 'true' || v === 'yes' || v === '1' || v === 'enabled') return 'on';
    // Any other / empty content → treat presence as an explicit OFF (sentinel = quiet this session).
    return 'off';
  } catch {
    return null; // unreadable → no override
  }
}

/**
 * Write the per-session sentinel for `sessionId` to force fray ON or OFF this session.
 * Creates `.fray/.session-state/` as needed. Returns the sentinel path.
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
 * Remove the per-session sentinel for `sessionId` (revert to the default). No-op if absent.
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
 * Resolve the canonical session id for the CURRENT process: the env the hooks +
 * tool calls share (`CLAUDE_CODE_SESSION_ID`), with an optional explicit override
 * (a hook's stdin `session_id`) taking precedence. Both are the same value in
 * practice (verified), so either works; the explicit arg lets a hook pass the id
 * it already parsed.
 * @param {string} [explicit]
 * @returns {string|null}
 */
export function currentSessionId(explicit) {
  return (explicit && String(explicit)) || process.env.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * THE ACTIVATION GATE — is fray active in this project, FOR THIS SESSION?
 *
 * fray ships as a GLOBALLY-loaded Claude Code plugin, so its hooks fire in EVERY
 * project. They must be a SILENT no-op until a project opts in, or a virgin repo
 * gets fray noise it never asked for.
 *
 * The gate, in order:
 *   1. `.fray/` directory EXISTS — the project has been bootstrapped (the `/fray`
 *      skill creates it on first invocation). No `.fray/` → fray is dormant here.
 *   2. The PER-SESSION SENTINEL (`.fray/.session-state/<session_id>`) — the EXPLICIT
 *      per-session opt-in. `on` → fray active for THIS session; `off` → silenced.
 *      ABSENT → the default below.
 *   3. DEFAULT (no sentinel): fray is DORMANT — activation is OPT-IN PER SESSION. A
 *      fresh session in a `.fray/` repo stays silent (every hook a no-op) until it
 *      explicitly opts in via an `on` sentinel — written by the `/fray` skill's step 0
 *      or a manual `fray on`. No sentinel → dormant, EVEN THOUGH `.fray/` exists. (This
 *      is the opt-IN model; the former default was opt-OUT — active whenever `.fray/`
 *      existed — which contradicted the plugin's "dormant until you run /fray" contract.)
 *
 * This replaces the former repo-global `enabled:` flag in `.fray/config.yml`: that
 * flag was repo-wide (hit every concurrent session, couldn't be scoped) and could
 * not be toggled mid-session. The sentinel is per-session and writable by a tool
 * call, so a session can be activated (or quieted) without a relaunch.
 *
 * @param {string} projectDir  The repo root (e.g. `process.env.CLAUDE_PROJECT_DIR`).
 * @param {string} [sessionId]  The session id (defaults to `CLAUDE_CODE_SESSION_ID`).
 * @returns {boolean} whether fray is active here, for this session.
 */
export function frayActive(projectDir, sessionId) {
  if (!projectDir) return false;
  try {
    if (!existsSync(join(projectDir, '.fray'))) return false; // not bootstrapped → dormant
  } catch {
    return false; // unreadable → treat as dormant (silent, fail-safe for a virgin repo)
  }
  const override = sessionOverride(projectDir, currentSessionId(sessionId));
  if (override === 'off') return false; // explicit per-session silence
  if (override === 'on') return true; // explicit per-session enable
  return false; // DEFAULT: OPT-IN — dormant until this session runs `fray on`
}

/**
 * The thread-status vocabulary.
 * - `plan` — the EARLIEST phase: the thread's deliverable RIGHT NOW is the
 *   DESIGN/approach itself, not an implementation. Its `## Open questions` are
 *   actively driving the work; you'd dispatch a Plan/architect agent or work it WITH
 *   the human — NEVER an implementer (there is nothing settled to implement yet).
 *   Non-terminal. THE TRANSITION RULE: a `plan` thread flips to `todo` at the END of
 *   the planning process — the instant the design is locked and only implementation
 *   remains. Planning ENDS by marking the thread `todo` (or going straight to `active`
 *   if you dispatch the implementer immediately). Distinct from `needs-decision`:
 *   `needs-decision` is blocked on ONE specific human yes/no; `plan` is ongoing
 *   collaborative design with multiple open questions still in motion.
 * - `todo` — thought-through, has an open doc, awaiting explicit actioning. The
 *   "scoped but not yet scheduled" bucket — NO defer-reason ceremony required; `todo`
 *   simply means "not yet scheduled/actioned." Use it for work that COULD start but
 *   hasn't been picked up. CRUCIAL: a ready thread waiting on a TRANSIENT blocker (a
 *   PR merge, a wave drain, a prior agent's output) is NOT `todo` — it is `enqueued`
 *   + `depends_on` (which auto-fires on the board). Encode the dependency in
 *   `depends_on` frontmatter, NEVER as prose in `## Next step`.
 * - `enqueued` — basically ready to go; AUTO-FIRES when its `depends_on` clear. Held
 *   until a NAMED in-flight agent/thread (in `depends_on`) completes — a sequencing
 *   dependency (same-file serialization, or it needs the prior agent's output).
 *   Distinct from `blocked`: an `enqueued` thread has a concrete auto-trigger (its
 *   deps clear → dispatch it), it is NOT waiting on a human/decision. PREFER messaging
 *   the in-flight agent to fold the work in over enqueuing-then-dispatching, when the
 *   work fits that agent's scope (see the fray skill — steer-in-flight beats
 *   spawn-fresh). THE INVARIANT: a thread leaving `needs-decision` (just decided)
 *   transitions to `active` (dispatch this turn) or `enqueued` (`depends_on` a blocker)
 *   — a ready thread waiting on a transient blocker is `enqueued` + `depends_on`, not
 *   `todo` and never a prose-only defer-note.
 * - `blocked` — cannot proceed; waiting on a human decision, an answer, or an
 *   external event with no in-session auto-trigger.
 * - `needs-decision` — surfaced a question the human owns; recommend-only until answered.
 * - `done` / `dismissed` — TERMINAL (completed / decided-against): kept, never
 *   deleted, excluded from the active board's pending views.
 * @type {readonly string[]}
 */
export const STATUS = ['plan', 'todo', 'enqueued', 'active', 'blocked', 'needs-decision', 'done', 'dismissed'];

/**
 * The terminal subset of {@link STATUS}: completed OR decided-against. Both are
 * kept on disk and both are excluded from the pending/board views.
 * @type {readonly string[]}
 */
export const TERMINAL = ['done', 'dismissed'];

/**
 * The PARKED (non-terminal but not-yet-picked-up) subset of {@link STATUS}:
 * `plan` (design still in progress) and `todo` (design settled, build not started).
 * Both are real, live statuses that the on-demand `fray` board DOES show — but they
 * are EXCLUDED from the AUTO-INJECTED per-turn / stop-hook "pending threads" nag,
 * because nagging the orchestrator every turn about parked work is noise. Only the
 * genuinely-actionable/in-flight statuses (`enqueued`/`active`/`blocked`/`needs-decision`)
 * are auto-surfaced; parked work is pulled up deliberately via `fray` when you choose
 * to action it. NOT terminal — these threads are open work, just not auto-nagged.
 * @type {readonly string[]}
 */
export const PARKED = ['plan', 'todo'];

/**
 * @typedef {Object} FrayConfig
 * @property {boolean} autonomousMode  Whether autonomous mode is on. Default `false`.
 * @property {Record<string, string>} state  The `state:` block — cross-cutting "what's true now" globals. Default `{}`.
 */

/**
 * The type-safe DEFAULTS, returned when `.fray/config.yml` is absent. Individual
 * malformed lines are simply skipped (we keep whatever parsed), so a partially
 * broken file still yields a fully-populated config.
 *
 * NOTE: enablement is NO LONGER a config field. It moved to the per-session sentinel
 * (see {@link frayActive} / {@link sessionOverride}). config.yml carries only
 * `autonomous_mode` + the `state:` block now.
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
 *   - `key: value`         top-level scalar (e.g. `autonomous_mode: off`)
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
