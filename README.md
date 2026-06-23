# fray

**fray** is an orchestrator-first methodology for driving a large, mixed push — investigations + decided fixes + verifications — toward a goal through individually-dispatched background sub-agents. One main session stays the orchestrator and the only decider; sub-agents are instruments. A per-project `.fray/` thread board is the control surface, hooks handle dispatch and reconciliation, and a board/validator CLI keeps the whole effort legible.

This repository is a **monorepo of fray ports**, one per agent harness:

| Dir | Harness | What it is |
| --- | --- | --- |
| [`cc/`](cc/) | [Claude Code](https://claude.ai/code) | A Claude Code **plugin** — skill + hooks + board CLI, loaded globally, dormant per-repo until you run `/fray`. |
| [`pi/`](pi/) | [Pi](https://github.com/earendil-works) | The Pi port — extensions, prompts, and skill for the Pi coding agent. |

The [`codex/`](codex/) and [`opencode/`](opencode/) ports are also present.

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

The Claude Code plugin version lives in two files that MUST stay in lockstep — `cc/.claude-plugin/plugin.json` (`"version"`) and the `cc/skills/fray/SKILL.md` frontmatter (`version:`). Never edit them by hand (they drifted once that way). Bump both atomically:

```sh
node scripts/set-version.ts 1.8.0     # or: nub scripts/set-version.ts 1.8.0
```

The script validates the semver, writes both files, and prints what changed. `node scripts/set-version.ts --check` verifies they agree and exits nonzero on drift — CI (`.github/workflows/version-check.yml`) runs it on every push/PR. The other ports (`codex/`, `pi/`, `opencode/`) are on independent version tracks and are deliberately not touched by this script.

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
