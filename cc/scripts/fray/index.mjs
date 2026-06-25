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
 *   fray               # print the LIVE board (active/enqueued/blocked/needs-decision only)
 *   fray --all         # print all threads (every status)
 *   fray --status todo # print only threads in one status
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
  setSessionOverride,
  clearSessionOverride,
  sessionOverride,
  currentSessionId,
  frayActive,
} from './config.mjs';
import { parseAgents } from './agent-liveness.mjs';
import { deriveAgentState, findAgentOutputAge } from './agent-status.mjs';
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
  // `fray decisions` — the rich inline-reading view of every `needs-decision` thread's
  // FULL write-up (collectDecisions). The same queue the thread updater prints after each
  // edit; surfaced here as a board subcommand for an on-demand read.
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

// No `.fray/` here → fray is not active in this project. Print a friendly pointer instead
// of crashing on a missing directory (the board ships globally and may be run anywhere).
let frayEntries;
try {
  frayEntries = readdirSync(FRAY_DIR);
} catch {
  console.log(`No .fray/ in ${PROJECT_DIR} — fray is not active here. Run the /fray skill to bootstrap it (creates .fray/ + a default config.yml).`);
  process.exit(0);
}

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
      if (fm.status && !STATUS.includes(fm.status))
        errors.push(`invalid status "${fm.status}" (expected one of: ${STATUS.join(', ')})`);
    }
    const dependsOn = parseList(fm?.depends_on);
    const next = nextStep(src);
    const threadTerminal = TERMINAL.includes(fm?.status ?? '?');
    const threadActive = fm?.status === 'active'; // only `active` threads flag UNRECONCILED/idle agents; parked phases are expected to hold done agents
    // Agent liveness is DERIVED, never read from a stored per-agent flag: the binding
    // carries only immutable `{id, label}`; state comes from output-file age (ground
    // truth) + the thread's own status, via the SAME derivation the Stop hook uses.
    const agents = parseAgents(src).map((a) => ({
      ...a,
      state: deriveAgentState({ ageMin: findAgentOutputAge(a.id), threadTerminal, threadActive }),
    }));
    return {
      id,
      title: fm?.title ?? '',
      status: fm?.status ?? '?',
      status_text: fm?.status_text ?? '',
      next,
      dependsOn,
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
  if (t.status_text && t.status_text.length > 280) {
    t.warnings.push(`status_text is ${t.status_text.length} chars — keep it to 1-2 sentences; move detail into the body`);
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
const si = process.argv.indexOf('--status');
const only = si !== -1 ? process.argv[si + 1] : null;
const showAll = process.argv.includes('--all');
if (only && !STATUS.includes(only)) {
  console.error(`unknown status "${only}" (expected one of: ${STATUS.join(', ')})`);
  process.exit(2);
}

// Statuses hidden from the default board (non-actionable). Read defensively from
// config.mjs STATUS so an absent status is simply skipped.
const HIDDEN_BY_DEFAULT = new Set(['todo', 'done', 'dismissed'].filter((s) => STATUS.includes(s)));

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
for (const s of showStatuses) {
  const group = threads.filter((t) => t.status === s);
  if (!group.length) continue;
  out.push(`\n## ${s} (${group.length})`);
  for (const t of group) {
    out.push(`- ${t.id} — ${t.title}`);
    if (t.status_text) out.push(`    » ${t.status_text}`);
    out.push(`    → ${t.next}`);
    if (t.dependsOn.length) {
      const b = blockers(t);
      out.push(b.length
        ? `    ⏳ blocked on: ${b.join(', ')}`
        : `    ▶ READY — dependencies clear, dispatch now`);
    }
    // Dispatched-agent liveness — DERIVED (output-file age + thread status), never stored.
    for (const a of t.agents) {
      if (a.state === 'fresh' || a.state === 'terminal' || a.state === 'unknown') continue;
      const who = `${a.label ? `${a.label} ` : ''}[${a.id.slice(0, 9)}]`;
      out.push(a.state === 'unreconciled'
        ? `    ⚠ UNRECONCILED agent ${who} — output stale, thread non-terminal; fold + reconcile`
        : `    ⚠ IDLE agent ${who} — no recent output; poke or confirm mid-build`);
    }
    for (const w of t.warnings) out.push(`    ⚠ ${w}`);
  }
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
