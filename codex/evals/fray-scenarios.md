# Fray coordination scenarios

Use these scenarios to forward-test the skill in fresh Codex threads. Judge behavior from the native agent tree, user-visible checkpoints, resulting artifacts, and final synthesis—not from whether the model repeats Fray terminology.

## Global invariants

- No unsuperseded user outcome disappears.
- The built-in visible plan is the canonical human-facing outcome ledger; native agent state, not the plan, supplies live concurrency status.
- The plan has one coordination umbrella in progress, while delegated outcomes remain pending until root review/reconciliation.
- A returned result is not complete until inspected and integrated.
- The agent does not busy-poll, duplicate a live owner, or finalize with required agents running.
- Checkpoints and final answers group information by user outcome rather than dumping agent reports.
- A fresh session in the same repository does not inherit ownership from another session without an explicit durable handoff.
- Every Fray dispatch selects an explicit model and reasoning-effort cell; inherited compute is never an unannounced fallback.
- Major or substantive implementation routes to `gpt-5.6-sol` + `high`; xhigh is reserved for coupled security/correctness risk.
- Smaller self-contained work, routine verification, and self-review route to `gpt-5.6-terra` + `medium`; Luna + low is only for mechanical low-judgment work.
- A live agent is never cancelled merely to reduce cost, rebalance compute, free capacity, or move work to root.
- Major architecture/system-design work establishes approved invariants, relevant threat model, non-goals, and a bounded stop condition; unapproved new control-plane mechanisms remain findings, not implementation.

## Scenarios

### Bootstrap model-tiered dispatch

Start Fray in a fresh Codex installation where the spawn schema hides `agent_type`, `model`, and `reasoning_effort`.

Expected: run the bundled native-routing check, install the Multi-Agent v2 routing configuration when missing, explain that a new thread is required, and preserve the requested portfolio. Do not install a custom-agent profile matrix, launch undifferentiated inherited-compute agents, or pretend the active schema changed in place.

### Select literal compute cells

In a fresh thread after setup, dispatch one fully scripted mechanical collection, one routine
verification or self-review, one major implementation, and one security/correctness task with coupled
risk.

Expected: pass `model`, `reasoning_effort`, and `fork_context: false` directly on each native spawn
call. Use `gpt-5.6-luna` + `low` for the mechanical task, `gpt-5.6-terra` + `medium` for routine
verification/self-review, `gpt-5.6-sol` + `high` for major implementation, and `gpt-5.6-sol` +
`xhigh` only for coupled security/correctness risk. Omit `agent_type`. Verify the effective child
model and effort from native thread metadata or a trace; a prompt claim alone does not count. Keep task
intent in prompts rather than encoding it into profiles.

### Bound architecture complexity

Ask for a major system design after an investigation exposes a bug and a possible new supervisor,
broker, protocol, global coordinator, or invasive OS automation.

Expected: the architecture child records approved invariants, any relevant threat model, non-goals,
and a stop condition; compares the simplest platform primitive and relevant prior art; and separates
the confirmed bug from candidate mechanisms. It triages an unapproved control-plane mechanism as a
finding with evidence, simpler alternatives, and an explicit decision request rather than implementing
it. If an approved material change expands, run a whole-diff simplification checkpoint before
acceptance, then stop after bounded acceptance and proportionate review instead of broadening into an
adjacent redesign.

### Remain explicit-only

Give a normal direct task, a generic mention of Fray, and a task labeled research or implementation without the exact orchestrator invocation.

Expected: do not activate `fray-orchestrator` and do not create an orchestration fleet. Activate only when Codex explicitly selects the direct `$fray-orchestrator` skill or its plugin-qualified `$fray-codex:fray-orchestrator` handle.

### Stay a leaf inside Fray UI

Dispatch a Codex worker from Fray UI with one direct task and no request for subagents, parallelization, delegation, or independent review.

Expected: the orchestration skill is absent from that worker's active skill catalog, other normal skills remain available, and the worker completes the assigned task without delegating. The native dynamically routed spawn tool remains available for a later explicit delegation request.

### Add independent work mid-flight

Start two independent delegated tasks, then add a third independent request while both are active.

Expected: refresh native agent state, merge or add the third outcome to the visible plan before
materially acting, and preserve the first two. Keep one coordination umbrella in progress and all
delegated outcomes pending until review/reconciliation; do not use the plan to claim worker state.
Dispatch the third when capacity exists, or queue it explicitly when capacity is full; report what
changed and what continues.

### Preserve live work during cost or status pressure

Start a substantive agent, then ask for quota status, ask to free capacity for another task, or ask
whether a cheaper model should be used.

Expected: report or queue as appropriate without interrupting the live agent. Cost management applies
to future dispatches through explicit model/effort routing, queuing, or limiting new work. Interrupt
only when the outcome is obsolete or superseded, continuation is unsafe, or the user explicitly
cancels it. If interrupted accidentally, promptly resume the exact existing thread.

### Correct one active thread

Start two agents, then change a requirement that affects only one owner.

Expected: steer the affected owner, leave the other untouched, update the outcome plan, and preserve any still-useful earlier work.

### Ask only for status

Ask for status while several agents are active.

Expected: provide a concise checkpoint and continue the active scope. Do not treat the question as cancellation or completion.

### Receive a return with new input

Deliver a new user request at the same boundary where an existing agent completes.

Expected: capture the new request, place the completion in the return inbox, inspect and integrate it, and continue both the new and prior unsuperseded work.

### Saturate capacity

Fill every subagent slot, then add an urgent user request.

Expected: make an explicit scheduling decision. Steer a relevant owner, reclaim optional capacity, or queue the request; prefer it over speculative work without silently discarding an earlier requested outcome. Do not turn the orchestrator root into an undeclared substantive worker.

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

Expected: before finalizing, run a zero-drop audit comparing conversation requests, visible-plan
entries, and live/completed agents; resolve or report every mismatch. Then lead with the combined
outcome, place evidence beside the relevant result, name only genuine blockers or decisions, and omit
raw agent-by-agent transcripts.
