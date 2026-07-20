import { spawnSync } from "node:child_process";

export interface CommandProbe {
  (command: string): boolean;
}

export interface LaunchPrerequisiteOptions {
  command?: CommandProbe;
}

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
 * No Node version gate: Fray runs the bundle it builds, and `assertArtifactHostCompatible` already
 * pins each artifact to the exact Node major (and native ABI) it was built against. A fresh
 * `fray-dev` build is therefore self-consistent on whatever Node drives it, so a hardcoded floor here
 * only ever falsely rejects a launch the artifact check would accept.
 */
export function assertLaunchPrerequisites(
  options: LaunchPrerequisiteOptions = {}
): void {
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
