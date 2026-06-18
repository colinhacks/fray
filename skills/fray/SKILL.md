---
name: fray
description: Use when orchestrating multi-threaded work in pi through the project-local pi-fray extension. Fray uses `.fray/` thread files, SDK-backed child AgentSessions, live steering/follow-up tools, child findings sidecars, and explicit reconciliation.
metadata:
  internal: true
---

# Pi Fray

Fray in pi is dynamic orchestration, not a workflow DAG. The main pi session is the super-orchestrator and only decider. Child agents are instruments: investigate, implement, verify, review, or design, then report back for reconciliation. Default to outcome-driving, not passive audits: when the user points at a failing PR, CI, review, bug, broken page, or suspicious behavior, dispatch a child to inspect it and then drive the safe fix/reply/push unless blocked by a human-owned decision or permission.

## Child-first execution

This is non-negotiable: substantive investigation, implementation, debugging, code reading/tracing, repros, builds, benchmark runs, docs/copy edits, behavior diagnosis, and other load-bearing work starts in a Fray child. For a new thread, prefer `fray_create_thread` with `initialDispatches` so the thread and first child/children are created in one call. Use `fray_dispatch` for existing threads or later independent children.

The foreground orchestrator owns coordination, decisions, steering, reconciliation, thread synthesis, and small verification. Foreground work is limited to trivial state checks (`fray_next`, `fray_children`, status), steering/reconciliation, thread updates, thread synthesis, and narrow verification of child output.

If a user asks to investigate or fix something, first create or update the thread and dispatch a child. Do not run the repro, source trace, build, benchmark, docs edit, implementation, or substantive debugging yourself first.

Priority order: answer direct user questions immediately and concisely before background orchestration; reconcile and summarize completed child results; then continue dispatch/steering. Child-result summaries in main chat must include purpose/context (what the child was for), result, changed files/artifacts/verification if relevant, and next action; never summarize by child label alone.

## Use the extension tools

Start every fray turn with `fray_status` when state is unclear. Use `.fray/` as the canonical control plane; do not maintain a separate task list. Enabling or using fray is not the same as enabling autonomous mode; never call `fray_set_mode` unless the user explicitly asks to change autonomous mode.

Thread statuses are `todo`, `active`, `needs-decision`, `blocked`, `deferred`, `done`, and `dismissed`. Use `todo` for in-scope work that has not started, `deferred` for valid work intentionally parked for later, `needs-decision` for human judgment, and `blocked` for dependency/external waits. Dependencies and child queues belong in the thread body or child follow-up mechanism, not the status.

Core tools:

```text
fray_status
fray_validate
fray_search
fray_create_thread
fray_dispatch
fray_dispatch_many
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

The thread doc is the orchestrator's synthesized truth. Child agents may read it. Child agents should not directly edit canonical thread/config/run files; they update live status with `fray_run_update` and write findings sidecars under `.fray/<thread>.findings/`.

## Dispatch

For a new effort, prefer `fray_create_thread` with `initialDispatches`: create the thread doc and start the first child/children in one call. Do not use the older two-step `fray_create_thread` then `fray_dispatch` pattern unless you intentionally need to create a thread without starting work. Use `fray_dispatch` for child work on an existing thread. Use `fray_dispatch_many` only for independent siblings on an existing thread that should start together.

Every child prompt must require an orchestration-ready final report. The final output must include: verdict/status; what was done; changed files, artifacts, clone path, and commit SHA when applicable; verification commands and results; blockers, caveats, and remaining risks; and one concrete next action. No silent completion, progress-only final state, or "done" without usable result data.

Prefer intent and capability hints over rigid profiles:

```text
intent: harvest | investigate | implement | review | verify | design | custom
modelHint: current | cheap | balanced | strong | strongest
thinkingHint: low | medium | high | xhigh
capabilities.write: true | false
```

The orchestrator may run fast/cheap while children run stronger non-fast models. Sub-agents usually get broad tool access. Do not over-restrict them by default; constrain by task scope and fray invariants, not by starving tools. Do not make CI/review/PR children read-only by reflex: if the likely next step is a safe code/doc/test fix on an existing branch, give the child write/push-capable instructions scoped to that branch and tell it to land the obvious fix unless a human-owned decision appears.

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

Child aborts are exceptional. Do not reload, shut down the parent, or call `fray_abort_child` while children are live unless the user explicitly accepts aborting them. Prefer `fray_steer` or `fray_followup` to redirect live work. Live steering requires an in-process SDK handle; after reload/session replacement, Fray cannot recover that handle from Pi session files. If reload or parent shutdown aborts or loses a child, reconcile that run, preserve partial facts from findings/progress/session files, and relaunch the work if it is still needed.

## Reconciliation

A completed child is not handled until the orchestrator reconciles it. Use `fray_next` to pull the oldest unreconciled completion when multiple children finish; this is the durable to-do queue for child returns. Completion follow-up messages are only short nudges, e.g. `Child agent complete [<runId>].`; get details from `fray_next`, the widget, findings, or `fray_reconcile`.

1. Call `fray_next` or `fray_reconcile` for the run.
2. Read the findings/result. If the result lacks final output or usable artifacts, treat the child as incomplete: do not mark the task done; dispatch/retry, steer/follow up if still live, or ask the user for direction.
3. Reconcile the result: decide what is accepted, what needs follow-up, and what questions remain.
4. Fold facts into the owning thread's Status, Decisions, Open questions, Steps, and Next step.
5. Summarize the result in the main chat, including purpose/context, result, changed files/commits/verification when applicable, and the next action; never summarize by child label alone.
6. Dispatch needed autonomous follow-ups immediately.
7. Only after handling is complete, call `fray_reconcile` with `markHandled: true` (or legacy `markReconciled: true`).
8. Check `fray_next` for the next unhandled child result and repeat until the result queue is clear or a user-facing priority interrupts.

Every substantive implementation, copy, behavior, test, benchmark, or load-bearing verdict gets an independent review child.

## Authority

Sub-agents can fix obvious bugs and produce patches. They do not own default, security, product, brand, public API, config, or env-surface decisions unless the human already greenlit the decision and the prompt says so. Full tool permission is not full decision authority.

## Safety rails

The important rails are orchestration rails:

- Do not drop user asks; new asks are additive.
- Do not treat outcome-shaped asks as mere audits; after diagnosis, keep going to the safe fix/reply/push unless blocked by a real decision or permission.
- Do not drop child completions; reconcile them.
- Do not accept empty or artifact-free child results as done; retry or ask.
- Do not abort live children for reload/shutdown unless explicitly accepted; preserve partial facts and relaunch needed work after any abort.
- Do not hoard new information in the orchestrator; steer affected live children immediately.
- Do not let canonical thread docs drift from reality.
- Do not run destructive git operations in the shared tree.
- Use isolated clones for uncontaminated verification.
- Keep child prompts self-contained.

The benefit of fray is dynamism: dispatch, steer, follow up, review, and reconcile based on what emerges, while `.fray/` keeps the whole tangle durable.
