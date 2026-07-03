#!/usr/bin/env node
// @ts-check
// fray status line — a Claude Code `statusLine` command (configured in settings.json,
// because a PLUGIN cannot ship a statusLine: only `agent`/`subagentStatusLine` keys are
// honored in plugin-shipped settings, and a UserPromptSubmit hook's additionalContext is
// MODEL-ONLY — never rendered in the TUI). This is the user-visible surface for the fray
// board: a tasteful base line (dir · branch · model · context%) and, WHEN fray is active
// for this session, the live board summary — the states that actually matter, in priority
// order: AWAITING-YOU (human-blocked — YELLOW/prominent), ACTIVE (a live driver is on it now
// — cyan), and BLOCKED (machine/timer-blocked: waiting on another thread, a PR/CI, an external
// gate, or a revalidate timer — GRAY/de-emphasized, deliberately quiet). A `blocked` thread's
// RESOLUTION MECHANISM (which field is set) decides awaiting-you vs blocked, not a status word.
// Everything else (planning/planned/terminal) is intentionally not counted here.
//
// CANONICAL SOURCE: this file lives in the fray repo at `cc/statusline-fray.mjs`. It is
// DEPLOYED (copied verbatim) to `~/.claude/statusline-fray.mjs`, the stable path the
// settings.json `statusLine` command points at — it must stay self-contained and must NOT
// import from the versioned plugin cache (`~/.claude/plugins/cache/fray/fray/<version>/…`),
// whose path moves on every plugin bump. Edit HERE, push, then redeploy the copy.
//
// The activation gate below is an exact copy of the plugin's config.mjs `frayActive` +
// `sessionOverride`, so the status line lights up under EXACTLY the same condition as the
// hooks: `.fray/` exists AND this session has an `on` sentinel.
//
// Robust: never throws. Any failure → a minimal fallback line, never a broken status bar.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── ANSI (kept tiny; statuslines support color) ──────────────────────────────
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const gray = (s) => `\x1b[90m${s}\x1b[0m`; // de-emphasized (blocked = non-human wait, shouldn't grab the eye)
const sep = dim('·');

/**
 * fray's per-session activation gate — an EXACT copy of the plugin's config.mjs so the
 * status line is active under identical conditions to the hooks. `.fray/` must exist AND
 * the per-session sentinel must say `on` (opt-in default: dormant without it).
 * @param {string} projectDir
 * @param {string|undefined|null} sessionId
 * @returns {boolean}
 */
function frayActive(projectDir, sessionId) {
  if (!projectDir || !existsSync(join(projectDir, '.fray'))) return false;
  if (!sessionId) return false;
  try {
    const f = join(projectDir, '.fray', '.session-state', sessionId);
    if (!existsSync(f)) return false; // no override → dormant (opt-in)
    const v = readFileSync(f, 'utf8').trim().toLowerCase();
    return v === 'on' || v === 'true' || v === 'yes' || v === '1' || v === 'enabled';
  } catch {
    return false;
  }
}

const TERMINAL = new Set(['done', 'dismissed']);

/** Normalize a raw `status:` to canonical — inlined (this file is deployed standalone, no
 *  imports from the plugin). Legacy `enqueued`/`needs-decision` → `blocked`; `todo`/`plan` →
 *  `planned`. The human/machine split for `blocked` is derived from the mechanism FIELDS below,
 *  not the word, so a legacy `enqueued` (has deps → machine) or `needs-decision` (no field →
 *  human) classifies correctly. */
function normStatus(s) {
  if (s === 'enqueued' || s === 'needs-decision') return 'blocked';
  if (s === 'todo' || s === 'plan') return 'planned';
  return s;
}

/**
 * Scan `.fray/*.md` once and count the three live states that matter, in the unified waiting
 * model (2026-07-01): a `blocked` thread's RESOLUTION MECHANISM (which field is set) decides its
 * urgency, not the status word.
 *   awaitingYou — HUMAN-blocked (`blocked` with no `blocking_threads`/`depends_on`/`revalidate_at`).
 *                 YELLOW/prominent — the maintainer must act.
 *   active      — a driver (agent or the merge-cascade) is on it right now. CYAN.
 *   blocked     — MACHINE/timer-blocked (has a `blocking_threads`/`revalidate_at` mechanism).
 *                 GRAY/de-emphasized — waiting on non-human work.
 * Everything else (planning/planned/terminal) is not counted.
 * @param {string} projectDir
 * @returns {{ awaitingYou: number, active: number, blocked: number }}
 */
function scanBoard(projectDir) {
  let awaitingYou = 0;
  let active = 0;
  let blocked = 0;
  for (const f of readdirSync(join(projectDir, '.fray'))) {
    if (!f.endsWith('.md') || f.startsWith('_') || f.startsWith('.')) continue;
    let src;
    try {
      src = readFileSync(join(projectDir, '.fray', f), 'utf8');
    } catch {
      continue;
    }
    const raw = src.match(/^status:\s*(\S+)/m)?.[1];
    if (!raw) continue;
    const st = normStatus(raw);
    if (TERMINAL.has(st)) continue;
    if (st === 'active') { active++; continue; }
    if (st === 'blocked') {
      const depsM = src.match(/^(?:blocking_threads|depends_on):\s*(.+)$/m);
      const hasDeps = depsM ? depsM[1].trim() !== '' && depsM[1].trim() !== '[]' : false;
      const hasTimer = /^revalidate_at:\s*\S/m.test(src);
      if (hasDeps || hasTimer) blocked++;
      else awaitingYou++;
    }
  }
  return { awaitingYou, active, blocked };
}

/**
 * Cheap current-branch read straight from `.git/HEAD` — no `git` subprocess (the statusLine
 * command runs on every refresh; keep it allocation-light). Returns '' when detached/absent.
 * @param {string} projectDir
 * @returns {string}
 */
function gitBranch(projectDir) {
  try {
    const head = readFileSync(join(projectDir, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 7); // branch name, or short detached SHA
  } catch {
    return '';
  }
}

try {
  const hi = JSON.parse(readFileSync(0, 'utf8'));
  const projectDir = hi.workspace?.project_dir || hi.workspace?.current_dir || hi.cwd || process.cwd();
  const curDir = hi.workspace?.current_dir || hi.cwd || projectDir;
  const sessionId = hi.session_id;

  // ── base segments (always shown — this REPLACES the built-in line) ──
  const parts = [];
  parts.push(basename(curDir) || curDir);
  const branch = hi.workspace?.git_worktree || gitBranch(projectDir);
  if (branch) parts.push(dim(branch));
  const model = hi.model?.display_name;
  if (model) parts.push(dim(model));
  const pct = hi.context_window?.used_percentage;
  if (typeof pct === 'number') parts.push(dim(`${pct}%`));

  let line = parts.join(` ${sep} `);

  // ── fray segment (only when active): "fray enabled · N awaiting-you · N active · N blocked" ──
  // Priority order + colors keyed on the RESOLUTION MECHANISM, not a status word: awaiting-you
  // (human-blocked) is YELLOW (grab the eye — the human must act); active is cyan; blocked
  // (machine/timer-blocked) is GRAY (de-emphasized — waiting on other threads/PRs, not urgent).
  if (frayActive(projectDir, sessionId)) {
    const { awaitingYou, active, blocked } = scanBoard(projectDir);
    const fray = [`${dim('fray')} enabled`]; // "enabled" non-dim (default fg) to signal fray is ON
    fray.push(awaitingYou > 0 ? amber(`${awaitingYou} awaiting-you`) : dim('0 awaiting-you'));
    fray.push(active > 0 ? cyan(`${active} active`) : dim('0 active'));
    fray.push(blocked > 0 ? gray(`${blocked} blocked`) : dim('0 blocked'));
    line += `   ${fray.join(` ${sep} `)}`;
  }

  process.stdout.write(line);
} catch {
  // Never break the status bar — emit a minimal fallback.
  try {
    process.stdout.write(basename(process.cwd()));
  } catch {
    /* give up silently */
  }
}
