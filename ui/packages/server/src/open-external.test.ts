import { test } from "node:test"
import assert from "node:assert/strict"
import { validateExternalUrl } from "./open-external.ts"

test("allowed: http URL → ok", () => {
  const r = validateExternalUrl("http://example.com/path?q=1")
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.url, "http://example.com/path?q=1")
})

test("allowed: https URL → ok", () => {
  const r = validateExternalUrl("https://github.com/fray/ui/issues/1")
  assert.equal(r.ok, true)
})

test("blocked: javascript: scheme → rejected", () => {
  assert.equal(validateExternalUrl("javascript:alert(1)").ok, false)
})

test("blocked: file: scheme → rejected", () => {
  assert.equal(validateExternalUrl("file:///etc/passwd").ok, false)
})

test("blocked: data: scheme → rejected", () => {
  assert.equal(validateExternalUrl("data:text/html,<script>alert(1)</script>").ok, false)
})

test("blocked: mailto: scheme → rejected", () => {
  assert.equal(validateExternalUrl("mailto:a@b.com").ok, false)
})

test("blocked: garbage / unparseable → rejected", () => {
  assert.equal(validateExternalUrl("not a url").ok, false)
  assert.equal(validateExternalUrl("").ok, false)
})

test("blocked: shell metacharacters do not bypass the scheme check", () => {
  // Even a string with shell-dangerous characters is rejected unless it parses as http(s).
  assert.equal(validateExternalUrl("http; rm -rf /").ok, false)
  assert.equal(validateExternalUrl("$(rm -rf /)").ok, false)
})
