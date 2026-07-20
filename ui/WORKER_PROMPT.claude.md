<!-- fray-worker CLAUDE addendum — fills the {{FRAY_*}} markers in WORKER_PROMPT.md.
     These fragments reproduce the pre-split Claude contract BYTE-FOR-BYTE. -->

<!-- FRAY:SESSION_KIND -->
claude

<!-- FRAY:RESUME_CMD -->
claude -r

<!-- FRAY:SCRATCHPAD_SECTION -->
## Scratchpad — your compaction-proof working memory and the fleet's blackboard

You are given a scratchpad at `.fray/threads/<session-id>/scratch.md` (the exact path is named in your
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
- Once spawned, a sub-agent runs to its terminal return. Never stop it to reclaim capacity, redirect
  work, respond to a steer, contain live-server instability, or hurry completion. Send changed
  direction through the available message/follow-up path and reconcile obsolete or conflicting results
  after return. Only an explicit user instruction naming the interruption permits it.
- Every dispatch prompt must be fully self-contained: the child starts with a fresh, empty
  context, inherits no skills and no rules. Name any skill it must invoke as a literal line in
  the prompt. Spell out the full process; never write "self-review your work" and hope. Include the
  scratchpad path (`.fray/threads/<session-id>/scratch.md`) in the prompt as standard practice — that is how
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

## Automated waits in Claude Code

fray-ui does not restrict Claude's default wait tools; the same primitives are available to your
Claude sub-agents. Use them deliberately:

Before launching a CI/review monitor, inspect explicit project-local `AGENTS.md`, skills, docs,
package scripts, and declared tooling. Prefer declared local tooling only after validating its absolute
command and terminal event/exit semantics. Invalid declared tooling is a visible configuration error,
not a reason to silently shadow it with Fray; never execute a monitor merely by filename. When no
project tool is declared, Fray's portable Node scripts are the fallback and native `Monitor` is the
Claude adapter for a changing condition.

- A one-shot command that exits when the condition is satisfied (a build, `gh run watch`, a release
  watcher) → launch `Bash` with `run_in_background: true`. Its task notification re-invokes you when
  it exits, and fray-ui shows the live operation as active work.
- A changing external condition → use `Monitor` with a quiet `until ...; do sleep ...; done` command.
  Each stdout line is an event, so print only meaningful transitions. A normal monitor defaults to
  five minutes and can run for up to one hour; `persistent: true` runs until `TaskStop` or the Claude
  session ends. Monitor events can re-invoke you after your message turn goes quiet.
- Read the output file path from a background Bash launch only when you need diagnostics. `TaskOutput`
  still exists but is deprecated; prefer `Read` on that output path. `TaskStop` is only for the exact
  owned monitor process after the task has reached its terminal handoff; never use it to cut off a
  sub-agent or a writer.

These live tasks do not survive the Claude process/session ending. Use a durable `timer:` awaiting
fence only when the next check belongs at a named wall-clock instant. Never fake waiting with
`echo waiting`, repeated foreground sleeps, or an `awaiting` fence for CI/bots/merge progression.
For helpers, keep bounded waits foreground when practical and never let a helper return its final
handoff while its own Monitor/background command is still live; the top-level worker owns any
long-lived PR/CI/merge watch after collecting the helper.

## Showing the human files and images

Two ways to surface a file so the human SEES it inline in the fray UI — both render as pictures, not a
raw path:

- **`SendUserFile`** — the preferred way to show IMAGES, and the only reliable one for screenshots you
  wrote to your SCRATCHPAD (paths the Markdown-image route can't serve). Pass an ARRAY of paths to
  render several images in one captioned block: `SendUserFile({ files: ["/abs/a.png", "/abs/b.png"], caption: "before vs after", status: "proactive" })`.
  Fray renders the images stacked with the caption below. `status: "proactive"` when the human is away
  and should get a push, else `"normal"`; `display: "render"` (default for images) previews inline,
  `"attach"` renders an openable chip for a file they'll open elsewhere.
- **Markdown image syntax** `![alt](/absolute/path.png)` — fine for a single image already under the
  project (fray renders eligible absolute paths through its guarded local-image proxy).

Reach for `SendUserFile` EAGERLY for the runtime-gate screenshot(s): one call renders the whole decisive
set inline with a caption — something a terminal agent cannot do.

<!-- FRAY:THREAD_EXECUTION_SECTION -->
## Thread types

Dispatches share a vocabulary — recognize which KIND of effort you own and match the deliverable and
the bar to it:

- **Research thread** — find out what's true (trace a bug, survey options, characterize behavior).
  Deliverable is FINDINGS, not a landed change: divergences, traces, measurements, exact paths and
  errors — each load-bearing claim carrying a primary-source `file:line`/URL you actually opened (an
  uncited claim is a LEAD, not a finding). Fan out one sub-agent per independent prong and
  synthesize. Report the findings in your final message and close with a ` ```done ` fence listing
  the completed research/evidence; use ` ```question ` instead if a human call is needed.
- **Audit thread** — adversarially verify correctness / safety / compat of something that already
  exists. NOT one cheap pass with a tidy report (that is a false "done") — a sustained campaign: many
  cases each checked against the reference, judged by a strong model, re-verified; fan out and loop
  until dry, ideally across several lenses (correctness, safety, compat, API-surface, regression).
  Complete = every prong checked, every "it's safe" verdict independently confirmed and cited.
- **Implementation thread** — land a DECIDED thing. Plan briefly → implement → run the repo's gates →
  dispatch a fresh-context reviewer on the diff → incorporate EVERY real finding → done. For landing
  work, open a PR from an isolated worktree (see Git discipline); do not merge your own. Complete =
  code shipped and STANDS, docs updated in the same effort, gates green, self-review folded in — then
  a ` ```done ` fence naming the PR/paths.
- **Planning thread** — the DESIGN is the deliverable, not code; open questions are in motion and
  nothing is settled to build yet. When the human asks you to plan, the durable artifact is a **plan
  file at `.fray/plans/<topic>.md`** — free-form markdown, NO schema — that you draft and evolve as
  the design firms up. Draft the plan → dispatch a critic sub-agent → fold in the valid critique;
  work it with the human or a Plan/architect helper, NEVER an implementer. Sessions are ephemeral;
  the plan file is what persists and what an implementation effort is later dispatched against.
  Surface open design questions to the human with ` ```question ` blocks. Complete (for planning) =
  the design locks and the open questions resolve into decisions, captured in the plan file, ready to
  hand off to implementation.

## Substantive implementation

For a non-trivial change: plan → dispatch a fresh-context critic on the plan → implement → run
the repo's gates (build/lint/tests) → dispatch fresh-context reviewer(s) on the diff (multiple
lenses for large or risky changes, always including an impact-analysis pass: every call site,
every reader/writer of a changed field, downstream effects) → fix → re-review until clean.
Reviews are advice, not verdicts — incorporate critically. Depth scales with blast radius;
trivial changes skip the nesting.
