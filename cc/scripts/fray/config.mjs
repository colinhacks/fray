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
 * The CANONICAL thread-status vocabulary — listed in LIFECYCLE order. This is the ONLY
 * set written to disk going forward; the legacy spellings (`todo`/`plan`/`needs-decision`)
 * are accepted on read via {@link STATUS_ALIASES} + {@link normalizeStatus}, never as a
 * canonical value.
 * - `planning` — ACTIVE design discussion happening RIGHT NOW: the thread's deliverable is
 *   the DESIGN/approach itself, not an implementation. Its `## Open questions` are driving
 *   the work; you'd work it WITH the human or dispatch a Plan/architect agent — NEVER an
 *   implementer (nothing is settled to build yet). SURFACED in the per-turn nag (it is the
 *   active-equivalent for a plan). THE TRANSITION RULE: a `planning` thread flips to
 *   `planned` at a design stopping point — the instant the design is parked or locked and
 *   active discussion pauses (or straight to `active` if you dispatch the implementer).
 * - `planned` — PARKED: scoped/designed but NOT actively worked. The "thought-through, has
 *   a doc, not yet scheduled" bucket — no defer-reason ceremony. NOT surfaced in the nag
 *   (the board shows it; the per-turn pulse stays quiet). CRUCIAL: a ready thread waiting
 *   on a TRANSIENT blocker (a PR merge, a prior agent's output) is NOT `planned` — it is
 *   `enqueued` + `depends_on` (which auto-fires on the board), encoded in frontmatter, never
 *   as prose in `## Next step`. (This is the RENAME of the old `todo`, and it also absorbs
 *   the old first-class `plan` status.)
 * - `enqueued` — basically ready to go; AUTO-FIRES when its `depends_on` clear. Held until a
 *   NAMED in-flight agent/thread (in `depends_on`) completes — a sequencing dependency
 *   (same-file serialization, or it needs the prior agent's output). Distinct from
 *   `blocked`: an `enqueued` thread has a concrete auto-trigger, it is NOT waiting on a
 *   human. PREFER messaging the in-flight agent to fold the work in over
 *   enqueuing-then-dispatching, when the work fits that agent's scope (steer-in-flight beats
 *   spawn-fresh). SURFACED in the nag.
 * - `active` — building NOW; a live agent is on it. SURFACED. A just-decided, ready-to-run
 *   thread goes here when you dispatch it this turn.
 * - `blocked` — CANONICAL for blocked / awaiting-human-decision / waiting-on-external:
 *   cannot proceed without a human decision, an answer, or an external event with no
 *   in-session auto-trigger. SURFACED, and hoisted into the board's `⚖ awaiting you` queue
 *   by its status_text. (This ABSORBS the old `needs-decision` status — that spelling is no
 *   longer canonical; it reads as `blocked`.)
 * - `done` / `dismissed` — TERMINAL (completed / decided-against): kept, never deleted,
 *   excluded from the active board's pending views.
 * @type {readonly string[]}
 */
export const STATUS = ['planning', 'planned', 'enqueued', 'active', 'blocked', 'done', 'dismissed'];

/**
 * BACK-COMPAT READ ALIASES — legacy status spellings, accepted FOREVER on read (never a
 * validation error) and normalized to their canonical target. A thread file still carrying
 * `status: todo` / `status: plan` / `status: needs-decision` validates fine and is bucketed
 * as its canonical equivalent. The CLI normalizes these to canonical on write.
 * @type {Readonly<Record<string,string>>}
 */
export const STATUS_ALIASES = { todo: 'planned', plan: 'planned', 'needs-decision': 'blocked' };

/**
 * The full set ACCEPTED by the validator: canonical statuses plus the read-aliases. Used
 * for the "expected one of …" error message and the `--status <s>` filter.
 * @type {readonly string[]}
 */
export const ACCEPTED_STATUSES = [...STATUS, ...Object.keys(STATUS_ALIASES)];

/**
 * Normalize a raw `status:` value to its CANONICAL form: a legacy alias maps to its target,
 * a canonical value passes through, anything else (incl. unknown/garbage) returns unchanged
 * so the caller's validation can still reject it. Apply this wherever a thread's raw status
 * is read, validated, or bucketed.
 * @param {string|undefined|null} raw
 * @returns {string|undefined|null}
 */
export function normalizeStatus(raw) {
  if (raw == null) return raw;
  const v = String(raw).trim();
  return STATUS_ALIASES[v] ?? v;
}

/**
 * Is `raw` an accepted status — a canonical value OR a read-alias? (Validation accepts both;
 * rejects anything else.)
 * @param {string|undefined|null} raw
 * @returns {boolean}
 */
export function isValidStatus(raw) {
  if (raw == null) return false;
  const v = String(raw).trim();
  return STATUS.includes(v) || Object.prototype.hasOwnProperty.call(STATUS_ALIASES, v);
}

/**
 * The terminal subset of {@link STATUS}: completed OR decided-against. Both are
 * kept on disk and both are excluded from the pending/board views.
 * @type {readonly string[]}
 */
export const TERMINAL = ['done', 'dismissed'];

/**
 * The PARKED (non-terminal but not-yet-actively-worked) subset of canonical {@link STATUS}:
 * just `planned`. It is a real, live status the on-demand `fray` board DOES show — but it is
 * EXCLUDED from the AUTO-INJECTED per-turn / stop-hook "pending threads" nag, because nagging
 * the orchestrator every turn about parked work is noise. Pull parked work up deliberately
 * via `fray` when you choose to action it. (`planning` is NOT parked — active design counts
 * as in-flight and IS surfaced.)
 * @type {readonly string[]}
 */
export const PARKED = ['planned'];

/**
 * The SURFACED (auto-nagged) subset of canonical {@link STATUS}: the genuinely
 * actionable/in-flight statuses the per-turn + stop hooks list by name —
 * `planning` (active design), `enqueued`, `active`, `blocked`. Everything else
 * (`planned` + the terminals) is excluded from the nag. Equals
 * `STATUS − PARKED − TERMINAL`, kept explicit so the intent is readable.
 * @type {readonly string[]}
 */
export const SURFACED = ['planning', 'enqueued', 'active', 'blocked'];

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

// ── ANTI-DRIFT RECONCILE FORCING-FUNCTION ─────────────────────────────────────────
// The board is COMPUTED from per-thread frontmatter, so a thread whose status drifted
// from reality (a PR merged, but the thread never flipped to done) is surfaced as live
// truth until SOMETHING re-grounds it. "Reconcile" historically only meant "fold agent
// returns" — nothing forced a periodic re-grounding of the whole board against the actual
// code/PRs. This forcing-function fixes that: a LAST-COMPLETE-RECONCILE timestamp persists
// in `.fray/.last-reconcile` (gitignored runtime, like the rest of `.fray`); when it goes
// stale the per-turn hook emits a LOUD instruction to spin up a reconcile sub-agent. The
// hook does only timestamp math — the actual PR-liveness checking belongs to the dispatched
// reconcile sub-agent, NOT the every-turn hook.

/** Default staleness threshold (minutes) before the per-turn hook nags for a reconcile. */
export const DEFAULT_RECONCILE_THRESHOLD_MIN = 15;

/**
 * Resolve the reconcile-staleness threshold (minutes) from the parsed config's `state:`
 * block (`reconcile_threshold_min`), falling back to {@link DEFAULT_RECONCILE_THRESHOLD_MIN}.
 * A non-positive / unparseable value falls back too.
 * @param {FrayConfig} cfg
 * @returns {number}
 */
export function reconcileThresholdMin(cfg) {
  const raw = cfg?.state?.reconcile_threshold_min;
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RECONCILE_THRESHOLD_MIN;
}

/**
 * Path to the last-complete-reconcile timestamp file (epoch-ms) under `.fray/`.
 * @param {string} projectDir
 * @returns {string}
 */
export function lastReconcilePath(projectDir) {
  return join(projectDir, '.fray', '.last-reconcile');
}

/**
 * Read the persisted last-reconcile epoch-ms, or `null` when absent/unreadable/garbage.
 * @param {string} projectDir
 * @returns {number|null}
 */
export function readLastReconcile(projectDir) {
  try {
    const raw = readFileSync(lastReconcilePath(projectDir), 'utf8').trim();
    // Canonical form is epoch-ms (what writeLastReconcile emits). Match it strictly — a bare
    // parseInt would accept an ISO string like "2026-07-01T..." as 2026 (parseInt stops at the
    // '-'), yielding a ~56-year-stale age that nags every turn. Agents demonstrably hand-write
    // this file instead of running `fray reconcile`, so also accept a parseable ISO date.
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Stamp the last-complete-reconcile timestamp to `ts` (default now). Creates `.fray/` as
 * needed. Returns the file path.
 * @param {string} projectDir
 * @param {number} [ts]
 * @returns {string}
 */
export function writeLastReconcile(projectDir, ts = Date.now()) {
  const dir = join(projectDir, '.fray');
  mkdirSync(dir, { recursive: true });
  const f = lastReconcilePath(projectDir);
  writeFileSync(f, String(ts) + '\n');
  return f;
}

/**
 * Is the board reconcile STALE? Pure timestamp math (no I/O) so it is trivially testable.
 * A missing timestamp (`lastMs == null`) counts as stale — instruct a FIRST reconcile.
 * @param {number|null} lastMs   the persisted last-reconcile epoch-ms (or null when absent)
 * @param {number} thresholdMin  staleness threshold in minutes
 * @param {number} [now]
 * @returns {boolean}
 */
export function isReconcileStale(lastMs, thresholdMin, now = Date.now()) {
  if (lastMs == null) return true;
  return now - lastMs > thresholdMin * 60_000;
}

// ── REVALIDATE — time-based recheck for threads waiting on EXTERNAL state ──────────
// A thread `blocked` on something with no in-session auto-trigger (an external-repo PR
// awaiting a maintainer, an un-watchable CI, a third-party response) would otherwise sit
// silently or need a brittle live-polling shell (which dies on session end). Instead it
// carries a DURABLE `revalidate_at: <ISO8601 UTC>` frontmatter timestamp: while that time
// is in the FUTURE the thread is "parked on a timer" (quiet — NOT in the per-turn nag); once
// `now ≥ revalidate_at` it is "due" and the fray-reminder hook + board surface it LOUDLY for
// a recheck. The optional `last_checked: <ISO8601>` records the previous poll. This is the
// SINGLE source of the timer semantics, shared by the hook and the board so they never drift.

/**
 * @typedef {Object} RevalidateState
 * @property {number} atMs          `revalidate_at` parsed to epoch-ms.
 * @property {string|null} lastChecked  the raw `last_checked` scalar, or null when unset.
 * @property {boolean} due          whether `now ≥ revalidate_at` (the thread is due for recheck).
 * @property {number} etaMin        minutes until due (negative once due); for the board's "next check in".
 */

/**
 * Compute a thread's {@link RevalidateState} from its raw frontmatter scalars. ROBUST BY
 * CONTRACT: a missing / empty / unparseable `revalidate_at` → `null` ("no timer set"), never
 * a throw — so a thread WITHOUT the field behaves exactly as it always has, and a malformed
 * value degrades to not-set rather than crashing the hook. (The board separately surfaces a
 * present-but-unparseable value as a non-fatal warning so a typo'd timestamp isn't silently
 * swallowed.) Quotes are stripped to match the frontmatter quoter; `Date.parse` accepts the
 * ISO-8601 UTC form fray writes.
 * @param {string|undefined|null} revalidateAtRaw  raw `revalidate_at` scalar (ISO-8601 UTC)
 * @param {string|undefined|null} lastCheckedRaw   raw optional `last_checked` scalar
 * @param {number} [now]
 * @returns {RevalidateState | null}
 */
export function revalidateState(revalidateAtRaw, lastCheckedRaw, now = Date.now()) {
  if (revalidateAtRaw == null) return null;
  const v = String(revalidateAtRaw).trim().replace(/^["']|["']$/g, '');
  if (!v) return null;
  const atMs = Date.parse(v);
  if (!Number.isFinite(atMs)) return null; // malformed → treat as not-set (never crash)
  const lcRaw = lastCheckedRaw == null ? '' : String(lastCheckedRaw).trim().replace(/^["']|["']$/g, '');
  return { atMs, lastChecked: lcRaw || null, due: now >= atMs, etaMin: Math.round((atMs - now) / 60_000) };
}

/**
 * Humanize a minutes-until-due into a compact ETA (`45m`, `7h`, `2d`) for the board's
 * "next check in" line. Clamps negatives (an already-due timer) to `0m`.
 * @param {number} etaMin
 * @returns {string}
 */
export function formatEta(etaMin) {
  const m = Math.max(0, etaMin);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (60 * 24))}d`;
}
