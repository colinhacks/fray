import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { GithubItem } from "@fray-ui/shared"

// gh-CLI wrapper. Design principles (matching project.ts / open-external.ts): every call is
// execFile with an ARGS ARRAY, NEVER a shell string, so a repo/number can never be reinterpreted
// as a command (no injection surface); the repo string comes from trusted detection and `number`
// is a validated positive integer; every gh call gets a hard TIMEOUT (keyring/network can stall);
// and DETECTION failures degrade gracefully (return false/null — never throw into a board build /
// boot). Listing/hydration DO surface gh errors (rate-limit, network) to their RPC caller rather
// than swallowing them into an empty, misleading result (see risk 7).

const pexec = promisify(execFile)
const GH_TIMEOUT = 8000 // ms — every gh call; a slow keyring/network must never wedge an RPC or boot
const GH_MAXBUF = 16 * 1024 * 1024 // 16MB — a wide `--json` list can be large

// Run gh with an args array (no shell) and return stdout. Throws on non-zero exit / timeout — the
// caller decides whether to degrade (detection) or surface (listing/hydration).
async function gh(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await pexec("gh", args, { timeout: GH_TIMEOUT, maxBuffer: GH_MAXBUF, cwd: opts.cwd })
  return stdout
}

// --- Detection (cached at boot; see context.ts) ---

// `gh --version` exit 0 → the binary is on PATH.
export async function ghInstalled(): Promise<boolean> {
  try {
    await gh(["--version"])
    return true
  } catch {
    return false
  }
}

// `gh auth status --active` exit 0 → signed in. Re-checked live on each githubStatus query (cheap).
export async function ghAuthed(): Promise<boolean> {
  try {
    await gh(["auth", "status", "--active"])
    return true
  } catch {
    return false
  }
}

// The authoritative GitHub signal: `gh repo view` in `dir` succeeds ONLY for a gh-resolvable GitHub
// repo (a gitlab/bitbucket origin fails → null). Uses the dir's own git remote (no -R), so it must
// run with cwd=dir. Returns "owner/repo" or null. Never throws.
export async function ghRepo(dir: string): Promise<string | null> {
  try {
    const out = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: dir })
    const s = out.trim()
    return s || null
  } catch {
    return null
  }
}

// The stable (process-lifetime) detection triple, resolved once at boot and cached on ctx.github.
export interface GithubDetection {
  installed: boolean
  inRepo: boolean
  nameWithOwner: string | null
}

// Resolve installed + inRepo/nameWithOwner. Never throws (each probe swallows its own failure), so
// it is safe to call at boot without wedging startup on a broken/absent gh. NOTE: `gh repo view`
// needs auth, so a boot done while signed out caches inRepo:false — the router does NOT trust a
// cached-negative inRepo and re-resolves live (see resolveRepo in router.ts) so a post-boot
// `gh auth login` lights up the feature without a restart. A POSITIVE result is stable.
export async function detectGithub(dir: string): Promise<GithubDetection> {
  const installed = await ghInstalled()
  if (!installed) return { installed: false, inRepo: false, nameWithOwner: null }
  const nameWithOwner = await ghRepo(dir)
  return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner }
}

// The full status is composed in the router (githubStatus handler), which owns the ctx.github cache
// and warms it via resolveRepo — `authed` is re-checked live there so a mid-session sign-in reflects.

// --- Listing ---

export type GhKind = "issues" | "prs"
export type GhSort = "recent" | "reactions"

// gh's server-side sort — the list ORDER is authoritative (do NOT recompute client-side).
const SEARCH_SORT: Record<GhSort, string> = {
  reactions: "sort:reactions-desc",
  recent: "sort:updated-desc",
}

// Sum the reaction totals across reactionGroups: `[{ content, users: { totalCount } }]`. Pure +
// defensive — a foreign JSON shape must never throw; unknown/missing counts contribute 0.
export function sumReactions(groups: unknown): number {
  if (!Array.isArray(groups)) return 0
  let total = 0
  for (const g of groups) {
    const n = (g as { users?: { totalCount?: unknown } })?.users?.totalCount
    if (typeof n === "number" && Number.isFinite(n)) total += n
  }
  return total
}

// `gh issue list --json comments` returns the full comment ARRAY (capped ~100 by gh), not a count —
// so the badge count is its length. Tolerate a bare number too (defensive). Absent → undefined.
export function commentCount(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
  return undefined
}

// gh `labels` = `[{ name, color, … }]` — keep the name + 6-hex color for the row chips. Defensive:
// a foreign shape yields []; nameless entries are dropped.
export function parseLabels(v: unknown): { name: string; color: string }[] {
  if (!Array.isArray(v)) return []
  const out: { name: string; color: string }[] = []
  for (const l of v) {
    const o = l as { name?: unknown; color?: unknown }
    if (typeof o?.name === "string" && o.name) out.push({ name: o.name, color: typeof o?.color === "string" ? o.color : "" })
  }
  return out
}

// Parse the raw `gh {issue,pr} list --json …` output into GithubItems. PURE + defensive (this is the
// unit-tested seam — tests inject gh JSON here instead of shelling out): bad rows are skipped, missing
// fields default, and `kind` stamps the item discriminant. Reactions summed; comments length-counted.
export function parseListJson(raw: string, kind: GhKind): GithubItem[] {
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const itemKind = kind === "issues" ? "issue" : "pr"
  const out: GithubItem[] = []
  for (const row of arr) {
    const r = row as Record<string, unknown>
    const number = typeof r?.number === "number" ? r.number : Number(r?.number)
    if (!Number.isInteger(number) || number <= 0) continue
    const item: GithubItem = {
      kind: itemKind,
      number,
      title: typeof r?.title === "string" ? r.title : "",
      url: typeof r?.url === "string" ? r.url : "",
      reactions: sumReactions(r?.reactionGroups),
      updatedAt: typeof r?.updatedAt === "string" ? r.updatedAt : "",
      labels: parseLabels(r?.labels),
    }
    const c = commentCount(r?.comments)
    if (c !== undefined) item.comments = c
    if (typeof r?.createdAt === "string") item.createdAt = r.createdAt
    const login = (r?.author as { login?: unknown } | null)?.login
    if (typeof login === "string") item.author = login
    if (typeof r?.state === "string") item.state = r.state
    if (typeof r?.isDraft === "boolean") item.isDraft = r.isDraft
    out.push(item)
  }
  return out
}

// Clamp the limit to gh's sane range (the schema already bounds 1..100; belt-and-suspenders).
function clampLimit(limit: number): number {
  if (!Number.isInteger(limit)) return 30
  return Math.max(1, Math.min(100, limit))
}

// List a repo's issues or PRs, gh-sorted. Lets a gh error (rate limit / network) PROPAGATE to the
// RPC caller (surfaced, not swallowed — risk 7). Only a malformed-but-successful JSON body degrades
// to []. issues carry `comments`; PRs do not (no comment field requested).
export async function listItems(repo: string, kind: GhKind, sort: GhSort, limit: number): Promise<GithubItem[]> {
  const sub = kind === "issues" ? "issue" : "pr"
  const fields =
    kind === "issues"
      ? "number,title,url,reactionGroups,updatedAt,comments,createdAt,author,labels,state"
      : "number,title,url,reactionGroups,updatedAt,comments,createdAt,author,labels,state,isDraft"
  const raw = await gh([sub, "list", "-R", repo, "--search", SEARCH_SORT[sort], "--json", fields, "--limit", String(clampLimit(limit))])
  return parseListJson(raw, kind)
}

// --- Hydration (at dispatch, fresh full body) ---

export interface HydratedIssue {
  number: number
  title: string
  body: string
  url: string
  labels: string[]
}
export interface HydratedPr extends HydratedIssue {
  files: number
}

// labels arrive as `[{ name, … }]`; keep just the names. Defensive against a foreign shape.
function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((l) => (l as { name?: unknown })?.name).filter((n): n is string => typeof n === "string")
}

// Guard the issue/PR number before it becomes a gh argv token. There is no shell (args array), so
// this is not an injection guard — it just refuses to spend a gh call on a nonsensical number.
function requirePositiveInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid issue/PR number: ${String(n)}`)
  return n
}

export async function hydrateIssue(repo: string, n: number): Promise<HydratedIssue> {
  const num = requirePositiveInt(n)
  const raw = await gh(["issue", "view", String(num), "-R", repo, "--json", "number,title,body,url,labels,reactionGroups"])
  const d = JSON.parse(raw) as Record<string, unknown>
  return {
    number: typeof d.number === "number" ? d.number : num,
    title: typeof d.title === "string" ? d.title : "",
    body: typeof d.body === "string" ? d.body : "",
    url: typeof d.url === "string" ? d.url : "",
    labels: labelNames(d.labels),
  }
}

export async function hydratePr(repo: string, n: number): Promise<HydratedPr> {
  const num = requirePositiveInt(n)
  // `files` is the only extra field the review template / picker consumes; additions/deletions are
  // not surfaced, so they are not fetched.
  const raw = await gh(["pr", "view", String(num), "-R", repo, "--json", "number,title,body,url,labels,files"])
  const d = JSON.parse(raw) as Record<string, unknown>
  return {
    number: typeof d.number === "number" ? d.number : num,
    title: typeof d.title === "string" ? d.title : "",
    body: typeof d.body === "string" ? d.body : "",
    url: typeof d.url === "string" ? d.url : "",
    labels: labelNames(d.labels),
    files: Array.isArray(d.files) ? d.files.length : 0,
  }
}

// --- Prompt templating (pure; unit-tested) ---

// The TASK prompt is a raw tmux CLI arg (NOT the system-prompt file), so a giant issue/PR body risks
// tmux's command-length limit (see dispatch.ts:158). Cap the body defensively and mark the cut with
// a pointer to the full item. ~8KB is far under the limit while preserving the substance.
const BODY_CAP = 8 * 1024
export function truncateBody(body: string, n: number, kind: "issue" | "pr"): string {
  if (body.length <= BODY_CAP) return body
  const cut = body.slice(0, BODY_CAP).trimEnd()
  const cmd = kind === "issue" ? `gh issue view ${n}` : `gh pr view ${n}`
  return `${cut}\n\n… [truncated — read full via \`${cmd}\`]`
}

function labelsLine(labels: string[]): string {
  return labels.join(", ") || "none"
}

// --- Default templates (exported; the batch handler prefers the user's Settings override) ---
//
// These are TEMPLATE STRINGS with {token} placeholders that renderGithubPrompt substitutes:
// {repo} {n} {title} {url} {labels} {body}. They deliberately do NOT carry the leading
// `THREAD: <slug>` tag — renderGithubPrompt prepends it (see there) so a user's custom template can
// never omit/mangle it and orphan the thread's .fray file. Edit these to change the shipped defaults;
// a user override (Settings.githubIssuePrompt / githubPrPrompt) supersedes at dispatch time.

// The ISSUE default. Branches on report type: the worker first classifies bug-vs-feature, then a
// BUG gets reproduce → trace → recommend, and a FEATURE gets clarify → impact → plan. Research only.
// The body is deliberately NOT inlined ({body} is unused here) — the worker fetches it via
// `gh issue view`, keeping the dispatched first-message bubble small (a giant body dump used to fill
// the whole thread UI). A user's custom Settings template MAY still use {body} if they prefer inlining.
export const DEFAULT_ISSUE_PROMPT = `You are triaging a GitHub issue in {repo}. This is a RESEARCH thread: the deliverable is FINDINGS and
a recommendation — not a landed fix.

Issue #{n}: {title}
URL: {url}
Labels: {labels}

Read the full issue FIRST — \`gh issue view {n} -R {repo} --comments\` (title, body, and the discussion).
Then classify it as a BUG report or a FEATURE request from the body + labels + thread, state which it is
and why, then branch:

IF BUG:
1. REPRODUCE. Establish whether the reported behavior actually happens on the current tree. If it
   reproduces, capture the exact steps, command, and output. If it does NOT, say so and show what you
   observed instead.
2. INVESTIGATE. Trace the cause to concrete code — cite exact file:line for every load-bearing claim
   (an uncited claim is a LEAD, flag it). Read linked issues/PRs and related history when useful.
3. RECOMMEND. State the smallest correct fix (or the top 2 options with the tradeoff of each), the
   files it touches, and the risk. Do NOT implement it — this thread stops at the recommendation.

IF FEATURE:
1. CLARIFY. Restate the request precisely: what the user wants, the use-case behind it, and any
   ambiguity a maintainer would have to resolve before building it.
2. IMPACT. Map where it lands in the code — the files/modules a real implementation would touch, the
   public API / UX surface it changes, and the migration / back-compat concerns. Cite file:line.
3. PLAN. Sketch a concrete implementation plan (smallest viable version first), the risks and open
   design questions, and a rough effort/size estimate. Do NOT implement it — stop at the plan.

Post NOTHING to GitHub (no comments, no labels, no close) unless the human explicitly asks — read-only.

Handback: put your findings + recommendation in your FINAL MESSAGE (bare rest = "your move"), or a
\`\`\`question\`\`\` block if a human call is needed. If the next step is obvious, small, and you have high
confidence, you MAY end with a \`\`\`question approval\`\`\` proposing to implement it.`

// The PR default: an adversarial review/audit before recommending merge. Read-only.
export const DEFAULT_PR_PROMPT = `You are reviewing an open pull request in {repo}. This is an AUDIT thread: adversarially verify the
change is correct, safe, and complete before recommending merge.

PR #{n}: {title}
URL: {url}
Labels: {labels}

Read the PR FIRST — \`gh pr view {n} -R {repo} --comments\` (description + discussion), then:
1. READ THE DIFF. \`gh pr diff {n} -R {repo}\` (pipe large output through toon). Read the changed files
   in context, not just the hunks.
2. VERIFY. For each substantive change, ask: is it correct? does it handle edges? does it break
   existing behavior or the public API? are there tests, and do they actually cover the change?
   Check CI: \`gh pr checks {n} -R {repo}\`.
3. RECOMMEND. Approve / request-changes / needs-discussion, with a concise findings list — each
   concern citing exact file:line in the diff. Distinguish blocking issues from nits.

Post NOTHING to GitHub (no review, no comment, no approve/merge) unless the human explicitly asks —
read-only; produce the review as your final message.

Handback: your review in your FINAL MESSAGE (bare rest), or a \`\`\`question approval\`\`\` if you want a
go/no-go on posting the review to GitHub.`

// --- Pure templater (unit-tested seam) ---

// Common item shape both hydrations satisfy (HydratedPr's extra `files` is unused by the templates).
export interface PromptItem {
  number: number
  title: string
  url: string
  labels: string[]
  body: string
}

// The 6 substitution tokens a template may reference. Kept in one place so the UI hint, the tests,
// and the replace-regex stay in lockstep.
export const PROMPT_TOKENS = ["repo", "n", "title", "url", "labels", "body"] as const

// Render a batch-dispatch prompt from a template STRING (the shipped default OR the user's Settings
// override) against a hydrated item. PURE — the unit-tested seam. Behavior:
//  • Substitutes {repo} {n} {title} {url} {labels} {body} in a SINGLE pass, so a {token} that appears
//    inside a substituted value (e.g. a hostile issue body containing "{repo}") is NOT re-expanded —
//    there is no injection-via-item-content and no order-dependence between tokens.
//  • {body} is truncated defensively (kind-aware pointer) so a giant issue/PR body can't blow tmux's
//    arg-length limit (the task prompt is a CLI arg, not the system-prompt file — see dispatch.ts).
//  • Prepends the `THREAD: <slug>` tag itself: it is NOT part of the editable template, so a custom
//    prompt can never drop/mangle it and orphan the thread's .fray file.
//  • An unknown {placeholder} in the template is left verbatim (only the 6 known tokens are replaced).
export function renderGithubPrompt(template: string, repo: string, it: PromptItem, slug: string, kind: "issue" | "pr"): string {
  const subs: Record<(typeof PROMPT_TOKENS)[number], string> = {
    repo,
    n: String(it.number),
    title: it.title,
    url: it.url,
    labels: labelsLine(it.labels),
    body: truncateBody(it.body, it.number, kind),
  }
  const filled = template.replace(/\{(repo|n|title|url|labels|body)\}/g, (_m, k: (typeof PROMPT_TOKENS)[number]) => subs[k])
  return `THREAD: ${slug}\n\n${filled}`
}

// Pick the EFFECTIVE template: the user's Settings override when it is present and non-blank, else the
// shipped default. Whitespace-only is treated as unset so a stray space/newline can't blank the prompt.
export function effectiveTemplate(kind: "issue" | "pr", custom: string | undefined): string {
  if (custom && custom.trim().length > 0) return custom
  return kind === "issue" ? DEFAULT_ISSUE_PROMPT : DEFAULT_PR_PROMPT
}
