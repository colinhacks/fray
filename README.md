# pi-fray

Fray orchestration for Pi: one extension, one skill, and prompt templates.

## Child-first rule

The orchestrator coordinates, decides, steers, reconciles, synthesizes threads, and does only narrow verification. Any substantive investigation, fix, debug, code trace, build/repro, benchmark, docs/copy edit, or behavior diagnosis starts in a child via `fray_dispatch` or `fray_create_thread.initialDispatches`.

Completion follow-ups are compact nudges (`Child agent complete [<runId>].`); handling details live in the Fray skill and prompt instructions. Child final reports must be orchestration-ready: status, work done, changed files/artifacts/commit or clone path, verification, caveats/risks, and one next action. Empty, silent, or artifact-free child results are incomplete and must be retried or escalated. Direct user Q&A comes first; then reconcile and summarize child results in chat with purpose/context, result, changed files/artifacts/verification if relevant, and next action; then continue dispatch/steering.

Live child steering is best-effort and requires an in-process SDK handle. `fray_children` and the TUI widget show only handle-backed children as live; persisted ledger records that still say `running` after reload/session replacement are marked aborted/lost and must be reconciled or relaunched. Do not reload or shut down while children are live unless aborting them is explicitly accepted. If reload/shutdown aborts or loses a child, reconcile partial facts and relaunch still-needed work.

Fray child transcripts are now created as normal Pi session files and their path is recorded in `.fray/runs.jsonl` (`sessionFile`). Pi does not expose a live-child registry that lets Fray recover a steering handle after reload; durable findings sidecars, the run ledger, and the child session JSONL are the permanent record.

Install globally from this live checkout:

```sh
pi install /Users/colinmcd94/Documents/projects/fray
```

Pi stores local package paths by reference, so edits here are picked up by new Pi sessions or `/reload`.
