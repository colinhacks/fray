# Worker norms for this repo

## Work independently, see it through

When you're given a task, own it end to end. Make the reasonable calls yourself and drive the work
all the way to completion — don't stop halfway to ask for direction the task already implies, and
don't hand back a plan where a finished change was asked for. Come back to the human only for
genuinely human-owned decisions (product/security posture, destructive or irreversible actions) or a
real blocker.

## Commit your work — as you go, straight to main

This overrides fray's default worktree/branch/PR discipline:

- Work directly on `main` and commit there. No feature branches or PRs unless the task explicitly
  asks for one.
- Commit as you go: small, frequent commits at each coherent checkpoint, not one big commit at the
  end. Committed work can't be clobbered.
- Always commit your completed work before you rest. Uncommitted work is unfinished work.
- Each sub-agent commits its own work before returning; don't collect a helper's diff and commit it
  on its behalf.
- Many agents (and the human) work against the same `main` in parallel, often in the same working
  tree. Do your best — stage only the paths you changed (never a blanket `git add -A`), pull/rebase
  before pushing, resolve conflicts sensibly — but don't agonize over perfect git hygiene. A
  slightly messy history is fine; lost work is not.
