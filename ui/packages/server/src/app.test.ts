import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveLocalImage } from "./app.ts"

// A 1x1 PNG's leading bytes are enough — the route serves the bytes verbatim, it doesn't decode.
const PNG = Buffer.from("89504e470d0a1a0a", "hex")

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), "fray-img-"))
  const img = join(root, "shot.png")
  writeFileSync(img, PNG)
  return { root, img }
}

test("allowed: absolute png under a trusted root → 200 with content-type", () => {
  const { root, img } = fixtures()
  const r = resolveLocalImage(img, [root])
  assert.equal(r.status, 200)
  if (r.status === 200) {
    assert.equal(r.contentType, "image/png")
    assert.deepEqual(r.body, PNG)
  }
})

test("blocked: path outside every root → 403", () => {
  const { root, img } = fixtures()
  assert.equal(resolveLocalImage(img, ["/some/other/root"]).status, 403)
})

test("blocked: /etc/passwd → 403 (outside roots, and not an image ext → 400 first)", () => {
  const { root } = fixtures()
  // wrong extension is rejected before the root check
  assert.equal(resolveLocalImage("/etc/passwd", [root]).status, 400)
})

test("blocked: relative path → 400", () => {
  const { root } = fixtures()
  assert.equal(resolveLocalImage("shot.png", [root]).status, 400)
})

test("blocked: non-image extension → 400", () => {
  const { root } = fixtures()
  const txt = join(root, "note.txt")
  writeFileSync(txt, "hi")
  assert.equal(resolveLocalImage(txt, [root]).status, 400)
})

test("missing file → 404", () => {
  const { root } = fixtures()
  assert.equal(resolveLocalImage(join(root, "nope.png"), [root]).status, 404)
})

test("symlink escaping the root is resolved and blocked → 403", () => {
  const { root, img } = fixtures()
  const outside = mkdtempSync(join(tmpdir(), "fray-out-"))
  writeFileSync(join(outside, "real.png"), PNG)
  const link = join(root, "link.png")
  symlinkSync(join(outside, "real.png"), link)
  // link sits inside root, but its realpath is under `outside` — must be blocked when only root is trusted
  assert.equal(resolveLocalImage(link, [root]).status, 403)
  // and allowed when the real target's root is trusted
  assert.equal(resolveLocalImage(link, [root, outside]).status, 200)
})
