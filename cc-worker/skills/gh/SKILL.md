---
name: gh
description: The gh-CLI playbook for a fray-ui worker signed into GitHub (invoke as fray:gh). Load this whenever your effort touches GitHub — reading or triaging an issue or PR, reviewing a diff, checking CI/release status, or searching issues/PRs — to use `gh` eagerly and correctly: the read-vs-write boundary (never comment/label/close/merge unless the human asks), the toon absolute-path shim for large JSON, concrete read recipes, and active Monitor/background-Bash CI/PR watches. Only meaningful when you are signed in (`gh auth status --active` exit 0); the session-seed hook injects a pointer here when you are.
version: 0.1.1
metadata:
  internal: true
---

# fray:gh — the gh-CLI playbook

You are a **fray-ui worker** and you are **signed into the `gh` CLI in a GitHub repo** (the session-seed hook confirmed `gh auth status --active` before pointing you here). `gh` is the fastest path to issue / PR / CI / release context — reach for it before guessing, and prefer it over scraping the web UI or reasoning from memory.

This skill is the full playbook the injected `⟦gh available⟧` block summarizes: the **read-vs-write boundary**, the **toon shim** for large JSON, concrete **read recipes**, and how to keep a **CI/PR watch** active until the next actionable event.

## The one hard rule — READ freely, WRITE only when asked

`gh` can mutate the repo, and your token has the scopes to do it. **Do not.** Unless the human **explicitly asks in this session**, you are strictly read-only:

- **NEVER** comment, review, approve, request-changes, label, assign, milestone, edit, close, reopen, merge, or push — no state change of any kind on GitHub.
- Your deliverable is your **final message** (a findings write-up, a review, a recommendation) — NOT a GitHub post. Producing the review in-session is the job; posting it is a separate action the human authorizes.
- If posting would genuinely help, don't just do it — **ask** with a ` ```question approval ` block ("A. Post this review to the PR / B. Keep it in-session only", Recommendation), then rest. When the destructive edge is real (a force-merge, a close), that's a ` ```question approval danger ` gate.
- When the human HAS asked you to write, do exactly the scoped thing and report the resulting URL — nothing extra.

There is no server-side enforcement of this; the boundary is yours to hold.

## toon — pipe LARGE, FLAT gh JSON through the shim

`toon` (Token-Oriented Object Notation) losslessly re-encodes JSON ~30–40% smaller for LLM context. Use it when a `gh … --json` result you're reading into YOUR context is **large and flat** (a list page: `gh issue list`, `gh pr list`, `gh search`, `gh api` list endpoints).

**toon is NOT on PATH.** Use the absolute path, or export it once:

```bash
gh issue list -R OWNER/REPO --json number,title,url,updatedAt --limit 50 | "$HOME/.nvm/versions/node/v24.14.0/bin/toon"
# or, once per shell:
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
gh pr list -R OWNER/REPO --json number,title,url --limit 50 | toon
```

**Skip toon** for tiny payloads (a handful of fields, one item) and for **deeply-nested** JSON (`reactionGroups`, review threads, nested files) — nesting defeats tabularization, so the savings collapse to noise and you add a parse tax for yourself. A single `gh pr view N --json …` is small — read it raw.

## Read recipes

Always scope with `-R OWNER/REPO` so a command is dir-independent, and prefer `--json <fields>` (+ `-q <jq>`) so you pull exactly what you need.

**Issues**
```bash
gh issue view N -R OWNER/REPO --comments                          # full thread, human-readable
gh issue view N -R OWNER/REPO --json title,body,labels,state,url  # structured
gh issue list -R OWNER/REPO --search "sort:updated-desc" --json number,title,url,updatedAt --limit 30
gh issue list -R OWNER/REPO --search "sort:reactions-desc is:open" --json number,title,url --limit 30
```

**PRs + diffs**
```bash
gh pr view N -R OWNER/REPO --json title,body,state,labels,files,additions,deletions,url
gh pr diff N -R OWNER/REPO                # the unified diff — pipe through toon only if HUGE and you just need shape
gh pr checks N -R OWNER/REPO              # CI check rollup for the PR
gh pr view N -R OWNER/REPO --comments     # review threads + conversation
```
Read the changed files **in context**, not just the hunks — `gh pr diff` shows what changed, but correctness lives in the surrounding code.

**CI / runs / releases**
```bash
gh run list -R OWNER/REPO --branch BRANCH --limit 10
gh run view RUN_ID -R OWNER/REPO --log-failed        # just the failing step logs
gh release view -R OWNER/REPO                         # latest release
```

**Search (across issues/PRs)**
```bash
gh search issues -R OWNER/REPO "crash on startup" --state open --json number,title,url --limit 30
gh search prs --repo OWNER/REPO "author:@me" --json number,title,url --limit 30
```
Use search to find duplicates, related work, and prior art before you conclude something is novel.

**Raw API** for anything the porcelain doesn't cover:
```bash
gh api repos/OWNER/REPO/commits/SHA/check-runs --jq '.check_runs[] | {name, conclusion}'
gh api "repos/OWNER/REPO/issues?state=open&labels=bug&per_page=50" | "$HOME/.nvm/versions/node/v24.14.0/bin/toon"
```

## Keep GitHub automation active

CI, automated review, releases, merge queues, and already-authorized merge progression are work you
can observe with `gh`; they do not earn an `awaiting` fence. Keep a live operation attached to the
thread and continue when it reports.

- One-shot completion: launch `Bash` with `run_in_background: true`, for example
  `gh run watch RUN_ID -R OWNER/REPO --exit-status` or a repo watcher that exits when all PR checks
  settle. The completion task-notification re-invokes you. Diagnose/fix on red; continue the authorized
  release/merge path on green.
- State transitions: use `Monitor` with a quiet loop that prints only changes or the terminal event.
  Finite monitors run up to one hour; `persistent: true` runs until `TaskStop` or the Claude session
  ends. Stop a watch once its gate is obsolete.
- A background Bash launch exposes an output-file path. Use `Read` on that path only for diagnostics;
  `TaskOutput` is deprecated. Do not fake waiting with `echo waiting` or sleep-only Bash calls.

Both mechanisms are session-bound. If the next check deliberately belongs at a named wall-clock
instant, park with a durable `timer:` fence. If a specific external human reviewer/approver is the
only remaining gate, park with `human: <actor + exact action>`. For a GitHub PR, pair it with
`github-review: OWNER/REPO#NUMBER`: fray-ui baselines current reviews/comments and wakes only on NEW
non-bot human activity after the fence, durably across restarts. Otherwise optionally pair a timer for
a scheduled recheck. The dashboard operator's own go/no-go remains a ` ```question ` block. `pr:` / `ci:` /
`session:` awaiting hints are legacy compatibility only — do not emit them for new automated waits.

## Fitting gh work into your thread type

- **Investigating an issue** (a research thread): reproduce → trace to `file:line` (cite every load-bearing claim) → recommend the smallest correct fix; read the full thread and linked issues/PRs with `gh` for context. Don't implement — stop at the recommendation. Handback = findings in your final message.
- **Reviewing a PR** (an audit thread): read the diff AND the files in context, verify correctness/edges/tests, check CI (`gh pr checks`), then produce a review (blocking issues vs nits, each citing `file:line`) as your final message. Approve/merge only if explicitly asked.

In both cases: read-only on GitHub unless told otherwise, and the review/findings live in your session, not in a GitHub post.
