# fray-ui

fray-ui is a workspace-scoped orchestration surface for [fray](../): a localhost server plus a web
client (opened as a normal tab in your default browser) that shows a sidebar of your repo's `.fray/`
threads and, for the selected thread, a live embedded Claude Code terminal. You dispatch agents,
watch them work, follow up, and clear the "awaiting you" queue — one server per repo. The UI itself
has zero orchestration intelligence: all the judgment lives in the user-editable dispatch preamble
(Settings) and in the [`cc-worker`](../cc-worker/) plugin that every dispatched agent loads.

## Quickstart

```bash
cd /path/to/fray/ui
nub install
nub run fray-dev:install          # one-time: writes ~/.local/bin/fray-dev → this checkout's CLI source
```

Then, from any Git repository:

```bash
cd /path/to/a/workspace
fray-dev                        # foreground immutable server + default-browser request; Ctrl-C stops it
fray-dev /path/to/other/repo    # explicitly select a repository
fray-dev --app                  # opt in to the legacy dedicated app window
fray-dev --no-app               # reuse/start and print its URL without opening a browser
fray-dev --status               # workspace, source checkout, port, supervisor PID
fray-dev --stop                 # stop only the UI server; agent tmux sessions survive
fray-dev --foreground           # compatibility spelling; Fray already runs in the foreground
```

## Production npm launcher

The development command above is deliberately source-backed. The intended production command is a
separate registry package: `npx frayui` will run the npm-resolved `frayui` package and never follow
this checkout. The current package metadata still uses the working name `fray`; migrating it to the
single-file `frayui` bundle is a separate release-packaging slice. When a published release is
available, **Update & Restart** will ask npm for a fresh immutable package execution cache, drain only
Fray's disposable HTTP control plane, and start that cache with the
same project identity, port, SQLite state, tmux socket, and provider sessions. It does not edit the
currently executing `npx` cache or replace an arbitrary global installation.

This repository has **not** published the package or verified ownership/availability of the unscoped
`frayui` npm name. The current workspace dependencies still need a maintainer-selected release closure (publish the
`@fray-ui/*` runtime packages, or build one audited bundled runtime tarball) before `npx frayui` can
be released; the npm publisher account and that packaging decision require maintainer action.
Until then, `fray-dev` is the supported command for this checkout.

`fray-dev` is source-backed only at launch: the installed shim contains an absolute, shell-safe pointer
to this checkout's `packages/cli/src/index.ts`, not a copied build. On each fresh launch after that
workspace's Fray supervisor has stopped, it selects a verified immutable artifact matching the current
source fingerprint, reuses an identical global artifact when one exists, or builds and promotes one
automatically. No manual `build`/`promote` step or repeated shim install is required. The running server
never watches this checkout and never runs HMR: edits made while it is running do nothing until you stop
Fray and run `fray-dev` again. SQLite state, persisted port, lock, legacy app profile, and tmux socket
are keyed by a stable checkout UUID. An ordinary/main worktree retains the repo's
`git config --local fray.id`; each linked Git worktree keeps a different UUID in its private Git
administrative directory. Canonical real paths make a checkout opened through a symlink reuse the
same instance, while sibling worktrees remain isolated even when their paths contain spaces.
Managed ordinary repositories use `tmux -L fray-repo-<full UUID>`; a durable migration record keeps
an attributable historical `fray-<8 chars>` server pinned until its sessions are gone, then switches
permanently without moving them. An explicit `FRAY_TMUX_SOCKET` is an unmanaged escape hatch and is
used verbatim—Fray does not inspect, migrate, or add ownership markers to that server.

`fray-dev` stays in the foreground while it serves its immutable snapshot; Ctrl-C stops only that
workspace's UI server. A second `fray-dev` verifies `/health` has both this UUID and exact canonical
worktree root, then asks the OS to open its URL in the configured default browser instead of starting
a competitor. New workspaces serialize only port allocation/startup, then run concurrently on isolated
ports and tmux sockets. `--port <n>` is an explicit new-launch request and fails clearly on a conflict.
Broken live supervisors are never silently replaced; inspect `fray-dev --status`, fix source, or use
`fray-dev --stop`.

If `~/.local/bin` is not on `PATH`, the installer prints the exact export to add. Use
`FRAY_BIN_DIR=/another/bin nub run fray-dev:install` to choose another directory; it refuses to overwrite
an unrelated `fray-dev` executable unless passed `--force`. `nub run fray-dev:check` verifies the owned
shim without changing it, and `nub run fray-dev:uninstall` removes only that owned shim. `fray-ui` remains
a package-bin alias for compatibility, but `fray-dev` is the canonical source-checkout command.

## Browser launch modes

The default `fray-dev` launch makes one standard OS request to open its localhost URL in the configured
default browser. The launcher waits for the OS handler to accept or reject that request; the browser
decides which window or process receives it. In particular, macOS may choose among running browser
instances that share one bundle identity. Fray does not scan, reuse, focus, or privately address
browser tabs. External links use native safe new-tab navigation and internal links stay in the local
browser context. `fray-dev --no-app` remains the print-only option.

`fray-dev --app` preserves the legacy dedicated/chromeless window as an explicit compatibility opt-in.
On macOS that window gets its **own Dock name ("Fray") and icon**. On the first opt-in app launch,
the launcher silently installs the Fray PWA into the project's browser profile
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

Failure at any opt-in app step (profile busy, install error, no shim found) falls back silently to
the plain `--app` window. [`packages/web/public/favicon.svg`](./packages/web/public/favicon.svg) is
the canonical icon artwork; `node scripts/generate-icons.mjs` regenerates its six tracked PNG
derivatives, while `node scripts/generate-icons.mjs --check` detects drift. On macOS,
`node scripts/generate-icons.mjs --refresh-app-icons` also refreshes the ICNS resource in idle,
metadata-verified Fray PWA shims without launching Chrome; it stages and verifies each ad-hoc-signed
bundle before swapping it into place. The manifest lives in
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
4. Agents are top-level processes in detached tmux sessions on the workspace's private, UUID-keyed socket.
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
permission and only fires when the Fray tab or window is hidden).

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
- **Escape hatch into a stuck agent.** The sessions live on the workspace socket recorded in
  `~/.fray/projects/<id>/project-launch.owner` (or `tmux-socket-migration.json` while stopped).
  Attach with `tmux -L <socket> attach -t fray-<slug>` and detach with `Ctrl-b d`.
- **Non-monorepo install** (fray-ui run against a repo outside this monorepo): set
  `FRAY_SCRIPTS_DIR` to the installed plugin's `scripts/fray` directory (the board parser) and
  `FRAY_WORKER_PLUGIN_DIR` to the `cc-worker` plugin directory.
- **Port already in use.** Omit `--port` to let `fray-dev` allocate and persist an isolated port. An
  explicit occupied port is rejected; `fray-dev --status` shows the workspace's current owner.
