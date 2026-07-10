import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repairThreadFile, deriveTitle, RepairError, REPAIR_STATUS_TEXT } from "./repair.ts"

// Stand up a temp project with a .fray/ dir; return its .fray path.
function frayDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fray-repair-"))
  const fd = join(dir, ".fray")
  mkdirSync(fd, { recursive: true })
  return fd
}

test("repairThreadFile: happy path — no heading → filename slug title, prepends frontmatter", () => {
  const fd = frayDir()
  try {
    // The incident shape: metadata in bold prose, no frontmatter at all.
    writeFileSync(join(fd, "sandbox-windows-backend.md"), "**Status: DONE**\n\nSome prose body.\n")
    const { slug } = repairThreadFile(fd, "sandbox-windows-backend.md")
    assert.equal(slug, "sandbox-windows-backend")
    const out = readFileSync(join(fd, "sandbox-windows-backend.md"), "utf8")
    assert.ok(out.startsWith("---\n"), "prepends a frontmatter block")
    assert.match(out, /^title: sandbox-windows-backend$/m, "title falls back to the filename slug")
    assert.match(out, /^status: active$/m, "conservative status: active — never inferred from prose")
    assert.match(out, /^status_text: "Frontmatter was missing and auto-repaired/m, "stamps the verify-me status_text")
    assert.ok(out.includes("**Status: DONE**"), "original body preserved verbatim")
    // Never guess DONE from the prose — active is the whole point (makes it visible + crash-net cards it).
    assert.doesNotMatch(out, /^status: done$/m)
  } finally {
    rmSync(fd, { recursive: true, force: true })
  }
})

test("repairThreadFile: title derived from the first H1 heading when present", () => {
  const fd = frayDir()
  try {
    writeFileSync(join(fd, "t.md"), "# Real Title Here\n\nbody\n")
    repairThreadFile(fd, "t.md")
    const out = readFileSync(join(fd, "t.md"), "utf8")
    assert.match(out, /^title: "Real Title Here"$/m, "H1 wins over the filename slug")
  } finally {
    rmSync(fd, { recursive: true, force: true })
  }
})

test("repairThreadFile: refuses a file that OPENS with a --- block, but heals a body `---` rule", () => {
  const fd = frayDir()
  try {
    // Opens with frontmatter (first non-blank line is `---`) → refuse.
    writeFileSync(join(fd, "has-fm.md"), "---\ntitle: x\nstatus: active\n---\nbody\n")
    assert.throws(() => repairThreadFile(fd, "has-fm.md"), (e: unknown) => e instanceof RepairError && /already opens with a "---" block/.test((e as Error).message))
    // Leading blank lines before the frontmatter still count as opening with it.
    writeFileSync(join(fd, "blank-then-fm.md"), "\n\n---\ntitle: y\n---\nbody\n")
    assert.throws(() => repairThreadFile(fd, "blank-then-fm.md"), RepairError)
    // A heading-first doc whose BODY contains a markdown `---` thematic break has NO frontmatter and
    // MUST be healed (the recurring real-world case Repair used to refuse).
    writeFileSync(join(fd, "hr.md"), "# Title\n\nsome text\n\n---\n\nmore text\n")
    const { slug } = repairThreadFile(fd, "hr.md")
    assert.equal(slug, "hr")
    const healed = readFileSync(join(fd, "hr.md"), "utf8")
    assert.ok(healed.startsWith("---\ntitle: Title\nstatus: active\n"))
    assert.ok(healed.includes("# Title")) // original body preserved verbatim
  } finally {
    rmSync(fd, { recursive: true, force: true })
  }
})

test("repairThreadFile: refuses path traversal / non-child / non-.md / missing", () => {
  const fd = frayDir()
  try {
    // A sibling file outside .fray that we must NOT be able to reach.
    writeFileSync(join(fd, "..", "secret.md"), "top secret\n")
    assert.throws(() => repairThreadFile(fd, "../secret.md"), (e: unknown) => e instanceof RepairError && /not directly under/.test((e as Error).message))
    assert.throws(() => repairThreadFile(fd, "sub/nested.md"), /not directly under/)
    assert.throws(() => repairThreadFile(fd, "/etc/passwd"), /not directly under/)
    // Confirm the sibling was never touched.
    assert.equal(readFileSync(join(fd, "..", "secret.md"), "utf8"), "top secret\n")
    // Right location, wrong extension.
    writeFileSync(join(fd, "notes.txt"), "hi\n")
    assert.throws(() => repairThreadFile(fd, "notes.txt"), /not a .md/)
    // Directly under .fray, .md, but does not exist.
    assert.throws(() => repairThreadFile(fd, "ghost.md"), /no thread file to repair/)
  } finally {
    rmSync(fd, { recursive: true, force: true })
  }
})

test("deriveTitle: H1 only (## and #no-space do not count), else slug", () => {
  assert.equal(deriveTitle("# Hello World\n", "slug"), "Hello World")
  assert.equal(deriveTitle("## Subhead\nbody\n", "slug"), "slug")
  assert.equal(deriveTitle("#nospace\n", "slug"), "slug")
  assert.equal(deriveTitle("no heading at all\n", "my-slug"), "my-slug")
  assert.equal(REPAIR_STATUS_TEXT.length > 0, true)
})
