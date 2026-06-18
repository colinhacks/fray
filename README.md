# pi-fray

Fray orchestration for Pi: one extension, one skill, and prompt templates.

## Child-first rule

The orchestrator coordinates, decides, steers, reconciles, synthesizes threads, and does only narrow verification. Any substantive investigation, fix, debug, code trace, build/repro, benchmark, docs/copy edit, or behavior diagnosis starts in a child via `fray_dispatch` or `fray_create_thread.initialDispatches`.

When the necessary next action is clear and authorized by context, act immediately: dispatch or steer the right child, apply the safe fix, run the verification, or push/post within the user's existing permissions. User implication is authorization within standing safety constraints; treat outcome-shaped asks as authorization to proceed through the safe implementation/verification loop. Do not stop at identifying a blocker, P0, reload blocker, or known required fix; if no human-owned decision blocks it, launch or steer the work now and report what happened. Child-first means prompt dispatch/steering, not inaction. Keep following outstanding threads until they are done, blocked, or explicitly deprioritized. Separate reload safety from work completeness: no live children may make reload handle-safe, but pending required fixes still need action. Do not say reload is blocked by a fix without starting or steering that fix.

Completion follow-ups are native Pi follow-up messages that embed the oldest unhandled child's run metadata and captured final output. Unhandled completions are a strict inbox, not optional notifications. The active notification path is native follow-up with embedded result → orchestrator synthesis into the owning thread or `.fray/backlog.md` → chat summary → `fray_reconcile { markHandled: true }` → `fray_next` again. `fray_next`/`fray_reconcile` remain the durable source of truth and fallback read path. Child final responses are the primary reports and must be orchestration-ready: purpose, result, changed files/actions, verification, caveats/risks, and one next action. Empty or missing final output is an incomplete handoff/bug, not normal success: Fray recovers from the child session file when possible, and otherwise reclassifies the run as incomplete/needs-retry. Findings sidecars are optional raw appendices, not the normal handoff.

Substantive implementation children should be mini-orchestrators within their assigned scope: plan briefly, implement, run local verification, self-review the diff, evaluate/integrate, and for landing work commit and push to `main` by default unless the repo/task specifies a PR flow or forbids pushing. When CI applies and credentials are available, the child should wait for CI and fix in-scope failures instead of handing off immediately after the first push.

GitHub issue/PR tasks require `gh` context before diagnosis or fixes: view the issue/PR, inspect linked or open PRs, include the commands/results in the final report, and then drive the outcome by fixing, pushing, commenting, closing, or verifying when safe.

Children are expected to keep their owning thread doc current with `fray_thread_patch`, a Fray-scoped patch tool that can update frontmatter and body together through multiple exact replacements plus appended level-2 sections in one locked write. Generic child `write`/`edit` still cannot modify canonical `.fray` thread/config/run files; `fray_thread_patch` targets only the child's own `.fray/<thread>.md`. Child updates cover progress, status/frontmatter, Status, Open questions, Decisions, Steps/checklists, Child runs rows, Next step, and body synthesis as facts become durable. `fray_reconcile` still owns durable handled state, final-output review, and chat reporting; it no longer means the orchestrator must manually perform every thread-doc update.

Fray is not silent backgrounding. The orchestrator's role is to surface child progress/results to the user, not only decisions. Every dispatch gets a concise chat note with purpose and run ID; every child completion is reported in chat after reconciliation, even when it needs no human decision. Before unrelated work or any new dispatch, drain the oldest unhandled result unless a higher-priority user ask interrupts; after answering that interruption, resume the inbox immediately. Completion reports use this shape: purpose, result, changed files/actions, verification, caveats, next action. Do not batch-reconcile silently; handle one child at a time, report it, mark handled, call `fray_next`, repeat.

Maintain a visible queue for unhandled completions. If Pi exposes a native todo-list mechanism in the active prompt/tools, mirror the inbox there; otherwise use the owning thread's `Steps / follow-up queue` or `.fray/backlog.md` checklist plus `fray_next`. Do not invent a separate custom queue; `.fray/runs.jsonl` is recovery only, and `fray_next` remains the source of truth.

Unthreaded dispatches attach to `.fray/backlog.md`, which is the central control surface for backlog-owned work. `.fray/backlog.findings/` may contain raw artifacts, but accepted summaries belong in `.fray/backlog.md`.

Live child steering is best-effort and currently requires an in-process SDK handle. `fray_children` and the TUI widget show only handle-backed children as live; persisted ledger records that still say `running` after reload/session replacement are marked aborted/lost and must be reconciled or relaunched. Do not reload or shut down while children are live unless aborting them is explicitly accepted. Reload discipline has two checks: live-child safety and pending-work completeness. If live children are clear but a known required fix remains, start or steer the fix; do not present that fix as a reload blocker while leaving it idle. If reload/shutdown aborts or loses a child, reconcile partial facts and relaunch still-needed work. Resuming completed/lost runs from recorded `sessionFile` is a separate capability to investigate.

Fray child transcripts are created as normal Pi session files and their path is recorded in `.fray/runs.jsonl` (`sessionFile`). Pi does not expose a live-child registry that lets Fray recover a steering handle after reload; captured final output, the run ledger, and the child session JSONL are the permanent record. If live final-output capture is empty, Fray reads `sessionFile` and extracts the latest assistant final text before surfacing the run; if that also fails, the handoff is incomplete/retryable.

Install globally from this live checkout:

```sh
pi install /Users/colinmcd94/Documents/projects/fray
```

Pi stores local package paths by reference, so edits here are picked up by new Pi sessions or `/reload`.
