# Fray for Codex

Fray turns one Codex chat into an explicit orchestration session. The root chat owns priorities,
cross-workstream decisions, dispatch, reconciliation, and the human-facing synthesis. Substantive
research, implementation, verification, planning, and review run in bounded native Codex agents.

This is deliberately lighter than the classic Claude Code implementation. It uses Codex's native
agent threads and completion state instead of lifecycle hooks or a Cartesian matrix of custom-agent
profiles. For an explicit multi-workstream orchestration it does create a concise, durable
`.fray/threads/<CODEX_THREAD_ID>/scratch.md`: the root uses this universal thread scratch document as
concise, human-readable notes for open work, owners, constraints, and verification. A worker may keep a task-local scratchpad when
compaction or a large evidence set makes one useful at
`.fray/threads/<child-CODEX_THREAD_ID>/scratch.md`; the orchestrator does not mirror every worker's
notes. `.fray/plans/*.md` remains exclusively for user plans.

## Install from GitHub

Requires a current Codex release with plugin and native subagent support. This release is tested with
Codex CLI 0.144.3.

```sh
codex plugin marketplace add colinhacks/fray --ref main
codex plugin add fray-codex@fray
```

Start a new Codex thread after installation. Invoke the orchestration skill with its exact
plugin-qualified name:

```text
Use $fray-codex:fray-orchestrator to coordinate these workstreams: ...
```

The skill is explicit-only. A generic mention of Fray, a single direct task, or a task described as
research, audit, implementation, planning, verification, or review does not activate it.

Codex namespaces skills contributed by plugins, which is why the public handle contains
`fray-codex:`. The bare `$fray-orchestrator` handle is available only when using the direct
development install described below.

Verify the package is visible and enabled:

```sh
codex plugin marketplace list
codex plugin list
```

## One-time native routing setup

Fray requires every dispatch to pass an explicit `model` and `reasoning_effort`. Some current Codex
surfaces expose a reserved `collaboration.spawn_agent` schema that omits those fields even though the
native Multi-Agent v2 runtime supports them.

On its first explicit invocation, the skill inspects the active spawn schema. If dynamic routing is
not ready, it runs its bundled `scripts/configure-native-routing.mjs install` helper. The helper
updates the user's Codex configuration to:

```toml
[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
tool_namespace = "fray"
```

Start one more new Codex thread after that change so the tool schema reloads. A working Fray session
then sees a native spawn schema with both `model` and `reasoning_effort`. The configured namespace is
`fray`, although a release may present a runtime-normalized tool name such as
`multi_agent_v1__spawn_agent`. The native AgentControl runtime, parent/child relationships, status,
steering, and completion returns remain Codex-owned.

This setup is not a claim that an undocumented schema will remain stable forever. Treat the active
tool catalog as authoritative. If the active spawn tool does not advertise both routing fields, Fray
stops and reports the limitation instead of silently spawning inherited-compute workers.

## Model and effort routing

Every Fray dispatch passes an exact model slug, an explicit effort, and `fork_context: false` so the
child starts from its self-contained task prompt rather than a parent-history fork:

- `gpt-5.6-terra` + `medium` is the default for most work, including ordinary research, bounded
  implementation, verification, review, and planning.
- `gpt-5.6-luna` + `medium` or `gpt-5.6-terra` + `medium` for fully specified mechanical QA,
  documentation, straightforward tests, and exact collection or edits. Luna is only for work whose
  decisions are already made.
- `gpt-5.6-terra` + `high` only when observed evidence demonstrates cross-layer or concurrency
  ambiguity that a medium worker cannot safely resolve.
- `gpt-5.6-sol` + `high` or `xhigh` only for genuinely high-risk runtime, persistence,
  process-control, provider-protocol, or complex-concurrency work. Use xhigh only when the evidence
  shows that high effort is inadequate for the coupled risk.

Before any Sol or xhigh spawn, the orchestrator records a concrete routing rationale in the dispatch:
the observed evidence, the specific risk or ambiguity, and why Terra + medium is inadequate. Broad
labels such as “architecture,” “substantive,” “security-sensitive,” or “review” are not sufficient.
Fray does not use Sol, xhigh, max, or ultra merely because work is important, broad, or difficult.
Intent and compute remain separate, and the account's active model catalog and effort support always
win over this policy.

## What orchestrator mode changes

After explicit invocation, the root chat stays out of substantive worker execution. It:

- preserves every unfinished user outcome unless the user supersedes it;
- creates and continuously maintains Codex's built-in visible plan plus concise scratch notes;
- assigns bounded ownership and non-overlapping write scopes;
- routes model and effort per dispatch;
- accepts new input while children are active without dropping earlier work;
- reconciles every return before reporting an outcome complete; and
- synthesizes results by user outcome rather than pasting agent transcripts.

Before multi-thread dispatch, Fray creates or refreshes the thread-isolated
`.fray/threads/<CODEX_THREAD_ID>/scratch.md` with ordinary Markdown and creates or refreshes the short
visible plan with every known outcome. At every user-message boundary, it refreshes native agents,
updates the notes with reports, corrections, or constraints, and immediately updates the visible-plan
summary before materially acting. It preserves unfinished outcomes unless explicitly superseded or
deferred, and never marks one complete merely because an agent returned or another became more urgent.
The notes record only the useful context: owner, evidence, material constraints, and verification still
needed. Native agent state is the execution source of truth. The scratch path uses exact
`CODEX_THREAD_ID`; if it is unavailable, Fray keeps continuity in the native thread rather than scanning
for or borrowing another thread's notes. Before final handoff, Fray re-reads the scratch notes and runs
a zero-drop audit across conversation requests, plan entries, and live/completed agents.

When an unresolved choice would materially change scope, deliverable, authority, cost, risk, or the
user's preferred outcome, Fray stops that lane and uses Codex's native blocking `request_user_input`
card when available. The card gives concrete options, puts the recommended option first, and explains
the tradeoff; Fray does not substitute a prose question. It proceeds autonomously for facts that safe
inspection can discover and for bounded, reversible, or nonmaterial defaults, while independent work
continues.

## Agent completion invariant

Once Fray spawns an agent, it lets that agent run to a terminal return. A changed requirement travels
through the agent's message or queued-follow-up path; the root reconciles obsolete or conflicting
results after return. It never interrupts active agents to reduce churn, reclaim slots or quota,
redirect work, respond to a steer, contain live-server instability, or hurry completion. An
interruption can leave partially applied edits, tests, and owned processes behind, which is an unsound
state. Isolate or restart only the affected unstable service, never an agent that may be writing. If an
agent appears hung or continuing would be dangerous, Fray asks the user through the interactive
question path. The only exception is an explicit user instruction naming the interruption.

## Browser QA and helper-process hygiene

The plugin bundles the official `chrome-devtools-mcp` server for browser QA. Each Codex session gets
an isolated Chrome profile, page-ID routing keeps concurrent agents on their owned targets, and usage
statistics are disabled. Install or update the plugin and start a new thread before expecting the MCP
tools in the active inventory.

For any delegated task that launches a browser, agent-browser session, Chrome DevTools MCP, or helper
process, Fray requires a minimum, uniquely named owned session/server—normally one reused for desktop
and narrow/mobile checks. The worker must close its exact session/server through a `finally`, trap, or
equivalent path on success, failure, or interruption; it must never global-close another agent's
session. Before returning, it verifies its owned session/server and helper-process tree are gone, and
reports that cleanup confirmation with screenshot and console evidence. Chrome DevTools MCP is preferred
when available to the current Codex provider; `agent-browser` or the repository Puppeteer harness is an
explicit fallback. The root does not reconcile a browser-QA outcome as complete without screenshot and
console/page-error evidence, optical-review results, and cleanup confirmation.

## Fray UI workers are intentionally different

A Codex worker launched from Fray UI is an independent top-level Codex process assigned one dashboard
task. It is not the portfolio orchestrator. Fray UI suppresses the orchestration skill for that
process and injects a smaller worker contract:

- own exactly the assigned task and work solo by default;
- do not coordinate sibling dashboard efforts;
- delegate only when the task or a later human message explicitly requests subagents,
  parallelization, or independent review;
- when delegation is authorized, use explicit model and effort routing and reconcile every child
  before returning.

This keeps nested delegation available without turning every Fray UI card into another full Fray
portfolio.

## GitHub CI and review monitors

Fray's canonical portable sources live at repository `monitors/`; byte-identical packaged copies of
`ci-watch.mjs` and `review-watch.mjs` sit beside this skill. Agents first inspect project-local
`AGENTS.md`, skills, docs, package scripts, and declared tooling. An explicit local monitor wins only
after its absolute command and terminal event/exit semantics are validated; invalid declared tooling is
a visible configuration error, never silently shadowed by Fray. Agents never choose a monitor merely
by filename. The bundled copies are the fallback and use active, owned `gh` CLI monitoring rather than treating `awaiting ci:` or a partial
`gh pr checks` rollup as a wake mechanism. The CI monitor combines PR checks with workflow runs for
the exact head SHA: `ACTION_REQUIRED` fork gates are pending, not green. The review monitor wakes only
on new non-bot activity after its baseline. Neither script exposes GitHub credentials or detaches a
process; cancelling the worker cancels its monitor, and restarting launches a new owned monitor.

Fray UI's server scheduler remains the durable fallback for wall-clock `timer:` and external-human
`human:` + `github-review:` gates. It is not a substitute for an active CI monitor or evidence that
the full CI matrix passed.

Codex keeps the selected monitor in one persistent `exec_command` / `write_stdin` session. A routed
Luna child is an optional concurrency choice only when the parent genuinely has independent work to do;
it is never the default or the monitor abstraction. It only runs the validated monitor to its terminal
NDJSON verdict and cannot edit, mutate GitHub, delegate, detach, or emit a timer/legacy CI fence.

## Limitations

- Plugin installation, plugin updates, routing changes, and skill renames require a new Codex thread;
  an existing thread does not reload its skill or tool inventory.
- Fray deliberately disables parent-context forking and uses fresh, self-contained child prompts.
- Changing the Multi-Agent v2 namespace to `fray` can affect prompts or integrations hardcoded to the
  literal `collaboration.*` tool name. It does not remove the native collaboration runtime.
- Available models, effort levels, concurrency, nesting depth, and rate limits depend on the active
  Codex release and account.
- Plugin installation does not itself execute the routing helper; the first explicit orchestration
  invocation performs the check and setup.
- Removing the plugin does not currently reconstruct pre-existing Multi-Agent v2 values that the
  routing helper replaced. Record custom values before setup if you need to restore them later.

## Update or remove

```sh
codex plugin marketplace upgrade fray
codex plugin add fray-codex@fray
```

Start a new thread after updating.

```sh
codex plugin remove fray-codex@fray
codex plugin marketplace remove fray
```

Plugin removal leaves the one-time `features.multi_agent_v2` routing block in `~/.codex/config.toml`.
Remove or restore that block manually only if no other workflow relies on the `fray` namespace.

## Direct development install

From this repository root:

```sh
node scripts/install-codex-skill.mjs install
node scripts/install-codex-skill.mjs check
```

This creates a rollback-safe hardlink tree at `~/.codex/skills/fray-orchestrator`, so in-place source
edits are visible immediately. Run `update` after an edit replaces an inode and `uninstall` to remove
the direct skill. During an upgrade, the installer recognizes the former broad
`~/.codex/skills/fray` skill and moves it to `~/.codex/legacy-skills/` outside skill discovery; the
backup is retained for manual recovery. Unrecognized directories named `fray` are left untouched.
Do not keep this direct install enabled alongside the marketplace plugin.

## Troubleshooting

- **The skill is missing:** run `codex plugin list`, confirm `fray-codex@fray` is enabled, and start a
  new thread. In a plugin install, use `$fray-codex:fray-orchestrator`, not the bare development name.
- **Only `collaboration.spawn_agent` appears:** let the explicit skill run its routing setup, then
  start a new thread.
- **The active spawn tool lacks model or effort:** stop; the active Codex surface does not support the
  required routing contract. Do not claim inherited compute was selected explicitly.
- **Two Fray skills appear:** remove either the direct development install or the marketplace plugin,
  then start a new thread.
- **A Fray UI worker starts orchestrating:** confirm the UI is passing its selective skill-disable
  session flag on both spawn and resume, and inspect the worker's initial contract.
