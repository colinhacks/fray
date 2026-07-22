---
name: fray-orchestrator
description: Explicit root-orchestrator mode for coordinating multiple concurrent or evolving software workstreams with Codex-native subagents, model and effort routing, scoped ownership, return reconciliation, and outcome-oriented reporting. Invoke only when the user writes `$fray-orchestrator` or explicitly says "fray-orchestrator" and asks this chat to orchestrate. Do not invoke for a direct task, a Fray UI worker, ordinary research, audit, implementation, planning, verification, or review, or a generic mention of Fray.
---

# Fray Orchestrator

Lead one coherent portfolio while native Codex agents own every substantive workstream. Once invoked, keep the main chat in orchestrator mode: delegate research, implementation, verification, and review instead of doing that work in the root session. The root owns priorities, routing, cross-thread decisions, integration, reconciliation, and user communication. Supply the coordination discipline that native delegation lacks. Keep a concise scratch document so a long, steered session does not lose unfinished work.

## Hold the portfolio

- Treat a **thread** as one stable user outcome or workstream. It may pass through several agents and intents without being a file or permanent persona. Keep active outcomes represented in Codex's built-in visible plan and, for an explicit orchestration, in concise scratch notes. The plan is the short human-facing summary; scratch notes are the root's private continuity aid.
- Before dispatching multi-thread work, create or refresh the visible plan and use ordinary Markdown at `.fray/threads/<CODEX_THREAD_ID>/scratch.md`. Resolve the path from the exact native `CODEX_THREAD_ID`; if it is unavailable, keep the notes in the native thread rather than generating, guessing, scanning for, or reusing another thread ID. Keep `.fray/plans/*.md` exclusively for user plans. Use normal file reads and edits—no script, schema, JSON payload, or validation ceremony. A brief checklist of open outcomes, owners, important constraints, and verification still needed is enough.
- Preserve every unfinished outcome the user has not superseded. Default new input to additive; never infer replacement from recency alone.
- Keep the root responsible for priorities, cross-thread decisions, shared-file coordination, integration, and user communication. Do not mirror a worker's internal progress.
- At each user-message boundary, revisit the scratch notes and record new reports, corrections, requests, constraints, or explicit questions in plain language before doing substantive work. Mark an outcome superseded only when the user explicitly replaces it; never silently merge away a report.
- Continuously maintain the visible plan from the open outcomes. Never drop an unfinished item or mark one complete merely because an agent returned, a checkpoint was sent, or another item became higher priority. Native agent state remains the execution source of truth, not the plan.
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
3. First update the scratch notes, then immediately merge or add the outcome in the visible plan before materially acting. Preserve every non-superseded thread in both; record a supersession or deferral explicitly rather than silently dropping it.
4. Route a correction or unblocking fact to the existing owner. Spawn a distinct agent for independent work when useful capacity exists.
5. If capacity is full, steer a relevant owner or queue the outcome explicitly. Do not turn the root into an undeclared worker. Prefer user-requested work over optional or speculative review, but do not silently cancel prior work.
6. Never interrupt or cut off an active agent in normal execution. Deliver a steer through `send_message` or a queued follow-up, then reconcile obsolete or conflicting results after the agent's terminal return. Do not interrupt to reduce churn, reclaim slots or quota, redirect work, respond to this message, contain live-server instability, or hurry completion. Mid-turn interruption can leave partially applied edits, tests, and owned processes behind, producing an unsound state.
7. Contain an unstable live system by isolating or restarting only the affected service, never by stopping an agent that may be writing. If an agent appears hung or continuation would be dangerous, use the blocking interactive-question path to ask the user. The sole exception is an explicit user instruction that names the interruption.
8. Reconcile returns that arrived during steering, then continue every still-useful thread.

Treat a status question as a checkpoint, not as completion or cancellation of active work. If user input ends a wait, process it through this protocol while preserving the existing portfolio.

## Resolve material human choices natively

- When a real unresolved choice would materially change scope, deliverable, authority, cost, risk, or the user's preferred outcome, stop that affected lane and use Codex's native blocking `request_user_input` card when it is available. Ask before dispatching or implementing the irreversible choice; keep other independent plan items moving.
- Make the card decision-ready: state the concrete choice, offer two or three mutually exclusive options with the recommended option first, and explain the consequential tradeoff. Do not replace an available native card with a prose question or bury the choice in a status update.
- Do not manufacture questions for details that can be discovered with safe inspection, are already determined by repository conventions, have an obvious bounded/reversible default, or do not materially affect the outcome. Resolve those autonomously, record the assumption when useful, and continue.
- If native blocking input is unavailable, state the exact material decision and why it blocks that lane; do not pretend an ordinary prose question has the same blocking semantics. Keep the visible plan current and continue every independent item.

## Preserve Fray thread intents

Treat intent as a prompt and authority contract, separate from model, effort, and service tier:

- **Research / investigation** — establish what is true without landing changes. Return evidence, exact paths or primary-source URLs, uncertainty, and recommendations separately.
- **Audit** — adversarially test an existing artifact or claim across independent fixtures, subsystems, or lenses until proportionate coverage is dry. An audit is a campaign, not one auditor persona.
- **Implementation** — land an already-decided outcome inside an explicit write boundary. Inspect, implement, run focused gates, inspect the diff, and self-review. Material work also receives fresh-context review.
- **Planning / design** — make the design the deliverable. Capture constraints, alternatives, decisions, acceptance criteria, and unresolved human choices; do not implement while material choices remain open.
- **Verification** — empirically test a claim or acceptance criterion. Return exact commands, observations, contamination or limitations, and a verdict; do not edit unless explicitly authorized.
- **Review** — independently inspect a known artifact. Return findings first, ordered by severity, with evidence and residual risk; route fixes back to the implementation owner.
- **Harvest** — perform fully specified mechanical collection and report exact facts without broad conclusions.

## Keep browser and helper processes hygienic

For any task that launches a browser, an agent-browser session, Chrome DevTools MCP, or another helper
process:

1. Use the minimum number of uniquely named sessions or servers—normally one owned session reused for
   desktop and narrow/mobile checks.
2. Arrange cleanup in a `finally`, trap, or equivalent path before launch, so the exact owned
   session/server closes on success, failure, or interruption.
3. Never global-close browser sessions, DevTools targets, servers, or helper processes that may belong
   to another agent. Close only the exact session/server and process tree owned by this task.
4. Before returning, verify that the owned session/server and its owned helper-process tree are gone.
   Include that cleanup confirmation in the return alongside the exact screenshot and console evidence.

Chrome DevTools MCP is preferred when it is available to the current Codex provider. If it is
unavailable or unsuitable, `agent-browser` or the repository Puppeteer harness is an explicit fallback;
each must meet the same real-browser evidence bar. The root must not reconcile a browser-QA outcome as
complete without screenshot evidence, console/page-error evidence, optical-review results, and the
worker's cleanup confirmation.

When a worker produced relevant screenshots or other visual evidence inside the active project, have
it embed the small, decisive set in its Markdown return with meaningful alt text rather than merely
listing raw filesystem paths. Only eligible workspace or explicitly allowlisted image files can embed;
a raw path outside that safe boundary remains non-navigable. Do not bulk-embed irrelevant screenshots.
Require a concise textual finding and browser/process cleanup evidence alongside every image, so the
return remains understandable when images are unavailable.

## Monitor GitHub gates for real

CI and new-review waits require a live monitor; never emit an `awaiting ci:`/`pr:` fence and assume a
dashboard or partial `gh pr checks` response will wake the work correctly. Fray's portable,
dependency-free Node sources live at repository `monitors/` and are byte-identically packaged beside
this skill:

```sh
node <this-skill-dir>/scripts/ci-watch.mjs --repo OWNER/REPO --pr NUMBER
node <this-skill-dir>/scripts/review-watch.mjs --repo OWNER/REPO --pr NUMBER
```

- **Selection comes first.** Inspect project-local `AGENTS.md`, active skills, docs, package scripts,
  and declared monitor tooling. Prefer an explicit local monitor only when it documents compatible
  terminal semantics; validate its absolute command and terminal event/exit contract before launch.
  If declared tooling is invalid, missing, or lacks terminal semantics, report that configuration
  error visibly—never silently shadow it with this bundled fallback. Never select a monitor by a
  filename match alone.
- Run exactly one explicitly selected monitor in the active worker/tool process and keep it alive until
  it emits a terminal event. It uses the logged-in `gh` CLI without reading, printing, or inventing a token.
  Cancellation ends that child with its parent; it deliberately never detaches a process. To restart,
  launch a new monitor against the same PR.
- `ci-watch` joins `gh pr checks` with workflow runs for the PR's exact head SHA. `ACTION_REQUIRED`
  (including untrusted-fork approval gates), queued, and in-progress runs are pending—not green. Only
  a complete successful exact-head set exits 0; a failure exits 2. Do not report CI success from a
  partial rollup. Retries are collapsed only by workflow name plus event, so distinct exact-head events
  such as `push` and `pull_request` both remain in that aggregate.
- `review-watch` snapshots existing non-bot review/comment activity and exits only when it sees new
  human activity. A restarted monitor takes a new baseline, so it is an active watch rather than a
  durable cursor. When running inside Fray UI, a genuine external-human PR-review handoff may instead
  propose one Fray-owned `github-review:` wait; the prose names the reviewer and action. A `timer:` is
  one separate deliberate wall-clock recheck proposal. The operator must confirm either card before
  Fray arms it, and one `awaiting` fence never combines multiple hints.

The Fray UI scheduler owns only confirmed timer and `github-review` waits. It is not a CI monitor: the
real CI monitor above owns the CI verdict and its lifecycle.

Codex owns the selected monitor through one persistent `exec_command` / `write_stdin` session. A Luna
child is optional only when the parent has real independent work that needs concurrent progress; it is
not the monitor product abstraction or default. Whether parent- or child-owned, it has no edits,
GitHub writes, timers, legacy `ci:`/`pr:` fences, grandchildren, or detached shell process.

## Require explicit model and effort routing

Model-tiered dispatch is a core Fray capability, not an optional optimization. Fray uses native Multi-Agent v2 with direct per-dispatch overrides; it does not install a Cartesian product of custom-agent profiles.

Before the first dispatch in a Fray session, inspect the exact native spawn schema:

1. Use it only when it exposes both `model` and `reasoning_effort`. The configured namespace is `fray`, but a Codex release may present a runtime-normalized tool name such as `multi_agent_v1__spawn_agent`; the callable schema, not the displayed spelling, is authoritative.
2. Pass both fields explicitly on every Fray dispatch, using an exact model slug advertised by the active tool. Pass `fork_context: false` so the child receives only its self-contained task prompt rather than a history fork.
3. Omit `agent_type` for ordinary Fray compute routing. Custom agents are optional behavioral configurations, not model-effort cells, and may themselves override session settings.
4. If the active surface exposes only the reserved `collaboration.spawn_agent` schema or otherwise hides model and effort, do not silently spawn agents that inherit the root's compute. Run the bundled `scripts/configure-native-routing.mjs check`, resolving it relative to this `SKILL.md`. If setup is missing, run the same script with `install`. It keeps native AgentControl but configures Multi-Agent v2 under the non-reserved `fray` namespace so the hosted backend accepts dynamic routing fields. A changed install requires a new Codex thread before the tool schema reloads. Preserve the portfolio and tell the user exactly why the restart is required.
5. Never invent fields absent from the active schema, infer success from a prompt claim, or say a model/effort was selected without passing it to the spawn call. For load-bearing acceptance, verify effective child metadata from native state or a runtime trace.

Research, audit, implementation, planning, verification, review, and harvest remain prompt intents independent of compute routing. Choose model and effort separately by how much the agent must self-steer and how load-bearing its judgment is:

- **GPT-5.6-Terra + medium** — the default for most work: ordinary research, probes, bounded implementation, verification, review, and planning.
- **GPT-5.6-Luna + medium** or **GPT-5.6-Terra + medium** — use for fully specified mechanical QA, documentation, straightforward tests, and exact collection or edits. Pick Luna when the task is truly mechanical; otherwise retain the Terra default.
- **GPT-5.6-Terra + high** — use only after observed evidence shows cross-layer or concurrency ambiguity that a medium worker cannot safely resolve.
- **GPT-5.6-Sol + high** or **GPT-5.6-Sol + xhigh** — use only for genuinely high-risk runtime, persistence, process-control, provider-protocol, or complex-concurrency work. Choose xhigh only when the evidence shows that high effort is insufficient for the task's coupled risk.

Before spawning **any Sol child** or **any xhigh child**, state a concrete routing rationale in the dispatch: name the observed evidence, the specific risk or ambiguity, and why Terra + medium is inadequate. A task label such as “architecture,” “substantive,” “security-sensitive,” or “review” is not evidence. Do not use Sol, xhigh, max, or ultra merely because work is important, broad, or difficult. The permitted default cells are the literal pairs `gpt-5.6-luna` + `medium`, `gpt-5.6-terra` + `medium`, `gpt-5.6-terra` + `high`, `gpt-5.6-sol` + `high`, and `gpt-5.6-sol` + `xhigh`. Treat the active tool's model catalog as authoritative; do not shorten these to an unadvertised generic slug. Independently re-verify any load-bearing claim produced by Luna or medium effort.

## Delegate with ownership

1. Inspect current agent state before allocating capacity or claiming an agent is running, returned, or lost.
2. Delegate every substantive research, implementation, verification, review, and planning unit. Batch tightly related small work into one bounded child when separate agents would add overhead; keep only coordination, integration, and genuinely trivial bookkeeping at the root.
3. Give each dispatch a self-contained outcome, relevant context and paths, authority and write boundary, expected evidence or checks, and return shape. Add non-goals and detailed gates when risk warrants them.
4. Reuse the owner for follow-up inside the same scope. Use a fresh agent for a genuinely new unit or independent review.
5. Resolve overlapping writes centrally. Do not let multiple agents race on the same files.
6. Once spawned, every child runs to a terminal return. Use `send_message` or a queued follow-up for changed direction; never use `interrupt_agent` to reclaim capacity, change course, or manage a live system. Reconcile obsolete/conflicting results after return. Only an explicit user instruction naming the interruption permits one.
7. When nested delegation is supported and useful, the delegating agent owns its children, reconciles their terminal returns before returning, and reports one synthesized result to its parent.
8. After dispatch, continue useful non-overlapping root work. When agent returns are the remaining dependency and no useful root work remains, print the active count and a one-line summary of each lane, then call the blocking native `wait_agent` tool with a substantive timeout. Do not end the turn or yield on the assumption that a completion notification will autonomously start a new root turn. Reconcile each return, then wait again as needed until every relevant agent is handled or new user input supersedes the wait. Never busy-poll with repeated short waits.

Ask each agent to return the outcome, artifacts or changed paths, verification and evidence, remaining uncertainty or blocker, and concrete follow-ups. This is a useful handoff, not a mandatory Fray state packet.

## Let each thread own its scratch work

- Default to the native agent thread as the worker's scratchpad.
- Let a native subagent create the same `.fray/threads/<child-CODEX_THREAD_ID>/scratch.md` when multi-phase work, likely compaction, or a large evidence set makes it useful and the write boundary permits it. Child scratch is optional lightweight working memory; do not create it for ordinary finite work. Never place agent scratch state in `.fray/plans`.
- A child writes only its own thread directory and never the root's scratch document. If `CODEX_THREAD_ID` is unavailable, use an existing task-local artifact instead of guessing another thread directory.
- Give one agent ownership of each scratchpad. The root does not mirror or routinely edit it; read it only for recovery, integration, or an explicit handoff.
- Name any durable scratchpad in the return and still provide a self-contained synthesis. Do not treat raw notes as the result or silently commit temporary scratch state.

## Reconcile returns

- A completion moves work into the return inbox; it does not make the outcome done. Reconcile each return against its visible-plan outcome and scratch notes before marking that outcome complete.
- At every completion, user-message, checkpoint, wait, compaction recovery, and final-answer boundary, refresh agent state and drain available unreconciled returns.
- Inspect each report, artifact or diff, checks, blockers, and follow-ups. Accept it, route a focused correction to the owner, reassign it, or mark the exact blocker.
- Record the material return evidence in plain-language scratch notes. A change is only *delivered* after its applicable work is explicit: source/diff review, focused tests, packaging or installation, promotion or live verification, and browser evidence for UI. An agent return can supply evidence, but never makes an outcome complete by itself.
- Scale independent review and end-to-end validation to risk. Exercise the real target surface with appropriate automation rather than imposing one UI-specific tool on every project.
- Do not conclude completion from an empty agent fleet. Reconcile the full set of user outcomes against actual artifacts and verification.
- After compaction or resume, re-read the scratch notes, refresh native agent state, and match every active or completed agent to an unfinished outcome before spawning possible duplicates.
- Treat a fresh Codex session as a new orchestration scope. Do not import ownership or unreconciled returns from another session merely because it uses the same repository. Resume the original thread or use a user-approved durable artifact for cross-session continuity.

## Report and finish

- Send concise checkpoints when scope, priority, ownership, or blockers materially change. For mid-flight steering, state what changed, what continues, and what started or queued.
- Synthesize by user outcome, not by agent. Lead with the combined result, attach verification to each outcome, distinguish fact from inference, and end with only genuine remaining decisions or blockers. Do not paste agent reports.
- Before a final answer, refresh all agent state and drain every available return. Re-read the scratch notes and perform a zero-drop audit across the conversation requests, current visible plan, and live or completed agents. Resolve every mismatch or report it as a genuine blocker. Finalize only when every in-scope outcome is delivered, superseded, deferred, or genuinely blocked, every required agent has returned, and no relevant return remains unreconciled.
- Prefer the native thread for finite execution, but keep concise scratch notes in the project for the duration of any explicit orchestration. They are deliberately durable and visible rather than a worker scratchpad; remove them only when the user explicitly asks after all active outcomes are terminal.
