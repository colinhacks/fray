#!/usr/bin/env node
// @ts-check
// PermissionRequest hook (fray worker), matcher "*" — a durable, STRUCTURED replacement for scraping
// the tmux pane to notice a blocking permission prompt. Claude Code's transcript emits no signal when
// a worker parks on a tool-approval prompt (the last record stays assistant + stop_reason:"tool_use"),
// so fray historically regex-matched the rendered TUI — fragile, and it false-tripped whenever an
// agent merely QUOTED prompt-shaped text on screen. This hook fires exactly when Claude CREATES the
// permission request, so it is precise by construction: it drops a marker file the tailer reads as the
// primary "blocked on <tool>" signal, and the regex is demoted to a fallback for the trust/login
// screens (which fire no PermissionRequest) and plugin-less foreign sessions.
//
// OBSERVE-ONLY: this hook emits NOTHING on stdout and exits 0, so it does NOT decide the request — the
// normal permission flow proceeds and the human still answers the prompt. (Verified 2026-07-21: an
// empty-output exit-0 PermissionRequest hook leaves the prompt pending.)
//
// The tailer owns the marker's LIFECYCLE (supersede-by-timestamp + idle cleanup); this hook only ever
// WRITES the current request, overwriting any prior one for the same slug. A resolved request always
// advances the transcript past `at`, which is how the tailer knows the block cleared.
//
// GATE: inert unless FRAY_UI_THREAD (the slug) AND FRAY_PERM_DIR (the marker dir the server scans) are
// both set. FAIL OPEN on any error — a broken observer must never halt or alter a worker.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const slug = process.env.FRAY_UI_THREAD;
const dir = process.env.FRAY_PERM_DIR;
if (!slug || !dir) process.exit(0);

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  // ExitPlanMode is always auto-denied by the sibling deny-plan.mjs (a fray worker is never in plan
  // mode), so it never becomes a real human block — don't mark it.
  if (input.tool_name === 'ExitPlanMode') process.exit(0);
  const marker = {
    slug,
    tool: typeof input.tool_name === 'string' ? input.tool_name : null,
    promptId: typeof input.prompt_id === 'string' ? input.prompt_id : null,
    permissionMode: typeof input.permission_mode === 'string' ? input.permission_mode : null,
    at: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  // Write to a temp sibling then rename, so the tailer never reads a half-written marker.
  const dest = join(dir, `${slug}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, dest);
} catch {
  // fail open — the request proceeds regardless
}
process.exit(0);
