import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  currentProcessGeneration,
  processGenerationIsStale,
  readProjectLaunchOwner,
  type ProjectLaunchTarget,
} from "./project-launch.ts"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SOCKET_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const MIGRATION_NAME = "tmux-socket-migration.json"
const GUARD_NAME = ".tmux-socket-migration.guard"
const GUARD_OWNER = "owner.json"
const GUARD_TIMEOUT_MS = 2_000
const PARTIAL_GRACE_MS = 1_000
const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4))

export const TMUX_MARKER_PROJECT_ID = "@fray_project_id"
export const TMUX_MARKER_PROJECT_ROOT = "@fray_project_root_sha256"

export interface TmuxSocketPane {
  sessionName: string
  paneId: string
  panePid: number
  sessionCreated: number
  dead: boolean
  currentPath: string
}

export type TmuxSocketObservation =
  | { kind: "absent" }
  | { kind: "unknown" }
  | {
      kind: "present"
      projectId: string | null
      projectRootHash: string | null
      panes: TmuxSocketPane[]
    }

export interface TmuxSocketRuntime {
  inspect(socket: string): TmuxSocketObservation
  label(
    socket: string,
    anchor: Pick<TmuxSocketPane, "paneId" | "panePid" | "sessionCreated">,
    marker: { projectId: string; projectRootHash: string },
  ): boolean
}

export interface TmuxSocketMigrationRecord {
  version: 1
  projectId: string
  projectDir: string
  legacySocket: string
  fullSocket: string
  selectedSocket: string
  phase: "claiming" | "legacy" | "full"
  updatedAt: string
}

interface GuardOwner {
  version: 1
  token: string
  pid: number
  processStart: string
}

function canonicalUuid(value: string | undefined | null): string | null {
  return value && UUID_RE.test(value) ? value.toLowerCase() : null
}

function fallbackSocketComponent(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9]/gu, "")
  if (compact && compact.length <= 40) return compact
  return createHash("sha256").update("fray-tmux-noncanonical\0").update(value).digest("hex").slice(0, 32)
}

/** New ordinary repositories use all 128 UUID bits. The 42-byte name is safely below tmux limits. */
export function deriveSocket(projectId: string | undefined | null): string {
  if (!projectId) return "fray"
  const uuid = canonicalUuid(projectId)
  return `fray-repo-${uuid ? uuid.replaceAll("-", "") : fallbackSocketComponent(projectId)}`
}

/** Historical ordinary-repository mapping, retained only by the durable migration protocol. */
export function deriveLegacySocket(projectId: string | undefined | null): string {
  const short = (projectId ?? "").replace(/[^A-Za-z0-9]/gu, "").slice(0, 8)
  return short ? `fray-${short}` : "fray"
}

export function deriveWorktreeSocket(projectId: string | undefined | null): string {
  if (!projectId) return "fray"
  const uuid = canonicalUuid(projectId)
  return `fray-worktree-${uuid ? uuid.replaceAll("-", "") : fallbackSocketComponent(projectId)}`
}

export function validateTmuxSocketName(value: string): string {
  if (!SOCKET_RE.test(value)) throw new Error("invalid FRAY_TMUX_SOCKET name")
  return value
}

export function deriveProjectSocket(
  projectId: string | undefined | null,
  linkedWorktree = false,
  repositoryOverride?: string,
): string {
  if (repositoryOverride !== undefined) return validateTmuxSocketName(repositoryOverride)
  if (linkedWorktree) return deriveWorktreeSocket(projectId)
  return deriveSocket(projectId)
}

export function tmuxProjectRootHash(projectDir: string): string {
  return createHash("sha256")
    .update("fray-tmux-project-root-v1\0")
    .update(projectDir)
    .digest("hex")
}

function errorStderr(error: unknown): string {
  return error && typeof error === "object" && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "")
    : ""
}

function tmuxSocketIsAbsent(error: unknown): boolean {
  const stderr = errorStderr(error)
  return /(?:no server running|no sessions|failed to connect|error connecting to .*\((?:no such file or directory|connection refused)\))/iu.test(stderr)
}

const INSPECTION_FORMAT = [
  "#{session_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{session_created}",
  "#{pane_dead}",
  "#{pane_current_path}",
  `#{${TMUX_MARKER_PROJECT_ID}}`,
  `#{${TMUX_MARKER_PROJECT_ROOT}}`,
].join("\t")

export function parseTmuxSocketInspection(output: string): TmuxSocketObservation {
  const lines = output.split("\n").filter(Boolean)
  if (lines.length === 0) return { kind: "absent" }
  const panes: TmuxSocketPane[] = []
  let projectId: string | null | undefined
  let projectRootHash: string | null | undefined
  for (const line of lines) {
    const fields = line.split("\t")
    if (fields.length !== 8) return { kind: "unknown" }
    const [sessionName, paneId, panePidRaw, sessionCreatedRaw, deadRaw, currentPath, idRaw, rootRaw] = fields
    const panePid = Number.parseInt(panePidRaw, 10)
    const sessionCreated = Number.parseInt(sessionCreatedRaw, 10)
    if (
      !sessionName || !/^%\d+$/u.test(paneId) || !Number.isSafeInteger(panePid) || panePid <= 0 ||
      !Number.isSafeInteger(sessionCreated) || sessionCreated <= 0 ||
      (deadRaw !== "0" && deadRaw !== "1") || (deadRaw === "0" && !isAbsolute(currentPath))
    ) return { kind: "unknown" }
    const parsedId = idRaw || null
    const parsedRoot = rootRaw || null
    if (projectId === undefined) projectId = parsedId
    else if (projectId !== parsedId) return { kind: "unknown" }
    if (projectRootHash === undefined) projectRootHash = parsedRoot
    else if (projectRootHash !== parsedRoot) return { kind: "unknown" }
    panes.push({
      sessionName,
      paneId,
      panePid,
      sessionCreated,
      dead: deadRaw === "1",
      currentPath,
    })
  }
  return { kind: "present", projectId: projectId ?? null, projectRootHash: projectRootHash ?? null, panes }
}

export const productionTmuxSocketRuntime: TmuxSocketRuntime = {
  inspect(socket) {
    try {
      const output = execFileSync(
        "tmux",
        ["-L", validateTmuxSocketName(socket), "list-panes", "-a", "-F", INSPECTION_FORMAT],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
      return parseTmuxSocketInspection(output)
    } catch (error) {
      return tmuxSocketIsAbsent(error)
        ? { kind: "absent" }
        : { kind: "unknown" }
    }
  },
  label(socket, anchor, marker) {
    if (
      !/^%\d+$/u.test(anchor.paneId) || !Number.isSafeInteger(anchor.panePid) ||
      !Number.isSafeInteger(anchor.sessionCreated) || !UUID_RE.test(marker.projectId) ||
      !/^[0-9a-f]{64}$/u.test(marker.projectRootHash)
    ) return false
    const condition = `#{&&:#{==:#{pane_id},${anchor.paneId}},#{&&:#{==:#{pane_pid},${anchor.panePid}},#{==:#{session_created},${anchor.sessionCreated}}}}`
    const ok = `FRAY_TMUX_MARKER_OK_${randomUUID().replaceAll("-", "")}`
    try {
      const output = execFileSync("tmux", [
        "-L", validateTmuxSocketName(socket),
        "if-shell", "-t", anchor.paneId, "-F", condition,
        `set-option -gq ${TMUX_MARKER_PROJECT_ID} ${marker.projectId} ; set-option -gq ${TMUX_MARKER_PROJECT_ROOT} ${marker.projectRootHash} ; display-message -p ${ok}`,
        "",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      return output.trimEnd().endsWith(ok)
    } catch {
      return false
    }
  },
}

function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    fsyncSync(fd)
  } catch {
    // Some filesystems do not support directory fsync; the file itself is still durable.
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    syncDirectory(dirname(path))
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    try { rmSync(temp, { force: true }) } catch {}
  }
}

function readGuard(path: string): GuardOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(path, GUARD_OWNER), "utf8")) as Partial<GuardOwner>
    if (
      value.version !== 1 || !UUID_RE.test(value.token ?? "") || !Number.isInteger(value.pid) ||
      value.pid! <= 0 || typeof value.processStart !== "string"
    ) return null
    return value as GuardOwner
  } catch {
    return null
  }
}

function acquireGuard(stateDir: string): () => void {
  const path = join(stateDir, GUARD_NAME)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + GUARD_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      const generation = currentProcessGeneration()
      const owner: GuardOwner = { version: 1, token: randomUUID(), ...generation }
      atomicJson(join(path, GUARD_OWNER), owner)
      let released = false
      return () => {
        if (released) return
        released = true
        const current = readGuard(path)
        if (!current || current.token !== owner.token || current.pid !== owner.pid || current.processStart !== owner.processStart) return
        const quarantine = `${path}.release-${owner.token}`
        try {
          renameSync(path, quarantine)
          rmSync(quarantine, { recursive: true, force: true })
        } catch {}
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
    }

    const owner = readGuard(path)
    let stale = owner ? processGenerationIsStale(owner) : false
    if (!owner) {
      try {
        const age = Date.now() - statSync(path).mtimeMs
        stale = age >= PARTIAL_GRACE_MS || age < -PARTIAL_GRACE_MS
      } catch {
        stale = false
      }
    }
    if (stale) {
      try {
        const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`
        renameSync(path, quarantine)
        rmSync(quarantine, { recursive: true, force: true })
        continue
      } catch {}
    }
    if (Date.now() >= deadline) throw new Error("another Fray process is choosing this project's tmux socket")
    Atomics.wait(SYNC_WAIT, 0, 0, 25)
  }
}

export function tmuxSocketMigrationPath(stateDir: string): string {
  return join(stateDir, MIGRATION_NAME)
}

export function readTmuxSocketMigration(stateDir: string): TmuxSocketMigrationRecord | null {
  try {
    const value = JSON.parse(readFileSync(tmuxSocketMigrationPath(stateDir), "utf8")) as Partial<TmuxSocketMigrationRecord>
    if (
      value.version !== 1 || !UUID_RE.test(value.projectId ?? "") || !isAbsolute(value.projectDir ?? "") ||
      !SOCKET_RE.test(value.legacySocket ?? "") || !SOCKET_RE.test(value.fullSocket ?? "") ||
      !SOCKET_RE.test(value.selectedSocket ?? "") ||
      (value.phase !== "claiming" && value.phase !== "legacy" && value.phase !== "full") ||
      typeof value.updatedAt !== "string"
    ) return null
    if (value.selectedSocket !== (value.phase === "full" ? value.fullSocket : value.legacySocket)) return null
    return value as TmuxSocketMigrationRecord
  } catch {
    return null
  }
}

function writeMigration(
  target: ProjectLaunchTarget,
  legacySocket: string,
  fullSocket: string,
  phase: "claiming" | "legacy" | "full",
): TmuxSocketMigrationRecord {
  const record: TmuxSocketMigrationRecord = {
    version: 1,
    projectId: target.projectId,
    projectDir: target.projectDir,
    legacySocket,
    fullSocket,
    selectedSocket: phase === "full" ? fullSocket : legacySocket,
    phase,
    updatedAt: new Date().toISOString(),
  }
  atomicJson(tmuxSocketMigrationPath(target.stateDir), record)
  return record
}

function markerKind(
  observation: Extract<TmuxSocketObservation, { kind: "present" }>,
  target: ProjectLaunchTarget,
): "exact" | "empty" | "foreign" | "partial" {
  if (observation.projectId === null && observation.projectRootHash === null) return "empty"
  if (observation.projectId === null || observation.projectRootHash === null) return "partial"
  return observation.projectId === target.projectId && observation.projectRootHash === tmuxProjectRootHash(target.projectDir)
    ? "exact"
    : "foreign"
}

function pathBelongsToProject(path: string, projectDir: string): boolean {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    canonical = resolve(path)
  }
  const rel = relative(projectDir, canonical)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function markerlessLegacyIsAttributable(
  observation: Extract<TmuxSocketObservation, { kind: "present" }>,
  target: ProjectLaunchTarget,
): boolean {
  return observation.panes.length > 0 && observation.panes.every((pane) =>
    !pane.dead && isAbsolute(pane.currentPath) &&
    /^fray-[a-z0-9][a-z0-9-]*$/u.test(pane.sessionName) && pathBelongsToProject(pane.currentPath, target.projectDir),
  )
}

function validateFullSocket(
  runtime: TmuxSocketRuntime,
  socket: string,
  target: ProjectLaunchTarget,
): void {
  const observation = runtime.inspect(socket)
  if (observation.kind === "absent") return
  if (observation.kind === "unknown" || markerKind(observation, target) !== "exact") {
    throw new Error(
      `Fray's derived full project tmux socket ${socket} has unknown or foreign ownership; no sessions were contacted or mutated. This can indicate duplicate or corrupt fray.id values, or a canonical-root collision.`
    )
  }
}

function liveOwnerForProject(target: ProjectLaunchTarget) {
  const owner = readProjectLaunchOwner(target.stateDir)
  if (!owner || owner.projectId !== target.projectId || processGenerationIsStale(owner)) return null
  return owner
}

function chooseLegacy(
  runtime: TmuxSocketRuntime,
  observation: TmuxSocketObservation,
  target: ProjectLaunchTarget,
  legacySocket: string,
  fullSocket: string,
  keepEmptyForLiveOwner: boolean,
  claimInProgress = false,
): string {
  if (observation.kind === "unknown") {
    throw new Error("Fray could not verify the legacy tmux socket; no sessions were contacted")
  }
  if (observation.kind === "absent") {
    if (keepEmptyForLiveOwner) return writeMigration(target, legacySocket, fullSocket, "legacy").selectedSocket
    validateFullSocket(runtime, fullSocket, target)
    return writeMigration(target, legacySocket, fullSocket, "full").selectedSocket
  }
  const ownership = markerKind(observation, target)
  if (ownership === "exact") {
    if (claimInProgress && !markerlessLegacyIsAttributable(observation, target)) {
      throw new Error("Fray's interrupted legacy tmux ownership claim remains unverified; no sessions were contacted")
    }
    return writeMigration(target, legacySocket, fullSocket, "legacy").selectedSocket
  }
  if (ownership !== "empty" || !markerlessLegacyIsAttributable(observation, target)) {
    throw new Error("Fray's legacy tmux socket is shared, foreign, or unverified; no sessions were contacted")
  }
  // Publish intent before the first mutation. If this process dies after setting the global marker,
  // the next resolver remembers that the claim was never confirmed and rechecks the entire pane set
  // before it can turn this into a trusted legacy pin.
  writeMigration(target, legacySocket, fullSocket, "claiming")
  const anchor = observation.panes[0]
  const marker = { projectId: target.projectId, projectRootHash: tmuxProjectRootHash(target.projectDir) }
  if (!runtime.label(legacySocket, anchor, marker)) {
    throw new Error("Fray could not atomically claim its existing legacy tmux server; no sessions were contacted")
  }
  const confirmed = runtime.inspect(legacySocket)
  if (
    confirmed.kind !== "present" || markerKind(confirmed, target) !== "exact" ||
    !markerlessLegacyIsAttributable(confirmed, target)
  ) {
    throw new Error("Fray could not confirm legacy tmux ownership after labeling; no sessions were contacted")
  }
  return writeMigration(target, legacySocket, fullSocket, "legacy").selectedSocket
}

export function resolveProjectTmuxSocket(
  target: ProjectLaunchTarget,
  options: { repositoryOverride?: string; runtime?: TmuxSocketRuntime } = {},
): string {
  if (!UUID_RE.test(target.projectId) || !isAbsolute(target.projectDir) || !isAbsolute(target.stateDir)) {
    throw new Error("invalid project identity for tmux socket selection")
  }
  // Explicit operator choices are never migrated, inspected, or marked by Fray. This escape hatch
  // has identical semantics for ordinary and linked worktrees (the live Nub instance deliberately
  // uses `FRAY_TMUX_SOCKET=fray`). An explicitly empty value is invalid rather than silently managed.
  if (options.repositoryOverride !== undefined) return validateTmuxSocketName(options.repositoryOverride)
  if (target.identityScope === "worktree") return deriveWorktreeSocket(target.projectId)

  const legacySocket = deriveLegacySocket(target.projectId)
  const fullSocket = deriveSocket(target.projectId)
  const runtime = options.runtime ?? productionTmuxSocketRuntime
  const release = acquireGuard(target.stateDir)
  try {
    const owner = liveOwnerForProject(target)
    if (owner?.tmuxSocket) {
      const pinned = validateTmuxSocketName(owner.tmuxSocket)
      if (pinned === fullSocket) validateFullSocket(runtime, fullSocket, target)
      return pinned
    }
    const oldOwnerPinsLegacy = Boolean(owner)
    const record = readTmuxSocketMigration(target.stateDir)
    if (!record && existsSync(tmuxSocketMigrationPath(target.stateDir))) {
      throw new Error("Fray's persisted tmux migration record is invalid; no sessions were contacted")
    }
    if (record) {
      if (
        record.projectId !== target.projectId || record.legacySocket !== legacySocket ||
        record.fullSocket !== fullSocket
      ) throw new Error("Fray's persisted tmux migration does not match this project")
      if (record.phase === "full") {
        validateFullSocket(runtime, fullSocket, target)
        if (record.projectDir !== target.projectDir) writeMigration(target, legacySocket, fullSocket, "full")
        return fullSocket
      }
      return chooseLegacy(
        runtime,
        runtime.inspect(legacySocket),
        target,
        legacySocket,
        fullSocket,
        oldOwnerPinsLegacy,
        record.phase === "claiming",
      )
    }

    // A state directory without SQLite predates no workers, so a colliding legacy prefix belongs to
    // somebody else and is irrelevant. New repositories go straight to the injective namespace.
    if (!existsSync(join(target.stateDir, "ui.db")) && !oldOwnerPinsLegacy) {
      validateFullSocket(runtime, fullSocket, target)
      return writeMigration(target, legacySocket, fullSocket, "full").selectedSocket
    }
    return chooseLegacy(
      runtime,
      runtime.inspect(legacySocket),
      target,
      legacySocket,
      fullSocket,
      oldOwnerPinsLegacy,
    )
  } finally {
    release()
  }
}

export function resolveProjectTmuxSocketSelection(
  target: ProjectLaunchTarget,
  options: { repositoryOverride?: string; runtime?: TmuxSocketRuntime } = {},
): { socket: string; managed: boolean } {
  const socket = resolveProjectTmuxSocket(target, options)
  if (options.repositoryOverride !== undefined) return { socket, managed: false }
  if (target.identityScope === "worktree") return { socket, managed: true }
  const owner = liveOwnerForProject(target)
  if (owner?.tmuxSocket === socket) return { socket, managed: owner.tmuxSocketManaged !== false }
  return { socket, managed: true }
}
