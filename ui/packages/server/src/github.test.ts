import { test } from "node:test"
import assert from "node:assert/strict"
import { GITHUB_DISPATCH_UI_BOUNDARY } from "@fray-ui/shared"
import {
  sumReactions,
  commentCount,
  parseListJson,
  truncateBody,
  renderGithubPrompt,
  effectiveTemplate,
  DEFAULT_ISSUE_PROMPT,
  DEFAULT_PR_PROMPT,
  type HydratedIssue,
  type HydratedPr,
} from "./github.ts"

// All tests inject gh output (no real gh shell-out) — the parsing/scoring/templating fns are pure.

// ---- sumReactions ----

test("sumReactions: sums totalCount across reaction groups", () => {
  const groups = [
    { content: "THUMBS_UP", users: { totalCount: 347 } },
    { content: "HEART", users: { totalCount: 71 } },
    { content: "ROCKET", users: { totalCount: 31 } },
  ]
  assert.equal(sumReactions(groups), 449)
})

test("sumReactions: empty / missing / malformed → 0, never throws", () => {
  assert.equal(sumReactions([]), 0)
  assert.equal(sumReactions(undefined), 0)
  assert.equal(sumReactions(null), 0)
  assert.equal(sumReactions("nope"), 0)
  assert.equal(sumReactions([{ content: "X" }]), 0) // no users
  assert.equal(sumReactions([{ users: {} }]), 0) // no totalCount
  assert.equal(sumReactions([{ users: { totalCount: "3" } }]), 0) // non-numeric ignored
})

// ---- commentCount ----

test("commentCount: array length (gh returns the comment ARRAY, not a count)", () => {
  assert.equal(commentCount([{ body: "a" }, { body: "b" }, { body: "c" }]), 3)
  assert.equal(commentCount([]), 0)
})

test("commentCount: tolerates a bare number; absent/garbage → undefined", () => {
  assert.equal(commentCount(12), 12)
  assert.equal(commentCount(undefined), undefined)
  assert.equal(commentCount(-1), undefined)
  assert.equal(commentCount("5"), undefined)
})

// ---- parseListJson ----

test("parseListJson: issues — maps fields, sums reactions, counts comment array", () => {
  const raw = JSON.stringify([
    {
      number: 326,
      title: "Support multiple accounts",
      url: "https://github.com/cli/cli/issues/326",
      reactionGroups: [
        { content: "THUMBS_UP", users: { totalCount: 347 } },
        { content: "HEART", users: { totalCount: 71 } },
      ],
      updatedAt: "2026-07-01T00:00:00Z",
      comments: [{ body: "x" }, { body: "y" }],
      createdAt: "2026-06-01T00:00:00Z",
      author: { login: "octocat", name: "The Octocat" },
      labels: [{ name: "enhancement", color: "a2eeef", description: "…" }],
      state: "OPEN",
    },
  ])
  const items = parseListJson(raw, "issues")
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    kind: "issue",
    number: 326,
    title: "Support multiple accounts",
    url: "https://github.com/cli/cli/issues/326",
    reactions: 418,
    updatedAt: "2026-07-01T00:00:00Z",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    comments: 2,
    createdAt: "2026-06-01T00:00:00Z",
    author: "octocat",
    state: "OPEN",
  })
})

test("parseListJson: prs — kind='pr', empty reactionGroups → 0, no comments field", () => {
  const raw = JSON.stringify([
    {
      number: 13844,
      title: "perf(status): O(1) map lookup",
      url: "https://github.com/cli/cli/pull/13844",
      reactionGroups: [],
      updatedAt: "2026-07-10T15:01:40Z",
    },
  ])
  const items = parseListJson(raw, "prs")
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "pr")
  assert.equal(items[0].number, 13844)
  assert.equal(items[0].reactions, 0)
  assert.equal(items[0].comments, undefined)
})

test("parseListJson: skips rows with a bad/missing number; keeps valid ones", () => {
  const raw = JSON.stringify([
    { title: "no number" },
    { number: 0, title: "zero" },
    { number: -5, title: "negative" },
    { number: 7, title: "good", url: "u", updatedAt: "t" },
  ])
  const items = parseListJson(raw, "issues")
  assert.equal(items.length, 1)
  assert.equal(items[0].number, 7)
})

test("parseListJson: unparseable / non-array → [] (never throws)", () => {
  assert.deepEqual(parseListJson("not json", "issues"), [])
  assert.deepEqual(parseListJson("{}", "issues"), [])
  assert.deepEqual(parseListJson("42", "prs"), [])
})

test("parseListJson: missing string fields default to ''", () => {
  const raw = JSON.stringify([{ number: 3 }])
  const [it] = parseListJson(raw, "issues")
  assert.equal(it.title, "")
  assert.equal(it.url, "")
  assert.equal(it.updatedAt, "")
  assert.equal(it.reactions, 0)
})

// ---- truncateBody ----

test("truncateBody: short body passes through unchanged", () => {
  assert.equal(truncateBody("hello", 5, "issue"), "hello")
})

test("truncateBody: long body is capped with a pointer to the full item", () => {
  const big = "x".repeat(20_000)
  const outIssue = truncateBody(big, 42, "issue")
  assert.ok(outIssue.length < big.length)
  assert.ok(outIssue.includes("[truncated — read full via `gh issue view 42`]"))
  const outPr = truncateBody(big, 99, "pr")
  assert.ok(outPr.includes("[truncated — read full via `gh pr view 99`]"))
})

// ---- prompt templating (renderGithubPrompt) ----

const issue: HydratedIssue = {
  number: 326,
  title: "Support multiple accounts",
  body: "When I switch accounts the token is wrong.",
  url: "https://github.com/cli/cli/issues/326",
  labels: ["enhancement", "auth"],
}

test("renderGithubPrompt: substitutes all tokens + prepends the THREAD tag", () => {
  const tmpl = "Repo {repo} · Issue #{n}: {title}\nURL: {url}\nLabels: {labels}\n--\n{body}"
  const p = renderGithubPrompt(tmpl, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  assert.ok(p.startsWith("THREAD: investigate-cli-cli-326\n\n"))
  assert.ok(p.includes("Repo cli/cli · Issue #326: Support multiple accounts"))
  assert.ok(p.includes("URL: https://github.com/cli/cli/issues/326"))
  assert.ok(p.includes("Labels: enhancement, auth"))
  assert.ok(p.includes("When I switch accounts the token is wrong."))
})

test("renderGithubPrompt: generated compact lead precedes an exact UI boundary; full template remains below it", () => {
  const template = "INTERNAL TEMPLATE\nRepo={repo}\nBody={body}\n<!-- ordinary-custom-comment -->"
  const p = renderGithubPrompt(template, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  const marker = `\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n`
  const cut = p.indexOf(marker)
  assert.notEqual(cut, -1)
  assert.equal(
    p.slice(0, cut),
    "THREAD: investigate-cli-cli-326\n\nInvestigate this issue and make recommendations\n\nIssue #326: Support multiple accounts\nRepository: cli/cli\nURL: https://github.com/cli/cli/issues/326",
  )
  assert.equal(
    p.slice(cut + marker.length),
    "INTERNAL TEMPLATE\nRepo=cli/cli\nBody=When I switch accounts the token is wrong.\n<!-- ordinary-custom-comment -->",
  )
  assert.equal(p.split(GITHUB_DISPATCH_UI_BOUNDARY).length - 1, 1)
})

test("renderGithubPrompt: empty labels render 'none'", () => {
  const p = renderGithubPrompt("Labels: {labels}", "cli/cli", { ...issue, labels: [] }, "s", "issue")
  assert.ok(p.includes("Labels: none"))
})

test("renderGithubPrompt: oversized body is truncated (kind-aware pointer)", () => {
  const pIssue = renderGithubPrompt("{body}", "cli/cli", { ...issue, body: "y".repeat(20_000) }, "s", "issue")
  assert.ok(pIssue.includes("[truncated — read full via `gh issue view 326`]"))
  const pPr = renderGithubPrompt("{body}", "cli/cli", { ...issue, number: 99, body: "y".repeat(20_000) }, "s", "pr")
  assert.ok(pPr.includes("[truncated — read full via `gh pr view 99`]"))
})

test("renderGithubPrompt: single-pass — a {token} INSIDE item content is NOT re-expanded (no injection)", () => {
  // A hostile body/title containing a placeholder must appear verbatim, never re-substituted.
  const evil = { ...issue, title: "{repo}", body: "leak {url} {n} {labels}" }
  const p = renderGithubPrompt("T={title}\nB={body}", "cli/cli", evil, "s", "issue")
  assert.ok(p.includes("T={repo}")) // title's literal "{repo}" survives, not re-expanded to cli/cli
  assert.ok(p.includes("B=leak {url} {n} {labels}")) // body placeholders survive verbatim
})

test("renderGithubPrompt: unknown {placeholder} in the template is left verbatim", () => {
  const p = renderGithubPrompt("known {repo} unknown {frobnicate}", "cli/cli", issue, "s", "issue")
  assert.ok(p.includes("known cli/cli unknown {frobnicate}"))
})

test("DEFAULT_ISSUE_PROMPT: branches on bug vs feature; DEFAULT_PR_PROMPT is the audit template", () => {
  // Issue default instructs classify + both branches.
  assert.ok(/classify/i.test(DEFAULT_ISSUE_PROMPT))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("IF BUG:"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("IF FEATURE:"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("REPRODUCE"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("IMPACT"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("read-only"))
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("```done```"))
  assert.ok(!DEFAULT_ISSUE_PROMPT.includes("bare rest"))
  // The defaults are TEMPLATES: they carry {token}s and NOT the THREAD tag (the server prepends it).
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("{repo}") && DEFAULT_ISSUE_PROMPT.includes("{n}"))
  assert.ok(!DEFAULT_ISSUE_PROMPT.includes("THREAD:"))
  // PR default is the adversarial audit template.
  assert.ok(DEFAULT_PR_PROMPT.includes("AUDIT thread"))
  assert.ok(DEFAULT_PR_PROMPT.includes("gh pr diff {n} -R {repo}"))
  assert.ok(DEFAULT_PR_PROMPT.includes("keep CI/bot/merge"))
  assert.ok(DEFAULT_PR_PROMPT.includes("backend wait primitive"))
  assert.ok(DEFAULT_PR_PROMPT.includes("```done```"))
  assert.ok(!DEFAULT_PR_PROMPT.includes("bare rest"))
  assert.ok(!DEFAULT_PR_PROMPT.includes("THREAD:"))
  // The body is NOT inlined in the shipped defaults — the worker fetches it via the gh CLI, keeping
  // prompt transport small (the generated UI boundary separately keeps the visible bubble compact).
  assert.ok(!DEFAULT_ISSUE_PROMPT.includes("{body}"), "issue default must not inline the body")
  assert.ok(!DEFAULT_PR_PROMPT.includes("{body}"), "PR default must not inline the body")
  assert.ok(DEFAULT_ISSUE_PROMPT.includes("gh issue view {n} -R {repo}"))
  assert.ok(DEFAULT_PR_PROMPT.includes("gh pr view {n} -R {repo}"))
})

test("DEFAULT_ISSUE_PROMPT renders into a real issue prompt (round-trip through renderGithubPrompt)", () => {
  const p = renderGithubPrompt(DEFAULT_ISSUE_PROMPT, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  assert.ok(p.startsWith("THREAD: investigate-cli-cli-326\n\n"))
  assert.ok(p.includes("Issue #326: Support multiple accounts"))
  assert.ok(p.includes("gh issue view 326 -R cli/cli --comments"))
  assert.ok(!p.includes("{repo}") && !p.includes("{n}")) // every token filled
})

const pr: HydratedPr = {
  number: 13844,
  title: "perf(status): O(1) map lookup",
  body: "Replaces the O(n) scan with a map.",
  url: "https://github.com/cli/cli/pull/13844",
  labels: ["external"],
  files: 2,
}

test("DEFAULT_PR_PROMPT renders into a real PR prompt (diff/checks by number)", () => {
  const p = renderGithubPrompt(DEFAULT_PR_PROMPT, "cli/cli", pr, "review-cli-cli-13844", "pr")
  assert.ok(p.startsWith("THREAD: review-cli-cli-13844\n\n"))
  assert.ok(p.includes("PR #13844: perf(status): O(1) map lookup"))
  assert.ok(p.includes("gh pr diff 13844 -R cli/cli"))
  assert.ok(p.includes("gh pr checks 13844 -R cli/cli"))
  assert.ok(p.includes("read-only"))
})

// ---- effectiveTemplate (settings override vs default fallback) ----

test("effectiveTemplate: unset/blank falls back to the shipped default", () => {
  assert.equal(effectiveTemplate("issue", undefined), DEFAULT_ISSUE_PROMPT)
  assert.equal(effectiveTemplate("issue", ""), DEFAULT_ISSUE_PROMPT)
  assert.equal(effectiveTemplate("issue", "   \n\t "), DEFAULT_ISSUE_PROMPT) // whitespace-only = unset
  assert.equal(effectiveTemplate("pr", undefined), DEFAULT_PR_PROMPT)
  assert.equal(effectiveTemplate("pr", ""), DEFAULT_PR_PROMPT)
})

test("effectiveTemplate: a non-blank override is used verbatim (per kind)", () => {
  assert.equal(effectiveTemplate("issue", "my custom {title}"), "my custom {title}")
  assert.equal(effectiveTemplate("pr", "review {n}"), "review {n}")
})
