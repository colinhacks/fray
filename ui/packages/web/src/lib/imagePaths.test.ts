import { test } from "node:test"
import assert from "node:assert/strict"
import { splitProseImages } from "./imagePaths.ts"

test("a standalone image-path line becomes an image part", () => {
  const parts = splitProseImages("Here is the shot:\n/Users/me/shot.png\nDone.")
  assert.deepEqual(parts, [
    { kind: "md", text: "Here is the shot:" },
    { kind: "image", path: "/Users/me/shot.png" },
    { kind: "md", text: "Done." },
  ])
})

test("backtick-wrapped path lines are detected and unwrapped", () => {
  const parts = splitProseImages("`/tmp/a.jpeg`")
  assert.deepEqual(parts, [{ kind: "image", path: "/tmp/a.jpeg" }])
})

test("all supported extensions, case-insensitive", () => {
  for (const p of ["/a/b.PNG", "/a/b.jpg", "/a/b.jpeg", "/a/b.gif", "/a/b.webp", "/a/b.svg"]) {
    assert.deepEqual(splitProseImages(p), [{ kind: "image", path: p }])
  }
})

test("an inline path inside a sentence stays prose", () => {
  const parts = splitProseImages("See /Users/me/shot.png for details.")
  assert.deepEqual(parts, [{ kind: "md", text: "See /Users/me/shot.png for details." }])
})

test("non-image and relative paths stay prose", () => {
  assert.deepEqual(splitProseImages("/etc/hosts"), [{ kind: "md", text: "/etc/hosts" }])
  assert.deepEqual(splitProseImages("./rel/shot.png"), [{ kind: "md", text: "./rel/shot.png" }])
})

test("pure prose returns a single md part", () => {
  assert.deepEqual(splitProseImages("just words"), [{ kind: "md", text: "just words" }])
})

test("empty input returns nothing", () => {
  assert.deepEqual(splitProseImages(""), [])
})
