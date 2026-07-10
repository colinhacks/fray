import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

// We SHELL OUT to the fray board scripts (cc/scripts/fray/*.mjs) rather than importing them.
// They are zero-dep plain node but pull in a wide internal module graph (ownership, bindings,
// agent-status, decisions) and read the project via CLAUDE_PROJECT_DIR/cwd — invoking the CLI
// with that env is the robust, drift-proof path (the board logic is never duplicated here, per
// the architecture invariant). The scripts dir is resolved relative to this package (the fray
// monorepo) and overridable via FRAY_SCRIPTS_DIR for a marketplace-installed plugin later.
//
// RISK: the default path assumes the server runs inside the fray monorepo. A standalone install
// against another repo must set FRAY_SCRIPTS_DIR to the installed plugin's scripts/fray dir.
export function frayScriptsDir(): string {
  if (process.env.FRAY_SCRIPTS_DIR) return process.env.FRAY_SCRIPTS_DIR
  // src/ -> server -> packages -> ui -> <repo root>
  return resolve(import.meta.dirname, "..", "..", "..", "..", "cc", "scripts", "fray")
}

// The per-thread shape emitted by `fray --json` (index.mjs, the --json branch). Parsed
// DEFENSIVELY: only the fields the board read-model needs are typed; unknowns are ignored.
export interface FrayThread {
  id: string
  title: string
  status: string
  status_text?: string
  activity?: string // form-constrained gerund label (≤100 chars) — the UI listing-row gloss
  next?: string
  hasPlan?: boolean // derived: the body has a `## Plan` section (drives the UI's quiet PLAN badge)
  mechanism?: string
  humanBlocked?: boolean
  ready?: boolean
  threadDeps?: string[]
  externalDeps?: { type: string; label: string }[]
  owner?: string | null
  revalidate?: { atMs: number } | null
  agents?: { id: string; label?: string; state?: string }[]
  errors?: string[]
  warnings?: string[]
}

// Structured, per-file error emitted alongside the legacy `errors` strings by the fray --json branch.
// `kind: "no-frontmatter"` is the one-click-repairable case; the server surfaces it to the client so
// the board banner can offer a Repair button (see repair.ts + the repairThread RPC).
export interface FrayErrorItem {
  file: string
  kind: "no-frontmatter" | "other"
  message: string
}

export interface FrayBoard {
  config: unknown
  threads: FrayThread[]
  errors: string[]
  warnings: string[]
  errorItems: FrayErrorItem[]
}

// Whether the project has been fray-bootstrapped (.fray/ exists). When absent the board is
// empty and we never invoke the CLI (it would just print a "no .fray/" notice).
export function frayDirExists(projectDir: string): boolean {
  return existsSync(join(projectDir, ".fray"))
}

export async function readBoard(projectDir: string, scriptsDir = frayScriptsDir()): Promise<FrayBoard> {
  const { stdout } = await execFileP("node", [join(scriptsDir, "index.mjs"), "--json"], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    maxBuffer: 32 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as Partial<FrayBoard>
  return {
    config: parsed.config ?? {},
    threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    // Additive: absent on a pre-update fray script (older cc/scripts) → [] (the board just loses the
    // repair affordance, never the plain error strings).
    errorItems: Array.isArray(parsed.errorItems) ? parsed.errorItems : [],
  }
}

// Structured thread-file write, through the SAME code path as `fray-update` (never a
// hand-rolled markdown edit). e.g. runThreadUpdate(dir, slug, ["--status", "done"]).
export async function runThreadUpdate(
  projectDir: string,
  slug: string,
  args: string[],
  scriptsDir = frayScriptsDir(),
): Promise<void> {
  await execFileP("node", [join(scriptsDir, "thread-update.mjs"), slug, ...args], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  })
}
