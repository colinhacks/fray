import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import watcher, {
  type AsyncSubscription,
  type Event as WatchEvent,
  type Options as WatchOptions,
  type SubscribeCallback,
} from "@parcel/watcher"
import {
  currentProcessGeneration,
  projectLaunchEnvironment,
  projectLaunchRecordHasGeneration,
  readProjectLaunchOwner,
  removeProjectStatus,
  verifyProjectLaunchDelegate,
  writeProjectStatus,
  type ProjectLaunchTarget,
} from "./project-launch.ts"
import { RestartSupervisorProxy, type RestartResult } from "./restart-supervisor.ts"

export const DEV_RESTART_DEBOUNCE_MS = 180
export const DEV_CRASH_STABLE_MS = 5000
export const DEV_CRASH_RETRY_BASE_MS = 500
export const DEV_CRASH_RETRY_MAX_MS = 10_000
// A server's public shutdown deadline is diagnostic, not proof that its ownership fence is safe to
// abandon. Leave enough room for the child to finish that late drain before escalating to SIGKILL.
const CHILD_STOP_TIMEOUT_MS = 15_000
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"])
const CONFIG_NAMES = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"])
const CHILD_RUNTIME_PACKAGES = new Set(["server", "shared", "rpc", "claude-agent-sdk-runtime"])
const CHILD_PACKAGE_METADATA = new Set(["claude-agent-sdk-runtime"])
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".vite",
])
const DEV_WATCH_IGNORE = [...GENERATED_DIRS].map((dir) => `**/${dir}/**`)

export type DevChangeKind = "child" | "launcher"

/** Exponential retry prevents a ready-then-crash generation from spinning a fork/Vite loop. */
export function devCrashRetryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(DEV_CRASH_RETRY_BASE_MS * 2 ** exponent, DEV_CRASH_RETRY_MAX_MS)
}

export interface DevBoot {
  pid: number
  port: number
  bootId: string
}

export interface DevSupervisorOptions {
  port: number
  launchTarget: ProjectLaunchTarget
  launchOwnerToken: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  stateDir?: string
  watchRoots?: string[]
  /** Stable artifact mode disables source watching and Vite/HMR child boot. */
  watch?: boolean
  /** Additional child-only environment, read again for every controlled replacement. */
  childEnvironment?: () => NodeJS.ProcessEnv
  debounceMs?: number
  childEntry?: string
  /** Allows stable mode to fork the selected artifact runtime on every replacement. */
  childEntryProvider?: () => string
  /**
   * Select one immutable child launch snapshot immediately before each replacement. The entry and
   * environment must describe the same verified artifact; this is intentionally distinct from a
   * pair of independently-evaluated providers so a pointer change cannot split a generation.
   */
  childLaunchProvider?: () => { entry: string; environment: NodeJS.ProcessEnv }
  childArgs?: string[]
  /** Stable-mode only: build/preflight a candidate before the controlled child restart. */
  updateRestart?: () => Promise<RestartResult>
  /** Restore the known-good artifact selection if its replacement cannot become ready. */
  rollbackUpdate?: () => Promise<void> | void
  /**
   * Replace the durable owner after a successful immutable update.  This is deliberately separate
   * from a child recycle: a promoted artifact also contains the CLI/supervisor implementation.
   * The callback must preserve the tokenized project owner in its environment and never return on
   * success (normally it calls execve).
   */
  durableReexec?: () => Promise<void> | void
  /** Deterministic test seam. Production subscribes through @parcel/watcher. */
  watchSubscribe?: (root: string, callback: SubscribeCallback, options: WatchOptions) => Promise<AsyncSubscription>
  /** Test seam. Production uses process.execve so the launcher keeps its pid, cwd and stdio. */
  reexec?: (request: { executable: string; argv: string[]; env: Record<string, string> }) => void
  log?: (line: string) => void
  error?: (line: string) => void
}

export interface DevSupervisor {
  readonly port: number
  readonly firstBoot: Promise<DevBoot>
  readonly stopRequested: Promise<void>
  currentBoot(): DevBoot | null
  close(): Promise<void>
}

export interface SupervisorShutdownHandlerOptions {
  close: () => Promise<void>
  release: () => void
  exit: (code: number) => void
  error?: (line: string) => void
}

/** Idempotent, permanently-installed signal/control handler for the durable supervisor owner. */
export function createSupervisorShutdownHandler(options: SupervisorShutdownHandlerOptions): () => void {
  let stopping = false
  return () => {
    if (stopping) return
    stopping = true
    void options.close().then(
      () => {
        options.release()
        options.exit(0)
      },
      (error) => {
        options.error?.(`[fray-ui] supervisor shutdown failed: ${error instanceof Error ? error.message : error}`)
        options.release()
        options.exit(1)
      },
    )
  }
}

const packagesDir = resolve(import.meta.dirname, "..", "..")
const workspaceDir = resolve(packagesDir, "..")

/** Runtime source trees that can change the server-side API/control plane. Web source stays on Vite HMR. */
export function defaultDevWatchRoots(): string[] {
  return [workspaceDir]
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function ignoredDevPath(path: string): boolean {
  const parts = resolve(path).split(sep)
  const name = parts.at(-1) ?? ""
  return parts.some((part) => GENERATED_DIRS.has(part) || part === "fixtures" || part.endsWith(".fixtures"))
    || /\.(?:test|spec)\.[^.]+$/.test(name)
    || name.includes(".golden.")
}

/**
 * Pure watch classifier. Runtime source can use a cheap disposable-child recycle. Launcher, CLI,
 * dependency and compiler/startup config changes require a validated in-place parent re-exec too.
 */
export function classifyDevChange(path: string, roots = defaultDevWatchRoots()): DevChangeKind | null {
  const absolute = resolve(path)
  const root = roots.find((candidate) => isWithin(absolute, resolve(candidate)))
  if (!root) return null
  if (ignoredDevPath(absolute)) return null

  const name = basename(absolute)
  // `watchRoots` is a public test/embedding seam. Resolve package ownership against the root that
  // actually admitted this event rather than the source checkout captured at module-import time.
  const relToWorkspace = relative(resolve(root), absolute)
  const parts = relToWorkspace.split(sep)
  const packageName = parts[0] === "packages" ? parts[1] : undefined
  if (name === "package.json" && parts.length === 3 && packageName && CHILD_PACKAGE_METADATA.has(packageName)) {
    // This private dependency membrane is loaded only by the disposable control-plane child. Its
    // exports/dependencies must be revalidated, but replacing the stable launcher would buy nothing.
    return "child"
  }
  if (CONFIG_NAMES.has(name) || /^tsconfig(?:\.[^.]+)?\.json$/.test(name) || /^vite(?:\.[^.]+)?\.config\.[cm]?[jt]s$/.test(name)) {
    return "launcher"
  }
  if (!SOURCE_EXTENSIONS.has(extname(name))) return null

  if (parts[0] !== "packages" || parts[2] !== "src") return null
  const pkg = packageName
  if (pkg === "cli") return "launcher"
  if (pkg === "server") {
    if (name === "dev-supervisor.ts" || name === "dev.ts") return "launcher"
    return "child"
  }
  if (pkg && CHILD_RUNTIME_PACKAGES.has(pkg)) return "child"
  // Web source remains Vite HMR's responsibility. Its package/vite/tsconfig files matched above.
  return null
}

/** Back-compatible boolean used by focused tests and callers that only care whether a recycle occurs. */
export function isDevServerSource(path: string, roots = defaultDevWatchRoots()): boolean {
  return classifyDevChange(path, roots) !== null
}

/** Syntax-check config formats that a plain Node child boot does not necessarily consume itself. */
export function devConfigSyntaxError(path: string): string | null {
  const name = basename(path)
  const isTsconfig = /^tsconfig(?:\.[^.]+)?\.json$/.test(name)
  if (name !== "package.json" && !isTsconfig) return null
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return `${name}: ${err instanceof Error ? err.message : err}`
  }
  if (name === "package.json") {
    try {
      JSON.parse(text)
      return null
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : err}`
    }
  }
  if (isTsconfig) {
    try {
      // This is a dev-only preflight, not a compiler invocation. Supporting comments and trailing
      // commas here keeps a stable bundled runtime free of TypeScript and its build-only closure.
      JSON.parse(text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,\s*([}\]])/g, "$1"))
      return null
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : err}`
    }
  }
  return null
}

/** A child gets a copy of the caller's complete environment; only the private dev port marker is added. */
export function devChildEnv(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  return { ...env, FRAY_DEV_PORT: String(port), FRAY_DEV_CHILD: "1" }
}

/** Allocate a disposable control-plane port. The durable proxy keeps the public port throughout. */
async function allocatePrivateDevPort(publicPort: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = await new Promise<number>((resolvePort, rejectPort) => {
      const listener = createNetServer()
      listener.once("error", rejectPort)
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address()
        listener.close((error) => error ? rejectPort(error) : resolvePort(typeof address === "object" && address ? address.port : 0))
      })
    })
    // Vite's legacy source-only HMR companion is still private to the disposable child. Stable
    // artifacts do not create it, but reserving the pair keeps the legacy escape hatch coherent.
    const hmrPort = candidate + 39_000 <= 65_535 ? candidate + 39_000 : candidate - 1000
    if (candidate > 0 && candidate !== publicPort && await canBindPrivatePort(hmrPort)) return candidate
  }
  throw new Error("could not allocate a private Fray control-plane port")
}

async function canBindPrivatePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveBind) => {
    const listener = createNetServer()
    listener.once("error", () => resolveBind(false))
    listener.listen(port, "127.0.0.1", () => listener.close(() => resolveBind(true)))
  })
}

export function devReexecEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const next = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  delete next.FRAY_DEV_CHILD
  delete next.FRAY_DEV_PORT
  next.FRAY_DEV_REEXEC = "1"
  return next
}

type ReadyMessage = { type: "fray-ready"; pid: number; processStart: string; port: number; bootId: string }
function readyMessage(value: unknown): value is ReadyMessage {
  if (!value || typeof value !== "object") return false
  const msg = value as Partial<ReadyMessage>
  return msg.type === "fray-ready"
    && typeof msg.pid === "number"
    && typeof msg.processStart === "string"
    && typeof msg.port === "number"
    && typeof msg.bootId === "string"
}

type StopOwnerMessage = { type: "fray-stop-owner"; token: string }
function stopOwnerMessage(value: unknown): value is StopOwnerMessage {
  if (!value || typeof value !== "object") return false
  const msg = value as Partial<StopOwnerMessage>
  return msg.type === "fray-stop-owner" && typeof msg.token === "string"
}

class Supervisor implements DevSupervisor {
  readonly port: number
  readonly firstBoot: Promise<DevBoot>
  readonly stopRequested: Promise<void>
  private resolveFirstBoot!: (boot: DevBoot) => void
  private resolveStopRequested!: () => void
  private child: ChildProcess | null = null
  private boot: DevBoot | null = null
  private subscriptions: AsyncSubscription[] = []
  private debounce: ReturnType<typeof setTimeout> | null = null
  private restartRunning = false
  private restartAgain = false
  private reloadLauncher = false
  private crashAttempts = 0
  private crashStableTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private stopping: ChildProcess | null = null
  private childPort: number | undefined
  private browserRestart: Promise<RestartResult> | null = null
  private readonly cwd: string
  private readonly parentEnv: NodeJS.ProcessEnv
  private readonly roots: string[]
  private readonly watchEnabled: boolean
  private readonly childEnvironment: () => NodeJS.ProcessEnv
  private readonly debounceMs: number
  private readonly childEntry: string
  private readonly childEntryProvider?: () => string
  private readonly childLaunchProvider?: () => { entry: string; environment: NodeJS.ProcessEnv }
  private readonly childArgs: string[]
  private readonly watchSubscribe: NonNullable<DevSupervisorOptions["watchSubscribe"]>
  private readonly reexec: DevSupervisorOptions["reexec"]
  private readonly supervisorLock: string | null
  private readonly statusPublisherToken = randomUUID()
  private readonly processGeneration = currentProcessGeneration()
  private readonly ownerToken: string
  private readonly launchTarget: ProjectLaunchTarget
  private readonly logLine: (line: string) => void
  private readonly errorLine: (line: string) => void
  private readonly publicProxy: RestartSupervisorProxy
  private readonly updateRestart?: () => Promise<RestartResult>
  private readonly rollbackUpdate?: () => Promise<void> | void
  private readonly durableReexec?: () => Promise<void> | void
  /** Environment of the generation that actually reached ready, never merely the latest pointer. */
  private activeChildEnvironment: NodeJS.ProcessEnv = {}
  private lastRestartFailure: string | undefined

  constructor(opts: DevSupervisorOptions) {
    const launchOwner = verifyProjectLaunchDelegate(opts.launchTarget, opts.launchOwnerToken)
    const callerGeneration = currentProcessGeneration()
    if (
      launchOwner.pid !== callerGeneration.pid ||
      launchOwner.processStart !== callerGeneration.processStart
    ) throw new Error("dev supervisor caller is not the exact project launch owner")
    this.port = opts.port
    this.launchTarget = opts.launchTarget
    this.cwd = resolve(opts.cwd ?? opts.launchTarget.projectDir)
    if (this.cwd !== opts.launchTarget.projectDir) throw new Error("dev supervisor cwd does not match its owned project")
    this.parentEnv = projectLaunchEnvironment(opts.env ?? process.env, opts.launchTarget, opts.launchOwnerToken)
    this.roots = (opts.watchRoots ?? defaultDevWatchRoots()).map((root) => resolve(root))
    this.watchEnabled = opts.watch !== false
    this.childEnvironment = opts.childEnvironment ?? (() => ({}))
    this.debounceMs = opts.debounceMs ?? DEV_RESTART_DEBOUNCE_MS
    this.childEntry = opts.childEntry ?? fileURLToPath(new URL("./dev-bootstrap.ts", import.meta.url))
    this.childEntryProvider = opts.childEntryProvider
    this.childLaunchProvider = opts.childLaunchProvider
    this.childArgs = opts.childArgs ?? []
    this.watchSubscribe = opts.watchSubscribe ?? ((root, callback, options) => watcher.subscribe(root, callback, options))
    this.reexec = opts.reexec ?? (typeof process.execve === "function"
      ? (request) => process.execve!(request.executable, request.argv, request.env)
      : undefined)
    if (opts.stateDir && resolve(opts.stateDir) !== opts.launchTarget.stateDir) {
      throw new Error("dev supervisor state directory does not match its owned project")
    }
    this.supervisorLock = resolve(opts.launchTarget.stateDir, "dev-supervisor.lock")
    this.ownerToken = opts.launchOwnerToken
    this.logLine = opts.log ?? ((line) => console.log(line))
    this.errorLine = opts.error ?? ((line) => console.error(line))
    this.updateRestart = opts.updateRestart
    this.rollbackUpdate = opts.rollbackUpdate
    this.durableReexec = opts.durableReexec
    this.publicProxy = new RestartSupervisorProxy({
      port: opts.port,
      childPort: () => this.childPort,
      restart: () => this.restartFromBrowser(),
      updateRestart: this.updateRestart ? () => this.updateFromBrowser() : undefined,
      status: () => {
        if (this.browserRestart || this.restartRunning) return { state: "restarting" as const }
        const failed = this.child === null && this.boot === null
        const artifactDigest = this.activeChildEnvironment.FRAY_STABLE_ARTIFACT
        return failed
          ? { state: "failed" as const, message: "Fray application server is not ready", ...(artifactDigest ? { artifactDigest } : {}) }
          : { state: "ready" as const, ...(artifactDigest ? { artifactDigest } : {}) }
      },
    })
    this.firstBoot = new Promise<DevBoot>((resolveFirstBoot) => {
      this.resolveFirstBoot = resolveFirstBoot
    })
    this.stopRequested = new Promise<void>((resolveStopRequested) => {
      this.resolveStopRequested = resolveStopRequested
    })
  }

  currentBoot(): DevBoot | null {
    return this.boot
  }

  async start(): Promise<void> {
    if (this.supervisorLock) {
      mkdirSync(dirname(this.supervisorLock), { recursive: true })
      this.writeStatus("starting", "watcher initializing")
    }

    try {
      await this.publicProxy.listen()
      if (this.watchEnabled) {
        const settled = await Promise.allSettled(
          this.roots.filter(existsSync).map((root) => this.watchSubscribe(root, (err, events) => this.onWatch(err, events), {
            ignore: DEV_WATCH_IGNORE,
          })),
        )
        for (const result of settled) {
          if (result.status === "fulfilled") this.subscriptions.push(result.value)
          else this.errorLine(`[fray-ui] dev watch failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`)
        }
        if (this.subscriptions.length === 0) throw new Error("no Fray server source tree could be watched")
      }
    } catch (err) {
      await this.publicProxy.close().catch(() => undefined)
      this.removeStatus()
      throw err
    }

    this.requestRestart("initial boot", true)
  }

  private onWatch(err: Error | null, events: WatchEvent[]): void {
    if (err) {
      this.errorLine(`[fray-ui] dev watch error: ${err.message}`)
      this.writeStatus("degraded", `watch error: ${err.message}`)
      return
    }
    let relevant: WatchEvent | undefined
    let kind: DevChangeKind | null = null
    const configPaths = new Set<string>()
    for (const event of events) {
      const candidate = classifyDevChange(event.path, this.roots)
      if (!candidate) continue
      configPaths.add(event.path)
      if (candidate === "launcher") {
        if (kind !== "launcher") relevant = event
        kind = "launcher"
      } else if (!kind) {
        relevant = event
        kind = "child"
      }
    }
    if (relevant && kind) {
      for (const path of configPaths) {
        const syntaxError = devConfigSyntaxError(path)
        if (!syntaxError) continue
        const message = `dev config invalid: ${syntaxError}; watching for a corrective edit`
        this.errorLine(`[fray-ui] dev ${message}`)
        this.writeStatus("failed", message)
        return
      }
      // A source edit is an explicit corrective generation, not another attempt in the prior crash run.
      this.crashAttempts = 0
      this.requestRestart(relative(workspaceDir, relevant.path), false, kind === "launcher")
    }
  }

  private requestRestart(reason: string, immediate = false, reloadLauncher = false, delayMs = this.debounceMs): void {
    if (this.closed) return
    this.reloadLauncher ||= reloadLauncher
    if (this.debounce) clearTimeout(this.debounce)
    const run = () => {
      this.debounce = null
      const scope = this.reloadLauncher ? "control plane + launcher" : "control plane"
      this.logLine(`[fray-ui] dev ${scope} restarting (${reason})`)
      this.writeStatus("restarting", reason)
      void this.restart()
    }
    if (immediate) run()
    else this.debounce = setTimeout(run, delayMs)
  }

  private async restart(): Promise<void> {
    if (this.restartRunning) {
      this.restartAgain = true
      return
    }
    this.restartRunning = true
    try {
      let shouldReloadLauncher = false
      do {
        this.restartAgain = false
        shouldReloadLauncher ||= this.reloadLauncher
        this.reloadLauncher = false
        await this.stopChild()
        if (!this.closed) {
          const ready = await this.spawnChild()
          // Keep the old watcher alive after a syntax/import/start failure. The next relevant edit is
          // another retry; crucially, a broken launcher never strands the running shell with no watcher.
          if (!ready) return
        }
      } while (this.restartAgain && !this.closed)
      if (shouldReloadLauncher && !this.closed) await this.reexecLauncher()
    } finally {
      this.restartRunning = false
    }
  }

  /** Called only by the public supervisor control endpoint, never by ordinary document reloads. */
  private restartFromBrowser(): Promise<RestartResult> {
    if (this.browserRestart) return this.browserRestart
    const previousBoot = this.boot?.bootId
    const work = (async (): Promise<RestartResult> => {
      this.lastRestartFailure = undefined
      this.requestRestart("Restart Fray requested from browser", true)
      const deadline = Date.now() + 30_000
      while (!this.closed && Date.now() < deadline) {
        const boot = this.boot
        if (boot && (!previousBoot || boot.bootId !== previousBoot)) return { state: "ready" }
        if (this.lastRestartFailure) {
          this.writeStatus("failed", this.lastRestartFailure, null)
          return { state: "failed", message: this.lastRestartFailure }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
      const message = this.closed
        ? "Fray supervisor stopped while restarting"
        : "Fray application server did not become ready within 30 seconds"
      this.writeStatus("failed", message)
      return { state: "failed", message }
    })().finally(() => { this.browserRestart = null })
    this.browserRestart = work
    return work
  }

  private async updateFromBrowser(): Promise<RestartResult> {
    if (!this.updateRestart) return { state: "failed", message: "Update & Restart is unavailable in this launcher mode" }
    // The candidate is built and validated while the known-good child stays live. Only a successful
    // candidate reaches the controlled restart path, so a failed build never takes the board down.
    const candidate = await this.updateRestart()
    if (candidate.state !== "ready") return candidate
    if (!this.durableReexec) {
      return this.failDurableUpdate(
        "Update & Restart requires a durable supervisor handoff; the current supervisor was left running",
        false,
      )
    }
    // The child must be cleanly drained before exec.  The owner token, project database, tmux
    // server and provider sessions are not child resources and deliberately survive this handoff.
    let handoffPreparationStarted = false
    try {
      handoffPreparationStarted = true
      await this.prepareDurableReexec()
      await this.durableReexec()
      return this.failDurableUpdate("durable supervisor handoff returned unexpectedly", true)
    } catch (error) {
      const message = `durable supervisor handoff failed: ${error instanceof Error ? error.message : error}`
      return this.failDurableUpdate(message, handoffPreparationStarted)
    }
  }

  /**
   * A promoted pointer is not committed until its durable owner has actually been replaced.  If
   * that handoff cannot happen, put the previous pointer back before reporting the failure.  When
   * draining has already started, rebuild this same owner in place so a thrown/injected exec does
   * not leave a lease-holding but closed supervisor behind.
   */
  private async failDurableUpdate(message: string, restoreSupervisor: boolean): Promise<RestartResult> {
    const failures: string[] = []
    if (!this.rollbackUpdate) {
      failures.push("rollback callback is unavailable")
    } else {
      try {
        await this.rollbackUpdate()
      } catch (error) {
        failures.push(`rollback failed: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (restoreSupervisor) {
      try {
        await this.restoreAfterFailedDurableUpdate()
      } catch (error) {
        failures.push(`supervisor recovery failed: ${error instanceof Error ? error.message : error}`)
      }
    }

    const detail = failures.length > 0 ? `${message}; ${failures.join("; ")}` : message
    this.errorLine(`[fray-ui] ${detail}`)
    this.writeStatus("failed", detail, this.boot)
    return { state: "failed", message: detail }
  }

  /** Restore this exact lease-owning supervisor after prepare/re-exec failed before replacement. */
  private async restoreAfterFailedDurableUpdate(): Promise<void> {
    this.closed = false
    await this.publicProxy.listen()
    const ready = await this.spawnChild()
    if (!ready) throw new Error("the recovered control plane did not become ready")
  }

  private async prepareDurableReexec(): Promise<void> {
    this.closed = true
    this.clearCrashStability()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await Promise.allSettled(this.subscriptions.map((sub) => sub.unsubscribe()))
    this.subscriptions = []
    await this.stopChild()
    // Do not release the tokenized project lease or delete the owner status.  exec replaces this
    // PID; the successor proves and adopts that exact lease before it opens a replacement proxy.
    await this.publicProxy.close()
    this.writeStatus("restarting", "immutable artifact promoted; re-executing durable supervisor", null)
  }

  private async spawnChild(): Promise<boolean> {
    const privatePort = await allocatePrivateDevPort(this.port)
    let launch: { entry: string; environment: NodeJS.ProcessEnv } | undefined
    try {
      launch = this.childLaunchProvider?.()
    } catch (error) {
      const message = `child launch selection failed: ${error instanceof Error ? error.message : error}; watching for a corrective edit`
      this.lastRestartFailure = message
      this.errorLine(`[fray-ui] ${message}`)
      this.writeStatus("failed", message, null)
      return false
    }
    return new Promise((settled) => {
      if (this.closed) return settled(false)
      let child: ChildProcess
      try {
        child = fork(launch?.entry ?? this.childEntryProvider?.() ?? this.childEntry, this.childArgs, {
          cwd: this.cwd,
          env: devChildEnv({ ...this.parentEnv, ...(launch?.environment ?? this.childEnvironment()) }, privatePort),
          // The supervisor may itself run under `node --input-type`, `--test`, an inspector, etc. Those
          // parent-only flags are invalid or dangerous for a file-backed control-plane child.
          execArgv: [],
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        })
      } catch (error) {
        const message = `child spawn failed: ${error instanceof Error ? error.message : error}; watching for a corrective edit`
        this.lastRestartFailure = message
        this.errorLine(`[fray-ui] ${message}`)
        this.writeStatus("failed", message, null)
        settled(false)
        return
      }
      this.child = child
      this.childPort = privatePort
      this.boot = null
      let started = false
      let ownershipRejected = false
      let spawnSettled = false
      const settleSpawn = (ready: boolean) => {
        if (spawnSettled) return
        spawnSettled = true
        settled(ready)
      }

      child.on("message", (message) => {
        if (stopOwnerMessage(message) && message.token === this.ownerToken) {
          this.resolveStopRequested()
          return
        }
        if (!readyMessage(message) || child !== this.child) return
        const owner = readProjectLaunchOwner(this.launchTarget.stateDir)
        if (
          !owner ||
          owner.token !== this.ownerToken ||
          owner.projectId !== this.launchTarget.projectId ||
          owner.projectDir !== this.launchTarget.projectDir ||
          message.pid !== child.pid ||
          message.port !== privatePort ||
          !projectLaunchRecordHasGeneration(owner, { pid: message.pid, processStart: message.processStart })
        ) {
          const detail = "control plane reported ready without a registered owner-bound generation"
          ownershipRejected = true
          this.errorLine(`[fray-ui] dev ${detail}`)
          this.writeStatus("failed", detail)
          child.kill("SIGTERM")
          settleSpawn(false)
          return
        }
        started = true
        const boot = { pid: message.pid, port: this.port, bootId: message.bootId }
        this.boot = boot
        this.activeChildEnvironment = launch?.environment ?? this.childEnvironment()
        this.lastRestartFailure = undefined
        this.resolveFirstBoot(boot)
        this.logLine(`[fray-ui] dev control plane ready (pid ${boot.pid}, boot ${boot.bootId.slice(0, 8)})`)
        this.writeStatus("ready", "control plane ready", boot)
        this.armCrashStability(child)
        settleSpawn(true)
      })
      child.once("error", (err) => {
        const message = `child spawn failed: ${err.message}; watching for a corrective edit`
        this.lastRestartFailure = message
        this.errorLine(`[fray-ui] ${message}`)
        this.writeStatus("failed", message)
        settleSpawn(false)
      })
      child.once("exit", (code, signal) => {
        if (this.child === child) {
          this.child = null
          this.childPort = undefined
          this.boot = null
          this.activeChildEnvironment = {}
        }
        const expected = this.closed || this.stopping === child || ownershipRejected
        this.clearCrashStability()
        if (!expected) {
          const why = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`
          const retryDelay = started ? devCrashRetryDelay(++this.crashAttempts) : 0
          const message = started
            ? `control plane stopped (${why}); retry ${this.crashAttempts} in ${retryDelay}ms`
            : `control plane stopped (${why}) before ready; watching for a corrective edit`
          if (!started) this.lastRestartFailure = message
          this.errorLine(`[fray-ui] dev ${message}`)
          this.writeStatus("failed", message)
          // A previously-ready control plane crash is transient until proved otherwise. Restart it;
          // pre-ready syntax/import failures stay quiet under the healthy old watcher until an edit.
          if (started) this.requestRestart("unexpected control-plane exit", false, false, retryDelay)
        }
        if (this.stopping === child) this.stopping = null
        settleSpawn(false)
      })
    })
  }

  private writeStatus(state: "starting" | "restarting" | "ready" | "failed" | "degraded", message: string, boot = this.boot): void {
    if (!this.supervisorLock) return
    try {
      writeProjectStatus(this.supervisorLock, {
        pid: this.processGeneration.pid,
        processStart: this.processGeneration.processStart,
        publisherToken: this.statusPublisherToken,
        ownerToken: this.ownerToken,
        projectId: this.launchTarget.projectId,
        projectDir: this.launchTarget.projectDir,
        port: this.port,
        cwd: this.cwd,
        state,
        message,
        updatedAt: new Date().toISOString(),
        ...(this.activeChildEnvironment.FRAY_STABLE_ARTIFACT ? { artifactDigest: this.activeChildEnvironment.FRAY_STABLE_ARTIFACT } : {}),
        ...(boot ? { childPid: boot.pid, bootId: boot.bootId } : {}),
      })
    } catch (err) {
      this.errorLine(`[fray-ui] could not write dev status: ${err instanceof Error ? err.message : err}`)
    }
  }

  private removeStatus(): void {
    if (!this.supervisorLock) return
    removeProjectStatus(this.supervisorLock, {
      pid: this.processGeneration.pid,
      processStart: this.processGeneration.processStart,
      publisherToken: this.statusPublisherToken,
      ownerToken: this.ownerToken,
    })
  }

  private armCrashStability(child: ChildProcess): void {
    this.clearCrashStability()
    this.crashStableTimer = setTimeout(() => {
      this.crashStableTimer = null
      if (this.child === child) this.crashAttempts = 0
    }, DEV_CRASH_STABLE_MS)
    this.crashStableTimer.unref()
  }

  private clearCrashStability(): void {
    if (this.crashStableTimer) clearTimeout(this.crashStableTimer)
    this.crashStableTimer = null
  }

  private async reexecLauncher(): Promise<void> {
    if (!this.reexec) {
      const message = "launcher source changed, but this Node runtime cannot re-exec; restart Fray once"
      this.errorLine(`[fray-ui] ${message}`)
      this.writeStatus("degraded", message)
      return
    }
    this.logLine(`[fray-ui] dev launcher validated; reloading in place (pid ${process.pid})`)
    this.closed = true
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await Promise.allSettled(this.subscriptions.map((sub) => sub.unsubscribe()))
    this.subscriptions = []
    await this.stopChild()
    // Keep the same-PID launch owner across execve. This replaceable status is only observability;
    // the tokenized owner remains authoritative while the new executable validates and republishes.
    this.writeStatus("restarting", "launcher validated; reloading parent in place", null)
    try {
      this.reexec({ executable: process.execPath, argv: process.argv, env: devReexecEnv(this.parentEnv) })
    } catch (error) {
      this.errorLine(`[fray-ui] dev launcher re-exec failed: ${error instanceof Error ? error.message : error}`)
    }
    // execve never returns. A failed/injected return must release ownership through the caller's one
    // shutdown path; otherwise this live but watcherless PID would strand the project indefinitely.
    this.removeStatus()
    this.errorLine("[fray-ui] dev launcher re-exec returned unexpectedly; restart Fray once")
    this.resolveStopRequested()
  }

  private async stopChild(): Promise<void> {
    this.clearCrashStability()
    const child = this.child
    if (!child) return
    this.stopping = child
    await new Promise<void>((resolveStop) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(force)
        resolveStop()
      }
      child.once("exit", finish)
      const force = setTimeout(() => {
        this.errorLine(`[fray-ui] dev child ${child.pid ?? "?"} did not close in ${CHILD_STOP_TIMEOUT_MS}ms; killing control plane only`)
        child.kill("SIGKILL")
      }, CHILD_STOP_TIMEOUT_MS)
      force.unref()
      if (!child.kill("SIGTERM")) finish()
    })
    if (this.child === child) this.child = null
    if (this.childPort !== undefined) this.childPort = undefined
    if (this.stopping === child) this.stopping = null
    this.boot = null
    this.activeChildEnvironment = {}
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearCrashStability()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await Promise.allSettled(this.subscriptions.map((sub) => sub.unsubscribe()))
    this.subscriptions = []
    await this.stopChild()
    await this.publicProxy.close()
    this.removeStatus()
  }
}

export async function startDevSupervisor(opts: DevSupervisorOptions): Promise<DevSupervisor> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error(`invalid dev supervisor port: ${opts.port}`)
  const supervisor = new Supervisor(opts)
  await supervisor.start()
  return supervisor
}

/** Loaded by every disposable generation so supervisor-module edits are compile/start validated. */
export async function runDevControlPlaneChild(): Promise<void> {
  await import("./dev-child.ts")
}
