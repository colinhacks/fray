---
name: gh
description: The gh-CLI playbook for a fray-ui worker signed into GitHub (invoke as fray:gh). Load this whenever your effort touches GitHub — reading or triaging an issue or PR, reviewing a diff, checking CI/release status, or searching issues/PRs — to use `gh` eagerly and correctly: the read-vs-write boundary (never comment/label/close/merge unless the human asks), the toon absolute-path shim for large JSON, concrete read recipes, and how to tie a CI or PR watch into your ```awaiting signal fence. Only meaningful when you are signed in (`gh auth status --active` exit 0); the session-seed hook injects a pointer here when you are.
version: 0.1.0
metadata:
  internal: true
---

# fray:gh — the gh-CLI playbook

You are a **fray-ui worker** and you are **signed into the `gh` CLI in a GitHub repo** (the session-seed hook confirmed `gh auth status --active` before pointing you here). `gh` is the fastest path to issue / PR / CI / release context — reach for it before guessing, and prefer it over scraping the web UI or reasoning from memory.

This skill is the full playbook the injected `⟦gh available⟧` block summarizes: the **read-vs-write boundary**, the **toon shim** for large JSON, concrete **read recipes**, and how to tie a **CI/PR watch** into your ` ```awaiting ` signal fence.

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

## Tie a CI or PR watch into your ```awaiting fence

You are a worker: **do not block on a poll loop** (no `Monitor`, no background-shell `while` on `gh run watch`, no foreground CI watch — a held process can't survive a rest). When your next step depends on a **machine** finishing on GitHub — CI completing, a PR merging/closing — read the current state ONCE, then **rest with an ` ```awaiting ` fence** carrying the hint the fray-ui scheduler wakes on. It resumes your session the moment the condition fires, hours or days later.

- Waiting on **CI** for a ref/PR → after `gh pr checks N` shows checks still running, rest with:
  ```
  ```awaiting
  ci: OWNER/REPO#N
  Pushed the fix; watching PR checks. Wake me when they finish and I'll fold in any failure.
  ```
- Waiting on a **PR to merge/close** →
  ```
  ```awaiting
  pr: OWNER/REPO#N
  Review posted per your ask; waiting on merge. Wake me when it lands.
  ```

`ci:` fires when the checks finish (pass or fail); `pr:` fires on merge/close. You wake with a steer (`✅ CI is green on …` / `❌ CI failed on …` / `✅ PR … merged`), then continue. Put *what to re-check* in the prose so future-you knows why it's waiting. Never use `awaiting` for a human wait — that's a ` ```question `.

## Fitting gh work into your thread type

- **Investigating an issue** (a research thread): reproduce → trace to `file:line` (cite every load-bearing claim) → recommend the smallest correct fix; read the full thread and linked issues/PRs with `gh` for context. Don't implement — stop at the recommendation. Handback = findings in your final message.
- **Reviewing a PR** (an audit thread): read the diff AND the files in context, verify correctness/edges/tests, check CI (`gh pr checks`), then produce a review (blocking issues vs nits, each citing `file:line`) as your final message. Approve/merge only if explicitly asked.

In both cases: read-only on GitHub unless told otherwise, and the review/findings live in your session, not in a GitHub post.
