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
 *   fray               # print the LIVE board (planning/active/enqueued/blocked only; planned is hidden)
 *   fray --all         # print all threads (every status)
 *   fray --status planned # print only threads in one status (legacy aliases todo/plan/needs-decision accepted)
 *   fray reconcile     # stamp .fray/.last-reconcile = now (records a completed board reconcile)
 *   fray --validate    # print ONLY validation errors; exit 1 if any (for the hook / CI). --check is an alias.
 *   fray --json        # machine-readable {config, threads, errors} — ALWAYS complete, never filtered
 *
 * Thread DEPENDENCIES are expressed entirely in per-thread frontmatter — an optional
 * `depends_on: [slug, ...]` array naming OTHER THREAD SLUGS (the same files the board
 * already scans; NOT an external registry). When every target is terminal (done/
 * dismissed) the board prints `▶ READY — dependencies clear, dispatch now`; otherwise
 * it lists the outstanding blockers. Computed on demand from the scanned statuses —
 * there is no stored dependency graph.
 */

import { readFileSync, readdirSync } from 'node:fs';
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
} from './config.mjs';
import { newestBindingByThread, downstreamThreads, restedAgentIds } from './agent-bindings.mjs';
import { deriveAgentState, findAgentOutputAge, IDLE_MIN, DROPPED_MIN } from './agent-status.mjs';
import { collectDecisions, isExternalBlock } from './decisions.mjs';

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
 * Parse a YAML inline-array value (`[a, b, c]` or empty `[]`) into a string list.
 * Bare scalars (`a` / `"a"`) are tolerated and wrapped as a single-element list.
 * Self-contained by design: each entry is a THREAD SLUG that the board already
 * scans — `depends_on` references other thread files, never an external registry.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseList(raw) {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[|\]$/g, '');
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

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
    console.log(`fray: ${state === 'on' ? 'ENABLED' : 'DISABLED'} for this session (${sid}).`);
    console.log(`  sentinel: ${path}`);
    console.log(`  revert to default (dormant) with: fray reset`);
    process.exit(0);
  }
  // `fray reconcile` — RECORD a completed board reconcile by stamping `.fray/.last-reconcile`
  // to now. The per-turn fray-reminder hook nags when this timestamp goes stale; a reconcile
  // sub-agent (or a human) runs this AFTER re-grounding every non-terminal thread against the
  // actual code/PRs, to reset the staleness clock. Pure timestamp write — no board scan needed.
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
  // `fray decisions` — the rich inline-reading view of every `blocked` thread's FULL
  // write-up (collectDecisions; `blocked` absorbs the old `needs-decision`). The same queue
  // the thread updater prints after each edit; surfaced here as a board subcommand for an
  // on-demand read.
  if (sub === 'decisions') {
    const all = collectDecisions();
    const human = all.filter((d) => !isExternalBlock(d.blocked_on));
    const external = all.filter((d) => isExternalBlock(d.blocked_on));
    if (all.length === 0) {
      console.log('✓ no pending decisions');
    } else {
      if (human.length) {
        console.log(`⚖ ${human.length} decision(s) awaiting you:\n`);
        human.forEach((d, i) => {
          console.log(`[${d.slug}]`);
          console.log(d.status_text || '(no status_text written up)');
          if (i < human.length - 1) console.log('');
        });
      } else {
        console.log('✓ no decisions awaiting you');
      }
      if (external.length) {
        console.log(`\n⏳ ${external.length} awaiting external (upstream/CI — tracked, NOT your call):`);
        external.forEach((d) => console.log(`  [${d.slug}] ${d.blocked_on ? `(${d.blocked_on}) ` : ''}${d.status_text || ''}`.trimEnd()));
      }
    }
    process.exit(0);
  }
}

// .fray/config.yml globals — parsed by the shared, type-safe loadConfig (autonomous_mode + state).
const cfg = loadConfig(PROJECT_DIR);

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
    const dependsOn = parseList(fm?.depends_on);
    // REVALIDATE timer — the parsed `revalidate_at`/`last_checked` state (null when unset/
    // malformed). `revalidateMalformed` is set when the field is PRESENT but didn't parse, so
    // a typo'd timestamp surfaces as a non-fatal warning below rather than silently never firing.
    const revalidate = revalidateState(fm?.revalidate_at, fm?.last_checked);
    const revalidateMalformed = Boolean(fm?.revalidate_at) && !revalidate;
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
      revalidate,
      revalidateMalformed,
      agents,
      text: src,
      errors,
      /** @type {string[]} */ warnings: [],
      dropRisk: false, // set true when the enqueued-but-all-deps-terminal heuristic fires
    };
  });

// `depends_on` references other THREAD SLUGS — validate they resolve. A dangling
// slug (no matching `.fray/<slug>.md`) is a warning, surfaced like any frontmatter
// error so the orchestrator notices the stale dependency. Everything is COMPUTED
// from the scanned set; there is no external registry to consult.
const slugs = new Set(threads.map((t) => t.id));
const statusOf = new Map(threads.map((t) => [t.id, t.status]));
for (const t of threads) {
  for (const dep of t.dependsOn) {
    if (!slugs.has(dep)) t.errors.push(`depends_on references unknown thread "${dep}"`);
  }
}

/**
 * A thread's blockers: the subset of its `depends_on` targets not yet terminal.
 * Empty ⇒ all dependencies clear. Unknown slugs are skipped here (already an error).
 * @param {{ dependsOn: string[] }} t
 * @returns {string[]}
 */
function blockers(t) {
  return t.dependsOn.filter((dep) => slugs.has(dep) && !TERMINAL.includes(statusOf.get(dep) ?? '?'));
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
  if (t.dependsOn.length) {
    const b = blockers(t);
    out.push(b.length
      ? `    ⏳ blocked on: ${b.join(', ')}`
      : `    ▶ READY — dependencies clear, dispatch now`);
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

  // (1) DROP-RISK: an `enqueued` thread that DECLARES `depends_on` but ALL of them are
  //     terminal — its auto-trigger fired and it was never dispatched. This is the
  //     post-`planned` drop shape: a ready thread whose transient blocker (correctly
  //     encoded in `depends_on`) has cleared, yet it still sits enqueued. The board
  //     computes this from frontmatter, so it CANNOT be skipped by reflex.
  if (t.status === 'enqueued' && t.dependsOn.length > 0 && blockers(t).length === 0) {
    t.dropRisk = true;
    t.warnings.push('drop risk: `enqueued` but ALL `depends_on` are terminal — it should have auto-fired; re-read the thread and dispatch/advance it now');
  }

  // status_text is a 1-2 sentence English status note (frontmatter); flag overlong ones —
  // anything past ~2 sentences belongs in the body, not the at-a-glance board field.
  // EXEMPT blocked: its status_text IS the ⚖ awaiting-you queue entry (the concise blocker /
  // open question), surfaced UNTRUNCATED on the board + reminder — never warn on or clip it.
  if (t.status !== 'blocked' && t.status_text && t.status_text.length > 280) {
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
    return { ...t, blockers: b, ready: t.dependsOn.length > 0 && b.length === 0 };
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

// ⚖ AWAITING YOU — the COMPUTED queue of every `blocked` thread (blocked / awaiting-human-
// decision / waiting-on-external — `blocked` absorbs the old `needs-decision`), surfaced by its
// FULL status_text (the concise blocker / open question). HOISTED to the top of the board (not
// buried mid-status-list) and rendered UNTRUNCATED — the terminal is wide and the question must
// be fully readable. Nothing is stored: filtered live from the scanned threads, the same
// compute-don't-cache principle as the rest of the board. Shown in the live/default + `--all`
// views and when `--status blocked` (or the legacy `needs-decision` alias) is requested;
// suppressed for any OTHER single-status filter. `blocked` is rendered ONLY here — it is
// skipped in the per-status group loop below to avoid duplication.
if (!only || only === 'blocked') {
  const pendingDecisions = threads.filter((t) => t.status === 'blocked');
  if (pendingDecisions.length) {
    out.push(`\n## ⚖ blocked (${pendingDecisions.length}) — awaiting your call`);
    for (const t of pendingDecisions) renderThread(t, out);
  }
}

for (const s of showStatuses) {
  if (s === 'blocked') continue; // rendered in the dedicated ⚖ awaiting-you section above
  const group = threads.filter((t) => t.status === s);
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
