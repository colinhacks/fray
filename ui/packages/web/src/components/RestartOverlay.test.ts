import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RestartOverlay } from "./RestartOverlay.tsx"

test("closed overlay renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(RestartOverlay, { open: false })), "")
})

test("open overlay is a full-viewport modal block above every modal", () => {
  const html = renderToStaticMarkup(createElement(RestartOverlay, { open: true }))
  assert.match(html, /role="alertdialog"/)
  assert.match(html, /aria-modal="true"/)
  // Full-viewport scrim that intercepts pointer paths, sitting above the tallest surface — the
  // shared Radix Dialog is z-[200], so the overlay must clear it at z-[300].
  assert.match(html, /fixed inset-0/)
  assert.match(html, /z-\[300\]/)
  assert.doesNotMatch(html, /z-\[200\]/)
  assert.match(html, /Updating and restarting Fray/)
  assert.match(html, /animate-spin/)
  // The focusable card is what we park focus on so Tab cannot reach a background control.
  assert.match(html, /tabindex="-1"/)
})

test("a supervisor message renders as a status sub-line, blank ones are dropped", () => {
  const withMessage = renderToStaticMarkup(createElement(RestartOverlay, { open: true, message: "Promoting build 42" }))
  assert.match(withMessage, /Promoting build 42/)
  const blank = renderToStaticMarkup(createElement(RestartOverlay, { open: true, message: "   " }))
  const paragraphs = (blank.match(/<p /g) ?? []).length
  assert.equal(paragraphs, 1)
})
