import { test } from "node:test"
import assert from "node:assert/strict"
import { parseRepoLabel } from "./project.ts"

test("parseRepoLabel: scp-like ssh with .git", () => {
  assert.equal(parseRepoLabel("git@github.com:owner/repo.git"), "owner/repo")
})

test("parseRepoLabel: scp-like ssh without .git", () => {
  assert.equal(parseRepoLabel("git@github.com:owner/repo"), "owner/repo")
})

test("parseRepoLabel: https with .git", () => {
  assert.equal(parseRepoLabel("https://github.com/owner/repo.git"), "owner/repo")
})

test("parseRepoLabel: https without .git and trailing slash", () => {
  assert.equal(parseRepoLabel("https://github.com/owner/repo/"), "owner/repo")
})

test("parseRepoLabel: ssh:// url form", () => {
  assert.equal(parseRepoLabel("ssh://git@github.com/owner/repo.git"), "owner/repo")
})

test("parseRepoLabel: nested gitlab group keeps final owner/repo", () => {
  assert.equal(parseRepoLabel("https://gitlab.com/group/sub/repo.git"), "sub/repo")
})

test("parseRepoLabel: junk / empty → null", () => {
  assert.equal(parseRepoLabel(""), null)
  assert.equal(parseRepoLabel("not-a-url"), null)
})
