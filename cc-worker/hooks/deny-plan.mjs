#!/usr/bin/env node
// @ts-check
// PermissionRequest hook on ExitPlanMode (fray) — a fray-ui worker runs under a dashboard, not a
// live chat, so the plan-APPROVAL prompt (shown when the model calls ExitPlanMode to present a plan
// and ask to proceed) would hang the session invisibly. Deny it and redirect the worker to encode
// its plan/ask in the thread file instead.
//
// WHY PermissionRequest, not PreToolUse: ExitPlanMode is a PERMISSION surface, not a plain tool —
// it is denied via PermissionRequest (AskUserQuestion, a real tool, is denied via PreToolUse in the
// sibling deny-ask.mjs). CAVEAT: PermissionRequest hooks do NOT fire under `claude -p` (headless
// print mode); fray-ui workers run as INTERACTIVE tmux `claude` sessions, where they DO fire. So
// this protects the real worker path; the `-p` smoke test cannot exercise it (documented).
//
// PLAN-MODE SOFTLOCK — why this denies UNCONDITIONALLY when gated: a session genuinely IN plan mode
// is read-only until ExitPlanMode is approved, so denying ExitPlanMode there would SOFTLOCK it
// (can't exit → can't edit → can't even follow the "write to the thread" redirect). This hook CANNOT
// tell if the session is in plan mode: the PermissionRequest input carries NO permission-mode signal
// (session_id / cwd / hook_event_name only — Claude Code hooks docs). The fix is at the SOURCE
// instead — fray-ui NEVER spawns a worker in plan mode (dispatch.ts coerces `--permission-mode plan`
// → `auto` in both command builders), so a real fray-ui worker is never in plan mode and this deny
// only ever meets a SPURIOUS ExitPlanMode call (nothing to exit → deny + redirect is correct). A
// worker "plans" by writing a plan file (`.fray/plans/<topic>.md`) and asking via a ```question
// approval block, never via interactive plan mode.
// RESIDUAL GAP (accepted, documented): the deny could softlock only a FOREIGN session that is
// simultaneously in plan mode AND running with FRAY_UI_THREAD set AND this plugin loaded — a combo
// fray-ui never produces (FRAY_UI_THREAD is set only by fray-ui dispatch, which coerces plan away).
// A normal plan-mode session outside fray-ui is untouched (this hook is inert without FRAY_UI_THREAD).
//
// GATE: inert unless FRAY_UI_THREAD is set. FAIL OPEN on any parse error — a broken hook must never
// halt work.
import { readFileSync } from 'node:fs';

const slug = process.env.FRAY_UI_THREAD;
if (!slug) process.exit(0);

try {
  JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // fail open — a broken hook must never halt work
}

// The instructive redirect rides TOP-LEVEL `additionalContext` (per the Claude Code hooks docs) —
// on a PermissionRequest DENY the `decision` object carries ONLY `{behavior:"deny"}`; the reason
// the model reads is `additionalContext`, injected as a plain-text system-reminder. Exit 0 with
// this JSON on stdout (exit 2 would make Claude Code ignore the JSON — never mix).
const reason =
  'Interactive plan-approval prompts freeze headless workers (no one is at the keyboard to approve). Do NOT present a plan for approval. Instead: if the plan is settled, just proceed with the work. If the plan is the deliverable, write it into a plan file `.fray/plans/<topic>.md` (free-form markdown) and/or your scratchpad. If it needs a human call before you build, ask in your FINAL MESSAGE with a ```question approval block stating what you need approved, then come to rest — the human reviews it from the fray-ui queue.';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny' },
    },
    additionalContext: reason,
  }),
);
process.exit(0);
