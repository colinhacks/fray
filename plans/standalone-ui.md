# Fray UI — standalone orchestration surface

A workspace-scoped UI layer over fray: a sidebar of agent threads on the left, an embedded live Claude Code terminal on the right. No AI or intelligence of its own — fray-the-methodology and Claude Code do all the thinking; this is a dumb, fast window onto them. "Superpowered `claude agents`."

## What we learned from recon

**Fray side** (`cc/scripts/fray/`): the data layer already exists and is UI-ready.

- `fray --json` (`cc/scripts/fray/index.mjs:547`) emits `{ config, threads[], errors[], warnings[] }`; each thread carries `id, title, status, status_text, mechanism (human|threads|timer), humanBlocked, ready, dependsOn, owner, revalidate, agents[], blockers[]`. This is the read model, done.
- The modules are pure, dependency-free Node `.mjs` — a server can `import` them directly instead of shelling out. `config.mjs` is the schema authority (status vocab, block-mechanism derivation, staleness math).
- `fray-update` (`cc/scripts/fray/thread-update.mjs`) is the structured, atomic write path — the UI never hand-edits thread markdown.
- The worker contract ("here's your thread file, edit it in place, statuses mean X") is already written down in `cc/skills/fray/SKILL.md`. The UI reuses it verbatim as the dispatch preamble.
- Threads live in `<repo>/.fray/*.md` → workspace scoping is free: one server instance per repo, watching that repo's `.fray/` only.

**GENT side** (`~/Documents/projects/gent`): the app-shell and transport layer already exist.

- Hono server + hand-rolled typed RPC (`packages/rpc/` — query=GET, mutation=POST, stream=SSE, Proxy-typed client + React Query hooks). Reusable as-is.
- One global SSE channel (`/events`) fed by an in-process EventBus, with heartbeat + client reconnect. Reusable as-is.
- Chromeless window: `packages/cli/src/browser.ts` is Gluon (CanadaHonk, MIT) vendored down to one file. Chrome `--app=<url>` = no URL bar, no tabs; Firefox fallback via userChrome.css. Reusable as-is.
- React 19 + Vite 8 + Tailwind v4 + valtio + TanStack Query, dev server unified on one port. Reusable pattern.
- Per-project SQLite (`better-sqlite3` + drizzle) keyed by a UUID stashed in `.git/config` (`gent.id`), plus `server.lock` `{pid, port}` for single-instance detection. Reusable pattern.
- GENT has **no** PTY/terminal code (its Claude adapter is the in-process Agent SDK). The terminal pane is the one genuinely new subsystem.

**Claude Code side** (verified against installed CLI, v2.1.x):

- `--session-id <uuid>` lets us **pin** the session ID at spawn → we always know exactly which log file is ours: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.
- `-r/--resume <id>` resumes a finished session with a new prompt — that's the follow-up mechanism.
- Session JSONL is typed records (`user`, `assistant`, `queue-operation`, …) each carrying `sessionId`, `cwd`, `gitBranch`, `timestamp` — good enough for liveness/last-message telemetry without deep reverse engineering.
- Interactive `claude` in a PTY authenticates via the normal OAuth keychain → **subscription billing works**. No API key, no SDK metering.

## The shell decision

| Option | Terminal embedding | Effort | Verdict |
|---|---|---|---|
| **A. Localhost server + Chrome `--app` (GENT pattern)** | xterm.js in the page + node-pty on the server, I/O over WebSocket. This is literally how VS Code's integrated terminal works (xterm.js), and how code-server/Codespaces render full TUIs in a plain browser tab. Claude Code's TUI (ink) renders fine in it. | Low — ~70% of the stack is lift-and-shift from GENT | **Recommended** |
| B. Native Mac app (Swift/AppKit + SwiftTerm) | Best-in-class feel, real Cmd-key handling | High — greenfield, no GENT reuse, Mac-only, slow iteration | Defer; revisit only if the browser terminal *feels* bad after M0 |
| C. Electron | node-pty in-process, same xterm.js frontend | Medium — packaging/signing/updater tax for little gain over A | No |
| D. Tauri | Needs a Rust PTY bridge; webview is Safari-based (worse xterm perf than Chromium) | Medium | No |
| E. Pure TUI (fray board inside tmux) | Native by definition | Low, but it's not the product you described | No |

The instinct that "embedding the shell won't work in a browser" is the one assumption recon disproves: xterm.js + node-pty over a WebSocket is boring, proven tech. The failure modes are small (Cmd+W closes the app window; a few shortcuts get eaten by Chrome) and none block the core experience. So: **Option A**, with M0 explicitly structured to kill this risk first — if the spike feels bad, we swap the shell (B) while keeping the entire server unchanged, because the server/client split means the shell is disposable.

## Process model: tmux-backed PTYs

Each thread's agent is a **top-level interactive `claude` process** (not an Agent-tool subagent — the UI replaces the orchestrator session), run inside a **detached tmux session on a private socket**:

```
tmux -L fray new-session -d -s fray-<slug> -x 220 -y 50 \
  claude --session-id <uuid> -n "<thread title>" "<dispatch prompt>"
```

- **Why tmux and not bare node-pty:** sessions survive fray-ui server restarts and crashes (reattach on boot instead of orphaning work); the user can always `tmux -L fray attach -t fray-<slug>` from a real terminal as an escape hatch; kill/list/liveness come free (`tmux list-sessions`, pane PID).
- **Why a private socket (`-L fray`):** never collides with the user's own tmux.
- The web terminal attaches via node-pty spawning `tmux -L fray attach -t fray-<slug>`; xterm.js resize events → pty resize → tmux handles reflow. Detach on pane blur is optional (attach-on-view keeps server PTY count = 1, not N).
- Subscription auth: interactive `claude` reads keychain OAuth as usual. Nothing special needed — tmux buys durability, not auth.
- The spawned session has the fray plugin active like any other session in this repo, so all fray hooks/skills apply to it and it can dispatch its own `fray-*` sub-agents normally. Turtles all the way down, exactly as today.

## Status tracking: three signals, no fragile reverse-engineering

Core insight: **the `.fray/<slug>.md` file is the primary status channel** — the worker is already contractually required to keep it updated. The JSONL log and process state are secondary telemetry. Combined:

1. **Fray board** — watch `.fray/` (`@parcel/watcher`, already a GENT dep), re-derive board via imported fray modules on change, diff, publish to SSE bus. Gives: `status` (planning/planned/active/blocked/done/dismissed), `mechanism` (human/threads/timer), `status_text`, deps. `blocked` + `mechanism: human` **is** the needs-decision state — surface loud (yellow, top of sidebar, matching fray's own "⚖ awaiting you" queue).
2. **Session JSONL tail** — incremental tail of `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (we pinned the ID). Gives: agent alive-and-thinking vs idle (last record type/age), last assistant text for sidebar previews, token/turn counts. Treat as best-effort: parse defensively, degrade to "unknown" on schema drift, never make correctness depend on it.
3. **Process state** — tmux session exists + pane PID alive → running; gone → exited.

Derived per-thread runtime state machine (server-side, dumb):

```
spawning → running → { turn-idle (waiting at prompt) | needs-decision (fray: blocked/human)
                     | exited-unread | done }
```

## Unread / lifecycle semantics

Two orthogonal bits, stored in the UI's SQLite (never in the thread file — fray files stay agent-territory):

- **Unread**: set when the agent's turn ends or process exits after `lastReadAt`; badge (dot + bold) in the sidebar; sticks until explicitly cleared. Merely *viewing* the pane does not clear it — there's an explicit ack.
- **Complete**: user clicks "Mark complete" → clears unread **and** calls `fray-update <slug> --status done` (via the real write path, so validation/stamping applies). Distinct "Dismiss" maps to `--status dismissed`. An agent self-reporting done still shows unread until the human acks — that's the whole point.

**Follow-ups**: input box under the terminal pane. If the process is alive → inject into the PTY (bracketed paste + Enter, exactly like typing). If exited → respawn in the same tmux session name: `claude -r <session-id> "<message>"` (same pinned ID keeps the log continuous; `--fork-session` deliberately not used). Either way the thread flips back to running.

## Dispatch flow (new task)

1. User hits "New thread", types the task, picks permission mode (default `acceptEdits`; `plan` and `bypassPermissions` available) and optionally model/effort.
2. Server creates the thread file via `fray-update --create` equivalents — slug, title, `status: active`, Goal section = the prompt.
3. Server composes the dispatch prompt: `THREAD: <slug>` header + the user's task + the fray worker preamble (pointer to its thread file, the edit-in-place ownership contract, status vocabulary, "update continuously") — sourced from/aligned with `cc/skills/fray/SKILL.md` so there is exactly one contract.
4. Spawn in tmux as above; record `{slug, sessionId, tmuxName, pid, startedAt}` in SQLite; sidebar row appears immediately with a live pane.

Because the permission UI is Claude Code's own TUI rendered live in the pane, interactive permission prompts, plan-mode approval, and AskUserQuestion all *just work* — a decisive advantage of the PTY approach over any SDK/headless integration.

## Workspace scoping

- `fray ui` (or `npx fray-ui`) is run **inside a repo**; the server binds `127.0.0.1:<port>`, serves only that repo's `.fray/`, and computes the one matching `~/.claude/projects/<slug>/` log dir. There is no cross-repo view, by design.
- Per-repo identity: UUID in `.git/config` (`fray.id`, GENT's pattern); UI state DB at `~/.fray/projects/<id>/ui.db`; `server.lock` with `{pid, port}` so a second launch in the same repo just opens a window against the running server.
- Multiple repos = multiple servers on different ports = multiple app windows. Fully isolated.

## Repo layout & packaging

New pnpm workspace inside the fray monorepo (sibling to `cc/`, `pi/`, `codex/`, `opencode/` — it's the fifth port, sort of):

```
ui/
  packages/
    cli/        # `fray-ui` bin: find repo, lock/launch server, open chromeless window (browser.ts vendored from gent, credit Gluon/CanadaHonk)
    server/     # Hono + rpc + SSE bus + SQLite; fray-board watcher; tmux/pty manager; jsonl tailer; dispatch composer
    rpc/        # lifted from gent (or extracted to a shared dep later)
    web/        # React 19 + Vite + Tailwind + valtio + xterm.js
    shared/     # zod schemas / types
```

Server imports `cc/scripts/fray/*.mjs` directly (they're zero-dep by design) — no duplicate parser, no drift. New deps beyond GENT's set: `node-pty`, `@xterm/xterm` (+ `@xterm/addon-fit`, `@xterm/addon-webgl`), `ws` (terminal I/O wants a WebSocket; SSE stays for everything else).

## UI sketch

```
┌──────────────┬──────────────────────────────────────────┐
│ ⚖ AWAITING   │  auth-refactor            [claude TUI]   │
│ ● auth-refa… │ ┌──────────────────────────────────────┐ │
│              │ │                                      │ │
│ ▶ RUNNING    │ │   (xterm.js pane — live Claude       │ │
│   pdf-export │ │    Code session, fully interactive)  │ │
│   ci-flake   │ │                                      │ │
│              │ └──────────────────────────────────────┘ │
│ ◌ BLOCKED    │  status: blocked (awaiting you)          │
│   deploy-v2  │  "Pick auth lib: better-auth vs lucia"   │
│              │ ┌──────────────────────────────────────┐ │
│ ✓ DONE (2)   │ │ follow-up…                    [send] │ │
│ [ + new ]    │ └──────────────[mark complete][dismiss]┘ │
└──────────────┴──────────────────────────────────────────┘
```

Sidebar groups mirror fray's own board ordering (awaiting-you first, then running/active, blocked-on-machine, parked, terminal). Unread dot per row; `status_text` as the row subtitle.

## Milestones

**M0 — kill the risk (≈2–3 days).** Throwaway spike: tmux(-L fray) → node-pty attach → WebSocket → xterm.js in a `chrome --app` window, running real interactive `claude`. Acceptance: TUI renders correctly (colors, spinner, ink redraws), keyboard is complete (arrows, Enter, Esc, paste, Ctrl-C), resize reflows, permission prompt is answerable, feels < 50ms local. **This gate decides Option A vs B before anything else is built.**

**M1 — core loop (≈1–1.5 wks).** Scaffold `ui/` from GENT (rpc, SSE bus, Vite/React shell, SQLite, lock/launch). Fray-board watcher → SSE. Sidebar + terminal pane. New-thread dispatch with pinned session IDs. Sessions registry table.

**M2 — lifecycle (≈1 wk).** Unread badges + mark-complete/dismiss wired to `fray-update`. Follow-up box (PTY inject / `-r` resume). Needs-decision surfacing with `status_text`. JSONL tailer for liveness + last-message previews. Server-restart recovery: rebind existing tmux sessions from the registry.

**M3 — polish (≈1 wk).** macOS notifications on unread/needs-decision (terminal-notifier or Web Notifications). Thread detail drawer (rendered thread .md, Decisions/Next-step). Command palette (cmdk). `fray ui` packaging + `--app` default-on. Docs.

**Deferred, deliberately:** native Mac app (only if M0 fails the feel test); multi-repo switcher (explicitly unwanted); worktrees (explicitly out of scope); any intelligence in the UI layer.

## Risks & mitigations

- **JSONL schema drift across Claude Code versions** → it's telemetry only; correctness rides on `.fray/` files + process state. Defensive parsing, version-tag the parser.
- **Chrome `--app` chrome-isms** (Cmd+W closes window, some shortcuts eaten) → acceptable for v1; document; native app remains the exit ramp.
- **xterm.js perf under ink's heavy redraws** → WebGL renderer addon; attach-on-view so only the focused pane streams.
- **Prompt injection into PTY vs TUI state** (e.g. agent mid-permission-prompt when a follow-up arrives) → queue follow-ups server-side and inject only when the JSONL/PTY indicates the prompt is idle; otherwise tell the user to answer in-pane.
- **Two writers to thread files** → UI writes only via `fray-update` (atomic, validated); agents own their files per the existing contract.
- **`--session-id` pinning or `-r` behavior changes** → both are stable public flags; smoke-test in CI against the installed CLI.
