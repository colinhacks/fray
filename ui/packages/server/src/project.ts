import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// Workspace resolution + on-disk locations. Everything here is derived once at boot and
// threaded through the AppContext — no module reads cwd on its own.

export interface Project {
  dir: string // repo root (git toplevel of the server's cwd)
  id: string // stable UUID, persisted in .git/config key fray.id
  name: string // basename of dir, for display
  label: string // "owner/repo" from the git origin remote, else name (repos with no remote)
  stateDir: string // ~/.fray/projects/<id>/ — SQLite + server.lock live here
  cwdSlug: string // ~/.claude/projects/<slug>/ session-log dir name
}

// The server's cwd's git root. Falls back to cwd for a non-git dir (degraded, but usable).
export function resolveProjectDir(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim()
  } catch {
    return cwd
  }
}

// The project UUID lives in the repo's git config (fray.id) so it survives clones/reopens
// and is the same key fray-ui's cli reads. Created on first run.
export function resolveProjectId(dir: string): string {
  try {
    const existing = execFileSync("git", ["config", "--local", "fray.id"], { cwd: dir, encoding: "utf8" }).trim()
    if (existing) return existing
  } catch {
    // key unset (or not a git repo) — fall through to create
  }
  const id = randomUUID()
  try {
    execFileSync("git", ["config", "--local", "fray.id", id], { cwd: dir })
  } catch {
    // non-git dir: the UUID is still stable for this process; persistence is best-effort
  }
  return id
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
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }).trim()
    return parseRepoLabel(url)
  } catch {
    return null // no origin remote, or not a git repo
  }
}

export function resolveProject(cwd = process.cwd()): Project {
  const dir = resolveProjectDir(cwd)
  const id = resolveProjectId(dir)
  const stateDir = join(homedir(), ".fray", "projects", id)
  mkdirSync(stateDir, { recursive: true })
  const name = dir.split("/").filter(Boolean).pop() ?? dir
  return { dir, id, name, label: resolveProjectLabel(dir) ?? name, stateDir, cwdSlug: cwdSlug(dir) }
}
