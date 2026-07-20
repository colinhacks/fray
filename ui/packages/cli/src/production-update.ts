import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export const PRODUCTION_REEXEC_FLAG = "--_fray-production-reexec";

export interface RegistryReleaseAdapter {
  latestVersion(packageName: string): Promise<string>;
  spawnNpmExec(request: {
    packageSpec: string;
    /** Bin to invoke from the resolved package. Defaults to the package name (frayui). */
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): ChildProcess;
}

export interface RegistryUpdatePlan {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  packageSpec: string;
}

/**
 * Compare normal npm versions without bringing a runtime semver dependency into the launcher.
 * Unknown/non-semver versions deliberately never self-update: an operator can still run npx with
 * an explicit tag, but the browser button must fail closed rather than downgrade or guess.
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
    if (!match) return null;
    return { numeric: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 0; index < left.numeric.length; index++) {
    const delta = left.numeric[index]! - right.numeric[index]!;
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export async function planRegistryUpdate(
  packageName: string,
  currentVersion: string,
  adapter: Pick<RegistryReleaseAdapter, "latestVersion">
): Promise<RegistryUpdatePlan | null> {
  const latestVersion = (await adapter.latestVersion(packageName)).trim();
  const comparison = compareReleaseVersions(currentVersion, latestVersion);
  if (comparison === null)
    throw new Error(`cannot safely compare installed Fray version ${currentVersion} with registry version ${latestVersion}`);
  if (comparison >= 0) return null;
  return { packageName, currentVersion, latestVersion, packageSpec: `${packageName}@${latestVersion}` };
}

/**
 * Ask npm for a separate, immutable execution cache and start a successor from it.  This never
 * edits the package directory that npx is currently executing, which might be shared or deleted
 * by npm while the durable supervisor is still live.
 */
export function handoffToRegistrySuccessor(
  plan: RegistryUpdatePlan,
  request: { port: number; projectDir: string; cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "spawnNpmExec">
): void {
  const child = adapter.spawnNpmExec({
    packageSpec: plan.packageSpec,
    // The published bin name tracks the package name (frayui). Never hardcode a stale bin here or
    // a renamed release would resolve the new package but invoke a bin that no longer exists.
    bin: plan.packageName,
    args: [PRODUCTION_REEXEC_FLAG, "--port", String(request.port), request.projectDir],
    cwd: request.cwd,
    env: {
      ...request.env,
      FRAY_REGISTRY_PACKAGE: plan.packageName,
      FRAY_REGISTRY_VERSION: plan.latestVersion,
    },
  });
  child.once("error", () => {});
  child.unref();
}

export const npmRegistryReleaseAdapter: RegistryReleaseAdapter = {
  latestVersion(packageName) {
    return new Promise((resolveVersion, reject) => {
      execFile("npm", ["view", `${packageName}@latest`, "version", "--json"], { encoding: "utf8" }, (error, stdout) => {
        if (error) return reject(new Error(`could not check npm for ${packageName}: ${error.message}`));
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolveVersion(typeof parsed === "string" ? parsed : String(parsed));
        } catch {
          resolveVersion(stdout.trim().replaceAll('"', ""));
        }
      });
    });
  },
  spawnNpmExec({ packageSpec, bin, args, cwd, env }) {
    // The explicit package spec forces npm to resolve/install a new cache entry before running it.
    return spawn("npm", ["exec", "--yes", `--package=${packageSpec}`, "--", bin, ...args], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
  },
};
