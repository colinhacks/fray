# Fray for Codex

Fray turns one Codex chat into an explicit orchestration session. The root chat owns priorities,
cross-workstream decisions, dispatch, reconciliation, and the human-facing synthesis. Substantive
research, implementation, verification, planning, and review run in bounded native Codex agents.

This is deliberately lighter than the classic Claude Code implementation. It uses Codex's native
agent threads and completion state instead of requiring a `.fray/` board, dispatch ledger, lifecycle
hooks, or a Cartesian matrix of custom-agent profiles. A worker may keep a task-local scratchpad when
compaction or a large evidence set makes one useful; the orchestrator does not mirror every worker's
notes.

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

- `gpt-5.6-luna` + `low` for fully specified mechanical collection or edits.
- `gpt-5.6-terra` + `medium` for ordinary research, probes, tests, verification, and bounded work.
- `gpt-5.6-sol` + `high` or `xhigh` for substantive implementation, subtle diagnosis, architecture,
  security-sensitive work, and load-bearing review.
- `gpt-5.6-sol` + `max` only for the hardest leaf problems.
- `gpt-5.6-sol` + `ultra` only for an intentionally delegated lead that should orchestrate a nested
  campaign—not an ordinary worker.

Intent and compute are separate. A research task may warrant Sol; a mechanical implementation may
warrant Luna. The account's active model catalog and effort support always win over this default
matrix.

## What orchestrator mode changes

After explicit invocation, the root chat stays out of substantive worker execution. It:

- preserves every unfinished user outcome unless the user supersedes it;
- assigns bounded ownership and non-overlapping write scopes;
- routes model and effort per dispatch;
- accepts new input while children are active without dropping earlier work;
- reconciles every return before reporting an outcome complete; and
- synthesizes results by user outcome rather than pasting agent transcripts.

Native thread state is the primary execution record. Fray does not create a mandatory on-disk board.

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
