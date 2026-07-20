# Portable GitHub monitors

`monitors/` is Fray's canonical, dependency-free Node.js implementation of active GitHub CI and
human-review waits. It requires only Node.js and a logged-in `gh`; it never reads or prints a token.
The shipped copies in `codex/skills/fray-orchestrator/scripts/` and `cc-worker/skills/gh/scripts/`
are generated from this directory by `node scripts/sync-portable-monitors.mjs`. Verify them without
writing with `node scripts/sync-portable-monitors.mjs --check`.

Run an explicitly selected monitor, never a script found merely because its filename looks familiar:

```sh
node /absolute/path/to/ci-watch.mjs --repo OWNER/REPO --pr NUMBER
node /absolute/path/to/review-watch.mjs --repo OWNER/REPO --pr NUMBER
```

Before choosing a bundled script, inspect project-local `AGENTS.md`, active skills, repository docs,
`package.json` scripts, and declared monitor tooling. Prefer a project-declared tool only when its
documented terminal semantics cover the gate being watched. Validate its absolute command and its
terminal event/exit contract before launching it. If a declared tool is missing, non-executable, or
does not provide that contract, stop and report that invalid configuration; do not silently fall back
or shadow it. Use these bundled scripts only when no declared project monitor exists.

## NDJSON protocol

Each stdout line is a JSON object with `protocol: "fray.github-monitor/v1"`, an ISO `at`, a `kind`,
and `type`: `status` or `terminal`. `status` is non-terminal (`pending` CI or armed review);
`terminal` is a final verdict. CI exits 0 on a complete successful exact-head set, 2 on a failure,
and 3 for an invocation, missing-`gh`, or GitHub/auth error. Those errors are terminal rather than a
silent retry loop. Each `gh` invocation has a 30-second bound and at most three attempts with bounded
250ms/500ms backoff before that terminal error. SIGINT/SIGTERM emits one terminal `cancelled` event
and exits 130. `--help` is the sole stdout exception: it prints plain usage text and exits 0. A `--once`
pending snapshot exits 0 without a terminal event. Review exits 0 for new human activity; its
`--once` baseline is a status snapshot.

`ci-watch` combines `gh pr checks` with newest workflow runs for the PR's exact head SHA.
`ACTION_REQUIRED`, queued, and in-progress work are pending, never success. `review-watch` baselines
non-bot reviews/comments and wakes only for new human activity after that baseline. Workflow runs are
collapsed only by `(workflow name, event)`: retries of the same workflow event replace older runs, while
different events on the same exact head (for example `push` and `pull_request`) both contribute to the
aggregate verdict.
