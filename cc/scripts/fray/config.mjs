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

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
 * The CANONICAL thread-status vocabulary — listed in LIFECYCLE order. This is the ONLY set
 * written to disk going forward; legacy spellings (`todo`/`plan`/`enqueued`/`needs-decision`)
 * are accepted on read via {@link STATUS_ALIASES} + {@link normalizeStatus}, never written.
 *
 * THE WAITING MODEL (2026-07-08, refining the 2026-07-01 unified model): "awaiting a human" is
 * now its OWN first-class status — `needs-human` — no longer an encoding of `blocked`. `blocked`
 * narrows to MACHINE-waits ONLY and REQUIRES a resolution-mechanism field. So the human(yellow)/
 * machine(gray) split is back in the WORD (`needs-human` vs `blocked`); the mechanism field now
 * only distinguishes the two MACHINE flavors of `blocked` (threads vs timer). BACK-COMPAT: a
 * legacy `blocked` thread with NO machine field reads as `needs-human` (see {@link
 * effectiveStatus}); the legacy `needs-decision` spelling aliases to `needs-human`.
 *
 * - `planning` — ACTIVE design discussion happening RIGHT NOW: the deliverable is the DESIGN
 *   itself, not an implementation. Open questions in motion; worked WITH the human or a Plan/
 *   architect agent, NEVER an implementer. SURFACED. Flips to `planned` at a design stopping
 *   point (or straight to `active` when you dispatch the build).
 * - `planned` — PARKED: scoped/designed but NOT actively worked. NOT surfaced in the nag (the
 *   board shows it; the pulse stays quiet). A thread waiting on a TRANSIENT blocker is NOT
 *   `planned` — it is `blocked` + the right mechanism field. (RENAME of the old `todo`; also
 *   absorbs the old `plan`.)
 * - `active` — building NOW; a live agent is on it. SURFACED.
 * - `needs-human` — AWAITING A HUMAN: a question / decision / approval, OR a finished result that
 *   needs human review, that ONLY the maintainer can resolve. REQUIRES a `status_text` stating
 *   the ask. YELLOW, hoisted to the top of the `⚖ awaiting you` queue, surfaced in the nag by its
 *   `status_text` (untruncated), the ONLY thing the Stop hook pops. (Absorbs the old
 *   `needs-decision` spelling AND the old `blocked`-with-no-machine-field human encoding.)
 * - `blocked` — CANNOT run, waiting on NON-human work. REQUIRES exactly ONE machine mechanism
 *   ({@link blockMechanism}); a `blocked` thread with no machine field is mis-encoded and reads
 *   as `needs-human` (the validator warns). The mechanism is one of:
 *     (1) `blocking_threads: [slug, …]` — blocked on other THREADS going terminal. GRAY,
 *         de-emphasized, AUTO-FIRES: the instant every listed thread is done/dismissed the board
 *         flips it `▶ READY — dispatch now` (+ the DROP-RISK callout). (Old `enqueued`; the field
 *         is the RENAME of `depends_on`, which is still accepted as a read-alias field. Entries
 *         may also be typed EXTERNAL gates `pr:`/`ci:`/`external:` — those park, they don't fire.)
 *     (2) `revalidate_at: <ISO>` (+ `last_checked`) — blocked on an external event with a TIMER.
 *         GRAY/dim, parked + quiet until due, then surfaces loudly for a recheck.
 *   Machine-blocked threads do NOT clamor for attention — GRAY, rendered LAST among live groups,
 *   EXCLUDED from the `⚖ awaiting you` queue + the Stop-hook pop.
 * - `done` / `dismissed` — TERMINAL (completed / decided-against): kept, never deleted,
 *   excluded from the active board's pending views.
 * @type {readonly string[]}
 */
export const STATUS = ['planning', 'planned', 'active', 'needs-human', 'blocked', 'done', 'dismissed'];

/**
 * BACK-COMPAT READ ALIASES — legacy status spellings, accepted FOREVER on read (never a
 * validation error) and normalized to their canonical target. `todo`/`plan` → `planned`;
 * `enqueued` → `blocked` (dep-blocked, a machine wait); `needs-decision` → `needs-human` (the
 * human-decision state, promoted to its own first-class status on 2026-07-08). A thread still
 * carrying any of these validates fine and buckets as its canonical target; the CLI writes the
 * canonical word. NOTE: a legacy `blocked` thread with no machine field is a SEPARATE contextual
 * alias to `needs-human` — that one depends on the mechanism fields, so it lives in
 * {@link effectiveStatus}, not this pure string map.
 * @type {Readonly<Record<string,string>>}
 */
export const STATUS_ALIASES = { todo: 'planned', plan: 'planned', enqueued: 'blocked', 'needs-decision': 'needs-human' };

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
 * The SURFACED (auto-nagged) subset of canonical {@link STATUS} — the actionable/in-flight
 * statuses, in PRIORITY order. `needs-human` is FIRST (top-priority — the maintainer must act;
 * the ⚖ awaiting-you queue). `blocked` is now MACHINE-only (gray, de-emphasized), rendered after
 * `active`. Equals `STATUS − PARKED − TERMINAL`.
 * @type {readonly string[]}
 */
export const SURFACED = ['needs-human', 'active', 'blocked', 'planning'];

// ── the RESOLUTION MECHANISM of a `blocked` thread — the crux of the unified waiting model ──
// A `blocked` thread carries EXACTLY ONE mechanism describing HOW it unblocks; the board derives
// color / urgency / ordering / auto-fire from this, NOT from the status word. Precedence when
// mis-configured with more than one machine field: timer > threads > human (and the validator
// warns on the ambiguity). This is a PURE function of already-parsed booleans so both the board
// and the hooks compute it identically.

/**
 * @typedef {'human'|'threads'|'timer'} BlockMechanism
 */

/**
 * Derive a blocked thread's resolution mechanism from which fields are set.
 *   - `timer`   — a (parseable) `revalidate_at` is present → re-poll on a timer. GRAY/dim.
 *   - `threads` — `blocking_threads`/`depends_on` is non-empty → auto-fires when its thread
 *                 deps go terminal (external gate entries park it). GRAY.
 *   - `human`   — neither → only the maintainer can unblock it. YELLOW, the ⚖ awaiting-you queue.
 * @param {{hasBlockingThreads?: boolean, hasTimer?: boolean}} f
 * @returns {BlockMechanism}
 */
export function blockMechanism({ hasBlockingThreads, hasTimer }) {
  if (hasTimer) return 'timer';
  if (hasBlockingThreads) return 'threads';
  return 'human';
}

/**
 * Is a `blocked` thread a HUMAN-decision block (the ⚖ awaiting-you case)? True ⟺ its mechanism
 * is `human` — no `blocking_threads`/`depends_on` and no `revalidate_at`. The single predicate
 * the board / decisions / reminder / stop-hook / statusline share so "awaiting you" can never
 * drift between them.
 * @param {{hasBlockingThreads?: boolean, hasTimer?: boolean}} f
 * @returns {boolean}
 */
export function isHumanBlocked(f) {
  return blockMechanism(f) === 'human';
}

/**
 * The EFFECTIVE (bucketing) status of a thread, given its raw `status:` and its mechanism fields.
 * Applies the pure string aliases ({@link normalizeStatus}) AND the ONE contextual alias that
 * needs the fields: a legacy `blocked` thread with NO machine field (the old pre-`needs-human`
 * human-wait encoding) reads as `needs-human`. A `blocked` thread WITH a machine field stays
 * `blocked` (a machine wait). Everything else passes through its normalized form. This is the
 * single predicate the board, `fray decisions`, the reminder/stop hooks, and the statusline share
 * so "awaiting a human" can never drift between them — a thread is awaiting-you IFF
 * `effectiveStatus(...) === 'needs-human'`.
 * @param {string|undefined|null} rawStatus
 * @param {{hasBlockingThreads?: boolean, hasTimer?: boolean}} [fields]
 * @returns {string|undefined|null}
 */
export function effectiveStatus(rawStatus, { hasBlockingThreads, hasTimer } = {}) {
  const s = normalizeStatus(rawStatus);
  if (s === 'blocked' && !hasBlockingThreads && !hasTimer) return 'needs-human';
  return s;
}

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
// in `.fray/.last-reconcile` (gitignored runtime, like the rest of `.fray`); the per-turn
// hook decides whether to nag via a TWO-TRIGGER gate (see shouldNagReconcile) and, when hot,
// emits a LOUD instruction to spin up a reconcile sub-agent. The hook does only mtime/timestamp
// math — the actual PR-liveness checking belongs to the dispatched reconcile sub-agent, NEVER
// this every-turn hook.
//
// WHY TWO TRIGGERS (2026-07-01, replacing the pure elapsed-time gate). The old gate was pure
// wall-clock (`now − last_reconcile > threshold`); it fired every turn once the clock ran out
// EVEN WHEN NOTHING CHANGED, so the orchestrator tuned it out. The new gate fires only when
// there is a real reason to re-ground:
//   (1) DIRTY-GATE (primary, precise): the newest mtime among NON-TERMINAL threads is NEWER
//       than the last reconcile → a thread moved since we last re-grounded, so re-ground it.
//       Silent when nothing moved. This is the no-cry-wolf trigger.
//   (2) EXTERNAL-DRIFT BACKSTOP (secondary): a LONG wall-clock backstop that exists purely to
//       catch drift the dirty-gate structurally CANNOT see — a PR merging or CI flipping with
//       NO thread edit (touches no file → bumps no mtime). Long by design so it never becomes
//       the every-turn nag the dirty-gate replaced.

/** Default EXTERNAL-DRIFT BACKSTOP (minutes): the long wall-clock fallback that catches drift
 *  producing NO thread-file change (a PR merge, a CI flip). Long on purpose — the precise,
 *  every-change trigger is the dirty-gate; this only backstops the file-invisible cases. */
export const DEFAULT_RECONCILE_BACKSTOP_MIN = 120;

/**
 * Resolve the external-drift BACKSTOP (minutes) from the parsed config's `state:` block
 * (`reconcile_threshold_min`), falling back to {@link DEFAULT_RECONCILE_BACKSTOP_MIN}. A
 * non-positive / unparseable value falls back too. (The config KEY keeps its historical name
 * `reconcile_threshold_min` — it now tunes the backstop half of the gate; the dirty-gate is a
 * strict mtime comparison and is NOT time-configurable.)
 * @param {FrayConfig} cfg
 * @returns {number}
 */
export function reconcileBackstopMin(cfg) {
  const raw = cfg?.state?.reconcile_threshold_min;
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RECONCILE_BACKSTOP_MIN;
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
 * @typedef {'first'|'dirty'|'backstop'|null} ReconcileNagReason
 */

/**
 * THE RECONCILE-NAG GATE — pure (no I/O) so it is trivially testable. Decides whether the
 * per-turn hook should nag for a reconcile, and WHY, via the two-trigger model above. Fires
 * (nag=true) when ANY of:
 *   - `first`    — no last-reconcile stamp (`lastReconcileMs == null`) → instruct a FIRST reconcile.
 *   - `dirty`    — the newest NON-TERMINAL thread mtime is NEWER than the last reconcile → a
 *                  thread moved since we re-grounded (the precise, no-cry-wolf trigger).
 *   - `backstop` — `now − lastReconcile > backstopMin` → long wall-clock fallback for external
 *                  drift (PR/CI) that changed no file. Checked only when NOT already dirty.
 * Otherwise `{ nag: false, reason: null }` — SILENT when the board is clean, which is the point.
 * A missing `newestNonTerminalMtimeMs` (null — no non-terminal threads, or none stat-able) simply
 * can't trip the dirty-gate; `first`/`backstop` still apply.
 * @param {{newestNonTerminalMtimeMs: number|null, lastReconcileMs: number|null, backstopMin: number, now?: number}} f
 * @returns {{nag: boolean, reason: ReconcileNagReason}}
 */
export function shouldNagReconcile({ newestNonTerminalMtimeMs, lastReconcileMs, backstopMin, now = Date.now() }) {
  if (lastReconcileMs == null) return { nag: true, reason: 'first' };
  if (newestNonTerminalMtimeMs != null && newestNonTerminalMtimeMs > lastReconcileMs) {
    return { nag: true, reason: 'dirty' };
  }
  if (now - lastReconcileMs > backstopMin * 60_000) return { nag: true, reason: 'backstop' };
  return { nag: false, reason: null };
}

/**
 * The STAMP-LAST instruction — shared by every surface that nudges a reconcile (the
 * UserPromptSubmit backstop AND the Stop-hook rest path) so the ordering rule never drifts
 * between them. The reconcile agent EDITS threads (flips drifted statuses), which bumps their
 * mtime; if it stamped `.fray/.last-reconcile` BEFORE those edits, its own edits would leave
 * the board dirty forever (the dirty-gate would re-fire next turn). So `fray reconcile` (the
 * stamp) MUST be its LAST action, after every thread edit. Reconcile is a JUDGMENT task →
 * dispatch at Opus, high effort.
 *
 * SCOPED (2026-07-06): when the dirty-gate knows exactly WHICH thread(s) drifted, pass their
 * slugs so the instruction says "re-ground <those>" instead of "re-ground EVERY non-terminal
 * thread" — a precise nudge, not a whole-board sweep. An empty/absent scope keeps the full-sweep
 * phrasing (the backstop/first-reconcile case, where drift is file-invisible so no slug is known).
 * @param {string[]} [scopeSlugs]
 * @returns {string}
 */
export function reconcileStampLastInstruction(scopeSlugs) {
  const scope = Array.isArray(scopeSlugs) && scopeSlugs.length
    ? `re-ground ${scopeSlugs.join(', ')} (plus any thread whose EXTERNAL state — a referenced PR/CI — moved)`
    : 're-ground EVERY non-terminal thread';
  return `AUTO-DISPATCH a BACKGROUND reconcile sub-agent (reflexively — don't deliberate; reconcile is a JUDGMENT task → Opus, high effort): ${scope} against ground truth (PR merged? symbol exists? work shipped?), flip drifted statuses to match, then — as its LAST step, AFTER every thread edit — run \`fray reconcile\` to stamp \`.fray/.last-reconcile\`. Stamping LAST is REQUIRED: the agent's own edits bump thread mtimes, so stamping before them leaves the board dirty forever.`;
}

// ── STAMP-ON-AGENT-COMPLETION — the write-ownership treadmill fix (2026-07-06) ──────
// fray MANDATES write-ownership: a dispatched agent edits its OWN thread. But every such edit
// bumps that thread's mtime past `.last-reconcile`, so the dirty-gate reads the board stale and
// nags the orchestrator to re-ground a thread the agent JUST reconciled — the system fighting its
// own design. Fix: when a thread-bound agent rests, the SubagentStop hook records the thread's
// current mtime here as "reconciled by its owning agent up to this point." The dirty-gate then
// treats a thread whose current mtime is NOT NEWER than its owner-mark as CLEAN (an owning-agent
// edit is folded via the REST path, never the reconcile path). Only NON-owning drift — an
// orchestrator edit, or external state moving a referenced PR/CI — trips the reconcile nag.

/** Path to the per-thread owner-reconcile marks: `{ [slug]: mtimeMs }` under `.fray/`. */
export function ownerReconciledPath(projectDir) {
  return join(projectDir, '.fray', '.owner-reconciled.json');
}

/** Read the `{ [slug]: mtimeMs }` owner-reconcile map, or `{}` when absent/unreadable/garbage. */
export function readOwnerReconciled(projectDir) {
  try {
    const o = JSON.parse(readFileSync(ownerReconciledPath(projectDir), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Record that `slug`'s owning agent reconciled it AT `mtimeMs` (its thread file's mtime at rest).
 * Merge-writes, capped so a long-lived board can't grow the map without bound. Best-effort.
 * @param {string} projectDir @param {string} slug @param {number} mtimeMs
 */
export function stampOwnerReconciled(projectDir, slug, mtimeMs) {
  if (!slug || !(mtimeMs > 0)) return;
  try {
    const map = readOwnerReconciled(projectDir);
    map[slug] = mtimeMs;
    const entries = Object.entries(map);
    const capped = entries.length > 400
      ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 400))
      : map;
    mkdirSync(join(projectDir, '.fray'), { recursive: true });
    writeFileSync(ownerReconciledPath(projectDir), JSON.stringify(capped) + '\n');
  } catch {
    /* best-effort — a missed stamp just risks one spurious reconcile nag */
  }
}

/**
 * Is a thread's current mtime already accounted for by its OWNING AGENT's reconcile mark? True ⟺
 * a mark exists and the current mtime is NOT NEWER than it — i.e. the latest edit was the owning
 * agent's own thread write (folded via the rest path), NOT orchestrator-facing drift. Such a
 * thread must NOT trip the dirty-gate. Pure predicate so the reminder + stop hook agree.
 * @param {number} currentMtimeMs @param {number|undefined} ownerMarkMs
 * @returns {boolean}
 */
export function ownerCleanMtime(currentMtimeMs, ownerMarkMs) {
  return typeof ownerMarkMs === 'number' && currentMtimeMs > 0 && currentMtimeMs <= ownerMarkMs;
}

/**
 * STRUCTURED un-drained-queued-follow-up detection. The OLD test — `\bQUEUED\b` anywhere in the
 * source — false-fired on historical CHECKED-OFF items and any prose mention. This matches ONLY an
 * UNCHECKED todo checkbox (`- [ ]`) whose text carries the live-follow-up shape (a `QUEUED` marker
 * or a "dispatch … return" instruction). A checked `- [x]` is DONE and never flags; prose never
 * flags. (A future structured frontmatter field could replace this; the precise checkbox matcher
 * needs no thread-authoring change.)
 * @param {string} src
 * @returns {boolean}
 */
export function hasQueuedFollowup(src) {
  if (typeof src !== 'string') return false;
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[ \]\s+(.*)$/); // UNCHECKED checkbox only ("[ ]", never "[x]")
    if (!m) continue;
    if (/\bQUEUED\b/.test(m[1]) || /\bdispatch\b[^.]*\breturn\b/i.test(m[1])) return true;
  }
  return false;
}

/**
 * ASSESS BOARD DRIFT — pure (no I/O), so it is trivially testable. Given per-thread records +
 * the owner-reconcile marks + the last-reconcile stamp, returns whether the board needs
 * re-grounding, WHY (via {@link shouldNagReconcile}), and the SPECIFIC drifted slugs (for the
 * scoped nudge). A non-terminal thread contributes ONLY when it is not owner-clean — an
 * owning-agent edit is not drift (see the STAMP-ON-AGENT-COMPLETION note above).
 * @param {{records:{slug:string,status:string|undefined,mtimeMs:number}[], ownerReconciled:Record<string,number>, lastReconcileMs:number|null, backstopMin:number, now?:number}} a
 * @returns {{nag:boolean, reason:ReconcileNagReason, dirtySlugs:string[]}}
 */
export function assessDrift({ records, ownerReconciled, lastReconcileMs, backstopMin, now = Date.now() }) {
  let newest = null;
  /** @type {string[]} */
  const dirtySlugs = [];
  for (const r of records) {
    if (TERMINAL.includes(r.status ?? '')) continue;
    if (!(r.mtimeMs > 0)) continue;
    if (ownerCleanMtime(r.mtimeMs, ownerReconciled?.[r.slug])) continue; // owning-agent edit — not drift
    if (lastReconcileMs == null || r.mtimeMs > lastReconcileMs) dirtySlugs.push(r.slug);
    if (newest == null || r.mtimeMs > newest) newest = r.mtimeMs;
  }
  const { nag, reason } = shouldNagReconcile({ newestNonTerminalMtimeMs: newest, lastReconcileMs, backstopMin, now });
  return { nag, reason, dirtySlugs };
}

/**
 * COMPUTE BOARD DRIFT — the I/O wrapper over {@link assessDrift} the STOP hook uses (the per-turn
 * reminder reuses its own richer scan). Scans `.fray/*.md`, builds records (status + mtime),
 * flags un-drained queued follow-ups ({@link hasQueuedFollowup}), and returns the drift verdict
 * plus the queued slugs — the "is there GENUINE work before idle?" signal for the self-satisfying
 * stop. Fail-open: any error → clean ({nag:false, empty lists}).
 * @param {string} projectDir @param {{backstopMin:number, now?:number}} opts
 * @returns {{nag:boolean, reason:ReconcileNagReason, dirtySlugs:string[], queuedSlugs:string[], lastReconcileMs:number|null}}
 */
export function computeBoardDrift(projectDir, { backstopMin, now = Date.now() }) {
  const lastReconcileMs = readLastReconcile(projectDir);
  try {
    const ownerReconciled = readOwnerReconciled(projectDir);
    const frayDir = join(projectDir, '.fray');
    let files;
    try {
      files = readdirSync(frayDir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'));
    } catch {
      return { nag: false, reason: null, dirtySlugs: [], queuedSlugs: [], lastReconcileMs };
    }
    /** @type {{slug:string,status:string|undefined,mtimeMs:number}[]} */
    const records = [];
    /** @type {string[]} */
    const queuedSlugs = [];
    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      let src;
      let mtimeMs = 0;
      try {
        const fp = join(frayDir, f);
        src = readFileSync(fp, 'utf8');
        mtimeMs = statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      const status = normalizeStatus(src.match(/^status:\s*(\S+)/m)?.[1]) ?? undefined;
      records.push({ slug, status, mtimeMs });
      if (!TERMINAL.includes(status ?? '') && hasQueuedFollowup(src)) queuedSlugs.push(slug);
    }
    const { nag, reason, dirtySlugs } = assessDrift({ records, ownerReconciled, lastReconcileMs, backstopMin, now });
    return { nag, reason, dirtySlugs, queuedSlugs, lastReconcileMs };
  } catch {
    return { nag: false, reason: null, dirtySlugs: [], queuedSlugs: [], lastReconcileMs };
  }
}

// ── DEBOUNCE the 'dirty' reconcile nag (2026-07-06) ─────────────────────────────────
// A burst of return-folding is several quick turns, each editing a non-terminal thread — every
// one of which would otherwise trip the dirty-gate and nag a reconcile. Debounce it: a `dirty`
// signal must PERSIST both > DEBOUNCE_MIN minutes AND > DEBOUNCE_TURNS turns before it nags.
// `first`/`backstop` are inherently non-bursty (a baseline / a 2-hour fallback) and nag at once.

/** Default debounce: a `dirty` reconcile nag holds until it has persisted this long (minutes)… */
export const DEFAULT_RECONCILE_DEBOUNCE_MIN = 3;
/** …AND this many turns. Both must be exceeded — the AND is what survives a fast fold-burst. */
export const DEFAULT_RECONCILE_DEBOUNCE_TURNS = 2;

/**
 * DEBOUNCE gate — pure. `reason == null` (board clean) resets the window. `first`/`backstop` nag
 * immediately (no window). A `dirty` reason starts a window on first sight (no nag yet) and nags
 * only once the window has aged past BOTH thresholds. The caller owns reading/incrementing/
 * persisting `turns` + the window state.
 * @param {{reason:ReconcileNagReason, now:number, turns:number, state:{dirty_since_ms?:number,dirty_since_turn?:number}, debounceMin:number, debounceTurns:number}} a
 * @returns {{nag:boolean, state:{dirty_since_ms?:number,dirty_since_turn?:number}}}
 */
export function debounceReconcileNag({ reason, now, turns, state, debounceMin, debounceTurns }) {
  if (reason == null) return { nag: false, state: {} }; // clean → clear the window
  if (reason !== 'dirty') return { nag: true, state: {} }; // first/backstop → immediate, no window
  const since = state?.dirty_since_ms;
  const sinceTurn = state?.dirty_since_turn;
  if (typeof since !== 'number' || typeof sinceTurn !== 'number') {
    return { nag: false, state: { dirty_since_ms: now, dirty_since_turn: turns } }; // start the window
  }
  const aged = now - since > debounceMin * 60_000 && turns - sinceTurn >= debounceTurns;
  return { nag: aged, state: { dirty_since_ms: since, dirty_since_turn: sinceTurn } };
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

/**
 * Parse a thread's dependency array from RAW file source. Reads `blocking_threads:` (the
 * 2026-07-01 rename) OR `depends_on:` (still accepted as a read-alias FIELD), and handles BOTH
 * the inline-array form (`[a, b]`) and the YAML block form (`- a` on following indented lines) —
 * the flat `key: value` frontmatter reader drops block-form list items, so dep-reading MUST go
 * through this src-level parser, not the flat map. This is the SINGLE source of dep-parse truth
 * shared by the board (`index.mjs`) and the reminder hook (`fray-reminder.mjs`) so the two can
 * never disagree on whether a thread is machine- vs human-blocked (the statusline keeps its own
 * inlined copy — it is deployed standalone and cannot import from the plugin). Entries may be
 * bare thread slugs OR typed external gates; classification is {@link classifyDep}'s job.
 * @param {string} src
 * @returns {string[]}
 */
export function parseDeps(src) {
  for (const field of ['blocking_threads', 'depends_on']) {
    const inline = String(src).match(new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]`, 'm'));
    if (inline) {
      return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    const block = String(src).match(new RegExp(`^${field}:\\s*\\n((?:[ \\t]+-[ \\t]*.+\\n?)+)`, 'm'));
    if (block) {
      return block[1].split('\n').map((l) => l.replace(/^[ \t]+-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  return [];
}
