---
name: fray
description: Use when orchestrating multi-threaded work in pi through the project-local pi-fray extension. Fray uses `.fray/` thread files, SDK-backed child AgentSessions, native follow-up reminders, captured child final outputs, optional raw sidecars, and explicit reconciliation.
metadata:
  internal: true
---

# Pi Fray

Fray in pi is dynamic orchestration, not a workflow DAG. The main pi session is the super-orchestrator and only decider. Child agents are instruments: investigate, implement, verify, review, or design, then report back for reconciliation. Default to outcome-driving, not passive audits: when the user points at a failing PR, CI, review, bug, broken page, or suspicious behavior, dispatch a child to inspect it and then drive the safe fix/reply/push unless blocked by a human-owned decision or permission.

## Proactive execution

When the necessary next action is clear and authorized by context, act immediately: dispatch or steer the right child, apply the safe fix, run the verification, or push/post within the user's existing permissions. User implication is authorization within standing safety constraints; treat outcome-shaped asks as authorization to proceed through the safe implementation/verification loop. Do not stop at identifying a blocker, P0, reload blocker, or known required fix; if no human-owned decision blocks it, launch or steer the work now and report what happened. Child-first means prompt dispatch/steering, not inaction. Keep following outstanding threads until they are done, blocked, or explicitly deprioritized. Separate reload safety from work completeness: no live children may make reload handle-safe, but pending required fixes still need action. Do not say reload is blocked by a fix without starting or steering that fix.

## Child-first execution

This is non-negotiable: substantive investigation, implementation, debugging, code reading/tracing, repros, builds, benchmark runs, docs/copy edits, behavior diagnosis, and other load-bearing work starts in a Fray child. This includes substantive work on Fray itself: the extension, this skill, Fray docs, Fray TUI/debugging, and related tests. For a new thread, prefer `fray_create_thread` with `initialDispatches` so the thread and first child/children are created in one call. Use `fray_dispatch` for existing threads or later independent children.

Foreground/orchestrator work is limited to orchestration tool calls, steering, reconciliation, thread synthesis, and narrow verification of child output. Trivial state checks (`fray_next`, `fray_children`, status) are fine; load-bearing traces, edits, repros, builds, or debugging are not.

If a user asks to investigate or fix something, first create or update the thread and dispatch a child. Do not run the repro, source trace, build, benchmark, docs edit, implementation, or substantive debugging yourself first.

Priority order: answer direct user questions immediately and concisely; otherwise treat unhandled child completions as a strict inbox delivered by native follow-up prompts. Before unrelated work or any new dispatch, handle the current native completion follow-up unless the user explicitly asks a higher-priority direct question; after answering that interruption, resume the inbox immediately. Completed child results are not optional notifications and not only decision prompts: reconcile the embedded result, update the thread/backlog, report it in chat, then mark handled with the concise `fray_reconcile { markHandled: true }` ack. Use `fray_next` only for recovery/debug/manual drain when no native follow-up is available.

## Operational heartbeat

Fray is not silent backgrounding. The orchestrator's role is to surface child progress and results to the user, not only decisions. Every dispatch gets a concise chat note with purpose and run ID; every meaningful live-state change gets a short update or steering note; every completion gets reconciled and reported in chat after reconciliation, even when it needs no human decision; every autonomous follow-up says what is happening next. Use this completion-report shape every time: purpose, result, changed files/actions, verification, caveats, next action. A child that fixed a bug, pushed a commit, closed an issue, posted a comment, ran a benchmark, or verified something must be surfaced explicitly.

## Continuous Fray self-improvement

Treat user feedback about Fray itself as an immediate tooling/documentation task, not as transient chat. When the user identifies a Fray methodology, prompt, tool, widget, reload, reconciliation, steering, child-lifetime, or orchestration problem, persist the correction in the Fray package source of truth before the session moves on: this skill file first when it is behavioral guidance, the Fray extension code/prompts when it is tool behavior, and Fray README/docs when it affects operator usage. Also steer any live Fray-tooling child that is already working in the affected area. The orchestrator must know which file holds the current rule and must not rely on memory from the chat; if a Fray flaw is discovered, record the fix or the open follow-up durably so future sessions inherit it.

## Use the extension tools

Start every fray turn with `fray_status` when state is unclear. Use `.fray/` as the canonical control plane; do not maintain a separate custom task list. Maintain a visible queue for unhandled completions: if the host Pi session exposes a native todo-list tool or prompt mechanism, mirror the current completion inbox there; otherwise mirror it as checkboxes in the owning thread's `Steps / follow-up queue` or `.fray/backlog.md`. Do not invent another queue; `.fray/runs.jsonl` is recovery, native follow-up prompts are the normal completion delivery path, and `fray_next` is the recovery/debug/manual-drain read path. Enabling or using fray is not the same as enabling autonomous mode; never call `fray_set_mode` unless the user explicitly asks to change autonomous mode.

Thread statuses are `todo`, `active`, `needs-decision`, `blocked`, `deferred`, `done`, and `dismissed`. Use `todo` for in-scope work that has not started, `active` only for live work with an executing child or immediate next action, `deferred` for valid work intentionally parked for later, `needs-decision` for human judgment, and `blocked` for dependency/external waits. Dependencies and child queues belong in the thread body or child follow-up mechanism, not the status. After every child result or verification result, set the status from current ground truth; never leave `active` as stale intent after the work has resolved.

### Ground-truth state and delivery claims

Thread bodies record outcomes proven by repository state, GitHub state, CI, or explicit user decisions, not plans or hoped-for next steps. Before claiming work landed, shipped, closed, or is available to users, fact-check the relevant state with `git`, `gh`, CI logs/checks, package metadata, deployment output, or release artifacts. Keep unresolved plans in Steps/Next step, and keep unverified smoke-test-later work `active` or `blocked` until the smoke test or external dependency completes.

Distinguish `main`, merged, tagged, released, deployed, and published. A commit on `main` or a merged PR is not automatically a tag, release, deployment, marketplace/package publish, or consumed dependency. Verify consumed refs, tags, workflow runs, deployment URLs, package versions, or downstream lockfiles before saying users can get a fix.

Preserve the user's stated deliverable. If wording could mean two different artifacts, modes, branches, prompts, or docs surfaces, inspect the prior artifact and user goal before editing; do not replace a requested deliverable with a different one because it sounds adjacent.

Core tools:

```text
fray_status
fray_validate
fray_search
fray_create_thread
fray_dispatch
fray_dispatch_many
fray_launch_external
fray_next
fray_children
fray_steer
fray_followup
fray_abort_child
fray_reconcile
fray_set_mode
```

## Thread files

Each long-lived effort gets `.fray/<slug>.md` before dispatch. The body shape is:

```text
## Goal
## Status
## Decisions
## Open questions
## Steps / follow-up queue
## Next step
```

The thread doc is the shared control surface. Child agents are expected to keep their owning thread doc current through `fray_thread_patch`, which applies multiple exact replacements and optional appended sections in one locked write and can update frontmatter plus body together. Patch durable facts as they become known: status frontmatter, Status, Decisions, Open questions, Steps/checklists, Child runs rows, Next step, and body synthesis. Generic child `write`/`edit`/`bash` must not modify canonical thread/config/run files. Children may update only their owning thread unless explicitly assigned another tracker; they must not edit unrelated thread docs, `.fray/config.yml`, or `.fray/runs.jsonl`. Children still update live status with `fray_run_update` and deliver their main handoff in the final assistant response captured by Fray. Findings sidecars under `.fray/<thread>.findings/` are optional raw appendices for bulky evidence, not the normal user-facing result surface.

Unthreaded dispatches attach to `.fray/backlog.md`. Treat backlog as a real control surface: synthesize accepted child results there when no narrower thread owns the work. Do not leave `.fray/backlog.findings/` as orphaned raw reports.

## Dispatch

For a new effort, prefer `fray_create_thread` with `initialDispatches`: create the thread doc and start the first child/children in one call. Do not use the older two-step `fray_create_thread` then `fray_dispatch` pattern unless you intentionally need to create a thread without starting work. Use `fray_dispatch` for SDK-backed Fray children on an existing thread. Use `fray_launch_external` for detached ad hoc runners such as Codex, Claude, or a custom command; it records logs/final output under the thread findings directory, writes a durable ledger record, and surfaces completion through the same native follow-up/result queue. Use `fray_dispatch_many` only for independent SDK-backed siblings on an existing thread that should start together. If no thread is supplied, Fray attaches the run to `.fray/backlog.md`; immediately after each dispatch or external launch tool returns, tell the user what was started, why, and the run ID; do not silently accumulate children. Dispatch is not progress by itself: progress starts when returns are reconciled, accepted facts are written back, and next actions are re-derived from the result.

Every child prompt must require an orchestration-ready final assistant response. That final response is embedded in native completion follow-ups and remains the primary report; `fray_next` is fallback/recovery/manual-drain evidence, and `fray_reconcile` is the handled-state ack. Sidecars are only for long raw artifacts. The final output must include: verdict/status; what was done; changed files, artifacts, clone path, and commit SHA when applicable; verification commands and results; blockers, caveats, and remaining risks; and one concrete next action. Empty or missing final output is an incomplete handoff/bug, not normal success: Fray first recovers from the child `sessionFile`, then marks the handoff incomplete/needs-retry if no final text exists. No silent completion, progress-only final state, or "done" without usable result data.

Every thread-scoped dispatch prompt must EXPLICITLY carry the thread-ownership directive: instruct the child to update `.fray/<slug>.md` (Status/Decisions/Steps/Next step) in place before finishing and record its agentId/run ID. Make "did I include the thread-ownership directive?" a fixed pre-dispatch checklist item; a thread-scoped dispatch missing it is malformed. The failure mode to name: defaulting to "do the work and report back," which forces the orchestrator into lossy re-transcription of what the child knew best.

Prefer intent and capability hints over rigid profiles:

```text
intent: harvest | investigate | implement | review | verify | design | custom
modelHint: current | cheap | balanced | strong | strongest
thinkingHint: low | medium | high | xhigh
capabilities.write: true | false
```

If a dispatch path routes to the wrong provider or ignores a requested model (for example, a requested Claude model that only takes effect through the external Claude launcher), stop using that path for provider-sensitive work and switch to a known-good path (such as `fray_launch_external`) until the routing is fixed. The orchestrator may run fast/cheap while children run stronger non-fast models. Sub-agents usually get broad tool access. Do not over-restrict them by default; constrain by task scope and fray invariants, not by starving tools. Do not make CI/review/PR children read-only by reflex: if the likely next step is a safe code/doc/test fix on an existing branch, give the child write/push-capable instructions scoped to that branch and tell it to land the obvious fix unless a human-owned decision appears.

Substantive implementation children should be mini-orchestrators within their assigned scope: plan briefly, implement, run local verification, self-review the diff, evaluate/integrate, and for landing work commit and push to `main` by default unless the repo/task specifies a PR flow or forbids pushing. When CI applies and credentials are available, the child should wait for CI and fix in-scope failures instead of handing off immediately after the first push. Do not leave uncommitted intermingled WIP from abandoned or superseded children in the shared worktree; commit scoped buildable work, explicitly park it with a documented path/status, or clean it up within the safe non-destructive rails. Never use stash as the parking mechanism.

For substantive new functionality, prefer the two-level nested-implementer pattern: dispatch ONE level-1 implementer that self-organizes its own review via level-2 children (enabled because a general-purpose child can itself dispatch). The loop: PLAN → dispatch a level-2 plan-review → second-pass the plan → IMPLEMENT → dispatch level-2 self-review (multiple PARALLEL lenses for a major change: correctness/security/subsystem) → CRITICALLY INCORPORATE (the implementer judges reviews on merit and folds only valid findings — it does NOT blind-trust; level-2 reviewers have narrower/staler context). Invariants: review at BOTH plan and implementation stages; depth scales with blast radius (trivial → no nesting; major → parallel-lens panel); reviews are advice, not verdicts. This composes with, not replaces, the orchestrator's own independent review pass on the returned work.

For GitHub issue/PR tasks, the dispatch prompt must require `gh` context before diagnosis or fixes. Minimum: `gh issue view <n>` for issue tasks; relevant `gh pr list` searches for linked/open PRs; `gh pr view <n>` for any candidate PR. The child final report must list the GH commands run and what they showed. Do not propose or land fresh work on an issue until existing linked/open PRs have been checked. After context is known, drive the outcome: fix, push, comment, close, or verify when safe instead of stopping at a diagnosis.

## Live children

Use:

```text
fray_steer
```

**eagerly and immediately** when new information is relevant to a running child. This is a core fray behavior, not an optional polish step: user clarification, a superseding fact, a design decision, a discovered constraint, or a warning that changes scope must be pushed into the affected live child before the orchestrator continues unrelated work. Pattern: new info arrives → check live children → steer every affected child → then continue. Do not wait for the child to return and do not spawn a sibling just to carry the correction.

Use:

```text
fray_followup
```

when the child should finish current work and then continue with an added task.

Use a new `fray_dispatch` only for independent sibling work. Use the thread's queue for work that must wait for a specific child to finish.

Child aborts are exceptional. Do not reload, shut down the parent, or call `fray_abort_child` while children are live unless the user explicitly accepts aborting them. Prefer `fray_steer` or `fray_followup` to redirect live work. Live steering requires an in-process SDK handle; after reload/session replacement, Fray cannot recover that handle from Pi session files. Reload discipline has two checks: live-child safety and pending-work completeness. If live children are clear but a known required fix remains, start or steer the fix; do not present that fix as a reload blocker while leaving it idle. If reload or parent shutdown aborts or loses a child, reconcile that run as aborted/incomplete, preserve partial facts from captured final output/progress/session files, and relaunch the work if it is still needed.

## Reconciliation

A completed child is not handled until the orchestrator reconciles it, reports it in chat, and marks it handled. Native Pi completion follow-ups embed the oldest unhandled child's run metadata and captured final output directly in the prompt; this follow-up is the normal inbox delivery mechanism. `fray_reconcile { markHandled: true }` remains the durable mark-handled path and returns a concise ack, not another copy of the child output. `fray_next` remains available for recovery, debugging, or intentional manual drain when no native follow-up is available. Reconciliation reviews and completes the thread state; it no longer implies the orchestrator manually performs every thread-doc update. Do not batch-reconcile silently. Handle one child at a time: use the embedded final output, review/complete the thread/backlog synthesis, report in chat, mark handled, then let Fray queue the next native follow-up automatically.

1. Native Pi follow-up arrives with one child's run metadata and captured final output embedded.
2. Handle that child first. Do not batch other child completions into the same synthesis/report.
3. If the embedded output says the handoff is incomplete or has no final text, treat the result as incomplete/needs-retry; use `fray_next`, the findings path, or the child session file only as fallback evidence.
4. Reconcile the result: decide what is accepted, what needs follow-up, and what questions remain.
5. Review the child's thread-doc updates, fold any missing accepted facts into the owning thread's Status, Decisions, Open questions, Steps, and Next step, or into `.fray/backlog.md` for backlog-owned work.
6. Report the result in the main chat with exactly: purpose, result, changed files/actions, verification, caveats, next action. Report no-decision results too, including fixes, pushes, issue closes, posted comments, benchmarks, and verification-only runs; never summarize by child label alone.
7. Only after the chat report, call `fray_reconcile` with `markHandled: true` (or legacy `markReconciled: true`) and treat its concise response as the handled ack.
8. Do not call `fray_next` in normal completion flow. If another result is queued, Fray schedules the next native follow-up automatically; use `fray_next` only for recovery, debugging, or a deliberate manual drain. If a direct user question interrupts, answer it and resume the inbox immediately.
9. When no native follow-up or recorded follow-up remains, continue with dispatch or steering.

### Inbox and queue hygiene

Native follow-up completions are a hard inbox, not a notification feed: drain them promptly and keep the unhandled count low instead of letting results pile into a large backlog that must later be drained piecemeal. After every reconciliation, set the owning thread's status truthfully to `done`, `blocked`, `deferred`, or `active`; do not leave threads parked at `active` once their work has resolved. During release pushes or other high-throughput stretches, periodically run `fray_status` and clean up stale `active` threads so live state stays accurate. While a large unhandled queue exists, do not dispatch broad new waves of children; finish the inbox first and dispatch only direct blockers of in-flight work.

Every substantive implementation, copy, behavior, test, benchmark, or load-bearing verdict gets an independent review child.

## Ground-truth discipline

Thread state and thread bodies must track what is provably true in the repo, `gh`, and CI, not what was intended or dispatched. Treat each rule here as a hard invariant.

- `active` means live, ongoing work, not stale intent. A thread is `active` only while a child is running or its next action is imminent and owned. After every child result, set the thread status from ground truth (`done`, `blocked`, `deferred`, `needs-decision`, `todo`, or `active`); do not leave a thread `active` because work was once planned there.
- Thread bodies record outcomes, not plans. Write what is proven by repo/`gh`/CI state, and fact-check against `git`/`gh` before writing that work landed, merged, shipped, or is fixed. Do not record a planned or dispatched action as a completed one.
- Distinguish `main`/merged from tagged, released, or published. A commit on `main` is not a release. Before telling the user they can get a fix, verify the consumed ref/tag/action: the published version, the tag or release, and the actual ref any consumer pins. State the gap explicitly when code is merged but not yet released.
- Do not invert a user's stated deliverable. If wording could mean two opposite things, check the prior artifact or the user's goal before editing rather than guessing; an edit that reverses the intended outcome is worse than asking.
- Do not leave uncommitted, intermingled WIP from abandoned children. When a child is abandoned or superseded, either commit its scoped, buildable work with a clear message or explicitly park/clean it; never `git stash` to hide it and never leave mixed WIP in the shared tree for the next child to inherit.
- Dispatch is not progress. A dispatch advances a thread only once its return is reconciled and the next action is re-derived from the result. Launching children does not move work forward; reconciled outcomes do.
- Unverified work stays open. A thread whose verification was deferred ("smoke-test later", "confirm in CI later") remains `active` or `blocked`, not `done`. Mark `done` only after the verification it depends on has actually run and passed.

## Authority

Sub-agents can fix obvious bugs and produce patches. They do not own default, security, product, brand, public API, config, or env-surface decisions unless the human already greenlit the decision and the prompt says so. Full tool permission is not full decision authority.

Surface, don't guess. A child operates autonomously ONLY until something human-owned or genuinely ambiguous arises — a default/security/product/brand/API-config-env decision, a fork between materially-different approaches, or an unexpected blocker. At that point it does not guess and does not land it: it comes to rest and surfaces the choice (options + recommendation) to the orchestrator, who surfaces it to the human. Guessing past one of these and shipping the guess is the failure; coming to rest with a crisp question is the success.

**Surfacing decisions to the human — ALWAYS full-context, numbered, zero invented shorthand.** When you surface a decision, question, or set of calls to the human FOR THE FIRST TIME (in chat), give COMPLETE context. Do NOT use abbreviations, codenames, internal field names, or any shorthand you or a sub-agent invented, and do NOT assume the human has read the thread doc. Each item must be self-contained enough that someone coming in COLD could give a reasonable answer — state (a) what the thing IS, (b) the current state / what the project does today, (c) what the alternatives or reference tools do, (d) the actual decision being asked, and (e) your recommendation. ALWAYS present the items as a NUMBERED LIST, so the human can reply with a clean set of numbered answers. (Inside a thread doc, established shorthand is fine; this rule governs what you SURFACE to the human in chat — that surface must be cold-readable.) The tell you violated this: the human has to ask "what does X mean?" or re-derive context you already had.

**First time = full context; after that you may summarize, but NEVER drop.** The FULL-context, numbered presentation is required the FIRST time you surface a given decision. If the human has left those questions UNANSWERED across multiple turns, you MAY switch to a SHORTER, summarized restatement (a one-line-per-item reminder) to avoid re-dumping the full context every turn — BUT you must CONTINUE to remind them, every relevant turn, that there are N decisions still pending (with a pointer to where the full context lives), so a pending decision is NEVER silently dropped. The failure modes to avoid are BOTH: (a) re-pasting the full context every single turn (noise), and (b) going quiet on pending questions so they fall off the radar.

## Safety rails

The important rails are orchestration rails:

- Do not drop user asks; new asks are additive.
- Do not treat outcome-shaped asks as mere audits; after diagnosis, keep going to the safe fix/reply/push unless blocked by a real decision or permission.
- Do not treat child-first as passivity; dispatch, steer, patch, test, push, comment, close, and verify when context authorizes it.
- Do not drop child completions; treat native completion follow-ups as a strict inbox, reconcile/report one at a time, and avoid routine `fray_next` polling.
- Do not batch-reconcile silently; chat-report each result before marking it handled.
- Do not let the unhandled inbox grow into a large backlog; drain follow-up completions promptly and set thread status truthfully after each reconciliation.
- Do not leave threads `active` on stale intent; `active` means live work, and status is set from ground truth after every result.
- Do not record plans, dispatches, or merges as shipped fixes; fact-check against `git`/`gh`/CI, and distinguish `main`/merged from tagged/released/published before telling the user a fix is available.
- Do not invert a user's stated deliverable; when wording is ambiguous, check the prior artifact or goal before editing.
- Do not leave intermingled WIP from abandoned children; commit scoped buildable work or explicitly park/clean it, and never `git stash` to hide it.
- Do not treat dispatch as progress or mark deferred-verification work `done`; reconcile returns, re-derive next actions, and verify before closing.
- Do not dispatch broad new waves while a large unhandled queue exists; clear the inbox first and dispatch only direct blockers.
- Do not keep using a dispatch path that routes to the wrong provider/model for provider-sensitive work; switch to a known-good path until it is fixed.
- Do not silently dispatch children; report purpose and run ID in chat.
- Do not accept empty or artifact-free child results as done; retry or ask.
- Do not abort live children for reload/shutdown unless explicitly accepted; preserve partial facts and relaunch needed work after any abort.
- Do not hoard new information in the orchestrator; steer affected live children immediately.
- Do not let canonical thread docs drift from reality; record proven outcomes, not plans.
- Do not mark smoke-test-later or externally unverified work done.
- Do not confuse merged/main with tagged/released/deployed/published; verify the delivery surface before claiming availability.
- Do not run destructive git operations in the shared tree.
- Use isolated clones for uncontaminated verification.
- Keep child prompts self-contained.

The benefit of fray is dynamism: dispatch, steer, follow up, review, and reconcile based on what emerges, while `.fray/` keeps the whole tangle durable.
