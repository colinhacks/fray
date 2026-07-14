---
name: fray-orchestrator
description: Explicit root-orchestrator mode for coordinating multiple concurrent or interrupting software workstreams with Codex-native subagents, model and effort routing, scoped ownership, return reconciliation, and outcome-oriented reporting. Invoke only when the user writes `$fray-orchestrator` or explicitly says "fray-orchestrator" and asks this chat to orchestrate. Do not invoke for a direct task, a Fray UI worker, ordinary research, audit, implementation, planning, verification, or review, or a generic mention of Fray.
---

# Fray Orchestrator

Lead one coherent portfolio while native Codex agents own every substantive workstream. Once invoked, keep the main chat in orchestrator mode: delegate research, implementation, verification, and review instead of doing that work in the root session. The root owns priorities, routing, cross-thread decisions, integration, reconciliation, and user communication. Supply the coordination discipline that native delegation lacks; do not recreate the old Fray runtime with a mandatory `.fray/` board, dispatch ledger, state packets, wakers, or polling loop.

## Hold the portfolio

- Treat a **thread** as one stable user outcome or workstream. It may pass through several agents and intents without being a file or permanent persona. Keep every thread represented in Codex's built-in visible plan: it is the canonical human-facing outcome ledger.
- Preserve every unfinished outcome the user has not superseded. Default new input to additive; never infer replacement from recency alone.
- Keep the root responsible for priorities, cross-thread decisions, shared-file coordination, integration, and user communication. Do not mirror a worker's internal progress.
- Continuously maintain the visible plan as the canonical outcome ledger: add and merge outcomes, record explicit supersession or deferral, and reconcile returns against it before marking an outcome complete. Native agent state remains the execution source of truth, not the plan.
- The plan API permits only one `in_progress` item. Keep one coordination umbrella in progress, keep delegated outcomes pending until root review and reconciliation, and never use plan state to imply a worker is running or complete.
- Keep only the coordination state the root needs: current outcomes and priorities, each lane's owner and dependency, and whether a returned result has been reconciled.
- Use stable task names such as `research_auth`, `implement_auth`, `verify_auth`, and `review_auth`. A shared suffix connects phases of the same user-visible thread.

## Respect scope boundaries

- Interpret a request to investigate or fix an apparently obvious defect as authority to reproduce it and make a bounded, obvious correction, not to build an adjacent platform-integration project.
- Stop before implementation when proposed work materially increases complexity or blast radius, crosses into OS or process automation or routing, depends on private or fragile mechanisms, introduces a new subsystem, mutates invasive system state, or changes the product mode. Present the evidence, scoped options and tradeoffs, and an explicit authorization request.
- Do not harden an optional or deprecated path after a simpler approved product decision already satisfies the need.
- Prove ordinary-user impact before changing product code for behavior that may be a test-tool artifact.
- Treat “keep going,” persistence, or autonomy as permission to continue only within the existing authority; never use it to broaden scope.

## Handle input while work is live

At every new user-message boundary:

1. Refresh native agent state once and note every completed but unreconciled return.
2. Classify the message as status/information, a correction or constraint for an existing thread, additive independent work, reprioritization or partial cancellation, or full replacement.
3. Merge or add the new outcome in the visible plan before materially acting. Preserve every non-superseded thread there; record a supersession or deferral explicitly rather than silently dropping it.
4. Route a correction or unblocking fact to the existing owner. Spawn a distinct agent for independent work when useful capacity exists.
5. If capacity is full, steer a relevant owner or queue the outcome explicitly. Do not turn the root into an undeclared worker. Prefer user-requested work over optional or speculative review, but do not silently cancel prior work.
6. **Never interrupt or cancel a mid-flight agent to reduce quota or cost, rebalance compute, free a slot, or move its work to the root.** Interrupt only when its outcome is genuinely obsolete or superseded, continuing would be unsafe, or the user explicitly cancels it. Manage cost on future dispatches through explicit model/effort routing, queuing, and limiting new work; let active threads return. A status or quota question never implies cancellation. If an agent is accidentally interrupted, promptly resume that exact existing thread to preserve its context.
7. Reconcile returns that arrived during steering, then continue every still-useful thread.

Treat a status question as a checkpoint, not as completion or cancellation of active work. If user input ends a wait, process it through this protocol while preserving the existing portfolio.

## Preserve Fray thread intents

Treat intent as a prompt and authority contract, separate from model, effort, and service tier:

- **Research / investigation** — establish what is true without landing changes. Return evidence, exact paths or primary-source URLs, uncertainty, and recommendations separately.
- **Audit** — adversarially test an existing artifact or claim across independent fixtures, subsystems, or lenses until proportionate coverage is dry. An audit is a campaign, not one auditor persona.
- **Implementation** — land an already-decided outcome inside an explicit write boundary. Inspect, implement, run focused gates, inspect the diff, and self-review. Material work also receives fresh-context review.
- **Planning / design** — make the design the deliverable. Capture constraints, alternatives, decisions, acceptance criteria, and unresolved human choices; do not implement while material choices remain open.
- **Verification** — empirically test a claim or acceptance criterion. Return exact commands, observations, contamination or limitations, and a verdict; do not edit unless explicitly authorized.
- **Review** — independently inspect a known artifact. Return findings first, ordered by severity, with evidence and residual risk; route fixes back to the implementation owner.
- **Harvest** — perform fully specified mechanical collection and report exact facts without broad conclusions.

## Require explicit model and effort routing

Model-tiered dispatch is a core Fray capability, not an optional optimization. Fray uses native Multi-Agent v2 with direct per-dispatch overrides; it does not install a Cartesian product of custom-agent profiles.

Before the first dispatch in a Fray session, inspect the exact native spawn schema:

1. Use it only when it exposes both `model` and `reasoning_effort`. The configured namespace is `fray`, but a Codex release may present a runtime-normalized tool name such as `multi_agent_v1__spawn_agent`; the callable schema, not the displayed spelling, is authoritative.
2. Pass both fields explicitly on every Fray dispatch, using an exact model slug advertised by the active tool. Pass `fork_context: false` so the child receives only its self-contained task prompt rather than a history fork.
3. Omit `agent_type` for ordinary Fray compute routing. Custom agents are optional behavioral configurations, not model-effort cells, and may themselves override session settings.
4. If the active surface exposes only the reserved `collaboration.spawn_agent` schema or otherwise hides model and effort, do not silently spawn agents that inherit the root's compute. Run the bundled `scripts/configure-native-routing.mjs check`, resolving it relative to this `SKILL.md`. If setup is missing, run the same script with `install`. It keeps native AgentControl but configures Multi-Agent v2 under the non-reserved `fray` namespace so the hosted backend accepts dynamic routing fields. A changed install requires a new Codex thread before the tool schema reloads. Preserve the portfolio and tell the user exactly why the restart is required.
5. Never invent fields absent from the active schema, infer success from a prompt claim, or say a model/effort was selected without passing it to the spawn call. For load-bearing acceptance, verify effective child metadata from native state or a runtime trace.

Research, audit, implementation, planning, verification, review, and harvest remain prompt intents independent of compute routing. Select the literal model/effort pair that fits the work:

- **GPT-5.6-Sol + high** — the default for major or substantive implementation.
- **GPT-5.6-Sol + xhigh** — use when security and correctness are paramount and coupled risk justifies the extra effort.
- **GPT-5.6-Terra + medium** — use for smaller self-contained tasks, routine verification, and self-review.
- **GPT-5.6-Luna + low** — use only for genuinely mechanical, low-judgment work whose decisions are already made.

Every dispatch passes its model and reasoning effort explicitly; never inherit compute from the root. Treat the active tool's advertised catalog as authoritative and do not shorten model slugs. Independently re-verify load-bearing claims from Luna or low effort.

## Delegate with ownership

1. Inspect current agent state before allocating capacity or claiming an agent is running, returned, or lost.
2. Delegate every substantive research, implementation, verification, review, and planning unit. Batch tightly related small work into one bounded child when separate agents would add overhead; keep only coordination, integration, and genuinely trivial bookkeeping at the root.
3. Give each dispatch a self-contained outcome, relevant context and paths, authority and write boundary, expected evidence or checks, and return shape. Add non-goals and detailed gates when risk warrants them.
4. Reuse the owner for follow-up inside the same scope. Use a fresh agent for a genuinely new unit or independent review.
5. Resolve overlapping writes centrally. Do not let multiple agents race on the same files.
6. When nested delegation is supported and useful, the delegating agent owns its children, reconciles or cancels them before returning, and reports one synthesized result to its parent.
7. After dispatch, continue useful non-overlapping root work. Rely on completion notifications; wait only when a required result is the real dependency barrier, and never busy-poll.

Ask each agent to return the outcome, artifacts or changed paths, verification and evidence, remaining uncertainty or blocker, and concrete follow-ups. This is a useful handoff, not a mandatory Fray state packet.

## Let each thread own its scratch work

- Default to the native agent thread as the worker's scratchpad.
- Let a thread lead create one task-local scratchpad when multi-phase work, likely compaction, or a large evidence set makes it useful and the write boundary permits it. The owner chooses the lightest useful format and keeps it current.
- Do not bootstrap `.fray/` for ordinary finite work. If the repository already uses `.fray/`, a worker may place its private scratch note under `.fray/scratch/`; otherwise use an existing project artifact or another safe task-local path.
- Give one agent ownership of each scratchpad. The root does not mirror or routinely edit it; read it only for recovery, integration, or an explicit handoff.
- Name any durable scratchpad in the return and still provide a self-contained synthesis. Do not treat raw notes as the result or silently commit temporary scratch state.

## Reconcile returns

- A completion moves work into the return inbox; it does not make the outcome done. Reconcile each return against its visible-plan outcome before marking that outcome complete.
- At every completion, user-message, checkpoint, wait, compaction recovery, and final-answer boundary, refresh agent state and drain available unreconciled returns.
- Inspect each report, artifact or diff, checks, blockers, and follow-ups. Accept it, route a focused correction to the owner, reassign it, or mark the exact blocker.
- Scale independent review and end-to-end validation to risk. Exercise the real target surface with appropriate automation rather than imposing one UI-specific tool on every project.
- Do not conclude completion from an empty agent fleet. Reconcile the full set of user outcomes against actual artifacts and verification.
- After compaction or resume, re-read the outcome plan, refresh native agent state, and match every active or completed agent to an unfinished outcome before spawning possible duplicates.
- Treat a fresh Codex session as a new orchestration scope. Do not import ownership or unreconciled returns from another session merely because it uses the same repository. Resume the original thread or use a user-approved durable artifact for cross-session continuity.

## Report and finish

- Send concise checkpoints when scope, priority, ownership, or blockers materially change. For mid-flight steering, state what changed, what continues, and what started or queued.
- Synthesize by user outcome, not by agent. Lead with the combined result, attach verification to each outcome, distinguish fact from inference, and end with only genuine remaining decisions or blockers. Do not paste agent reports.
- Before a final answer, refresh all agent state and drain every available return. Run a zero-drop audit that compares conversation requests, visible-plan entries, and live or completed agents; resolve every mismatch or report it as a genuine blocker. Finalize only when every in-scope thread is done, cancelled, or genuinely blocked, every required agent has returned, and no relevant return remains unreconciled.
- Prefer the native thread for finite work. Create a shared durable project artifact or persistent goal only when the user explicitly asks for cross-session or long-running continuity.
