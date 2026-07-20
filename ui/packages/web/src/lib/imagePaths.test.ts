import { test } from "node:test"
import assert from "node:assert/strict"
import { joinComposerValue, splitComposerValue, splitProseAttachments } from "./imagePaths.ts"

test("a standalone image-path line becomes an image part", () => {
  const parts = splitProseAttachments("Here is the shot:\n/Users/me/shot.png\nDone.")
  assert.deepEqual(parts, [
    { kind: "md", text: "Here is the shot:" },
    { kind: "image", path: "/Users/me/shot.png" },
    { kind: "md", text: "Done." },
  ])
})

test("backtick-wrapped path lines are detected and unwrapped", () => {
  const parts = splitProseAttachments("`/tmp/a.jpeg`")
  assert.deepEqual(parts, [{ kind: "image", path: "/tmp/a.jpeg" }])
})

test("inline raster image extensions become image parts, case-insensitive (svg is NOT inline)", () => {
  for (const p of ["/a/b.PNG", "/a/b.jpg", "/a/b.jpeg", "/a/b.gif", "/a/b.webp"]) {
    assert.deepEqual(splitProseAttachments(p), [{ kind: "image", path: p }])
  }
  // svg can't be served inline safely (XSS) → it renders as an openable chip, not an <img>.
  assert.deepEqual(splitProseAttachments("/a/b.svg"), [{ kind: "file", path: "/a/b.svg" }])
})

test("a standalone non-image doc path becomes a file part", () => {
  const parts = splitProseAttachments("Review this:\n/Users/me/report.pdf\nThanks.")
  assert.deepEqual(parts, [
    { kind: "md", text: "Review this:" },
    { kind: "file", path: "/Users/me/report.pdf" },
    { kind: "md", text: "Thanks." },
  ])
})

test("common safe-tier doc/text/code extensions become file parts, case-insensitive", () => {
  for (const p of ["/a/b.PDF", "/a/notes.txt", "/a/data.csv", "/a/x.json", "/a/y.md", "/a/z.log", "/a/s.ts", "/a/m.py", "/a/c.yaml"]) {
    assert.deepEqual(splitProseAttachments(p), [{ kind: "file", path: p }])
  }
})

test("backtick-wrapped doc path lines are detected and unwrapped", () => {
  assert.deepEqual(splitProseAttachments("`/tmp/a.pdf`"), [{ kind: "file", path: "/tmp/a.pdf" }])
})

test("an inline path inside a sentence stays prose", () => {
  assert.deepEqual(splitProseAttachments("See /Users/me/shot.png for details."), [
    { kind: "md", text: "See /Users/me/shot.png for details." },
  ])
  assert.deepEqual(splitProseAttachments("Open /Users/me/report.pdf now."), [
    { kind: "md", text: "Open /Users/me/report.pdf now." },
  ])
})

test("extension-less, unsupported, and relative paths stay prose", () => {
  assert.deepEqual(splitProseAttachments("/etc/hosts"), [{ kind: "md", text: "/etc/hosts" }])
  assert.deepEqual(splitProseAttachments("./rel/shot.png"), [{ kind: "md", text: "./rel/shot.png" }])
  assert.deepEqual(splitProseAttachments("/a/archive.zip"), [{ kind: "md", text: "/a/archive.zip" }])
})

test("standalone paths INSIDE a fenced code block stay code, never chips", () => {
  const md = "Changed files:\n```\n/Users/foo/src/main.rs\n/Users/foo/README.md\n```\nDone."
  // The whole fenced block (with both ``` markers + the two paths) stays one md part; only the
  // surrounding prose is separate. No file/image parts are extracted from inside the fence.
  assert.deepEqual(splitProseAttachments(md), [
    { kind: "md", text: "Changed files:\n```\n/Users/foo/src/main.rs\n/Users/foo/README.md\n```\nDone." },
  ])
})

test("a tilde fence and a language-tagged fence both suppress promotion", () => {
  assert.deepEqual(splitProseAttachments("~~~\n/a/x.py\n~~~"), [{ kind: "md", text: "~~~\n/a/x.py\n~~~" }])
  assert.deepEqual(splitProseAttachments("```bash\n/a/y.ts\n```"), [{ kind: "md", text: "```bash\n/a/y.ts\n```" }])
})

test("a path AFTER a closed fence is still promoted", () => {
  assert.deepEqual(splitProseAttachments("```\ncode\n```\n/a/real.pdf"), [
    { kind: "md", text: "```\ncode\n```" },
    { kind: "file", path: "/a/real.pdf" },
  ])
})

test("pure prose returns a single md part", () => {
  assert.deepEqual(splitProseAttachments("just words"), [{ kind: "md", text: "just words" }])
})

test("empty input returns nothing", () => {
  assert.deepEqual(splitProseAttachments(""), [])
})

test("splitComposerValue peels the trailing attachment run into chips, prose keeps the rest", () => {
  const { prose, attachments } = splitComposerValue("Please review\n/tmp/a.png\n/tmp/spec.pdf")
  assert.equal(prose, "Please review")
  assert.deepEqual(attachments, [
    { path: "/tmp/a.png", kind: "image" },
    { path: "/tmp/spec.pdf", kind: "file" },
  ])
})

test("splitComposerValue leaves a path typed mid-prose inline (only a trailing run peels)", () => {
  const { prose, attachments } = splitComposerValue("/tmp/a.png\nnow some words")
  assert.equal(prose, "/tmp/a.png\nnow some words")
  assert.deepEqual(attachments, [])
})

test("splitComposerValue on pure prose returns the value unchanged and no attachments", () => {
  const { prose, attachments } = splitComposerValue("just words\nsecond line")
  assert.equal(prose, "just words\nsecond line")
  assert.deepEqual(attachments, [])
})

test("splitComposerValue does not peel a path inside a trailing code fence", () => {
  const { prose, attachments } = splitComposerValue("look:\n```\n/tmp/x.py\n```")
  assert.equal(prose, "look:\n```\n/tmp/x.py\n```")
  assert.deepEqual(attachments, [])
})

test("joinComposerValue round-trips with splitComposerValue", () => {
  const value = "Please review\n/tmp/a.png\n/tmp/spec.pdf"
  const { prose, attachments } = splitComposerValue(value)
  assert.equal(joinComposerValue(prose, attachments.map((a) => a.path)), value)
})

test("joinComposerValue with no paths is the prose verbatim; empty prose yields bare paths", () => {
  assert.equal(joinComposerValue("hello", []), "hello")
  assert.equal(joinComposerValue("", ["/tmp/a.png"]), "/tmp/a.png")
  assert.equal(joinComposerValue("hi", ["/tmp/a.png"]), "hi\n/tmp/a.png")
})
