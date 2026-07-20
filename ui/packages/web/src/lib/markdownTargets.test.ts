import { test } from "node:test"
import assert from "node:assert/strict"
import { localImageUrl, localImageUrlForTarget, localMarkdownTarget } from "./markdownTargets.ts"

test("absolute POSIX and file URLs become local targets with decoded proxy paths", () => {
  assert.deepEqual(
    localMarkdownTarget("/Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", posixPath: "/Users/me/visual review/shot.png" },
  )
  assert.deepEqual(
    localMarkdownTarget("file:///Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", posixPath: "/Users/me/visual review/shot.png" },
  )
  assert.equal(
    localImageUrl("/Users/me/visual review/shot.png"),
    "/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("/Users/me/visual%20review/shot.png")!),
    "/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
})

test("only server-supported local image extensions become proxy URLs", () => {
  for (const path of ["/tmp/shot.png", "/tmp/shot.JPG", "/tmp/shot.jpeg", "/tmp/shot.gif", "/tmp/shot.webp"]) {
    assert.ok(localImageUrlForTarget(localMarkdownTarget(path)!), path)
  }
  assert.equal(localImageUrlForTarget(localMarkdownTarget("/tmp/shot.svg")!), null)
  assert.equal(localImageUrlForTarget(localMarkdownTarget("C:\\Users\\me\\shot.png")!), null)
})

test("Windows and remote file targets are visibly local but cannot become proxy reads", () => {
  assert.deepEqual(localMarkdownTarget("C:\\Users\\me\\shot.png"), { display: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("C:%5CUsers%5Cme%5Cshot.png"), { display: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("file://fileserver/share/shot.png"), { display: "file://fileserver/share/shot.png" })
})

test("normal web, relative app, anchor, and mail links remain links", () => {
  for (const href of [
    "https://example.com/shot.png",
    "//cdn.example.com/shot.png",
    "thread/a",
    "/thread/a",
    "/status/active",
    "/",
    "/?filter=active",
    "#details",
    "mailto:dev@example.com",
  ]) assert.equal(localMarkdownTarget(href), null, href)
})

test("malformed URL encoding cannot throw or become an app navigation", () => {
  assert.deepEqual(localMarkdownTarget("/Users/me/bad%ZZ.png"), {
    display: "/Users/me/bad%ZZ.png",
    posixPath: "/Users/me/bad%ZZ.png",
  })
})
