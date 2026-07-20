# Unstarted Fray work: handoff

Last classified: 2026-07-13

This document contains only user-discussed work for which no implementation is evident in the current worktree. It is a dispatch handoff, not authorization to start the work. Reconfirm the item and its open decisions with the maintainer before assigning an implementation agent.

## Classification caveat

The repository is heavily modified and contains both staged and unstaged work. A changed source file, test, artifact, or live-runtime result can prove that an effort has started, even when an old `.fray` planning file still says otherwise. The reverse is not true: absence from `git status` or a text search cannot prove that nobody started an effort elsewhere. Re-audit the worktree, live board, and current maintainer intent immediately before dispatch.

## 1. Slash-command strategy and reliable terminal escape hatch

### User-facing problem and outcome

Interactive slash commands do not map cleanly onto Fray's rendered thread UI. The maintainer asked for a separate investigation of Conductor's approach, a recommendation for the smallest useful slash-command set Fray should support directly, and a credible terminal-view escape hatch for commands that remain native to Claude Code or Codex. The result should be a decision document first, not an assumed implementation.

### Evidence that it is unstarted

- The current UI has a generic `Cmd+K` action/thread palette in `ui/packages/web/src/components/CommandPalette.tsx`, but it does not expose provider slash commands.
- Claude's `/rename` has a deliberately special-purpose implementation in `ui/packages/server/src/rename-controller.ts`; current comments explicitly say Codex has no equivalent. This proves one command was handled, not that a general slash-command design was started.
- Repository searches found no Conductor research, provider command inventory, capability model, or slash-command UX plan outside unrelated OpenCode entrypoints and `/rename` handling.
- Terminal, transcript, and rendering code is already modified, so terminal reliability itself is **started work** and must not be reclassified as a new implementation. Only the unstarted slash-command product investigation belongs here.

### Scoped acceptance criteria

1. Produce a short research/decision document grounded in the current Conductor product and the installed Claude Code and Codex command surfaces.
2. Inventory native commands by backend and classify each as: useful as a first-class Fray action, safe only in Terminal, already represented by existing UI, or unsuitable for Fray.
3. Recommend a minimal first-class set and explain why every included command earns dedicated UI. Treat the existing Claude AI rename action and `Cmd+K` palette as inputs, not blank-slate designs.
4. Define the invocation model, discoverability, keyboard behavior, backend capability handling, error states, and the fallback when a command is unavailable.
5. Specify what “switch to Terminal” must guarantee before it can be advertised as the escape hatch: visible repaint without scrolling, keyboard/focus correctness, paste/submit correctness, and faithful command output.
6. Surface unresolved product choices to the maintainer and stop. Do not implement the command surface until the recommendation is approved.

### Likely relevant modules

- `ui/packages/web/src/components/CommandPalette.tsx`
- `ui/packages/web/src/components/TerminalPane.tsx`
- `ui/packages/web/src/components/ThreadActionBar.tsx`
- `ui/packages/web/src/components/ChatView.tsx`
- `ui/packages/server/src/rename-controller.ts`
- `ui/packages/server/src/tmux.ts`
- `ui/packages/server/src/terminal.ts`
- `ui/packages/server/src/backend/claude.ts`
- `ui/packages/server/src/backend/codex.ts`
- `ui/packages/shared/src/index.ts`

### Required verification for any later implementation

- Run provider-real E2E sessions for both Claude Code and Codex in a disposable Fray stack, not transcript-only fixtures.
- Exercise keyboard invocation, mouse selection, unavailable-command behavior, focus return, normal and Command-click link behavior where relevant, and the Terminal fallback.
- In Terminal, verify live line painting without a scroll/repaint nudge, resize/reflow, paste, Enter, Escape, and at least one real native slash command at desktop and narrow widths; capture screenshots and console/network errors.
- Confirm unsupported commands cannot be submitted to the wrong backend and that a failed command never presents a false success state.

### Scope boundaries and decisions to surface

- Research and recommendation come before implementation.
- Do not build a general command protocol merely because one or two commands need buttons.
- Do not inject raw control characters, scrape an unstable TUI, add AppleScript/process routing, or revive app-mode work without explicit approval. If provider APIs do not offer a robust path, report that constraint.
- Do not treat the existing `/rename` controller as proof that arbitrary native commands are safe to automate.
- Keep normal-browser operation as the default; slash-command work must not reopen the settled browser-shell decision.
- Conductor behavior is comparative evidence, not a requirement to copy its complete surface.

## 2. Persistent, stacked questions

### User-facing problem and outcome

Questions embedded in a thread are currently positional: only the latest substantive assistant message can remain answerable. A later assistant turn can strand an older unanswered question, and any later user message is treated as if it answered all earlier questions. The discussed outcome is for multiple questions to remain independently visible and answerable until the user explicitly answers or dismisses each one.

### Evidence that it is unstarted

- `.fray/question-stacking.md` records root-cause analysis and proposed forks with `status: planning`; every implementation step remains unchecked.
- `ui/packages/web/src/lib/answering.ts` still exposes one `liveMsg`, walks backward to one trailing assistant message, and returns no questions after the first later user message.
- `ui/packages/server/src/tailer.ts` still derives `pendingQuestion` from `lastAssistantHasQuestion` while the turn is idle.
- Searches found no addressed-question store, stable `(message, block)` question identity, per-question dismiss action, or persisted open-question collection.
- The broader native-interaction/permission work in the dirty tree is already started and must not be conflated with this markdown-question lifecycle feature.

The exact scope is uncertain because the planning file records recommendations but no final maintainer choice on its four forks. Reconfirm those choices before implementation.

### Scoped acceptance criteria

1. Give every rendered question block a stable identity that survives later assistant messages, event records, reloads, and server restarts.
2. Track addressed state per question. Answering or explicitly dismissing one question must not clear another; an unrelated free-form steer must not silently clear the set unless the maintainer chooses that policy.
3. Render all open questions answerable in place. Decide with the maintainer whether a compact “N open questions” navigation affordance is also required.
4. Keep queue truth and thread-view truth consistent: the thread remains in Queue while any actionable question is open and leaves only when all are addressed or another higher-priority lifecycle action applies.
5. When answering a non-trailing question, send enough question identity/context for a worker that has moved on to associate the reply correctly.
6. Persist addressed state durably and scope it to the Fray-owned thread/session generation so stale or foreign records cannot mutate a current thread.
7. Decide explicitly whether the first cut covers only fenced markdown questions or also backend-native question interactions. Do not silently broaden it.

### Likely relevant modules

- `ui/packages/web/src/lib/answering.ts`
- `ui/packages/web/src/lib/questionBlocks.ts`
- `ui/packages/web/src/components/ChatView.tsx`
- `ui/packages/web/src/components/TodosView.tsx`
- `ui/packages/web/src/components/InteractionCards.tsx`
- `ui/packages/server/src/tailer.ts`
- `ui/packages/server/src/board.ts`
- `ui/packages/server/src/storage.ts`
- `ui/packages/server/src/router.ts`
- `ui/packages/shared/src/index.ts`

### Required verification for any later implementation

- Unit-test stable identity, multiple questions in one message, questions across multiple assistant messages, event-line interleaving, partial answers, dismissals, unrelated steers, reload, restart, and session-generation replacement.
- Use a disposable real worker to raise two questions separated by later activity; answer only the older one from Queue, verify the newer one stays actionable, reload the page/server, and then answer or dismiss the remainder.
- Verify the same state in the thread drawer and Queue card at desktop and narrow widths, with screenshots plus console/network inspection.
- Test concurrent clients so one answer cannot be submitted twice or leave another client showing a stale enabled control.

### Scope boundaries and decisions to surface

- Reconfirm server-authoritative persistence versus a phased client-only first cut; the planning record recommends server authority because Queue correctness depends on it.
- Reconfirm explicit-answer-only semantics, whether per-question dismissal is allowed, and whether a bare steer affects any open question.
- Reconfirm whether the first cut includes native provider questions. Markdown fences, Codex structured interactions, and Claude terminal prompts have different trust and delivery paths.
- Do not create a generic workflow/forms engine as part of question stacking.
- Do not answer provider-native prompts by fragile TTY control injection. Use an existing structured interaction path or surface the limitation.

## Explicitly not carried forward as unstarted

The current worktree contains implementation, tests, artifacts, active review, or an assigned in-flight task for the following discussed areas, so they do not belong in this handoff: queue/rest/done/held behavior; the bottom Archive action on Done cards; the enabled bottom Snooze action on Awaiting cards; removal of the header Dismiss action; composer profile controls; `↳` sub-agent lines; sidebar `?` versus ellipsis classification; icon iteration; board provenance filtering; tmux socket migration; normal-browser default and `--app` opt-in; Fray skill migration and the scope-escalation guardrail; model/effort placement and persistence; select alignment; live thread permissions and provider prompts; rename behavior; dispatch-message hiding; tool-call/Exec rendering; queue focus; terminal/render investigations; server hot reload; global CLI/project launch; and the currently running read-only audits.

Several stale planning records also must not be dispatched blindly:

- `.fray/codex-discovery-race.md` says the race is planned, but the dirty worktree already has sentinel-authoritative discovery and concurrent same-directory regression tests in `backend/codex.ts`, `dispatch.ts`, and `backend/codex.test.ts`.
- `.fray/ci-await-mechanism.md` proposes a custom MCP await server, but the current product direction is already implemented differently: native blocking/background waits for automated work plus a durable `github-review:`/`timer:` scheduler for human or scheduled waits. A custom MCP server is not an unstarted requirement unless the maintainer explicitly reopens that design.
- `.fray/fenceless-rest-nudge.md` is superseded by the later product decision that ordinary bare rest belongs in Queue. Do not revive mandatory fencing or a nudge hook without a new decision.
- A global permanent in-flight sub-agent readout is not listed: current sidebar child rows and background-operation strips already implement a persistent readout path. Audit its UX as existing work rather than dispatching a new feature.

## Evidence checks used for this classification

- `git status --short` across the repository, including all current staged, unstaged, and untracked UI/backend work.
- `rg` searches for slash commands, Conductor, provider command handling, question identity/addressed state, live sub-agent surfaces, wait tooling, and relevant TODO/deferred markers.
- Direct inspection of `CommandPalette.tsx`, `rename-controller.ts`, `Sidebar.tsx`, `answering.ts`, `tailer.ts`, `scheduler.ts`, and the backend-specific worker prompts.
- Direct inspection of `.fray/ci-await-mechanism.md`, `.fray/plans/ci-await-mechanism.md`, `.fray/codex-discovery-race.md`, `.fray/fenceless-rest-nudge.md`, `.fray/question-stacking.md`, and `.fray/worker-contract-backend-aware.md`.
- Live-audit evidence supplied by the orchestrator: Nub health was OK; 30 Fray-owned threads were present with no board errors/warnings; representative Codex tool calls and long dispatch fixtures existed; permission values were initialized; and the listener, boot identity, tmux panes, and sessions were preserved. Browser-rendered behavior was not used to classify an item as unstarted unless static evidence independently proved that no implementation existed.
