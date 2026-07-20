# cc-worker — design decisions

The **fray** worker-side plugin (dir `cc-worker/`, manifest `name: "fray"` since 2026-07-08) is
consumed by fray-ui worker sessions: one interactive top-level
`claude` per `.fray/` thread, loaded via `claude --plugin-dir <repo>/cc-worker`. Each session is a
**worker bound to ONE thread** (slug in env `FRAY_UI_THREAD` + a `THREAD:` line in its prompt). The
human + the fray-ui app are the orchestrator; the worker just drives its one thread. This records
what was ported from the orchestrator `cc/` plugin, what was dropped, and why.

## Shared source, bundled runtime closure

- **`scripts/fray/config.mjs` and `scripts/fray/agent-bindings.mjs` are THIN SHIMS** that
  `export *` from `../../../cc/scripts/fray/*.mjs`. cc-worker never copies config/vocab/binding
  logic — there is exactly one source of truth (cc's). This assumes cc is a sibling dir (`../../cc/`
  from the plugin root), the same assumption fray-ui's server makes (`ui/ARCHITECTURE.md`: it imports
  the board logic from `../../cc/scripts/fray/*.mjs`).
- **`bin/fray` and `bin/fray-update`** are cc's exact shim pattern, resolving cc's real scripts at
  `../../cc/scripts/fray/{index,thread-update}.mjs` relative to the bin file (cwd-independent). They
  land on the worker's Bash PATH the way cc's do. `fray-update` is the worker's primary tool for
  owning its one thread file; `fray` lets it read/validate the board.
- **Portable artifact rule:** `ui/packages/cli/src/artifacts.ts` copies the exact sibling
  `cc/scripts/fray/` module closure to `runtime/cc/scripts/fray/`, beside `runtime/cc-worker/`.
  The existing shims therefore resolve inside an immutable artifact when the source checkout is gone;
  both the worker and cc closure are hashed in `manifest.runtimeFiles` and required at read time.
- **`agents/*.md`** are copied UNCHANGED from `cc/agents/` (16 profiles) — a worker dispatches its
  own helpers at the same model/effort cells as the orchestrator.

## Hooks ported (all gated on `FRAY_UI_THREAD` — inert if the plugin is loaded anywhere else)

| Hook | Event | Ported from | What it does for a worker |
| --- | --- | --- | --- |
| `session-seed.mjs` | SessionStart (startup/resume/clear/compact) | cc `session-seed.mjs` | Injects the single-thread worker contract + the bound slug + its file path; re-grounds on compact. Also writes cc's `off` sentinel defensively (see interplay). |
| `agent-dispatch.mjs` | PreToolUse(Agent) | cc `agent-dispatch.mjs` | Enforces `run_in_background:true`, strips `name`/`team_name`, appends a worker-flavored orchestration epilogue. |
| `agent-bind.mjs` | PostToolUse(Agent) | cc `agent-bind.mjs` (verbatim behavior) | Records `agentId → thread` into `.fray/.agent-bindings.jsonl` in cc's exact format, so a worker's THREAD-tagged helper renders on the fray-ui board's per-thread liveness. |
| `stop-flush.mjs` | Stop | cc `fray-stop-reminder.mjs` (dirty-check idea only) | If the worker's ONE thread file wasn't edited since the last rest, nudges it to flush its state (mtime dirty-check, cooldown-limited, least-alarming `additionalContext` channel). |

## cc hooks DROPPED — one line each on why

- **`fray-reminder.mjs` (UserPromptSubmit per-turn pulse)** — DROPPED. It nags the *orchestrator*
  about the whole board (pending-by-status, reconcile-stale, un-drained follow-ups, revalidate-due).
  A worker owns one thread and does not orchestrate a board; a per-turn board pulse is pure noise.
- **`fray-stop-reminder.mjs` (board-wide Stop reconcile + pop-one decision queue)** — DROPPED as-is;
  only its per-thread dirty-check idea is reused in `stop-flush.mjs`. The rest (reconcile every
  rested agent, pop the next human-blocked thread and present it) is orchestrator decision-queue work
  the fray-ui app + human own, not the worker.
- **`fray-notify-surface.mjs` (Stop) + `fray-notify` bin/`notify.mjs`** — DROPPED. The durable
  WIN/DECISION/BLOCKER notification queue is an orchestrator surfacing channel; in fray-ui the UI
  surfaces "awaiting you" from thread `status: blocked` + `status_text` directly, so the worker needs
  no separate notify queue.
- **`fray-subagent-rest.mjs` (SubagentStop recorder) + `fray-rest-guard.mjs` (SubagentStop guard)**
  — DROPPED. These feed the orchestrator's board-wide "reconcile every rested dispatched agent"
  machinery (`.rested-agents.jsonl`, the `.dispatch-count` gate). A worker actively collects its own
  handful of helpers before resting (contract in SKILL.md); it does not need the board-scale
  rest-reconciliation guard. The worker-facing half of the rest-guard's lesson (run long ops inline,
  don't rest on a waiter) is carried in the dispatch epilogue instead.
- **`fray-thread-edit-steer.mjs` (PostToolUse Edit/Write)** — DROPPED. It's an orchestrator
  convenience that steers an in-flight agent when the orchestrator hand-edits a thread; a worker edits
  its OWN thread and dispatches its OWN helpers, so there's nothing to cross-steer.
- **`session-end.mjs` (SessionEnd heartbeat clear)** — DROPPED. It clears the session-ownership
  HEARTBEAT so a dead orchestrator's threads orphan. Workers don't participate in cc's multi-session
  ownership model (no `owner_session` claims, no heartbeat) — the fray-ui app tracks which session
  drives which thread — so there's no heartbeat to clear.
- **The `.dispatch-ledger.jsonl` write + THREAD-existence DENY gate + `.dispatch-count` bump**
  (inside cc's `agent-dispatch.mjs`) — DROPPED from the worker's PreToolUse. The ledger is a
  compaction-durable orchestrator record of which-agent-serves-which-thread across MANY threads; the
  THREAD-existence gate enforces the orchestrator's "file the thread before dispatching" discipline;
  the count only gates the (dropped) SubagentStop recorder. A worker owns exactly one, already-created
  thread and its helpers own no thread, so none apply. The `.agent-bindings.jsonl` write — the piece
  that actually renders sub-agent liveness on the board — IS kept (via `agent-bind.mjs`).

## Interplay with the orchestrator `cc` plugin (double-hook analysis)

**Question:** if the user has `cc` (the fray orchestrator plugin) enabled globally AND a fray-ui
worker session starts in the same repo, do both plugins' hooks fire (double-hook)?

**Finding — NO, not by default. cc is inert in a fresh worker session.** cc's every hook is gated on
`frayActive(projectDir, sessionId)` (`cc/scripts/fray/config.mjs`). That gate is **opt-IN per
session**: it requires `.fray/` to exist AND a per-session sentinel at
`.fray/.session-state/<session_id>` containing `on` (written by `fray on` / the orchestrator fray
skill's Step 0). With no sentinel it returns **false** — the documented default:

```
// config.mjs frayActive(), final line:
return false; // DEFAULT: OPT-IN — dormant until this session runs `fray on`
```

A freshly-spawned fray-ui worker has a distinct `CLAUDE_CODE_SESSION_ID` and never runs `fray on`, so
cc's `frayActive()` is false for it → **all cc hooks are silent no-ops in the worker.** Meanwhile
cc-worker gates on the orthogonal `FRAY_UI_THREAD` env, so the two plugins key off different signals
and do not both activate. No double-hook by default.

**Residual risk:** if, inside a worker session, someone runs `fray on` or loads the orchestrator
`fray` skill (whose Step 0 runs `fray on`), cc's `frayActive()` flips true AND cc-worker is active →
both fire (you'd get orchestrator board nags inside a worker — wrong).

**Mitigation implemented (cheap + safe + reversible):** `session-seed.mjs` writes cc's OWN per-session
`off` sentinel for the worker's session id via cc's shared `setSessionOverride(dir, sid, 'off')` on
every worker SessionStart. `frayActive()` short-circuits to false on an `off` override
(`if (override === 'off') return false`), so cc is **guaranteed dormant** in a worker session even if
something later attempts to activate it — unless the human deliberately runs `fray on` afterward
(which overwrites the sentinel), the explicit "I want this session to orchestrate too" escape hatch.
This uses cc's own public API (identical to what `fray off` does), touches only gitignored runtime
state keyed on this worker's session id, and does NOT disable cc-worker (which gates on
`FRAY_UI_THREAD`, not the sentinel). It's the safest cheap option: it neutralizes the other plugin
without a UI-side plugin-disable flag (Claude Code has no per-invocation "disable plugin X" flag), and
the worker SKILL.md additionally tells the worker not to run `fray on` / load the orchestrator skill.

## plugin.json

`name: "fray"` (renamed from `fray-worker` on 2026-07-08 — see the follow-up note), `version: "0.1.2"`,
`license: "MIT"`. Hooks are auto-discovered from `hooks/hooks.json` (same as cc — plugin.json carries
no explicit hooks reference); every hook command is wired via `${CLAUDE_PLUGIN_ROOT}`.

## Claude settings-source isolation — deliberately deferred

The portable worker launch passes its per-session plugin with `--plugin-dir` on both spawn and
resume, and clears only `CLAUDE_CODE_SUBAGENT_MODEL` plus `CLAUDE_CODE_EFFORT_LEVEL`: those inherited
variables would silently defeat Fray's selected worker/profile. It deliberately does **not** replace
`HOME`, `CLAUDE_CONFIG_DIR`, or Claude's settings sources. Doing so would also change authentication,
user-approved permissions, MCP configuration, and global plugin behavior; that is a product-policy
decision, not an artifact-portability implementation detail. A future isolation policy must specify
which settings/auth surfaces are preserved before adding `--settings`, a config-home override, or a
global-plugin disable mechanism.

## 2026-07-02: Stop hook removed
stop-flush.mjs is no longer wired (script kept for reference). User call: under fray-ui the
tailer/board already surface worker state live, and the block-until-file-edited nag forced even
trivial workers into Read/Edit dances that render as noise in the chat UI. Thread-file discipline
remains a prompt-level contract (worker system prompt + SKILL), not a hook-enforced gate.

## 2026-07-08: Developer-experience port — doctrine, thread-type presets, dialectic
Goal: carry the old cc/ plugin's developer experience (minus the orchestrator machinery) into
fray-ui workers. What landed:
- **`skills/dialectic/SKILL.md`** — ported from `cc/skills/dialectic/` (self-contained dueling-
  sub-agents methodology; no board/reconcile dependency). Its model-tier references use this
  plugin's namespace (`fray:opus-high`, etc. — see the naming note below).
- **`skills/worker/SKILL.md`** — added two sections: "Choosing a helper's model + effort" (the
  full Haiku/Sonnet/Opus tiering doctrine + effort ladder + bias-to-Opus corollary, adapted from
  `cc/skills/fray/SKILL.md:218-234` for a worker dispatching its OWN helpers) and "Thread-type
  presets" (research / audit / implementation / planning — deliverable shape + "done" bar each,
  derived from that skill's `:92-150`/`:242-317`/`:463` framing). Also added a status-field
  discipline section (later split into `activity` + `status_text` — see the follow-up) and an
  "awaiting your OWN sub-agent is NOT blocked" clarification.
- **`ui/WORKER_PROMPT.md`** (fray-ui system prompt, not in this plugin) — carries the terse version
  of the same three: a "Status discipline" block, the model/effort doctrine in the Sub-agents
  section, and a "Thread types" section. This is the maintainer's explicit ask that the preset
  vocabulary ride in the SYSTEM prompt passed to every worker. No dispatch.ts change, so no fray-ui
  server restart is needed — `loadWorkerPrompt()` re-reads the file per dispatch and each spawned
  `claude` rescans this plugin dir fresh.

### Naming: subagent_type is `fray:<model>-<effort>` (plugin renamed to `fray` on 2026-07-08)
The plugin's manifest `name` (`.claude-plugin/plugin.json`) drives the subagent-type NAMESPACE, and
each agent file's frontmatter `name` drives the agent name — verified empirically with a throwaway
plugin (`name:"fray"` + agent `name:opus-high` → `fray:opus-high`); the plugin DIRECTORY name does
not matter. So the profiles dispatch as `fray:opus-high` / `fray:sonnet-medium` / `fray:haiku`, and
the skills as `fray:worker` + `fray:dialectic`. A BARE name (`opus-high`, `haiku`) does NOT resolve
— the Agent tool returns "Agent type '…' not found. Available agents: … fray:haiku …" — so every
doctrine/dialectic reference uses the `fray:`-prefixed form (confirmed end-to-end: `subagent_type:
fray:haiku` returns PONG). See the follow-up note below for why the name is `fray`, not `fray-worker`.

## 2026-07-08 (follow-up): status split, validation hook, `fray:` namespace rename
Three maintainer refinements landed on top of the port:

**1. `status_text` split into `activity` + `status_text`.** The single overloaded field became two:
`activity` = the form-constrained LIVE label the UI renders beside the spinner (single line, ≤100
chars, present-progressive gerund); `status_text` = the classic 1–2-sentence human gloss that also
doubles as THE ask on a human-`blocked` thread (queue cards headline it; no gerund constraint). The
gerund/≤100 discipline moved OFF `status_text` and ONTO `activity` in `ui/WORKER_PROMPT.md` +
`skills/worker/SKILL.md`. (UI-side `activity` plumbing/rendering — board JSON → ThreadView → listing
row — is a SIBLING agent's scope; not touched here beyond `ui/WORKER_PROMPT.md`.)

**2. New PostToolUse validation hook — `hooks/thread-frontmatter-validate.mjs`** (matcher
`Edit|Write|MultiEdit`, wired in `hooks/hooks.json`). Gated on FRAY_UI_THREAD + a top-level
`.fray/<slug>.md` path (dotfiles + `.findings/` sidecars skipped via the vendored `threadSlug`). On
every thread-file edit it re-reads + validates the frontmatter and, on a HARD violation, returns
`{"decision":"block","reason":…}` (PostToolUse block — the worker sees the quoted reason and
re-edits); soft issues warn via `systemMessage`; a clean edit is silent; ANY error fails OPEN
(exit 0). Rules (mirroring cc's board validator `index.mjs:302-335`): required `title`+`status`;
`status` ∈ the vocab (legacy aliases warn, not block); `activity` single-line/≤100/gerund-heuristic
(first word ends in "ing"); `blocked` ⇒ at most ONE of `blocking_threads`/`revalidate_at`, and
human-blocked (neither) ⇒ `status_text` required; `status_text` >240 chars warns. SELF-CONTAINED: it
VENDORS minimal copies of cc's frontmatter parser (`index.mjs:82`), path matcher
(`fray-thread-edit-steer.mjs:67`), and vocab (`config.mjs:291`/`:301`) — cc-worker must not import cc
at runtime. Verified: 10 direct unit cases (pass/block/warn/inert) + a real headless worker whose bad
Write was blocked with the exact quoted reason.

**3. Plugin renamed `fray-worker` → `fray`; worker skill renamed `fray-worker` → `worker`.** The
maintainer disliked the old worker-prefixed dispatch namespace. Renamed the manifest `name` to `fray` and the 16 agent
files + their frontmatter from `fray-<model>-<effort>` to `<model>-<effort>` (bare `haiku`), so
dispatches read `fray:opus-high` etc. Renamed the worker skill dir + frontmatter `fray-worker` →
`worker` (giving `fray:worker`, not the stutter `fray:fray-worker`). The plugin DIRECTORY stays
`cc-worker/` (dispatch.ts points at that path — unchanged, no server restart). Every reference in
`ui/WORKER_PROMPT.md`, both skills, the hooks, and this file was updated; a grep for the old prefix token is clean.

**Accepted name collision.** The old GLOBAL orchestrator plugin (`cc/`) is ALSO named `fray`. This is
accepted as harmless: `cc/` is disabled in `~/.claude/settings.json` (`"fray@fray": false`) and, even
when enabled, loads only in ORCHESTRATOR sessions (a different process class) — never in a fray-ui
worker, which loads ONLY this plugin via `--plugin-dir cc-worker`. Verified: the headless worker env
(same settings.json) registers a clean `fray:*` set with no `cc/` agents present. If a user ever
loaded BOTH plugins in one session, Claude Code would namespace-collide two `fray` plugins — but that
combination does not occur on the worker path.

## 2026-07-08 (campaign): `needs-human` first-class status + interactive-prompt deny hooks
Part of the board-wide redesign (owned jointly with the fray-ui UI half): `needs-human` becomes a
first-class fray status — the declared "awaiting a human" state and the queue's definition — while
`blocked` narrows to MACHINE-waits only. The vocab/parser/validator changes live in the shared cc/
scripts (`config.mjs` STATUS/STATUS_ALIASES + new `effectiveStatus()`, `index.mjs`, `decisions.mjs`,
`statusline-fray.mjs`, `thread-update.mjs`, `fray-reminder.mjs`) — consumed by fray-ui's readBoard
shell-out, so they take effect on the next board rebuild with NO server restart. cc-worker-side:

- **`hooks/thread-frontmatter-validate.mjs`** — vendored vocab bumped: `needs-human` is canonical,
  `needs-decision` aliases to it. New rules: a `needs-human` thread (incl. a legacy `blocked` with no
  machine field, which reads as needs-human via the inlined `effectiveStatus`) REQUIRES a
  `status_text` (hard BLOCK); a machine-`blocked` thread with no mechanism field is a WARN suggesting
  needs-human (not a block — legacy tolerance); >1 mechanism stays a block.
- **`skills/worker/SKILL.md` + `ui/WORKER_PROMPT.md` + `hooks/session-seed.mjs`** — the worker status
  guidance rewritten to the new contract: an ask OR a result needing review → `status: needs-human`
  with a `status_text` ask ("Review: …"); `blocked` is machine-only; `done` means NOTHING is left for
  the human (Mark-as-done is the human's acknowledgment — never jump straight to `done` when review
  is pending).
- **`hooks/deny-ask.mjs`** (existing, PreToolUse `AskUserQuestion`) — deny reason re-pointed at
  `--status needs-human`. `AskUserQuestion` is a real tool → cleanly deniable via PreToolUse; verified
  by piping the hook its exact payload (deny + reason) and confirming inert when FRAY_UI_THREAD unset.
- **`hooks/deny-plan.mjs`** (NEW, PermissionRequest `ExitPlanMode`) — denies the plan-approval prompt.
  MECHANISM (per the Claude Code hooks docs): `ExitPlanMode` is a PERMISSION surface, not a plain
  tool, so it is denied via a **PermissionRequest** hook (matcher exactly `ExitPlanMode`), NOT
  PreToolUse. The deny JSON is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":
  {"behavior":"deny"}}, "additionalContext":"<redirect>"}` — the instructive redirect rides
  **top-level `additionalContext`** (NOT `decision.message`), which Claude injects to the model as a
  plain-text system-reminder; exit 0 with the JSON on stdout (exit 2 makes Claude ignore it). CAVEAT:
  PermissionRequest hooks do NOT fire under `claude -p` (headless print mode), so the `-p` smoke test
  can't exercise it — but fray-ui workers run as INTERACTIVE tmux `claude` sessions, where they DO
  fire. Both deny hooks are FRAY_UI_THREAD-gated and fail-open. (`AskUserQuestion` was not surfaced as
  an invokable tool in the `-p` harness either, so both hooks were verified by piping their exact hook
  payloads rather than by driving a live prompt.)

### The `--settings` permission floor — BUILT, verified, then deliberately REMOVED (2026-07-08)
A `--settings` permission FLOOR was added to `ui/dispatch.ts` (`WORKER_DENY_SETTINGS =
{"permissions":{"deny":["AskUserQuestion","ExitPlanMode"]}}`, both command builders) and verified to
work: `claude -p --settings '{deny:[AskUserQuestion,ExitPlanMode,Bash]}'` → the model reports
`Bash: No` (control — a bare-name deny removes a normally-present tool from context), `Read/Write:
Yes`, `AskUserQuestion/ExitPlanMode: No`. It was then **removed on the maintainer's call**, and the
reasoning is worth keeping (it corrects the earlier "floor first, hooks failover" story):

- A bare-name deny removes the tool from the tool LIST, but a model **knows `AskUserQuestion` /
  `ExitPlanMode` from TRAINING** and can still attempt them. With the floor in place, that attempt
  hits a generic "no such tool" permission error — NOT the hook's instructive `needs-human` redirect
  (a permission `deny` is evaluated regardless of hook output and takes precedence, so the model sees
  the generic denial). So the floor can actually **prevent the tool-block education process**.
- Therefore: **hooks-only enforcement.** The deny HOOKS are themselves a hard deny AND they teach on
  contact (their `needs-human` redirect reaches the model — verified: deny-ask emits a PreToolUse
  `permissionDecisionReason`, deny-plan a PermissionRequest top-level `additionalContext`). The floor
  is gone; `dispatch.ts` + `server.test.ts` are reverted to clean.

### Plan-mode softlock fix (2026-07-08)
A worker in plan mode that calls `ExitPlanMode` would be denied by deny-plan — but plan mode ALSO
blocks file edits, so the redirect ("write the plan into your thread") is impossible to follow: a
softlock. The PermissionRequest hook input carries **no** permission-mode signal (session_id / cwd /
hook_event_name only), so deny-plan cannot detect plan mode to pass through. Fixed at the SOURCE
instead: `ui/dispatch.ts` `workerPermissionMode()` coerces `--permission-mode plan` → `auto` inside
BOTH command builders (so dispatch, adopt, AND resume never spawn a worker in plan mode). Workers plan
by writing the plan into the thread + `status: needs-human` (the contract), which has no plan-mode
requirement — so nothing is lost. deny-plan then denies `ExitPlanMode` UNCONDITIONALLY when gated:
for a real fray-ui worker (never in plan mode) that is always a spurious call → deny + redirect is
correct. RESIDUAL GAP (accepted, documented): the deny could softlock only a FOREIGN session that is
simultaneously in plan mode AND running with FRAY_UI_THREAD set AND this plugin loaded — a combination
fray-ui never produces. A normal plan-mode session outside fray-ui is untouched (deny-plan is inert
without FRAY_UI_THREAD). Follow-up for UI honesty: `web/src/lib/options.ts` still offers "plan" in the
dispatch permission-mode dropdown (coerced to `auto` at spawn) — the sibling can drop it there.

### Malformed-thread one-click repair — read-side recovery (2026-07-09)
INCIDENT: a worker that spawned before the frontmatter-validation write-hook existed wrote
`nub/.fray/sandbox-windows-backend.md` with its metadata in **bold prose** instead of YAML
frontmatter. The board banner correctly reported "sandbox-windows-backend.md: no YAML frontmatter",
but the thread was INVISIBLE to the queue/status system (the parser can't read its title/status →
`status: ?`) until the orchestrator hand-edited YAML. Maintainer directive: "make sure that doesn't
happen again."

TWO-SIDED DEFENSE:
- **Write-side (already existed):** the frontmatter-validation file-tool hook blocks a compliant
  worker from writing a thread `.md` with no frontmatter in the first place.
- **Read-side (this change):** RECOVERY for any straggler the write-hook can't catch — pre-hook
  files, hand edits, and (the residual, by design) **Bash-written files that bypass the file-tool
  hooks entirely**. The board now ships STRUCTURED, classified errors so the UI can offer one-click
  repair.

MECHANISM:
- `cc/scripts/fray/index.mjs` `--json` gains a parallel `errorItems: [{file, kind, message}]`
  (`kind: 'no-frontmatter'` = repairable, else `'other'`). The parser classifies — it knows exactly
  why it rejected the file. The legacy `errors: string[]` array is emitted UNCHANGED alongside it.
- `errorItems` flows through `readBoard`/`fray.ts` → `board.ts assemble()` → `BoardSnapshot` +
  `BoardMeta` (so the repair affordance survives a board delta, not just the keyframe) → the
  TodosView banner, which renders a **Repair** button per `no-frontmatter` item.
- `repairThread({file})` RPC (`repair.ts`) validates the file is a real `.md` DIRECTLY under `.fray/`
  (resolve + dirname===root guard; rejects `../`, `sub/`, absolute paths), refuses any file that
  already has a `---` block (repair is ONLY the missing-frontmatter case), then PREPENDS minimal
  frontmatter: `title` from the first `# H1` (else the filename slug), `status: active`, and a
  standing `status_text` flag that the status is unverified. Then a board rebuild.

CONSERVATIVE ON PURPOSE: repair NEVER infers status from prose. This morning's file said "DONE" in
bold — guessing wrong silently is worse than surfacing. `status: active` makes the thread visible;
if its agent is gone, the runtime crash-net cards it for human attention — the correct escalation.

RESIDUAL (accepted, documented): a Bash-written `.fray/*.md` bypasses the file-tool hooks by design,
so the write-side can't prevent it — the read-side repair is the safety net that heals it in one
click.

## 2026-07-09: v2 worker contract — the session-first rebuild (fences + scratchpad; thread-file contract DELETED)
The maintainer settled fray-ui on a SESSION-FIRST model: threads ARE claude sessions and the human's
dashboard shows the session TRANSCRIPT. Queue membership is explicit: `question` hands off to the
human, `done` queues a checked completion, process-level blocks surface themselves, `awaiting`
excuses a machine wait, and bare rest stays quiet. The entire `.fray/<slug>.md` ownership contract is
GONE: no thread files, no frontmatter, no `status`/`activity`/`status_text`, no `needs-human`, no
`blocked` machine fields, no `hasPlan`/`## Plan`, no `fray-update`. Workers now SIGNAL through their
FINAL MESSAGE and PERSIST through a SCRATCHPAD. This is the cc-worker-side realignment.

**The new signal model (taught in `ui/WORKER_PROMPT.md` §"End-of-turn signals" + `skills/worker/SKILL.md`):**
- **Bare rest is quiet** — a rested thread with no fence does NOT enter Needs-you and is not a human
  handoff. Human handoff is explicit via `question` (or a real process-level block).
- **` ```done `** — work complete + stands; body = 1–4 lines of what shipped + where. Renders a
  checked success card in the queue until explicit Archive; the fence MUTATES NOTHING
  (maintainer-settled), and a follow-up may still wake the worker.
- **` ```awaiting `** — waiting on a MACHINE (CI/PR/timer/session); body may lead with `kind: value`
  hint lines, kind ∈ pr|ci|timer|session. NEVER for a human wait.
- **` ```question `** — unchanged grammar (question / approval / multi / danger; trailing `- A. …`
  options + `Recommendation:`), now the ONLY handback-for-input; no status flip accompanies it.
- CONSISTENCY: the taught grammar matches the shared parser (`ui/packages/shared/src/index.ts`
  `ThreadFence` kind ∈ done|awaiting, `AwaitingHint` kind ∈ pr|ci|timer|session). Opening line is
  exactly ` ```done `/` ```awaiting ` (nothing after the language word); exactly one fence, at the end.

**The scratchpad (`.fray/threads/<session-id>/scratch.md`) — new §"Scratchpad" in both docs:** free-form
markdown, NO schema, NO validation. It is the worker's compaction-proof working memory (survive-
compaction to-do lists / work queues / Ralph-style epic checklists live here, not in ephemeral
context) AND the shared blackboard for parallel sub-agents (shared state is written into it; its PATH
is passed into every sub-agent prompt; helpers READ it, the worker folds their results back in). The
path is server-established convention already wired through `shared` (`scratchpadPath`), `router.ts`
(reads `.fray/threads/<session_id>/scratch.md`), and `dispatch.ts`.

**Hooks changed:**
- **DELETED `hooks/thread-frontmatter-validate.mjs`** + its `hooks.json` PostToolUse `Edit|Write|
  MultiEdit` entry. It validated thread-file frontmatter (status vocab / gerund `activity` / machine
  fields) — a contract that no longer exists. Nothing left to validate on file edits.
- **DELETED `hooks/stop-flush.mjs`** (already UNWIRED since the 2026-07-02 Stop-hook removal; kept
  "for reference" then). Its sole job was nudging the worker to flush state into its thread FILE —
  dead with the thread-file contract gone. No `hooks.json` entry to remove (it was never re-wired).
- **`hooks/session-seed.mjs`** — reseeded to the v2 contract: signal via the final message (bare rest
  is quiet; done queues checked completion; awaiting excuses a machine wait; question asks) + the
  scratchpad, whose concrete path is derived from
  the SessionStart `session_id` (`currentSessionId(input.session_id)` → `.fray/threads/<sid>/scratch.md`) and
  named in the seed. FRAY_UI_THREAD gating + the cc double-hook `off`-sentinel defense KEPT verbatim;
  the compact re-grounding now points at the scratchpad, not a thread file.
- **`hooks/agent-dispatch.mjs`** — epilogue no longer says "don't edit `.fray/` thread files or
  config.yml"; now "don't edit the dispatcher's scratchpad (`.fray/threads/<session-id>/scratch.md`) — READ it for shared
  context if its path is in your prompt, report in your FINAL MESSAGE." Background/name-strip
  enforcement unchanged.
- **`hooks/deny-ask.mjs`** — redirect retargeted off `fray-update … --status needs-human`: now "ask
  in your FINAL MESSAGE with ```question blocks, then rest; a question IS the handback (no extra
  fence)." Still PreToolUse(AskUserQuestion), FRAY_UI_THREAD-gated, fail-open.
- **`hooks/deny-plan.mjs`** — redirect retargeted off "write the plan into your thread `.fray/<slug>.md`
  + status: needs-human": now "write the plan into `.fray/plans/<topic>.md` and/or the scratchpad;
  ask via a ```question approval block." PermissionRequest(ExitPlanMode) mechanism + the plan-mode
  softlock reasoning (dispatch.ts coerces plan→auto) unchanged.
- **`hooks/agent-bind.mjs`** — UNCHANGED (functionally). It records `agentId → thread` into
  `.fray/.agent-bindings.jsonl` from a helper's `THREAD: <slug>` tag; that tag still rides the
  per-thread dispatch and references no dead status/frontmatter contract. NOTE for the server/tailer
  verticals: session-first sub-agent liveness is now TAILER-derived (`ThreadView.subAgents`), so the
  `.agent-bindings.jsonl` binding this hook writes may be VESTIGIAL. Left in place (harmless,
  fail-open, out of this vertical's delete scope) — a candidate for removal once the tailer path is
  confirmed to fully supersede board-side `bindingsByThread`.

**`skills/worker/SKILL.md`** — rewritten to the same pillars (version 0.2.0): the signal model
replaces the status-vocabulary sections; a scratchpad section replaces the "own ONE thread file"
sections; thread-type presets keep the research/audit/implementation/planning taxonomy but strip
every status reference (planning now delivers a `.fray/plans/<topic>.md` artifact). The sub-agents
section adds "pass the scratchpad path into helper prompts." `skills/dialectic` untouched.

**`plugin.json`** description updated: no more "validate thread-file frontmatter"; now fence signals
+ scratchpad blackboard + sub-agent profiles + deny-ask/deny-plan.

**What the server/web verticals must know:** (a) FRAY_UI_THREAD must keep being passed at spawn — every
hook still gates on it. (b) The scratchpad path convention is `.fray/threads/<session-id>/scratch.md` where
`<session-id>` is the pinned `--session-id` (the same id the SessionStart hook sees as `session_id`);
the seed hook NAMES that concrete path to the worker, so dispatch must keep pinning `--session-id`.
(c) `ui/packages/server/src/dispatch.ts` `composePrompt()` STILL emits the dead per-thread contract
("You own `.fray/<slug>.md` … set `status: blocked` … Set `status: done`") — that is server-vertical
scope (not editable here), but it now CONTRADICTS the v2 WORKER_PROMPT and must be rewritten to the
fence/scratchpad model (or dropped) by the dispatch owner. Flagged to server-core.

## 2026-07-12: awaiting reversal — park only human/timestamp gates; keep automation active

The v2 rule above made `awaiting` a broad machine-wait bucket. In practice workers emitted a fence
for CI, bots, releases, and merge progression, then returned with no process actually owning the
next transition. The rail's hourglass therefore implied a watcher that often did not exist. The
contract is now narrower:

- `awaiting` is a deliberate PARK for either `human: <actor + exact external review/approval>` or
  `timer: <ISO-8601 instant>`. The dashboard operator's own decision remains `question`.
- CI, automated review, releases/deploys, merge queues, and already-authorized merge progression
  stay ACTIVE. Claude workers use a background `Bash` one-shot or `Monitor`; Codex workers keep a
  blocking exec session alive and poll it. Their completion/event re-invokes the worker.
- `pr:` / `ci:` / `session:` continue to parse so old transcripts do not break. The existing PR/CI
  waker remains a compatibility bridge, but workers must not create new waits with those hints.
  `timer:` remains the durable scheduler path across process/session restart. `human:` is descriptive
  and intentionally not auto-fired.
- Every follow-up clears the old fence. “Back to awaiting” requires a fresh check: re-emit a current
  human/timer fence, or re-arm automation and remain active.

Claude Code 2.1.207 was audited before teaching this. fray-ui does not pass `--tools`,
`--allowedTools`, or `--disallowedTools`, and its helper profiles only select model/effort, so wait
tools are available to top-level workers and helpers. `Monitor` defaults to 300,000 ms (maximum
3,600,000 ms); `persistent:true` runs until `TaskStop` or session end. Background Bash reports an
output path; `TaskOutput` exists but is deprecated, so workers should `Read` that path for diagnostics.
Both Monitor and background Bash are session/process-bound, which is why durable wall-clock checks
remain `timer:` fences. Helpers must not return a final handoff while they still own a live watcher;
the top-level worker owns long-lived CI/PR/merge progression.

## 2026-07-13: ordinary rest returns to Queue; human Snooze/Archive own triage

The quiet-bare-rest rule above was reversed after live use showed that an owned Fray worker could
come to rest without choosing a fence and disappear from the only surface the operator routinely
triages. Queue membership is now server-derived from process rest, not dependent on perfect worker
signaling:

- Every owned, open session whose top-level turn is genuinely at rest enters Queue by default.
- A live child/Monitor still counts as in-flight work. A truthful external-human or future-timer
  `awaiting` fence remains dimmed in Held. Legacy CI/PR/session and hintless waits do not excuse rest.
- A human may durably Snooze an ordinary handoff (default one day, presets/custom exact instant) or
  Archive it. Due snoozes automatically re-enter Queue; Archive never does.
- Questions, permissions/native approvals, typed interactions, and crashes break through Snooze so a
  provider cannot be stranded behind an invisible hard gate. `done` remains the checked presentation,
  but it is still a resting handoff and can be snoozed.

The worker contract still teaches explicit `question`, `done`, and narrow `awaiting` fences because
they improve priority and presentation. A fence is no longer required merely to make a rested worker
discoverable.

## 2026-07-12: runtime release gate — real CDP evidence plus independent review

Major UI, server, and control-plane work may no longer reach `done` from unit/integration/mocked
evidence alone. The canonical `ui/WORKER_PROMPT.md` contract now requires real Chrome CDP QA against
a disposable full stack, relevant active/idle/error/restart coverage, desktop+narrow screenshots,
console/network inspection, and an explicit correctness+aesthetics assessment. Chrome DevTools MCP is
preferred when it is available to the current provider; `agent-browser` or the repository Puppeteer
harness are explicit fallbacks. Mocked DOM/routes can supplement but cannot be the sole evidence.

Completion also requires two distinct review passes: the implementer's self-review of diff+evidence,
then an independent fresh-context adversarial review; confirmed findings are fixed and affected gates
rerun. The exception is proportional and narrow: trivial non-runtime docs-only or provably mechanical
changes may skip CDP/independent review, while uncertainty applies the gate. This rule is mirrored in
`skills/worker/SKILL.md` (v0.2.2) and the SessionStart seed; the backend-aware prompt contract test pins
all four delivered surfaces, and the Claude expansion golden changes intentionally. The Codex addendum
no longer mislabels an author's inline second read as independent review: use delegation when available,
or report the gate unmet.
