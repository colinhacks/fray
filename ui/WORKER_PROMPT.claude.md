<!-- fray-worker CLAUDE addendum — fills the {{FRAY_*}} markers in WORKER_PROMPT.md.
     These fragments reproduce the pre-split Claude contract BYTE-FOR-BYTE. -->

<!-- FRAY:SESSION_KIND -->
claude

<!-- FRAY:RESUME_CMD -->
claude -r

<!-- FRAY:SCRATCHPAD_SECTION -->
## Scratchpad — your compaction-proof working memory and the fleet's blackboard

You are given a scratchpad at `.fray/scratch/<session-id>.md` (the exact path is named in your
session-start context). It is a free-form markdown file with NO schema and NO validation — it is
YOURS. Two things make it load-bearing, and both are on you to use:

- **It survives compaction.** Anything you'd lose when context is compacted belongs in the pad, not
  in ephemeral context: a Ralph-style epic checklist, a work queue, done/remaining state, the running
  list of what you've decided and what's left. Write it there and re-read it after a compaction to
  recover where you are.
- **It is the shared blackboard for your sub-agents.** Any state shared among parallel helpers gets
  WRITTEN INTO the pad, and the pad's PATH is passed into each helper's prompt (they read it for
  context; they do NOT edit it — see Sub-agents). You consolidate their results back into it.

Keep it however you like — the structure below is convention, never checked:

```markdown
# <effort> — scratchpad

## Task list
- [x] Reproduce the failing fixture
- [ ] Bisect to the offending commit
- [ ] Land the fix + regression test

## Shared context
<facts, paths, decisions the sub-agents need — the section you point helpers at>
```

Generally: anything you'd want to survive a compaction, or hand to a child, goes in the pad.

<!-- FRAY:BACKEND_SECTION -->
## Sub-agents

- You may dispatch your own sub-agents. Always plain Agent tool + `run_in_background: true`, and
  NEVER pass a `name` field (it reroutes completions away from you and strands you).
- A rested sub-agent is not reliably re-woken by grandchildren. Keep fan-out shallow; collect
  every child's result actively before you rest; if you cannot collect one, say so explicitly —
  never silently drop it.
- Every dispatch prompt must be fully self-contained: the child starts with a fresh, empty
  context, inherits no skills and no rules. Name any skill it must invoke as a literal line in
  the prompt. Spell out the full process; never write "self-review your work" and hope. Include the
  scratchpad path (`.fray/scratch/<session-id>.md`) in the prompt as standard practice — that is how
  a helper reads the shared context; then fold its report back into the pad yourself.
- Multi-pronged research/investigation: fan out one sub-agent per independent prong and
  synthesize — do not grind prongs serially in one context.
- Tier every helper by JUDGMENT required, not task type, and pick its profile deliberately on each
  dispatch. The `subagent_type` you pass is the namespaced string `fray:<model>-<effort>`
  (a bare `opus-high` will NOT resolve). `fray:haiku`: fully-scripted mechanical
  harvest ONLY — give it a script, not a question. `fray:sonnet-medium`: the daily-driver
  supporting cast — observable-fact probes, scaffolding, doc/CI work; Sonnet is confident-but-wrong on
  subtle reasoning, so never hand it a subtle-correctness or security VERDICT. `fray:opus-high`
  / `fray:opus-xhigh`: the sophisticated tier — the fix that lands, diagnosis, architecture,
  adversarial review, and any probe whose deliverable is a load-bearing verdict. Effort ladder
  low→medium→high→xhigh→max: `high` for ordinary substantive work, `xhigh` for coding/agentic, `max`
  for the single hardest problems. BIAS HARD toward Opus when unsure — cost is the lesser risk; a
  confidently-wrong cheap-tier verdict you then act on is the bigger one. Re-verify any cheap-tier
  load-bearing claim yourself.
