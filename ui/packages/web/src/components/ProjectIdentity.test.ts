import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { IdentityMark, projectIdentity } from "./Sidebar.tsx"

function board(projectLabel: string) {
  return { projectLabel }
}

function render(label: string | null, connection: "connecting" | "open" | "closed" = "connecting"): string {
  return renderToStaticMarkup(createElement(IdentityMark, {
    identity: projectIdentity(label === null ? null : board(label)),
    state: connection,
  }))
}

test("cold project loading reserves a quiet identity measure without guessing fray", () => {
  const html = render(null)

  assert.match(html, /data-project-identity-state="loading"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /aria-label="Project identity loading; connecting…"/)
  assert.match(html, /class="identity-placeholder" aria-hidden="true"/)
  assert.doesNotMatch(html, />fray</)
  assert.doesNotMatch(html, /animate-/)
})

test("the first verified board identity renders directly as owner/repo", () => {
  const html = render("openai/fray", "open")

  assert.match(html, /data-project-identity-state="verified"/)
  assert.match(html, /aria-label="Project: openai\/fray; connected"/)
  assert.match(html, /<span class="text-muted">openai<\/span>/)
  assert.match(html, /<span class="font-semibold text-fg\/90">fray<\/span>/)
  assert.doesNotMatch(html, /identity-placeholder/)
})

test("a reconnect retains the currently adopted verified identity", () => {
  // The app keeps its last adopted board while the stream reconnects; projectIdentity is deliberately
  // stateless, so passing that same board cannot flash a loading fallback.
  const identity = projectIdentity(board("openai/fray"))
  const html = renderToStaticMarkup(createElement(IdentityMark, { identity, state: "connecting" }))

  assert.equal(identity.state, "verified")
  assert.match(html, /Project: openai\/fray; connecting…/)
  assert.doesNotMatch(html, /identity-placeholder/)
})

test("a new boot or project has no retained identity and only accepts its own board", () => {
  const prior = projectIdentity(board("openai/old-project"))
  const freshBoot = projectIdentity(null)
  const replacement = projectIdentity(board("other-org/new-project"))

  assert.deepEqual(prior, { state: "verified", label: "openai/old-project", owner: "openai", repo: "old-project" })
  assert.deepEqual(freshBoot, { state: "loading" })
  assert.deepEqual(replacement, { state: "verified", label: "other-org/new-project", owner: "other-org", repo: "new-project" })
})

test("a board without an owner/repo identity stays neutral rather than showing its directory name", () => {
  const identity = projectIdentity(board("fray"))
  const html = render("fray", "open")

  assert.deepEqual(identity, { state: "unavailable" })
  assert.match(html, /aria-label="Project identity unavailable; connected"/)
  assert.match(html, /identity-placeholder/)
  assert.doesNotMatch(html, />fray</)
})

test("long repository names remain truncatable and expose the full accessible identity", () => {
  const label = "an-owner-with-a-long-name/a-repository-name-that-needs-to-truncate-in-the-corner"
  const html = render(label, "open")

  assert.match(html, /class="block min-w-0 truncate"/)
  assert.match(html, new RegExp(`title="${label}"`))
  assert.match(html, new RegExp(`aria-label="Project: ${label}; connected"`))
})

test("the resolved identity and live status form one compact flexible cluster", () => {
  const html = render("openai/fray", "open")

  assert.match(html, /class="identity-slot identity-slot--resolved"/)
  assert.match(html, /class="flex items-center gap-1 shrink-0"/)
  assert.doesNotMatch(html, /w-16/)
  assert.doesNotMatch(html, /identity-slot--placeholder/)
})
