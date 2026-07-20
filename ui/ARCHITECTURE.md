# fray-ui architecture (read this before touching any package)

fray-ui is a workspace-scoped orchestration surface for fray: a localhost server + web client
(opened as a chromeless Chrome `--app=` window) showing a sidebar of `.fray/` threads and, for the
selected thread, a live embedded Claude Code terminal. The UI has ZERO intelligence: all
orchestration wisdom lives in the user-editable dispatch preamble (settings) and in the worker
plugin (`../cc-worker/`). The full plan: `../plans/standalone-ui.md`.

## Invariants

- **Workspace-scoped.** One server per repo, launched from the repo root. It watches only that
  repo's `.fray/` and only the matching `~/.claude/projects/<cwd-slug>/` session logs. No
  cross-repo anything.
- **Fray files are the source of truth for thread status.** The server imports the board logic
  from `../../cc/scripts/fray/*.mjs` (zero-dep, plain node) — NEVER duplicate the parser. Writes
  to thread files go through the same code paths as `fray-update` (import `thread-update.mjs`
  helpers), never hand-rolled markdown edits.
- **Session JSONL (`~/.claude/projects/<slug>/<session-id>.jsonl`) is telemetry only** —
  liveness, previews. Parse defensively; on schema surprise degrade to "unknown", never crash,
  never let correctness depend on it.
- **Agents are top-level interactive `claude` processes in detached tmux sessions** on the
  private socket `tmux -L fray`, session name `fray-<slug>`, spawned with a pinned
  `--session-id <uuid>`. The web terminal attaches via node-pty (`tmux -L fray attach -t ...`),
  one attach per viewing client, killed on disconnect (kills the attach client, not the session).
- **Full-snapshot SSE.** The single `/events` SSE channel pushes `{type:"board", board}` full
  snapshots (see `@fray-ui/shared` `ServerEvent`). No diff protocol.
- **Permission prompts are pane-sniffed, not derived from JSONL.** Even under `--permission-mode
  auto`, claude can pause on an interactive permission prompt with NO transcript signal (the last
  record stays assistant + `stop_reason:"tool_use"`). The tailer detects it by capturing the tmux
  pane text (only for a still-in-flight turn that's been quiet ≥4s, to avoid per-tick tmux calls)
  and matching the modal markers; the `perm-prompt` runtime rides the board snapshot with no notify
  and no unread — the sidebar's attention sort surfaces it. See `tailer.ts` `matchesPermPrompt`.
- **Human questions are ```question fenced blocks in the worker's final pre-rest message** — the
  message is the medium; there is deliberately NO question tool, sidecar file, or RPC (two earlier
  designs — a blocking MCP tool and a fray-ask CLI + .questions/ sidecars — were built and
  rejected: fragile timeouts / redundant state; the user chose fences). The block body is plain
  markdown; a TRAILING `- A. …` option list + optional `Recommendation:` line are convention-parsed
  into choice chips (web/src/lib/questionBlocks.ts); ` ```question approval ` tags a go/no-go gate.
  Answers compose into one follow-up numbered by ORIGINAL block position ("Answers:\n2. …"). The
  contract lives in ui/WORKER_PROMPT.md + cc-worker's SKILL/deny-ask hook — keep all three aligned.

## Packages

- `shared` — zod schemas + types + constants. THE contract; read `src/index.ts` first.
- `rpc` — typed query/mutation/stream over Hono (lifted from gent, unchanged). Server defines a
  `Router` in `server/src/router.ts`; web imports `type AppRouter` from it for the typed client.
- `server` — Hono app on 127.0.0.1 (default port in shared): rpc mounts at `/rpc`, SSE at
  `/events`, terminal WebSocket at `/term/:slug` (`ws` package), static web assets in prod, Vite
  middleware in dev (`src/dev.ts`). Subsystems: `bus.ts` (EventEmitter → SSE), `board.ts`
  (.fray watcher + read model), `tmux.ts`, `sessions.ts` (SQLite registry via better-sqlite3),
  `tailer.ts` (JSONL), `dispatch.ts` (thread file create + prompt compose + spawn),
  `settings.ts`.
- `web` — React 19 + Vite 8 + Tailwind v4 + valtio + TanStack Query + xterm.js.
- `cli` — canonical source-backed `fray` bin (`fray-ui` compatibility alias): canonicalize cwd's Git
  root, health-check/reuse its detached dev supervisor, atomically allocate/persist an isolated port,
  then open or focus the chromeless window. Locks and logs live under
  `~/.fray/projects/<id>/`; `src/browser.ts` is vendored from Gluon via gent.

## Conventions

- TypeScript run directly by Node 26 (type stripping) — no build step for server/cli; Vite builds web.
- ESM everywhere, `type: "module"`.
- Comments sparse and dense: design/invariant/provenance only.
- Tests: `node --test`, colocated `*.test.ts`, minimal + contract-shaped.
- Known gotcha: node-pty prebuilds lose the exec bit on `spawn-helper` (npm/pnpm strip it) —
  the server package postinstall re-chmods it. PTY code cannot run inside a sandboxed shell.
- UI state (unread, lastReadAt, session registry, settings) lives in
  `~/.fray/projects/<projectId>/ui.db` (SQLite). An ordinary/main worktree's UUID remains the repo's
  `.git/config` key `fray.id`; a linked worktree stores its own UUID at
  `<worktree-gitdir>/fray.config`, preserving ordinary state while isolating sibling DB/lock/tmux
  namespaces. NEVER store UI state in the checkout's `.fray/`.
- **Sidebar design philosophy (2026-07-09, maintainer-directed — don't regress it).** A FLOATING
  left column: NO background, NO border, NO clipping on the column itself (the New-thread pill's
  hover-scale must never clip; only the section LIST is a scroll container). Vertically centered in
  the viewport (sticky full-height wrapper; the inner column grows fit-content to
  `max-h-[calc(100vh-96px)]` — symmetric 48px margins — and scrolls internally only past that cap;
  horizontal overflow impossible by width discipline: min-w-0 everywhere + break-words titles).
  Width scales `clamp(240px, 30vw, 600px)`; it and the 720px workpane sit as a centered pair with
  one fixed 40px gutter, and the workpane itself vertically centers while shorter than the viewport
  (`my-auto`). THREE collapsible sections keyed on STATUS (`web/src/groups.ts` `sectionOf`): Active
  (active/blocked/needs-human, expanded), Plans (planning/planned — the design-phase statuses ARE
  the plans; collapsed), Inactive (done/dismissed/archived; collapsed; rows carry a status chip).
  Rows order by most-recent USER interaction (`orderByInteraction` — agent churn never reorders).
  Titles WRAP, never truncate. ONE derived indicator per row (spinner running, blue ● needs-action,
  clock/dashed-circle machine-waits, faint · idle); a petite-caps PLAN tag marks a doc with a
  `## Plan` section (derived `hasPlan`). ENTIRELY MOUSE-DRIVEN — no arrow-walk, no chevron, no focus
  machine (all deleted): a row click opens the thread's drawer (chat; the fray DOC composite for a
  never-spawned thread — `store.openThread`), and the remaining keyboard is ⌘K/⌘N/⌘I + Esc
  unwinding overlays then drawers. A ZERO-thread board (brand-new user) hides the sidebar entirely
  and centers the dispatch prompt as the whole screen.

## Experimental Codex app-server bridge foundation

- Disabled by default. `FRAY_CODEX_APP_SERVER_BRIDGE=1` constructs a lazy internal bridge; it does
  not change dispatch defaults, `backendFor`, or tmux/TUI control. The generic scoped interaction
  cards can reflect bridge-owned journal rows, but no default user flow creates those rows.
- The bridge can start new sessions and resume only native thread ids in its own SQLite ownership
  table. Existing/default/TUI Codex sessions are never imported or migrated.
- The protocol gate accepts exactly installed Codex `0.144.1`, audited from generated protocol plus
  immutable source tag `rust-v0.144.1` (`44918ea10c0f99151c6710411b4322c2f5c96bea`), over child stdio
  JSONL after `initialize` / `initialized`. Upgrades require a new exact source/protocol audit,
  fingerprint, fixtures, and diagnostic expectation; semver ranges are never accepted. It rejects
  versioned `jsonrpc` envelopes, bounds and serializes inbound records, and never retains stderr text.
  No PTY or terminal scraping.
- The child receives an explicit minimal environment, not `process.env`: executable/runtime/home,
  locale/temp, OS credential-store plumbing, proxy/custom-CA settings, and only the audited built-in
  Codex/OpenAI auth/provider variables. Fray, GitHub, Anthropic, AWS, Node injection, and arbitrary
  `CODEX_*`/`OPENAI_*` values are excluded. Arbitrary custom-provider `env_key` support remains out of
  scope until it can be derived and approved without forwarding unrelated secrets.
- Provider responses are durably claimed once, but the interaction journal remains pending until
  Codex emits `serverRequest/resolved`. A disconnect never blindly replays an unknown send; a newly
  witnessed matching server request is required. Session/turn ownership, provider RPC ids, and
  response acknowledgements remain connection-epoch and project-session scoped. Secret user-input
  delivery fails closed until a secure transient escrow exists.
- Exact response semantics are intentionally narrow: additional permissions expose turn/session
  grants plus deny (the server treats an empty granted profile as no grant), while
  `request_user_input` exposes only answer. That protocol has no decline/cancel response; cancelling
  work belongs to a separate future `turn/interrupt` control, not a fabricated interaction choice.
- Registry replacement/deletion atomically cancels old delivery rows and detaches the exact native
  binding before a lifecycle hook removes it and terminates the child. Bridge disconnect/close
  detaches active bindings, and action authority requires a live connection plus the exact active
  binding/epoch. Ordinary TUI sessions have no matching binding and are untouched.
- Scoped interaction reads expose only a provider-neutral delivery effect. `awaiting-user` is the
  sole provider-backed state that enables controls; durable `queued`/`sent` projects as noninteractive
  “Sending to runtime…” across remounts and restarts, and a missing bridge projects as
  `reconnect-required`. Transport ids, provider context/responses, and secret values never cross this
  RPC boundary. The board retains pending thread visibility but removes queued/sent work from Needs
  You until a genuinely actionable request exists.
- Dispatch selection remains intentionally deferred. Do not enable this flag as a user-facing default
  until dedicated turn-interrupt UX, secure secret-answer delivery, custom-provider environment
  policy, independent review, and real end-to-end live-thread validation are complete.
