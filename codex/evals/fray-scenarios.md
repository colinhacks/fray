# Fray coordination scenarios

Use these scenarios to forward-test the skill in fresh Codex threads. Judge behavior from the native agent tree, user-visible checkpoints, resulting artifacts, and final synthesis—not from whether the model repeats Fray terminology.

## Global invariants

- No unsuperseded user outcome disappears.
- Native agent state, not the plan, supplies live concurrency status.
- A returned result is not complete until inspected and integrated.
- The agent does not busy-poll, duplicate a live owner, or finalize with required agents running.
- Checkpoints and final answers group information by user outcome rather than dumping agent reports.
- A fresh session in the same repository does not inherit ownership from another session without an explicit durable handoff.
- Every Fray dispatch selects an explicit model and reasoning-effort cell; inherited compute is never an unannounced fallback.

## Scenarios

### Bootstrap model-tiered dispatch

Start Fray in a fresh Codex installation where the spawn schema hides `agent_type`, `model`, and `reasoning_effort`.

Expected: run the bundled native-routing check, install the Multi-Agent v2 routing configuration when missing, explain that a new thread is required, and preserve the requested portfolio. Do not install a custom-agent profile matrix, launch undifferentiated inherited-compute agents, or pretend the active schema changed in place.

### Select literal compute cells

In a fresh thread after setup, dispatch one fully scripted harvest and one load-bearing adversarial review.

Expected: pass `model`, `reasoning_effort`, and `fork_context: false` directly on each native spawn call, choosing `gpt-5.6-luna` + `low` for the scripted harvest and `gpt-5.6-sol` + `high` or higher for the load-bearing review. Omit `agent_type`. Verify the effective child model and effort from native thread metadata or a trace; a prompt claim alone does not count. Keep harvest/review behavior in the task prompts rather than encoding those intents into profiles.

### Remain explicit-only

Give a normal direct task, a generic mention of Fray, and a task labeled research or implementation without the exact orchestrator invocation.

Expected: do not activate `fray-orchestrator` and do not create an orchestration fleet. Activate only when Codex explicitly selects the direct `$fray-orchestrator` skill or its plugin-qualified `$fray-codex:fray-orchestrator` handle.

### Stay a leaf inside Fray UI

Dispatch a Codex worker from Fray UI with one direct task and no request for subagents, parallelization, delegation, or independent review.

Expected: the orchestration skill is absent from that worker's active skill catalog, other normal skills remain available, and the worker completes the assigned task without delegating. The native dynamically routed spawn tool remains available for a later explicit delegation request.

### Add independent work mid-flight

Start two independent delegated tasks, then add a third independent request while both are active.

Expected: preserve the first two; record and dispatch the third when capacity exists, or queue it explicitly when capacity is full; report what changed and what continues.

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

Expected: lead with the combined outcome, place evidence beside the relevant result, name only genuine blockers or decisions, and omit raw agent-by-agent transcripts.
