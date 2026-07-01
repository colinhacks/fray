#!/usr/bin/env node
// @ts-check
/**
 * fray — the board + validator. There is NO stored board file: the board/status
 * view is COMPUTED ON DEMAND from the independent per-thread `.fray/<slug>.md`
 * files (the filename slug IS the thread id — the filesystem guarantees uniqueness,
 * so there is no `id` frontmatter field and nothing to dedupe) plus `.fray/config.yml`
 * (globals). Each thread's frontmatter is validated against the schema; the
 * `fray-reminder` hook runs `--validate` every turn so malformed frontmatter surfaces
 * to the orchestrator immediately.
 *
 * Usage (the `fray` command is the bin/ shim that runs this script against the
 * project's `.fray/`, regardless of cwd or where the plugin is installed):
 *   fray               # print the LIVE board (⚖ awaiting-you + active/planning/blocked; planned hidden)
 *   fray --all         # print all threads (every status)
 *   fray --status planned # print only threads in one status (aliases todo/plan/enqueued/needs-decision accepted)
 *   fray reconcile     # stamp .fray/.last-reconcile = now (records a completed board reconcile)
 *   fray --validate    # print ONLY validation errors; exit 1 if any (for the hook / CI). --check is an alias.
 *   fray --json        # machine-readable {config, threads, errors} — ALWAYS complete, never filtered
 *
 * A `blocked` thread's RESOLUTION MECHANISM (which frontmatter field is set) drives its color +
 * placement — see `blockMechanism` in config.mjs. HUMAN-blocked (no machine field) → the hoisted
 * `⚖ awaiting you` queue. MACHINE-blocked → the de-emphasized `blocked` group. The two machine
 * fields:
 *   - `blocking_threads: [entry, …]` (the RENAME of `depends_on`, still accepted as a read-alias
 *     FIELD). Each entry (see `classifyDep`): a BARE THREAD SLUG auto-fires `▶ READY` when it goes
 *     terminal (a dangling slug is a validation error); a TYPED EXTERNAL gate `pr:owner/repo#N` /
 *     `issue:…` / `ci:…` / `external:<desc>` PARKS the thread (`⏳ waiting on: <ext>`, never dangles).
 *   - `revalidate_at: <ISO>` — an external TIMER; parked quiet until due, then surfaces for recheck.
 * Computed on demand from the scanned statuses — there is no stored dependency graph.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig,
  STATUS,
  TERMINAL,
  ACCEPTED_STATUSES,
  normalizeStatus,
  isValidStatus,
  setSessionOverride,
  clearSessionOverride,
  sessionOverride,
  currentSessionId,
  frayActive,
  writeLastReconcile,
  revalidateState,
  formatEta,
  classifyDep,
  parseDeps,
  blockMechanism,
  isHumanBlocked,
  touchSessionHeartbeat,
  clearSessionHeartbeat,
  readSessionHeartbeat,
  ownerStaleMin,
  sessionLive,
} from './config.mjs';
import { readOwner, setOwner, effectiveOwnership } from './ownership.mjs';
import { newestBindingByThread, downstreamThreads, restedAgentIds } from './agent-bindings.mjs';
import { deriveAgentState, findAgentOutputAge, IDLE_MIN, DROPPED_MIN } from './agent-status.mjs';
import { collectDecisions } from './decisions.mjs';

// The project root comes from the environment, NOT from this script's own path: the
// board ships inside the fray PLUGIN (and, after a marketplace install, lives in
// ~/.claude/plugins/cache/…), so a script-relative `../../` root would point at the
// PLUGIN, never the project. CLAUDE_PROJECT_DIR is exported to hook processes and set
// by the bin/fray shim; when run by hand from the repo root, process.cwd() is correct.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAY_DIR = join(PROJECT_DIR, '.fray');

// STATUS/TERMINAL are imported from ./config.mjs — the single shared source the hooks
// also use, so the vocab can never drift between the tool and the reminder hook.
const REQUIRED = ['title', 'status']; // created / last_update are optional.

/**
 * Parse a top-of-file `--- … ---` YAML frontmatter block (flat `key: value` only).
 * @param {string} src
 * @returns {Record<string, string> | null}
 */
function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null; // no frontmatter at all
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * First non-blank line under `## Next step`, collapsed to one cell.
 * @param {string} src
 * @returns {string}
 */
function nextStep(src) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /^##\s+Next step\s*$/i.test(l));
  if (i === -1) return '';
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{1,6}\s/.test(lines[j])) break;
    if (lines[j].trim()) return lines[j].trim();
  }
  return '';
}


// PER-SESSION TOGGLE — `fray on` / `fray off` / `fray status` flip (or report) fray
// enablement for THIS Claude Code session, keyed on CLAUDE_CODE_SESSION_ID (the same id
// the hooks gate on — verified equal). Activation is OPT-IN: a session is dormant by
// default, so `fray on` is what an agent (the `/fray` skill's step 0) OR a human runs to
// ACTIVATE the current session; `fray off` silences it; both write the sentinel, no
// relaunch. These are handled BEFORE the board renders, since they are not board queries.
{
  const sub = process.argv[2];
  if (sub === 'on' || sub === 'off' || sub === 'enable' || sub === 'disable') {
    const sid = currentSessionId();
    if (!sid) {
      console.error('fray: no session id (CLAUDE_CODE_SESSION_ID unset) — cannot toggle this session.');
      process.exit(1);
    }
    const state = sub === 'on' || sub === 'enable' ? 'on' : 'off';
    const path = setSessionOverride(PROJECT_DIR, sid, state);
    // Heartbeat: `on` stamps it (this session is live + can own threads NOW); `off` clears it
    // (the session stops participating → its owned threads become orphaned/claimable at once).
    if (state === 'on') touchSessionHeartbeat(PROJECT_DIR, sid);
    else clearSessionHeartbeat(PROJECT_DIR, sid);
    console.log(`fray: ${state === 'on' ? 'ENABLED' : 'DISABLED'} for this session (${sid}).`);
    console.log(`  sentinel: ${path}`);
    console.log(`  revert to default (dormant) with: fray reset`);
    process.exit(0);
  }
  // `fray claim <slug> [--force]` / `fray disown <slug> [--force]` / `fray owners [--gc]` —
  // per-thread session OWNERSHIP. Claiming is EASY when a thread is unowned or its owner is
  // DEAD (heartbeat stale/absent); claiming a thread owned by a DIFFERENT, still-LIVE session
  // is DISCOURAGED and requires `--force`. Ownership is stored as `owner_session:` frontmatter,
  // written only by these explicit gestures — never by an automatic hook (see ownership.mjs).
  if (sub === 'claim' || sub === 'disown' || sub === 'owners') {
    const rest = process.argv.slice(3);
    const force = rest.includes('--force');
    const gc = rest.includes('--gc');
    const slug = rest.find((a) => !a.startsWith('-'));
    const sid = currentSessionId();
    const cfgO = loadConfig(PROJECT_DIR);
    const staleMin = ownerStaleMin(cfgO);
    const id8 = (s) => (s ? s.slice(0, 9) : '(none)');
    const seenAgo = (owner) => {
      const hb = readSessionHeartbeat(PROJECT_DIR, owner);
      return hb == null ? 'never' : `${Math.round((Date.now() - hb) / 60_000)}m ago`;
    };

    if (sub === 'owners') {
      // Full per-thread ownership view. `--gc` additionally CLEARS every orphaned owner (the
      // explicit reconciliation-path clear — safe because it is orchestrator-driven, not a hook).
      let entries;
      try {
        entries = readdirSync(FRAY_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();
      } catch {
        console.log(`No .fray/ in ${PROJECT_DIR}.`);
        process.exit(0);
      }
      let cleared = 0;
      console.log(`fray owners — this session: ${id8(sid)} · owner-stale window: ${staleMin}m\n`);
      for (const f of entries) {
        const s = f.replace(/\.md$/, '');
        const owner = readOwner(PROJECT_DIR, s);
        const live = owner ? sessionLive(PROJECT_DIR, owner, staleMin) : false;
        const st = effectiveOwnership(owner, sid, live);
        let note = 'unowned';
        if (st === 'mine') note = `yours (${id8(owner)})`;
        else if (st === 'other-live') note = `session ${id8(owner)} — LIVE, last seen ${seenAgo(owner)}`;
        else if (st === 'orphaned') note = `session ${id8(owner)} — DEAD (last seen ${seenAgo(owner)})${gc ? ' → cleared' : ' → claimable'}`;
        if (st === 'orphaned' && gc) {
          try { setOwner(PROJECT_DIR, s, null); cleared++; } catch { /* best-effort */ }
        }
        console.log(`  ${s} — ${note}`);
      }
      if (gc) console.log(`\ncleared ${cleared} orphaned owner${cleared === 1 ? '' : 's'}.`);
      process.exit(0);
    }

    // claim / disown both need a slug + a session id + the thread to exist.
    if (!sid) { console.error(`fray ${sub}: no session id (CLAUDE_CODE_SESSION_ID unset).`); process.exit(1); }
    if (!slug) { console.error(`usage: fray ${sub} <slug> [--force]`); process.exit(1); }
    if (!existsSync(join(FRAY_DIR, `${slug}.md`))) { console.error(`fray ${sub}: no thread .fray/${slug}.md`); process.exit(1); }
    const owner = readOwner(PROJECT_DIR, slug);
    const live = owner ? sessionLive(PROJECT_DIR, owner, staleMin) : false;
    const st = effectiveOwnership(owner, sid, live);

    if (sub === 'claim') {
      if (st === 'mine') {
        touchSessionHeartbeat(PROJECT_DIR, sid);
        console.log(`fray: ${slug} is already yours (${id8(sid)}).`);
        process.exit(0);
      }
      if (st === 'other-live' && !force) {
        console.error(`fray: ${slug} is owned by a DIFFERENT, LIVE session ${id8(owner)} (last seen ${seenAgo(owner)}).`);
        console.error(`  Another session is on this thread — coordinate first. To take it anyway: fray claim ${slug} --force`);
        process.exit(1);
      }
      try { setOwner(PROJECT_DIR, slug, sid); } catch (e) { console.error(`fray claim: ${e instanceof Error ? e.message : e}`); process.exit(1); }
      touchSessionHeartbeat(PROJECT_DIR, sid);
      const from = st === 'unowned' ? 'was unowned'
        : st === 'orphaned' ? `previous owner ${id8(owner)} was DEAD (last seen ${seenAgo(owner)})`
          : `FORCE-taken from LIVE session ${id8(owner)}`;
      console.log(`fray: CLAIMED ${slug} for this session (${id8(sid)}) — ${from}.`);
      process.exit(0);
    }

    // disown
    if (st === 'unowned') { console.log(`fray: ${slug} is not owned — nothing to disown.`); process.exit(0); }
    if (st === 'other-live' && !force) {
      console.error(`fray: ${slug} is owned by a DIFFERENT, LIVE session ${id8(owner)}. To release it anyway: fray disown ${slug} --force`);
      process.exit(1);
    }
    try { setOwner(PROJECT_DIR, slug, null); } catch (e) { console.error(`fray disown: ${e instanceof Error ? e.message : e}`); process.exit(1); }
    console.log(`fray: released ownership of ${slug}${st === 'orphaned' ? ` (cleared dead owner ${id8(owner)})` : ''}.`);
    process.exit(0);
  }
  // `fray reconcile` — RECORD a completed board reconcile by stamping `.fray/.last-reconcile`
  // to now. The reconcile nudge (Stop-hook rest path + per-turn backstop) fires when a thread
  // moved since this stamp (dirty-gate) or a long backstop elapses; a reconcile sub-agent (or a
  // human) runs this AS ITS LAST STEP, AFTER re-grounding + editing every non-terminal thread —
  // stamping last is REQUIRED, or its own edits leave the board dirty. Pure timestamp write.
  if (sub === 'reconcile') {
    const f = writeLastReconcile(PROJECT_DIR);
    console.log('fray: board reconcile recorded — staleness clock reset.');
    console.log(`  stamped: ${f}`);
    process.exit(0);
  }
  if (sub === 'reset' || sub === 'default') {
    const sid = currentSessionId();
    if (sid) clearSessionOverride(PROJECT_DIR, sid);
    console.log(`fray: session override cleared for ${sid ?? '(no session id)'} — back to the default (DORMANT; run \`fray on\` to activate this session).`);
    process.exit(0);
  }
  if (sub === 'status') {
    const sid = currentSessionId();
    const ov = sessionOverride(PROJECT_DIR, sid);
    const active = frayActive(PROJECT_DIR, sid);
    console.log(`fray: ${active ? 'ACTIVE' : 'INACTIVE'} this session (${sid ?? 'no session id'})`);
    console.log(`  override: ${ov ?? 'none (default — DORMANT; run `fray on` to activate)'}`);
    process.exit(0);
  }
  // `fray decisions` — the rich inline-reading view of every HUMAN-blocked thread's FULL
  // write-up (collectDecisions — `blocked` with no `blocking_threads`/`revalidate_at`). The same
  // queue the thread updater prints after each edit; surfaced here as a board subcommand.
  if (sub === 'decisions') {
    const items = collectDecisions();
    if (items.length === 0) {
      console.log('✓ no pending decisions');
    } else {
      console.log(`⚖ ${items.length} decision(s) awaiting you:\n`);
      items.forEach((d, i) => {
        console.log(`[${d.slug}]`);
        console.log(d.status_text || '(no status_text written up)');
        if (i < items.length - 1) console.log('');
      });
    }
    process.exit(0);
  }
}

// .fray/config.yml globals — parsed by the shared, type-safe loadConfig (autonomous_mode + state).
const cfg = loadConfig(PROJECT_DIR);
// Session-ownership context for the board: THIS session's id (from CLAUDE_CODE_SESSION_ID,
// present in Bash tool calls) + the owner-staleness window. Used to annotate each thread with
// its effective ownership (mine / another live session's / orphaned) — DERIVED, never stored.
const CURRENT_SID = currentSessionId();
const OWNER_STALE_MIN = ownerStaleMin(cfg);

// No `.fray/` here → fray is not active in this project. Print a friendly pointer instead
// of crashing on a missing directory (the board ships globally and may be run anywhere).
let frayEntries;
try {
  frayEntries = readdirSync(FRAY_DIR);
} catch {
  console.log(`No .fray/ in ${PROJECT_DIR} — fray is not active here. Run the /fray skill to bootstrap it (creates .fray/ + a default config.yml).`);
  process.exit(0);
}

// AUTOMATIC thread↔agent binding (`.fray/.agent-bindings.jsonl`, written by the agent-bind
// hook at dispatch) — the replacement for the old hand-maintained `agents:` frontmatter.
// Liveness keys on each thread's NEWEST agent only (a superseded older one is never flagged),
// suppresses threads with a PR landing via the merge cascade, and uses the rest log to tell a
// parked agent apart from one still inside a long tool call.
const newestBindings = newestBindingByThread(PROJECT_DIR);
const downstream = downstreamThreads(PROJECT_DIR);
const restedIds = restedAgentIds(PROJECT_DIR);

const threads = frayEntries
  .filter((f) => f.endsWith('.md') && !f.startsWith('_')) // `_`-prefixed = non-thread meta (e.g. a stray _board.md)
  .sort()
  .map((f) => {
    const id = f.replace(/\.md$/, ''); // the filename slug IS the id
    const src = readFileSync(join(FRAY_DIR, f), 'utf8');
    const fm = frontmatter(src);
    /** @type {string[]} */
    const errors = [];
    if (!fm) {
      errors.push('no YAML frontmatter');
    } else {
      for (const k of REQUIRED) if (!fm[k]) errors.push(`missing required field: ${k}`);
      if (fm.status && !isValidStatus(fm.status))
        errors.push(`invalid status "${fm.status}" (expected one of: ${ACCEPTED_STATUSES.join(', ')})`);
    }
    // Bucket on the CANONICAL status: a legacy `todo`/`plan`/`needs-decision` thread groups
    // (and is surfaced) as its canonical target. Unknown/garbage passes through unchanged so
    // it still lands in the `(invalid status)` group below.
    const status = normalizeStatus(fm?.status) ?? '?';
    // The dependency field is `blocking_threads` (the RENAME of `depends_on`, 2026-07-01);
    // `depends_on` stays accepted as a read-alias FIELD so old threads still resolve. Both mean
    // the same array — bare THREAD-slug deps (drive READY/auto-fire + dangling validation) plus
    // typed EXTERNAL gates `pr:`/`ci:`/`external:` (park the thread as "waiting on"; never dangle).
    // Read deps from RAW src (not the flat frontmatter map) so a block-form YAML list is not
    // dropped — the shared parser is what keeps the board's machine/human classification in
    // lock-step with the reminder hook (both call the SAME parseDeps).
    const dependsOn = parseDeps(src);
    const classified = dependsOn.map(classifyDep);
    const threadDeps = classified.filter((d) => d.kind === 'thread').map((d) => d.slug);
    /** @type {{type:string,label:string}[]} */
    const externalDeps = classified.filter((d) => d.kind === 'external').map((d) => ({ type: d.type, label: d.label }));
    // REVALIDATE timer — the parsed `revalidate_at`/`last_checked` state (null when unset/
    // malformed). `revalidateMalformed` is set when the field is PRESENT but didn't parse, so
    // a typo'd timestamp surfaces as a non-fatal warning below rather than silently never firing.
    const revalidate = revalidateState(fm?.revalidate_at, fm?.last_checked);
    const revalidateMalformed = Boolean(fm?.revalidate_at) && !revalidate;
    // The RESOLUTION MECHANISM of a `blocked` thread (meaningless for other statuses): human
    // (⚖/yellow) vs threads/timer (gray). Both fields present → the validator warns; derivation
    // picks timer > threads > human. `humanBlocked` is the ⚖ awaiting-you predicate.
    const mechanism = blockMechanism({ hasBlockingThreads: dependsOn.length > 0, hasTimer: Boolean(revalidate) });
    const humanBlocked = status === 'blocked' && isHumanBlocked({ hasBlockingThreads: dependsOn.length > 0, hasTimer: Boolean(revalidate) });
    const next = nextStep(src);
    const threadTerminal = TERMINAL.includes(status);
    const threadActive = status === 'active'; // only `active` threads flag dropped/idle agents; parked phases are expected to hold done agents
    const threadDownstream = downstream.has(id); // PR landing via the cascade → legitimately active, suppress
    // Agent liveness is DERIVED, never read from a stored per-agent flag: the AUTOMATIC
    // binding carries only immutable `{id, label}`; state comes from the NEWEST agent's
    // output-file age (ground truth) + the thread's own status + the rest log, via the SAME
    // derivation the Stop hook uses. Newest-only: a superseded older agent is never flagged.
    const binding = newestBindings.get(id);
    const agents = binding
      ? [{
          ...binding,
          state: deriveAgentState({ ageMin: findAgentOutputAge(binding.id), threadTerminal, threadActive, threadDownstream, hasRested: restedIds.has(binding.id), idleMin: IDLE_MIN, droppedMin: DROPPED_MIN }),
        }]
      : [];
    return {
      id,
      title: fm?.title ?? '',
      status, // CANONICAL (legacy aliases normalized); unknown passes through as-is
      status_text: fm?.status_text ?? '',
      next,
      dependsOn,
      threadDeps,
      externalDeps,
      mechanism,
      humanBlocked,
      hasBlockingThreads: dependsOn.length > 0,
      owner: fm?.owner_session || null,
      revalidate,
      revalidateMalformed,
      agents,
      text: src,
      errors,
      /** @type {string[]} */ warnings: [],
      dropRisk: false, // set true when the blocked-machine-but-all-deps-terminal heuristic fires
    };
  });

// THREAD-slug deps reference other threads — validate they resolve. A dangling slug (no
// matching `.fray/<slug>.md`) is an error, surfaced like any frontmatter error so the
// orchestrator notices the stale dependency. EXTERNAL deps (`pr:`/`ci:`/`external:`…) are
// NOT checked — there is nothing in `.fray/` to resolve them to. Everything is COMPUTED from
// the scanned set; there is no external registry to consult.
const slugs = new Set(threads.map((t) => t.id));
const statusOf = new Map(threads.map((t) => [t.id, t.status]));
for (const t of threads) {
  for (const dep of t.threadDeps) {
    if (!slugs.has(dep)) t.errors.push(`blocking_threads references unknown thread "${dep}"`);
  }
}

/**
 * A thread's blockers: the subset of its THREAD-slug `depends_on` targets not yet terminal.
 * Empty ⇒ all thread deps clear. Unknown slugs are skipped here (already an error). External
 * deps are NOT blockers in this sense — they park the thread separately (see renderThread).
 * @param {{ threadDeps: string[] }} t
 * @returns {string[]}
 */
function blockers(t) {
  return t.threadDeps.filter((dep) => slugs.has(dep) && !TERMINAL.includes(statusOf.get(dep) ?? '?'));
}

/**
 * Render one thread's board block (slug line + status_text gloss + next-step + dep state +
 * agent-liveness + warnings) into `out`. Shared by the per-status groups AND the dedicated
 * `⚖ awaiting you` (blocked) section so the two can never drift. status_text is emitted IN
 * FULL — the board NEVER truncates it (the length cap is a soft scan-loop warning, itself
 * exempted for `blocked`, so a blocker's open question is always fully readable on a wide term).
 * @param {(typeof threads)[number]} t
 * @param {string[]} out
 */
function renderThread(t, out) {
  out.push(`- ${t.id} — ${t.title}`);
  if (t.status_text) out.push(`    » ${t.status_text}`);
  out.push(`    → ${t.next}`);
  if (t.threadDeps.length) {
    const b = blockers(t);
    // READY only when thread deps AND external deps are all clear — a pending external gate
    // still parks the thread even after its in-board thread deps go terminal. When a
    // `revalidate_at` timer is ALSO set (the mis-configured >1-mechanism case the validator
    // warns about), the timer is the GOVERNING mechanism (precedence timer > threads), so the
    // timer block below owns the surfacing — never claim `▶ READY` here or the board would print
    // a "dispatch now" line contradicting the parked timer.
    const readyBlocked = b.length
      ? `    ⏳ blocked on: ${b.join(', ')}`
      : t.externalDeps.length
        ? `    ⏳ thread deps clear — still waiting on external`
        : t.mechanism === 'timer'
          ? null // a timer governs — the ⏰ line below is the single surfacing
          : `    ▶ READY — dependencies clear, dispatch now`;
    if (readyBlocked) out.push(readyBlocked);
  }
  // EXTERNAL deps park the thread; surface them as a "waiting on" line (they resolve via a
  // `revalidate_at` re-poll or a manual edit, never auto-fired from the board).
  if (t.externalDeps.length) {
    out.push(`    ⏳ waiting on: ${t.externalDeps.map((d) => d.label).join(', ')}`);
  }
  // SESSION OWNERSHIP — annotate ONLY the actionable coordination cases (owned by another live
  // session → don't touch; orphaned → claimable). `mine`/`unowned` stay unmarked to keep the
  // board lean (`fray owners` gives the full per-thread view). Derived from the owner's
  // heartbeat freshness, never a stored flag.
  if (t.owner) {
    const ownerLive = sessionLive(PROJECT_DIR, t.owner, OWNER_STALE_MIN);
    const st = effectiveOwnership(t.owner, CURRENT_SID, ownerLive);
    const id8 = t.owner.slice(0, 9);
    if (st === 'other-live') {
      const hb = readSessionHeartbeat(PROJECT_DIR, t.owner);
      const ago = hb == null ? 'unknown' : `${Math.round((Date.now() - hb) / 60_000)}m ago`;
      out.push(`    👤 owned by another LIVE session ${id8} (last seen ${ago}) — don't touch; \`fray claim ${t.id} --force\` to take it`);
    } else if (st === 'orphaned') {
      out.push(`    👤 orphaned — owner session ${id8} is dead; \`fray claim ${t.id}\` to take it`);
    }
  }
  // REVALIDATE timer status — `⏰ revalidate due` once the timer fired (re-poll the external
  // state), or a quiet `next check in <eta>` while parked, so the board reflects the timer.
  if (t.revalidate) {
    out.push(t.revalidate.due
      ? `    ⏰ revalidate due — re-poll the external state (last checked ${t.revalidate.lastChecked || 'never'})`
      : `    ⏰ next check in ${formatEta(t.revalidate.etaMin)} (last checked ${t.revalidate.lastChecked || 'never'})`);
  }
  // Dispatched-agent liveness — DERIVED (newest-agent output age + thread status + rest log),
  // never stored. Newest agent only; downstream (mid-merge) threads already suppressed.
  for (const a of t.agents) {
    if (a.state === 'fresh' || a.state === 'terminal' || a.state === 'unknown') continue;
    const who = `${a.label ? `${a.label} ` : ''}[${a.id.slice(0, 9)}]`;
    out.push(a.state === 'dropped'
      ? `    ⚠ ACTIVE THREAD, NO LIVE AGENT — newest agent ${who} quiet, no PR/merge in flight; fold + flip to done, or resume it`
      : `    · idle agent ${who} — no recent output; fine if watching CI/mid-build, else poke`);
  }
  for (const w of t.warnings) out.push(`    ⚠ ${w}`);
}

// ── Stall-suspect WARNINGS (drop-risk heuristics) ───────────────────────────────
// These are CONSERVATIVE warnings, NOT hard errors — they never fail `--validate`'s
// exit code (that stays gated on real frontmatter errors so the per-turn hook + CI
// don't break on a heuristic). They exist because a ready thread was once parked with
// a transient blocker encoded as PROSE (not `depends_on`) and silently DROPPED turn
// after turn. The canonical drop shape post-`planned`-removal: an `enqueued` thread
// whose `depends_on` are ALL terminal — it SHOULD have auto-fired and didn't. The
// `dropRisk` flag below is the SAME signal the per-turn fray-reminder hook surfaces by
// name. Self-contained: every signal is read off the thread's own frontmatter; no
// external state. Keep these PRECISE — never false-flag a legitimately-waiting `todo`.
for (const t of threads) {
  if (TERMINAL.includes(t.status)) continue; // terminal threads are done — never a drop-risk

  // (1) DROP-RISK: a `blocked` thread with the THREADS mechanism (`blocking_threads` set) whose
  //     thread deps are ALL terminal — its auto-trigger fired and it was never dispatched. A
  //     pending EXTERNAL gate or a live timer legitimately parks it, so the heuristic requires
  //     thread deps present, all clear, no external gate outstanding, AND no `revalidate_at`.
  if (t.status === 'blocked' && t.threadDeps.length > 0 && blockers(t).length === 0 && t.externalDeps.length === 0 && !t.revalidate) {
    t.dropRisk = true;
    t.warnings.push('drop risk: `blocked` on `blocking_threads` that are ALL terminal — it should have auto-fired; re-read the thread and dispatch/advance it now');
  }

  // (1b) ONE MECHANISM PER BLOCKED THREAD — warn on ambiguity. A `blocked` thread should carry
  //      exactly one resolution mechanism; both `blocking_threads` AND `revalidate_at` set is
  //      ambiguous (which unblocks it?). And a HUMAN-blocked thread (neither field) MUST have a
  //      status_text — it IS the ⚖ awaiting-you queue entry, so an empty one is an empty row.
  if (t.status === 'blocked') {
    if (t.hasBlockingThreads && t.revalidate) {
      t.warnings.push('blocked with BOTH `blocking_threads` and `revalidate_at` — set exactly ONE resolution mechanism (the board treats it as the timer)');
    }
    if (t.humanBlocked && !t.status_text) {
      t.warnings.push('HUMAN-blocked (no `blocking_threads`/`revalidate_at`) but no status_text — write the decision needed; it IS the ⚖ awaiting-you queue entry');
    }
  }

  // status_text is a 1-2 sentence English status note (frontmatter); flag overlong ones —
  // anything past ~2 sentences belongs in the body, not the at-a-glance board field.
  // EXEMPT a HUMAN-blocked thread: its status_text IS the ⚖ awaiting-you queue entry (the
  // concise decision needed), surfaced UNTRUNCATED on the board + reminder — never warn/clip it.
  if (!t.humanBlocked && t.status_text && t.status_text.length > 280) {
    t.warnings.push(`status_text is ${t.status_text.length} chars — keep it to 1-2 sentences; move detail into the body`);
  }

  // Present-but-unparseable `revalidate_at`: the hook degrades it to not-set (fail-safe), but
  // a typo'd timestamp means the timer will NEVER fire — surface it as a non-fatal warning so
  // the bad value is caught instead of silently stranding the thread.
  if (t.revalidateMalformed) {
    t.warnings.push('revalidate_at present but not a parseable ISO-8601 timestamp — the timer will NOT fire; fix it (e.g. 2026-06-27T18:00:00Z) or remove the field');
  }

  // Soft warning: non-terminal threads without a status_text have no at-a-glance board note.
  if (!t.status_text && t.id !== 'backlog') {
    t.warnings.push('no status_text — add a 1-2 sentence gloss of the current state (shown on the board as the » line)');
  }

  // (2) An EMPTY `## Next step` on a non-terminal thread — the board's "→" cell goes
  //     blank, so the thread has no stated next action and is easy to lose track of.
  //     `backlog` is the documented parking-lot (a curated list, not a single-effort
  //     thread), so it legitimately has no `## Next step` — exempt it.
  if (!t.next && t.id !== 'backlog') {
    t.warnings.push('empty `## Next step` — no stated next action (the board "→" cell is blank)');
  }
}

const allErrors = threads.filter((t) => t.errors.length).map((t) => `  ${t.id}.md: ${t.errors.join('; ')}`);
const allWarnings = threads.filter((t) => t.warnings.length).map((t) => `  ${t.id}.md: ${t.warnings.join('; ')}`);

if (process.argv.includes('--validate') || process.argv.includes('--check')) {
  // Warnings print but DO NOT affect the exit code — they're conservative drop-risk
  // heuristics, not schema errors. Only real frontmatter errors fail the hook/CI.
  if (allWarnings.length) console.error(`fray drop-risk WARNINGS (advisory, non-fatal):\n${allWarnings.join('\n')}`);
  if (allErrors.length) {
    console.error(`fray frontmatter validation FAILED:\n${allErrors.join('\n')}`);
    process.exit(1);
  }
  console.log(`fray frontmatter OK${allWarnings.length ? ` (${allWarnings.length} drop-risk warning${allWarnings.length === 1 ? '' : 's'} above)` : ''}`);
  process.exit(0);
}

if (process.argv.includes('--json')) {
  const dump = threads.map(({ text, ...t }) => {
    const b = blockers(t);
    // READY = thread deps present + all clear + no external gate outstanding.
    return { ...t, blockers: b, ready: t.threadDeps.length > 0 && b.length === 0 && t.externalDeps.length === 0 };
  });
  console.log(JSON.stringify({ config: cfg, threads: dump, errors: allErrors, warnings: allWarnings }, null, 2));
  process.exit(0);
}

// Substring search across id + title + body — find a thread when you can't recall its slug.
const qi = process.argv.indexOf('--search');
if (qi !== -1) {
  const q = (process.argv[qi + 1] ?? '').toLowerCase();
  const hits = threads.filter((t) => `${t.id} ${t.title} ${t.text}`.toLowerCase().includes(q));
  console.log(
    hits.length
      ? hits.map((t) => `${t.id} [${t.status}] — ${t.title}`).join('\n')
      : `no threads match "${q}"`,
  );
  process.exit(0);
}

// Default: the board. `--status <s>` narrows to one status. `--all` shows everything.
// A legacy alias (`todo`/`plan`/`needs-decision`) is accepted and normalized to its
// canonical target, so `fray --status todo` shows `planned` threads.
const si = process.argv.indexOf('--status');
const onlyRaw = si !== -1 ? process.argv[si + 1] : null;
if (onlyRaw && !isValidStatus(onlyRaw)) {
  console.error(`unknown status "${onlyRaw}" (expected one of: ${ACCEPTED_STATUSES.join(', ')})`);
  process.exit(2);
}
const only = onlyRaw ? normalizeStatus(onlyRaw) : null; // canonical filter value
const showAll = process.argv.includes('--all');

// Statuses hidden from the default board (non-actionable): the PARKED `planned` phase + the
// terminals. `planning` (active design) is SURFACED, so it is NOT hidden. Read defensively
// from config.mjs STATUS so an absent status is simply skipped.
const HIDDEN_BY_DEFAULT = new Set(['planned', 'done', 'dismissed'].filter((s) => STATUS.includes(s)));

// When `--all` or `--status <s>` is given, show the requested set; otherwise show
// only the live/actionable statuses.
const showStatuses = only
  ? [only]
  : showAll
    ? STATUS
    : STATUS.filter((s) => !HIDDEN_BY_DEFAULT.has(s));

const out = [];
out.push(`fray board — autonomous_mode: ${cfg.autonomousMode ? 'on' : 'off'}${only ? ` — status:${only}` : showAll ? ' — all' : ' — live'}`);
if (allErrors.length) out.push(`\n⚠ VALIDATION ERRORS:\n${allErrors.join('\n')}`);
if (allWarnings.length) out.push(`\n⚠ DROP-RISK WARNINGS (advisory):\n${allWarnings.join('\n')}`);

// ⚖ AWAITING YOU — the COMPUTED queue of every HUMAN-blocked thread (`blocked` with NO
// `blocking_threads` and NO `revalidate_at` → only the maintainer can unblock it), surfaced by
// its FULL status_text (the concise decision needed). HOISTED to the top of the board (not
// buried mid-status-list) and rendered UNTRUNCATED. The machine/timer-blocked threads are NOT
// here — they wait on non-human work and render (gray, last) in the `blocked` group below.
// Nothing is stored: filtered live from the scanned threads. Shown in the live/default + `--all`
// views and when `--status blocked` (or its `needs-decision`/`enqueued` aliases) is requested.
if (!only || only === 'blocked') {
  const pendingDecisions = threads.filter((t) => t.humanBlocked);
  if (pendingDecisions.length) {
    out.push(`\n## ⚖ awaiting you (${pendingDecisions.length}) — human-blocked`);
    for (const t of pendingDecisions) renderThread(t, out);
  }
}

// Per-status groups, in SURFACE-PRIORITY order (⚖ human-blocked hoisted above; then active,
// planning, and machine/timer-`blocked` LAST/de-emphasized) — not raw STATUS order — so the
// board reads awaiting-you → active → planning → blocked top-to-bottom.
const GROUP_ORDER = ['active', 'planning', 'blocked', 'planned'];
const orderedStatuses = [...showStatuses].sort((a, b) => {
  const ia = GROUP_ORDER.indexOf(a); const ib = GROUP_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});
for (const s of orderedStatuses) {
  // `blocked` renders ONLY its MACHINE/timer threads here — the HUMAN-blocked ones are in the
  // ⚖ section above (skip them to avoid duplication).
  const group = threads.filter((t) => t.status === s && !t.humanBlocked);
  if (!group.length) continue;
  out.push(`\n## ${s} (${group.length})`);
  for (const t of group) renderThread(t, out);
}
const unknown = threads.filter((t) => !STATUS.includes(t.status));
if (unknown.length) out.push(`\n## (invalid status) (${unknown.length})\n${unknown.map((t) => `- ${t.id} [${t.status}]`).join('\n')}`);

// Footer: when threads are hidden in the default view, tell the user how many.
if (!only && !showAll) {
  const hiddenCount = threads.filter((t) => HIDDEN_BY_DEFAULT.has(t.status)).length;
  if (hiddenCount > 0) {
    const hiddenLabels = [...HIDDEN_BY_DEFAULT].filter((s) => threads.some((t) => t.status === s)).join('/');
    out.push(`\n… ${hiddenCount} hidden (${hiddenLabels}) — \`--all\` to show`);
  }
}

console.log(out.join('\n'));
