# fray

**An orchestrator-first methodology — and a Claude Code plugin that enforces it — for driving large, mixed pushes of work through individually-dispatched background sub-agents.**

A *fray* is a tangle of concurrent **threads**, each one an ongoing effort (often a chain of sub-agents: probe → fix → review → land). You — the main Claude Code session — are the **orchestrator**: you hold the whole picture, dispatch sub-agents as instruments, ingest what they return, and decide the next move. The human stays in the loop on exactly the decisions the investigations surface, and nothing gets dropped no matter how fast the work comes in.

fray is the alternative to hardcoding a multi-agent DAG up front. A pre-planned workflow fans out expensively and buries the decision points before the facts are in; fray stays cheap and dynamic by driving everything from the main session, one dispatch at a time, with a durable per-project board so the human can re-prioritize or stop after any round and lose nothing.

---

## Install

fray ships as a globally-loaded Claude Code plugin. Install once and it's available in every project — but it stays **completely dormant** until you opt a project in (see [Activation](#activation)).

```bash
# register this repo as a local marketplace, then install the plugin (user scope = all projects)
claude plugin marketplace add colinhacks/fray
claude plugin install fray@fray
```

To develop fray itself (edits take effect immediately, no cache copy), run a session with the in-place dev flag instead:

```bash
claude --plugin-dir /path/to/fray
```

> Marketplace installs are copied into `~/.claude/plugins/cache`, so edits to your local checkout don't take effect until you bump the `version` in `plugin.json` and run `/plugin marketplace update`. Use `--plugin-dir` while iterating.

---

## Activation

The plugin is global, but fray is **dormant until a SESSION opts in.** Every hook is a silent no-op — it injects nothing, blocks nothing, creates nothing — unless the repo has a `.fray/` directory AND the current session has explicitly opted in. A virgin repo with fray installed sees zero fray output; so does a fresh session in a fray repo that hasn't run `fray on`.

To activate fray for your session, invoke the skill:

```
/fray
```

Its STEP 0 runs `fray on`, which opts THIS session in. On first invocation in a repo with no `.fray/`, the skill also **bootstraps**: it creates `.fray/` and a default `.fray/config.yml`. From then on the hooks fire for any opted-in session in that project.

- **Activate / quiet THE CURRENT SESSION** (not the whole repo) — `fray on` opts this session in; `fray off` silences it; `fray reset` reverts to the dormant default; `fray status` reports the state. Both an agent and a human can do this via a single tool call mid-session — no relaunch, and without touching other sessions.
- **Fully de-activate the repo**: delete `.fray/`.

Enablement is **opt-in and per-session**, keyed on the Claude Code session id (`CLAUDE_CODE_SESSION_ID`, the same id the hooks receive). `fray on`/`off` write a sentinel at `.fray/.session-state/<session_id>`; the hooks honor it every turn. The DEFAULT (no sentinel) is **DORMANT** — a session is active only after it runs `fray on`. There is no repo-global `enabled` flag anymore: it was repo-wide (hit every concurrent session) and couldn't be toggled mid-session.

The DX in one line: **install once → dormant everywhere → `/fray` opts your session in.**

### `.fray/config.yml`

```yaml
autonomous_mode: off   # when on, the orchestrator stops asking and biases hard to action
state:                 # optional cross-cutting "what's true now" globals
  # release: v1.2.3
```

(Enablement is no longer a config field — see the per-session toggle above.)

---

## Requirements & caveats

- **fray relies on Claude Code's EXPERIMENTAL agent-teams feature** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). The always-steer core of the methodology — messaging a *running* sub-agent, warm-resuming a *completed* one, answering a question an agent raised mid-flight — depends on the `SendMessage` tool, which only exists when agent-teams is enabled. Verify with `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
  - **Without agent-teams:** the board, the dispatch enforcement + epilogue, the rest/stop reconciliation guards, and the whole thread model still work. You lose only live steering and warm-resume, and fall back to the `blocked` + `blocking_threads` sequencing model. It is experimental and harness-dependent — don't assume it's on.
- **Node is required** to run the hooks and the `fray` board command. They're dependency-free, pure-Node `.mjs` scripts — no `npm install`, no transpiler.
- The hooks **fail open**: any error, missing file, or unparseable input → they do nothing rather than disrupt your session. A broken fray never traps you.

---

## How it works

### The control surface: a directory of per-thread files

fray's state lives in `.fray/`, in the consuming project — never a single bloated `todo.md`:

- **`.fray/<slug>.md`** — one file per live, multi-step thread. The filename slug *is* the thread id. Each thread is a self-contained document with a fixed structure: `## Goal · ## Status · ## Decisions · ## Open questions · ## Steps/follow-up queue · ## Next step`.
- **`.fray/config.yml`** — non-thread globals: `autonomous_mode` and a `state:` block. (Enablement is NOT here — it's per-session; see the toggle above.)
- **`.fray/.session-state/<session_id>`** — per-session enablement sentinels (`on`/`off`), written by `fray on`/`fray off`. Local-only runtime state under the already-ignored `.fray/`.
- **`.fray/<slug>.findings/<id>.md`** — optional sub-agent findings sidecars (only for parallel fan-out; the resting state is one unified thread doc).
- **`.fray/.agent-bindings.jsonl`** — ephemeral, hook-written `agentId → thread` routing records (the `agent-bind` PostToolUse hook captures one per background dispatch from the Agent tool result). Lets the board + Stop-hook reconnect a sub-agent's return/rest to its thread — the AUTOMATIC replacement for a hand-maintained `agents:` frontmatter list. Pure routing state, never a thread's source of truth.

There is **no stored board** and **no unified ledger** — both would be caches that drift out of sync with the threads. The board is **computed on demand** from the thread frontmatter.

### The board command

The plugin puts a `fray` command on the Bash tool's PATH. It reads the current project's `.fray/` and computes the live view:

```bash
fray               # the live board (planning / active / blocked)
fray --all         # every thread, every status
fray --status planned # one status (legacy aliases todo/plan/enqueued/needs-decision accepted)
fray --search <q>  # find a thread by id / title / body text
fray reconcile     # stamp .fray/.last-reconcile = now (record a completed board reconcile)
fray --validate    # validate all thread frontmatter; exit 1 on error (used by the hook + CI)
fray --json        # machine-readable {config, threads, errors, warnings}
fray decisions     # the rich write-up of every blocked thread (the awaiting-you queue)
```

Thread **dependencies** are expressed in frontmatter (`blocking_threads: [<other-slug>]`; `depends_on` is still read as an alias); the board computes when every thread-slug dependency has gone terminal and flips the thread to `▶ READY — dispatch now`. Typed `pr:`/`issue:`/`ci:`/`external:` entries are external gates that park the thread instead of auto-firing.

### The thread updater

`fray-update` is a structured, atomic editor for a thread's frontmatter + body — a superset of a raw text edit, on the Bash PATH alongside `fray`:

```bash
fray-update <slug> --status active                      # set status (validated against the vocab)
fray-update <slug> --status blocked \
  --status-text "<the decision needed>"                 # human-blocked REQUIRES a write-up
fray-update <slug> --status blocked \
  --set blocking_threads="[other-slug]"                 # machine-blocked on another thread (auto-fires)
fray-update <slug> --set key=value                      # set any other frontmatter scalar
fray-update <slug> --patch "<find>===>><replace>"       # body find/replace, must match exactly once
fray-update <slug> --append "<text>"                    # append to the body
```

It enforces the invariant that a **human-`blocked` thread** (`status: blocked` with no `blocking_threads`/`revalidate_at` mechanism) **requires a non-empty `status_text`** (the awaiting-you queue derives from it) — a machine-blocked thread carrying a mechanism field is exempt. It auto-stamps `last_update` and prints the full queue after every edit so a pending blocker is never buried.

### Status vocabulary

`planning · planned · active · blocked · done · dismissed`

`planning` is active design discussion (surfaced in the nag); `planned` is parked, scoped-but-unworked (not nagged); `blocked` is the unified "cannot run right now" state — its **resolution-mechanism field** decides how it unblocks: no field = awaiting a HUMAN decision (surfaced + hoisted into the ⚖ awaiting-you queue, yellow), `blocking_threads` = waiting on other threads / an external gate (gray, auto-fires when thread-slug deps clear), `revalidate_at` = a re-poll timer (gray). Legacy `todo` / `plan` / `enqueued` / `needs-decision` are still accepted as read-aliases (normalized to `planned` / `planned` / `blocked` / `blocked`).

`done` and `dismissed` are terminal and **kept forever** — each is its own file, excluded from the board and the per-turn pending list by status, so a finished thread is zero bloat. (No "clean up" step; that's the whole point of per-file threads.)

### The hooks

> **v1.30.0: the board-reconciliation layer is disabled.** Only `agent-dispatch` and the `SubagentStop` rest guards remain registered — each chat session manages its own dispatched sub-agents, and no session is pulsed with the full set of in-flight fray threads (the shared-board hooks were cross-notifying concurrent sessions). `.fray/` thread files stay the durable record; the `fray` CLI computes the board on demand. The disabled registrations (`fray-reminder`, `session-seed`, `fray-stop-reminder`, `fray-notify-surface`, `agent-bind`, `fray-thread-edit-steer`, `session-end`) are parked under `_disabled_board_reconciliation` in `hooks/hooks.json`; the table rows below describe that parked layer.

The plugin wires six lifecycle hooks. All of them are gated on the activation check above — silent in any project without an opted-in `.fray/`.

| Hook | Event | Job |
| :-- | :-- | :-- |
| `agent-dispatch` | `PreToolUse(Agent)` | Enforces **background** dispatch (denies any foreground Agent call), auto-appends an **orchestration epilogue** to every sub-agent prompt (so it hands back the next links in the chain), gates `THREAD:`-tagged dispatches on the thread file existing, and logs a dispatch ledger. |
| `fray-reminder` | `UserPromptSubmit` | The per-turn pulse: lists pending threads **by name**, validates frontmatter, flags un-drained queued follow-ups, surfaces any **stranded active thread** (active, but its newest agent looks dropped — high-confidence only), emits a **board-reconcile** backstop when a non-terminal thread moved since the last reconcile (dirty-gate) or the long external-drift backstop elapsed, and switches doctrine for autonomous mode. |
| `session-seed` | `SessionStart` | Seeds the static orchestrator role + hygiene doctrine once per session (and a re-grounding after compaction). Also detects whether Claude Code's experimental **agent teams** is enabled (fray's steering core depends on it) and, if not, injects a one-time-per-session notice with the exact global-enable steps. |
| `fray-stop-reminder` | `Stop` | Refuses to let the orchestrator go idle while a sub-agent rest sits unreconciled — the **primary home for the board-reconcile nudge** (a rest is the causal event that moves board truth): folds the rest, then re-grounds + stamps `fray reconcile` LAST. Also surfaces stranded active threads + soft idle notes. |
| `fray-subagent-rest` | `SubagentStop` | Records each sub-agent rest so the Stop guard can catch an un-folded return. |

Agent liveness is **derived**, never stored — from the agent's output-file freshness plus the owning thread's status — so a hand-maintained status field can't drift and false-flag a finished agent. It is also **low-noise by construction**: each thread is judged on its **newest** bound agent only (a superseded older agent never flags), a thread whose PR is landing via the merge cascade is suppressed (it's legitimately active while it merges), and a "no live agent" flag fires only when the newest agent has been quiet past a generous threshold (45 min) **and** has rested — so an agent still inside one long tool call, or one watching CI, is never mistaken for dropped.

### The loop

There's no committed step list to march through. Each turn the orchestrator:

1. Reconciles the sub-agent returns that came in (fold facts into threads, advance status, **drain queued follow-ups**).
2. Surfaces new open questions; moves answered ones into Decisions.
3. Scans the board (`fray`) and re-derives "what's next."
4. Dispatches the next round — backgrounded, model-tiered, honoring dependencies.

The win over a hardcoded workflow: the human answers the questions the investigations raise *as they arise*, spend stays low (cheap sub-agents, no fan-out tax), and the orchestrator keeps one coherent mental model of the whole effort instead of handing it to a script.

The full methodology — model-tiering by judgment, write-ownership, the reconciliation discipline, parallelization rules, autonomous mode, the question channel — lives in the skill ([`skills/fray/SKILL.md`](skills/fray/SKILL.md)). Loading the skill loads the methodology.

---

## Layout

```text
fray/
├── .claude-plugin/
│   ├── plugin.json          # plugin manifest
│   └── marketplace.json     # single-plugin local marketplace catalog
├── skills/
│   └── fray/SKILL.md        # the methodology (the /fray skill)
├── hooks/
│   ├── hooks.json           # hook wiring (uses ${CLAUDE_PLUGIN_ROOT})
│   ├── agent-dispatch.mjs
│   ├── fray-reminder.mjs
│   ├── session-seed.mjs
│   ├── fray-stop-reminder.mjs
│   └── fray-subagent-rest.mjs
├── scripts/
│   └── fray/
│       ├── index.mjs         # the board + validator (+ on/off/status/decisions/reconcile subcommands)
│       ├── config.mjs        # shared config parse + activation gate + status vocab + reconcile-staleness
│       ├── thread-update.mjs # structured atomic thread editor (frontmatter + body)
│       ├── decisions.mjs     # the blocked / awaiting-you queue, derived from threads
│       ├── agent-liveness.mjs
│       └── agent-status.mjs  # shared derived-state logic (board + Stop hook)
├── bin/
│   ├── fray                  # the board command (on the Bash PATH when enabled)
│   └── fray-update           # the structured thread updater (on the Bash PATH when enabled)
└── README.md
```

Every script is pure, dependency-free Node. The hooks read/write the *project's* `.fray/` (via `CLAUDE_PROJECT_DIR`) while their own code loads from the plugin (via `${CLAUDE_PLUGIN_ROOT}`) — that plugin-vs-data split is what lets one global install serve every project.

---

## License

MIT
