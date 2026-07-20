import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { openLocalFile, resolveLocalFile, resolveOpenableFile } from "./local-file.ts"

test("local opener canonicalizes a regular file inside its trusted root and uses fixed argv", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-local-file-"))
  const file = join(root, "space ; $(not-a-command).md")
  writeFileSync(file, "safe")
  const calls: Array<{ command: string; args: readonly string[]; shell: unknown }> = []
  const result = openLocalFile(file, "system", [root], { spawn: (command, args, options) => {
    calls.push({ command, args, shell: options.shell })
    return { unref() {} }
  } })
  assert.deepEqual(result, { action: "opened", path: realpathSync(file) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.at(-1), realpathSync(file))
  assert.equal(calls[0].shell, false)
})

test("local opener refuses relative, outside, directory, and escaping symlink paths", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-local-file-root-"))
  const outside = mkdtempSync(join(tmpdir(), "fray-local-file-outside-"))
  const outsideFile = join(outside, "secret.txt")
  writeFileSync(outsideFile, "no")
  const link = join(root, "escape.txt")
  symlinkSync(outsideFile, link)
  assert.throws(() => resolveLocalFile("relative.txt", [root]), /absolute/)
  assert.throws(() => resolveLocalFile(outsideFile, [root]), /trusted roots/)
  assert.throws(() => resolveLocalFile(root, [root]), /regular file/)
  assert.throws(() => resolveLocalFile(link, [root]), /trusted roots/)
})

test("copy preference returns only the canonical trusted path without spawning", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-local-file-copy-"))
  const file = join(root, "artifact.txt")
  writeFileSync(file, "safe")
  assert.deepEqual(openLocalFile(file, "copy", [root], { spawn: () => { throw new Error("must not spawn") } }), { action: "copy", path: realpathSync(file) })
})

test("resolveOpenableFile classifies references: home (~), project-relative, absolute, :line, and misses", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fray-openable-home-")))
  const project = realpathSync(mkdtempSync(join(tmpdir(), "fray-openable-proj-")))
  const roots = [home, project]
  writeFileSync(join(home, "CLAUDE.md"), "cfg")
  mkdirSync(join(project, "packages", "web", "src"), { recursive: true })
  writeFileSync(join(project, "packages", "web", "src", "App.tsx"), "code")

  // ~-relative expands to the home root
  assert.equal(resolveOpenableFile("~/CLAUDE.md", project, roots, home), join(home, "CLAUDE.md"))
  // repo-relative resolves against the project dir
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // an absolute path is taken as-is
  assert.equal(resolveOpenableFile(join(project, "packages/web/src/App.tsx"), project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // a trailing :line[:col] editor suffix is stripped before resolving
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx:42:7", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // misses → null (never throws): nonexistent, a directory, and a path outside the roots
  assert.equal(resolveOpenableFile("~/nope.md", project, roots, home), null)
  assert.equal(resolveOpenableFile("packages/web", project, roots, home), null) // a directory, not a file
  assert.equal(resolveOpenableFile("/etc/hosts", project, roots, home), null) // outside the openable roots
  assert.equal(resolveOpenableFile("   ", project, roots, home), null)
})
