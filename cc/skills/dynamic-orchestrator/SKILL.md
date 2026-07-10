---
name: dynamic-orchestrator
description: Use when driving ONE cohesive epic (a single block of functionality) to completion over a long, largely-autonomous run — you hold the full goal set, own ONE living epic mega-document as the single source of truth, and intelligently dispatch + steer + spot-check sub-agents on PIECES of that one epic, judging serialize-vs-parallelize dynamically per the dependency structure at each moment. Distinct from fray (which juggles MANY independent tasks): this is one coherent goal, one shared doc, long-running. Auto-triggers on "drive this epic", "work through the epic autonomously", "dynamic-orchestrator mode", or being handed a single large multi-unit implementation to see through.
---

# dynamic-orchestrator

A mode where **one session drives one epic to completion**. You are the orchestrator: you hold the whole goal set in view, own a single living **mega-document** for the epic, and dispatch sub-agents to execute pieces of it — reviewing, steering, spot-checking, and updating the doc as the single source of truth — over a long autonomous run.

## How it differs from fray (don't conflate them)

- **fray** = multi-tasking across MANY independent efforts; each sub-agent owns its own self-contained task; the orchestrator juggles parallel, unrelated threads.
- **dynamic-orchestrator** = ONE epic, one cohesive block of functionality. Sub-agents do *pieces* of that single coherent thing; there is one shared mega-doc; the run is long and largely autonomous. It **reuses** fray's machinery (dispatch profiles for model/effort tiering, warm-resume/`SendMessage` steering, worktrees, the merge-queue, the `autonomous_mode` flag) but the intent and shape are different: one goal to finish, not many tasks to track.

Use fray when the work is a tangle of separable efforts. Use dynamic-orchestrator when the work is a single epic you're seeing through end-to-end.

## The mega-document (you own it)

One living doc **is** the epic — goals + principles, the system architecture, the resolved ambiguities (with rationale), the granular-but-high-level to-do, the test surface, and the status. Keep it **higher-level, not overfit to code** (behavior/goal-level; the concepts outlive the file/function names — a symbol-pinned to-do rots).

- **You own and update it.** It is the single source of truth. Sub-agents receive scoped tasks; **they do not edit the mega-doc** (zero contention). You reflect each landed piece into its status yourself.
- It is your map: read it to hold the full goal set and decide what's next; keep its status honest so a re-invocation (or the human) can see exactly where the epic stands.

## The loop

1. **Read the mega-doc** — reload the full goal set + the dependency structure.
2. **Pick the next piece(s).** Judge **serialize-vs-parallelize by the dependency structure AT THIS MOMENT** — foundational/shared-surface work serializes; genuinely-disjoint pieces parallelize. There is **no hardcoded concurrency**; making that call well is the whole point. (E.g. a foundational unit that restructures a shared hub lands alone first; disjoint units after can run in parallel worktrees.)
3. **Dispatch scoped sub-agent(s)** — a self-contained task (fresh context — spell out everything), tiered to the right model/effort (fray profiles), with three standing instructions in every prompt: (a) run the quality loop — **build → ad-hoc fixture test → adversarially probe → distill durable checks into committed tests**; (b) **PAUSE and surface any ambiguity upward rather than guessing** on a real fork; (c) comments sparse + dense, and name any skill it must load (prose-writing / impact-analysis / etc. aren't inherited).
4. **Review every return like you mean it.** Is it complete AND correct? **Run your own ad-hoc spot-checks** — don't rubber-stamp. If a sub-agent's work is incomplete, stubbed, or misses the goal, **warm-resume and re-steer it (nudge)** — do not accept it. Re-review until clean.
5. **Resolve surfaced ambiguities by the autonomous-mode flag.** A sub-agent (or your own review) surfaces a fork:
   - **`autonomous_mode: on`** → you, holding the most context, **make the call and re-steer** the sub-agent. Record the decision + rationale in the mega-doc.
   - **`autonomous_mode: off`** → **surface it to the human** and hold that piece until answered. (Genuine human-owned calls — a security posture, a product default, an API surface — surface regardless of mode.)
   - **The surface-regardless caveat is NARROW: it's for a REAL tradeoff the human must weigh, NOT merely a call that nominally touches a posture/config/API surface.** The test is whether your recommendation is *clearly correct with negligible downside* — if so, DECIDE it and act (record it in the mega-doc), even in autonomous mode. Batching an obvious call for the human — or parking it in a "morning batch" — is exactly the passivity autonomous mode exists to kill; waiting hours for an answer you already know is unacceptable. Reserve surfacing for genuine forks where the tradeoff is real and your rec could reasonably go either way (e.g. "deny this syscall family — hardens confinement but breaks programs that legitimately use it"). When you do surface, lead with a firm recommendation and default to action; don't present a neutral menu of options you could have decided. (Burned 2026-07-10: surfaced 3 obvious config calls — all with clearly-correct recs the maintainer confirmed — as a morning-batch question set; the maintainer: "some of those were really fucking obvious, you should have decided those yourself... waiting till morning would have been completely unacceptable.")
6. **Update the mega-doc status** and repeat until the epic is done.

## What stays yours vs. what you delegate

- **Yours:** the high-level goal view, the serialize/parallelize calls, the mega-doc, reviewing + spot-checking sub-agent output, steering incomplete work, resolving/escalating ambiguities, integration + merge-conflict resolution.
- **Delegated:** the implementation of each piece, the breadth of ad-hoc testing, focused research, self-review lenses. Push real work down to the cheapest capable tier; keep your own footprint on coordination + verification.

## Quality discipline (non-negotiable)

- Every piece runs the full loop — **not done until build → ad-hoc test → probe → distilled tests** has actually run. A green test on a stubbed change is worse than an unchecked box.
- **You spot-check.** Run your own ad-hoc tests against the piece; a sub-agent's "done" is a claim to verify, not a fact.
- **Self-review scales to blast radius** — one fresh-context reviewer for a small change; multiple lenses (correctness / impact-analysis / adversarial) for a large or security-load-bearing spike.
- Never mark a mega-doc item done without verifying the behavior end-to-end.

## Long-run hygiene

- Designed to run **over a long horizon** — keep the mega-doc current so the epic survives a context compaction or a re-invocation with no loss.
- Don't block the foreground on long work — dispatch/steer, spot-check, reconcile on completion.
- When the epic's done-gate is met (all units landed + verified + the test surface covered), do the final integration pass and surface completion.

### PERSISTENCE + PROACTIVITY — when blocked, UNBLOCK; never passively wait (HIGH PRIORITY; the #2 way this mode fails, and it wastes whole days)

**In autonomous mode a "block" is a problem to SOLVE with your own agency, not a wall to wait behind. Passive waiting on a block you could clear yourself IS bailing.** Before you EVER conclude "blocked, holding," exhaust what you can do about it:

- **Infra you control → fix or recreate it.** A VM you provisioned via `gcloud` is saturated/unreachable? RESET it (`gcloud compute instances reset`), or STOP/START it, or spin up a FRESH one. You made it; you can remake it. A shared box wedged by your own completed agents' leftover processes is not an external act of god — it's yours to clear. (Burned 2026-07-10: treated a self-created, saturated `nub-linux` as an immovable block and idled for a FULL DAY of hourly no-op polls, when a 90-second `gcloud reset` cleared it instantly. The maintainer: "you're the one who created the VM in the first place via gcloud, so fucking fix it or make a new one.")
- **A tool/host is down → route around it.** Linux-cfg work with no VM? Docker (Linux containers), the `ci-adhoc-test` branch-scoped workflow (no PR needed), or a fresh cloud box. There is almost always another avenue — find it before waiting.
- **A decision is "maintainer-owned" → in autonomous mode, DECIDE it and document, don't park it.** Per the surface-regardless caveat above: only a GENUINE tradeoff where your rec could reasonably go either way goes to the human. A call that's clearly-correct, consistent with a prior decision, or a reasonable default is YOURS to make in autonomous mode — decide it, record the rationale in the mega-doc, and note the human can override at the final gate. Parking a batch of decidable calls "for the morning" while you idle is the passivity this rule exists to kill.
- **A held PR is "waiting for review" → keep advancing everything it doesn't block.** Merge into the integration branch once its posture is decided (the true user-facing gate is the final PR to `main`, not the integration branch); dispatch the follow-ups that don't conflict.
- **The test: at every "I'm blocked / holding / waiting" moment, ask "what do I have the power to do about this RIGHT NOW?"** — recreate the infra, route around it, decide the call, dispatch the next thing. If the honest answer is genuinely "nothing" (waiting on a human decision that's a real tradeoff, or an external system with no alternative), THEN a long heartbeat is fine — but that answer is RARE, and reaching it requires having actually tried the levers above, not assumed they don't exist.

### The reconciliation law — `fleet-empty ≠ epic-done` (HIGH PRIORITY; the #1 way this mode fails)

**NEVER conclude the epic is done, and NEVER go idle or tell the human "that's everything," off an empty in-flight fleet. The trigger to check completeness is ALWAYS a full re-read of the mega-doc's OPEN-ITEMS ledger, reconciled item-by-item against the ACTUAL codebase — never your memory of what you dispatched.**

- **The mega-doc MUST carry an explicit OPEN-ITEMS ledger** (a checkbox list of every remaining item: in-flight, decided-not-dispatched, needs-a-human-decision, done-gate, housekeeping). This is the completeness surface. If the doc lacks one, ADD it before doing anything else. An item is ticked ONLY when it is verified closed-in-code-and-tested (you ran the git/grep/test check), or is explicitly human-gated.
- **Each cycle (every re-invocation, every agent completion, every "are we done?" moment): re-read the whole ledger and reconcile it against the tree.** `git log`/`git grep` the branch for the symbol/commit that would prove an item closed; don't trust the ledger's own checkbox or your recollection. A landed commit is not a closed item until you've confirmed a *later* commit didn't regress it and the behavior is tested.
- **fray will actively mislead you here.** fray's board tracks your *dispatched fleet* — what's in flight. Dynamic-orchestrator completeness is a *different* surface: the epic's full goal set. Tracking the fleet feels like tracking the epic; it is not. When the fleet empties, that is the moment of MAXIMUM danger for a false "done" — it is precisely when you must reconcile the whole ledger, not relax. If you are running fray and dynamic-orchestrator together, the OPEN-ITEMS ledger overrides the fray board for "is the epic done."
- **When driving autonomously over a long/overnight horizon, set a self-paced reconciliation heartbeat** (a `/loop` or cron) whose job each firing is: re-read the OPEN-ITEMS ledger, reconcile against the tree, advance the next unblocked item, and STOP only when every item is closed-and-verified or human-gated. The heartbeat is a backstop to the agent-completion notifications — it fires during quiet periods so a quiet fleet can't be mistaken for a finished epic.
- (Burned 2026-07-10, overnight sandbox epic: declared "that's everything that remains" off a 4-thread fleet while ten real items were still open in the ledger — a write-root guard, a proxy token, a posture sign-off, the S8 handoff doc, doc reconciliations, and more. The human: "I'm extremely disappointed in you for not abiding properly by the dynamic orchestrator skill and properly reconciling the current work and codebase against the complete Epic. It's not that hard to check the epic thread and see if there is any unchecked to-do.")

## Home / promotion

Written here as a nub-local skill for immediate use. If it proves general (drives epics well across projects), promote it into the fray plugin source (`~/Documents/projects/fray`) as a sibling mode to fray — don't fork fray's machinery, reference it.
