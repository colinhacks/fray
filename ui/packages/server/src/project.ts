import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  resolveGitProjectIdentity,
  type GitProjectIdentityScope,
} from "./project-identity.ts"
import type { ProjectLaunchTarget } from "./project-launch.ts"
import { resolveProjectTmuxSocketSelection } from "./tmux-socket.ts"

// Workspace resolution + on-disk locations. Everything here is derived once at boot and
// threaded through the AppContext — no module reads cwd on its own.

export interface Project {
  dir: string // repo root (git toplevel of the server's cwd)
  id: string // stable checkout UUID; common config for main, private Git metadata for linked worktrees
  name: string // basename of dir, for display
  label: string // "owner/repo" from the git origin remote, else name (repos with no remote)
  stateDir: string // ~/.fray/projects/<id>/ — SQLite + server.lock live here
  cwdSlug: string // ~/.claude/projects/<slug>/ session-log dir name
  tmuxSocket?: string // production resolvers always pin this; optional only for narrow test fixtures
  tmuxSocketManaged?: boolean // false only for an explicit FRAY_TMUX_SOCKET override
  // Present for linked worktrees; ordinary/main worktrees use the repository-scoped identity.
  identityScope?: Extract<GitProjectIdentityScope, "worktree">
}

// The trusted read roots for serving/opening local files (the /local-image route + the openLocalFile
// mutation). A file is served only when its symlink-resolved real path sits under one of these AND has a
// whitelisted image extension; the HTTP layer already rejects non-local/mismatched origins, so this is the
// defense-in-depth gate that keeps those endpoints from becoming arbitrary file read. Both temp trees are
// trusted, not just the per-user one (os.tmpdir() → /var/folders on macOS): agents write screenshots into
// the shared temp tree too — Claude Code's own per-session scratchpad lives at /tmp/claude-<uid>/…, and
// fray's disposable-stack scratch under /tmp/fray-* — so `/tmp` (realpath-normalized by the caller's
// isUnder check, e.g. → /private/tmp on macOS) covers every worker + subagent scratchpad without coupling
// to Claude Code's internal path convention. Intentionally permissive within the temp/screenshot space.
export function trustedLocalFileRoots(project: Pick<Project, "dir" | "stateDir">): string[] {
  return [project.dir, tmpdir(), "/tmp", resolve(homedir(), "Screenshots"), join(project.stateDir, "attachments")]
}

// The roots for the file-OPEN action (openLocalFile + the resolveLocalPaths classifier behind clickable
// inline-code paths). Broader than trustedLocalFileRoots: home-and-below is added so a referenced file
// like ~/.claude/CLAUDE.md opens, while system trees (/etc, /usr, …) stay out. Opening spawns the desktop
// opener (no bytes enter the page) and is still realpath-confined by the caller's isUnder check — never
// the whole filesystem. homedir() subsumes ~/Screenshots and an in-home project/attachments dir; the temp
// trees and an out-of-home checkout are kept explicit via the trusted set.
export function openableFileRoots(project: Pick<Project, "dir" | "stateDir">): string[] {
  return [homedir(), ...trustedLocalFileRoots(project)]
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false
  return /not a git repository/iu.test(String(error.stderr))
}

// The server's cwd's git root. Falls back to cwd for a non-git dir (degraded, but usable).
export function resolveProjectDir(cwd = process.cwd()): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    return realpathSync(root)
  } catch (error) {
    // A malformed config, unsafe ownership, missing Git binary, or other repository failure must not
    // silently turn a real repo into a fresh random namespace. Only Git's explicit non-repo result is
    // eligible for the historical degraded fallback.
    if (!isNotGitRepositoryError(error)) throw new Error("unable to resolve Git repository root")
    try {
      return realpathSync(cwd)
    } catch {
      return resolve(cwd)
    }
  }
}

// Main/ordinary UUIDs live in local Git config; linked-worktree UUIDs live in that worktree's private
// Git administrative directory. The CLI reads the same identity. Git failures are closed; non-Git
// directories retain the historical process-local fallback UUID.
function resolveProjectIdentity(
  dir: string,
  home = homedir(),
): { id: string; scope: GitProjectIdentityScope; root: string } {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (inside !== "true") throw new Error("Git directory is not a worktree")
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw new Error("unable to inspect Git repository identity")
    return { id: randomUUID(), scope: "repository", root: dir }
  }
  const identity = resolveGitProjectIdentity(dir, home)
  return { id: identity.id, scope: identity.scope, root: identity.root }
}

export function resolveProjectId(dir: string, home = homedir()): string {
  return resolveProjectIdentity(dir, home).id
}

// Claude Code's per-project session-log dir name: the absolute cwd with every '/' and '.'
// replaced by '-'. Verified empirically against ~/.claude/projects (e.g. /Users/x/.workshell
// → -Users-x--workshell). Used later by the JSONL tailer; computed here so the rule lives once.
export function cwdSlug(absPath: string): string {
  return absPath.replace(/[/.]/g, "-")
}

// Parse "owner/repo" out of a git remote URL. Handles the two forms git prints:
//   git@github.com:owner/repo.git   (scp-like ssh)
//   https://github.com/owner/repo(.git)   (https, optional .git, optional trailing slash)
// Also tolerates ssh://git@host/owner/repo.git. Returns null when it can't find an owner/repo pair.
export function parseRepoLabel(remoteUrl: string): string | null {
  const url = remoteUrl.trim()
  if (!url) return null
  // scp-like: [user@]host:owner/repo(.git)
  const scp = url.match(/^[^/@]+@[^:/]+:(.+?)(?:\.git)?\/?$/)
  if (scp) return normalizeOwnerRepo(scp[1])
  // url form: scheme://[user@]host[:port]/owner/repo(.git)
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/i)
  if (m) return normalizeOwnerRepo(m[1])
  return null
}

// Keep only the final two path segments (owner/repo); some hosts nest groups (gitlab) — the last
// two are the ones that read as "owner/repo". Reject if we can't get two non-empty segments.
function normalizeOwnerRepo(path: string): string | null {
  const parts = path.split("/").filter(Boolean)
  if (parts.length < 2) return null
  return parts.slice(-2).join("/")
}

// The origin remote's "owner/repo", or null when there's no remote (fresh/scratch repos have none).
export function resolveProjectLabel(dir: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return parseRepoLabel(url)
  } catch {
    return null // no origin remote, or not a git repo
  }
}

export function resolveProject(cwd = process.cwd(), home = homedir(), env: NodeJS.ProcessEnv = process.env): Project {
  const identity = resolveProjectIdentity(resolveProjectDir(cwd), home)
  const dir = identity.root
  const id = identity.id
  const stateDir = join(home, ".fray", "projects", id)
  mkdirSync(stateDir, { recursive: true })
  const name = basename(dir) || dir
  const target = {
    projectId: id,
    projectDir: dir,
    stateDir,
    ...(identity.scope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
  const selected = resolveProjectTmuxSocketSelection(target, { repositoryOverride: env.FRAY_TMUX_SOCKET })
  return {
    dir,
    id,
    name,
    label: resolveProjectLabel(dir) ?? name,
    stateDir,
    cwdSlug: cwdSlug(dir),
    tmuxSocket: selected.socket,
    tmuxSocketManaged: selected.managed,
    ...(identity.scope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
}

export function projectLaunchTarget(project: Project): ProjectLaunchTarget {
  return {
    projectId: project.id,
    projectDir: project.dir,
    stateDir: project.stateDir,
    tmuxSocket: project.tmuxSocket,
    tmuxSocketManaged: project.tmuxSocketManaged,
    ...(project.identityScope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
}

/** Rebuild non-secret display metadata from an already owner-verified pinned launch target. */
export function projectFromLaunchTarget(
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = process.env,
): Project {
  let dir: string
  try {
    dir = realpathSync(target.projectDir)
  } catch {
    throw new Error("pinned Fray project directory is no longer available")
  }
  if (dir !== target.projectDir) throw new Error("pinned Fray project directory is not canonical")
  const name = basename(dir) || dir
  const selected = target.tmuxSocket
    ? { socket: target.tmuxSocket, managed: target.tmuxSocketManaged !== false }
    : resolveProjectTmuxSocketSelection(target, { repositoryOverride: env.FRAY_TMUX_SOCKET })
  return {
    dir,
    id: target.projectId,
    name,
    label: resolveProjectLabel(dir) ?? name,
    stateDir: target.stateDir,
    cwdSlug: cwdSlug(dir),
    tmuxSocket: selected.socket,
    tmuxSocketManaged: selected.managed,
    ...(target.identityScope === "worktree" ? { identityScope: "worktree" as const } : {}),
  }
}
