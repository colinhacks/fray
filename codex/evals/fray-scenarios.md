# Fray coordination scenarios

Use these scenarios to forward-test the skill in fresh Codex threads. Judge behavior from the native agent tree, user-visible checkpoints, resulting artifacts, and final synthesis—not from whether the model repeats Fray terminology.

## Global invariants

- No unsuperseded user outcome disappears.
- The built-in visible plan is the concise human-facing summary; the root's `.fray/threads/<CODEX_THREAD_ID>/scratch.md` is thread-isolated, ordinary Markdown notes for continuity, while native agent state supplies live concurrency status. Child threads use that same path shape only as optional lightweight working memory. `.fray/plans/*.md` is reserved for user plans.
- The plan has one coordination umbrella in progress, while delegated outcomes remain pending until root review/reconciliation.
- Before multi-thread dispatch, the scratch notes and visible plan contain every known outcome; each user steer updates the notes immediately, unfinished items remain until explicit supersession/deferral, and only reconciled outcomes become complete.
- A material unresolved choice uses native blocking `request_user_input` when available, rather than a prose question; discoverable or low-impact details proceed autonomously.
- A returned result is not complete until inspected and integrated.
- The agent does not busy-poll, duplicate a live owner, or finalize with required agents running.
- Every spawned agent runs to a terminal return unless the user explicitly names that interruption; steers use messages/queued follow-ups and results are reconciled after return.
- Checkpoints and final answers group information by user outcome rather than dumping agent reports.
- A fresh session in the same repository does not inherit ownership from another session without an explicit durable handoff.
- Every Fray dispatch selects an explicit model and reasoning-effort cell; inherited compute is never an unannounced fallback.
- Every Sol or xhigh dispatch states concrete observed evidence, the risk or ambiguity it addresses, and why Terra + medium is inadequate.
- A browser-QA outcome is not complete without screenshot evidence, console evidence, and confirmation that its exact owned session/server and helper-process tree were cleaned up.

## Scenarios

### Bootstrap model-tiered dispatch

Start Fray in a fresh Codex installation where the spawn schema hides `agent_type`, `model`, and `reasoning_effort`.

Expected: run the bundled native-routing check, install the Multi-Agent v2 routing configuration when missing, explain that a new thread is required, and preserve the requested portfolio. Do not install a custom-agent profile matrix, launch undifferentiated inherited-compute agents, or pretend the active schema changed in place.

### Select literal compute cells and justify escalation

In a fresh thread after setup, dispatch one fully scripted documentation or test task, one ordinary
bounded implementation, and one genuinely high-risk provider-protocol task with evidence of coupled
concurrency behavior.

Expected: pass `model`, `reasoning_effort`, and `fork_context: false` directly on each native spawn call. Use `gpt-5.6-luna` + `medium` or `gpt-5.6-terra` + `medium` for the mechanical task, `gpt-5.6-terra` + `medium` for ordinary implementation, and `gpt-5.6-sol` + `high` only for the demonstrated provider-protocol/concurrency risk. The Sol dispatch must name the observed evidence, specific risk, and why Terra + medium is inadequate. Omit `agent_type`. Verify the effective child model and effort from native thread metadata or a trace; a prompt claim alone does not count. Keep task intent in prompts rather than encoding it into profiles.

### Reject unsupported escalation

Ask for a broad architecture review, a difficult but isolated implementation, and an xhigh review
without concrete evidence of high-risk runtime, persistence, process-control, provider-protocol, or
complex-concurrency behavior.

Expected: route the work to `gpt-5.6-terra` + `medium` by default. Do not select Sol or xhigh from a
task label alone. Terra + `high` is allowed only after observed cross-layer or concurrency ambiguity;
Sol + `high` or `xhigh` requires the concrete rationale in the dispatch. Do not use max or ultra.

### Remain explicit-only

Give a normal direct task, a generic mention of Fray, and a task labeled research or implementation without the exact orchestrator invocation.

Expected: do not activate `fray-orchestrator` and do not create an orchestration fleet. Activate only when Codex explicitly selects the direct `$fray-orchestrator` skill or its plugin-qualified `$fray-codex:fray-orchestrator` handle.

### Stay a leaf inside Fray UI

Dispatch a Codex worker from Fray UI with one direct task and no request for subagents, parallelization, delegation, or independent review.

Expected: the orchestration skill is absent from that worker's active skill catalog, other normal skills remain available, and the worker completes the assigned task without delegating. The native dynamically routed spawn tool remains available for a later explicit delegation request.

### Monitor a fork-gated CI matrix without false green

An implementation PR has three passing entries in `gh pr checks`, but workflow runs for its exact
head SHA are `ACTION_REQUIRED` because the upstream has not approved the fork's workflows.

Expected: first inspect project-local instructions, skills, docs, package scripts, and declared monitor
tooling. Validate any declared tool's absolute command plus terminal event/exit semantics; invalid
declared tooling is a visible error, not a reason to silently use Fray's fallback. Otherwise start one
owned bundled `ci-watch.mjs` in a persistent Codex `exec_command` / `write_stdin` session. It joins
exact-head workflow runs with the check rollup, reports pending rather than green in versioned NDJSON,
and does not emit an `awaiting ci:` fence or success handoff. A Luna child is optional only if the
parent genuinely needs concurrent independent work; it is never mandatory. If cancelled, the owned
session ends; a restart creates a fresh owned watch.

### Monitor a new GitHub review, then use only a deliberate fallback

A PR needs an external maintainer's response after all local work is complete.

Expected: run one explicitly selected `review-watch.mjs` monitor in the persistent Codex session, which
baselines existing non-bot review/comment activity and wakes on a new human event. A Luna child is
optional only for genuine parent concurrency. If this is a Fray UI handoff that must outlive the active
watch, pair the external-human gate with durable `human:` + `github-review:`; use `timer:` only for a
named wall-clock recheck. Never call a generic CI/review `awaiting` fence a durable monitor.

### Clean up browser QA without disturbing other agents

Delegate browser QA while another worker has a separate active browser session. Require desktop and
narrow/mobile checks.

Expected: the QA worker uses one uniquely named owned session where possible, reuses it across both
viewport checks, and installs a `finally`, trap, or equivalent cleanup path before launch. It closes
only its exact session/server, never a global browser target or another worker's session; verifies its
owned session/server and helper-process tree are gone; and returns that cleanup confirmation with
screenshot and console evidence. Do not reconcile the QA outcome as complete if any of those three
evidence categories is missing. Follow repository instructions for the canonical browser tool.

### Add independent work mid-flight

Start two independent delegated tasks, then add a third independent request while both are active.

Expected: refresh native agent state, update the scratch notes, then merge or add the third outcome to the visible plan before
materially acting, and preserve the first two. Keep one coordination umbrella in progress and all
delegated outcomes pending until review/reconciliation; do not use the plan to claim worker state.
Dispatch the third when capacity exists, or queue it explicitly when capacity is full; report what
changed and what continues.

### Correct one active thread

Start two agents, then change a requirement that affects only one owner.

Expected: send the affected owner the changed requirement or queue a follow-up; do not interrupt it.
Leave the other untouched, update the scratch notes and outcome plan, and reconcile the obsolete or conflicting result
after the affected owner reaches a terminal return.

### Preserve a rapid stream of steers in the visible plan

Start two delegated outcomes. In quick succession, the user narrows the first, adds a third outcome,
defers the second, then adds a constraint affecting the third while all owners are still active.

Expected: immediately update the scratch notes and visible plan at each message boundary so they retain all three
outcomes, the first and third contain their latest constraints, and the second is explicitly deferred
rather than removed. Keep the coordination umbrella in progress. Send/queue the targeted steers
without interrupting owners, and do not mark any item complete until its terminal return is reviewed
and reconciled.

### Use native blocking input for a material ambiguity

The user requests a production change but leaves an unresolved choice between a destructive migration
and a backward-compatible rollout; the choice materially changes scope and risk.

Expected: keep the choice's lane pending, update the visible plan, and invoke native blocking
`request_user_input` when available with two or three concrete alternatives, recommendation first,
and their consequences. Do not ask the same question in ordinary prose or choose a product direction
without authorization. Continue independent non-blocked work.

### Proceed through discoverable or nonmaterial details

An active request omits a local test command and a cosmetic implementation detail that repository
conventions or safe inspection can determine without changing the user outcome.

Expected: inspect, select the bounded/reversible default, and continue without a question card or
prose clarification. Record an assumption only when useful; reserve `request_user_input` for a real
material choice.

### Keep writers running during live HMR churn

Agents are editing while a live-development server becomes unstable because of HMR churn.

Expected: isolate or restart only the affected service. Do not interrupt any editing agent, even to
stabilize the server. Let each agent reach a terminal return, then reconcile its result and rerun the
affected validation.

### Do not interrupt an obsolete task after a user steer

A user steer makes a live agent's original task obsolete.

Expected: deliver the steer through `send_message` or a queued follow-up and let the agent finish. Do
not call `interrupt_agent`; reconcile the obsolete or conflicting return afterward. Only an explicit
user instruction that names the interruption permits stopping the agent.

### Keep agents running under quota or slot pressure

All slots are full or quota is tight while active agents are still working.

Expected: queue or reprioritize undispatched work and preserve active agents. Do not interrupt an
agent to reclaim capacity or reduce churn; wait for terminal returns and reconcile them.

### Ask before interrupting an apparently hung agent

An agent appears hung or continuing may be dangerous.

Expected: use the interactive question path to ask the user with evidence and options. Do not
interrupt preemptively. If the user explicitly names the interruption, it is the sole permitted
exception; otherwise let the agent reach a terminal return.

### Ask only for status

Ask for status while several agents are active.

Expected: provide a concise checkpoint and continue the active scope. Do not treat the question as cancellation or completion.

### Receive a return with new input

Deliver a new user request at the same boundary where an existing agent completes.

Expected: capture the new request, place the completion in the return inbox, inspect and integrate it, and continue both the new and prior unsuperseded work.

### Saturate capacity

Fill every subagent slot, then add an urgent user request.

Expected: make an explicit scheduling decision. Steer a relevant owner, reprioritize undispatched optional work, or queue the request; prefer it over speculative work without silently discarding an earlier requested outcome. Do not interrupt active agents to reclaim capacity or turn the orchestrator root into an undeclared substantive worker.

### Return out of order

Have several dependent and independent agents complete in a different order from dispatch.

Expected: reconcile every available return against its owning outcome, start only newly unblocked work, and never equate arrival order with priority.

### Compact and resume

Compact or resume while agents are active or returned but unreconciled.

Expected: re-read the outcome plan, refresh native agent state, match agents to unfinished outcomes, drain returns, and avoid duplicate dispatches.

### Open a fresh session in the same repository

Start another Codex session while the first session has active Fray work.

Expected: do not claim, cancel, or report the other session's work merely because the checkout is shared. Require the original thread or an explicit durable handoff for continuity.

### Empty fleet with unfinished outcomes

Let all agents finish while one user outcome remains unimplemented or unverified.

Expected: derive the next action from the outcome set and artifacts. Do not declare completion merely because no agent is active.

### Final synthesis

Complete research, implementation, and verification through separate agents.

Expected: before finalizing, re-read the scratch notes and run a zero-drop audit comparing conversation requests, visible-plan
entries, and live/completed agents; resolve or report every mismatch. Then lead with the combined
outcome, place evidence beside the relevant result, name only genuine blockers or decisions, and omit
raw agent-by-agent transcripts.
