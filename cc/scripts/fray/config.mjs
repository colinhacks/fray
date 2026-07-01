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

// ── PER-SESSION LIVENESS HEARTBEAT — the crux of thread OWNERSHIP ───────────────────
// A fray thread can be OWNED by a session (frontmatter `owner_session: <id>`), so several
// sessions can share one repo, each driving its own set of threads (see ownership.mjs). The
// failure to avoid: a thread owned by a session that then TERMINATES → nobody can touch it.
// Claude Code's `SessionEnd` hook is a best-effort eager signal but is NOT guaranteed on a
// crash / kill / terminal-close (verified against the hooks docs), so it cannot be the SOLE
// liveness signal. The robust fallback is a HEARTBEAT: every fray-active session stamps a
// `.seen` sidecar each turn, and ownership liveness is DERIVED from its freshness (never a
// stored "alive" flag — same compute-don't-store discipline as agent liveness). A dead owner's
// heartbeat goes stale → its threads read as ORPHANED → freely claimable. The heartbeat lives
// ALONGSIDE the on/off sentinel under `.fray/.session-state/` (a sibling `<id>.seen` file), so
// it composes with — and never collides with — the activation sentinel `<id>`.

/**
 * Path to a session's liveness heartbeat sidecar: `.fray/.session-state/<sid>.seen`.
 * @param {string} projectDir
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionHeartbeatPath(projectDir, sessionId) {
  return join(projectDir, '.fray', '.session-state', `${sessionId}.seen`);
}

/**
 * Stamp `sessionId`'s heartbeat to `ts` (default now) — the "this session is alive NOW" mark
 * refreshed each turn by the UserPromptSubmit + SessionStart hooks. Creates the state dir as
 * needed. Best-effort: any write error is swallowed (a missed beat just risks one stale read).
 * @param {string} projectDir
 * @param {string} sessionId
 * @param {number} [ts]
 */
export function touchSessionHeartbeat(projectDir, sessionId, ts = Date.now()) {
  if (!projectDir || !sessionId) return;
  try {
    const dir = join(projectDir, '.fray', '.session-state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.seen`), String(ts) + '\n');
  } catch {
    /* best-effort — a missed heartbeat is tolerated by the staleness window */
  }
}

/**
 * Read `sessionId`'s last-heartbeat epoch-ms, or `null` when absent/unreadable/garbage.
 * @param {string} projectDir
 * @param {string} sessionId
 * @returns {number|null}
 */
export function readSessionHeartbeat(projectDir, sessionId) {
  if (!projectDir || !sessionId) return null;
  try {
    const raw = readFileSync(sessionHeartbeatPath(projectDir, sessionId), 'utf8').trim();
    if (/^\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    const t = Date.parse(raw); // tolerate a hand-written ISO stamp
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Remove `sessionId`'s heartbeat (mark it dead IMMEDIATELY). Called by the SessionEnd hook
 * (graceful exit) and by `fray off`/`fray reset`. No-op if absent.
 * @param {string} projectDir
 * @param {string} sessionId
 */
export function clearSessionHeartbeat(projectDir, sessionId) {
  if (!projectDir || !sessionId) return;
  try {
    rmSync(sessionHeartbeatPath(projectDir, sessionId), { force: true });
  } catch {
    /* already gone */
  }
}

/** Default owner-staleness window (minutes): how long since a session's last heartbeat before
 *  its owned threads are treated as ORPHANED (auto-claimable without `--force`). Generous on
 *  purpose — an idle-at-prompt session heartbeats only on activity, so a short window would
 *  mis-declare a live-but-idle session dead. `--force` covers the "I KNOW it's dead, take it
 *  now" case, so the window only governs the no-force auto-claim threshold. */
export const DEFAULT_OWNER_STALE_MIN = 180;

/**
 * Resolve the owner-staleness window (minutes) from config's `state.owner_stale_min`, falling
 * back to {@link DEFAULT_OWNER_STALE_MIN}. Non-positive / unparseable → the default.
 * @param {FrayConfig} cfg
 * @returns {number}
 */
export function ownerStaleMin(cfg) {
  const raw = cfg?.state?.owner_stale_min;
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OWNER_STALE_MIN;
}

/**
 * Is `sessionId` currently LIVE — heartbeat present AND within `staleMin`, AND not explicitly
 * turned OFF this session? DERIVED (never a stored flag). A session with no heartbeat, a stale
 * one, or an `off` sentinel is dead (its owned threads are orphaned / claimable).
 * @param {string} projectDir
 * @param {string} sessionId
 * @param {number} staleMin
 * @param {number} [now]
 * @returns {boolean}
 */
export function sessionLive(projectDir, sessionId, staleMin, now = Date.now()) {
  if (!projectDir || !sessionId) return false;
  if (sessionOverride(projectDir, sessionId) === 'off') return false; // explicitly silenced → not owning
  const hb = readSessionHeartbeat(projectDir, sessionId);
  if (hb == null) return false;
  return now - hb <= staleMin * 60_000;
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
 * - `enqueued` — held until a TRIGGER fires (NOT a human decision). Two trigger kinds:
 *   (1) an IN-SESSION dep via `depends_on` — AUTO-FIRES when a named in-flight fray
 *   thread/agent goes terminal (same-file serialization, or needs the prior agent's output);
 *   (2) an EXTERNAL-world wait via `revalidate_at` — a timer re-polls an upstream PR/CI/
 *   third-party you can't watch (our work shipped, waiting on someone outside the session).
 *   EITHER way it is NOT waiting on a human, so it is EXCLUDED from the `⚖ awaiting you`
 *   queue. PREFER messaging the in-flight agent over enqueuing-then-dispatching when the work
 *   fits that agent's scope. SURFACED in the nag (depends_on form); revalidate form is quiet
 *   until due.
 * - `active` — building NOW; a live agent is on it. SURFACED. A just-decided, ready-to-run
 *   thread goes here when you dispatch it this turn.
 * - `needs-decision` — awaiting a HUMAN DECISION/ACTION, and ONLY that: cannot proceed until the
 *   maintainer decides/answers/approves. THE top-priority, human-facing bucket — SURFACED FIRST,
 *   hoisted into the board's `⚖ awaiting you` queue by its status_text, YELLOW on the status line,
 *   and the ONLY thing the Stop hook pops. (REINTRODUCED 2026-07-01 — it is the human-decision
 *   role that `blocked` briefly held under the 1.19.7 "blocked = decision-only" standardization,
 *   now split back out so `blocked` can mean the non-human wait below.)
 * - `blocked` — waiting on something that is NOT the human: a running fray thread, a pending
 *   PR/CI, an external merge. It should NOT clamor for attention — GRAY on the status line,
 *   de-emphasized on the board (rendered LAST among live groups), and EXCLUDED from the
 *   `⚖ awaiting you` queue + the Stop-hook pop (there is nothing for the human to DO). It is the
 *   general "waiting on non-human work" bucket; `enqueued` is its specialization that the board
 *   can AUTO-FIRE (it carries a `depends_on`/`revalidate_at` trigger). Prefer `enqueued` when a
 *   concrete trigger exists; use `blocked` for a coarse non-human wait with no board trigger.
 *   (REDEFINED 2026-07-01 — it NO LONGER means "awaiting you"; that role moved to
 *   `needs-decision`.)
 * - `done` / `dismissed` — TERMINAL (completed / decided-against): kept, never deleted,
 *   excluded from the active board's pending views.
 * @type {readonly string[]}
 */
export const STATUS = ['planning', 'planned', 'enqueued', 'active', 'needs-decision', 'blocked', 'done', 'dismissed'];

/**
 * BACK-COMPAT READ ALIASES — legacy status spellings, accepted FOREVER on read (never a
 * validation error) and normalized to their canonical target. A thread file still carrying
 * `status: todo` / `status: plan` validates fine and is bucketed as `planned`. The CLI
 * normalizes these to canonical on write.
 *
 * NOTE (2026-07-01): `needs-decision` is NO LONGER an alias — it is CANONICAL again (the
 * human-decision bucket). A thread carrying `status: needs-decision` now validates + buckets as
 * itself. The reverse migration is manual: threads written `status: blocked` under the brief
 * 1.19.7 "blocked = awaiting-you" regime should be re-triaged (genuinely-awaiting-human →
 * `needs-decision`; waiting-on-a-PR/thread → keep `blocked`/`enqueued`).
 * @type {Readonly<Record<string,string>>}
 */
export const STATUS_ALIASES = { todo: 'planned', plan: 'planned' };

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
 * actionable/in-flight statuses the per-turn + stop hooks list by name — in PRIORITY order
 * `needs-decision` (awaiting you — first), `active`, `planning` (active design), `enqueued`,
 * `blocked` (non-human wait — last/de-emphasized). Everything else (`planned` + the terminals)
 * is excluded from the nag. Equals `STATUS − PARKED − TERMINAL`, kept explicit so the intent —
 * AND the surface order — is readable.
 * @type {readonly string[]}
 */
export const SURFACED = ['needs-decision', 'active', 'planning', 'enqueued', 'blocked'];

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

// ── depends_on classification — thread-slug deps vs typed EXTERNAL deps ─────────────
// `depends_on` was historically an array of THREAD SLUGS only. It is now LOOSENED to also
// express dependencies on state OUTSIDE the fray board — a GitHub PR/issue, an external CI
// run, or a free-form gate — via a `<type>:<ref>` PREFIX on the entry. Backward-compat is the
// contract: a BARE entry (no recognized prefix) stays a thread slug and behaves exactly as
// before. A thread slug is a filename base and cannot contain a colon, so a recognized
// `<type>:` prefix is unambiguous. The two kinds drive DIFFERENT board behavior:
//   - THREAD deps drive READY/blocked — the board auto-fires the thread when every thread dep
//     goes terminal, and the validator flags a dangling thread-slug dep.
//   - EXTERNAL deps PARK the thread ("waiting on <ext>") — they have no in-board terminal
//     signal, so they resolve via `revalidate_at` re-polling or a manual edit (drop the dep).
//     They are NEVER flagged as dangling (there is nothing in `.fray/` to resolve them to).

/**
 * Recognized EXTERNAL dep types. An entry prefixed with one of these is an external dep;
 * `external` is the free-form catch-all. An UNRECOGNIZED prefix is deliberately NOT treated
 * as external — it stays a thread slug so a typo surfaces via the dangling-dep validator
 * (rather than silently becoming an inert external gate).
 * @type {readonly string[]}
 */
export const EXTERNAL_DEP_TYPES = ['pr', 'issue', 'ci', 'external'];

/**
 * @typedef {{kind:'thread', slug:string}} ThreadDep
 * @typedef {{kind:'external', type:string, label:string}} ExternalDep
 */

/**
 * Classify one raw `depends_on` entry. A `<type>:<ref>` prefix with a RECOGNIZED type
 * ({@link EXTERNAL_DEP_TYPES}) → an external dep (label is the full entry, e.g.
 * `pr:vercel/turborepo#13187`); anything else → a thread-slug dep (the backward-compatible
 * default). Never throws.
 * @param {string} raw
 * @returns {ThreadDep | ExternalDep}
 */
export function classifyDep(raw) {
  const s = String(raw ?? '').trim();
  const c = s.indexOf(':');
  if (c > 0) {
    const type = s.slice(0, c).toLowerCase();
    if (EXTERNAL_DEP_TYPES.includes(type)) return { kind: 'external', type, label: s };
  }
  return { kind: 'thread', slug: s };
}
