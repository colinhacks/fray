# fray

**fray** is an orchestrator-first methodology for driving a large, mixed push — investigations + decided fixes + verifications — toward a goal through individually-dispatched background sub-agents. One main session stays the orchestrator and the only decider; sub-agents are instruments. Each port uses the smallest control surface its harness needs: Claude Code uses a `.fray/` board, hooks, and a CLI, while Codex uses native agent state plus a prompt-first coordination skill packaged as a plugin.

This repository is a **monorepo of fray ports**, one per agent harness:

| Dir | Harness | What it is |
| --- | --- | --- |
| [`cc/`](cc/) | [Claude Code](https://claude.ai/code) | A Claude Code **plugin** — skill + hooks + board CLI, loaded globally, dormant per-repo until you run `/fray`. |
| [`codex/`](codex/) | [Codex](https://developers.openai.com/codex) | A minimal Codex **plugin** whose first component is the Fray orchestration skill; the plugin shell leaves room for future skills and lifecycle hooks. |
| [`pi/`](pi/) | [Pi](https://github.com/earendil-works) | The Pi port — extensions, prompts, and skill for the Pi coding agent. |
| [`codexold/`](codexold/) | Codex (legacy) | The archived hook-heavy Codex plugin and predecessor Orchestrator skill. Not installed or active. |

The [`opencode/`](opencode/) port is also present.

## Codex plugin (`codex/`)

The Codex port is an explicit, prompt-first orchestration plugin. Its classic in-chat mode is the
`fray-orchestrator` skill: once invoked, the root chat coordinates and delegates substantive work to
native Codex agents with explicit model and reasoning-effort choices. It uses native agent state and
completion returns instead of recreating Claude Fray's mandatory `.fray/` board and lifecycle hooks.

Install the public plugin directly from this GitHub repository:

```sh
codex plugin marketplace add colinhacks/fray --ref main
codex plugin add fray-codex@fray
```

Start a new Codex thread, then invoke the plugin skill explicitly as
`$fray-codex:fray-orchestrator`. Codex namespaces plugin skills; the shorter
`$fray-orchestrator` handle is used only by the direct development install below. The skill is not
implicitly discoverable, so ordinary tasks—and Fray UI workers in particular—do not enter portfolio
orchestration mode accidentally.

Current Codex builds may initially expose native spawning without per-dispatch `model` and
`reasoning_effort`. On first use, Fray checks that schema and can configure Multi-Agent v2 under the
non-reserved `fray` tool namespace; that one-time change requires one more new Codex thread. Fray
does not claim explicit compute routing when those fields were not actually passed.

See [`codex/README.md`](codex/README.md) for the complete setup, routing matrix, Fray UI boundary,
limitations, updates, and troubleshooting.

For in-place development, contributors can hardlink the bundled skill into `~/.codex/skills`:

```sh
node scripts/install-codex-skill.mjs install
node scripts/install-codex-skill.mjs check
```

The shortcut validates and hardlinks the complete `fray-orchestrator` skill, configures native dynamic
routing, and supports `update`, `check`, and `uninstall`. It also moves a recognized legacy
`~/.codex/skills/fray` install outside skill discovery so the former broad trigger cannot remain
active beside `fray-orchestrator`. Do not enable the direct skill and the marketplace-installed
plugin simultaneously. The hook-heavy predecessor remains archived under
[`codexold/`](codexold/) for reference only.

## Claude Code plugin (`cc/`)

The Claude Code plugin lives in [`cc/`](cc/). The repo root is a Claude Code **marketplace** that points at it (`source: "./cc"`), so installing is one step:

```sh
claude plugin marketplace add colinhacks/fray
claude plugin install fray@fray
```

This loads fray globally across all repos. It stays **silent and dormant** in any repo that has no `.fray/` directory — run `/fray` in a project to bootstrap the thread board and activate it there. See [`cc/README.md`](cc/README.md) for the full design, the activation/bootstrap model, and the board CLI.

### Developing fray itself (live edits)

A marketplace install copies the plugin into `~/.claude/plugins/cache`, so edits to this repo do **not** propagate to an installed copy by default. Two ways to iterate live:

- **Per-session, in-place:** `claude --plugin-dir /path/to/fray/cc` — loads the plugin from disk, no copy, edits take effect on reload.
- **Global, live propagation:** replace the cache copy with a symlink back to the source so every session picks up edits machine-wide:
  ```sh
  rm -rf ~/.claude/plugins/cache/fray/fray/1.2.0
  ln -s /path/to/fray/cc ~/.claude/plugins/cache/fray/fray/1.2.0
  ```
  Claude Code follows the symlink and resolves all components live. (A version bump or `claude plugin update` would re-copy and overwrite the symlink — re-create it after.)

### Bumping the plugin version

The Claude Code plugin version lives in two files that MUST stay in lockstep — `cc/.claude-plugin/plugin.json` (`"version"`) and the `cc/skills/fray/SKILL.md` frontmatter (`version:`). Never edit them by hand (they drifted once that way). Update both through the version script, which replaces each file atomically:

```sh
node scripts/set-version.ts 1.8.0     # or: nub scripts/set-version.ts 1.8.0
```

The script validates the semver, writes both files, and prints what changed. `node scripts/set-version.ts --check` verifies they agree and exits nonzero on drift — CI (`.github/workflows/version-check.yml`) runs it on every pull request and on pushes to `main`. The Codex plugin and the other ports (`pi/`, `opencode/`) have independent version tracks and are deliberately not touched by this script.

### Per-session enable/disable (toggleable mid-session)

Enablement is **per-session**, keyed on the Claude Code session id (`CLAUDE_CODE_SESSION_ID` — the same id the hooks receive in their stdin payload, verified equal). Toggle the CURRENT session with the board command:

```sh
fray off      # silence fray for THIS session only (other concurrent sessions unaffected)
fray on       # force fray on for THIS session
fray reset    # clear the override — back to the default
fray status   # show this session's enablement + override
```

`fray on`/`off` write a one-line sentinel at `.fray/.session-state/<session_id>`; every hook re-reads it each turn, so the toggle takes effect MID-SESSION with no relaunch — and an agent can flip it via a single tool call. The DEFAULT (no sentinel) is **active whenever `.fray/` exists**; the sentinel is a per-session override on top.

This replaces the former repo-global `enabled:` flag in `.fray/config.yml` and the launch-only `FRAY=0/1` env var — both were repo/session-wide and could not be scoped to (or toggled within) a single session. `.fray/.session-state/` is local-only runtime state under the already-gitignored `.fray/`.
