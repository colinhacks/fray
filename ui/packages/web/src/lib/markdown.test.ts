import { test } from "node:test"
import assert from "node:assert/strict"
import { stripFrontmatter } from "./markdown.ts"

// stripFrontmatter underpins the thread header's "Fray document" gate (ChatView.ThreadHeader): the
// button shows iff `stripFrontmatter(threadBody).trim()` is non-empty. These lock the two invariants
// that gate relies on — a missing/frontmatter-only doc must reduce to empty (button HIDDEN, no
// dead-end "No thread file found"), a doc with real body must survive (button SHOWN).
test("stripFrontmatter: empty input stays empty (missing .fray/<slug>.md → doc button hidden)", () => {
  assert.equal(stripFrontmatter("").trim(), "")
})

test("stripFrontmatter: a frontmatter-only doc reduces to empty (no body → button hidden)", () => {
  const md = "---\ntitle: \"x\"\nstatus: active\n---\n"
  assert.equal(stripFrontmatter(md).trim(), "")
})

test("stripFrontmatter: real body survives frontmatter removal (button shown)", () => {
  const md = "---\ntitle: \"x\"\n---\n\n## Goal\nShip it.\n"
  assert.equal(stripFrontmatter(md).trim(), "## Goal\nShip it.")
})

test("stripFrontmatter: body without frontmatter is returned untouched", () => {
  assert.equal(stripFrontmatter("## Goal\nbody").trim(), "## Goal\nbody")
})

test("stripFrontmatter: CRLF frontmatter delimiters are handled", () => {
  const md = "---\r\ntitle: x\r\n---\r\n\r\nbody\r\n"
  assert.equal(stripFrontmatter(md).trim(), "body")
})
