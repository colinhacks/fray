---
name: adhoc-cdp
description: Ad hoc runtime verification for fray-ui — boot a fully-ISOLATED disposable stack and drive the REAL app (screenshots, console, network) headless in the background, plus focused real-subsystem harnesses for backend behavior the browser can't reach. Load this whenever your effort changes fray-ui server/UI/control-plane code and you need to SEE it work before claiming done (the worker RUNTIME RELEASE GATE requires exactly this). Do it OFTEN and EAGERLY — a change is unverified until you have driven the running app, not just typechecked it.
version: 0.1.0
metadata:
  internal: true
---

# fray:adhoc-cdp — drive the real app, don't guess

A fray-ui change is **not done until you have watched it work in the running app**. Typecheck and unit
tests prove shapes, not behavior. This skill is the fast, repeatable loop for that: a throwaway stack that
touches nothing real, driven headless so you can screenshot and inspect it in the background while you keep
working. Reach for it **often and eagerly** — every server/UI/control-plane change, every bug fix you want
to prove, every "does this actually render" question.

Two layers, use both as the change demands:
1. **The isolated stack + browser** — for anything with a UI or HTTP surface.
2. **A focused real-subsystem harness** — for backend behavior the browser can't reach (tmux, SQLite,
   scheduler, resume/wake paths). Spin the REAL resource, assert the REAL function.

---

## 1. The isolated disposable stack

`ui/scripts/adhoc-stack.mjs` boots a complete fray-ui instance sandboxed on every axis so it can never
touch the maintainer's live instance, real `~/.fray` SQLite, or real worker tmux:

- `HOME` → a fresh temp dir (the SQLite DB + `server.lock` live in an empty `~/.fray` there)
- `FRAY_TMUX_SOCKET` → a unique socket (spawned worker tmux never collides with real sockets)
- `PORT` → a unique high port (never fights the dev server on 5175)
- `FRAY_WAKERS_OFF=1` → scheduler OFF by default; pass `--wakers` to arm it when testing wake delivery

Boot it in the **background** (never foreground — it stays up until killed) and read back its URL:

```bash
# from ui/ — run in the background, then read the printed json line for the url
npx tsx scripts/adhoc-stack.mjs --port=4930
# → {"url":"http://127.0.0.1:4930/","port":4930,"home":"…","socket":"…","project":"…","wakers":false}
```

Flags: `--port=N`, `--project=/abs/dir` (defaults to the fray repo — a gh-authed repo with an empty board
under the temp HOME), `--wakers` (arm the scheduler), `--keep` (don't delete the temp HOME on exit).

**Cleanup:** send SIGTERM/SIGINT (kill the background Bash task) — it deletes the temp HOME automatically.
Always kill it before you come to rest; never rest on a running stack.

---

## 2. Driving the app — headless, with screenshots

### Preferred when it's available and free: Chrome DevTools MCP
When the `chrome-devtools` MCP is connected, use it for rich inspection: `new_page` → `navigate_page` →
`take_snapshot` (a11y tree, best for locating elements) / `take_screenshot` / `list_console_messages` /
`list_network_requests` / `click` / `fill` / `evaluate_script`.

> **Gotcha (hit this for real):** chrome-devtools-mcp launches ONE Chrome on a single shared
> `chrome-profile`. If a Chrome is already running on that profile (a prior session, the user's own), every
> `new_page` fails with *"The browser is already running … Use --isolated"*. It is often NOT free to use in
> a background/headless run. When it collides or isn't connected, fall straight to the puppeteer path below —
> don't fight it.

### Reliable headless/background path: `ui/scripts/shot.mjs` (puppeteer)
`shot.mjs` launches its **own isolated headless Chrome** every run (no shared profile, no collision), so it
works in the background unconditionally. It screenshots and runs an in-page `evaluate` in one shot, and
prints any page/console errors. This is the workhorse for "prove it renders" and responsive checks.

```bash
# screenshot + assert board state (the eval's completion value prints as json)
node scripts/shot.mjs "http://127.0.0.1:4930/" .adhoc-shots/board-desktop.png \
  "({title: document.title, threads: document.querySelectorAll('[data-thread-slug]').length})" \
  --w=1440 --h=900 --wait=2500

# narrow viewport for responsive/overflow checks
node scripts/shot.mjs "http://127.0.0.1:4930/" .adhoc-shots/board-narrow.png "" --w=420 --h=880

# a complex in-page routine (occlusion/alignment/optical-center) from a file
node scripts/shot.mjs "$URL" out.png @/tmp/routine.js
```

Always: capture **desktop + narrow** widths, read the screenshots back, and check the `PAGE ERRORS:` line
— a clean render with console errors is not a pass. Exercise the relevant active/idle/error/restart states,
not just first paint.

### Seeding real state
An empty board proves the shell renders but not much else. To exercise real flows, drive the app's own RPC
surface (`POST /rpc`) or the UI itself (type a task in the composer via `shot.mjs`'s evaluate / CDP `fill`)
so the state is created the way production creates it — never hand-write rows into the sandbox SQLite.

---

## 3. Focused real-subsystem harnesses (backend behavior)

Browser QA can't reach tmux sockets, the resume/wake path, SQLite migrations, or the scheduler. For those,
write a small `tsx` harness that spins the **real** resource and asserts the **real** function — mocks prove
nothing about tmux. Pattern (`ui/scripts/verify-legacy-wake.mjs` is a worked example for the legacy-socket
wake fix):

```
import { execFileSync } from "node:child_process"
import { theFixedFunction } from "../packages/server/src/<module>.ts"
// 1. create the real precondition (a real tmux pane on a real socket, a real sqlite db, …)
// 2. call the real function
// 3. PASS/FAIL each assertion to stdout; process.exit(1) on any failure
// 4. tear the real resource down in finally
```

Include **negative controls** (an identity-mismatch case that must still be rejected), not just the happy
path — that's what proves a widened code path didn't weaken a safety check. A good harness catches your own
bugs: `verify-legacy-wake.mjs` caught a trailing-quote boundary bug in a matcher on its first run because it
used the production argv form instead of a hand-quoted string. Replicate production faithfully.

---

## 4. Before you rest

- Kill every background stack you booted (temp HOME auto-cleans on SIGTERM).
- Put the **decisive** screenshots (not bulk) into your handoff with **markdown image syntax**
  — `![meaningful alt](/abs/path.png)` — NOT `SendUserFile` (that pushes a file as a deliverable; it is
  not inline handoff evidence). The fray chat renders a local image only when its real path sits under a
  `/local-image` **trusted root**: `ctx.project.dir`, `os.tmpdir()`, `~/Screenshots`, or the project's
  `attachments/` dir. `.adhoc-shots/` (where `shot.mjs` writes by default) is gitignored and under NONE of
  those, so `![](.adhoc-shots/…)` 403s and renders broken. So: `--out` the shot to (or `cp` the decisive
  one into) `os.tmpdir()` and embed THAT absolute path. Keep a concise textual finding + process-cleanup note.
- If a gate was skipped (MCP unavailable, a state you couldn't reach), say so plainly — don't imply coverage
  you didn't have.
