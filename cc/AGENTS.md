# AGENTS.md — fray plugin development

Orientation for AI agents (and humans) working on the **fray** Claude Code plugin.

## ALWAYS bump the version on EVERY runtime change — NON-NEGOTIABLE (read first)

Claude Code's plugin cache is **version-keyed**: it stores each plugin at `~/.claude/plugins/cache/<marketplace>/fray/<version>/` and only re-fetches when the **version string changes**. If you edit a runtime component (hooks, skills, agents, MCP) WITHOUT bumping the version, **Claude keeps running the cached OLD copy** — your change silently never ships. (This bit us: a fixed, deduped rest-guard hook sat in source while the cache kept serving the stale `1.1.0` verbose copy for days.)

So: **bump the `version` on every change that affects what the plugin does — before you commit.** The version string lives in TWO places that MUST stay in sync (a version-drift check fails if they diverge):

- `.claude-plugin/plugin.json` → `"version"`
- `skills/fray/SKILL.md` frontmatter → `version:`

Patch-bump both for a normal change (e.g. `1.7.4 → 1.7.5`). A pure-doc edit (like this file) may stay on the current version; anything the cache serves at runtime must bump.

## Local development — load straight from this repo (no cache fighting you)

For live iteration:

- **`claude --plugin-dir <path-to-this-repo>`** — loads directly from the repo, **zero cache**. Run `/reload-plugins` after editing `hooks/`, `agents/`, or `.mcp.json` (a `SKILL.md` edit is live-immediate).
- **Alternative that removes the forgotten-bump risk entirely:** OMIT the `version` field from `plugin.json` so Claude Code uses the commit SHA as the cache key — every commit auto-busts. Trade-off: no human-readable version numbers. (We currently keep explicit versions + the bump discipline above.)
- **Force-clear the cache** (nuclear): `rm -rf ~/.claude/plugins/cache/fray` then `/reload-plugins`.

## Reload-to-apply, by component

| Component | Takes effect |
| --- | --- |
| `skills/**/SKILL.md` | live, no reload |
| `hooks/`, `agents/`, `.mcp.json`, LSP | `/reload-plugins` or restart |
| `monitors/` | restart Claude Code |
