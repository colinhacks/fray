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

The plugin is global, but fray is **dormant in a project until that project has a `.fray/` directory.** Every hook is a silent no-op — it injects nothing, blocks nothing, creates nothing — in any repo without an opted-in `.fray/`. A virgin repo with fray installed sees zero fray output.

To activate fray in a repo, invoke the skill:

```
/fray
```

On its first invocation in a repo with no `.fray/`, the skill **bootstraps**: it creates `.fray/` and a default `.fray/config.yml`. From then on the hooks fire automatically in that project.

- **Turn fray off for THE CURRENT SESSION** (not the whole repo) — quiet one session without touching others: run `fray off`. Restore with `fray on`; revert to the default with `fray reset`; check with `fray status`. Both an agent and a human can do this via a single tool call mid-session — no relaunch.
- **Fully de-activate**: delete `.fray/`.

Enablement is **per-session**, keyed on the Claude Code session id (`CLAUDE_CODE_SESSION_ID`, the same id the hooks receive). `fray on`/`off` write a sentinel at `.fray/.session-state/<session_id>`; the hooks honor it every turn. The DEFAULT (no sentinel) is **active when `.fray/` exists** — the sentinel is a per-session override on top. There is no repo-global `enabled` flag anymore: it was repo-wide (hit every concurrent session) and couldn't be toggled mid-session.

The DX in one line: **install once → dormant everywhere → `/fray` in a repo activates it there.**

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
  - **Without agent-teams:** the board, the dispatch enforcement + epilogue, the rest/stop reconciliation guards, and the whole thread model still work. You lose only live steering and warm-resume, and fall back to the `enqueued` + `depends_on` sequencing model. It is experimental and harness-dependent — don't assume it's on.
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

There is **no stored board** and **no unified ledger** — both would be caches that drift out of sync with the threads. The board is **computed on demand** from the thread frontmatter.

### The board command

The plugin puts a `fray` command on the Bash tool's PATH. It reads the current project's `.fray/` and computes the live view:

```bash
fray               # the live board (active / enqueued / blocked / needs-decision)
fray --all         # every thread, every status
fray --status todo # one status
fray --search <q>  # find a thread by id / title / body text
fray --validate    # validate all thread frontmatter; exit 1 on error (used by the hook + CI)
fray --json        # machine-readable {config, threads, errors, warnings}
```

Thread **dependencies** are expressed in frontmatter (`depends_on: [<other-slug>]`); the board computes when every dependency has gone terminal and flips the thread to `▶ READY — dispatch now`.

### Status vocabulary

`todo · enqueued · active · blocked · needs-decision · done · dismissed`

`done` and `dismissed` are terminal and **kept forever** — each is its own file, excluded from the board and the per-turn pending list by status, so a finished thread is zero bloat. (No "clean up" step; that's the whole point of per-file threads.)

### The hooks

The plugin wires six lifecycle hooks. All of them are gated on the activation check above — silent in any project without an opted-in `.fray/`.

| Hook | Event | Job |
| :-- | :-- | :-- |
| `agent-dispatch` | `PreToolUse(Agent)` | Enforces **background** dispatch (denies any foreground Agent call), auto-appends an **orchestration epilogue** to every sub-agent prompt (so it hands back the next links in the chain), gates `THREAD:`-tagged dispatches on the thread file existing, and logs a dispatch ledger. |
| `fray-reminder` | `UserPromptSubmit` | The per-turn pulse: lists pending threads **by name**, validates frontmatter, flags un-drained queued follow-ups, and switches doctrine for autonomous mode. |
| `session-seed` | `SessionStart` | Seeds the static orchestrator role + hygiene doctrine once per session (and a re-grounding after compaction). Also detects whether Claude Code's experimental **agent teams** is enabled (fray's steering core depends on it) and, if not, injects a one-time-per-session notice with the exact global-enable steps. |
| `fray-stop-reminder` | `Stop` | Refuses to let the orchestrator go idle while a sub-agent rest sits unreconciled; surfaces idle/stale dispatched agents. |
| `fray-subagent-rest` | `SubagentStop` | Records each sub-agent rest so the Stop guard can catch an un-folded return. |

Agent liveness is **derived**, never stored — from the agent's output-file freshness plus the owning thread's status — so a hand-maintained status field can't drift and false-flag a finished agent.

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
│       ├── index.mjs        # the board + validator
│       ├── config.mjs       # shared config parse + activation gate + status vocab
│       ├── agent-liveness.mjs
│       └── agent-status.mjs  # shared derived-state logic (board + Stop hook)
├── bin/
│   └── fray                 # the board command (on the Bash PATH when enabled)
└── README.md
```

Every script is pure, dependency-free Node. The hooks read/write the *project's* `.fray/` (via `CLAUDE_PROJECT_DIR`) while their own code loads from the plugin (via `${CLAUDE_PLUGIN_ROOT}`) — that plugin-vs-data split is what lets one global install serve every project.

---

## License

MIT
