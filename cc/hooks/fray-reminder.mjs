#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook — injects the DYNAMIC, per-turn orchestrator pulse each turn.
// Run directly with node (no transpiler — max Node compat; fray's hooks have zero deps).
//
// Carries ONLY the genuinely-dynamic, anti-drop bits that can change turn-to-turn:
//   - the `modeLine` (autonomous vs interactive + the autonomous empowerment paragraph),
//     gated on `autonomousMode` (which can flip mid-session); and
//   - the `status` (pending-thread list BY NAME + per-message frontmatter validation +
//     the drain-queue / decided≠open / reconcile one-liner).
// The STATIC orchestrator role + hygiene doctrine (formerly the `core` const) moved to the
// once-per-session SessionStart hook (session-seed.mjs) — it does not change within a
// session, so re-paying it every prompt was pure waste.
// Emits hookSpecificOutput.additionalContext (model-only). Robust: never throws (a broken
// hook must not disrupt the prompt) — any failure → inject nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  frayActive,
  loadConfig,
  TERMINAL,
  PARKED,
  normalizeStatus,
  isValidStatus,
  readLastReconcile,
  reconcileThresholdMin,
  isReconcileStale,
  revalidateState,
} from '../scripts/fray/config.mjs';

// Token-saving: skip entirely inside sub-agent contexts. The hook stdin carries
// `agent_id` ONLY when fired inside a sub-agent (UserPromptSubmit shouldn't fire there
// at all, so this is belt-and-suspenders). Main session → no agent_id → proceed.
let sessionId; // hook-input session_id (== CLAUDE_CODE_SESSION_ID) for the per-session gate
let transcriptPath; // hook-input transcript_path — lets the liveness check find this session's tasks dir fast
try {
  const hi = JSON.parse(readFileSync(0, 'utf8'));
  if (hi.agent_id ?? hi.agentId) process.exit(0);
  sessionId = hi.session_id;
  transcriptPath = hi.transcript_path;
} catch {
  /* no stdin / not JSON → assume main session, proceed */
}

/**
 * Parse a thread's `depends_on:` frontmatter into a list of thread slugs. Accepts both
 * the inline-array form (`depends_on: [a, b]`) and the YAML block form (`- a` lines).
 * Dependency-free, intentionally narrow — matches the shapes fray actually writes.
 * @param {string} src
 * @returns {string[]}
 */
function parseDepends(src) {
  const inline = src.match(/^depends_on:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const block = src.match(/^depends_on:\s*\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  if (block) {
    return block[1].split('\n').map((l) => l.replace(/^[ \t]+-[ \t]*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

/**
 * Strip surrounding double-quotes (and their escapes) from a frontmatter scalar — the same
 * shape the board's quoter writes. Used to surface a blocked thread's status_text
 * (the concise blocker / open question) in the per-turn awaiting-you queue, UNTRUNCATED.
 * @param {string | undefined} raw
 * @returns {string}
 */
function unquote(raw) {
  if (raw === undefined) return '';
  let v = raw.trim();
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) v = m[1].replace(/\\(.)/g, '$1');
  return v;
}

/**
 * Emit the model-only additionalContext and exit.
 * @param {string} ctx
 * @returns {never}
 */
function emit(ctx) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
    }),
  );
  process.exit(0);
}

try {
  const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';
  // fray ACTIVATION GATE — fray ships globally and this hook fires in EVERY project.
  // Inject NOTHING unless the project is opted in (`.fray/` exists AND not disabled), so
  // a virgin repo sees zero fray noise. The `/fray` skill bootstraps `.fray/` to activate.
  if (!frayActive(dir, sessionId)) process.exit(0);
  // autonomous_mode lives in .fray/config.yml — parsed by the shared, type-safe loadConfig.
  // The board/status view is COMPUTED by the tool, never stored.
  const cfg = loadConfig(dir);
  const mode = cfg.autonomousMode ? 'on' : 'off';

  // fray: thread pulse + per-message frontmatter VALIDATION (so a malformed thread
  // surfaces immediately, not whenever I happen to look). The vocab + normalization
  // (isValidStatus / normalizeStatus / TERMINAL / PARKED) come from the shared module —
  // the same source the tool's `--validate` uses, so the hook and board never drift, and a
  // legacy alias is accepted + bucketed canonically here too. Unrecognized fields are
  // allowed by design — only required fields + the status vocab are checked.
  /** @type {string[]} */
  const pending = []; // `<slug>[status]` for every SURFACED thread (non-terminal, non-PARKED) — compact, one line, names included so a stalled thread is caught BY NAME (not just a count). The PARKED `planned` phase is deliberately EXCLUDED from the per-turn nag (it is real, board-visible work, just not auto-surfaced) — only genuinely-actionable/in-flight statuses (planning/enqueued/active/blocked) nag. Full detail stays in the `fray` board, NOT injected per-message.
  /** @type {string[]} */
  const queued = []; // non-terminal threads that still carry a `QUEUED` follow-up marker — surfaced BY NAME so the drain-the-queue step can't be skipped (missing these is totally unacceptable).
  /** @type {string[]} */
  const errors = [];
  // First pass collects every thread's status + depends_on so the drop-risk check
  // (an `enqueued` thread whose deps are ALL terminal) can resolve cross-thread dep
  // statuses — a single-pass scan can't, since a dep may be a thread not yet seen.
  /** @type {{id:string,status:string|undefined,deps:string[],src:string,status_text:string,revalidate_at:string|undefined,last_checked:string|undefined,mtimeMs:number}[]} */
  const scanned = [];
  try {
    for (const f of readdirSync(join(dir, '.fray'))) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue; // `_`-prefixed = non-thread meta
      const id = f.replace(/\.md$/, '');
      const fp = join(dir, '.fray', f);
      const src = readFileSync(fp, 'utf8');
      // FRESHNESS via file mtime — no written flag to maintain; the filesystem already
      // tracks the last edit. Surfaced per-thread below so a thread that CLAIMS active but
      // hasn't been touched in a while is visibly STALE (the anti-drop signal for "I trusted
      // a thread that was 45m stale"). 0 = stat race → no age shown (fail-quiet).
      let mtimeMs = 0;
      try { mtimeMs = statSync(fp).mtimeMs; } catch { /* stat race → unknown */ }
      const rawSt = src.match(/^status:\s*(\S+)/m)?.[1];
      const st = normalizeStatus(rawSt); // canonical (legacy todo/plan/needs-decision → canonical); unknown passes through
      if (!/^title:\s*\S/m.test(src)) errors.push(`${id}: missing title`);
      if (!rawSt) errors.push(`${id}: missing status`);
      else if (!isValidStatus(rawSt)) errors.push(`${id}: invalid status "${rawSt}"`);
      scanned.push({
        id, status: st, deps: parseDepends(src), src, mtimeMs,
        status_text: unquote(src.match(/^status_text:\s*(.*)$/m)?.[1]),
        revalidate_at: src.match(/^revalidate_at:\s*(.*)$/m)?.[1],
        last_checked: src.match(/^last_checked:\s*(.*)$/m)?.[1],
      });
    }
  } catch {
    /* no .fray dir yet */
  }
  const statusOf = new Map(scanned.map((t) => [t.id, t.status]));
  // Freshness rendering: compact "edited Nm/Nh/Nd ago" per thread + a ⚠STALE flag for an
  // active/enqueued thread untouched longer than STALE_MIN (its agent likely rested mid-work
  // or the thread drifted from reality). blocked/planning legitimately sit, so they show age
  // but are never marked stale.
  const now = Date.now();
  const STALE_MIN = 25;
  /** @param {number} m mtimeMs (0 = unknown) @returns {string} */
  const ageLabel = (m) => {
    if (!m) return '';
    const min = Math.round((now - m) / 60_000);
    if (min < 90) return `${min}m`;
    const h = (now - m) / 3_600_000;
    return h < 24 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${Math.round(h / 24)}d`;
  };
  /** @type {string[]} */
  const dropRisk = []; // `enqueued` threads whose depends_on are ALL terminal — they SHOULD have auto-fired and didn't. The canonical silent-stall shape; surfaced BY NAME so it can't be skipped by reflex.
  /** @type {{slug:string,status_text:string}[]} */
  const decisions = []; // every `blocked` thread — the COMPUTED awaiting-you queue, surfaced each turn by its FULL status_text (the concise blocker / open question). Nothing stored; derived live from the scan. (`blocked` absorbs the old `needs-decision`.)
  /** @type {{slug:string,hint:string,lastChecked:string|null}[]} */
  const revalidateDue = []; // non-terminal threads whose `revalidate_at` is now ≤ now — the timer fired; re-poll the external state. Surfaced LOUDLY by name (the durable replacement for a live-polling watcher shell).
  for (const t of scanned) {
    if (TERMINAL.includes(t.status ?? '')) continue;
    // REVALIDATE TIMER OWNS SURFACING. A non-terminal thread carrying a (parseable)
    // `revalidate_at` is governed entirely by its timer, NOT the normal per-turn nag: while
    // the time is in the FUTURE it is parked + QUIET (suppressed from pending/decisions — it
    // waits on external state, not a human decision this turn); once DUE it surfaces ONCE in
    // the dedicated REVALIDATE block below. Either way it is excluded from pending/queued/
    // decisions/drop-risk so the timer is its single surfacing channel (no double-nag). A
    // malformed timestamp → revalidateState null → falls through to normal surfacing (fail-safe:
    // a typo'd timer surfaces as ordinary blocked rather than going silent).
    const rv = revalidateState(t.revalidate_at, t.last_checked);
    if (rv) {
      if (rv.due) revalidateDue.push({ slug: t.id, hint: t.status_text, lastChecked: rv.lastChecked });
      continue;
    }
    // PARKED (`planned`) is non-terminal but deliberately NOT auto-nagged — it is parked
    // work the orchestrator pulls up via the `fray` board on its own schedule, not every turn.
    // Only the genuinely-actionable/in-flight statuses (planning/enqueued/active/blocked)
    // reach the per-turn pending list + its sub-checks (queued/drop-risk/decisions).
    if (!PARKED.includes(t.status ?? '')) {
      const age = ageLabel(t.mtimeMs);
      const isStale = (t.status === 'active' || t.status === 'enqueued') &&
        t.mtimeMs > 0 && now - t.mtimeMs > STALE_MIN * 60_000;
      pending.push(`${t.id}[${t.status ?? '?'}${age ? ', ' + age : ''}${isStale ? ' ⚠STALE' : ''}]`);
      if (/\bQUEUED\b/.test(t.src)) queued.push(t.id);
      if (t.status === 'blocked') decisions.push({ slug: t.id, status_text: t.status_text });
      // Drop-risk: enqueued WITH declared deps, ALL of which are terminal (the
      // auto-trigger fired but nothing dispatched it). A dep that is an unknown slug
      // is NOT terminal → not flagged (conservative; avoids crying wolf on a typo).
      if (t.status === 'enqueued' && t.deps.length > 0 &&
          t.deps.every((d) => TERMINAL.includes(statusOf.get(d) ?? '?'))) {
        dropRisk.push(t.id);
      }
    }
  }
  const status =
    `FRAY — ${pending.length} pending: ${pending.join(', ') || 'none'}. Advance or reconcile EACH this turn; if you went deep on ONE thread, don't let the others silently stall (run \`fray\` for detail). Each thread shows when its file was last edited; a \`⚠STALE\` marker = an active/enqueued thread untouched >${STALE_MIN}m (its agent likely rested mid-work or its status drifted from reality) — RE-READ that thread + verify it actually progressed (check its PR/agent) before trusting its text. Returns are a strict INBOX — drain the OLDEST first, ONE at a time, never batch; an empty/progress-only return is an INCOMPLETE handoff (record needs-retry + re-dispatch, do NOT mark done). When you fold a return: DRAIN that thread's queued follow-ups (\`## Steps\` items marked QUEUED — dispatch on <agent>'s return) + MOVE any answered Open question into Decisions (a DECIDED thing lives under ## Decisions, NEVER Open questions). done/dismissed threads are TERMINAL + KEPT — never delete them. ALWAYS STEER — DON'T RE-DISPATCH (TOP-PRIORITY RULE): SendMessage works on running AND completed sub-agents. To add context / redirect / fold scope into a file an agent owns, answer a question it raised, or RESUME an agent the instant a temporary blocker (a HOLD, a transient CI failure, a now-available input) clears — MESSAGE/RESUME that agent (by name or agentId). NEVER let an agent die and cold-redispatch a fresh replacement (loses its runbook + context), never spawn a clobbering sibling, never kill-and-respawn (orphans WIP). Only fall back to marking it\`enqueued\` (naming the agent it waits on) and dispatch the instant that agent returns; never spawn a clobbering sibling or kill-and-respawn.` +
    (queued.length ? `  ⚠ UN-DRAINED QUEUED FOLLOW-UPS in ${queued.length} thread(s): ${queued.join(', ')}. THE INSTANT any of their agents returns, RE-READ that thread .md (don't reconcile from memory) and DISPATCH the actionable QUEUED items as sub-agents THIS turn (a mandated self-review/integration pass IS one — dispatch it). Surface, never silently drop, the human-gated/post-launch ones. Skipping this is the #1 failure.` : '') +
    (dropRisk.length ? `  ⚠⚠ DROP-RISK THREADS in ${dropRisk.length} thread(s): ${dropRisk.join(', ')}. These are \`enqueued\` with ALL their \`depends_on\` now TERMINAL — their auto-trigger fired and they were NEVER dispatched (the exact silent-stall this guard exists to kill). RE-READ each thread .md THIS turn and DISPATCH/ADVANCE it — do NOT skip past this. If one is genuinely not ready, move it back to \`todo\` or fix its \`depends_on\`; leaving it \`enqueued\` with cleared deps is a bug.` : '') +
    (decisions.length ? `  ⚖ ${decisions.length} BLOCKED — AWAITING YOUR CALL (computed from \`blocked\` threads — nothing stored): ${decisions.map((d) => `[${d.slug}] ${d.status_text || '(no write-up — add a one-line status_text)'}`).join('  ·  ')}. SURFACE these to the human (full context, numbered — see the skill) and do NOT silently sit on them; each awaits a human decision / answer / external event. On resolution, record the call in the thread's \`## Decisions\` body and flip status OUT of blocked.` : '') +
    (revalidateDue.length ? `  ⏰ ${revalidateDue.length} REVALIDATE DUE — re-poll the external state NOW (CHANGED → act/unblock; UNCHANGED → bump \`revalidate_at\` forward 6–12h + stamp \`last_checked: <now>\`; re-arm until terminal): ${revalidateDue.map((r) => `⏰ REVALIDATE DUE: ${r.slug} — ${r.hint || 're-poll the external state'} (last checked ${r.lastChecked || 'never'})`).join('  ·  ')}.` : '') +
    (errors.length ? `  ⚠ VALIDATION ERRORS (fix now): ${errors.join('; ')}` : '');

  const modeLine =
    mode === 'on'
      ? "AUTONOMOUS MODE = ON (the human is away). What this MEANS: MAKE REASONABLE DECISIONS WITHOUT A HUMAN IN THE LOOP — do NOT ask questions, do NOT stall for confirmation; bias HARD to action and keep the background fleet busy. At a fork, pick the sensible option, DOCUMENT the call in the tracker, and PROCEED (choosing intelligently and letting the maintainer adjust on review beats stopping). Reconcile every completed sub-agent and immediately dispatch the next work. The ONLY things you may NOT autonomously land: a default / security-posture / product / brand / API-config-env decision the maintainer owns (recommend-only — design+prototype, surface to the tracker's decisions queue, don't flip the default), anything irreversible/destructive/published-external, and parked work not yet greenlit. Everything else: decide and do. Scan the board via `fray`. You ARE empowered — land greenlit work, merge landing agents' PRs, create repos, install tooling — yourself, no asking. Substantive work lands via a PR from an isolated git WORKTREE (agents open, you merge); the SHARED main tree is never branched/reset/stashed; exception-class edits (control surfaces, trivial docs) commit direct to main. Do NOT build an 'awaiting-maintainer' queue from REVERSIBLE decisions (the #1 repeated correction). The only true gates: a truly-irreversible-destructive act, a user-facing DEFAULT (ship behind a flag, don't freeze), and public-facing wording."
      : `autonomous_mode=${mode} → interactive: surface decisions + ask rather than auto-landing.`;

  // Surface ONLY the high-confidence "ACTIVE THREAD, NO LIVE AGENT" lines per turn (never the
  // soft idle notes — those would be noise). A genuinely stranded active thread SHOULD nag
  // every turn until reconciled (the anti-drop signal that would have caught the GVS miss), and
  // it is rare by construction (newest agent quiet >45m + rested + no PR/merge), so it can't cry
  // wolf. Dynamic import so a broken helper can never crash the prompt before this catch.
  let stranded = '';
  try {
    const { strandedThreadLines } = await import('../scripts/fray/agent-liveness.mjs');
    const sl = strandedThreadLines({ transcriptPath, projectDir: dir });
    if (sl.length) stranded = '\n\n' + sl.join('\n');
  } catch {
    /* fail-open — no stranded surfacing rather than risk the prompt */
  }

  // ANTI-DRIFT RECONCILE FORCING-FUNCTION. The board is computed from per-thread frontmatter,
  // so a thread whose status drifted from reality (a PR merged but the thread never flipped)
  // is surfaced as live truth until something re-grounds it. We persist a last-complete-
  // reconcile timestamp (`.fray/.last-reconcile`); when it goes stale, emit a LOUD instruction
  // to spin up a reconcile sub-agent. FAST by design: only timestamp math here — the actual
  // PR-liveness checking is the dispatched sub-agent's job, NEVER this every-turn hook (no
  // network/gh calls). A missing timestamp counts as stale (instruct a first reconcile).
  let reconcileBlock = '';
  try {
    const lastMs = readLastReconcile(dir);
    const thresholdMin = reconcileThresholdMin(cfg);
    if (isReconcileStale(lastMs, thresholdMin)) {
      const ago = lastMs == null ? 'never recorded' : `${Math.round((Date.now() - lastMs) / 60_000)}m ago`;
      reconcileBlock =
        `⚠ BOARD RECONCILE STALE (${ago}) — the board may not reflect reality (a thread's status can drift from the actual code/PRs). Spin up a reconcile sub-agent NOW: re-ground EVERY non-terminal thread against ground truth (PR merged? symbol exists? work shipped?), flip drifted statuses to match, then record the reconcile by running \`fray reconcile\` (stamps \`.fray/.last-reconcile\`). Do this before trusting the pending list below.\n\n`;
    }
  } catch {
    /* fail-open — skip the reconcile nag rather than risk the prompt */
  }

  emit(`${reconcileBlock}${modeLine}  ${status}${stranded}`);
} catch {
  // Fail-open: a broken hook must not disrupt the prompt. The static doctrine now lives in
  // SessionStart (session-seed.mjs), so there is nothing safe to fall back to here — inject
  // nothing rather than risk emitting partial/garbage.
  process.exit(0);
}
