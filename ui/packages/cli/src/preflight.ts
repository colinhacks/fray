import { spawnSync } from "node:child_process";

export interface CommandProbe {
  (command: string): boolean;
}

export interface LaunchPrerequisiteOptions {
  nodeVersion?: string;
  command?: CommandProbe;
}

/**
 * The lowest Node the runtime dependencies actually support, derived (not guessed) from what the
 * launch chain loads and runs:
 *   - the artifact build runs Vite ^8 on the user's own machine, engines `^20.19.0 || >=22.12.0`;
 *   - the runtime links better-sqlite3 ^12, engines `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`
 *     (18 is dropped);
 *   - the runtime uses `import.meta.dirname`, available since Node 20.11.
 * 20.19 is the tightest of these. Revisit this constant when those dependency floors move.
 */
const MINIMUM_NODE = { major: 20, minor: 19 } as const;

export interface ProviderReadiness {
  claude: boolean;
  codex: boolean;
}

export function commandIsAvailable(command: string): boolean {
  // `tmux --version` is not portable (macOS tmux accepts `-V` instead), so keep the probe
  // executable-specific while avoiding a shell and any persistent side effects.
  const versionArg = command === "tmux" ? "-V" : "--version";
  const result = spawnSync(command, [versionArg], {
    stdio: "ignore",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/**
 * Prerequisites shared by every local Fray launch. Provider CLIs are deliberately not included:
 * a workstation may use one backend while the other is unavailable.
 *
 * The Node floor here is a genuine minimum, not a proxy for the older Node-26 gate: it is the lowest
 * version Fray's build toolchain and native modules support (see `MINIMUM_NODE`). It is complementary
 * to `assertArtifactHostCompatible`, which only enforces that a reused artifact's Node major equals
 * the host's — that equality check cannot catch a host whose Node is simply below what the
 * dependencies need, which is precisely what this floor reports cleanly.
 */
export function assertLaunchPrerequisites(
  options: LaunchPrerequisiteOptions = {}
): void {
  const version = options.nodeVersion ?? process.versions.node;
  const [major, minor] = version.split(".").map(Number);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < MINIMUM_NODE.major ||
    (major === MINIMUM_NODE.major && minor < MINIMUM_NODE.minor)
  )
    throw new Error(
      `Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer is required (found ${version}); ` +
        `Fray's build (Vite) and native modules (better-sqlite3) do not support older Node. ` +
        `Install a newer Node release and relaunch Fray`
    );
  const command = options.command ?? commandIsAvailable;
  for (const executable of ["git", "tmux"]) {
    if (!command(executable))
      throw new Error(
        `required executable \`${executable}\` is not available on PATH; install ${executable} and relaunch Fray`
      );
  }
}

/** Non-blocking provider capability snapshot for callers that can selectively expose backends. */
export function providerReadiness(
  command: CommandProbe = commandIsAvailable
): ProviderReadiness {
  return { claude: command("claude"), codex: command("codex") };
}
