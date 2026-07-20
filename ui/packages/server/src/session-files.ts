import { lstatSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const SYSTEM_PROMPT_DIR = join(tmpdir(), "fray-sysprompts")

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

export function systemPromptPath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id")
  return join(SYSTEM_PROMPT_DIR, `${sessionId}.md`)
}

function isDirectDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function pathAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

function unlinkDirectChild(parent: string, filename: string): boolean {
  if (!isDirectDirectory(parent)) return pathAbsent(parent)
  const child = join(parent, filename)
  try {
    // rm/unlink of the direct child itself does not follow a child symlink. Parent validation above
    // prevents a poisoned directory symlink from redirecting recovery outside Fray-owned roots.
    rmSync(child, { force: true })
  } catch {
    return false
  }
  return pathAbsent(child)
}

export function cleanupAdoptionSessionFiles(projectDir: string, sessionId: string): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false
  const frayDir = join(projectDir, ".fray")
  let clean = true
  if (isDirectDirectory(frayDir)) {
    const threads = join(frayDir, "threads")
    // A UUID-named child belongs to exactly one dispatch. Remove the complete private scratchpad
    // directory rather than leaving an empty per-thread shell after a failed spawn/adoption.
    if (isDirectDirectory(threads)) {
      const child = join(threads, sessionId)
      try {
        rmSync(child, { recursive: true, force: true })
      } catch {
        clean = false
      }
    } else if (!pathAbsent(threads)) clean = false
  } else if (!pathAbsent(frayDir)) clean = false
  clean = unlinkDirectChild(SYSTEM_PROMPT_DIR, `${sessionId}.md`) && clean
  return clean
}
