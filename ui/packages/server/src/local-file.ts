import { spawn, type SpawnOptions } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import type { LocalFileOpener } from "@fray-ui/shared"

export type LocalFileOpenResult = { action: "opened"; path: string } | { action: "copy"; path: string }

export type LocalFileSpawn = (command: string, args: readonly string[], options: SpawnOptions) => { unref(): void }

function isUnder(real: string, root: string): boolean {
  let rootReal: string
  try { rootReal = realpathSync(root) } catch { return false }
  return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
}

// Canonicalize before containment so a symlink below a trusted root cannot smuggle a path outside.
// Files only. The breadth of what's openable is the CALLER's `roots`: the image proxy stays narrow
// (artifact dirs), while the open action gates to home-and-below (see the router) so a referenced file
// like ~/.claude/CLAUDE.md can open — still confined, never the whole filesystem.
export function resolveLocalFile(rawPath: string, roots: readonly string[]): string {
  if (!isAbsolute(rawPath)) throw new Error("Local path must be absolute")
  let real: string
  try { real = realpathSync(rawPath) } catch { throw new Error("Local file was not found") }
  if (!roots.some((root) => isUnder(real, root))) throw new Error("Local file is outside Fray's trusted roots")
  try {
    if (!statSync(real).isFile()) throw new Error("Local path is not a regular file")
  } catch (error) {
    if (error instanceof Error && error.message === "Local path is not a regular file") throw error
    throw new Error("Local file was not found")
  }
  return real
}

// Resolve a human-written path REFERENCE (as it might appear in inline code) to a canonical openable
// file under `roots`, or null when it doesn't resolve to a real file there. Absolute paths are taken
// as-is; a leading `~`/`~/` expands to the home dir; anything else is resolved relative to the project
// dir (so a repo-relative `packages/web/App.tsx` works). A trailing `:line[:col]` (editor cursor
// suffix) is dropped. Returns null rather than throwing so a batch resolver can score many candidates
// cheaply; the same realpath + containment + is-file gate as resolveLocalFile keeps it confined.
export function resolveOpenableFile(
  raw: string,
  projectDir: string,
  roots: readonly string[],
  home: string = homedir(),
): string | null {
  const trimmed = raw.trim().replace(/:\d+(?::\d+)?$/, "")
  if (!trimmed) return null
  const abs = trimmed === "~" ? home
    : trimmed.startsWith("~/") ? join(home, trimmed.slice(2))
      : isAbsolute(trimmed) ? trimmed
        : resolve(projectDir, trimmed)
  try {
    return resolveLocalFile(abs, roots)
  } catch {
    return null
  }
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions) {
  return spawn(command, [...args], options)
}

// Open only a previously canonicalized, allowlisted local path. No shell is ever involved; each
// platform integration gets a fixed command plus an argv array. `copy` deliberately performs no OS
// action: the trusted same-origin client writes the returned canonical path to its clipboard.
export function openLocalFile(
  rawPath: string,
  opener: LocalFileOpener,
  roots: readonly string[],
  options: { forceSystem?: boolean; spawn?: LocalFileSpawn } = {},
): LocalFileOpenResult {
  const path = resolveLocalFile(rawPath, roots)
  const selected = options.forceSystem ? "system" : opener
  if (selected === "copy") return { action: "copy", path }

  const spec = process.platform === "darwin"
    ? selected === "cursor" ? ["open", ["-a", "Cursor", path]] as const
      : selected === "vscode" ? ["open", ["-a", "Visual Studio Code", path]] as const
        : selected === "finder" ? ["open", ["-R", path]] as const
          : ["open", [path]] as const
    : selected === "finder"
      ? ["xdg-open", [path]] as const
      : selected === "cursor"
        ? ["cursor", [path]] as const
        : selected === "vscode"
          ? ["code", [path]] as const
          : ["xdg-open", [path]] as const
  ;(options.spawn ?? defaultSpawn)(spec[0], spec[1], { detached: true, stdio: "ignore", shell: false }).unref()
  return { action: "opened", path }
}
