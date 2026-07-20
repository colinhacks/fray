import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ToolDisclosureHeader } from "./ToolDisclosureHeader.ts"

function disclosureBounds(html: string): { start: number; end: number } {
  const marker = html.indexOf("data-tool-disclosure")
  assert.notEqual(marker, -1, "disclosure marker must render")
  const start = html.lastIndexOf("<button", marker)
  const end = html.indexOf("</button>", marker) + "</button>".length
  assert.ok(start >= 0 && end > start, "disclosure button must be well formed")
  return { start, end }
}

test("renders file and expansion actions as siblings with a complete disclosure name", () => {
  const html = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "fray-diff-header",
      controls: "edit-body-1",
      expanded: false,
      label: "Expand Edit diff: /repo/src/app.ts",
      onToggle: () => {},
      children: createElement("a", { href: "cursor://file/repo/src/app.ts" }, "app.ts"),
    }),
  )

  const disclosure = disclosureBounds(html)
  const linkStart = html.indexOf("<a ")
  const linkEnd = html.indexOf("</a>") + "</a>".length
  assert.ok(linkStart >= 0 && linkEnd < disclosure.start, "file link must precede, not nest in, the disclosure button")
  assert.equal(html.slice(disclosure.start, disclosure.end).includes("<a "), false)
  assert.match(html.slice(disclosure.start, disclosure.end), /type="button"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-controls="edit-body-1"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-expanded="false"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-label="Expand Edit diff: \/repo\/src\/app\.ts"/)
  assert.match(html, /data-expanded="false"/)
  assert.doesNotMatch(html, /role="button"/)
})

test("keeps an Agent drill-in button separate from the expanded disclosure state", () => {
  const html = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "fray-bash-header",
      controls: "agent-prompt-1",
      expanded: true,
      label: "Collapse Agent prompt: Review permissions",
      onToggle: () => {},
      children: createElement("button", { type: "button", "aria-label": "Open sub-agent transcript: Review permissions" }, "Review permissions"),
    }),
  )

  const disclosure = disclosureBounds(html)
  const firstButton = html.indexOf("<button")
  const firstButtonEnd = html.indexOf("</button>", firstButton) + "</button>".length
  assert.ok(firstButton >= 0 && firstButtonEnd < disclosure.start, "drill-in and expansion must be separate native buttons")
  assert.equal((html.match(/<button\b/g) ?? []).length, 2)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-controls="agent-prompt-1"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-expanded="true"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-label="Collapse Agent prompt: Review permissions"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /rotate-90/)
  assert.match(html, /data-expanded="true"/)
  assert.equal(html.slice(firstButton, firstButtonEnd).includes("aria-expanded"), false)
})

test("renders a running indicator only when the individual tool disclosure supplies one", () => {
  const running = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "fray-bash-header",
      controls: "bash-body-running",
      expanded: false,
      label: "Expand Bash: watch CI",
      onToggle: () => {},
      meta: createElement("span", { className: "fray-live-dot", "data-running-indicator": "tool-disclosure", "aria-hidden": true }),
      children: "watch CI",
    }),
  )
  const terminal = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "fray-bash-header",
      controls: "bash-body-done",
      expanded: false,
      label: "Expand Bash: completed CI",
      onToggle: () => {},
      meta: createElement("span", null, "done"),
      children: "completed CI",
    }),
  )

  assert.match(running, /data-running-indicator="tool-disclosure"/)
  assert.match(running, /fray-live-dot/)
  assert.match(running, /flex shrink-0 items-center gap-1\.5/, "the status cluster and disclosure control use the compact shared rhythm")
  assert.match(running, /relative -top-px shrink-0 transition-transform/, "the disclosure glyph receives its optical vertical correction")
  assert.doesNotMatch(terminal, /data-running-indicator/)
  assert.doesNotMatch(terminal, /fray-live-dot/)
})
