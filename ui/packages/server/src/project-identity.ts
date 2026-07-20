import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  currentProcessGeneration,
  defaultProcessPlatformAdapter,
  processGenerationIsStale,
  type ProcessPlatformAdapter,
} from "./process-generation.ts"

// Launcher allocation is machine-global, while first project-id creation uses a separate lock keyed
// to Git's common directory. A valid existing id takes the lock-free fast path in either case.
const GLOBAL_LOCK_NAME = "dev-launch.lock"
const GLOBAL_LOCK_OWNER = "owner.json"
const INCOMPLETE_LOCK_GRACE_MS = 1_000
const LOCK_POLL_MS = 50
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4))

interface LockOwner {
  version: 1
  pid: number
  processStart?: string
  token: string
  at: string
}

interface LockObservation {
  stale: boolean
  ownerPid?: number
}

export type GitProjectIdentityScope = "repository" | "worktree"

export interface GitProjectIdentity {
  /** The Fray instance id. Ordinary/main worktrees retain the repository-local `fray.id`. */
  id: string
  scope: GitProjectIdentityScope
  /** Canonical paths identify the exact checkout independently of symlink aliases. */
  root: string
  gitDir: string
  commonGitDir: string
}

export interface GitWorktree {
  root: string
  gitDir: string
  commonGitDir: string
  scope: GitProjectIdentityScope
  /** A linked worktree's private administrative directory is deleted with that worktree. */
  identityConfig?: string
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function exitStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined
}

function canonicalHome(home: string): string {
  try {
    return realpathSync(home)
  } catch {
    return resolve(home)
  }
}

export function globalLaunchLockPath(home = homedir()): string {
  return join(canonicalHome(home), ".fray", GLOBAL_LOCK_NAME)
}

function namedLaunchLockPath(home: string, name: string): string {
  return join(canonicalHome(home), ".fray", name)
}

export function pidIsAlive(pid: unknown): pid is number {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false
  try {
    process.kill(pid as number, 0)
    return true
  } catch (error) {
    // EPERM still proves that the process exists; it only denies signalling it.
    return errorCode(error) === "EPERM"
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    fsyncSync(fd)
  } catch {
    // Directory fsync is unavailable on some filesystems. The file itself is always synced first.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

function lockOwnerPath(lockPath: string): string {
  try {
    return statSync(lockPath).isDirectory() ? join(lockPath, GLOBAL_LOCK_OWNER) : lockPath
  } catch {
    return lockPath
  }
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(lockOwnerPath(lockPath), "utf8")) as Partial<LockOwner>
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      value.pid! <= 0 ||
      (value.processStart !== undefined && (typeof value.processStart !== "string" || value.processStart.length > 256)) ||
      typeof value.token !== "string" ||
      !PROJECT_ID_RE.test(value.token) ||
      typeof value.at !== "string"
    ) return undefined
    return value as LockOwner
  } catch {
    return undefined
  }
}

function legacyOwnerPid(lockPath: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(lockOwnerPath(lockPath), "utf8")) as { pid?: unknown }
    return Number.isInteger(value.pid) && (value.pid as number) > 0 ? value.pid as number : undefined
  } catch {
    return undefined
  }
}

function observeLock(lockPath: string, adapter: ProcessPlatformAdapter): LockObservation {
  const owner = readOwner(lockPath)
  const pid = owner?.pid ?? legacyOwnerPid(lockPath)
  if (pid !== undefined) {
    const stale = owner?.processStart
      ? processGenerationIsStale({ pid, processStart: owner.processStart }, adapter)
      : !pidIsAlive(pid)
    return { stale, ownerPid: pid }
  }

  // Creating the lock pathname is the atomic claim. There is necessarily a tiny interval before its
  // JSON is complete; never steal a fresh partial file (or a legacy directory missing owner.json). If
  // its creator crashed, the age grace makes that claim recoverable without operator intervention.
  try {
    const ownerPath = lockOwnerPath(lockPath)
    let modified = statSync(lockPath).mtimeMs
    if (ownerPath !== lockPath) {
      try { modified = Math.max(modified, statSync(ownerPath).mtimeMs) } catch {}
    }
    const age = Date.now() - modified
    return { stale: age >= INCOMPLETE_LOCK_GRACE_MS || age < -INCOMPLETE_LOCK_GRACE_MS }
  } catch {
    return { stale: false }
  }
}

function quarantineLock(lockPath: string): boolean {
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`
  try {
    // Atomic rename removes the stale name before deletion. A competing stale reaper either wins this
    // rename or retries; it can never recursively delete a newly-created replacement lock.
    renameSync(lockPath, quarantine)
  } catch {
    return false
  }
  try { rmSync(quarantine, { recursive: true, force: true }) } catch {}
  return true
}

function tryAcquireLock(lockPath: string, adapter: ProcessPlatformAdapter): (() => void) | undefined {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    // `wx` makes the path claim and opens its inode as one operation. Writing through that descriptor
    // cannot corrupt a replacement lock if a very slow/partial claim is quarantined after the grace.
    fd = openSync(lockPath, "wx", 0o600)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return undefined
    throw error
  }

  const generation = currentProcessGeneration(adapter)
  const owner: LockOwner = {
    version: 1,
    pid: generation.pid,
    processStart: generation.processStart,
    token: randomUUID(),
    at: new Date(adapter.now()).toISOString(),
  }
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    syncDirectory(dirname(lockPath))
  } catch (error) {
    try { closeSync(fd) } catch {}
    // Leave a partial inode in place. It becomes recoverable after the grace period; blindly unlinking
    // this pathname could remove a replacement claim if this write was stalled and already reaped.
    throw error
  }

  // A claim whose write took longer than the incomplete-lock grace may have been quarantined. Only
  // return ownership if the canonical pathname still contains our exact process/token pair.
  const committed = readOwner(lockPath)
  if (
    !committed ||
    committed.pid !== owner.pid ||
    committed.processStart !== owner.processStart ||
    committed.token !== owner.token
  ) return undefined

  let released = false
  return () => {
    if (released) return
    released = true
    const current = readOwner(lockPath)
    if (
      !current ||
      current.token !== owner.token ||
      current.pid !== owner.pid ||
      current.processStart !== owner.processStart
    ) return
    const quarantine = `${lockPath}.release-${process.pid}-${owner.token}`
    try {
      renameSync(lockPath, quarantine)
      rmSync(quarantine, { recursive: true, force: true })
    } catch {
      // Ownership did not match at the atomic rename boundary or cleanup was interrupted. A future
      // acquisition safely recovers any stale lock; never delete a path whose owner we did not prove.
    }
  }
}

function tryAcquireGlobalLaunchLock(home: string, adapter: ProcessPlatformAdapter): (() => void) | undefined {
  return tryAcquireLock(globalLaunchLockPath(home), adapter)
}

function lockTimeoutError(observation: LockObservation): Error {
  return new Error(
    observation.ownerPid === undefined
      ? "another Fray launch still owns the global launch lock"
      : `another Fray launch (pid ${observation.ownerPid}) still owns the global launch lock`,
  )
}

export async function acquireGlobalLaunchLock(
  home = homedir(),
  timeoutMs = 10_000,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): Promise<() => void> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let observation: LockObservation = { stale: false }
  for (;;) {
    const release = tryAcquireGlobalLaunchLock(home, adapter)
    if (release) return release
    observation = observeLock(globalLaunchLockPath(home), adapter)
    if (observation.stale && quarantineLock(globalLaunchLockPath(home))) continue
    if (Date.now() >= deadline) throw lockTimeoutError(observation)
    await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

function acquireNamedLaunchLockSync(
  home: string,
  name: string,
  timeoutMs = 10_000,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): () => void {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const lockPath = namedLaunchLockPath(home, name)
  let observation: LockObservation = { stale: false }
  for (;;) {
    const release = tryAcquireLock(lockPath, adapter)
    if (release) return release
    observation = observeLock(lockPath, adapter)
    if (observation.stale && quarantineLock(lockPath)) continue
    if (Date.now() >= deadline) throw lockTimeoutError(observation)
    Atomics.wait(SYNC_WAIT, 0, 0, Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

export function acquireGlobalLaunchLockSync(
  home = homedir(),
  timeoutMs = 10_000,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): () => void {
  return acquireNamedLaunchLockSync(home, GLOBAL_LOCK_NAME, timeoutMs, adapter)
}

function identityCreationLockName(worktree: Pick<GitWorktree, "commonGitDir">): string {
  return `identity-${createHash("sha256").update(worktree.commonGitDir).digest("hex")}.lock`
}

export function validateProjectId(value: string): string {
  const id = value.trim()
  if (!PROJECT_ID_RE.test(id)) {
    throw new Error("git config --local fray.id is invalid; expected exactly one UUID")
  }
  return id
}

function revParsePath(dir: string, flag: "--show-toplevel" | "--git-dir" | "--git-common-dir"): string {
  let raw: string
  try {
    raw = execFileSync("git", ["rev-parse", flag], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new Error("unable to inspect Git worktree identity")
  }
  try {
    return realpathSync(resolve(dir, raw))
  } catch {
    throw new Error("unable to canonicalize Git worktree identity")
  }
}

/** Resolve the exact checkout and its private/common Git administrative directories. */
export function resolveGitWorktree(dir: string): GitWorktree {
  const root = revParsePath(dir, "--show-toplevel")
  const gitDir = revParsePath(root, "--git-dir")
  const commonGitDir = revParsePath(root, "--git-common-dir")
  const scope: GitProjectIdentityScope = gitDir === commonGitDir ? "repository" : "worktree"
  return {
    root,
    gitDir,
    commonGitDir,
    scope,
    // Do not enable Git's repository-wide `extensions.worktreeConfig` merely to hold one private Fray
    // value. A config file inside the linked worktree's own administrative directory has Git's atomic
    // config-lock behavior, survives `git worktree move`, and disappears with `git worktree remove`.
    ...(scope === "worktree" ? { identityConfig: join(gitDir, "fray.config") } : {}),
  }
}

function readProjectIdConfig(dir: string, args: string[], description: string): string | undefined {
  let output: string
  try {
    output = execFileSync("git", ["config", ...args, "--get-all", "fray.id"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (error) {
    if (exitStatus(error) === 1) return undefined
    throw new Error(`unable to read ${description}`)
  }
  const values = output.replace(/\r?\n$/u, "").split(/\r?\n/u)
  if (values.length !== 1) throw new Error(`${description} is invalid; expected exactly one UUID`)
  try {
    return validateProjectId(values[0] ?? "")
  } catch {
    throw new Error(`${description} is invalid; expected exactly one UUID`)
  }
}

export function readGitProjectId(dir: string): string | undefined {
  return readProjectIdConfig(dir, ["--local"], "git config --local fray.id")
}

function readGitWorktreeProjectId(worktree: GitWorktree): string | undefined {
  if (!worktree.identityConfig) return undefined
  return readProjectIdConfig(
    worktree.root,
    ["--file", worktree.identityConfig],
    "linked-worktree fray.id",
  )
}

function syncGitConfigPath(path: string): void {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dirname(path))
}

function syncGitConfig(dir: string): void {
  let raw: string
  try {
    raw = execFileSync("git", ["rev-parse", "--git-path", "config"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    throw new Error("unable to locate git config after writing fray.id")
  }
  const path = resolve(dir, raw)
  syncGitConfigPath(path)
}

function createGitProjectId(dir: string): string {
  const proposed = randomUUID()
  try {
    // Git's own config lock writes and renames the file atomically. `--add` cannot silently replace an
    // external value; the mandatory reread below rejects duplicates or any unexpected winner.
    execFileSync("git", ["config", "--local", "--add", "fray.id", proposed], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    })
    syncGitConfig(dir)
  } catch {
    throw new Error("unable to persist git config --local fray.id")
  }
  const committed = readGitProjectId(dir)
  if (committed !== proposed) throw new Error("git config --local fray.id changed during creation")
  return committed
}

function createGitWorktreeProjectId(worktree: GitWorktree, repositoryId: string): string {
  const config = worktree.identityConfig
  if (!config) throw new Error("linked worktree is missing its private identity config path")
  let proposed = randomUUID()
  while (proposed === repositoryId) proposed = randomUUID()
  try {
    execFileSync("git", ["config", "--file", config, "--add", "fray.id", proposed], {
      cwd: worktree.root,
      stdio: ["ignore", "ignore", "ignore"],
    })
    syncGitConfigPath(config)
  } catch {
    throw new Error("unable to persist linked-worktree fray.id")
  }
  const committed = readGitWorktreeProjectId(worktree)
  if (committed !== proposed) throw new Error("linked-worktree fray.id changed during creation")
  return committed
}

function resolvedIdentity(worktree: GitWorktree): GitProjectIdentity | undefined {
  const repositoryId = readGitProjectId(worktree.root)
  if (worktree.scope === "repository") {
    return repositoryId ? { ...worktree, id: repositoryId } : undefined
  }
  const worktreeId = readGitWorktreeProjectId(worktree)
  if (!repositoryId || !worktreeId) return undefined
  if (worktreeId === repositoryId) {
    throw new Error("linked-worktree fray.id is invalid; it must differ from the repository fray.id")
  }
  return { ...worktree, id: worktreeId }
}

/**
 * Resolve the durable Fray identity for one exact Git checkout.
 *
 * The main/ordinary worktree keeps the historical repository-local `fray.id` byte-for-byte, preserving
 * its existing state directory. Each linked worktree stores a different UUID in its own Git administrative
 * directory, so aliases share it, moves retain it, and removal removes it.
 */
export function resolveGitProjectIdentity(dir: string, home = homedir()): GitProjectIdentity {
  let worktree = resolveGitWorktree(dir)
  const existing = resolvedIdentity(worktree)
  if (existing) return existing

  // Unrelated repositories must never serialize identity creation behind a machine-global launch.
  // Linked worktrees share commonGitDir, so they still coordinate around their shared Git config.
  const release = acquireNamedLaunchLockSync(home, identityCreationLockName(worktree))
  try {
    // Re-resolve after waiting: another process may have moved the checkout or committed either id.
    worktree = resolveGitWorktree(dir)
    const committed = resolvedIdentity(worktree)
    if (committed) return committed

    const repositoryId = readGitProjectId(worktree.root) ?? createGitProjectId(worktree.root)
    if (worktree.scope === "repository") return { ...worktree, id: repositoryId }

    const id = readGitWorktreeProjectId(worktree) ?? createGitWorktreeProjectId(worktree, repositoryId)
    if (id === repositoryId) {
      throw new Error("linked-worktree fray.id is invalid; it must differ from the repository fray.id")
    }
    return { ...worktree, id }
  } finally {
    release()
  }
}

/** Back-compatible scalar API for the exact checkout's durable UUID. */
export function resolveGitProjectId(dir: string, home = homedir()): string {
  return resolveGitProjectIdentity(dir, home).id
}
