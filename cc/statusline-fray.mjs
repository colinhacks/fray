#!/usr/bin/env node
// @ts-check
// fray status line — a Claude Code `statusLine` command (configured in settings.json,
// because a PLUGIN cannot ship a statusLine: only `agent`/`subagentStatusLine` keys are
// honored in plugin-shipped settings, and a UserPromptSubmit hook's additionalContext is
// MODEL-ONLY — never rendered in the TUI). This is the user-visible surface for the fray
// board: a tasteful base line (dir · branch · model · context%) and, WHEN fray is active
// for this session, the live board summary — the states that actually matter, in priority
// order: NEEDS-DECISION (awaiting the human — YELLOW/prominent), ACTIVE (a live driver is on
// it now — cyan), and BLOCKED (waiting on a NON-human thing: another thread, a PR/CI, an
// external merge — GRAY/de-emphasized, deliberately quiet). Everything else
// (planning/planned/enqueued/terminal) is intentionally not counted here.
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

/**
 * Scan `.fray/*.md` once and count the three live states that matter:
 *   needsDecision — awaiting the HUMAN (the ⚖ queue). YELLOW/prominent.
 *   active        — a driver (agent or the merge-cascade) is on it right now.
 *   blocked       — waiting on a NON-human thing (another thread, a PR/CI, an external merge).
 * Everything else (planning/planned/enqueued/terminal) is deliberately not counted.
 * @param {string} projectDir
 * @returns {{ needsDecision: number, active: number, blocked: number }}
 */
function scanBoard(projectDir) {
  let needsDecision = 0;
  let active = 0;
  let blocked = 0;
  for (const f of readdirSync(join(projectDir, '.fray'))) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    let st;
    try {
      st = readFileSync(join(projectDir, '.fray', f), 'utf8').match(/^status:\s*(\S+)/m)?.[1];
    } catch {
      continue;
    }
    if (!st || TERMINAL.has(st)) continue;
    if (st === 'needs-decision') needsDecision++;
    else if (st === 'active') active++;
    else if (st === 'blocked') blocked++;
  }
  return { needsDecision, active, blocked };
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

  // ── fray segment (only when active): "fray enabled · N needs-decision · N active · N blocked" ──
  // Priority order + colors: needs-decision is YELLOW (grab the eye — the human must act); active
  // is cyan; blocked is GRAY (de-emphasized — it's just waiting on other threads/PRs, not urgent).
  if (frayActive(projectDir, sessionId)) {
    const { needsDecision, active, blocked } = scanBoard(projectDir);
    const fray = [`${dim('fray')} enabled`]; // "enabled" non-dim (default fg) to signal fray is ON
    fray.push(needsDecision > 0 ? amber(`${needsDecision} needs-decision`) : dim('0 needs-decision'));
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
