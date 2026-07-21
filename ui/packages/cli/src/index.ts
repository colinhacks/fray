#!/usr/bin/env node
import { join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import { StartupProgress } from "./startup-progress.ts";
import {
  buildFrayArtifact,
  assertArtifactHostCompatible,
  defaultArtifactRoot,
  ensureStableFrayArtifact,
  promoteFrayArtifact,
  readFrayArtifact,
  readStableArtifact,
} from "./artifacts.ts";
import { assertLaunchPrerequisites } from "./preflight.ts";
import {
  acquireGlobalLaunchLock,
  choosePort,
  expectedOwnerHealth,
  FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS,
  helpText,
  liveWorkspaceOwner,
  parseCliArgs,
  persistLauncher,
  probeFray,
  prepareBeforeGlobalLaunchLock,
  readPreferredPort,
  requestFrayStop,
  resolveWorkspace,
  sourceLabel,
  sourceWorkspaceDir,
  supervisorNeedsAttention,
  waitForWorkspace,
  workspaceFromLaunchTarget,
  workspaceLaunchTarget,
  type CliOptions,
  type Workspace,
} from "./launcher.ts";
import {
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  processGenerationIsStale,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
  verifyProjectLaunchDelegate,
  type ProjectLaunchLease,
} from "@fray-ui/server/project-launch";

function fail(error: unknown): never {
  console.error(`fray: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const sourceCommand = process.env.FRAY_SOURCE_COMMAND ?? "fray-dev";
const command = ["build", "promote", "restart"].includes(argv[0] ?? "")
  ? argv[0]
  : undefined;
let options: CliOptions;
try {
  options = parseCliArgs(
    command === "promote" ? argv.slice(2) : command ? argv.slice(1) : argv
  );
} catch (error) {
  fail(error);
}
if (options.help) {
  console.log(helpText(sourceCommand));
  process.exit(0);
}
if (argv.includes("--prod"))
  fail("--prod is not available from the source-backed development launcher");

const internalLaunch =
  process.env.FRAY_DIRECT_SUPERVISOR === "1" ||
  process.env.FRAY_DAEMON_CHILD === "1" ||
  process.env.FRAY_DEV_REEXEC === "1" ||
  process.env.FRAY_DEV_CHILD === "1";
const startupProgress =
  !internalLaunch &&
  !options.stop &&
  !options.status &&
  command !== "restart" &&
  command !== "promote"
    ? new StartupProgress()
    : undefined;
startupProgress?.phase(
  options.dev ? "Preparing source development server" : "Preparing Fray startup"
);

let workspace: Workspace;
try {
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  const internal =
    process.env.FRAY_DEV_CHILD === "1" ||
    process.env.FRAY_DIRECT_SUPERVISOR === "1" ||
    process.env.FRAY_DAEMON_CHILD === "1" ||
    process.env.FRAY_DEV_REEXEC === "1";
  if (internal && !pinned)
    throw new Error("internal launch is missing its pinned project identity");
  workspace = internal
    ? workspaceFromLaunchTarget(pinned!)
    : resolveWorkspace(options.repoPath);
} catch (error) {
  startupProgress?.fail(
    `Fray startup failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  fail(error);
}
process.chdir(workspace.root);
const expectedHealth = { projectId: workspace.id, projectDir: workspace.root };
const launchTarget = workspaceLaunchTarget(workspace);

// The supervisor validates every generation by forking this same source entry with a private marker.
// That disposable child boots only the HTTP/Vite control plane; it must never recursively supervise.
if (process.env.FRAY_DEV_CHILD === "1") {
  const token = projectLaunchOwnerTokenFromEnvironment(process.env);
  if (!token) throw new Error("dev child is missing project launch ownership");
  verifyProjectLaunchDelegate(workspaceLaunchTarget(workspace), token);
  const { runDevControlPlaneChild } = await import(
    "@fray-ui/server/dev-supervisor"
  );
  await runDevControlPlaneChild();
  await new Promise<never>(() => {});
}

async function runSupervisor(
  port: number,
  inheritedToken?: string | null,
  pinnedArtifactDigest?: string
): Promise<never> {
  // Keep build/promote/status/stop usable for repair on a partially provisioned machine, but never
  // let a control-plane server start when its mandatory local tools are unavailable.
  assertLaunchPrerequisites();
  const target = workspaceLaunchTarget(workspace);
  const token =
    inheritedToken ?? projectLaunchOwnerTokenFromEnvironment(process.env);
  if (!token) throw new Error("supervisor launch is missing project ownership");
  const launchOwner = adoptProjectLaunchOwner(target, token, "supervisor");
  const supervisorEnv = projectLaunchEnvironment(
    {
      ...process.env,
      FRAY_DIRECT_SUPERVISOR: "1",
    },
    target,
    launchOwner.token
  );
  const selectedArtifact = options.dev
    ? undefined
    : pinnedArtifactDigest ?? process.env.FRAY_STABLE_ARTIFACT
    ? readFrayArtifact(
        pinnedArtifactDigest ?? process.env.FRAY_STABLE_ARTIFACT!,
        defaultArtifactRoot()
      )
    : ensureStableFrayArtifact(
        workspace.stateDir,
        sourceWorkspaceDir(),
        defaultArtifactRoot()
      );
  if (selectedArtifact) assertArtifactHostCompatible(selectedArtifact);
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import(
    "@fray-ui/server/dev-supervisor"
  );
  let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>;
  const stableOptions = selectedArtifact
    ? (() => {
        let updateRollbackArtifact: typeof selectedArtifact | undefined;
        let firstChildLaunch = true;
        const selectedChildLaunch = () => {
          // The launcher selected this artifact before starting the foreground supervisor. The first control-plane child is
          // pinned to that verified digest even if source or the durable pointer changes while the
          // supervisor is coming up. Later authenticated restarts intentionally consult promotion.
          const artifact = firstChildLaunch
            ? selectedArtifact
            : readStableArtifact(workspace.stateDir, defaultArtifactRoot());
          firstChildLaunch = false;
          if (!artifact)
            throw new Error(
              "the currently promoted Fray artifact is missing or failed verification"
            );
          assertArtifactHostCompatible(artifact);
          return {
            entry: join(artifact.runtimeDir, "src", "index.js"),
            environment: {
              FRAY_STABLE_WEB_DIST: artifact.webDir,
              FRAY_STABLE_ARTIFACT: artifact.digest,
              FRAY_SCRIPTS_DIR: join(artifact.runtimeDir, "cc", "scripts", "fray"),
              // The bundled runtime resolves its worker plugin from the verified artifact closure.
              FRAY_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
            },
          };
        };
        return {
          childLaunchProvider: selectedChildLaunch,
          watch: false,
          updateRestart: async () => {
            // Build and verify before touching the healthy child. No source edit can enter this path.
            try {
              const current = readStableArtifact(
                workspace.stateDir,
                defaultArtifactRoot()
              );
              if (!current)
                throw new Error(
                  "the currently promoted Fray artifact is missing or failed verification"
                );
              const candidate = buildFrayArtifact(
                sourceWorkspaceDir(),
                defaultArtifactRoot()
              );
              updateRollbackArtifact = current;
              promoteFrayArtifact(
                workspace.stateDir,
                candidate.digest,
                defaultArtifactRoot()
              );
              return { state: "ready" as const };
            } catch (error) {
              return {
                state: "failed" as const,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          },
          rollbackUpdate: () => {
            if (!updateRollbackArtifact) return;
            promoteFrayArtifact(
              workspace.stateDir,
              updateRollbackArtifact.digest,
              defaultArtifactRoot()
            );
            updateRollbackArtifact = undefined;
          },
          ...(typeof process.execve === "function"
            ? {
                durableReexec: () => {
                  // Update & Restart promotes a complete deployed CLI/runtime, not merely the
                  // child HTTP entry. Replace this owner with that immutable CLI so
                  // server/supervisor fixes take effect too. The tokenized launch lease stays in
                  // the environment across execve; SQLite, tmux and provider-side sessions are
                  // project resources and are never copied or torn down for this handoff.
                  const artifact = readStableArtifact(
                    workspace.stateDir,
                    defaultArtifactRoot()
                  );
                  if (!artifact)
                    throw new Error(
                      "the promoted Fray artifact is missing or failed verification"
                    );
                  assertArtifactHostCompatible(artifact);
                  const env = projectLaunchEnvironment(
                    {
                      ...supervisorEnv,
                      FRAY_DEV_REEXEC: "1",
                      FRAY_SOURCE_DIR: sourceLabel(),
                      FRAY_STABLE_ARTIFACT: artifact.digest,
                    },
                    target,
                    launchOwner.token
                  );
                  delete env.FRAY_DEV_CHILD;
                  delete env.FRAY_DEV_PORT;
                  process.execve!(
                    process.execPath,
                    [
                      process.execPath,
                      join(artifact.runtimeDir, "src", "index.js"),
                      "--port",
                      String(port),
                      workspace.root,
                    ],
                    env
                  );
                },
              }
            : {}),
        };
      })()
    : {
        // --dev is intentionally the only route that can boot source plus Vite/HMR.
        watch: true,
      };
  try {
    supervisor = await startDevSupervisor({
      port,
      cwd: workspace.root,
      env: supervisorEnv,
      stateDir: workspace.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      ...stableOptions,
    });
  } catch (error) {
    launchOwner.release();
    throw error;
  }
  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    release: () => {
      launchOwner.release();
    },
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  persistLauncher(workspace, port, sourceWorkspaceDir());
  return await new Promise<never>(() => {});
}

// A legacy detached supervisor or durable re-exec re-enters here after launcher source changes. It must rebuild
// its watcher in-place without competing with its own global lock or trying to open another window.
if (
  process.env.FRAY_DIRECT_SUPERVISOR === "1" ||
  process.env.FRAY_DAEMON_CHILD === "1" ||
  process.env.FRAY_DEV_REEXEC === "1"
) {
  if (!options.port) fail("internal supervisor launch is missing --port");
  await runSupervisor(
    options.port,
    projectLaunchOwnerTokenFromEnvironment(process.env)
  );
}

if (command === "build") {
  try {
    startupProgress?.phase("Preparing immutable Fray artifact");
    const artifact = buildFrayArtifact(
      sourceWorkspaceDir(),
      defaultArtifactRoot(),
      { onProgress: (message) => startupProgress?.phase(message) }
    );
    startupProgress?.complete("Immutable Fray artifact is ready");
    console.log(`built Fray artifact ${artifact.digest}`);
    console.log(`web: ${artifact.webDir}`);
    process.exit(0);
  } catch (error) {
    startupProgress?.fail(
      `Immutable artifact build failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    fail(error);
  }
}

if (command === "promote") {
  try {
    const digest = argv[1];
    if (!digest) throw new Error("usage: fray-dev promote <artifact-digest>");
    const pointer = promoteFrayArtifact(
      workspace.stateDir,
      digest,
      defaultArtifactRoot()
    );
    console.log(
      `promoted Fray artifact ${pointer.current}${
        pointer.previous ? ` (rollback ${pointer.previous})` : ""
      }`
    );
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

async function existingHealth() {
  const ports = new Set<number>();
  const authoritative = readProjectLaunchOwner(workspace.stateDir);
  const owner = liveWorkspaceOwner(workspace.stateDir, launchTarget);
  if (
    authoritative &&
    (authoritative.state === "draining" ||
      processGenerationIsStale(authoritative))
  ) {
    return {
      port: undefined,
      health: null,
      owner: null,
      launchOwner: authoritative,
    };
  }
  const expected = expectedOwnerHealth(launchTarget, authoritative);
  if (owner) ports.add(owner.port);
  const preferred = readPreferredPort(workspace.stateDir);
  if (preferred) ports.add(preferred);
  for (const port of ports) {
    const health = await probeFray(port, expected);
    if (health) return { port, health, owner, launchOwner: authoritative };
  }
  return { port: undefined, health: null, owner, launchOwner: authoritative };
}

async function claimProjectLaunch(): Promise<
  ProjectLaunchLease | { reusePort: number }
> {
  const target = workspaceLaunchTarget(workspace);
  const deadline = Date.now() + 10_000;
  let lastOwner = readProjectLaunchOwner(workspace.stateDir);
  for (;;) {
    const attempt = tryAcquireProjectLaunchOwner(target, "launcher");
    if (attempt.kind === "acquired") return attempt.lease;
    lastOwner = attempt.owner ?? lastOwner;
    const existing = await existingHealth();
    if (existing.health && existing.port) return { reusePort: existing.port };
    if (Date.now() >= deadline) {
      const detail = lastOwner
        ? `${lastOwner.role} pid ${lastOwner.pid} owns startup but did not become ready`
        : "another launcher is still publishing project ownership";
      throw new Error(
        `${detail}; retry, inspect fray-dev --status, or stop the exact owner with fray-dev --stop`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function openOrPrint(port: number, reused: boolean): Promise<void> {
  const url = `http://127.0.0.1:${port}`;
  startupProgress?.clearLine();
  console.log(`${reused ? "reusing" : "started"} Fray for ${workspace.root}`);
  console.log(`source: ${sourceLabel()}`);
  if (options.noApp) console.log(url);
  else {
    startupProgress?.phase(
      options.appMode ? "Requesting Fray app window" : "Requesting default browser"
    );
    let opened: string;
    try {
      if (options.appMode) {
        await launchApp(url, {
          dataPath: join(workspace.stateDir, "browser-profile"),
        });
        opened = `${reused ? "focused" : "opened"} Fray app — ${url}`;
      } else {
        await launchBrowserTab(url);
        opened = `requested Fray in your default browser — ${url}`;
      }
    } catch {
      const target = options.appMode ? "Fray app window" : "default browser";
      opened = `Could not open the ${target}. Open manually: ${url}`;
    }
    // Clear the animated phase line before printing so the record never glues onto the spinner.
    startupProgress?.clearLine();
    console.log(opened);
  }
}

async function stopWorkspace(): Promise<void> {
  const target = launchTarget;
  const owner = readProjectLaunchOwner(workspace.stateDir);
  if (!owner) {
    console.log(`Fray is not running for ${workspace.root}`);
    return;
  }
  const status = liveWorkspaceOwner(workspace.stateDir, target);
  const healthy = status ? null : await existingHealth();
  const controlPort = status?.port ?? healthy?.port;
  const controlled = controlPort
    ? await requestFrayStop(
        controlPort,
        expectedOwnerHealth(target, owner),
        owner.token
      )
    : false;
  // Never turn a process-generation observation into a later PID signal: the PID can be recycled in
  // that gap. Live shutdown requires the owner token over HTTP/IPC. Proven-stale owners are recovered
  // below while registered children self-exit on supervisor IPC disconnect.
  if (!controlled && !processGenerationIsStale(owner)) {
    throw new Error(
      "Fray refused to stop a live owner without authenticated token-bound control; the owner was left untouched"
    );
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!readProjectLaunchOwner(workspace.stateDir)) {
      console.log(
        `stopped Fray UI for ${workspace.root}; tmux agent sessions were preserved`
      );
      return;
    }
    // A process can exit after accepting authenticated control but before its finally block removes
    // ownership. Reap through the same delegate-fencing protocol; never unlink the record directly.
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", {
      delegateDrainTimeoutMs: 250,
    });
    if (reaped.kind === "acquired") {
      reaped.lease.release();
      console.log(
        `stopped Fray UI for ${workspace.root}; tmux agent sessions were preserved`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The last poll can race a supervisor's finally block by a few milliseconds. Make one final
  // generation-safe observation before calling this a timeout: never signal a PID or unlink an
  // ownership record directly, and only reclaim through the same token/delegate protocol.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lateOwner = readProjectLaunchOwner(workspace.stateDir);
  if (!lateOwner) {
    console.log(
      `stopped Fray UI for ${workspace.root}; tmux agent sessions were preserved`
    );
    return;
  }
  if (processGenerationIsStale(lateOwner)) {
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", {
      delegateDrainTimeoutMs: 250,
    });
    if (reaped.kind === "acquired") {
      reaped.lease.release();
      console.log(
        `stopped Fray UI for ${workspace.root}; tmux agent sessions were preserved`
      );
      return;
    }
  }
  throw new Error(`supervisor pid ${owner.pid} did not stop within 10s`);
}

try {
  if (options.stop) {
    await stopWorkspace();
    process.exit(0);
  }

  let before = await existingHealth();
  if (command === "restart") {
    if (!before.port) throw new Error("Fray is not running for this workspace");
    const response = await fetch(
      `http://127.0.0.1:${before.port}/_fray/control/restart`,
      {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${before.port}` },
      }
    );
    const result = (await response.json()) as {
      state?: string;
      message?: string;
    };
    if (!response.ok || result.state !== "ready")
      throw new Error(
        result.message ?? "Fray did not become ready after restart"
      );
    console.log(
      `restarted Fray artifact ${
        readStableArtifact(workspace.stateDir)?.digest ?? "unknown"
      }`
    );
    process.exit(0);
  }
  if (options.status) {
    if (before.health && before.port) {
      const needsAttention = supervisorNeedsAttention(before.owner);
      console.log(
        `${needsAttention ? "degraded" : "running"}: http://127.0.0.1:${
          before.port
        }`
      );
      console.log(`workspace: ${before.health.projectDir}`);
      console.log(`source: ${sourceLabel()}`);
      if (before.owner?.artifactDigest)
        console.log(`artifact: ${before.owner.artifactDigest}`);
      console.log(`supervisor pid: ${before.owner?.pid ?? "unknown"}`);
      if (needsAttention) {
        console.log(
          `detail: ${
            before.owner?.message ?? `supervisor is ${before.owner?.state}`
          }`
        );
        process.exitCode = 1;
      }
    } else if (before.owner) {
      console.log(
        `broken: supervisor pid ${before.owner.pid} is ${
          before.owner.state ?? "alive"
        } but port ${before.owner.port} is unhealthy`
      );
      if (before.owner.message) console.log(`detail: ${before.owner.message}`);
      process.exitCode = 1;
    } else if (before.launchOwner) {
      console.log(
        `broken: ${before.launchOwner.role} pid ${before.launchOwner.pid} owns launch in ${before.launchOwner.state} state without a healthy control plane`
      );
      if (before.launchOwner.delegates.length > 0) {
        console.log(
          `detail: waiting for ${before.launchOwner.delegates.length} delegated control plane(s) to drain`
        );
      }
      process.exitCode = 1;
    } else console.log(`stopped: ${workspace.root}`);
    process.exit();
  }
  if (before.health && before.port) {
    await openOrPrint(before.port, true);
    startupProgress?.complete("Fray is ready");
    process.exit(0);
  }
  if (before.owner && !readProjectLaunchOwner(workspace.stateDir)) {
    const owner = before.owner;
    // Upgrade compatibility: an old supervisor has atomic-ish status but predates tokenized ownership.
    // Never start over it; allow its current child handoff to finish, then fail closed if still unhealthy.
    try {
      await waitForWorkspace(owner.port, expectedHealth, 5_000);
      before = await existingHealth();
    } catch {}
    if (before.health && before.port) {
      await openOrPrint(before.port, true);
      startupProgress?.complete("Fray is ready");
      process.exit(0);
    }
    throw new Error(
      `supervisor pid ${
        owner.pid
      } is alive but its control plane is unhealthy (${
        owner.state ?? "unknown"
      }: ${
        owner.message ?? "no detail"
      }); fix the source or run fray-dev --stop`
    );
  }

  const projectClaim = await claimProjectLaunch();
  if ("reusePort" in projectClaim) {
    await openOrPrint(projectClaim.reusePort, true);
    startupProgress?.complete("Fray is ready");
    process.exit(0);
  }
  const launchOwner = projectClaim;
  const target = workspaceLaunchTarget(workspace);
  // This preparation is local to the project. Keep it outside the machine-global port/start lock
  // so independent repositories can perform cold source/artifact work concurrently.
  let pinnedArtifact: ReturnType<typeof ensureStableFrayArtifact> | undefined;
  let release: (() => void) | undefined;
  try {
    const sequenced = await prepareBeforeGlobalLaunchLock(
      () => {
        startupProgress?.phase("Checking Fray launch prerequisites");
        assertLaunchPrerequisites();
        // The verified digest is passed to the foreground supervisor generation so a source mutation
        // after this point cannot alter its first child.
        return options.dev
          ? undefined
          : (() => {
              startupProgress?.phase("Preparing immutable Fray artifact");
              const artifact = ensureStableFrayArtifact(
                workspace.stateDir,
                sourceWorkspaceDir(),
                defaultArtifactRoot(),
                { onProgress: (message) => startupProgress?.phase(message) }
              );
              assertArtifactHostCompatible(artifact);
              return artifact;
            })();
      },
      () => {
        startupProgress?.phase("Waiting for Fray startup lock");
        // This lock protects only machine-shared port allocation and initial supervisor startup.
        // Artifact publication handles same-digest winners independently of this critical section.
        return acquireGlobalLaunchLock(
          undefined,
          FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS
        );
      }
    );
    pinnedArtifact = sequenced.prepared;
    release = sequenced.release;
  } catch (error) {
    launchOwner.release();
    throw error;
  }
  try {
    // Another invocation may have completed while this one waited for the allocator lock.
    const after = await existingHealth();
    if (after.health && after.port) {
      await openOrPrint(after.port, true);
      startupProgress?.complete("Fray is ready");
      release();
      release = undefined;
      launchOwner.release();
      process.exit(0);
    }
    if (after.owner)
      throw new Error(
        `supervisor pid ${after.owner.pid} became unhealthy during launch; run fray-dev --status`
      );

    const port = await choosePort(
      options.port,
      readPreferredPort(workspace.stateDir)
    );
    const ownedHealth = expectedOwnerHealth(
      target,
      readProjectLaunchOwner(workspace.stateDir)
    );
    startupProgress?.phase("Starting Fray server");
    const running = runSupervisor(port, launchOwner.token, pinnedArtifact?.digest);
    // From here the forked control-plane child logs to the same TTY. Go line-oriented so its
    // records (and the supervisor's own) land on their own rows instead of gluing onto the spinner.
    startupProgress?.beginConcurrentLogs("Waiting for Fray server health");
    await Promise.race([waitForWorkspace(port, ownedHealth), running]);
    // Hold the allocation/startup lock until the port is actually listening, then release it before the
    // foreground server lifetime. Concurrent repositories therefore allocate distinct ports without
    // serializing their running UI servers.
    release();
    release = undefined;
    await openOrPrint(port, false);
    startupProgress?.complete("Fray is ready");
    // The normal launcher intentionally remains attached. Its SIGINT/SIGTERM handler is installed
    // by runSupervisor and stops only this workspace's UI control plane.
    await running;
  } finally {
    release?.();
    launchOwner.release();
  }
} catch (error) {
  startupProgress?.fail(
    `Fray startup failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  fail(error);
}
