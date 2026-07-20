import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import {
  currentProcessGeneration,
  defaultProcessPlatformAdapter,
  observeProcessGeneration,
  processGenerationIsStale,
  processStartTime,
  type ProcessGeneration,
  type ProcessGenerationObservation,
  type ProcessPlatformAdapter,
} from "./process-generation.ts"

const OWNER_NAME = "project-launch.owner"
const MUTATION_GUARD_NAME = ".project-launch.guard"
const OWNER_VERSION = 2
const PARTIAL_GRACE_MS = 1_000
const GUARD_TIMEOUT_MS = 2_000
const POLL_MS = 25
const DELEGATE_DRAIN_TIMEOUT_MS = 6_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export const FRAY_LAUNCH_OWNER_TOKEN = "FRAY_LAUNCH_OWNER_TOKEN"
export const FRAY_LAUNCH_PROJECT_ID = "FRAY_LAUNCH_PROJECT_ID"
export const FRAY_LAUNCH_PROJECT_DIR = "FRAY_LAUNCH_PROJECT_DIR"
export const FRAY_LAUNCH_STATE_DIR = "FRAY_LAUNCH_STATE_DIR"
export const FRAY_LAUNCH_IDENTITY_SCOPE = "FRAY_LAUNCH_IDENTITY_SCOPE"
export const FRAY_LAUNCH_TMUX_SOCKET = "FRAY_LAUNCH_TMUX_SOCKET"
export const FRAY_LAUNCH_TMUX_SOCKET_MANAGED = "FRAY_LAUNCH_TMUX_SOCKET_MANAGED"

export type ProjectLaunchRole = "launcher" | "supervisor" | "server"

export interface ProjectLaunchTarget {
  projectId: string
  projectDir: string
  stateDir: string
  identityScope?: "worktree"
  tmuxSocket?: string
  tmuxSocketManaged?: boolean
}

export type ProjectLaunchDelegateRole = "control-plane"

export interface ProjectLaunchDelegateRecord extends ProcessGeneration {
  role: ProjectLaunchDelegateRole
  registeredAt: string
}

export interface ProjectLaunchOwnerRecord extends ProcessGeneration {
  version: 2
  token: string
  projectId: string
  projectDir: string
  tmuxSocket?: string
  tmuxSocketManaged?: boolean
  role: ProjectLaunchRole
  state: "active" | "draining"
  delegates: ProjectLaunchDelegateRecord[]
  acquiredAt: string
  updatedAt: string
}

interface MutationGuardRecord extends ProcessGeneration {
  version: 1
  token: string
  at: string
}

export interface ProjectLaunchLease extends ProcessGeneration {
  readonly target: ProjectLaunchTarget
  readonly token: string
  readonly role: ProjectLaunchRole
  release(): boolean
}

export interface ProjectLaunchDelegateLease extends ProcessGeneration {
  readonly target: ProjectLaunchTarget
  readonly token: string
  readonly role: ProjectLaunchDelegateRole
  release(): boolean
}

export interface ProjectLaunchProtocolOptions {
  adapter?: ProcessPlatformAdapter
  delegateDrainTimeoutMs?: number
  pollMs?: number
}

export type ProjectLaunchAttempt =
  | { kind: "acquired"; lease: ProjectLaunchLease }
  | { kind: "contended"; owner: ProjectLaunchOwnerRecord | null }

export class ProjectLaunchConflictError extends Error {
  readonly owner: ProjectLaunchOwnerRecord | null

  constructor(owner: ProjectLaunchOwnerRecord | null) {
    super(owner
      ? `Fray project launch is already owned by ${owner.role} pid ${owner.pid}; wait for it to become ready or stop that exact owner`
      : "Fray project launch ownership is being published; retry shortly")
    this.name = "ProjectLaunchConflictError"
    this.owner = owner
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function validText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
}

export {
  currentProcessGeneration,
  defaultProcessPlatformAdapter,
  exactProcessGenerationIsLive,
  observeProcessGeneration,
  processGenerationIsStale,
  processStartTime,
  type ProcessGeneration,
  type ProcessGenerationObservation,
  type ProcessPlatformAdapter,
} from "./process-generation.ts"

function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    fsyncSync(fd)
  } catch {
    // Unsupported on some filesystems. The file itself is always synced before publication.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    syncDirectory(dirname(path))
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

function quarantine(path: string, suffix: string): boolean {
  const moved = `${path}.${suffix}-${process.pid}-${randomUUID()}`
  try {
    renameSync(path, moved)
  } catch {
    return false
  }
  try { rmSync(moved, { recursive: true, force: true }) } catch {}
  return true
}

function pathAge(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function parseGeneration(value: Record<string, unknown>): ProcessGeneration | null {
  return Number.isInteger(value.pid) && (value.pid as number) > 0 && validText(value.processStart, 128)
    ? { pid: value.pid as number, processStart: value.processStart }
    : null
}

function parseGuard(path: string): MutationGuardRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const generation = parseGeneration(value)
    if (value.version !== 1 || !generation || typeof value.token !== "string" || !UUID_RE.test(value.token) || !validText(value.at, 128)) return null
    return { version: 1, token: value.token, at: value.at, ...generation }
  } catch {
    return null
  }
}

function acquireMutationGuard(
  stateDir: string,
  timeoutMs = GUARD_TIMEOUT_MS,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): () => void {
  const path = join(stateDir, MUTATION_GUARD_NAME)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deadline = adapter.now() + Math.max(0, timeoutMs)
  for (;;) {
    const generation = currentProcessGeneration(adapter)
    const token = randomUUID()
    let fd: number | undefined
    try {
      fd = openSync(path, "wx", 0o600)
      const record: MutationGuardRecord = {
        version: 1,
        token,
        at: new Date(adapter.now()).toISOString(),
        ...generation,
      }
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8")
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      const committed = parseGuard(path)
      if (!committed || committed.token !== token || committed.pid !== generation.pid || committed.processStart !== generation.processStart) continue
      let released = false
      return () => {
        if (released) return
        released = true
        const current = parseGuard(path)
        if (!current || current.token !== token || current.pid !== generation.pid || current.processStart !== generation.processStart) return
        quarantine(path, "release")
      }
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
      }
      if (errorCode(error) !== "EEXIST") throw error
    }

    const current = parseGuard(path)
    const age = pathAge(path)
    const stale = current
      ? processGenerationIsStale(current, adapter)
      : age !== undefined && (age >= PARTIAL_GRACE_MS || age < -PARTIAL_GRACE_MS)
    if (stale && quarantine(path, "stale")) continue
    if (adapter.now() >= deadline) throw new Error("timed out waiting for the Fray project ownership guard")
    adapter.sleep(Math.min(POLL_MS, Math.max(1, deadline - adapter.now())))
  }
}

function validRole(value: unknown): value is ProjectLaunchRole {
  return value === "launcher" || value === "supervisor" || value === "server"
}

function validDelegateRole(value: unknown): value is ProjectLaunchDelegateRole {
  return value === "control-plane"
}

function parseDelegates(value: unknown): ProjectLaunchDelegateRecord[] | null {
  if (!Array.isArray(value) || value.length > 64) return null
  const delegates: ProjectLaunchDelegateRecord[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null
    const record = candidate as Record<string, unknown>
    const generation = parseGeneration(record)
    if (!generation || !validDelegateRole(record.role) || !validText(record.registeredAt, 128)) return null
    const key = `${generation.pid}:${generation.processStart}`
    if (seen.has(key)) return null
    seen.add(key)
    delegates.push({ ...generation, role: record.role, registeredAt: record.registeredAt })
  }
  return delegates
}

function parseOwner(path: string): ProjectLaunchOwnerRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const generation = parseGeneration(value)
    if (
      (value.version !== 1 && value.version !== OWNER_VERSION) ||
      !generation ||
      typeof value.token !== "string" ||
      !UUID_RE.test(value.token) ||
      typeof value.projectId !== "string" ||
      !UUID_RE.test(value.projectId) ||
      !validText(value.projectDir) ||
      !isAbsolute(value.projectDir) ||
      (value.tmuxSocket !== undefined && (!validText(value.tmuxSocket, 64) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value.tmuxSocket))) ||
      (value.tmuxSocketManaged !== undefined && typeof value.tmuxSocketManaged !== "boolean") ||
      ((value.tmuxSocket === undefined) !== (value.tmuxSocketManaged === undefined)) ||
      !validRole(value.role) ||
      !validText(value.acquiredAt, 128) ||
      !validText(value.updatedAt, 128)
    ) return null
    const delegates = value.version === 1 ? [] : parseDelegates(value.delegates)
    const state = value.version === 1 ? "active" : value.state
    if (!delegates || (state !== "active" && state !== "draining")) return null
    return {
      version: 2,
      token: value.token,
      projectId: value.projectId,
      projectDir: value.projectDir,
      ...(typeof value.tmuxSocket === "string"
        ? { tmuxSocket: value.tmuxSocket, tmuxSocketManaged: value.tmuxSocketManaged as boolean }
        : {}),
      role: value.role,
      state,
      delegates,
      acquiredAt: value.acquiredAt,
      updatedAt: value.updatedAt,
      ...generation,
    }
  } catch {
    return null
  }
}

export function projectLaunchOwnerPath(stateDir: string): string {
  return join(stateDir, OWNER_NAME)
}

export function readProjectLaunchOwner(stateDir: string): ProjectLaunchOwnerRecord | null {
  return parseOwner(projectLaunchOwnerPath(stateDir))
}

function sameTarget(record: ProjectLaunchOwnerRecord, target: ProjectLaunchTarget): boolean {
  return record.projectId === target.projectId && record.projectDir === target.projectDir &&
    (!record.tmuxSocket || !target.tmuxSocket || (
      record.tmuxSocket === target.tmuxSocket && record.tmuxSocketManaged === target.tmuxSocketManaged
    ))
}

// The owner file itself is scoped by target.stateDir. A repository/worktree can be moved while a
// supervisor is down, so stale-owner retirement must key on the durable project identity rather
// than permanently pinning the old canonical root. Live owners and delegates remain fenced below.
function sameProjectIdentity(record: ProjectLaunchOwnerRecord, target: ProjectLaunchTarget): boolean {
  return record.projectId === target.projectId
}

export function projectLaunchTokenProof(target: ProjectLaunchTarget, token: string): string {
  if (!UUID_RE.test(token)) throw new Error("invalid Fray project launch owner token")
  return createHash("sha256")
    .update("fray-project-launch-v2\0")
    .update(target.projectId)
    .update("\0")
    .update(target.projectDir)
    .update("\0")
    .update(token)
    .digest("hex")
}

function removeStatusesForToken(stateDir: string, token: string): void {
  for (const name of ["dev-supervisor.lock", "server.lock"]) {
    const path = join(stateDir, name)
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { ownerToken?: unknown }
      if (value.ownerToken === token) quarantine(path, "stale")
    } catch {}
  }
}

function writeNewOwner(path: string, record: ProjectLaunchOwnerRecord): void {
  let fd: number | undefined
  try {
    fd = openSync(path, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncDirectory(dirname(path))
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    throw error
  }
}

function makeLease(
  target: ProjectLaunchTarget,
  record: ProjectLaunchOwnerRecord,
  adapter: ProcessPlatformAdapter,
): ProjectLaunchLease {
  let released = false
  return {
    target,
    token: record.token,
    pid: record.pid,
    processStart: record.processStart,
    role: record.role,
    release: () => {
      if (released) return false
      const unlock = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
      try {
        const path = projectLaunchOwnerPath(target.stateDir)
        const current = parseOwner(path)
        if (
          !current ||
          !sameTarget(current, target) ||
          current.token !== record.token ||
          current.pid !== record.pid ||
          current.processStart !== record.processStart
        ) {
          released = true
          return false
        }
        const liveDelegates = current.delegates.filter((delegate) => !processGenerationIsStale(delegate, adapter))
        if (liveDelegates.length > 0) return false
        const removed = quarantine(path, "release")
        if (removed) {
          removeStatusesForToken(target.stateDir, current.token)
          released = true
        }
        return removed
      } finally {
        unlock()
      }
    },
  }
}

function newOwnerRecord(
  target: ProjectLaunchTarget,
  role: ProjectLaunchRole,
  adapter: ProcessPlatformAdapter,
): ProjectLaunchOwnerRecord {
  const now = new Date(adapter.now()).toISOString()
  return {
    version: 2,
    token: randomUUID(),
    projectId: target.projectId,
    projectDir: target.projectDir,
    ...(target.tmuxSocket
      ? { tmuxSocket: target.tmuxSocket, tmuxSocketManaged: target.tmuxSocketManaged !== false }
      : {}),
    role,
    state: "active",
    delegates: [],
    acquiredAt: now,
    updatedAt: now,
    ...currentProcessGeneration(adapter),
  }
}

function installNewOwner(
  target: ProjectLaunchTarget,
  role: ProjectLaunchRole,
  adapter: ProcessPlatformAdapter,
): ProjectLaunchAttempt {
  const path = projectLaunchOwnerPath(target.stateDir)
  const record = newOwnerRecord(target, role, adapter)
  try {
    writeNewOwner(path, record)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return { kind: "contended", owner: parseOwner(path) }
    throw error
  }
  const committed = parseOwner(path)
  if (!committed || committed.token !== record.token) return { kind: "contended", owner: committed }
  return { kind: "acquired", lease: makeLease(target, committed, adapter) }
}

function drainDelegates(
  delegates: ProjectLaunchDelegateRecord[],
  options: Required<Pick<ProjectLaunchProtocolOptions, "delegateDrainTimeoutMs" | "pollMs">> & { adapter: ProcessPlatformAdapter },
): void {
  // Registered control planes are direct children and shut themselves down when their authenticated
  // supervisor IPC channel disconnects. Never turn a generation observation into a later PID signal:
  // the PID can be recycled in that gap. Unknown/live delegates retain the draining fence.
  const deadline = options.adapter.now() + options.delegateDrainTimeoutMs
  while (delegates.some((delegate) => !processGenerationIsStale(delegate, options.adapter))) {
    if (options.adapter.now() >= deadline) return
    options.adapter.sleep(Math.min(options.pollMs, Math.max(1, deadline - options.adapter.now())))
  }
}

export function tryAcquireProjectLaunchOwner(
  target: ProjectLaunchTarget,
  role: ProjectLaunchRole,
  protocol: ProjectLaunchProtocolOptions = {},
): ProjectLaunchAttempt {
  const adapter = protocol.adapter ?? defaultProcessPlatformAdapter
  const options = {
    adapter,
    delegateDrainTimeoutMs: Math.max(0, protocol.delegateDrainTimeoutMs ?? DELEGATE_DRAIN_TIMEOUT_MS),
    pollMs: Math.max(1, protocol.pollMs ?? POLL_MS),
  }
  let draining: ProjectLaunchOwnerRecord | null = null
  let unlock = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
  try {
    const path = projectLaunchOwnerPath(target.stateDir)
    const existing = parseOwner(path)
    if (existing) {
      if (!sameProjectIdentity(existing, target)) return { kind: "contended", owner: existing }
      if (!processGenerationIsStale(existing, adapter)) return { kind: "contended", owner: existing }
      draining = existing.state === "draining" ? existing : {
        ...existing,
        state: "draining",
        updatedAt: new Date(adapter.now()).toISOString(),
      }
      if (existing.state !== "draining") atomicJson(path, draining)
    } else {
      const age = pathAge(path)
      if (age !== undefined) {
        if (age < PARTIAL_GRACE_MS && age >= -PARTIAL_GRACE_MS) return { kind: "contended", owner: null }
        if (!quarantine(path, "stale")) return { kind: "contended", owner: parseOwner(path) }
      }
      return installNewOwner(target, role, adapter)
    }
  } finally {
    unlock()
  }

  drainDelegates(draining!.delegates, options)

  unlock = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
  try {
    const path = projectLaunchOwnerPath(target.stateDir)
    const current = parseOwner(path)
    if (!current || current.token !== draining!.token || !sameProjectIdentity(current, target)) {
      return { kind: "contended", owner: current }
    }
    const liveDelegates = current.delegates.filter((delegate) => !processGenerationIsStale(delegate, adapter))
    if (liveDelegates.length > 0) return { kind: "contended", owner: { ...current, delegates: liveDelegates } }
    if (!quarantine(path, "stale")) return { kind: "contended", owner: parseOwner(path) }
    removeStatusesForToken(target.stateDir, current.token)
    return installNewOwner(target, role, adapter)
  } finally {
    unlock()
  }
}

export function acquireProjectLaunchOwner(
  target: ProjectLaunchTarget,
  role: ProjectLaunchRole,
  protocol: ProjectLaunchProtocolOptions = {},
): ProjectLaunchLease {
  const attempt = tryAcquireProjectLaunchOwner(target, role, protocol)
  if (attempt.kind === "contended") throw new ProjectLaunchConflictError(attempt.owner)
  return attempt.lease
}

export function adoptProjectLaunchOwner(
  target: ProjectLaunchTarget,
  token: string,
  role: ProjectLaunchRole,
  protocol: ProjectLaunchProtocolOptions = {},
): ProjectLaunchLease {
  if (!UUID_RE.test(token)) throw new Error("invalid Fray project launch owner token")
  const adapter = protocol.adapter ?? defaultProcessPlatformAdapter
  const unlock = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
  try {
    const path = projectLaunchOwnerPath(target.stateDir)
    const current = parseOwner(path)
    if (!current || !sameTarget(current, target) || current.token !== token || current.state !== "active") {
      throw new Error("Fray project launch ownership handoff no longer matches this project")
    }
    const generation = currentProcessGeneration(adapter)
    const next: ProjectLaunchOwnerRecord = {
      ...current,
      ...generation,
      version: 2,
      role,
      ...(target.tmuxSocket
        ? { tmuxSocket: target.tmuxSocket, tmuxSocketManaged: target.tmuxSocketManaged !== false }
        : {}),
      updatedAt: new Date(adapter.now()).toISOString(),
    }
    atomicJson(path, next)
    const committed = parseOwner(path)
    if (
      !committed ||
      committed.token !== token ||
      committed.pid !== generation.pid ||
      committed.processStart !== generation.processStart
    ) throw new Error("Fray project launch ownership handoff was not committed")
    return makeLease(target, committed, adapter)
  } finally {
    unlock()
  }
}

export function verifyProjectLaunchDelegate(
  target: ProjectLaunchTarget,
  token: string,
  protocol: ProjectLaunchProtocolOptions = {},
): ProjectLaunchOwnerRecord {
  if (!UUID_RE.test(token)) throw new Error("invalid Fray project launch owner token")
  const adapter = protocol.adapter ?? defaultProcessPlatformAdapter
  const unlock = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
  try {
    const current = parseOwner(projectLaunchOwnerPath(target.stateDir))
    if (
      !current ||
      !sameTarget(current, target) ||
      current.token !== token ||
      current.state !== "active" ||
      processGenerationIsStale(current, adapter)
    ) {
      throw new Error("Fray control-plane child has no live matching project launch owner")
    }
    return current
  } finally {
    unlock()
  }
}

export function registerProjectLaunchDelegate(
  target: ProjectLaunchTarget,
  token: string,
  role: ProjectLaunchDelegateRole = "control-plane",
  protocol: ProjectLaunchProtocolOptions = {},
): ProjectLaunchDelegateLease {
  if (!UUID_RE.test(token)) throw new Error("invalid Fray project launch owner token")
  const adapter = protocol.adapter ?? defaultProcessPlatformAdapter
  const generation = currentProcessGeneration(adapter)
  const unlock = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
  try {
    const path = projectLaunchOwnerPath(target.stateDir)
    const current = parseOwner(path)
    if (
      !current ||
      !sameTarget(current, target) ||
      current.token !== token ||
      current.state !== "active" ||
      processGenerationIsStale(current, adapter)
    ) throw new Error("Fray control-plane child has no live matching project launch owner")

    const registeredAt = new Date(adapter.now()).toISOString()
    if (current.pid === generation.pid && current.processStart === generation.processStart) {
      throw new Error("Fray launch owner cannot register itself as a delegated control plane")
    }
    const delegates = current.delegates.filter((delegate) => (
      !processGenerationIsStale(delegate, adapter)
      && (delegate.pid !== generation.pid || delegate.processStart !== generation.processStart)
    ))
    if (delegates.length >= 64) throw new Error("Fray project has too many live delegated control planes")
    delegates.push({ ...generation, role, registeredAt })
    const next: ProjectLaunchOwnerRecord = {
      ...current,
      version: 2,
      delegates,
      updatedAt: registeredAt,
    }
    atomicJson(path, next)
    const committed = parseOwner(path)
    if (!committed || !committed.delegates.some((delegate) => (
      delegate.pid === generation.pid && delegate.processStart === generation.processStart && delegate.role === role
    ))) throw new Error("Fray control-plane delegate registration was not committed")

    let released = false
    return {
      target,
      token,
      role,
      ...generation,
      release: () => {
        if (released) return false
        const releaseGuard = acquireMutationGuard(target.stateDir, GUARD_TIMEOUT_MS, adapter)
        try {
          const owner = parseOwner(path)
          if (!owner || !sameTarget(owner, target) || owner.token !== token) {
            released = true
            return false
          }
          const remaining = owner.delegates.filter((delegate) => (
            delegate.pid !== generation.pid || delegate.processStart !== generation.processStart
          ))
          if (remaining.length === owner.delegates.length) {
            released = true
            return false
          }
          atomicJson(path, {
            ...owner,
            delegates: remaining,
            updatedAt: new Date(adapter.now()).toISOString(),
          })
          released = true
          return true
        } finally {
          releaseGuard()
        }
      },
    }
  } finally {
    unlock()
  }
}

export function projectLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  target: ProjectLaunchTarget,
  token: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [FRAY_LAUNCH_OWNER_TOKEN]: token,
    [FRAY_LAUNCH_PROJECT_ID]: target.projectId,
    [FRAY_LAUNCH_PROJECT_DIR]: target.projectDir,
    [FRAY_LAUNCH_STATE_DIR]: target.stateDir,
    [FRAY_LAUNCH_IDENTITY_SCOPE]: target.identityScope ?? "repository",
    ...(target.tmuxSocket ? {
      [FRAY_LAUNCH_TMUX_SOCKET]: target.tmuxSocket,
      [FRAY_LAUNCH_TMUX_SOCKET_MANAGED]: target.tmuxSocketManaged === false ? "0" : "1",
    } : {}),
  }
}

export function projectLaunchTargetFromEnvironment(env: NodeJS.ProcessEnv): ProjectLaunchTarget | null {
  const projectId = env[FRAY_LAUNCH_PROJECT_ID]
  const projectDir = env[FRAY_LAUNCH_PROJECT_DIR]
  const stateDir = env[FRAY_LAUNCH_STATE_DIR]
  const scope = env[FRAY_LAUNCH_IDENTITY_SCOPE]
  const tmuxSocket = env[FRAY_LAUNCH_TMUX_SOCKET]
  const tmuxManaged = env[FRAY_LAUNCH_TMUX_SOCKET_MANAGED]
  if (
    !projectId ||
    !UUID_RE.test(projectId) ||
    !projectDir ||
    !isAbsolute(projectDir) ||
    !stateDir ||
    !isAbsolute(stateDir) ||
    (scope !== "repository" && scope !== "worktree") ||
    (tmuxSocket !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(tmuxSocket)) ||
    (tmuxManaged !== undefined && tmuxManaged !== "0" && tmuxManaged !== "1") ||
    ((tmuxSocket === undefined) !== (tmuxManaged === undefined))
  ) return null
  return {
    projectId,
    projectDir,
    stateDir,
    ...(scope === "worktree" ? { identityScope: "worktree" as const } : {}),
    ...(tmuxSocket ? { tmuxSocket, tmuxSocketManaged: tmuxManaged !== "0" } : {}),
  }
}

export function projectLaunchOwnerTokenFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  const token = env[FRAY_LAUNCH_OWNER_TOKEN]
  return token && UUID_RE.test(token) ? token : null
}

export function writeProjectStatus(path: string, value: Record<string, unknown>): void {
  atomicJson(path, value)
}

export function removeProjectStatus(
  path: string,
  expected: { pid: number; processStart: string; publisherToken: string; ownerToken: string },
): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    if (
      value.pid !== expected.pid ||
      value.processStart !== expected.processStart ||
      value.publisherToken !== expected.publisherToken ||
      value.ownerToken !== expected.ownerToken
    ) return false
    return quarantine(path, "release")
  } catch {
    return false
  }
}

export function projectLaunchRecordHasGeneration(
  owner: ProjectLaunchOwnerRecord,
  generation: ProcessGeneration,
): boolean {
  return (owner.pid === generation.pid && owner.processStart === generation.processStart)
    || owner.delegates.some((delegate) => (
      delegate.pid === generation.pid && delegate.processStart === generation.processStart
    ))
}
