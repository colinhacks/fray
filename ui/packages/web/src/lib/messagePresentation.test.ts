import { test } from "node:test"
import assert from "node:assert/strict"
import { messagePresentationText } from "./messagePresentation.ts"

test("messagePresentationText prefers a validated display projection without changing full text", () => {
  const message = { text: "compact\n\n<!-- boundary -->\n\nlarge machine tail", displayText: "compact" }
  assert.equal(messagePresentationText(message), "compact")
  assert.match(message.text, /large machine tail/)
})

test("messagePresentationText leaves ordinary messages and HTML comments untouched", () => {
  const text = "Example:\n<!-- an ordinary comment -->\nstill visible"
  assert.equal(messagePresentationText({ text }), text)
})
