# fray-ui

fray-ui is a workspace-scoped orchestration surface for [fray](../): a localhost server plus a web
client (opened as a chromeless Chrome `--app=` window) that shows a sidebar of your repo's `.fray/`
threads and, for the selected thread, a live embedded Claude Code terminal. You dispatch agents,
watch them work, follow up, and clear the "awaiting you" queue — one server per repo. The UI itself
has zero orchestration intelligence: all the judgment lives in the user-editable dispatch preamble
(Settings) and in the [`cc-worker`](../cc-worker/) plugin that every dispatched agent loads.

## Quickstart

```bash
pnpm install                      # from ui/ — installs all workspaces
node packages/server/src/dev.ts   # API + Vite dev middleware on :4917 for the CURRENT repo
```

Then open http://127.0.0.1:4917. For the packaged experience use the `fray-ui` bin, which ensures
the per-repo server is running and opens the chromeless app window:

```bash
node packages/cli/src/index.ts            # default: boot server + open the app window
node packages/cli/src/index.ts --no-app   # just print the URL (no window)
node packages/cli/src/index.ts --port 4930 --dev
```

Flags: `--app` is the default; `--no-app` prints the URL instead of opening a window; `--port <n>`
overrides the listen port; `--dev` embeds Vite. If no supported browser is found for app mode, the
server still comes up and the URL is printed.

## Standalone window identity (its own macOS Dock name + icon)

On macOS the fray window gets its **own Dock name ("fray") and icon** — fully hands-free. On the
first `fray-ui` launch the launcher silently installs the fray PWA into the project's browser profile
over the Chrome DevTools Protocol (`--remote-debugging-pipe` → `PWA.install` +
`PWA.changeAppUserSettings(displayMode: standalone)`; windowless, ~3-4s, once per machine). Chrome
then generates a real app-shim bundle at `~/Applications/Chrome Apps.localized/fray.app` — own
`CFBundleName`, icon rasterized from our web-app manifest — and every launch goes through that shim
(`open fray.app`), whose `app_mode_loader` hosts the window under its own bundle identity. Verified:
`lsappinfo` shows `LSDisplayName="fray"`, `Arch=ARM64`, and the Dock shows fray's own tile.
Subsequent launches detect the existing shim (~60ms) and skip the install.

Why it works this way (all verified empirically on Chrome 150 / macOS):

- A plain `--app=` window is owned by the Chrome browser process — the Dock shows "Google Chrome",
  no launch flag changes it, and a hand-rolled `.app` that `exec`s Chrome loses its identity the
  moment Chrome's Cocoa startup re-registers the process (and risks a Rosetta launch besides).
  Chrome's generated app-shim is the only mechanism that yields an own Dock identity.
- The CDP `PWA.*` domain is only exposed on `--remote-debugging-pipe` connections (port-based
  websocket clients lack `AllowUnsafeOperations`), and a CDP install defaults the app to
  open-in-a-tab — `changeAppUserSettings(displayMode: "standalone")` is the required second half;
  without it the browser answers the shim `kSuccessAndDisconnect` and windows stay Chrome-branded.
- Shim detection is stateless: the launcher scans shim `Info.plist`s for `CrAppModeShortcutURL` ==
  the launch URL and `CrAppModeUserDataDir` under the project profile. (Chrome's generated app id is
  not reproducible as a hash of the URL — don't try.)

Failure at any step (profile busy, install error, no shim found) falls back silently to the plain
`--app` window — launch never breaks. The favicon, manifest, and manifest icons live in
[`packages/web/public/`](./packages/web/public); the window title is set at runtime to
`fray · <owner/repo>` from the board snapshot.

*Windows/Linux follow-ups (not yet wired):* the launcher only brands the Dock on macOS. Windows would
set an `AppUserModelID` (+ icon) on a generated `.lnk`; Linux (X11) would pass `--class=fray` and ship
a `.desktop` file whose `StartupWMClass=fray` matches it. Both are documented TODOs.

## Architecture (10 lines)

1. Workspace-scoped: one server per repo, launched from the repo root, watching only that repo's `.fray/`.
2. `.fray/` thread files are the source of truth for thread status — the server imports fray's own
   board parser (`cc/scripts/fray/*.mjs`), never re-implements it.
3. Session JSONL (`~/.claude/projects/<slug>/*.jsonl`) is telemetry only: liveness + previews, parsed defensively.
4. Agents are top-level `claude` processes in detached tmux sessions on the private socket `tmux -L fray`.
5. The web terminal attaches per-viewer via node-pty (`tmux attach`); closing a tab kills only that attach client.
6. A single `/events` SSE channel pushes full board snapshots (no diff protocol) plus `notify` events.
7. RPC is a typed query/mutation layer over Hono at `/rpc`; the terminal is a WebSocket at `/term/:slug`.
8. `web` is React 19 + Vite + Tailwind v4 + valtio + TanStack Query + xterm.js.
9. UI state (unread, settings, session registry) lives in `~/.fray/projects/<id>/ui.db` (SQLite), never in `.fray/`.
10. Packages: `shared` (zod contract), `rpc`, `server`, `web`, `cli`. Read `ARCHITECTURE.md` before touching any.

## Settings & the dispatch preamble

Everything the UI deliberately does NOT know lives in **Settings** (gear icon): the
**dispatch preamble** is injected verbatim ahead of every dispatched agent's task, carrying the
orchestration wisdom (sub-agent discipline, git hygiene, the stop criterion). It ships from
[`DEFAULT_PREAMBLE.md`](./DEFAULT_PREAMBLE.md); edit it per project and use **Reset preamble to
default** to clear your overrides back to the shipped defaults. Settings also carry the default
permission mode, model, effort, and a desktop-notifications toggle (which requests browser
permission and only fires when the app window is hidden).

## The cc-worker plugin

Every agent fray-ui spawns loads the [`cc-worker`](../cc-worker/) Claude Code plugin
(`--plugin-dir`), which supplies the single-thread worker contract and hooks. Its hooks gate on the
`FRAY_UI_THREAD` env var, so passing it is harmless even in a non-fray repo. In the monorepo it is
found automatically as a sibling of `cc/`; a standalone install points at it with
`FRAY_WORKER_PLUGIN_DIR`.

## Troubleshooting

- **Terminal never attaches / `spawn-helper` errors.** node-pty prebuilds lose the exec bit when
  npm/pnpm unpack them. The server package's `postinstall` re-chmods it; if it didn't run, do it
  manually: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`. PTY code cannot run inside a
  sandboxed shell.
- **Escape hatch into a stuck agent.** The sessions live on a private tmux socket. Attach directly
  with `tmux -L fray attach -t fray-<slug>` (detach with `Ctrl-b d`) to drive an agent by hand.
- **Non-monorepo install** (fray-ui run against a repo outside this monorepo): set
  `FRAY_SCRIPTS_DIR` to the installed plugin's `scripts/fray` directory (the board parser) and
  `FRAY_WORKER_PLUGIN_DIR` to the `cc-worker` plugin directory.
- **Port already in use.** Another fray-ui server may hold the default port; pass `--port <n>`, or
  find the live one via `~/.fray/projects/<id>/server.lock`.
