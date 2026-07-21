# Worker norms for this repo

## Work independently, see it through

When you're given a task, own it end to end. Make the reasonable calls yourself and drive the work
all the way to completion — don't stop halfway to ask for direction the task already implies, and
don't hand back a plan where a finished change was asked for. Come back to the human only for
genuinely human-owned decisions (product/security posture, destructive or irreversible actions) or a
real blocker.

## Decide and proceed — signal the call, don't stall on it

When the task underspecifies something, your default is to DECIDE, not to ask. A reversible call
costs minutes to redo; a round-trip to the human costs hours — so the bar for stopping is high, and it
clears only when a wrong guess would be both costly and hard to undo.

- **Proceed on any call you can reverse, and on any call you hold with high confidence.** If it's
  derivable from the code, the conventions, or ordinary engineering judgment, it's yours — make it and
  keep moving rather than handing back a question you could have answered.
- **Give the human some indication of the approach you took, as you take it.** When you proceed on a
  judgment call, name the direction you chose (and the notable alternative you passed on) so they can
  course-correct early. A confident call the human can see is fine; a silent one they can't catch is not.
- **Reserve questions for the genuinely human-owned and irreversible** — product or security posture,
  destructive or irreversible actions, external-facing commitments, or a fork where a wrong pick is
  expensive to unwind. Those earn a round-trip; little else does.
- **Account for your decisions in the results summary.** Whenever you report back, explain the calls
  you made along the way — the assumptions, the forks you resolved, the alternatives you rejected — so
  the human reads your reasoning off the summary instead of reverse-engineering it from the diff.

## Verify end-to-end — test the whole, not the parts

Every change you land needs REAL end-to-end verification: exercise the actual behavior in the actual
runtime, the way it will really run, and observe the real outcome. This is non-negotiable.

- Testing the pieces in isolation is NOT end-to-end. A passing unit test, a mock, a typecheck, or a
  hand-driven PROXY (e.g. invoking a CLI yourself with the flags the server *would* have passed, and
  concluding the server-spawned path works) proves the parts — not the whole. The seam between the
  parts is exactly where the bug lives. If a feature spawns/injects/renders something, drive the REAL
  spawned/injected/rendered thing and confirm the observable result: the tool actually shows up in a
  real worker's registry and is callable; the page actually renders in a real browser; the request
  actually succeeds against a real server. "I verified the components" is how a broken feature ships.
- If genuine end-to-end testing is truly infeasible, that does NOT lower the bar — it raises it. Do a
  rigorous ADVERSARIAL self-review: attack your own assumptions, enumerate every way the change could
  fail in the real runtime, and trace the full path yourself end to end. Then dispatch a fresh-context
  reviewer to do the same against your diff.
- Never present an isolated or proxy check as if it were end-to-end. In your handoff, state plainly
  what you actually exercised and what you could NOT, and why. "It should work" is not "it works" —
  do not claim a thing is verified or done when you have only verified a stand-in for it.

## Commit your work — straight to main, never through a PR

This overrides fray's default worktree/branch/PR discipline:

- **Never open a pull request.** Not for a fix, not for significant work — PRs are off right now, no
  exceptions. Work reaches `main` locally, never through GitHub.
- The default is to work directly on `main` and commit there.
- If you want isolation you MAY create a git worktree on a local branch and work there — but then you
  OWN landing it. When the work is done and you have HIGH CONFIDENCE, report back to the human; once
  they confirm, merge the branch into `main` locally. Getting it back onto `main` is your
  responsibility, not the human's — never leave a branch stranded.
- Commit as you go: small, frequent commits at each coherent checkpoint, not one big commit at the
  end. Committed work can't be clobbered.
- Always commit your completed work before you rest. Uncommitted work is unfinished work.
- Each sub-agent commits its own work before returning; don't collect a helper's diff and commit it
  on its behalf.
- Many agents (and the human) work against the same `main` in parallel, often in the same working
  tree. Do your best — stage only the paths you changed (never a blanket `git add -A`), pull/rebase
  before pushing, resolve conflicts sensibly — but don't agonize over perfect git hygiene. A
  slightly messy history is fine; lost work is not.
