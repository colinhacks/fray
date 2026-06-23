---
name: opencode-fray
description: "Use this skill in OpenCode for large, mixed efforts: investigations, fixes, reviews, launch pushes, audits, or refactors where the human needs decisions surfaced as facts emerge. Fray uses `.fray/` thread files as the control surface, OpenCode `Task` sub-agents as bounded workers, task ids as durable agent handles, and explicit reconciliation after every return."
metadata:
  internal: true
---

# Fray For OpenCode

Fray is the orchestrator-first workflow for work that is too large or too mixed for one foreground loop. The main OpenCode session is the orchestrator and the only decider. Sub-agents are instruments: they investigate, implement bounded fixes, verify, or review, then return a final report for the orchestrator to fold into `.fray/`.

Use this OpenCode version when fray is active in OpenCode. Do not import Claude hook assumptions or Codex plugin mechanics unless the OpenCode tool surface actually exposes them.

## OpenCode Bundle

This repo carries fray as an OpenCode-native bundle:

```text
.opencode/skills/opencode-fray/SKILL.md
.opencode/plugins/fray.ts
.opencode/commands/fray.md
.opencode/commands/fray-validate.md
.opencode/fray/core.mjs
.opencode/fray/index.mjs
.opencode/opencode.json
.opencode/agent/*.md
.opencode/package.json
.opencode/package-lock.json
```

The skill is named `opencode-fray` because OpenCode also discovers Claude-compatible skills under `.claude/skills/`; a project-local skill named `fray` can collide with `.claude/skills/fray/SKILL.md`.

The plugin is the OpenCode equivalent of the hook layer. It registers custom `fray_status`, `fray_validate`, and `fray_search` tools; injects a per-chat system reminder with pending thread state; hooks Task execution with `tool.execute.before` and `tool.execute.after`; validates that `THREAD: <slug>` points to an existing `.fray/<slug>.md`; injects a durable `FRAY_DISPATCH_ID`; appends the standard follow-up epilogue; writes best-effort ledger rows before and after Task execution; amends the Task tool definition with fray rules; adds `/fray` command context; injects pending fray state into compaction context; and exposes `FRAY_ROOT` / `FRAY_OPENCODE` to shell commands.

The slash commands are entrypoints:

```text
/fray
/fray-validate
```

## Start Every Fray Turn

First reconcile any returned sub-agents. A return is not handled until its facts, task id, follow-ups, and open questions are folded into the owning thread.

Then compute the board:

```bash
node .opencode/fray/index.mjs
node .opencode/fray/index.mjs --validate
```

Inside OpenCode, prefer the custom tools when available:

```text
fray_status
fray_validate
fray_search
```

Use the board to choose the next dispatch. Do not maintain a separate native todo list while fray is active; `.fray/` is the todo substrate.

## Control Surface

- `.fray/<slug>.md`: one file per live multi-step or long-lived thread. The filename slug is the id.
- `.fray/config.yml`: globals only — `autonomous_mode` and shared `state` facts. Enablement is per-session via the `.fray/.session-state/<session_id>` sentinel, not a config flag.
- `.fray/<slug>.findings/<id>.md`: optional sidecars for durable sub-agent output.
- `.fray/.dispatch-ledger.jsonl`: optional durable dispatch metadata. In OpenCode, the thread body is usually enough; use the ledger if a thread has many concurrent task ids.
- `.opencode/fray/index.mjs`: the OpenCode-local computed board. There is no stored board.

Thread frontmatter must include `title` and `status`. Status vocabulary is:

```text
todo
enqueued
active
blocked
needs-decision
done
dismissed
```

`todo` means thought-through, has an open doc, and awaiting explicit actioning — the "scoped but not yet scheduled" bucket, no defer-reason ceremony required. A ready thread waiting on a TRANSIENT blocker (a PR merge, a wave drain, a prior task's output) is NOT `todo` — it is `enqueued` + `depends_on`, which auto-fires. `enqueued` means basically ready to go and AUTO-FIRES when its `depends_on` clear — deliberately held until a named in-flight task or thread completes. This is a sequencing dependency, not a human gate; set `depends_on:` in frontmatter so the board computes the trigger, never encode it as prose. The per-turn reminder emits a LOUD by-name DROP-RISK callout for any `enqueued` thread whose deps have all cleared but was never dispatched — act on it immediately. `blocked` means waiting on a human, external event, or unresolved decision with no in-session trigger. `done` and `dismissed` are terminal and kept.

Each thread body must keep these sections, in this order:

```text
## Goal
## Status
## Decisions
## Open questions
## Steps / follow-up queue
## Next step
```

Edit thread bodies in place so they read as current truth. Do not accumulate a chronological changelog inside a thread.

## When To Create A Thread

Create `.fray/<slug>.md` first, before dispatching or doing substantial work, when an effort:

- will take two or more sub-agents,
- carries a human-owned decision,
- outlives the current turn,
- is split off from an existing effort, or
- is explicitly requested as a thread or spike.

One-shots do not need a file. Put loose cross-cutting one-offs in `.fray/backlog.md`.

Research and implementation stay in one thread. Retool the same file in place when research turns into build work.

## User Asks Are Additive

Every user ask is additive. A new request joins the existing queue; it does not supersede, deprioritize, or replace earlier asks unless the human explicitly says to stop or replace them.

When a new ask lands mid-work:

- capture it immediately in a thread or in the owning thread's `## Steps / follow-up queue`,
- dispatch or advance it in parallel when independent,
- use `enqueued` only for a real file or dependency conflict with a named in-flight task or thread,
- also continue reconciling and advancing earlier asks in the same turn.

Before replying, re-read the current pending list and recent user messages and verify no user ask has evaporated.

## OpenCode Task Lifecycle

When the active OpenCode tool schema exposes `Task`, OpenCode sub-agents are launched with that tool. Every `Task` return includes a `task_id`. Treat that task id as the durable agent handle.

Use `Task` this way after OpenCode has restarted with this project's `.opencode/opencode.json`:

- `subagent_type: "fray-harvester"` for fully scripted output/log/file-fact harvesting.
- `subagent_type: "fray-scout"` or `"explore"` for quick codebase discovery, file search, and narrow no-edit maps.
- `subagent_type: "fray-researcher"` for source-backed investigation and differential probes.
- `subagent_type: "fray-verifier"` for targeted builds, tests, fixtures, and CI/log checks.
- `subagent_type: "fray-implementer"` or `"general"` for decided implementation work.
- `subagent_type: "fray-reviewer"` for independent adversarial review.
- `subagent_type: "fray-architect"` for hard design and decision-analysis work.
- `subagent_type: "fray-docs-writer"`, `"fray-vendored-dep-engineer"`, or `"fray-frontend-inspector"` for specialized docs, vendored/forked-dependency, or rendered-site work.
- If the current running session exposes only `"explore"` and `"general"`, restart OpenCode so the project-local profiles are loaded.
- `task_id: ""` for a fresh dispatch.
- `task_id: "<previous id>"` only when intentionally resuming that same sub-agent context.
- `description` as a short human-readable label.
- `prompt` as the full contract: thread slug, task id if known, context, scope, constraints, deliverable, and final-report shape.

When `.opencode/plugins/fray.ts` is loaded, thread-scoped Task prompts get a hook-backed preflight. The orchestrator still owns the discipline, because tool schemas can change and one-shots intentionally omit `THREAD:`:

1. Confirm `.fray/<slug>.md` exists before any thread-scoped dispatch.
2. Put `THREAD: <slug>` at the top of the prompt so the plugin can validate it.
3. Tell the agent whether it may edit files.
4. Tell the agent not to edit `.fray/<slug>.md` or `.fray/config.yml`.
5. Require a final `## Follow-ups` section; the plugin appends this requirement when it recognizes the Task prompt.
6. After the task returns, record the returned `task_id` in the thread's `## Status` or relevant step.

OpenCode Task lifecycle facts:

- A completed Task can be resumed with its returned `task_id` when continuity matters.
- A fresh Task does not fork the current chat. It gets only the context you put in the prompt.
- There is no exposed live SendMessage-style tool for a running Task in this harness. Do not assume you can steer a running sub-agent mid-flight.
- A completed worker is no longer active, but OpenCode keeps enough task-session state for intentional `task_id` resume while that session is retained.

For thread-scoped dispatches, start prompts with this shape:

```text
THREAD: <slug>

You are an OpenCode sub-agent working for the fray orchestrator. Do not edit `.fray/<slug>.md` or `.fray/config.yml`. Return facts, changed paths, verification, open questions, and a final `## Follow-ups` section.

Task:
...
```

For one-shots, omit `THREAD:` and keep the prompt bounded.

## Task Id Discipline

Record task ids where the next turn can find them. The thread `## Status` should name in-flight or just-returned tasks in plain English, for example:

```text
Implementation task in flight: `ses_...` is updating the resolver docs. Review is enqueued until it returns.
```

When a task returns:

- read the owning thread before doing anything else,
- fold the returned facts into `## Status`, `## Decisions`, and `## Open questions`,
- mark completed checklist items,
- add new follow-ups from the agent's `## Follow-ups`,
- dispatch any autonomous queued follow-up in the same turn,
- keep or remove the task id in `## Status` depending on whether it is still needed for resume.

Use `task_id` resume only when continuity matters: the agent already built context that is useful, and the follow-up is the same thread of work. For independent review, clean-room reproduction, or adversarial checking, use a fresh task with a self-contained prompt.

## Parallel Dispatch

Default to parallel when work is independent. OpenCode can launch multiple `Task` sub-agents in one assistant turn, and routine file reads/searches can be parallelized with `multi_tool_use.parallel`.

Parallelize:

- read-only investigations,
- independent fixtures,
- independent doc/code surfaces,
- implementation and review on separate files after the implementation returns,
- independent self-review passes.

Serialize or enqueue:

- two agents editing the same file or same narrow surface,
- a review that depends on a not-yet-returned implementation,
- a follow-up that needs a specific task's output,
- a trustworthy build/test result that needs an uncontaminated tree.

Do not use raw destructive git operations in parallel-agent prompts. Forbid `git reset`, `git checkout --`, `git stash`, branch switches, worktrees, and recursive repo copies unless the human explicitly asks and the repo rules allow it. When uncontaminated verification is required, use a tracked-file isolation pattern such as `git clone --depth 1 file://...` with its own build directory.

## Prompt Contract

Every substantive OpenCode sub-agent prompt must be self-contained. A task does not reliably know the current chat unless you put the relevant facts in the prompt.

Include:

- the thread slug,
- the goal and current decision state,
- exact files or surfaces to inspect,
- allowed write scope,
- constraints from `AGENTS.md`,
- whether to commit or not if the user asked for commits,
- verification commands or fixture shape,
- expected final report.

For coding workers, include:

```text
Work on main. Do not create branches, stashes, worktrees, or recursive repo copies. Do not run destructive git commands. Other agents or the user may be editing the tree; do not revert unknown changes. Edit only the assigned files. Use apply_patch for manual edits. Finish with changed paths, verification run, and `## Follow-ups`.
```

Sub-agents are not deciders. They may fix obvious bugs. They must not autonomously land default, security, product, brand, public API, config, or env-surface decisions unless the human already greenlit the decision and the prompt says so.

Surface, don't guess. A sub-agent operates autonomously ONLY until something human-owned or genuinely ambiguous arises — a default/security/product/brand/API-config-env decision, a fork between materially-different approaches, or an unexpected blocker. At that point it does not guess and does not land it: it comes to rest and surfaces the choice (options plus its recommendation) to the orchestrator, who surfaces it to the human. Guessing past one of these and shipping the guess is the failure; coming to rest with a crisp question is the success. Bake this criterion into dispatch prompts.

## Write Ownership

Only the orchestrator edits `.fray/<slug>.md` and `.fray/config.yml`. Sub-agents return results to the orchestrator. If a sub-agent needs to persist durable output, instruct it to write a sidecar under `.fray/<thread>.findings/<id>.md`, then fold the signal into the canonical thread yourself.

The orchestrator uses OpenCode's normal editing rules: read before editing, use `apply_patch` for manual edits, avoid touching unrelated user changes, and preserve markdown paragraph style.

## Reconcile Returns

At the top of every fray turn, fold returned agents before answering new conversational threads.

Reconciliation checklist:

```text
Read `.fray/<slug>.md`.
Fold facts into Status.
Move settled calls into Decisions.
Keep only unresolved items in Open questions.
Drain queued follow-ups.
Dispatch autonomous follow-ups now.
Update Next step.
Record or clear task ids.
```

A task is not reconciled just because its final message is visible. The thread must reflect the result.

## Independent Review

Every substantive piece of work gets a separate review or integration pass. Do not let the doing-agent grade its own homework.

Use a fresh `Task` for review when the work:

- lands code,
- changes user-facing copy,
- changes behavior,
- touches tests or fixtures,
- affects public API, config, env, security, product, or brand surface,
- produces a load-bearing verdict or number.

The review prompt should include the original goal, changed files, relevant constraints, and exact verification expected. Ask for findings first, ordered by severity, then residual risks and follow-ups.

### Nested lead pattern (L1→L2)

A dispatched `Task` sub-agent is itself a LEAD (L1) that can dispatch its own L2 `Task` sub-agents — like the orchestrator. Two uses, both encouraged.

**Use A — fan out L2s for independent sub-work, then synthesize.** When an L1's task decomposes into genuinely-independent pieces, fan out a BOUNDED set of L2s (≈3–10) in parallel, collect, and synthesize ONE deliverable rather than grinding through them serially. Examples: research "to its logical conclusion" with one L2 per architecture path/option; a survey with one L2 per attack/reference/file/subsystem; separable implementation pieces. Fan out when pieces are INDEPENDENT and parallelism saves real wall-clock; stay serial for a true dependency chain (sequence them) or trivial work (do it inline). Mechanics: bounded not a swarm (the real ceiling is 429 backoff, not one-at-a-time); an L2's completion returns to the DISPATCHING L1; do not set `name`/`team_name` (the dispatch hook auto-strips both — they strand nested agents); TIER each L2 by load (survey → cheaper model, hard analysis/engineering → top model); the L1 COLLECTS + SYNTHESIZES into one coherent deliverable (never scattered sub-results) and still owns its thread + reports up. The budget governor forbids UNBOUNDED fan-out (a runaway swarm), not bounded parallelism.

**Use B — the implementer self-organizes its own review via L2s.** For substantive new functionality, dispatch ONE level-1 implementer that self-organizes its own review via level-2 `Task` sub-agents. The loop:

- PLAN the implementation.
- Dispatch a level-2 plan-review; take a second pass folding in valid critique.
- IMPLEMENT against the refined plan.
- Dispatch level-2 self-review; for a major change, run multiple PARALLEL reviewers with distinct lenses (correctness, security, a subsystem).
- CRITICALLY INCORPORATE: the implementer judges each review on merit and folds in only valid findings. It does not blind-trust; a level-2 reviewer has narrower and possibly staler context than the implementer.

Invariants: review at BOTH the plan and implementation stages; depth scales with blast radius (trivial change needs no nesting; major change gets the parallel-lens panel); reviews are advice, not verdicts. This composes with, and does not replace, the orchestrator's own independent review pass on the returned work.

## OpenCode Tooling

Use the tool that matches the orchestration job:

- `Task`: delegate bounded work to `explore` or `general` sub-agents; capture the returned `task_id`.
- `fray_status`: custom OpenCode tool for the computed board.
- `fray_validate`: custom OpenCode tool for thread-frontmatter validation.
- `fray_search`: custom OpenCode tool for finding threads by id/title/body.
- `.opencode/plugins/fray.ts`: OpenCode plugin hooks for chat reminders, Task preflight/after ledgering, Task tool-definition guidance, command hooks, shell env, custom tools, and compaction context.
- `.opencode/fray/index.mjs`: OpenCode-local CLI for board, validation, JSON, status filter, and search.
- `.opencode/commands/fray.md`: slash-command entrypoint that loads the board and validator into the prompt.
- `.opencode/commands/fray-validate.md`: slash-command entrypoint for thread-frontmatter validation.
- `multi_tool_use.parallel`: parallelize independent `read`, `grep`, `glob`, and other safe tool calls.
- `glob`: find files by pattern.
- `grep`: search content.
- `read`: inspect exact files and directories.
- `apply_patch`: create or edit files manually.
- `bash`: run build, test, git, package-manager, Docker, or other terminal commands; do not use it for routine file reads/searches/edits.
- `question`: batch human decisions at checkpoints when the active OpenCode schema exposes it and the decision is actually blocking; otherwise ask in chat at the checkpoint.
- `skill`: load domain skills such as `agent-browser`, `md-toc`, or `todo` when appropriate; do not use the native todo tool as the fray tracker.

Use the `commentary` channel for short progress updates and tool calls while working. Use the `final` channel only for the completed response.

## Model And Agent Choice

This repo defines GPT-backed fray subagents in `.opencode/agent/*.md`. The project main thread defaults to `openai/gpt-5.5-fast` in `.opencode/opencode.json`; fray subagents deliberately use non-fast GPT models unless the profile is explicitly a cheap probe. Restart OpenCode after agent/config edits before expecting the `Task` tool schema to expose new names.

Claude Code model-tier mapping:

- Haiku-shaped mechanical work -> `fray-harvester` (`openai/gpt-5.4-mini`, `variant: none`) or `fray-scout` / `explore` (`openai/gpt-5.4-mini`, `variant: low`). Use only for fully scripted harvesting, file discovery, and narrow read-only maps.
- Sonnet-shaped supporting work -> `fray-researcher` or `fray-verifier` (`openai/gpt-5.4`, `variant: medium`). Use for differential probes, source-backed research, test/build runs, and CI/log checking.
- Opus-shaped engineering work -> `general` or `fray-implementer` (`openai/gpt-5.5`, `variant: high`). Use for diagnosis and fixes that land.
- Opus/Fable-shaped judgment -> `fray-reviewer` or `fray-architect` (`openai/gpt-5.5`, `variant: xhigh`). Use for adversarial review, architecture, public-surface decisions, and load-bearing verdicts. Never use GPT-5 Pro for fray; it is too expensive for this workflow.
- Specialized lanes -> `fray-docs-writer` for docs/copy, `fray-vendored-dep-engineer` for vendored/forked-dependency + fork/pin work, and `fray-frontend-inspector` for rendered-site/browser QA.

Agent selection norms:

- Use the cheapest profile that can reliably do the work, but do not let cheap profiles return subtle verdicts.
- Use `fray-reviewer` as a fresh independent pass for any substantive code, copy, behavior, public-surface, test, benchmark, or load-bearing research result.
- Use `task_id` resume only when continuity matters with the same completed agent; use a fresh `fray-reviewer` for clean-room review.
- If a custom profile is not available in the current Task schema, restart OpenCode. Until restart, fall back to `general` for deep work and `explore` for read-only discovery.

OpenCode exposes `variant` through agent config, not through the in-chat `Task` call. Do not claim you selected effort per dispatch unless you selected a named agent profile whose config carries that model/variant.

## Human Decisions

Investigations should keep moving until a decision is actually blocking. Put unresolved questions in `## Open questions` with enough context to decide.

Batch questions at checkpoints. Use `question` when the active tool schema exposes it; otherwise ask in chat. If `autonomous_mode: on`, do not ask; make reversible draft decisions, document them in `## Decisions`, and park only genuinely irreversible or externally destructive calls.

## Validation

Use these checks after changing fray files or OpenCode skill guidance:

```bash
node .opencode/fray/index.mjs --validate
opencode debug skill
opencode debug config
```

If you edit this skill, preserve the invariants: `.fray/` is canonical, the board is computed, only the orchestrator edits thread files, task ids are recorded on return, and every returned sub-agent is reconciled before the thread is marked done.
