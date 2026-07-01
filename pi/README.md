# pi-fray

Fray orchestration for Pi: one extension, one skill, and prompt templates.

## Child-first rule

The orchestrator coordinates, decides, steers, reconciles, synthesizes threads, and does only narrow verification. Any substantive investigation, fix, debug, code trace, build/repro, benchmark, docs/copy edit, or behavior diagnosis starts in a child via `fray_dispatch` or `fray_create_thread.initialDispatches`.

When the necessary next action is clear and authorized by context, act immediately: dispatch or steer the right child, apply the safe fix, run the verification, or push/post within the user's existing permissions. User implication is authorization within standing safety constraints; treat outcome-shaped asks as authorization to proceed through the safe implementation/verification loop. Do not stop at identifying a blocker, P0, reload blocker, or known required fix; if no human-owned decision blocks it, launch or steer the work now and report what happened. Child-first means prompt dispatch/steering, not inaction. Keep following outstanding threads until they are done, blocked, or explicitly deprioritized. Separate reload safety from work completeness: no live children may make reload handle-safe, but pending required fixes still need action. Do not say reload is blocked by a fix without starting or steering that fix.

Completion follow-ups are native Pi follow-up messages that embed the oldest unhandled child's run metadata and captured final output. Unhandled completions are a strict inbox, not optional notifications. The active notification path is native follow-up with embedded result → orchestrator synthesis into the owning thread or `.fray/backlog.md` → chat summary → `fray_reconcile { markHandled: true }` concise handled ack. If another result is queued, Fray schedules the next native follow-up automatically. `fray_next` remains a durable recovery/debug/manual-drain read path, not routine polling. Child final responses are the primary reports and must be orchestration-ready: purpose, result, changed files/actions, verification, caveats/risks, and one next action. Empty or missing final output is an incomplete handoff/bug, not normal success: Fray recovers from the child session file when possible, and otherwise reclassifies the run as incomplete/needs-retry. Findings sidecars are optional raw appendices, not the normal handoff.

Substantive implementation children should be mini-orchestrators within their assigned scope: plan briefly, implement, run local verification, self-review the diff, evaluate/integrate, and for landing work commit and push to `main` by default unless the repo/task specifies a PR flow or forbids pushing. When CI applies and credentials are available, the child should wait for CI and fix in-scope failures instead of handing off immediately after the first push.

GitHub issue/PR tasks require `gh` context before diagnosis or fixes: view the issue/PR, inspect linked or open PRs, include the commands/results in the final report, and then drive the outcome by fixing, pushing, commenting, closing, or verifying when safe.

Children are expected to keep their owning thread doc current with `fray_thread_patch`, a Fray-scoped patch tool that can update frontmatter and body together through multiple exact replacements plus appended level-2 sections in one locked write. Generic child `write`/`edit` still cannot modify canonical `.fray` thread/config/run files; `fray_thread_patch` targets only the child's own `.fray/<thread>.md`. Child updates cover progress, status/frontmatter, Status, Open questions, Decisions, Steps/checklists, Child runs rows, Next step, and body synthesis as facts become durable. `fray_reconcile` still owns durable handled state and final-output review; with `markHandled`, it acknowledges handling without echoing the child output that was already embedded in the native follow-up.

Fray is not silent backgrounding. The orchestrator's role is to surface child progress/results to the user, not only decisions. Every dispatch gets a concise chat note with purpose and run ID; every child completion is reported in chat before the handled ack, even when it needs no human decision. Before unrelated work or any new dispatch, handle the current native completion follow-up unless a higher-priority user ask interrupts; after answering that interruption, resume the inbox immediately. Completion reports use this shape: purpose, result, changed files/actions, verification, caveats, next action. Do not batch-reconcile silently; handle one child at a time, report it, mark handled, then let the next native follow-up surface naturally.

Maintain a visible queue for unhandled completions. If Pi exposes a native todo-list mechanism in the active prompt/tools, mirror the inbox there; otherwise use the owning thread's `Steps / follow-up queue` or `.fray/backlog.md` checklist. Do not invent a separate custom queue; `.fray/runs.jsonl` is recovery only, native follow-ups are normal delivery, and `fray_next` is for recovery/debug/manual drain.

User feedback about Fray itself is not chat-only memory. Persist methodology changes in `skills/fray/SKILL.md`, tool behavior in the extension/prompts, and operator-facing guidance in this README/docs before moving on; steer any live Fray-tooling child already working in the affected area.

Thread frontmatter uses the latest Fray/Freya canonical statuses: `planning`, `planned`, `active`, `blocked`, `done`, and `dismissed`. The Pi extension accepts legacy `todo`, `plan`, `deferred`, `enqueued`, and `needs-decision` values on read and normalizes them into the canonical board buckets; new Pi-created threads write canonical `planned`/`blocked` rather than the old aliases.

Detached ad hoc runners use `fray_launch_external({ thread?, label, runner, prompt?, command?, args?, cwd?, timeoutMs?, env?, finalOutputPath? })`. Built-in runners are `codex`, `claude`, and `custom`; Fray returns immediately with a run ID, PID, log path, final-output path, and findings path, then records completion in `.fray/runs.jsonl` and surfaces it through the normal native follow-up queue. External runs are recovered on reload/status from their status/final-output/log files.

Unthreaded dispatches attach to `.fray/backlog.md`, which is the central control surface for backlog-owned work. `.fray/backlog.findings/` may contain raw artifacts, but accepted summaries belong in `.fray/backlog.md`.

Live child steering is best-effort and currently requires an in-process SDK handle. SDK-backed ledger records that still say `running` after reload/session replacement are marked aborted/lost and must be reconciled or relaunched; detached external runs are recovered from their output/status files instead. Do not reload or shut down while SDK-backed children are live unless aborting them is explicitly accepted. Reload discipline has two checks: live-child safety and pending-work completeness. If live children are clear but a known required fix remains, start or steer the fix; do not present that fix as a reload blocker while leaving it idle. If reload/shutdown aborts or loses a child, reconcile partial facts and relaunch still-needed work. Resuming completed/lost SDK-backed runs from recorded `sessionFile` is a separate capability to investigate.

Fray child transcripts are created as normal Pi session files and their path is recorded in `.fray/runs.jsonl` (`sessionFile`). Pi does not expose a live-child registry that lets Fray recover a steering handle after reload; captured final output, the run ledger, and the child session JSONL are the permanent record. If live final-output capture is empty, Fray reads `sessionFile` and extracts the latest assistant final text before surfacing the run; if that also fails, the handoff is incomplete/retryable.

Install globally from this live checkout:

```sh
pi install /Users/colinmcd94/Documents/projects/fray/pi
```

Pi stores local package paths by reference, so edits here are picked up by new Pi sessions or `/reload`.
