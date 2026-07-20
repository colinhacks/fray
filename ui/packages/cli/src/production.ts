#!/usr/bin/env node
// The registry launcher is intentionally separate from index.ts. `fray-dev` follows mutable
// checkout source; `fray` runs the package that npm resolved and never turns an npx cache into a
// deployment directory.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  acquireGlobalLaunchLock,
  choosePort,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  parseCliArgs,
  probeFray,
  readPreferredPort,
  resolveWorkspace,
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
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
} from "@fray-ui/server/project-launch";
import { createSupervisorShutdownHandler, startDevSupervisor } from "@fray-ui/server/dev-supervisor";
import { handoffToRegistrySuccessor, npmRegistryReleaseAdapter, planRegistryUpdate, PRODUCTION_REEXEC_FLAG } from "./production-update.ts";
import { assertLaunchPrerequisites } from "./preflight.ts";

const PACKAGE_NAME = process.env.FRAY_REGISTRY_PACKAGE ?? "frayui";
const PACKAGE_VERSION = process.env.npm_package_version ?? "0.0.1";
const rawArgs = process.argv.slice(2);
const reexec = rawArgs.includes(PRODUCTION_REEXEC_FLAG);
const args = rawArgs.filter((arg) => arg !== PRODUCTION_REEXEC_FLAG);
const fail = (error: unknown): never => {
  console.error(`fray: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
};

const options: CliOptions = (() => {
  try { return parseCliArgs(args); } catch (error) { return fail(error); }
})();
if (options.help) {
  console.log("Fray production launcher\n\nUsage: npx frayui [options] [repository]\n\nRuns the npm-resolved immutable Fray package. Use fray-dev only for a source checkout.");
  process.exit(0);
}
if (options.dev || rawArgs.includes("--prod")) fail("--dev and --prod are not available from the registry launcher");

const workspace: Workspace = (() => {
  try {
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  if (reexec) {
    if (!pinned) throw new Error("registry successor is missing its pinned project identity");
    return workspaceFromLaunchTarget(pinned);
  }
  return resolveWorkspace(options.repoPath);
  } catch (error) { return fail(error); }
})();
process.chdir(workspace.root);
const target = workspaceLaunchTarget(workspace);
const expected = expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir));

async function existingPort(): Promise<number | undefined> {
  const owner = liveWorkspaceOwner(workspace.stateDir, target);
  const ports = [owner?.port, readPreferredPort(workspace.stateDir)].filter((value): value is number => !!value);
  for (const port of new Set(ports)) if (await probeFray(port, expected)) return port;
  return undefined;
}

function openOrPrint(port: number, reused: boolean): void {
  const url = `http://127.0.0.1:${port}`;
  console.log(`${reused ? "reusing" : "started"} Fray ${PACKAGE_VERSION} for ${workspace.root}`);
  console.log(url);
}

async function runSupervisor(port: number, token: string): Promise<never> {
  assertLaunchPrerequisites();
  const owner = adoptProjectLaunchOwner(target, token, "supervisor");
  const env = projectLaunchEnvironment({ ...process.env, FRAY_PRODUCTION_SUPERVISOR: "1" }, target, owner.token);
  const webDist = join(import.meta.dirname, "..", "web-dist");
  const childEntry = fileURLToPath(import.meta.resolve("@fray-ui/server/dev-child"));
  let plannedUpdate: Awaited<ReturnType<typeof planRegistryUpdate>> | undefined;
  const supervisor = await startDevSupervisor({
    port,
    cwd: workspace.root,
    stateDir: workspace.stateDir,
    launchTarget: target,
    launchOwnerToken: owner.token,
    env,
    watch: false,
    childEntry,
    childEnvironment: () => ({ FRAY_STABLE_WEB_DIST: webDist, FRAY_STABLE_ARTIFACT: `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}` }),
    updateRestart: async () => {
      try {
        const plan = await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
        if (!plan) return { state: "failed" as const, message: `Fray ${PACKAGE_VERSION} is already current` };
        plannedUpdate = plan;
        // npm only writes its own cache. The healthy supervisor is deliberately left up until the
        // server has drained its child and proxy immediately before durableReexec below.
        return { state: "ready" as const, message: `Fray ${plan.latestVersion} will start in a new npm execution cache` };
      } catch (error) {
        return { state: "failed" as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
    durableReexec: async () => {
      const plan = plannedUpdate ?? await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
      if (!plan) throw new Error("Fray is already current");
      handoffToRegistrySuccessor(plan, { port, projectDir: workspace.root, cwd: workspace.root, env }, npmRegistryReleaseAdapter);
      // The successor adopts the same tokenized project lease. SQLite, tmux and provider sessions
      // are keyed project resources, so neither process copies, deletes, nor recreates them.
      process.exit(0);
    },
  });
  const stop = createSupervisorShutdownHandler({ close: () => supervisor.close(), release: () => owner.release(), exit: (code) => process.exit(code) });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  return await new Promise<never>(() => {});
}

try {
  if (process.env.FRAY_PRODUCTION_SUPERVISOR === "1" || reexec) {
    if (!options.port) throw new Error("internal registry supervisor launch is missing --port");
    const token = projectLaunchOwnerTokenFromEnvironment(process.env);
    if (!token) throw new Error("registry supervisor launch is missing project ownership");
    await runSupervisor(options.port, token);
  }
  const existing = await existingPort();
  if (existing) { openOrPrint(existing, true); process.exit(0); }
  const claim = tryAcquireProjectLaunchOwner(target, "launcher");
  if (claim.kind !== "acquired") throw new Error("Fray is starting for this project; retry shortly");
  const release = await acquireGlobalLaunchLock();
  try {
    const port = await choosePort(options.port, readPreferredPort(workspace.stateDir));
    if (options.foreground) await runSupervisor(port, claim.lease.token);
    const log = openSync(join(workspace.stateDir, "fray.log"), "a");
    const child = spawn(process.execPath, [process.argv[1]!, "--foreground", "--no-app", "--port", String(port)], {
      cwd: workspace.root,
      detached: true,
      env: projectLaunchEnvironment({ ...process.env, FRAY_PRODUCTION_SUPERVISOR: "1" }, target, claim.lease.token),
      stdio: ["ignore", log, log],
    });
    child.unref();
    closeSync(log);
    await waitForWorkspace(port, expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir)));
    openOrPrint(port, false);
  } finally { release(); claim.lease.release(); }
} catch (error) { fail(error); }
