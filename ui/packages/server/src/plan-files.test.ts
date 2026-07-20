import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deletePlanFile, listPlanFiles, resolvePlanFile } from "./plan-files.ts"

function fixture(): { dir: string; plans: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fray-plan-files-"))
  const plans = join(dir, ".fray", "plans")
  mkdirSync(plans, { recursive: true })
  return { dir, plans, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test("plan resolver and discovery return one stable direct regular markdown child", () => {
  const h = fixture()
  try {
    writeFileSync(join(h.plans, "Release plan.md"), "# Release plan\nbody\n")
    writeFileSync(join(h.plans, ".hidden.md"), "# hidden\n")
    mkdirSync(join(h.plans, "nested.md"))

    const resolved = resolvePlanFile(h.dir, ".fray/plans/Release plan.md")
    assert.equal(resolved?.contents.toString("utf8"), "# Release plan\nbody\n")
    assert.equal(resolved?.relativePath, ".fray/plans/Release plan.md")
    assert.deepEqual(listPlanFiles(h.dir).map((file) => file.relativePath), [
      ".fray/plans/Release plan.md",
    ])
  } finally {
    h.dispose()
  }
})

test("plan delete removes a direct plan file and is idempotent for an already-gone plan", () => {
  const h = fixture()
  try {
    const path = join(h.plans, "Release plan.md")
    writeFileSync(path, "# Release plan\n")
    assert.equal(deletePlanFile(h.dir, ".fray/plans/Release plan.md"), true)
    assert.equal(existsSync(path), false)
    // Already gone: resolver rejects it, so nothing is deleted and it reports false.
    assert.equal(deletePlanFile(h.dir, ".fray/plans/Release plan.md"), false)
  } finally {
    h.dispose()
  }
})

// A real unlink failure must surface, not be swallowed into a false "deleted". Simulated by making the
// plans directory non-writable so unlink of its child fails with EACCES/EPERM. Skipped under root (which
// bypasses directory permission bits and would delete the file anyway).
test("plan delete re-throws a genuine filesystem failure instead of reporting success", { skip: process.getuid?.() === 0 }, () => {
  const h = fixture()
  const path = join(h.plans, "locked.md")
  try {
    writeFileSync(path, "# locked\n")
    chmodSync(h.plans, 0o500) // r-x: cannot unlink children
    assert.throws(() => deletePlanFile(h.dir, ".fray/plans/locked.md"))
    chmodSync(h.plans, 0o700)
    assert.equal(existsSync(path), true) // the file survived the failed delete
  } finally {
    try { chmodSync(h.plans, 0o700) } catch {}
    h.dispose()
  }
})

test("plan delete refuses traversal, nested, symlinked, and non-string targets", () => {
  const h = fixture()
  const external = mkdtempSync(join(tmpdir(), "fray-plan-del-external-"))
  try {
    const outside = join(external, "outside.md")
    writeFileSync(outside, "outside\n")
    symlinkSync(outside, join(h.plans, "linked.md"))
    for (const path of [
      "../safe.md",
      ".fray/plans/../../secret.md",
      ".fray/plans/nested/safe.md",
      ".fray/plans/linked.md",
      "/absolute.md",
      undefined,
    ]) {
      assert.equal(deletePlanFile(h.dir, path), false, String(path))
    }
    // The symlink target outside the plans dir must survive a refused delete.
    assert.equal(existsSync(outside), true)
  } finally {
    h.dispose()
    rmSync(external, { recursive: true, force: true })
  }
})

test("plan resolver rejects traversal, nested paths, and non-string input before filesystem access", () => {
  const h = fixture()
  try {
    writeFileSync(join(h.plans, "safe.md"), "safe\n")
    for (const path of [
      "../safe.md",
      ".fray/plans/../../secret.md",
      ".fray/plans/nested/safe.md",
      ".fray/plans/.hidden.md",
      ".fray/plans/safe.txt",
      "/absolute.md",
      undefined,
    ]) {
      assert.equal(resolvePlanFile(h.dir, path), null, String(path))
    }
  } finally {
    h.dispose()
  }
})

test("plan resolver and discovery reject a symlinked plans directory and symlinked markdown child", () => {
  const linkedDir = fixture()
  const external = mkdtempSync(join(tmpdir(), "fray-plan-external-"))
  try {
    rmSync(linkedDir.plans, { recursive: true })
    writeFileSync(join(external, "outside.md"), "outside\n")
    symlinkSync(external, linkedDir.plans, "dir")
    assert.equal(resolvePlanFile(linkedDir.dir, ".fray/plans/outside.md"), null)
    assert.deepEqual(listPlanFiles(linkedDir.dir), [])
  } finally {
    linkedDir.dispose()
    rmSync(external, { recursive: true, force: true })
  }

  const linkedFile = fixture()
  const target = join(linkedFile.dir, "outside.md")
  try {
    writeFileSync(target, "outside\n")
    symlinkSync(target, join(linkedFile.plans, "linked.md"))
    assert.equal(resolvePlanFile(linkedFile.dir, ".fray/plans/linked.md"), null)
    assert.deepEqual(listPlanFiles(linkedFile.dir), [])
  } finally {
    linkedFile.dispose()
  }
})

test("plan resolver rejects a direct file replacement at the checked-to-open boundary", () => {
  const h = fixture()
  try {
    const path = join(h.plans, "raced.md")
    writeFileSync(path, "authorized\n")
    const result = resolvePlanFile(h.dir, ".fray/plans/raced.md", {
      afterFileCheck: () => {
        renameSync(path, `${path}.old`)
        writeFileSync(path, "replacement\n")
      },
    })
    assert.equal(result, null)
  } finally {
    h.dispose()
  }
})

test("plan resolver and discovery reject a plans-directory generation swap", () => {
  const resolved = fixture()
  try {
    writeFileSync(join(resolved.plans, "raced.md"), "authorized\n")
    const result = resolvePlanFile(resolved.dir, ".fray/plans/raced.md", {
      afterDirectoryCheck: () => {
        renameSync(resolved.plans, `${resolved.plans}.old`)
        mkdirSync(resolved.plans)
        writeFileSync(join(resolved.plans, "raced.md"), "replacement\n")
      },
    })
    assert.equal(result, null)
  } finally {
    resolved.dispose()
  }

  const listed = fixture()
  try {
    writeFileSync(join(listed.plans, "raced.md"), "authorized\n")
    const result = listPlanFiles(listed.dir, {
      afterDirectoryCheck: () => {
        renameSync(listed.plans, `${listed.plans}.old`)
        mkdirSync(listed.plans)
        writeFileSync(join(listed.plans, "replacement.md"), "replacement\n")
      },
    })
    assert.deepEqual(result, [])
  } finally {
    listed.dispose()
  }
})
