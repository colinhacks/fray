# fray

**fray** is an orchestrator-first methodology for driving a large, mixed push — investigations + decided fixes + verifications — toward a goal through individually-dispatched background sub-agents. One main session stays the orchestrator and the only decider; sub-agents are instruments. A per-project `.fray/` thread board is the control surface, hooks handle dispatch and reconciliation, and a board/validator CLI keeps the whole effort legible.

This repository is a **monorepo of fray ports**, one per agent harness:

| Dir | Harness | What it is |
| --- | --- | --- |
| [`cc/`](cc/) | [Claude Code](https://claude.ai/code) | A Claude Code **plugin** — skill + hooks + board CLI, loaded globally, dormant per-repo until you run `/fray`. |
| [`pi/`](pi/) | [Pi](https://github.com/earendil-works) | The Pi port — extensions, prompts, and skill for the Pi coding agent. |

Future harnesses (`codex/`, `opencode/`, …) land as sibling directories.

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
  rm -rf ~/.claude/plugins/cache/fray/fray/1.0.0
  ln -s /path/to/fray/cc ~/.claude/plugins/cache/fray/fray/1.0.0
  ```
  Claude Code follows the symlink and resolves all components live. (A version bump or `claude plugin update` would re-copy and overwrite the symlink — re-create it after.)
