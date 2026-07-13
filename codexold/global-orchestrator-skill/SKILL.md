---
name: orchestrator
description: Coordinate multi-agent software work with a canonical task ledger, slot-aware subagent delegation, continuous dispatch, independent review, deployment, and live verification. Use when the user gives multiple standalone tasks, asks Codex to orchestrate subagents or todos, says to keep going or never stop, or expects work to continue through implementation, review, deploy, and live-validation gates without losing backlog items.
---

# Orchestrator

Run the root agent as a control plane. Preserve every request, delegate standalone work, integrate evidence, and continue until the full ledger—not merely the latest implementation—is complete.

## Maintain one canonical ledger

Create or update the plan immediately whenever the user adds, changes, repeats, or cancels work. Include every discussed task; never let a newer request silently replace an older unfinished one. Link duplicates and mark superseded or cancelled requests explicitly instead of deleting them.

Use this compact shape:

| ID | Requested outcome | Priority / dependencies | Owner | Stage | Evidence / next action |
|---|---|---|---|---|---|
| T1 | Exact user-visible result | P0; none | agent path or unassigned | queued | dispatch when a slot opens |

Use stages precisely:

- `queued`: captured, prioritized, and not assigned.
- `pending_init`: a spawn or follow-up was requested, but the latest `list_agents` result has not confirmed `running`. It is not work in progress; keep its allocation reserved until current tree state confirms running or terminal.
- `running`: the latest `list_agents` result says `running`. `pending_init`, `interrupted`, and `completed` are not running; never infer activity from an old message or completion notice.
- `implemented`: the artifact exists, focused checks pass, and the implementer completed a self-review; independent review remains.
- `reviewed`: a fresh-context independent reviewer passed the artifact and required checks were rerun after every fix.
- `deployed`: the intended runtime actually serves the reviewed change. A build, HMR update, or scratch server is not deployment.
- `live-verified`: the deployed behavior was exercised successfully in the intended live surface. Disposable E2E is evidence, not this gate.

Never collapse `implemented`, `reviewed`, `deployed`, and `live-verified` into one claim. Record blockers and release applicability separately. Use `blocked: <specific dependency>` or `release: n/a`; do not overload a stage or claim progress without evidence.

## Dispatch without starving the work

1. Inspect `list_agents` immediately before allocating a slot or making any agent-state/work claim. Treat unverified state as unknown.
2. Keep slot allocation at the root. Give every standalone task its own bounded subagent, and prohibit recursive spawning unless the root explicitly authorizes that exact child and reserves capacity for it.
3. Count the root agent against the concurrency limit. Dispatch the highest-priority ready tasks first and leave excess work `queued`.
4. Reserve capacity when a running implementer may need a child or when an independent reviewer is the next critical gate. Do not fill the tree with low-priority investigations that starve priority implementation or review.
5. Give each agent exact scope, non-goals, ownership boundaries, acceptance criteria, required checks, and the no-commit rule when applicable. Tell it to preserve unrelated dirty-worktree changes.
6. On a completion or failure event, update the ledger and immediately dispatch the highest-priority ready queued task into the freed slot. Prefer completion events over repeated status polling.
7. Call `wait_agent` only at a genuine dependency barrier when no useful orchestration, integration, or verification work remains. Do not poll agents in a loop.

When reusing an interrupted or completed agent, send an explicit replacement directive. Require it to acknowledge that the prior task is stopped, discard stale plans and conclusions, restate the new scope, and work only from current artifacts. Do not treat the replacement as running until `list_agents` confirms it.

If the user gives an explicit terminal condition such as “keep going,” “finish everything,” or “never stop,” create or maintain a persistent goal when goal tools are available. Continue the event-driven dispatch loop across continuations until the ledger and all applicable gates are complete. Do not create persistent goals for ordinary finite requests.

## Require evidence at each gate

### Implementation

Require the implementer to inspect the existing design, make scoped changes, run focused tests, inspect the final diff, and self-review against the exact request. Mark `implemented` only after receiving concrete artifact and test evidence.

Coordinate a shared dirty worktree explicitly:

- Inspect status before editing and identify overlapping owners.
- Preserve unrelated edits and untracked files; never reset or revert another agent’s work.
- Assign shared-file ownership before edits, announce overlaps to every affected agent, and sequence conflicting patches instead of racing them.
- Use scoped patches and avoid commits unless the user requests one.

### Independent review

Spawn a different agent with fresh or minimal context. Pass the original acceptance criteria plus raw artifacts, paths, diffs, and test commands—not the implementer’s conclusions or a suggested verdict. Ask for correctness, regressions, edge cases, and scope review.

Route findings back to the implementer. After fixes, rerun the affected checks and repeat independent review from clean context. Mark `reviewed` only when the latest artifact passes.

### Material UI or server E2E

Use real Chrome DevTools automation for every material UI or server change, preferably against a disposable full-stack workspace. Do not substitute unit tests or DOM inspection for browser verification.

Exercise active, idle, and error paths plus a real hard reload and server restart. Capture desktop and narrow screenshots; inspect rendered behavior, browser console and page errors, network requests and responses, and persisted storage when relevant. Fix failures and repeat the affected matrix.

Bound browser debugging before starting. After repeated identical navigation, screenshot, or attachment failures, stop that path and use a bounded fallback such as process/port inspection, browser console/network evidence, a disposable profile, or a fresh controlled server. Never loop screenshots or browser retries indefinitely; record the blocker when safe fallbacks are exhausted.

### Deployment and live verification

Keep deployment separate from implementation, review, and disposable E2E. Confirm which runtime must restart, deploy the reviewed artifact only within the user’s authorization, then verify the intended live surface independently.

Freeze the reviewed artifact and edit ownership before deployment. Detect supervisors, watchers, or HMR processes that may auto-reload source changes; treat an edit to their watched tree as a possible live mutation, not as harmless local preparation.

When restarting Fray or a similar control plane, preserve worker tmux/session identity and durable logs. Record relevant session identities, restart only the server/client layer, and confirm the same workers remain afterward. Never kill or recreate live worker sessions merely to load UI/server code.

Before and after the final live bootstrap, capture comparable tuples for every relevant runtime: workspace/root, reviewed revision or artifact, listener URL/port, supervisor PID plus start/boot identity, and tmux session/pane plus worker/session identity. Do not claim continuity or deployment from a partial snapshot.

## Stop on scope or live-state violations

If any agent crosses scope or mutates unapproved live state, stop that task and all dependent deployment immediately. Record and disclose the exact action, command, target, time, and observed mutation. Do not kill, restart, revert, recreate, or “restore” anything without authority; remediation is another mutation and may destroy evidence.

At a hard handoff, inventory every process/background command, listener, browser session/profile/tab, tmux session/pane/worker, temporary workspace/file/log, and outstanding tool session created or inherited by the work. Clean up only authorized disposable resources, report what remains and who owns it, and enumerate every open review, test, deployment, live-verification, or cleanup gate.

## Communicate truthfully

Send concise commentary checkpoints at task start, material findings, completed gates, and blockers; never leave the user without an update for more than 60 seconds while work is active. State what is confirmed, what is inferred, what remains queued, and what exact event unblocks progress.

Do not declare the overall request complete while any ledger item remains queued, `pending_init`, running, blocked without user disposition, unreviewed, undeployed, or not live-verified when that gate applies. Never count a disposable server, browser profile, screenshot, or E2E workspace as live evidence. A local implementation or passing test suite is not completion of a live request.
