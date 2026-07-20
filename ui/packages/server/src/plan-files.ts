import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"

const PLAN_PATH_RE = /^\.fray\/plans\/([A-Za-z0-9][A-Za-z0-9._ -]*\.md)$/

interface DirectoryIdentity {
  path: string
  realPath: string
  stat: Stats
}

interface PlanDirectoryIdentity {
  fray: DirectoryIdentity
  plans: DirectoryIdentity
}

export interface PlanFileIdentity {
  path: string
  realPath: string
  relativePath: string
  filename: string
  contents: Buffer
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  digest: string
}

// Deterministic race seams used only by focused filesystem tests. Production callers omit them.
export interface PlanFileResolutionHooks {
  afterDirectoryCheck?: () => void
  afterFileCheck?: () => void
}

function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function directDirectory(parentRealPath: string, name: string): DirectoryIdentity | null {
  try {
    const path = join(parentRealPath, name)
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const realPath = realpathSync(path)
    if (dirname(realPath) !== parentRealPath || basename(realPath) !== name) return null
    return { path, realPath, stat }
  } catch {
    return null
  }
}

function planDirectory(projectDir: string): PlanDirectoryIdentity | null {
  try {
    const projectRoot = realpathSync(projectDir)
    const fray = directDirectory(projectRoot, ".fray")
    if (!fray) return null
    const plans = directDirectory(fray.realPath, "plans")
    return plans ? { fray, plans } : null
  } catch {
    return null
  }
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.path === b.path && a.realPath === b.realPath && sameStat(a.stat, b.stat)
}

function samePlanDirectory(a: PlanDirectoryIdentity, b: PlanDirectoryIdentity | null): boolean {
  return b !== null && sameDirectory(a.fray, b.fray) && sameDirectory(a.plans, b.plans)
}

function filenameFromPlanPath(value: unknown): string | null {
  if (typeof value !== "string") return null
  return value.match(PLAN_PATH_RE)?.[1] ?? null
}

// Resolve one direct plan file to bytes read from a no-follow descriptor. The parent directories and
// child identity are checked both before and after the read, so replacement or directory-swap races
// fail closed instead of returning bytes from the replacement.
export function resolvePlanFile(
  projectDir: string,
  value: unknown,
  hooks: PlanFileResolutionHooks = {},
): PlanFileIdentity | null {
  const filename = filenameFromPlanPath(value)
  if (!filename) return null
  try {
    const directoryBefore = planDirectory(projectDir)
    if (!directoryBefore) return null
    hooks.afterDirectoryCheck?.()

    const path = join(directoryBefore.plans.realPath, filename)
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) return null
    const realPath = realpathSync(path)
    if (dirname(realPath) !== directoryBefore.plans.realPath || basename(realPath) !== filename) return null
    hooks.afterFileCheck?.()

    let contents: Buffer
    let openedBefore: Stats
    let openedAfter: Stats
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      openedBefore = fstatSync(fd)
      contents = readFileSync(fd)
      openedAfter = fstatSync(fd)
    } finally {
      closeSync(fd)
    }

    const after = lstatSync(path)
    const realPathAfter = realpathSync(path)
    const directoryAfter = planDirectory(projectDir)
    if (
      !before.isFile() || before.isSymbolicLink() ||
      !openedBefore.isFile() || !openedAfter.isFile() ||
      !after.isFile() || after.isSymbolicLink() ||
      !sameStat(before, openedBefore) || !sameStat(openedBefore, openedAfter) || !sameStat(openedAfter, after) ||
      realPathAfter !== realPath || !samePlanDirectory(directoryBefore, directoryAfter)
    ) return null

    return {
      path,
      realPath,
      relativePath: `.fray/plans/${filename}`,
      filename,
      contents,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest: createHash("sha256").update(contents).digest("hex"),
    }
  } catch {
    return null
  }
}

// Delete one direct plan file. Reuses the resolver so a traversal, symlink, or indirect target fails
// closed (returns false, deletes nothing) exactly as a read would; only a validated direct `.md` child
// of the stable plans directory is unlinked. Returns false when there is nothing to delete (the plan is
// absent or the path is refused) so the caller can stay idempotent, but a genuine filesystem failure
// (e.g. EACCES/EPERM) is RE-THROWN rather than swallowed, so a "deleted" result never masks a live file.
// A lost resolve→unlink race (ENOENT) is treated as an idempotent success. `.fray` watcher fans the drop.
export function deletePlanFile(projectDir: string, value: unknown): boolean {
  const resolved = resolvePlanFile(projectDir, value)
  if (!resolved) return false
  try {
    unlinkSync(resolved.realPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}

// Discover only direct filenames from one stable plans-directory generation, then route every child
// through the same resolver used by RPC reads. If the directory changes during discovery, discard the
// entire snapshot; the next watcher/reconcile pass can retry against one coherent generation.
export function listPlanFiles(
  projectDir: string,
  hooks: Pick<PlanFileResolutionHooks, "afterDirectoryCheck"> = {},
): PlanFileIdentity[] {
  const directoryBefore = planDirectory(projectDir)
  if (!directoryBefore) return []
  try {
    hooks.afterDirectoryCheck?.()
    const names = readdirSync(directoryBefore.plans.realPath).sort()
    const files = names.flatMap((filename) => {
      const relativePath = `.fray/plans/${filename}`
      if (!filenameFromPlanPath(relativePath)) return []
      const resolved = resolvePlanFile(projectDir, relativePath)
      return resolved ? [resolved] : []
    })
    return samePlanDirectory(directoryBefore, planDirectory(projectDir)) ? files : []
  } catch {
    return []
  }
}
