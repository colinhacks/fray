import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireGlobalLaunchLock,
  pidIsAlive,
  resolveGitProjectIdentity,
  type GitProjectIdentityScope,
} from "@fray-ui/server/project-identity";
import {
  defaultProcessPlatformAdapter,
  processGenerationIsStale,
  projectLaunchRecordHasGeneration,
  projectLaunchTokenProof,
  readProjectLaunchOwner,
  type ProjectLaunchOwnerRecord,
  type ProjectLaunchTarget,
  type ProcessPlatformAdapter,
} from "@fray-ui/server/project-launch";
import { resolveProjectTmuxSocketSelection } from "@fray-ui/server/tmux-socket";
import { DEFAULT_PORT } from "@fray-ui/shared";

export { acquireGlobalLaunchLock, pidIsAlive };

/**
 * Run project-local launch preparation before entering the machine-global port/start critical
 * section. Keeping this sequencing here makes it testable without starting a real supervisor.
 */
export async function prepareBeforeGlobalLaunchLock<T>(
  prepare: () => T | Promise<T>,
  acquire: () => Promise<() => void> = () => acquireGlobalLaunchLock()
): Promise<{ prepared: T; release: () => void }> {
  const prepared = await prepare();
  return { prepared, release: await acquire() };
}

export interface CliOptions {
  noApp: boolean;
  appMode: boolean;
  foreground: boolean;
  stop: boolean;
  status: boolean;
  help: boolean;
  /** Deliberately unsafe source/HMR control plane, never selected implicitly. */
  dev: boolean;
  port?: number;
  /** Optional Git repository to serve. Defaults to the caller's current directory. */
  repoPath?: string;
}

export interface Workspace {
  root: string;
  id: string;
  stateDir: string;
  name: string;
  identityScope: GitProjectIdentityScope;
  tmuxSocket: string;
  tmuxSocketManaged: boolean;
}

export interface LauncherStatus {
  pid: number;
  port: number;
  processStart?: string;
  publisherToken?: string;
  ownerToken?: string;
  state?: string;
  message?: string;
  childPid?: number;
  projectId?: string;
  projectDir?: string;
  artifactDigest?: string;
}

export interface FrayHealth {
  ok: true;
  projectId: string;
  projectDir: string;
  bootId: string;
  ownerProof?: string;
}

export interface ExpectedFrayHealth {
  projectId: string;
  projectDir: string;
  ownerProof?: string;
}

export const PORT_SCAN_COUNT = 100;
export const LAUNCH_TIMEOUT_MS = 30_000;
/** A first immutable artifact build can legitimately outlast the ordinary server-ready timeout. */
export const FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS = 120_000;

export function parseCliArgs(argv: string[]): CliOptions {
  const args = new Set(argv);
  let rawPort: string | undefined;
  let repoPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--port") {
      rawPort = argv[++index];
      if (rawPort === undefined || rawPort.startsWith("-"))
        throw new Error("--port requires a value");
      continue;
    }
    if (arg.startsWith("--port=")) {
      rawPort = arg.slice("--port=".length);
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (repoPath !== undefined)
      throw new Error("provide at most one repository path");
    repoPath = arg;
  }
  let port: number | undefined;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`invalid --port value: ${rawPort}`);
  }
  const known = new Set([
    "--app",
    "--no-app",
    "--foreground",
    "--detach",
    "--stop",
    "--status",
    "--help",
    "-h",
    "--dev",
    "--prod",
    "--port",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--port") {
      index++;
      continue;
    }
    if (arg.startsWith("--port=")) continue;
    if (!arg.startsWith("-") && arg === repoPath) continue;
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
  }
  if (args.has("--detach"))
    throw new Error("--detach is no longer available; fray-dev always runs in the foreground");
  if (args.has("--app") && args.has("--no-app"))
    throw new Error("choose either --app or --no-app");
  return {
    noApp: args.has("--no-app"),
    appMode: args.has("--app"),
    // Retain the option in the parsed shape for callers, but normal fray-dev is always attached.
    foreground: true,
    stop: args.has("--stop"),
    status: args.has("--status"),
    help: args.has("--help") || args.has("-h"),
    dev: args.has("--dev"),
    port,
    repoPath,
  };
}

export function helpText(command = "fray-dev"): string {
  return `Fray source launcher

Usage: ${command} [options] [repository]

Run from any Git repository, or pass an explicit repository path. Fray serves a verified immutable artifact
for that workspace, automatically selecting or safely building one on first launch, then opens it in your default browser;
source edits never restart the shared board.

Options:
  --app                use the legacy dedicated app window instead of a browser tab
  --no-app             print the URL without opening a browser
  --foreground         accepted for compatibility; fray-dev always runs in the foreground
  --dev                explicitly use the unsafe source watcher and Vite/HMR instead of an immutable artifact
  --port <port>        request a fixed port for a new workspace server
  --status             report this workspace's stable server and artifact
  --stop               stop this workspace's UI supervisor (tmux agents keep running)
  -h, --help           show this help

Commands:
  build                 build a new immutable candidate from the configured Fray source checkout
  promote <digest>      explicitly select a verified candidate for this workspace
  restart               restart the currently promoted artifact without building

An immutable artifact is the default. --dev is the only explicit unsafe source watcher/HMR mode.
`;
}

export function resolveWorkspace(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  let gitRoot: string;
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `fray-dev must be run inside a Git repository (cwd: ${cwd})`
    );
  }
  const identity = resolveGitProjectIdentity(realpathSync(gitRoot), home);
  const root = identity.root;
  const id = identity.id;
  const stateDir = join(home, ".fray", "projects", id);
  mkdirSync(stateDir, { recursive: true });
  const target = {
    projectId: id,
    projectDir: root,
    stateDir,
    ...(identity.scope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
  const selected = resolveProjectTmuxSocketSelection(target, {
    repositoryOverride: env.FRAY_TMUX_SOCKET,
  });
  return {
    root,
    id,
    stateDir,
    name: basename(root),
    identityScope: identity.scope,
    tmuxSocket: selected.socket,
    tmuxSocketManaged: selected.managed,
  };
}

export function workspaceLaunchTarget(
  workspace: Workspace
): ProjectLaunchTarget {
  return {
    projectId: workspace.id,
    projectDir: workspace.root,
    stateDir: workspace.stateDir,
    tmuxSocket: workspace.tmuxSocket,
    tmuxSocketManaged: workspace.tmuxSocketManaged,
    ...(workspace.identityScope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
}

export function workspaceFromLaunchTarget(
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  let root: string;
  try {
    root = realpathSync(target.projectDir);
  } catch {
    throw new Error("pinned Fray workspace is no longer available");
  }
  if (root !== target.projectDir)
    throw new Error("pinned Fray workspace path is not canonical");
  const selected = target.tmuxSocket
    ? { socket: target.tmuxSocket, managed: target.tmuxSocketManaged !== false }
    : resolveProjectTmuxSocketSelection(target, {
        repositoryOverride: env.FRAY_TMUX_SOCKET,
      });
  return {
    root,
    id: target.projectId,
    stateDir: target.stateDir,
    name: basename(root),
    identityScope:
      target.identityScope === "worktree" ? "worktree" : "repository",
    tmuxSocket: selected.socket,
    tmuxSocketManaged: selected.managed,
  };
}

function parseStatusFile(
  path: string,
  authoritative?: ProjectLaunchOwnerRecord | null,
  expected?: ProjectLaunchTarget,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter
): LauncherStatus | null {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<LauncherStatus>;
    if (
      !Number.isInteger(value.pid) ||
      value.pid! <= 0 ||
      !Number.isInteger(value.port) ||
      value.port! < 1 ||
      value.port! > 65_535
    )
      return null;
    if (authoritative) {
      const generation = { pid: value.pid!, processStart: value.processStart! };
      if (
        typeof value.processStart !== "string" ||
        value.ownerToken !== authoritative.token ||
        value.projectId !== authoritative.projectId ||
        value.projectDir !== authoritative.projectDir ||
        (expected &&
          (value.projectId !== expected.projectId ||
            value.projectDir !== expected.projectDir)) ||
        !projectLaunchRecordHasGeneration(authoritative, generation) ||
        processGenerationIsStale(generation, adapter)
      )
        return null;
    } else if (typeof value.processStart === "string") {
      if (
        processGenerationIsStale(
          { pid: value.pid!, processStart: value.processStart },
          adapter
        )
      )
        return null;
    } else if (!pidIsAlive(value.pid)) return null; // read-only compatibility with pre-owner status
    return value as LauncherStatus;
  } catch {
    return null;
  }
}

export function liveWorkspaceOwner(
  stateDir: string,
  expected?: ProjectLaunchTarget,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter
): LauncherStatus | null {
  const authoritative = readProjectLaunchOwner(stateDir);
  if (
    authoritative &&
    expected &&
    (authoritative.projectId !== expected.projectId ||
      authoritative.projectDir !== expected.projectDir)
  )
    return null;
  if (authoritative?.state === "draining") return null;
  if (authoritative && processGenerationIsStale(authoritative, adapter))
    return null;
  // The supervisor is the durable owner; server.lock belongs to its disposable child.
  return (
    parseStatusFile(
      join(stateDir, "dev-supervisor.lock"),
      authoritative,
      expected,
      adapter
    ) ??
    parseStatusFile(
      join(stateDir, "server.lock"),
      authoritative,
      expected,
      adapter
    )
  );
}

// A config validation failure deliberately leaves the prior healthy child serving while the durable
// watcher waits for a corrective edit. Health alone therefore cannot make `fray-dev --status` green: the
// supervisor lock is the authoritative signal that the newest generation needs attention.
export function supervisorNeedsAttention(
  owner: LauncherStatus | null
): boolean {
  return owner?.state === "failed" || owner?.state === "degraded";
}

export function readPreferredPort(stateDir: string): number | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(stateDir, "launcher.json"), "utf8")
    ) as { port?: unknown };
    return Number.isInteger(value.port) &&
      (value.port as number) > 0 &&
      (value.port as number) <= 65535
      ? (value.port as number)
      : undefined;
  } catch {
    return undefined;
  }
}

export function persistLauncher(
  workspace: Workspace,
  port: number,
  sourceDir: string
): void {
  writeFileSync(
    join(workspace.stateDir, "launcher.json"),
    JSON.stringify(
      {
        projectId: workspace.id,
        projectDir: workspace.root,
        port,
        sourceDir: realpathSync(sourceDir),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

export async function probeFray(
  port: number,
  expected: ExpectedFrayHealth,
  fetcher: typeof fetch = fetch
): Promise<FrayHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  timeout.unref?.();
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const health = (await response.json()) as Partial<FrayHealth>;
    if (
      health.ok !== true ||
      typeof health.projectId !== "string" ||
      typeof health.projectDir !== "string" ||
      typeof health.bootId !== "string"
    )
      return null;
    if (
      health.projectId !== expected.projectId ||
      health.projectDir !== expected.projectDir
    )
      return null;
    if (
      expected.ownerProof !== undefined &&
      health.ownerProof !== expected.ownerProof
    )
      return null;
    return health as FrayHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestFrayStop(
  port: number,
  expected: ExpectedFrayHealth,
  ownerToken: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (!(await probeFray(port, expected, fetcher))) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  timeout.unref?.();
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/control/stop`, {
      method: "POST",
      headers: { "x-fray-launch-token": ownerToken },
      signal: controller.signal,
    });
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function expectedOwnerHealth(
  target: ProjectLaunchTarget,
  owner: ProjectLaunchOwnerRecord | null
): ExpectedFrayHealth {
  return {
    projectId: target.projectId,
    projectDir: target.projectDir,
    ...(owner
      ? { ownerProof: projectLaunchTokenProof(target, owner.token) }
      : {}),
  };
}

export async function canBindPort(port: number): Promise<boolean> {
  const bind = (candidate: number) =>
    new Promise<boolean>((resolveBind) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolveBind(false));
      server.listen(candidate, "127.0.0.1", () =>
        server.close(() => resolveBind(true))
      );
    });
  return bind(port);
}

export async function choosePort(
  explicit: number | undefined,
  preferred: number | undefined,
  available = canBindPort
): Promise<number> {
  if (explicit !== undefined) {
    if (!(await available(explicit)))
      throw new Error(`port ${explicit} is already in use`);
    return explicit;
  }
  const candidates = [
    preferred,
    ...Array.from(
      { length: PORT_SCAN_COUNT },
      (_, index) => DEFAULT_PORT + index
    ),
  ];
  for (const port of candidates) {
    if (port && port <= 65535 && (await available(port))) return port;
  }
  throw new Error(
    `no free Fray development port found in ${DEFAULT_PORT}-${
      DEFAULT_PORT + PORT_SCAN_COUNT - 1
    }`
  );
}

export async function waitForWorkspace(
  port: number,
  expected: ExpectedFrayHealth,
  timeoutMs = LAUNCH_TIMEOUT_MS
): Promise<FrayHealth> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeFray(port, expected);
    if (health) return health;
    await delay(150);
  }
  throw new Error(
    `Fray did not become healthy on port ${port} within ${Math.ceil(
      timeoutMs / 1000
    )}s`
  );
}

export function sourceWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  // A durable artifact re-exec runs its deployed CLI from ~/.fray/builds, not this checkout.
  // Preserve the original canonical checkout explicitly so Update & Restart continues to build
  // from the source the operator launched, rather than treating the artifact cache as source.
  return env.FRAY_SOURCE_DIR
    ? resolve(env.FRAY_SOURCE_DIR)
    : resolve(import.meta.dirname, "..", "..", "..");
}

export function sourceLabel(): string {
  return realpathSync(sourceWorkspaceDir());
}

export function logTail(stateDir: string, maxChars = 4000): string {
  try {
    const value = readFileSync(join(stateDir, "dev.log"), "utf8");
    return value.slice(-maxChars).trim();
  } catch {
    return "";
  }
}
