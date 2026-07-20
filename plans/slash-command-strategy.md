# Slash-command strategy and terminal escape hatch

Status: decision proposal only. Last researched 2026-07-14 against Claude Code 2.1.209 and Codex CLI 0.144.4 installed here, plus current provider and Conductor documentation. This is not implementation authorization.

## Recommendation

Do **not** build a general provider-slash-command surface, command protocol, or `/` autocomplete in Fray's chat composer. Keep the existing, deliberately special Claude **AI Rename** action as the entire first-class native-command set. It is not precedent for arbitrary command automation: it has a narrow, observed transcript result and a controller that checks session identity, idle state, empty composer, competing controls, and timeout/failure ambiguity.

Everything else belongs in one of two existing Fray surfaces:

| Need | Fray surface | Why |
| --- | --- | --- |
| Navigate Fray, open/manage threads, settings, complete/read a thread | existing `Cmd+K` Command Palette and direct controls | These are Fray actions, not provider commands. Keep `Cmd+K` as app navigation; do not overload it with a provider command menu. |
| Set a title | existing manual title editor; Claude-only AI Rename where safe | Manual naming works for both backends; Codex has no equivalent AI rename command. |
| Change launch profile | existing model/effort/profile controls | A launch/profile setting is not reliably the same as changing an already-running provider session. |
| Any provider-native command, picker, skill, plugin/MCP command, approval, or TUI workflow | existing Terminal tab / “Open terminal” route | The provider owns its live command list, arguments, state, and confirmation UI. |

The smallest new product work, if any is approved later, is **zero commands**. It is only terminal discoverability/reliability work: make “Terminal” easy to reach from the thread tab and retain the existing contextual “Open terminal” routes. Do not advertise it as a full escape hatch until the guarantees below pass real-provider E2E.

## Why this is the smallest credible boundary

Conductor is useful comparative evidence, not a template to copy. Its app treats the harness as the runtime layer and supports a full, restorable **Big Terminal Mode** for any agent or command; its Claude-style slash commands are reusable Markdown prompts shown in the chat composer. It does not establish that a workspace UI can safely replay an arbitrary native CLI command. [Conductor harnesses](https://www.conductor.build/docs/reference/harnesses), [Big Terminal Mode](https://www.conductor.build/docs/reference/big-terminal-mode), and [Conductor slash commands](https://www.conductor.build/docs/reference/slash-commands).

The providers are more divergent than their shared `/` prefix suggests:

- Claude's menu includes fixed commands, bundled/user/project/plugin/MCP skills, and availability depends on platform, plan, and environment. It accepts commands only at the start of an input. [Claude commands](https://code.claude.com/docs/en/commands), [interactive mode](https://code.claude.com/docs/en/interactive-mode).
- Codex's current CLI menu includes session configuration, context compaction, cloud/local routing, model/reasoning, review, terminal/title/status-line configuration, background-terminal inspection, and conditional platform/catalog commands. When work is active it queues slash commands for the next turn; menus and errors may therefore arrive only after it finishes. [Codex slash commands](https://developers.openai.com/codex/cli/slash-commands).
- The installed CLI helps validate executable/launch facts (`claude` 2.1.209; `codex-cli` 0.144.4), but neither non-interactive `--help` exposes a safe complete live-TUI command catalogue. A later implementation must discover native capabilities from a real session, not copy this document into a static allowlist.

This means a Fray mirror would either be incomplete, falsely universal, stale after provider updates, or require fragile screen scraping/control injection. All are worse than preserving the native terminal.

## Command inventory and classification

“Already represented” means a Fray-owned action/profile control exists; it does **not** mean Fray should submit the provider command. “Terminal-only” includes commands whose arguments, picker state, output, permissions, or availability remain provider-owned.

| Backend / native command family | Classification | Fray handling |
| --- | --- | --- |
| **Claude:** `/rename [title]` | **First-class Fray action, Claude only** | Keep existing AI Rename plus manual rename. It is the sole exception because `rename-controller` verifies the exact idle Claude pane and observes `custom-title` after submission. Never show it for Codex. |
| **Claude:** `/clear`, `/compact`, `/context`, `/rewind`, `/branch`, `/resume`, `/fork`, `/btw`, transcript/history/view controls | **Terminal-only** | They mutate or inspect provider conversation/context/TUI state that Fray's rendered transcript does not own completely. |
| **Claude:** `/model`, `/effort`, `/plan`, `/permissions`, `/config`, `/add-dir`, `/mcp`, `/agents`, `/tasks`, `/background`, `/workflows` | **Terminal-only; some related settings already represented** | Existing profile controls govern Fray dispatch; they must not claim to be live-session `/model`/`/effort`/permission replacements. Native pickers, agents, and approval state stay in Terminal. |
| **Claude:** `/init`, `/memory`, `/doctor`, `/debug`, `/feedback`, `/review`, `/code-review`, `/security-review`, `/diff`, `/verify`, `/batch`, `/plugin`, custom/project/plugin/MCP skills | **Terminal-only** | Potential side effects, provider-specific workflow semantics, dynamically discovered commands, or output Fray cannot faithfully model. |
| **Codex:** `/status` | **Terminal-only** | Useful but provider-owned: current docs say it reports model, approval policy, writable roots, context/token use, and remote state. A Fray summary would be a different feature, not command replay. |
| **Codex:** `/model`, `/reasoning`, `/permissions`, `/personality`, `/fast`, `/ide`, `/keymap`, `/vim`, `/theme`, `/statusline`, `/title` | **Terminal-only; launch profile is already represented** | Runtime/session configuration and persistent Codex TUI preferences. Do not map profile controls to these commands. |
| **Codex:** `/compact`, `/diff`, `/review`, `/plan`, `/fork`, `/side`, `/goal`, `/init`, `/mcp`, `/ps`, `/feedback` | **Terminal-only** | They create provider work, inspect native data, or have provider-specific UI/results. |
| **Codex:** `/cloud`, `/cloud-environment`, `/local`, `/approve`, `/sandbox-add-read-dir`, `/setup-default-sandbox`, `/memories` | **Terminal-only** | Conditional availability and security/environment effects; do not expose a false capability or choose an approval in Fray. |
| **Fray `Cmd+K`: new thread, Queue, settings, thread jump/details, mark complete/read** | **Already represented** | Retain current palette semantics and keyboard chord. These are not aliases for `/` commands. |
| **Fray thread controls: manual rename, complete/read, chat/Terminal/Doc tabs, composer follow-up, model/effort launch profile** | **Already represented** | Keep direct UI controls rather than inventing textual aliases. |
| Raw provider slash command typed into Fray's rendered follow-up composer | **Unsuitable** | It is ordinary agent text today, not a verified native command channel. Never silently inject, strip, parse, or route it to tmux. Explain this in any future command UI. |

## Invocation, discoverability, capability, and error behavior

1. Keep `Cmd+K` global and app-scoped. It must never submit to a provider and its current fuzzy thread/action behavior remains intact.
2. Keep the thread-header sparkle as the only native-command affordance: label it **Rename with Claude**, show it only for an owned Claude session, and preserve its existing disabled reason. Manual rename remains the cross-provider alternative.
3. Keep Terminal as a controlled per-owned-thread tab. Contextual blocks for permission, Codex native input, and Claude AskUserQuestion already route there; preserve them rather than adding answer/approval buttons in Chat.
4. Do not reserve `/` in the Fray follow-up composer or offer an incomplete dropdown. If a user types `/…`, send it as normal follow-up text (current behavior) unless a separately approved product decision changes this. A future explicit command launcher, if one is ever justified, must be a separate Fray-only UI and must label every action with backend/capability scope.
5. A provider-specific action must be hidden when impossible, and disabled with a precise reason when temporarily unsafe (no owned live session, foreign/read-only thread, running turn, native prompt, typed draft, competing runtime control, or unknown capability). No optimistic success: only report completion after a provider-specific authoritative observation. Ambiguous submit, timeout, disconnect, or pane-identity change must say **inspect Terminal before retrying**.
6. Fray must never submit an unavailable command to the other backend, synthesize a selector answer, expose untrusted provider option/payload text in Chat, scrape a TUI as a command API, or inject raw control characters. A native command’s terminal output remains native output; Chat can only show a coarse, sanitized routing card when existing detection proves a blocking family.

## Terminal escape-hatch contract

Do not call the Terminal tab an escape hatch until all of these are true for an owned live thread. The current architecture is promising: `TerminalPane` has one xterm WebSocket per view, direct tmux attach, queued offline input, reconnect, native copy/paste treatment, and resize/clear refresh repair; the server bounds transport and attaches to the same private tmux server. That is implementation evidence, not completion evidence.

| Guarantee before advertising it | Required observable proof |
| --- | --- |
| **Visible repaint without a nudge** | Switching Chat → Terminal immediately shows the current native CLI screen; subsequent provider redraws, alternate-screen clears, resize/reflow, reconnect, and route/tab remount repaint without scroll, click, resize, or focus tricks. Test Claude and Codex real sessions. |
| **Correct focus and keyboard ownership** | Explicitly opening Terminal focuses xterm; Chat/global chords do not steal native TUI keys after focus. Click/pointer focus is reliable. `Escape`, arrows, Tab, Enter, Ctrl/Cmd combinations, and provider modal navigation reach the intended surface; leaving Terminal returns focus predictably without accidental submission. |
| **Paste and submit fidelity** | Single-line, multiline, large-but-allowed paste, bracketed paste where the CLI enables it, and Enter preserve bytes/order and submit exactly once. Offline queued input has a visible bounded failure state, never silent loss or duplicate replay. Copy uses native selection semantics. |
| **Faithful command output** | Terminal displays the actual active tmux pane, including provider slash menu/filtering, prompts, confirmations, tool approval, stdout/stderr, progress, and final output. It must not substitute transcript reconstruction or redact/alter command output. Reconnection must replay authoritative current screen without changing the worker. |
| **Ownership and failure truth** | Foreign sessions remain read-only and have no Terminal control. Denied/unavailable/exited/overloaded/rate-limited transport states are explicit; “Resume” returns to the Fray composer only after terminal exit. A terminal attach must not create a second worker or mutate another session. |

Later E2E must use a disposable real Fray stack for both providers and include: normal command discovery, at least one real native slash command, a picker/modal, input/paste/Enter/Escape, resize, reconnect, desktop and narrow widths, browser console/network checks, screenshots, and browser-session cleanup. Unit tests and transcript fixtures cannot establish this contract.

## Current code boundary (audit notes)

- `CommandPalette.tsx` is an app action/thread palette opened by `Cmd+K`; it has no provider commands.
- `ChatView.tsx` owns the Chat/Terminal/Doc tab and directs detected Claude permission/native Ask and Codex native-input states to Terminal. `ThreadActionBar.tsx` sends ordinary follow-ups.
- `rename-controller.ts` is intentionally narrow and requires the exact live Claude session; it specifically rejects Codex.
- `terminal.ts` attaches an xterm WebSocket client to tmux with bounded input/output/viewer handling; `tmux.ts` owns literal/key/paste primitives and warns those low-level controls are for version-gated TUI automation after capture/validation. They are not an authorization to automate arbitrary commands.

## Choices requiring maintainer approval

1. Is **zero new first-class commands** acceptable, with existing Claude AI Rename retained as the sole exception? If not, name the concrete user outcome; do not approve a generic protocol.
2. Should the product explicitly hint “Use Terminal for native Claude/Codex commands” near the composer or only in contextual blocked-state cards? A persistent hint improves discoverability but adds chrome and may imply reliability before E2E proves it.
3. Should a typed `/foo` in Fray's follow-up composer remain an ordinary prompt (recommended), receive a non-submitting “native commands are in Terminal” hint, or be blocked? Blocking is least ambiguous but changes normal prompting semantics.
4. When current terminal E2E finds an unmet guarantee, should Fray hide the Terminal tab, retain it with an experimental/recovery label, or simply avoid the “escape hatch” marketing claim while fixing reliability? This is a product-trust choice.
5. Is a future Fray-only command launcher desired for Fray-owned actions beyond `Cmd+K`? If yes, define its actions and keyboard model separately; it must not be presented as a provider slash menu.

## Sources checked

- [Anthropic: Commands](https://code.claude.com/docs/en/commands) and [Interactive mode](https://code.claude.com/docs/en/interactive-mode), accessed 2026-07-14.
- [OpenAI: Codex slash commands](https://developers.openai.com/codex/cli/slash-commands), accessed 2026-07-14.
- [Conductor: harnesses](https://www.conductor.build/docs/reference/harnesses), [Big Terminal Mode](https://www.conductor.build/docs/reference/big-terminal-mode), and [Slash commands](https://www.conductor.build/docs/reference/slash-commands), accessed 2026-07-14.
- Read-only local `claude --version`, `claude --help`, `codex --version`, `codex --help`, `codex resume --help`, and `codex features --help`, run 2026-07-14.
