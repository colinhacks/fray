# GitHub-first batch dispatch — implementation plan

Status: PLANNING. This is a file-level build spec for a new fray-ui feature. No code is written yet.

## Goal

When the opened project is a GitHub repo:
1. **Auth detection** — server learns whether the user is signed into `gh`; UI prompts to sign in if not.
2. **Picker modal** — lists the repo's Issues and PRs (tabs), sortable by recency or reactions, multi-select checkboxes.
3. **Batch dispatch** — each checked ISSUE spins up an "investigate/reproduce/recommend" fray thread; each checked PR spins up a review thread. Reuses the existing dispatch flow.
4. **Conditional gh skill injection** — teach workers to use `gh` eagerly, but ONLY when signed in.
5. **toon synergy** — encourage workers to pipe large `gh … --json | toon`.

---

## 1. Architecture map (verified by reading the code)

### RPC layer (how endpoints are declared + handled)
- `packages/rpc/src/server.ts` — `query()` / `mutation()` / `stream()` builders; `mountRouter(app, "/rpc", router)` mounts each proc as `GET /rpc/<name>` (query, input via `?input=<json>`) or `POST /rpc/<name>` (mutation, JSON body). Input/output validated by the proc's zod schemas.
- `packages/server/src/router.ts` — `createRouter(ctx)` returns the proc map. Every handler is thin and reads from `ctx` (the wired singletons). This is where new procs are added.
- `packages/server/src/context.ts` — `AppContext`: `project`, `storage`, `board`, `tailer`, `dispatcher`, `getSettings`, etc. Built once at boot in `createContext()`.
- `packages/server/src/app.ts` — line 168 mounts the router: `mountRouter(app, "/rpc", createRouter(ctx))`.
- **Web mirror**: `packages/web/src/api/rpc.ts` is a HAND-MAINTAINED mirror — the `Api` interface (method sigs) AND the `PROCEDURES` map (`"query"`/`"mutation"`). Every new endpoint must be added in BOTH places or the client proxy returns `undefined`. `rpc.<name>(input)` is the call surface; TanStack `useQuery`/`useMutation` wrap it in components.

### Dispatch flow, end to end
- `packages/server/src/dispatch.ts`:
  - `createDispatcher({ project, storage, board, getSettings, claudeBin })` → `{ dispatch(input), adopt(slug, message) }`.
  - `dispatch(input: DispatchInput)`: derive title (`input.title` or `fallbackTitle(prompt)`) → slug (`slugify` + `resolveSlug`) → fresh `sessionId` (UUID) → `writeScratchpad()` → `composePrompt(sessionId, input.prompt, settings.dispatchPreamble)` → `buildClaudeCommand({ sessionId, permissionMode, model, effort, prompt, pluginDir: workerPluginDir(), extraSystemPrompt: scratchpadOrientation(...) })` → `tmux.spawn(slug, cmd, project.dir, { FRAY_UI_THREAD: slug })` → `storage.upsertSession(...)` → `board.rebuild()` → returns `{ slug, sessionId }`.
  - The **system prompt** is assembled in `buildClaudeCommand`: `[loadWorkerPrompt(), extraSystemPrompt].join("\n\n")`, written to a per-session file passed via `--append-system-prompt-file` (inline blows tmux's command-length limit — see comment at dispatch.ts:158).
  - `DispatchInput` (shared, line 259): `{ prompt, title?, slug?, permissionMode?, model?, effort?, planPath? }`.
- **Web dispatch UI**: `packages/web/src/components/NewThreadModal.tsx`:
  - `DispatchForm` — the shared prompt box (`Composer` + model/effort/permission `Select` readouts). `useMutation(() => rpc.dispatch(input))` with `showToast` lifecycle.
  - `NewThreadDialog` — the anywhere-modal: `<Overlay onClose>` + a centered `div` (`w-[640px] max-w-[86vw] rounded-xl border border-border bg-panel p-5`) wrapping `DispatchForm`.
  - `Overlay` — the frosted backdrop (`fixed inset-0 z-50 … backdrop-blur-md`), backdrop-click closes. **Reuse this for the picker.**

### How the server learns the project + whether it's a GitHub repo
- `packages/server/src/project.ts`:
  - `resolveProjectDir()` — git toplevel of cwd.
  - `resolveProjectLabel(dir)` — parses `git remote get-url origin` into `owner/repo` (`parseRepoLabel` handles ssh + https). Returns `null` for no remote. **This yields owner/repo but does NOT confirm the host is GitHub or that gh can resolve it.**
  - `Project` carries `dir`, `id`, `name`, `label`, `stateDir`, `cwdSlug`.
- The authoritative GitHub signal is `gh repo view --json nameWithOwner` (verified: succeeds only when gh resolves the repo on github.com). Use gh, not the git label, for the `inRepo` decision — a gitlab origin must read as NOT a GitHub repo.

### Modals + store/board (web)
- `packages/web/src/store.ts` — single valtio `proxy`. Boolean flags drive overlays: `showSettings`, `showNewThread`, `showPalette`. `openNewThread(planPath?)` sets the flag. Toasts via `showToast(text, opts)`. The board arrives as a full `BoardSnapshot` over SSE (`setBoard`).
- `packages/web/src/App.tsx` — mounts overlays off the snapshot: line 228–229 `{snap.showSettings && <SettingsDrawer/>}`, `{snap.showNewThread && <NewThreadDialog .../>}`. `overlayOpen` (line 40) gates global key handling. `openNewThread()` bound to ⌘N (line 89). **The picker mounts here the same way.**
- `BoardSnapshot` (shared line 220): `projectDir`, `projectName`, `projectLabel`, `frayActive`, `threads`, `errors`, `warnings`, `errorItems?`, `plans?`. Extended with optional fields for back-compat.
- Reusable UI: `packages/web/src/components/ui/Select.tsx` (the readout selects), `Menu.tsx`, `Dialog.tsx`; `packages/web/src/lib/options.ts` (`MODEL_OPTIONS`, `EFFORT_OPTIONS`, `PERMISSION_OPTIONS`, `PERMISSION_COLOR`).

### Worker prompt / skill injection points
- `ui/WORKER_PROMPT.md` — the FIXED worker system prompt (loaded by `loadWorkerPrompt()` in dispatch.ts, stripped of its provenance header). Not user-editable.
- `cc-worker/skills/worker/SKILL.md` — the worker-contract skill (loadable as `fray:worker`). Sibling skill dir is `cc-worker/skills/`.
- `cc-worker/hooks/session-seed.mjs` — **SessionStart hook**, runs on every start/resume/clear/compact, gated on `FRAY_UI_THREAD`. Injects the worker contract + scratchpad path via `hookSpecificOutput.additionalContext`. Runs `node`, zero deps, in the worker's env (so `gh` is on its PATH). **This is the correct auth-gated injection site** — it can shell `gh auth status` live at every session start and covers dispatch + resume + compact uniformly, with no server changes to the dispatch/resume argv.
- `cc-worker/.claude-plugin/plugin.json` + `cc-worker/hooks/hooks.json` — plugin manifest + hook registration. `workerPluginDir()` in dispatch.ts resolves `cc-worker` and passes it via `--plugin-dir`, so its skills are loadable by workers.
- NOTE the repo layout: the git root is `/Users/colinmcd94/Documents/projects/fray`; `ui/` and `cc-worker/` are siblings under it. `workerPluginDir()` resolves `../../../../cc-worker` from `packages/server/src`.

---

## 2. Verified `gh` / `toon` capabilities (exact commands)

All run from a repo dir; `-R owner/repo` makes them dir-independent. gh is authed via keyring (account colinhacks), scopes include `repo`, `workflow`.

```bash
# Auth (exit 0 = signed in; non-zero = not)
gh auth status --active        # exit 0 when signed in
gh auth token                  # exit 0, prints token when signed in

# Is this a GitHub repo gh can resolve? (succeeds only for a gh-resolvable GitHub repo)
gh repo view --json nameWithOwner -q .nameWithOwner   # -> "owner/repo"

# Issues, reaction-sorted (server-side sort — do NOT recompute client-side)
gh issue list -R OWNER/REPO --search "sort:reactions-desc" \
  --json number,title,url,reactionGroups,updatedAt,comments --limit 30

# Issues, recency
gh issue list -R OWNER/REPO --search "sort:updated-desc" \
  --json number,title,url,reactionGroups,updatedAt,comments --limit 30

# PRs (recency default order, or explicit search sort)
gh pr list -R OWNER/REPO --search "sort:updated-desc" \
  --json number,title,url,reactionGroups,updatedAt --limit 30

# Single item hydration at dispatch time (full body, fresh)
gh issue view N -R OWNER/REPO --json number,title,body,url,labels,reactionGroups
gh pr view    N -R OWNER/REPO --json number,title,body,url,labels,additions,deletions,files

# toon pipe (worker-side only — see toon decision)
gh issue list -R OWNER/REPO --json number,title,url --limit 30 | ~/.nvm/versions/node/v24.14.0/bin/toon
```

**`reactionGroups` shape**: `[{ content: "THUMBS_UP"|"HEART"|…, users: { totalCount: N } }]`. To show a reaction count in the picker, sum `users.totalCount` across groups. The list ORDER already reflects reactions when `--search "sort:reactions-desc"` is used; the count is just a display badge.

**toon measurement**: `gh issue list … --json …reactionGroups… --limit 10 | toon --stats` → **~2% token savings** on reaction-nested data (nesting defeats tabularization). Flat `number,title,url` tabularizes well but is small. Conclusion in §7.

---

## 3. Files to add / edit

### Add
| File | Purpose |
|---|---|
| `packages/server/src/github.ts` | gh-wrapper module (auth, list, hydrate, batch-prompt helpers). |
| `packages/server/src/github.test.ts` | Unit tests for parsing/scoring/prompt-templating (pure fns; gh calls injected). |
| `packages/web/src/components/GithubPickerModal.tsx` | The picker modal component. |
| `cc-worker/skills/gh/SKILL.md` | The `fray:gh` skill (deep gh + toon guidance) workers load. |

### Edit
| File | Change |
|---|---|
| `packages/shared/src/index.ts` | Add zod schemas: `GithubStatus`, `GithubItem`, `GithubListInput`, `GithubBatchInput`, `GithubBatchResult`. |
| `packages/server/src/router.ts` | Add `githubStatus` (query), `githubList` (query), `githubDispatchBatch` (mutation). |
| `packages/server/src/context.ts` | Add a cached `github` helper (auth+repo detection) to `AppContext` (optional; see §4). |
| `packages/web/src/api/rpc.ts` | Add the 3 methods to `Api` + `PROCEDURES`. |
| `packages/web/src/store.ts` | Add `showGithubPicker` flag + `openGithubPicker()` / close. |
| `packages/web/src/App.tsx` | Mount `<GithubPickerModal>` off `snap.showGithubPicker`; add close-on-Esc. |
| `packages/web/src/components/HeaderActions.tsx` (or wherever the "New thread" pill lives) | Add a "From GitHub" trigger button, shown only when `githubStatus.inRepo`. |
| `cc-worker/hooks/session-seed.mjs` | Append an auth-gated gh+toon guidance block to `additionalContext`. |

---

## 4. Server-side gh-wrapper module design — `packages/server/src/github.ts`

Design principles, matching existing code (`project.ts`, `open-external.ts`): use `execFile`/`execFileSync` with an **args array, no shell** (no injection surface); repo string comes from trusted detection, `number` is a validated integer; every gh call gets a **timeout** (keyring/network can stall); failures degrade gracefully (never throw into a board build).

```ts
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const pexec = promisify(execFile)
const GH_TIMEOUT = 8000

// Run gh with args; parse JSON stdout. Throws GhError on non-zero (caller decides).
async function gh(args: string[]): Promise<string> {
  const { stdout } = await pexec("gh", args, { timeout: GH_TIMEOUT, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

// --- Detection (cached) ---
export async function ghInstalled(): Promise<boolean>          // `gh --version` exit 0
export async function ghAuthed(): Promise<boolean>             // `gh auth status --active` exit 0
export async function ghRepo(dir: string): Promise<string|null> // `gh repo view --json nameWithOwner`; null if not a GH repo

export interface GithubStatus { installed: boolean; inRepo: boolean; nameWithOwner: string|null; authed: boolean }
export async function githubStatus(dir: string): Promise<GithubStatus>

// --- Listing ---
export type GhKind = "issues" | "prs"
export type GhSort = "recent" | "reactions"
export interface GithubItem { kind: "issue"|"pr"; number: number; title: string; url: string; reactions: number; updatedAt: string; comments?: number }
export async function listItems(repo: string, kind: GhKind, sort: GhSort, limit: number): Promise<GithubItem[]>
//   issues -> gh issue list -R repo --search "sort:{reactions-desc|updated-desc}" --json number,title,url,reactionGroups,updatedAt,comments --limit N
//   prs    -> gh pr list    -R repo --search "sort:{reactions-desc|updated-desc}" --json number,title,url,reactionGroups,updatedAt --limit N
//   reactions = sum of reactionGroups[].users.totalCount

// --- Hydration (at dispatch, fresh full body) ---
export async function hydrateIssue(repo: string, n: number): Promise<{ number:number; title:string; body:string; url:string; labels:string[] }>
export async function hydratePr(repo: string, n: number): Promise<{ number:number; title:string; body:string; url:string; labels:string[]; files:number }>

// --- Prompt templating (pure; unit-tested) ---
export function issueInvestigatePrompt(repo: string, it: {number,title,body,url,labels}): string
export function prReviewPrompt(repo: string, it: {number,title,body,url,labels,files}): string
```

**Caching** (`context.ts`): detection (installed/inRepo/nameWithOwner) is stable for the process lifetime — resolve once at boot into `ctx.github = { installed, inRepo, nameWithOwner }`. `authed` can flip mid-session (user runs `gh auth login`), so re-check it live on each `githubStatus` query (cheap, ~8ms). Keep detection OUT of the board snapshot to avoid a shell-out on every delta.

---

## 5. New RPC endpoints — `packages/server/src/router.ts` + shared schemas

### shared/src/index.ts (new schemas)
```ts
export const GithubStatus = z.object({
  installed: z.boolean(),
  inRepo: z.boolean(),
  nameWithOwner: z.string().nullable(),
  authed: z.boolean(),
})
export const GithubItem = z.object({
  kind: z.enum(["issue", "pr"]),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  reactions: z.number().int().nonnegative(),
  updatedAt: z.string(),
  comments: z.number().int().nonnegative().optional(),
})
export const GithubListInput = z.object({
  kind: z.enum(["issues", "prs"]),
  sort: z.enum(["recent", "reactions"]),
  limit: z.number().int().min(1).max(100).default(30),
})
export const GithubBatchInput = z.object({
  // Minimal — the server re-hydrates title/body/url fresh from gh (always current, small wire payload).
  items: z.array(z.object({ kind: z.enum(["issue", "pr"]), number: z.number().int().positive() })).min(1).max(20),
  model: z.string().optional(),
  effort: Settings.shape.effort,
  permissionMode: PermissionMode.optional(),
})
export const GithubBatchResult = z.object({
  dispatched: z.array(z.object({ number: z.number(), kind: z.string(), slug: z.string() })),
  failed: z.array(z.object({ number: z.number(), kind: z.string(), error: z.string() })),
})
```

### router.ts (new procs)
```ts
githubStatus: query({
  output: GithubStatus,
  handler: async () => githubStatus(ctx.project.dir),   // uses ctx.github cache + live authed re-check
}),

githubList: query({
  input: GithubListInput,
  output: z.object({ items: z.array(GithubItem) }),
  handler: async ({ input }) => {
    const repo = ctx.github?.nameWithOwner
    if (!repo) return { items: [] }
    return { items: await listItems(repo, input.kind, input.sort, input.limit) }
  },
}),

githubDispatchBatch: mutation({
  input: GithubBatchInput,
  output: GithubBatchResult,
  handler: async ({ input }) => {
    const repo = ctx.github?.nameWithOwner
    if (!repo) throw new Error("not a GitHub repo")
    const dispatched = [], failed = []
    // SEQUENTIAL — each dispatch spawns a tmux session; a burst of 20 at once hammers the box.
    for (const it of input.items) {
      try {
        const hydrated = it.kind === "issue" ? await hydrateIssue(repo, it.number) : await hydratePr(repo, it.number)
        const prompt = it.kind === "issue" ? issueInvestigatePrompt(repo, hydrated) : prReviewPrompt(repo, hydrated)
        const title = `${it.kind === "issue" ? "Investigate" : "Review"} ${repo}#${it.number}`
        const { slug } = await ctx.dispatcher.dispatch({ prompt, title, model: input.model, effort: input.effort, permissionMode: input.permissionMode })
        dispatched.push({ number: it.number, kind: it.kind, slug })
      } catch (e) {
        failed.push({ number: it.number, kind: it.kind, error: (e as Error).message.slice(0, 120) })
      }
    }
    return { dispatched, failed }
  },
}),
```

Batch dispatch REUSES `ctx.dispatcher.dispatch` — no new spawn logic, and templates live server-side (single source of truth, unit-testable). Passing an explicit `title` skips the fallback-chop so the slug reads `investigate-cli-cli-1234`.

### web/src/api/rpc.ts (mirror)
Add to `Api`:
```ts
githubStatus(): Promise<GithubStatus>
githubList(input: { kind: "issues"|"prs"; sort: "recent"|"reactions"; limit?: number }): Promise<{ items: GithubItem[] }>
githubDispatchBatch(input: GithubBatchInput): Promise<GithubBatchResult>
```
Add to `PROCEDURES`: `githubStatus: "query"`, `githubList: "query"`, `githubDispatchBatch: "mutation"`.

---

## 6. Web: modal + gating + batch flow

### Trigger + auth prompt
- Add `showGithubPicker: boolean` to `store.ts` + `openGithubPicker()`.
- `useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })` in `HeaderActions` (near the "New thread" pill).
- Render logic:
  - `!status.inRepo` → render nothing (feature hidden).
  - `status.inRepo && !status.authed` → button reads "Sign in to GitHub"; click opens a small instruction modal: *"Run `gh auth login` in a terminal, then reload."* (We cannot drive interactive `gh auth login` from the server safely; instruct the human.)
  - `status.inRepo && status.authed` → button "From GitHub" → `openGithubPicker()`.
- `App.tsx`: mount `{snap.showGithubPicker && <GithubPickerModal onClose={...}/>}` next to the NewThread mount; add `else if (store.showGithubPicker) store.showGithubPicker = false` to the Esc chain.

### `GithubPickerModal.tsx` structure
Reuse `Overlay` from `NewThreadModal.tsx` (export it if not already — it IS exported). Dialog sized wider (`w-[720px] max-w-[90vw]`).

```
<Overlay onClose>
  <div class="… bg-panel p-5" onKeyDownCapture={Esc→onClose}>
    header: "Dispatch from GitHub — {nameWithOwner}"
    tabs:   [ Issues | PRs ]           -> local state `kind`
    sort:   [ Recent | Reactions ]     -> local state `sort` (Select/segmented)
    list:   useQuery(["githubList", {kind, sort}]) -> rows:
            [x] #1234  Title text…            💬 12   ▲ 47
            (checkbox toggles a Set<number>; row click toggles too)
            loading -> skeleton; empty -> "No open {issues|prs}"
    footer: model/effort/permission Selects (reuse MODEL_OPTIONS/EFFORT_OPTIONS/PERMISSION_OPTIONS)
            + "Dispatch N thread(s)" button (disabled when selection empty)
  </div>
</Overlay>
```

- Selection is a `Set<number>` PER kind (switching tabs preserves each tab's selection, or clear on tab switch — pick clear-on-switch for simplicity; document the choice).
- On Dispatch: `useMutation(() => rpc.githubDispatchBatch({ items: [...selection].map(n => ({kind: kind==="issues"?"issue":"pr", number: n})), model, effort, permissionMode }))`.
  - `onMutate`: `showToast("Starting N threads…", { spinner, sticky })`.
  - `onSuccess(res)`: `showToast(\`Started \${res.dispatched.length} thread(s)\${res.failed.length?\` (\${res.failed.length} failed)\`:""}\`)`; close the modal. New threads appear in the sidebar via the board SSE rebuild (dispatch already calls `board.rebuild()`).
- Reaction badge: display `item.reactions` (already summed server-side). Do NOT re-sort client-side — the server order is authoritative.

### Batch-dispatch data flow (summary)
```
[checkboxes: Set<number>] --Dispatch--> rpc.githubDispatchBatch({items:[{kind,number}], model, effort, mode})
   server: for each item (SEQUENTIAL)
     -> hydrate{Issue,Pr}(repo, n)         (gh … view N --json …body…)
     -> {issueInvestigate|prReview}Prompt   (server-side template)
     -> ctx.dispatcher.dispatch({prompt,title,model,effort,mode})   (EXISTING flow: scratchpad+spawn+row+rebuild)
   -> {dispatched:[{number,kind,slug}], failed:[…]}
   client: toast + close; board SSE paints the new sidebar rows
```

---

## 7. Prompt templates (server-side, written out)

`{repo}` = `owner/repo`; `{n}`, `{title}`, `{url}`, `{labels}`, `{body}` from hydration. Body is fenced to avoid its markdown bleeding into the prompt. These reference the issue/PR by number/title/body/url as required.

### `issueInvestigatePrompt` (checked ISSUES)
```
THREAD: {slug}

You are investigating a GitHub issue in {repo}. This is a RESEARCH thread: the deliverable is
FINDINGS and a recommendation — not a landed fix.

Issue #{n}: {title}
URL: {url}
Labels: {labels}

--- issue body ---
{body}
------------------

Do this:
1. REPRODUCE. Establish whether the reported behavior actually happens on the current tree. If it
   reproduces, capture the exact steps, command, and output. If it does NOT, say so and show what
   you observed instead.
2. INVESTIGATE. Trace the cause to concrete code — cite exact file:line for every load-bearing
   claim (an uncited claim is a LEAD, flag it). Use `gh` to read the full issue thread, linked
   issues/PRs, and related history when useful (`gh issue view {n} -R {repo} --comments`).
3. RECOMMEND. State the smallest correct fix (or the top 2 options with the tradeoff of each), the
   files it touches, and the risk. Do NOT implement it — this thread stops at the recommendation.

Post NOTHING to GitHub (no comments, no labels, no close) unless the human explicitly asks — read-only.

Handback: put your findings + recommendation in your FINAL MESSAGE (bare rest = "your move"), or a
```question``` block if a human call is needed. If the fix is obvious, small, and you have high
confidence, you MAY end with a ```question approval``` proposing to implement it.
```

### `prReviewPrompt` (checked PRs)
```
THREAD: {slug}

You are reviewing an open pull request in {repo}. This is an AUDIT thread: adversarially verify the
change is correct, safe, and complete before recommending merge.

PR #{n}: {title}
URL: {url}
Labels: {labels}

--- PR description ---
{body}
----------------------

Do this:
1. READ THE DIFF. `gh pr diff {n} -R {repo}` (pipe large output through toon — see below). Read the
   changed files in context, not just the hunks.
2. VERIFY. For each substantive change, ask: is it correct? does it handle edges? does it break
   existing behavior or the public API? are there tests, and do they actually cover the change?
   Check CI: `gh pr checks {n} -R {repo}`.
3. RECOMMEND. Approve / request-changes / needs-discussion, with a concise findings list — each
   concern citing exact file:line in the diff. Distinguish blocking issues from nits.

Post NOTHING to GitHub (no review, no comment, no approve/merge) unless the human explicitly asks —
read-only; produce the review as your final message.

Handback: your review in your FINAL MESSAGE (bare rest), or a ```question approval``` if you want a
go/no-go on posting the review to GitHub.
```

Both templates: keep `{body}` truncated defensively (e.g. cap at ~8KB) so a giant issue body can't blow the tmux prompt path — though the prompt already goes through `--append-system-prompt-file`… note the TASK prompt is a CLI arg, not the file, so a huge body IS a real tmux-arg-length risk. **Cap the body in the template** (append "… [truncated — read full via `gh issue view {n}`]").

---

## 8. Skill injection + the exact auth gate

Two coordinated pieces, both gated on gh auth:

### (a) Session-seed hook block — `cc-worker/hooks/session-seed.mjs` (primary mechanism)
Already runs on every SessionStart, gated on `FRAY_UI_THREAD`, in the worker's env. Add, AFTER the existing `core` composition:

```js
import { execFileSync } from 'node:child_process';
// … after `const parts = [core];`
let ghAuthed = false;
try { execFileSync('gh', ['auth', 'status', '--active'], { stdio: 'ignore', timeout: 4000 }); ghAuthed = true; } catch {}
if (ghAuthed) parts.push(GH_BLOCK);   // GH_BLOCK defined below
```

`GH_BLOCK` (the injected guidance — auth-gated, so absent when not signed in):
```
⟦gh available⟧ You are signed into the `gh` CLI in a GitHub repo. Use `gh` EAGERLY and well —
it is the fastest path to issue/PR/CI/release context:
• Read: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`,
  `gh run list`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping text.
• Search across the repo's issues/PRs with `gh search issues`/`gh search prs`.
• WRITE ONLY when the human explicitly asks — never auto-comment/label/close/merge.
• TOON: pipe LARGE `gh … --json` output through toon to cut tokens ~30–40% on flat data:
  `gh issue list -R OWNER/REPO --json number,title,url --limit 50 | "$HOME/.nvm/versions/node/v24.14.0/bin/toon"`
  toon is NOT on PATH — use the absolute path above (or `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`
  once at the start of a shell). Skip toon for tiny payloads or deeply-nested JSON (savings are noise there).
Load the `fray:gh` skill for the full playbook.
```

This is the exact gate: `gh auth status --active` exit 0 → inject; else nothing. It re-evaluates every session start/resume/compact, so a later `gh auth login` starts injecting on the next turn boundary. It fires for gh-authed sessions even in a non-GitHub dir — harmless (the guidance is inert if there's no repo), but you MAY additionally gate on `gh repo view` succeeding if you want it strictly repo-scoped.

### (b) The `fray:gh` skill — `cc-worker/skills/gh/SKILL.md`
A fuller playbook the block tells the worker to load: the read-vs-write boundary, the toon shim, common recipes (triage, diff review, CI watch tied to the ```awaiting``` fence's `ci:`/`pr:` hints), and the "never post without explicit ask" rule. Frontmatter mirrors `skills/worker/SKILL.md` (`name: gh`, `description:` triggering on gh/GitHub/issue/PR work, `metadata.internal: true`). It ships in the same plugin dir already passed via `--plugin-dir`, so no manifest change is needed beyond the file existing (verify `hooks.json`/plugin discovery picks up `skills/*` automatically — it already discovers `skills/worker` and `skills/dialectic`).

**Why the hook, not a dispatch.ts append**: the hook covers dispatch + resume + compact with one gate and re-checks auth live; a server-side `extraSystemPrompt` append would have to be threaded through BOTH `buildClaudeCommand` (dispatch/adopt) AND `buildClaudeResumeCommand` (resume.ts) and would bake auth state at dispatch time. The hook is the smaller, more robust change.

---

## 9. toon decision

- **Server-side picker fetch: do NOT use toon.** The server parses gh JSON directly; that JSON never enters an LLM context, so toon (a token-reduction format for LLM context) is irrelevant there. Also measured: reaction-nested list JSON tabularizes poorly → only ~2% savings even if it mattered.
- **Worker-side: YES, teach it (via §8).** The payoff is real when a WORKER reads LARGE, FLAT `gh` output into ITS context (issue/PR search results, `gh api` list pages). Provide the absolute-path shim (`$HOME/.nvm/versions/node/v24.14.0/bin/toon`) because toon is NOT on the default PATH, plus the one-time `export PATH=…` alternative. Tell it to skip toon for tiny or deeply-nested payloads (savings are noise; the nesting kills tabularization).
- Net: toon is a WORKER-behavior nudge in the injected skill, not a server code path.

---

## 10. Risks / unknowns

1. **gh not installed / not on PATH** — `githubStatus.installed=false` hides the feature entirely. Detection must not throw into the board build.
2. **gh latency / keyring stalls** — every server-side gh call needs a timeout (8s) + spinner in the UI; a slow `gh auth status` shouldn't wedge an RPC.
3. **Interactive `gh auth login` cannot be driven from the server** — the not-authed path INSTRUCTS the human to run it in a terminal; we only detect. (Confirm the product wants detection-only, not an embedded login.)
4. **Repo host ≠ GitHub** (gitlab/bitbucket origin) — `gh repo view` fails → `inRepo=false`. Correct, but means `project.label` (git-remote parse) and `github.nameWithOwner` (gh) can disagree; USE the gh value for all GitHub calls.
5. **Batch spawn burst** — 20 checked issues = 20 tmux sessions. Dispatch SEQUENTIALLY (done in the handler) and cap `items` at 20 in the schema. Consider a lower default cap.
6. **Huge issue/PR bodies** — the TASK prompt is a tmux CLI arg (not the system-prompt FILE), so a giant body risks the same command-length limit dispatch.ts already fights. Truncate `{body}` in the templates (~8KB).
7. **Rate limits** — large repos + high limits + reaction search can hit gh API limits; surface gh's error message in `failed[]` and the list query rather than swallowing.
8. **Auth-gate flap** — the hook re-checks per session start; a mid-turn `gh auth login` won't inject until the next start/resume. Acceptable.
9. **Skill auto-discovery** — confirm the worker plugin discovers `skills/gh/` without a manifest edit (it discovers `skills/worker` + `skills/dialectic` today; a new sibling should be automatic — verify).
10. **`gh` writes from workers** — the injected guidance says read-only unless asked, but a worker COULD comment/close. The prompt templates + skill both forbid it; there is no hard server enforcement. Flag if stronger guarantees are wanted (e.g. a `GH_TOKEN`-scoped read-only token — not currently feasible with the keyring auth).

---

## 11. Phased build order

- **Phase 0 — schemas + wiring skeleton.** Add the 5 zod schemas to `shared/src/index.ts`. Add the 3 methods to `web/src/api/rpc.ts` (`Api` + `PROCEDURES`). `npm run typecheck`.
- **Phase 1 — `github.ts` + tests.** Implement detection, listing, hydration, `reactions` summing, and the two prompt templates (pure fns). `github.test.ts` covers scoring + templating with injected gh output. No UI yet.
- **Phase 2 — RPC endpoints.** Add `githubStatus` / `githubList` / `githubDispatchBatch` to `router.ts`; add the cached `github` detection to `context.ts`. Verify by curl: `GET /rpc/githubStatus`, `GET /rpc/githubList?input=…`.
- **Phase 3 — picker UI.** `store.ts` flag + `openGithubPicker`; `GithubPickerModal.tsx` (tabs/sort/checkboxes/footer/dispatch); mount in `App.tsx`; trigger button + auth-prompt in `HeaderActions`. Drive it in the live app against `cli/cli` (has issues + PRs).
- **Phase 4 — skill injection.** `session-seed.mjs` gh block + auth gate; `skills/gh/SKILL.md`. Spawn a worker while authed and confirm the block appears; sign out and confirm it does NOT.
- **Phase 5 — verify end to end.** Open the picker in a real GitHub repo, check 2 issues + 1 PR, dispatch, confirm 3 threads appear in the sidebar with the right prompts, and that a dispatched worker uses `gh`/`toon` per the injected skill. Run `npm run typecheck` + `npm test` from the repo root.

Gates: `npm run typecheck` and `npm test` (repo root) must pass at the end of each phase that touches typed/tested code.
