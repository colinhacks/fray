import { test } from "node:test"
import assert from "node:assert/strict"
import { isPathCandidate } from "./localFileCode.ts"

test("isPathCandidate accepts path-like inline code", () => {
  for (const v of [
    "~/.claude/CLAUDE.md",
    "~",
    "/Users/me/artifacts/shot.png",
    "packages/web/src/App.tsx",
    "./foo/bar.ts",
    "../sibling/x.md",
    "packages/web/src/App.tsx:42:7", // an editor :line[:col] suffix is still a candidate (stripped server-side)
    "a/b", // any slash-bearing token is a candidate; the server decides if it's real
  ]) assert.equal(isPathCandidate(v), true, v)
})

test("isPathCandidate rejects non-paths: commands, bare words, URLs, whitespace, and over-long text", () => {
  for (const v of [
    "git status", // whitespace → a command, not a path
    "npm run build",
    "useState", // bare identifier, no slash
    "package.json", // bare filename (no slash) — deliberately excluded from v1 to avoid statting every word
    "README", // bare word
    "https://example.com/x.png", // URL
    "file:///Users/me/x.png", // URL scheme
    "cursor://file/Users/me/x.png", // URL scheme
    "", // empty
    "  ", // whitespace only
    `/${"x".repeat(2000)}`, // over the length cap
  ]) assert.equal(isPathCandidate(v), false, v)
})
