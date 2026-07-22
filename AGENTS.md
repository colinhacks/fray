# Web UI completion rule

For any user-visible web UI change, work is not complete until end-to-end Chrome or Chromium QA has exercised the affected workflow. Prefer Chrome DevTools MCP when it is available to the current provider. If it is unavailable or unsuitable, use `agent-browser` or this repository's Puppeteer harness as an explicit fallback; each path must produce the same real-browser evidence. Capture and inspect multiple screenshots covering the meaningful states: before and after, desktop and relevant narrow/mobile widths, plus open menus, drawers, hover, selected, loading, or error states when applicable. Check the browser console and page errors, and inspect visual results optically—not only by box-model measurements. Icons beside text must be optically vertically centered, and placement, truncation, and wrapping must be verified.

Unit, typecheck, and build tests do not substitute for this visual Chrome QA. The final handoff must include paths to the inspected screenshot evidence. This rule does not apply to purely non-UI changes.

# Browser process hygiene

Browser cleanup is a mandatory part of end-to-end QA. Reuse one uniquely named owned browser session, target, or harness instance for all desktop and narrow/mobile checks in a task; do not create a new browser instance per screenshot or assertion. Every task that starts a browser must arrange cleanup in a `finally`/shell `trap` or equivalent path before launch, including on QA failure or interruption. Before returning, verify that its exact owned session/target or harness instance and its owned browser/helper-process tree are gone.

Chrome DevTools MCP is the preferred QA tool when available. Never leave a Chrome DevTools MCP helper, `agent-browser` daemon, Puppeteer browser, or Chrome/Chromium helper process running after the task that created it. Do not use global browser/session/target close operations while another agent may be performing active QA; each agent owns and cleans up only its exact session, target, or process tree. A UI handoff is incomplete unless it includes screenshot paths, console/page-error evidence, optical-review results, and explicit browser-cleanup confirmation.

# Copy capitalization: sentence case, never title case

All user-visible copy uses SENTENCE case — capitalize only the first word and any proper nouns. This
covers button and menu labels, headings, section titles, toasts, and thread titles. Never Title-Case
Every Word (write "Confirm snooze", "Mark as done", "Fix queue focus" — not "Confirm Snooze", "Mark As
Done", "Fix Queue Focus"). Acronyms (PR, CI, API) keep their established casing. When an agent titles a
thread, the same rule applies.

# "Shipped" means merged into the primary branch

Never describe a created, opened, or pushed PR as "shipped." An open PR is implemented, pushed,
ready for review, or awaiting merge. Use "shipped" only after the change has actually been merged
into the repository's primary branch. This applies to progress updates, final handoffs, and signal-card
bullets.

# Project-local skills and tools are shared across agents

Any project-local skill or tool lives in ONE agent-neutral copy that every agent configuration
discovers — never a per-agent fork. Skills live canonically in `.agents/skills/<name>/` (Codex
discovers this path natively); `.claude/skills/<name>` is a relative symlink into that canonical copy
so Claude Code discovers the identical content. When adding a skill, create it under
`.agents/skills/` and add the symlink; verified end-to-end 2026-07-21 with `adhoc-cdp` (Claude lists
it through the symlink, `codex exec` resolves it at `.agents/skills/adhoc-cdp/SKILL.md`). Shared
tooling scripts follow the same rule: one copy in an agent-neutral location (e.g. `ui/scripts/`),
referenced from skills — never duplicated into agent-specific config trees.

# Agent completion invariant

Once spawned, an agent runs to its terminal return. Do not interrupt or cut off an active agent to
reduce churn, reclaim slots or quota, redirect work, respond to a user steer, contain live-server
instability, or hurry completion. Deliver new direction through the agent's message/follow-up path,
then reconcile obsolete or conflicting results after it returns. Mid-turn interruption can leave
partially applied edits, tests, and owned processes behind, making the resulting repository state
unsound. Isolate or restart only the affected unstable service; never stop a writer to stabilize it.
If an agent appears hung or continuing would be dangerous, use the interactive question path to ask the
user. The sole exception is an explicit user instruction that names the interruption.
