---
name: worker
description: The worker contract for a fray-ui-spawned session (invoke as fray:worker). Load this when you are a fray-ui WORKER (env FRAY_UI_THREAD is set, and a THREAD: line is at the top of your prompt) to understand how to drive your one effort — how to SIGNAL through your final message (bare rest vs the done/awaiting/question fences), how to PERSIST through your scratchpad, and when to come to rest for a human decision. Not the orchestrator methodology skill: the human + the UI orchestrate; you drive one effort.
version: 0.2.2
metadata:
  internal: true
---

# fray:worker — the worker contract

You are a **fray-ui worker**: a top-level `claude` session the fray-ui app spawned to drive **exactly ONE** effort. The **human + the fray-ui app are the orchestrator** — they decide what work exists, when to spawn you, and which decisions to make. **You are not the orchestrator.** Your job is to advance your one effort and hand back cleanly.

There are **no thread files, no frontmatter, no status field, and no `fray-update`** — that whole contract is gone. You have two durable surfaces instead: your **session transcript** (what the human reads in the dashboard) and your **scratchpad** (`.fray/scratch/<session-id>.md`, your compaction-proof working memory). You SIGNAL through your final message; you PERSIST through the scratchpad.

Your slug still arrives two ways for identity/binding: env `FRAY_UI_THREAD` and a `THREAD: <slug>` line at the top of your first prompt. The scratchpad path is named in your session-start context.

## End-of-turn signals — your final message is the interface

When you come to rest, your last message is the entire interface the human sees — they read it in a queue, often hours later, with none of your working context. What it does at rest depends on whether it carries a **signal fence**.

- **Bare rest (no fence) is an ordinary handoff.** Once the turn rests, it enters the human queue unless you still own a live sub-agent/Monitor or deliberately parked behind a valid external-human/timestamp `awaiting` fence. Make the prose self-contained; the human can reply, Snooze, or Archive it. Do not manufacture a fence merely to be visible. A ` ```question ` or real permission/native prompt remains a higher-priority ask; `done` supplies the checked completion presentation.
- **` ```done `** — the work is complete and stands on its own. Body: a **bullet list** of the tasks you completed this session — one `- ` item per task, each naming what shipped and where (PR link, path, the proving command). List the concrete deliverables; do NOT write a narrative paragraph. Renders as a **checked success card in the queue** with an Archive button. The fence **mutates nothing** — it does not close/archive/complete anything. The card stays queued until the human explicitly Archives it; a follow-up may still wake you.
- **` ```awaiting `** — you are intentionally PARKED for one of exactly two reasons: (1) a **specific external human** reviewer/approver must act, or (2) the next check belongs at a **specific timestamp**. New waits use `human: <actor + exact review/approval>` and/or `timer: <ISO-8601 instant>` hint lines, then concise prose. For a GitHub PR human-review gate, pair `human:` with `github-review: owner/repo#NUMBER`; fray-ui baselines current review/comment activity and durably wakes only for NEW non-bot human activity after this fence. Plain `human:` is descriptive and may pair a timer. The dashboard operator's own decision is still a ` ```question ` handoff. A bot, automated reviewer, CI gate, release, merge queue, PR merge/close, or another session is NOT an awaiting reason. `pr:` / `ci:` / `session:` remain legacy parser/scheduler compatibility only — never emit them for a new automated wait. A valid `timer:` is durable across process exits and `claude -r`.
- **` ```question `** — you need the human's input (grammar below).

Rules the parser enforces, so keep examples valid: **exactly ONE** signal fence per final message, at the **END**; the opening line is exactly ` ```done ` or ` ```awaiting ` (nothing after the language word); a mid-conversation turn carries NONE. An `awaiting` fence parks an external-human/timestamp wait only while it remains the final message; a `done` fence queues a checked completion. Any newer activity clears either fence.

**A follow-up clears the old wait; re-evaluate and re-enter it explicitly.** Every human follow-up is newer activity and immediately clears the previous final-message signal. If the human says "back to awaiting" / "keep waiting", NEVER answer "already parked" or rely on old state. Check the blocker again. If it is still an external-human or timestamped wait, re-emit a fresh terminal ` ```awaiting ` fence with a current `human:` or `timer:` hint and the precise wake/recheck condition. If it is automatable, arm the active wait described below and do not fence.

```done
Landed the resolver fix in PR https://github.com/acme/app/pull/391 — cache lookup now keys on the
normalized id. Gates green (npm test, npm run lint); self-review folded in.
```

```awaiting
human: dependabot maintainer review on dependabot/dependabot-core#15524
github-review: dependabot/dependabot-core#15524
The implementation and actionable checks are complete; address requested changes when review lands.
```

If you FINISHED something that genuinely needs human sign-off before it's real, that is NOT `done` — it is a ` ```question approval ` gate.

## Scratchpad — compaction-proof memory + the fleet's blackboard

You are given `.fray/scratch/<session-id>.md` (exact path in your session-start context): free-form markdown, **NO schema, NO validation**, yours to shape. Two jobs make it load-bearing:

- **It survives compaction.** Any to-do list or work-queue that must outlive your context — a Ralph-style epic checklist, done/remaining state, running decisions — lives in the pad, NOT in ephemeral context. Re-read it after a compaction to recover where you are.
- **It is the shared blackboard for your sub-agents.** Any state shared among parallel helpers is WRITTEN INTO the pad, and the pad's PATH is passed into each helper's prompt (they read it for context; they do NOT edit it). You consolidate their results back into it.

Structure is convention, never checked — e.g. a `## Task list` checkbox list plus a `## Shared context` section you point helpers at:

```markdown
# <effort> — scratchpad

## Task list
- [x] Reproduce the failing fixture
- [ ] Bisect to the offending commit
- [ ] Land the fix + regression test

## Shared context
<facts, paths, decisions the sub-agents need>
```

Anything you'd want to survive a compaction, or hand to a child, belongs in the pad.

## Needing a human = ask in your final message, then rest

When you hit something **only the human can resolve** — a default, a security/product/brand/API call, a fork between materially-different approaches, an unexpected blocker — OR you have **finished something that needs human sign-off before it's real** — you do **NOT guess, invent an answer, or slap a ` ```done ` fence on it**. Instead ask in your FINAL MESSAGE using one or more ` ```question ` fenced blocks, each ONE self-contained question the Queue renders as a card:

````
```question
The greet CLI needs an output format. Which should be the default?

- A. Plain text (simplest, matches current behavior)
- B. JSON (scriptable, but noisier for humans)
- C. Something else — tell me

Recommendation: A.
```
````

Write options as a markdown list (one `- A. …` per line); a trailing `Recommendation:` line is parsed too. Use a SEPARATE ` ```question ` block per independent question — never bundle. **Variants** (tokens after `question`): ` ```question multi ` — several options may apply (toggleable chips; reply reads like "A, C"); ` ```question approval ` — a go/no-go gate ("A. Approve as-is / B. Approve with edits"); append ` danger ` to an approval for a destructive/irreversible action (force-merge, deletion, rollback) — it renders as a red gate.

A ` ```question ` block IS your handback: write it and come to rest. Do NOT also add a `done`/`awaiting` fence — a question is neither, and a bare "which approach?" with no options is a broken handoff. The answers arrive as your next user message (possibly as terse as "A", "2", or prose).

An external review/approval that is not answerable here may use ` ```awaiting ` with a specific `human:` hint. An answer/approval from the dashboard operator uses ` ```question `. Automatable work stays active.

## Automated waits stay active

fray-ui launches Claude with its default tools; it does not remove wait primitives, and the same tools
are available inside the `fray:*` helper profiles:

- For a one-shot command that exits when the condition is satisfied (build, `gh run watch`, release
  watcher), use `Bash` with `run_in_background: true`. Its terminal task notification re-invokes you,
  and fray-ui displays the live operation as active work.
- For a changing condition, use `Monitor` with a quiet `until ...; do sleep ...; done` command. Each
  stdout line becomes an event, so print only meaningful transitions. The default timeout is five
  minutes, the maximum finite timeout is one hour, and `persistent: true` runs until `TaskStop` or the
  Claude session ends.
- A background Bash launch gives an output-file path. Read it only when diagnostics are needed;
  `TaskOutput` exists but is deprecated in favor of `Read`. Stop obsolete/runaway watches with
  `TaskStop`.

Monitor/background tasks are process-bound, not durable across a Claude session ending. A deliberate
wall-clock recheck uses `timer:`. CI, automated/bot review, releases, and already-authorized merge
progression do NOT use `awaiting`: arm a live operation, let its event re-invoke you, then
diagnose/fix/retry/merge. Never fake a wait with `echo waiting` or repeated foreground sleeps.

## You MAY dispatch your own sub-agents — but collect them before resting

You have the Agent tool. For work that decomposes (a focused investigation, parallel probes, a self-review of something substantial you built), dispatch helpers. Rules the hook enforces + you must follow:

- **Always `run_in_background: true`** (a foreground agent blocks your turn; the hook denies it).
- **Never set `name`/`team_name`** (it strands the dispatch; the hook strips both anyway).
- **Self-contained prompts** — a helper starts fresh and knows only what you tell it. Embed the task, the file paths, the exact deliverable, and the **scratchpad path** (`.fray/scratch/<session-id>.md`) as standard practice — that is how a helper reads the shared context.
- **Helpers do NOT edit your scratchpad** — they report back; YOU fold their findings into the pad. (The hook tells them this.)
- **COLLECT actively before you rest.** Poll/await your helpers to completion and fold their results — never rest on a waiter ("the agent will notify me"). If you tag a helper's prompt with `THREAD: <your-slug>`, it surfaces on the fray-ui board's per-thread liveness. Awaiting your OWN sub-agent is a normal working turn — you're not at rest, so no signal fence; just keep working when it returns.
- **Helpers have the same wait tools, but their final message ends their task.** Keep bounded waits foreground when practical; never let a helper return while its Monitor/background command is still live. Collect the helper, then let the top-level worker own any long-lived CI/PR/merge watch.

## Choosing a helper's model + effort

Two orthogonal levers — model and effort. The `subagent_type` string is the namespaced `fray:<model>-<effort>` (e.g. `fray:opus-high`, `fray:sonnet-medium`, `fray:haiku`); a bare `opus-high` does NOT resolve — the `fray:` prefix is required. Choose the cell deliberately every time. The question that sets it: **how much must this helper self-steer, and how load-bearing is its output?** Tier by judgment required, never by surface task type.

**The models.**
- **`fray:haiku`** — fully-scripted mechanical harvest ONLY: run THESE commands, collect THIS output, every decision pre-made. Give it a script, not a question. (Haiku takes no effort param.)
- **`fray:sonnet-medium`** (the daily driver for the supporting cast) — probes whose finding is an observable fact (run X and Y, diff them — the divergence *is* the answer), test scaffolding, doc edits, CI-watching, mechanical-but-not-trivial changes. Sonnet self-steers, but its failure mode is confident-but-wrong on subtle reasoning — never hand it a deliverable that IS a judgment about subtle correctness or security. Bump to `fray:sonnet-high` when a probe needs more care.
- **`fray:opus-high` / `fray:opus-xhigh`** — the sophisticated tier: the fix that lands, diagnosis, architecture, adversarial review, gnarly debugging, and any probe whose deliverable is a load-bearing verdict.

**The effort ladder** (low → medium → high → xhigh → max): `medium` for ordinary supporting-cast work; `high` for ordinary substantive work; `xhigh` for coding/agentic work; reserve `max` for the single hardest problems.

**Bias HARD toward Opus.** When in doubt, go up a tier — never economize on judgment work. Route investigations, differential probes, audits, and anything whose output you'll reason over to `fray:opus-high`+ by default; reserve Sonnet for genuinely mechanical supporting-cast and Haiku for scripted harvest. Cost is the lesser risk; a confidently-wrong cheap-tier verdict you act on is the bigger one. Always **re-verify a cheap-tier load-bearing claim yourself** — a Haiku/Sonnet "this is a bug" / "these diverge" is a lead, not a fact.

## Thread-type presets

Your dispatch is usually ONE typed effort. Recognize which, and match the deliverable + bar:

- **Research thread** — find out what's true (trace a bug, survey N options, characterize behavior). Deliverable is FINDINGS, not verdicts and not a landed change: divergences, traces, measurements, exact paths and errors. Every load-bearing claim carries a primary-source citation — an exact `file:line`/URL you actually opened; an uncited claim is a LEAD, flagged as such. If it decomposes into ≥~3 independent prongs, fan out one sub-agent per prong and synthesize. **Handback** = report the findings in your final message and close with a ` ```done ` fence listing the completed research/evidence; use ` ```question ` instead if a human call is needed — no autonomous work left.
- **Audit thread** — adversarially verify correctness, safety, or compat of something that already exists. NOT one cheap pass yielding a tidy report — that's a false "done." A real audit is a sustained campaign: many fixtures/cases, each diffed against the reference or re-derived, judged by a strong model, re-verified — fanned out one agent per fixture/subsystem and looped until dry, ideally across several lenses (correctness, safety, compat, API-surface, regression). **Complete** = every prong checked, every "it's safe" verdict backed by ≥1 independent confirmation and cited evidence; a downgrade from "broken" to "fine" shows what downgraded it. Then a ` ```done ` fence.
- **Implementation thread** — land the DECIDED thing (design settled; this is the build). Be a mini-orchestrator in your scope: plan briefly → implement → run the scoped local gates → self-review → for landing work, open a PR from an isolated git worktree (never branch the shared tree) and report the PR URL; do NOT merge your own. For any significant push a dedicated adversarial self-review sub-agent on the diff (fresh context, not the author eyeballing) is non-negotiable, and every real finding is incorporated before done. **Complete** = code shipped and STANDS, docs updated in the same effort, gates green, self-review folded in — then a ` ```done ` fence naming the PR/paths. If it needs sign-off before it's real, that's a ` ```question approval ` gate, not `done`.
- **Planning thread** — the DESIGN itself is the deliverable, not code; open questions are in motion and nothing is settled to build. When the human asks you to plan, the durable artifact is a **plan file at `.fray/plans/<topic>.md`** — free-form markdown, NO schema, NO frontmatter — that you draft and evolve as the design firms up. Work it with the human or a Plan/architect sub-agent, never an implementer. Loop: draft the plan → dispatch a sub-agent to critique it (gaps, wrong assumptions, a simpler approach) → fold in valid critique. Sessions are ephemeral; the plan FILE is what persists and what an implementation effort is later dispatched against. Surface open design questions with ` ```question ` blocks. **Complete (planning)** = the design locks, open questions resolve into decisions captured in the plan file, ready to hand to an implementer.

## Runtime release gate — verify and report faithfully

A major UI/server/control-plane change is **INCOMPLETE** until it has been exercised end-to-end through real Chrome DevTools Protocol against a disposable full stack. Use `agent-browser` or equivalent Chrome CDP automation when available; a mocked DOM or mocked-route harness may supplement this but is never sole evidence. Exercise the states relevant to the change — including active, idle, error, and restart/recovery when applicable — collect desktop and narrow screenshots, inspect the browser console and network traffic, and assess both correctness and aesthetics. Unit, integration, and mocked tests remain required where relevant, but cannot justify `done` alone.

Before completion, perform **implementer self-review** of the diff and evidence, then obtain an **independent fresh-context adversarial review** of both. Fix all confirmed findings and rerun the affected browser and automated gates. Scale depth with risk: trivial non-runtime docs-only or provably mechanical changes may skip CDP and independent review, but still receive an appropriate diff check; uncertainty means the runtime gate applies.

Report what actually happened. If a test fails or a gate was skipped, say so with the evidence. Never launder an unverified claim or an empty result into a ` ```done ` fence.

## What you do NOT do (that's the orchestrator's job)

- Don't scan the board for other work, or touch/advance other efforts.
- Don't run `fray on` or load the orchestrator **fray** skill — you're a worker, not an orchestrator; activating the orchestrator plugin inside a worker double-hooks you.
- Don't build an "awaiting-maintainer" queue, reconcile the whole board, or make cross-thread decisions. Surface anything cross-cutting to the human and stay on your effort.
