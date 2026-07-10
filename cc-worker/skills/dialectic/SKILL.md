---
name: dialectic
description: Run a dueling-sub-agents DIALECTIC to resolve a hard or contested decision — two adversarial debater sub-agents are each assigned one side, then argue back and forth (research → steelman the opponent → refute) across at least two full round-trips, until one genuinely convinces the other on the merits OR an irreducible crux is isolated for the human. Invoke for contested design / product / architecture / naming / security / trade-off calls where a single agent's take is suspect and adversarial stress-testing adds real value. Do NOT invoke for clear, low-stakes, or already-decided questions — the ceremony isn't worth it. Triggers on "dialectic", "have two agents debate this", "steelman both sides", "argue this out adversarially", "red-team both positions".
---

# dialectic — adversarial dueling sub-agents for a contested decision

A structured debate that stress-tests a hard call before you trust a conclusion. An **L1 orchestrator** runs two **L2 debater sub-agents**, each assigned ONE side, and relays their arguments back and forth — each round demanding the debater *steelman* the opponent's latest, then *refute* it with researched counterpoints. It ends only when one side is genuinely CONVINCED on the merits, or the single **crux** the decision hinges on is isolated. The point: every claim is adversarially researched and countered, so no idea survives on assertion alone.

This composes with fray — a dialectic is a good way to work a human-`blocked` thread whose call is genuinely contested. Run it, then present the synthesis (or the isolated crux) to the human.

## When to use — and when NOT

USE it when the decision is **contested AND consequential** and a lone agent's verdict is suspect: a design/architecture trade-off with real pull both ways, a product or naming call, a security posture, "should we do X or Y" where each has a strong case. The value is the adversarial pressure — each side actively hunting the other's weakest link.

Do NOT use it for a **clear, low-stakes, or already-decided** question. If the answer is obvious, or the cost of being wrong is trivial, the two-agent ceremony is waste — just decide (or dispatch a single research agent). Reserve it for the calls where being confidently-wrong is expensive.

## Model tiering — both debaters are TOP tier

This is hard judgment work: the debaters must research, reason adversarially, and know when a concession is honest. Tier accordingly (per the fray model policy):

- **The two L2 debaters:** the sophisticated tier at HIGH+ effort — **Fable when available, else Opus** (Fable 5 is currently unavailable and hard-fails, so today that means `fray:opus-high` / `fray:opus-xhigh`; use `fray:fable-high` once Fable is back). Never a cheap tier — a confidently-wrong debater poisons the whole exercise.
- **The L1 relay/synthesis (you, or a dispatched lead):** also top tier — judging whether a concession is *genuine* and isolating the true crux is the hardest judgment in the loop.

Dispatch each debater through a fray profile (`subagent_type: fray:opus-high`, etc.), one at a time (serial — each round needs the previous round's output). The `fray:` prefix is required — a bare `opus-high` does not resolve.

## The loop

1. **Frame the two sides.** State the decision as a clean A-vs-B (or two rival theses). Give each side a crisp charge.
2. **L2-A — opening case for A.** Dispatch A: *research and make the STRONGEST evidence-grounded case for side A — claims backed by sources/experiments/citations, never asserted. Attack nothing yet; build the best A.*
3. **L2-B — steelman then refute.** Dispatch B with A's full argument in the prompt: *first STEELMAN A (restate its strongest form so A would agree you got it), then attempt REFUTATION — adversarially research each of A's claims, attack the weakest links, and make the strongest case for B.*
4. **Back to L2-A.** Dispatch A with B's rebuttal: *steelman B's counterpoints, then address each — refute it with evidence, or CONCEDE the point explicitly.*
5. **Bounce.** Keep relaying each side's latest into the other, every round demanding steelman-then-refute of the newest points. **Minimum TWO full round-trips** — each side must respond to the other at least twice (A→B→A→B→A or longer); NEVER conclude after a single exchange.
6. **Terminate** when EITHER: one side is **genuinely convinced** (concedes the thesis on the merits, not to be agreeable), OR a **crux** is isolated — the one fact or value the decision reduces to, which no further argument can dissolve.
7. **L1 synthesizes.** Report: who convinced whom and ON WHAT GROUNDS; the surviving argument; and either the CONCLUSION or the isolated CRUX + your recommendation. For a human-owned decision (a default, security posture, product/brand/API call) this is **recommend-only** — surface the crux + rec, let the human decide.

## Dispatch shape (sub-agents don't share context — carry the exchange in the prompt)

Each debater is a FRESH dispatch. It knows only what its prompt contains, so every round's prompt must carry the **accumulated exchange so far** (the decision framing + every prior round, verbatim or tightly summarized) plus the round's instruction. Sketch:

- Round 1 → A: `[decision framing] You argue SIDE A. Research and make the strongest evidence-grounded case for A. Cite every load-bearing claim to a source you actually opened; an uncited claim is a lead, not a fact.`
- Round 2 → B: `[framing] [A's full argument] You argue SIDE B. First steelman A (restate its strongest form). Then refute: adversarially research each of A's claims, attack the weakest links, and make the strongest case for B. Cite everything.`
- Round 3 → A: `[framing] [A's arg] [B's rebuttal] Steelman B's counterpoints, then address EACH — refute with evidence or explicitly concede. Do not repeat your opening; engage B's specific points.`
- Round 4 → B, Round 5 → A, … same pattern, until termination.

Keep the debaters model-consistent within a run (same tier both sides — a fair fight). Front-load each prompt with the citation requirement so no round drifts into unsourced assertion.

## Anti-patterns (the L1 actively polices these)

- **Talking past each other.** Each round MUST directly address the other side's specific, newest points — not re-run its own opening in different words. If a round ignores the opponent's actual argument, reject it and re-dispatch with "address these specific points: …".
- **False convergence.** A debater conceding to be agreeable rather than because the argument won. The L1 JUDGES whether a concession is genuine — does it name the specific evidence/argument that changed its mind? A concession with no stated reason is suspect; push back ("why, specifically?") before accepting convergence.
- **Stopping too early.** One exchange is not a dialectic. Enforce the ≥2-round-trip floor; do not let a single strong-sounding opening end it.
- **Manufactured disagreement.** The inverse — dragging out a debate past genuine convergence or a clean crux. Once a side is truly convinced or the crux is isolated (and the floor is met), STOP and synthesize; don't pad rounds for symmetry.
- **Unfair sides.** Different tiers or lopsided prompts rig the outcome. Same model tier both sides, symmetric charges, same citation bar.
