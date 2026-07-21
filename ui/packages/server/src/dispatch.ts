import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync, type Stats } from "node:fs"
import { basename, join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import {
  AdoptThreadInput,
  DispatchInput,
  THREAD_SLUG_MAX_CHARS,
  ThreadSlug,
  tmuxSessionName,
  type Settings,
  type PermissionMode,
  type ProviderAuth,
} from "@fray-ui/shared"
import { PERM_DIR_ENV, permRequestDir, type Project } from "./project.ts"
import type { SessionRow, Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { AgentBackend, BackendKind, BuiltCommand, SpawnThreadMcp } from "./backend/types.ts"
import { CHROME_DEVTOOLS_MCP } from "./backend/types.ts"
import { buildWorkerPrompt } from "./workerPrompt.ts"
import { ensureCwdTrusted, discoverCodexRollout, codexSessionSentinel } from "./backend/codex.ts"
import { ProviderAuthRequiredError } from "./backend/auth-status.ts"
import { readBoard, type FrayBoard, type FrayThread } from "./fray.ts"
import * as tmux from "./tmux.ts"
import { SYSTEM_PROMPT_DIR, cleanupAdoptionSessionFiles, systemPromptPath } from "./session-files.ts"
import {
  ADOPTION_ATTEMPT_LEASE_MS,
  abandonAdoptionAttempt,
  reconcileAdoptionClaims,
  type AdoptionRecoveryRuntime,
} from "./adoption-recovery.ts"

// Dispatch = provision the thread's scratchpad + compose the full prompt + spawn a detached `claude`
// in a tmux session + register the session row. Session-first (2026-07-09): a new dispatch writes NO
// .fray/<slug>.md thread file — the session IS the thread, and its durable working memory is a
// scratchpad (.fray/threads/<sessionId>/scratch.md). The prompt is the ONLY intelligence: settings'
// dispatchPreamble (all orchestration wisdom) + scratchpad orientation + the task.

// title -> slug matching the board's id regex (^[a-z0-9][a-z0-9-]*$). Non-alnum collapses to a
// single '-'; leading/trailing '-' trimmed; empty falls back to "thread".
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // Leave no partial trailing separator after the cap. The collision suffixer below preserves this
  // same bound when it appends -2, -3, … to a maximum-length base.
  return s.slice(0, THREAD_SLUG_MAX_CHARS).replace(/-+$/g, "") || "thread"
}

// Derive a concrete thread title from the prompt when the human didn't supply one: the first ~6
// words of the prompt's first line, capped at 48 chars, ellipsized if anything was dropped. The
// thread FILE always needs a title (fray requires one) and the slug derives from it, so this never
// returns empty. Claude later renames the session (ai-title), which the UI prefers for display.
// Leading filler that carries no topic ("also spin up…", "please go ahead and…") and trailing
// function words a truncation must never end on (the old first-6-words cut produced slugs like
// "also-spin-up-a-sub-agent-to" — a dangling mid-phrase chop that reads as garbage in .fray/).
const LEAD_FILLER = new Set(["also", "please", "and", "then", "now", "ok", "okay", "hey", "just", "so", "well", "next", "go", "ahead", "lets", "let's", "can", "you", "could", "would"])
const TRAIL_STOP = new Set([
  "to", "a", "an", "the", "of", "for", "with", "in", "on", "at", "by", "and", "or", "but", "that",
  "this", "it", "is", "are", "be", "as", "into", "from", "my", "our", "your", "their",
])

export function fallbackTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0].trim()
  let allWords = firstLine.split(/\s+/).filter(Boolean)
  // Strip topic-free lead-ins, but never below two words of substance.
  while (allWords.length > 2 && LEAD_FILLER.has(allWords[0].toLowerCase().replace(/[^a-z]/g, ""))) allWords = allWords.slice(1)
  let words = allWords.slice(0, 6)
  // Never END on a dangling function word — back off (keeping at least two words).
  while (words.length > 2 && TRAIL_STOP.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) words = words.slice(0, -1)
  let t = words.join(" ")
  let truncated = words.length < allWords.length
  if (t.length > 48) {
    t = t.slice(0, 47).trimEnd()
    truncated = true
  }
  if (truncated) t += "…"
  return t || "thread"
}

// First free slug: <base>, then <base>-2, -3, … skipping any existing .fray/<slug>.md AND any taken
// registry slug (session-first: new dispatches have no .fray file, so uniqueness must also clear the
// storage rows — else two fileless sessions could collide on a slug). `taken` is the row predicate.
export function resolveSlug(frayDir: string, base: string, taken?: (slug: string) => boolean): string {
  base = ThreadSlug.parse(base)
  const isTaken = (slug: string) => existsSync(join(frayDir, `${slug}.md`)) || (taken?.(slug) ?? false)
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const stem = base.slice(0, THREAD_SLUG_MAX_CHARS - suffix.length).replace(/-+$/g, "") || "thread"
    const candidate = ThreadSlug.parse(`${stem}${suffix}`)
    if (!isTaken(candidate)) return candidate
  }
}

interface LegacyThreadFileIdentity {
  path: string
  realPath: string
  contents: Buffer
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  digest: string
}

function sameFileStat(a: LegacyThreadFileIdentity, b: LegacyThreadFileIdentity): boolean {
  return a.path === b.path && a.realPath === b.realPath && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.digest === b.digest
}

// Resolve an adoption source without ever accepting an indirect path. Both `.fray` and the selected
// markdown file must be real (not symlink) direct children of the real project root. Reading the file
// into the identity digest closes replacement/content races across the fresh-board authorization pass.
export function resolveLegacyThreadFile(projectDir: string, value: unknown): LegacyThreadFileIdentity | null {
  const parsed = ThreadSlug.safeParse(value)
  if (!parsed.success) return null
  try {
    const projectRoot = realpathSync(projectDir)
    const frayPath = join(projectRoot, ".fray")
    const frayStat = lstatSync(frayPath)
    if (!frayStat.isDirectory() || frayStat.isSymbolicLink()) return null
    const realFray = realpathSync(frayPath)
    if (dirname(realFray) !== projectRoot || basename(realFray) !== ".fray") return null

    const path = join(realFray, `${parsed.data}.md`)
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) return null
    const realPath = realpathSync(path)
    if (dirname(realPath) !== realFray || basename(realPath) !== `${parsed.data}.md`) return null
    let contents: Buffer
    let openedBefore: Stats
    let openedAfter: Stats
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      openedBefore = fstatSync(fd)
      contents = readFileSync(fd)
      openedAfter = fstatSync(fd)
    } finally {
      closeSync(fd)
    }
    const after = lstatSync(path)
    if (before.dev !== openedBefore.dev || before.ino !== openedBefore.ino ||
        openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino ||
        openedBefore.size !== openedAfter.size || openedBefore.mtimeMs !== openedAfter.mtimeMs ||
        openedBefore.ctimeMs !== openedAfter.ctimeMs || after.dev !== openedAfter.dev ||
        after.ino !== openedAfter.ino || after.size !== openedAfter.size ||
        after.mtimeMs !== openedAfter.mtimeMs || after.ctimeMs !== openedAfter.ctimeMs ||
        !openedAfter.isFile() || !after.isFile() || after.isSymbolicLink()) {
      return null
    }
    return {
      path,
      realPath,
      contents,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest: createHash("sha256").update(contents).digest("hex"),
    }
  } catch {
    return null
  }
}

const ADOPTABLE_LEGACY_STATUSES = new Set(["planning", "planned", "active", "needs-human", "blocked"])

export function isAdoptableLegacyBoardThread(thread: FrayThread, slug: string): boolean {
  return thread.id === slug &&
    ADOPTABLE_LEGACY_STATUSES.has(thread.status) &&
    thread.owner == null &&
    Array.isArray(thread.agents) && thread.agents.length === 0 &&
    Array.isArray(thread.errors) && thread.errors.length === 0
}

function boardAuthorizesAdoption(board: FrayBoard, slug: string): boolean {
  const matches = board.threads.filter((thread) => thread.id === slug)
  if (matches.length !== 1 || !isAdoptableLegacyBoardThread(matches[0], slug)) return false
  return !board.errorItems.some((item) => item.file === `${slug}.md`)
}

function ensureSafeDirectDirectory(parent: string, name: string): string {
  const path = join(parent, name)
  try {
    mkdirSync(path)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EEXIST") throw error
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe project directory")
  const real = realpathSync(path)
  if (dirname(real) !== parent || basename(real) !== name) throw new Error("unsafe project directory")
  return real
}

// The scratchpad skeleton (a CONVENTION, never validated): an H1, a one-line orientation, and the
// working sections. The worker owns it from here — this is only the starting shape. Backend-aware:
// a claude worker's pad is ALSO the fleet blackboard its sub-agents read (hence "## Shared context"),
// but a codex worker runs solo (fray dispatches no codex sub-agents), so its pad is purely
// compaction memory — the blackboard framing + shared section are dropped.
export function scratchpadContent(title: string, kind: BackendKind = "claude"): string {
  if (kind === "codex") {
    return `# Scratchpad — ${title}

Your compaction-proof working memory — keep your task list and any state that must survive a compaction here.

## Task list

- [ ]

## Notes
`
  }
  return `# Scratchpad — ${title}

Your compaction-proof working memory and the fleet blackboard — keep your task list and any state that must survive a compaction or be shared with your sub-agents here.

## Task list

- [ ]

## Shared context

## Notes
`
}

// Provision the thread's scratchpad (.fray/threads/<sessionId>/scratch.md), atomic tmp+rename. Returns the
// project-relative path. sessionId is a fresh UUID at both dispatch and adopt, so this never clobbers.
export function writeScratchpad(projectDir: string, sessionId: string, title: string, kind: BackendKind = "claude"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) throw new Error("invalid session id")
  const projectRoot = realpathSync(projectDir)
  const frayDir = ensureSafeDirectDirectory(projectRoot, ".fray")
  const threadsDir = ensureSafeDirectDirectory(frayDir, "threads")
  const dir = ensureSafeDirectDirectory(threadsDir, sessionId)
  const rel = `.fray/threads/${sessionId}/scratch.md`
  const path = join(dir, "scratch.md")
  // Deterministic per-session staging name lets restart recovery remove a SIGKILL artifact; the
  // session id is unique, so randomizing this filename only made the orphan undiscoverable.
  const tmp = join(dir, ".scratch.tmp")
  try {
    writeFileSync(tmp, scratchpadContent(title, kind), { flag: "wx", mode: 0o600 })
    if (existsSync(path)) throw new Error("scratchpad already exists")
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return rel
}

// The FIXED worker system prompt for `kind`, compiled in via workerPrompt.ts (single source of truth).
// The runtimeGate flag toggles the settings-gated Runtime-release-gate section. Not user-modifiable —
// the settings dispatchPreamble (custom instructions) is appended separately. Thin adapter kept so
// existing callers (spawn/adopt/resume builders + tests) are untouched.
export function loadWorkerPrompt(kind: BackendKind = "claude", runtimeGate = true): string {
  return buildWorkerPrompt(kind, { runtimeGate })
}

// The first USER message a dispatched agent receives: scratchpad orientation + custom instructions +
// task. Session-first (2026-07-09) — the old thread-ownership contract is REPLACED by scratchpad
// orientation (a new dispatch owns no .fray file). The fixed worker prompt (workerPrompt.ts) and the
// same scratchpad line at SYSTEM level travel via --append-system-prompt (see buildClaudeCommand) so
// they survive compaction and re-apply on resume; this composes the visible-message half.
export function composePrompt(sessionId: string, prompt: string, customInstructions: string, kind: BackendKind = "claude"): string {
  const scratch =
    kind === "codex"
      ? `Your scratchpad is \`.fray/threads/${sessionId}/scratch.md\` — your compaction-proof working memory. Keep your task list and any state that must survive a compaction IN it, and re-read it after a compaction to recover where you are.`
      : `Your scratchpad is \`.fray/threads/${sessionId}/scratch.md\` — your compaction-proof working memory and the shared blackboard for your sub-agents. Keep your task list and any state that must survive a compaction or be shared with sub-agents IN it, and pass its path to every sub-agent you dispatch.`
  const custom = customInstructions.trim()
    ? `\n\nPROJECT INSTRUCTIONS (from the human operator):\n${customInstructions.trim()}`
    : ""
  return `${scratch}${custom}\n\nTASK:\n${prompt}`
}

// The SYSTEM-level scratchpad orientation (survives compaction, rebuilds on every resume): a scratchpad
// line, plus a PLAN line when the thread is associated with a plan artifact. Passed as extraSystemPrompt
// on dispatch, adopt, AND the followUp resume path.
export function scratchpadOrientation(sessionId: string, planPath?: string | null, kind: BackendKind = "claude"): string {
  const scratch =
    kind === "codex"
      ? `SCRATCHPAD: .fray/threads/${sessionId}/scratch.md — your compaction-proof working memory (write your task list + any state that must survive a compaction there; re-read it after a compaction to recover where you are).`
      : `SCRATCHPAD: .fray/threads/${sessionId}/scratch.md — your compaction-proof working memory and the shared blackboard for your sub-agents (write shared state + your task list there; pass this path in every sub-agent prompt).`
  const lines = [scratch]
  if (planPath) lines.push(`PLAN: ${planPath} — the durable plan artifact this thread works from; read it FIRST.`)
  return lines.join("\n")
}

// A project can ship a repo-committed `FRAY.md` at its root to steer fray workers with its OWN
// engineering-PROCESS norms — gates, review depth, commit/PR conventions — which OVERRIDE fray's
// built-in PROCESS defaults (NOT the fray-mechanical contract: signal fences, scratchpad, the browser
// runtime gate stay in force — the injected header says so, matching the "Defer" section of the worker
// contract). When present, its contents are injected into every worker's SYSTEM prompt (dispatch,
// adopt, AND resume; both backends) under that header, so both backends see it without relying on the
// agent choosing to open the file. Read fresh on every spawn/resume, so an edit takes effect on the
// next launch.
//
// The read is guarded by statSync BEFORE readFileSync: only a regular file under a size cap is read.
// That keeps one accidental/hostile FRAY.md from wedging the server's event loop on EVERY dispatch and
// resume — a FIFO would make readFileSync block forever, a symlink loop throws, a directory/device
// isn't a regular file, and a runaway/generated file is rejected by size rather than fully slurped.
// The surviving content is then clipped to keep token/context cost bounded. Returns "" when
// absent/oversized/non-regular/empty — the caller drops it from the composed extra-system-prompt.
const FRAY_MD_MAX_CHARS = 12_000
const FRAY_MD_MAX_BYTES = 64 * 1024
export function frayConfigBlock(projectDir: string): string {
  const path = join(projectDir, "FRAY.md")
  let body: string
  try {
    const st = statSync(path) // follows a symlink to its target; ENOENT/ELOOP throw → caught
    if (!st.isFile() || st.size > FRAY_MD_MAX_BYTES) return "" // not a regular file, or runaway size
    body = readFileSync(path, "utf8").trim()
  } catch {
    return "" // no FRAY.md, unreadable, symlink loop, etc. → inject nothing
  }
  if (!body) return ""
  const clipped = body.length > FRAY_MD_MAX_CHARS ? `${body.slice(0, FRAY_MD_MAX_CHARS)}\n\n[FRAY.md truncated]` : body
  return `PROJECT FRAY CONFIG (from this repo's FRAY.md) — the project's own conventions for fray workers. They OVERRIDE the fray worker PROCESS defaults above (review depth, gates, git/PR conventions, the quality bar) wherever they conflict; follow them. They do NOT relax the fray-mechanical contract — the signal fences, scratchpad, and browser runtime gate still bind:\n\n${clipped}`
}

// A DispatchInput.planPath is honored only when it is a well-formed .fray/plans/*.md path AND the file
// exists; anything else is ignored (stored as null). Shape check forecloses traversal.
const PLAN_PATH_RE = /^\.fray\/plans\/[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/
export function validPlanPath(projectDir: string, planPath: string | undefined): string | null {
  if (!planPath || !PLAN_PATH_RE.test(planPath)) return null
  return existsSync(join(projectDir, planPath)) ? planPath : null
}

// Workers have NO coherent interactive-plan-mode semantics: plan mode stays read-only until an
// INTERACTIVE ExitPlanMode approval, which a headless dashboard worker can't satisfy (no one is at
// the keyboard) and which blocks all edits until then — a softlock. A worker "plans" by writing a
// plan artifact (.fray/plans/*.md) and asking via a ```question fence, never via interactive plan
// mode. So a worker is NEVER spawned in plan mode: `plan` is coerced to the safe fray-ui default
// (`auto`). Applied inside BOTH spawn builders so dispatch, adopt, AND resume are all covered. (The
// dispatch UI still OFFERS "plan" in its permission-mode dropdown — dropping it in web/options.ts is
// a follow-up for UI honesty; this coercion is the actual enforcement + the softlock fix.)
function workerPermissionMode(m: PermissionMode): PermissionMode {
  return m === "plan" ? "auto" : m
}

// Every fray-CREATED worker launches maximally non-interactive: an unattended headless worker cannot
// answer an interactive prompt, so a dispatch-time permission CHOICE is a footgun, not a feature —
// restrictive modes just stall the thread on a modal nobody is watching. Claude gets `auto`; codex
// gets `bypassPermissions` (→ `-s danger-full-access`). The dispatch/adopt paths stamp this
// unconditionally (client-sent permissionMode is ignored); the LIVE per-thread permission control
// still exists to steer an already-running session.
export const WORKER_DISPATCH_PERMISSION: Record<BackendKind, PermissionMode> = {
  claude: "auto",
  codex: "bypassPermissions",
}

// Canonical value that describes the permission policy the backend ACTUALLY receives. Claude's
// headless-worker plan request is coerced to auto (above); Codex's three sandbox levels share the
// PermissionMode storage field, so all workspace-write aliases collapse to `default`.
export function effectivePermissionMode(kind: BackendKind, mode: PermissionMode): PermissionMode {
  if (kind === "claude") return workerPermissionMode(mode)
  if (mode === "plan" || mode === "bypassPermissions") return mode
  return "default"
}

// The assembled system prompt (worker norms + spawn-specific orientation) is ~16KB — passing it
// inline as `--append-system-prompt <text>` on the tmux `new-session` command line EXCEEDS tmux's
// command-length limit and fails EVERY spawn with a silent "command too long" (found 2026-07-09:
// 100% of dispatch/adopt/resume broken). claude accepts `--append-system-prompt-file <path>`, so we
// write the prompt to a per-session file and pass the (short) path instead — the tmux command stays
// tiny. Written per invocation (dispatch AND resume) into a stable per-session path, so a resume
// after OS temp-cleanup just rewrites it. Returns the flag pair to splice into argv (empty if no
// system prompt). NOTE: keep using `--append-system-prompt` for genuinely SHORT text would also
// work, but a single file path is uniformly safe regardless of prompt growth.
function systemPromptFlags(sessionId: string, system: string): string[] {
  if (!system) return []
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true })
  const path = systemPromptPath(sessionId)
  writeFileSync(path, system)
  return ["--append-system-prompt-file", path]
}

// Resolve the descriptor for the fray spawn-thread MCP tool: the abs path to the stdio server script
// (shipped as a sibling of bin/fray in the worker plugin dir, so it rides the SAME ship+resolve path
// that already carries the plugin to prod) + the project state dir the script reads server.lock from.
// Returns undefined when the plugin dir or script can't be found — the worker then simply lacks the
// tool rather than failing to spawn. `env`/`moduleUrl` injectable for tests.
export function resolveSpawnThreadMcp(
  stateDir: string,
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): SpawnThreadMcp | undefined {
  const pluginDir = resolveWorkerPluginDir(moduleUrl, env)
  if (!pluginDir) return undefined
  const scriptPath = join(pluginDir, "bin", "spawn-thread-mcp.mjs")
  if (!existsSync(scriptPath)) return undefined
  return { scriptPath, stateDir }
}

// Claude flags that mount the fray-injected MCP servers via ONE inline `--mcp-config` JSON and
// PRE-APPROVE their tools (`--allowedTools`) so a headless worker never blocks on a permission prompt
// it has nobody to answer. execvp runs the argv with NO shell (tmux.ts), so the JSON travels literally.
// chrome-devtools is ALWAYS mounted (the runtime release gate needs a browser out of the box on any
// machine — parity with the codex backend's `-c` injection, same CHROME_DEVTOOLS_MCP spec); the
// server-level `mcp__chrome-devtools` rule pre-approves every tool it exposes. fray_spawn rides along
// when its descriptor resolved.
export function claudeMcpFlags(mcp?: SpawnThreadMcp): string[] {
  const servers: Record<string, unknown> = {
    [CHROME_DEVTOOLS_MCP.name]: { command: CHROME_DEVTOOLS_MCP.command, args: [...CHROME_DEVTOOLS_MCP.args] },
  }
  const allowed = [`mcp__${CHROME_DEVTOOLS_MCP.name}`]
  if (mcp) {
    // command is the ABSOLUTE node path (process.execPath — the node running the fray server), NOT bare
    // "node": Claude spawns the MCP-server process itself, and a worker's PATH varies by launch context
    // (a GUI-launched tmux, a login-shell difference) — if `node` isn't on it, the MCP server never
    // starts and the tool silently never appears in the worker. An absolute path removes that dependency.
    servers.fray_spawn = { command: process.execPath, args: [mcp.scriptPath], env: { FRAY_STATE_DIR: mcp.stateDir } }
    allowed.push("mcp__fray_spawn__spawn_fray_thread")
  }
  const config = JSON.stringify({ mcpServers: servers })
  // ONE comma-joined `--allowedTools=` in EQUALS form: the flag is VARIADIC, so a space-separated
  // value with a positional right behind it (e.g. the minimal no-system-prompt argv, where the prompt
  // directly follows) would be swallowed as a second rule. The equals form binds exactly one token —
  // immune to argv reordering. Verified live: `claude -p --allowedTools=mcp__chrome-devtools <prompt>`
  // runs the tools unprompted with the prompt surviving as the positional.
  return ["--mcp-config", config, `--allowedTools=${allowed.join(",")}`]
}

// The `claude` argv for a fresh dispatch. session-id is PINNED so we can resume the exact
// conversation later. claudeBin is injectable so tests build the command without spawning.
export function buildClaudeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  prompt: string
  claudeBin?: string
  pluginDir?: string
  // Injectable for tests; defaults to the compiled-in worker contract ("" disables the append).
  workerPrompt?: string
  // Extra spawn-specific system-prompt text appended AFTER the worker norms (e.g. the adoption
  // orientation) — system-level so the visible transcript carries only the human's own words.
  extraSystemPrompt?: string
  spawnThreadMcp?: SpawnThreadMcp
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--session-id", opts.sessionId, "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  if (opts.effort) argv.push("--effort", opts.effort)
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.spawnThreadMcp))
  // The fixed worker norms live in the SYSTEM prompt: rebuilt on every invocation (incl. resume)
  // and immune to compaction, unlike a first user message.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push(opts.prompt)
  return argv
}

// The fray-worker plugin (single-thread worker contract + hooks), a sibling of cc/ in the Fray
// source tree. Deployed artifacts carry it at runtime/cc-worker, but pnpm may load this module
// through a nested store rather than the flat node_modules layout. Search module ancestors so the
// closure remains discoverable in either layout; an explicitly verified artifact path wins.
export function resolveWorkerPluginDir(
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const override = env.FRAY_WORKER_PLUGIN_DIR
  if (override && existsSync(join(override, ".claude-plugin", "plugin.json")))
    return override
  let current = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const candidate = join(current, "cc-worker")
    if (existsSync(join(candidate, ".claude-plugin", "plugin.json"))) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function workerPluginDir(): string | undefined {
  return resolveWorkerPluginDir()
}

// Claude Code reads these inherited process variables as sub-agent profile defaults. A Fray worker
// chooses its profile explicitly through the launch argv and plugin agent profiles, so let neither
// a shell nor a globally configured Claude session silently replace that selection. Empty tmux
// environment entries override inherited values while preserving every auth/config variable.
export function claudeWorkerEnvironment(): Record<string, string> {
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    CLAUDE_CODE_EFFORT_LEVEL: "",
  }
}

// The `claude` argv to RESUME an existing session with a follow-up (used when the tmux session
// has died and a live sendKeys is impossible).
export function buildClaudeResumeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  message?: string
  claudeBin?: string
  pluginDir?: string
  workerPrompt?: string
  // Extra system-prompt text appended AFTER the worker norms (e.g. the scratchpad orientation) — the
  // system prompt is rebuilt per invocation, so a resume must re-carry it or the scratchpad is forgotten.
  extraSystemPrompt?: string
  // The spawn-thread MCP tool must ride resume too (a resumed worker keeps the capability).
  spawnThreadMcp?: SpawnThreadMcp
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  if (opts.effort) argv.push("--effort", opts.effort)
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  argv.push(...claudeMcpFlags(opts.spawnThreadMcp))
  // The system prompt is rebuilt per invocation — the resume must re-carry the worker norms too.
  // Same file-based path as buildClaudeCommand (see systemPromptFlags): inline would blow tmux's
  // command-length limit.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push("-r", opts.sessionId)
  if (opts.message) argv.push(opts.message)
  return argv
}

// Codex rollout-discovery timeout: session_meta normally appears within hundreds of ms, followed by
// the first user_message carrying Fray's ownership sentinel. Stay bounded, but never weaken that proof
// to cwd-only matching while we wait (concurrent workers intentionally share cwd).
// Two simultaneous cold Codex 0.144.1 starts were observed to serialize enough initialization that
// the second wrote session_meta/task_started immediately but its sentinel-bearing user record landed
// after 5s. Fifteen seconds keeps failure bounded without rejecting a healthy concurrent launch.
const CODEX_DISCOVERY_TIMEOUT_MS = 15_000
const CODEX_DISCOVERY_INTERVAL_MS = 100
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---- codex prompt transport (tmux command-length dodge) ----
// The codex worker-contract rides the PROMPT (the resolved prompt-prepend decision), so codex's prompt
// argv is the full contract (~18KB) — passing it inline on the `tmux new-session` command line exceeds
// tmux's command-length limit and fails EVERY codex spawn (the SAME limit Claude dodges by writing its
// system prompt to a file and passing a short `--append-system-prompt-file <path>`). Codex has no
// prompt-file flag, so we spill the prompt to a temp file and rebuild argv as a tiny `sh -c` wrapper
// that reads it at exec time — the tmux command stays short, and codex still receives the identical
// prompt as its trailing positional arg (nothing pollutes the repo/global config — the temp file is a
// transient transport artifact, NOT an on-disk AGENTS.md). This lives in the DISPATCH layer (like
// Claude's systemPromptFlags), leaving the CodexBackend's argv contract untouched.
const CODEX_PROMPT_DIR = join(tmpdir(), "fray-codex-prompts")
// POSIX single-quote a shell token (wrap in '' and escape embedded quotes) so the wrapper script can't
// word-split or interpret the codex flags (cwd/model/effort values).
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
// Rewrite a codex BuiltCommand so its (large) trailing prompt argv travels via a temp file instead of
// the tmux command line. The prompt is ALWAYS the last argv element (codex takes it as the trailing
// positional). Adds the temp file to prewrite (dispatch writes it before spawn).
function transportCodexPrompt(built: BuiltCommand, sessionId: string): BuiltCommand {
  const prompt = built.argv[built.argv.length - 1]
  const head = built.argv.slice(0, -1)
  mkdirSync(CODEX_PROMPT_DIR, { recursive: true })
  const promptFile = join(CODEX_PROMPT_DIR, `${sessionId}.txt`)
  // sh -c '<script>' <$0> <$1=promptFile>: `"$(cat "$1")"` re-hydrates the prompt as ONE arg at exec.
  const script = `exec ${head.map(shQuote).join(" ")} "$(cat "$1")"`
  return {
    ...built,
    argv: ["sh", "-c", script, "fray-codex", promptFile],
    prewrite: [...built.prewrite, { path: promptFile, contents: prompt, mode: 0o600 }],
  }
}

export interface Dispatcher {
  // `opts.backend` selects the agent backend for THIS dispatch (Codex-support epic, Phase 2); omitted /
  // "claude" is the default, so the RPC path (which passes no opts until the Phase-3 UI picker wires
  // DispatchInput.backend through) is byte-identical to before. A codex dispatch pre-arms the cwd trust
  // gate, spawns the codex TUI, then sentinel-discovers + pins the rollout id on the row.
  dispatch(input: DispatchInput, opts?: { backend?: BackendKind }): Promise<{ slug: string; sessionId: string }>
  // Cold-adopt an EXISTING thread fray-ui didn't originate (e.g. a repo with a pre-existing .fray
  // board): spawn a fresh worker pointed at the thread file. Fray's contract makes this sound —
  // the doc, not the conversation, is the durable context; the worker reads it and continues.
  adopt(slug: string, message?: string): Promise<{ slug: string; sessionId: string }>
}

export interface DispatchDeps {
  project: Project
  storage: Storage
  board: BoardManager
  // Adoption never authorizes from the BoardManager's potentially stale cache. Re-scan the legacy
  // board at click time, after the selected file has passed the direct-file containment check.
  readBoard?: typeof readBoard
  getSettings: () => Settings
  claudeBin?: string // injectable (tests / a stand-in command)
  spawn?: typeof tmux.spawn // injectable so tests don't touch tmux; identity is mandatory for safe rollback
  ensureServer?: typeof tmux.ensureServer
  hasSession?: typeof tmux.hasSession
  // Adoption rollback may stop only the exact pane identity returned by its own spawn. There is no
  // name-targeted fallback: a competing/current owner of the slug must never be killed.
  killPane?: typeof tmux.killPane
  killExpectedAdoptionPane?: typeof tmux.killExpectedAdoptionPane
  // Per-session agent-backend resolver that builds the spawn argv + injection (Codex-support epic).
  // Injected by the composition layer (context.ts); when absent (tests) dispatch falls back to the
  // local Claude argv builder, producing a byte-identical command. Selected by `opts.backend`.
  backendFor?: (kind?: string) => AgentBackend
  // $CODEX_HOME override for the codex trust pre-arm + rollout discovery (tests inject a tmp dir);
  // unset → the codex default (~/.codex), matching the CodexBackend the composition layer built.
  codexHome?: string
  // Failure cleanup targets only the exact freshly-spawned slug. Injectable so timeout tests can prove
  // no neighboring tmux session is touched.
  killSession?: typeof tmux.killSession
  // Deterministic discovery timing seams. Production uses the bounded 15s/100ms policy above.
  codexDiscoveryTimeoutMs?: number
  codexDiscoveryIntervalMs?: number
  codexDiscoverySleep?: (ms: number) => Promise<void>
  // Provider auth preflight (claude-auth plan, Slice A): resolves the target provider's credential
  // state BEFORE any thread state exists; a positive "signed-out" rejects the dispatch with
  // ProviderAuthRequiredError. Injected by the composition layer (context.ts: `claude auth status
  // --json` for Claude, the local auth.json read for Codex). Absent (tests) ⇒ no preflight, so unit
  // tests never shell out or depend on the developer's real credential state.
  preflightAuth?: (kind: BackendKind) => Promise<ProviderAuth>
  // Durable adoption recovery seams. Production uses tmux's token-aware exact-pane implementation;
  // focused tests inject an in-memory private server and deterministic time.
  adoptionRuntime?: AdoptionRecoveryRuntime
  adoptionNow?: () => number
  adoptionAttemptToken?: () => string
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const spawn = deps.spawn ?? tmux.spawn
  const ensureServer = deps.ensureServer ?? tmux.ensureServer
  const hasSession = deps.hasSession ?? tmux.hasSession
  const killPane = deps.killPane ?? tmux.killPane
  const killSession = deps.killSession ?? tmux.killSession
  const readBoardSource = deps.readBoard ?? readBoard
  const frayDir = join(deps.project.dir, ".fray")
  const adoptionRuntime: AdoptionRecoveryRuntime = deps.adoptionRuntime ?? {
    lookupAdoptionPane: tmux.lookupAdoptionPane,
    findAdoptionPane: tmux.findAdoptionPane,
    findPaneIdentity: tmux.findPaneIdentity,
    killExpectedAdoptionPane: deps.killExpectedAdoptionPane ?? tmux.killExpectedAdoptionPane,
  }

  // Build the detached-spawn command through the backend seam for the chosen `kind` (falling back to
  // the local Claude builder when no resolver is injected — identical argv). Returns argv + prewrites.
  function buildSpawnCommand(o: {
    sessionId: string
    permissionMode: PermissionMode
    model?: string
    effort?: string
    prompt: string
    extraSystemPrompt?: string
    kind?: BackendKind
    runtimeGate: boolean
  }): BuiltCommand {
    const spawnThreadMcp = resolveSpawnThreadMcp(deps.project.stateDir)
    const backend = deps.backendFor?.(o.kind)
    if (backend) {
      const built = backend.buildSpawn({
        sessionId: o.sessionId,
        cwd: deps.project.dir,
        prompt: o.prompt,
        workerContract: loadWorkerPrompt(o.kind, o.runtimeGate),
        extraSystemPrompt: o.extraSystemPrompt,
        permissionMode: o.permissionMode,
        model: o.model,
        effort: o.effort,
        spawnThreadMcp,
      })
      // Codex inlines the ~18KB worker contract into its prompt argv — too long for the tmux command
      // line. Spill it to a temp file (see transportCodexPrompt). Claude already writes its system
      // prompt to a file, so its argv is short — left untouched.
      return o.kind === "codex" ? transportCodexPrompt(built, o.sessionId) : built
    }
    const argv = buildClaudeCommand({
      sessionId: o.sessionId,
      permissionMode: o.permissionMode,
      model: o.model,
      effort: o.effort,
      prompt: o.prompt,
      claudeBin: deps.claudeBin,
      pluginDir: workerPluginDir(),
      extraSystemPrompt: o.extraSystemPrompt,
      workerPrompt: loadWorkerPrompt("claude", o.runtimeGate),
      spawnThreadMcp,
    })
    return { argv, env: claudeWorkerEnvironment(), prewrite: [] }
  }

  // Codex has NO --session-id pin: the rollout id is minted by codex and only knowable once it writes
  // session_meta (a beat after spawn). Poll the sentinel-based discovery briefly until the rollout
  // appears, so the pinned id is on the row before the tailer first sights it. Bounded so a Codex that
  // never records its first prompt cannot hang dispatch. A timeout is a dispatch FAILURE: the caller
  // tears down only this just-spawned slug and writes no row, instead of returning a stranded session
  // with a null/wrong native id.
  async function discoverCodexRolloutWithRetry(o: { sessionId: string; spawnedAtMs: number }): Promise<string | undefined> {
    const sentinel = codexSessionSentinel(o.sessionId)
    const timeoutMs = Math.max(0, deps.codexDiscoveryTimeoutMs ?? CODEX_DISCOVERY_TIMEOUT_MS)
    const intervalMs = Math.max(1, deps.codexDiscoveryIntervalMs ?? CODEX_DISCOVERY_INTERVAL_MS)
    const wait = deps.codexDiscoverySleep ?? sleep
    let elapsed = 0
    for (;;) {
      const found = discoverCodexRollout({ cwd: deps.project.dir, spawnedAtMs: o.spawnedAtMs, sentinel, codexHome: deps.codexHome })
      if (found) return found.sessionId
      if (elapsed >= timeoutMs) return undefined
      const delay = Math.min(intervalMs, timeoutMs - elapsed)
      await wait(delay)
      elapsed += delay
    }
  }

  function writePrewrites(built: BuiltCommand): void {
    for (const file of built.prewrite) {
      if (file.mode === undefined) writeFileSync(file.path, file.contents)
      else writeFileSync(file.path, file.contents, { mode: file.mode })
    }
  }

  function cleanupPrewrites(built: BuiltCommand): void {
    for (const path of new Set(built.prewrite.map((file) => file.path))) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Best-effort: these session-id-keyed files are inert and never identify another worker.
      }
    }
  }

  function cleanupDispatchFiles(scratchRel: string, built: BuiltCommand, sessionId: string): void {
    cleanupPrewrites(built)
    try {
      rmSync(join(deps.project.dir, scratchRel), { force: true })
    } catch {
      // The session-id-keyed scratchpad is inert and never identifies another worker.
    }
    cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
  }

  return {
    async dispatch(input, opts) {
      // Dispatcher is a server boundary too: tests, schedulers, and future transports may call it
      // without traversing the RPC parser. Reject malformed explicit slugs before scratch/tmux/SQLite.
      input = DispatchInput.parse(input)
      const settings = deps.getSettings()
      const kind: BackendKind = opts?.backend ?? "claude"
      // Auth preflight (Slice A): block ONLY on a positive "signed-out" — "unknown" (flaky read,
      // missing binary, timeout) fails OPEN so a network blip never traps a logged-in user. Runs
      // before the scratchpad/tmux/registry so a rejected dispatch leaves zero trace; the browser
      // keeps the draft and opens the sign-in modal off the sentinel message.
      if (deps.preflightAuth && (await deps.preflightAuth(kind).catch((): ProviderAuth => "unknown")) === "signed-out") {
        throw new ProviderAuthRequiredError(kind)
      }
      // Title: explicit human title, else the heuristic chop. (A headless `claude -p` titling pass
      // was tried and REMOVED — print mode is going away for Max subscription auth, which is the
      // whole reason the workers run as interactive tmux sessions. Claude's own evolving ai-title
      // takes over the display name seconds after the session starts; only the slug is heuristic.)
      const title = input.title?.trim() || fallbackTitle(input.prompt)
      const base = input.slug ?? slugify(title)
      const slug = resolveSlug(frayDir, base, (s) => deps.storage.getSession(s) !== undefined)
      // Codex TUI does not reliably emit either a native title or Fray's requested hidden marker.
      // Keep the already bounded, deterministic dispatch title as the durable automatic fallback.
      // Unlike the full composed prompt, fallbackTitle is capped and topic-oriented; a later valid
      // provider/Fray signal may still replace it through the title_auto CAS.
      const registryTitle = title
      const sessionId = randomUUID()
      const permissionMode = WORKER_DISPATCH_PERMISSION[kind]
      // Resolve the profile ONCE for this session. It feeds both the CLI argv and the persisted row,
      // so the thread UI describes what this dispatch actually launched with rather than whatever the
      // mutable global defaults happen to be when the drawer is opened later.
      const model = input.model ?? settings.model
      const effort = input.effort ?? settings.effort
      const planPath = validPlanPath(deps.project.dir, input.planPath)

      // Session-first: provision the scratchpad (the durable working memory) — NO .fray/<slug>.md file.
      // The scratchpad keys on the fray-minted sessionId, which stays the row's session_id for BOTH
      // backends (codex's discovered rollout id is pinned separately on agent_session_id).
      const scratchRel = writeScratchpad(deps.project.dir, sessionId, title, kind)

      const prompt = composePrompt(sessionId, input.prompt, settings.dispatchPreamble, kind)
      const runtimeGate = settings.runtimeGate !== false
      const built = buildSpawnCommand({
        sessionId,
        permissionMode,
        model,
        effort,
        prompt,
        extraSystemPrompt: [scratchpadOrientation(sessionId, planPath, kind), frayConfigBlock(deps.project.dir)].filter(Boolean).join("\n\n"),
        kind,
        runtimeGate,
      })

      // Codex TUI blocks on a "Do you trust this directory?" modal for an untrusted cwd — an unattended
      // worker would hang forever. Pre-arm the persisted-trust entry BEFORE spawn (idempotent global
      // ~/.codex/config.toml write; respects an existing block — see ensureCwdTrusted). Claude never
      // touches it. [maintainer-approved global write — Codex-support epic ⚖.]
      if (kind === "codex") ensureCwdTrusted(deps.project.dir, deps.codexHome)
      const spawnedAtMs = Date.now()

      // Spawn BEFORE writing the registry row so a spawn failure never strands a contentless row on
      // the board (C1). If the spawn throws, roll back the scratchpad we just provisioned too — a
      // failed dispatch must leave NO trace (no orphan row, no litter) — then surface the concise error.
      ensureServer()
      try {
        writePrewrites(built)
        spawn(slug, built.argv, deps.project.dir, { ...built.env, FRAY_UI_THREAD: slug, [PERM_DIR_ENV]: permRequestDir(deps.project) })
      } catch (err) {
        if (err instanceof tmux.TmuxSpawnError && err.identity) {
          try {
            killPane(err.identity)
          } catch {
            // Exact generation only; never fall back to the reusable slug.
          }
        }
        cleanupDispatchFiles(scratchRel, built, sessionId)
        throw err
      }

      // Codex mints its own rollout id — discover it (sentinel-matched, race-proof across concurrent
      // same-cwd dispatches) so it's pinned on the row BEFORE the tailer first sights it (else the
      // tailer can't locate the rollout). Never register a Codex row without that ownership proof:
      // resume would otherwise target the Fray UUID (not Codex's id) and silently attach incorrectly.
      let agentSessionId: string | undefined
      if (kind === "codex") {
        try {
          agentSessionId = await discoverCodexRolloutWithRetry({ sessionId, spawnedAtMs })
        } catch (err) {
          try {
            killSession(slug)
          } catch {
            // Preserve the discovery error; production killSession is already idempotent/best-effort.
          }
          cleanupDispatchFiles(scratchRel, built, sessionId)
          throw err
        }
        if (!agentSessionId) {
          try {
            killSession(slug)
          } catch {
            // The slug is still never registered or confused with a neighboring session.
          }
          cleanupDispatchFiles(scratchRel, built, sessionId)
          throw new Error(
            `Codex started, but Fray could not verify its rollout within ${Math.max(0, deps.codexDiscoveryTimeoutMs ?? CODEX_DISCOVERY_TIMEOUT_MS)}ms. The unregistered worker was stopped; please retry.`,
          )
        }
        // Seeing this dispatch's exact sentinel proves Codex already consumed the prompt transport.
        // Remove only these session-id-keyed prewrites before returning; successful dispatches must
        // not accumulate full user tasks/contracts in a shared temp directory.
        cleanupPrewrites(built)
      }

      deps.storage.upsertSession({
        slug,
        session_id: sessionId,
        tmux_name: tmuxSessionName(slug),
        spawned_at: new Date().toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        // No explicit human title → backend telemetry becomes the display name. Codex's neutral slug
        // fallback is intentionally never rendered as a title; Claude retains its historical fallback.
        rested_at: null,
        title_auto: input.title?.trim() ? 0 : 1,
        title: registryTitle,
        state: "open",
        meta: null,
        seen_at: null,
        plan_path: planPath,
        transcript_id: null, // discovery caches this later only if the transcript drifts off <session_id>.jsonl
        model: model ?? null,
        effort: effort ?? null,
        permission_mode: permissionMode,
      })
      // Codex pins live OFF the shared upsert (whose named-param statement every claude caller feeds):
      // stamp the backend + the discovered rollout id AFTER the row exists. Claude skips both, so its
      // `backend` stays the column DEFAULT 'claude' and `agent_session_id` stays NULL — untouched.
      if (kind === "codex") {
        deps.storage.setBackend(slug, kind)
        deps.storage.setAgentSession(slug, agentSessionId!)
      }

      // Respond immediately — the client switches views on the slug; the rebuild (a shell-out to
      // the fray board scripts) fans out over SSE moments later.
      void deps.board.rebuild().catch(() => {})
      return { slug, sessionId }
    },

    async adopt(slug, message) {
      const unavailable = () => new Error("thread is not available for adoption")
      const parsed = AdoptThreadInput.safeParse({ slug, message })
      if (!parsed.success) throw unavailable()
      slug = parsed.data.slug
      message = parsed.data.message

      // Authorization is deliberately reconstructed from current raw inputs instead of trusting a
      // browser affordance or the BoardManager cache: exact direct file identity + one fresh, valid,
      // nonterminal, unowned, agentless board row + no registry/tmux owner. Every precondition shares
      // one non-oracular failure and occurs before ensureServer, scratch creation, spawn, or storage.
      const source = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!source) throw unavailable()
      let freshBoard: FrayBoard
      try {
        freshBoard = await readBoardSource(deps.project.dir)
        if (!boardAuthorizesAdoption(freshBoard, slug)) throw unavailable()
      } catch {
        throw unavailable()
      }
      // A registry row owns its slug regardless of whether its worker is currently alive, exited, or
      // archived. Adoption is a cold-start path, never a replacement/resume path.
      try {
        if (deps.storage.getSession(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }

      // Retry performs the same leased reconciliation as boot. A stale attempt can be removed only
      // after its token is absent (or its exact tuple was killed); an active/finalized/conflicted claim
      // remains authoritative and returns the same non-oracular response as every other ineligible row.
      try {
        const outcome = reconcileAdoptionClaims({
          storage: deps.storage,
          projectDir: deps.project.dir,
          now: deps.adoptionNow,
          runtime: adoptionRuntime,
          slug,
        }).get(slug)
        // A retired-token orphan has no live claim by design. Its reconciliation outcome is therefore
        // an independent ownership fence: do not infer safety solely from the row/claim registry.
        if (outcome && outcome !== "recovered-stale-attempt") throw unavailable()
        if (deps.storage.getSession(slug) || deps.storage.getAdoptionClaim(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }

      // `hasSession` deliberately includes remain-on-exit panes. Even a dead name collision is safer to
      // surface than to name-kill: another process may be concurrently registering/replacing it, and a
      // slug-targeted cleanup could destroy the wrong worker. tmux's atomic new-session name claim is the
      // second line of defense if a worker appears immediately after this check.
      try {
        if (hasSession(slug)) throw unavailable()
      } catch {
        throw unavailable()
      }
      const recheckedSource = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!recheckedSource || !sameFileStat(source, recheckedSource)) throw unavailable()

      const settings = deps.getSettings()
      const sessionId = randomUUID()
      const attemptToken = deps.adoptionAttemptToken?.() ?? randomUUID()
      const now = deps.adoptionNow ?? Date.now
      const reservedAtMs = now()
      try {
        if (!deps.storage.reserveAdoptionClaim({
          slug,
          attemptToken,
          sessionId,
          reservedAtMs,
          leaseExpiresAtMs: reservedAtMs + ADOPTION_ATTEMPT_LEASE_MS,
        })) {
          throw unavailable()
        }
      } catch {
        throw unavailable()
      }

      let scratchRel: string | undefined
      let built: BuiltCommand | undefined
      let spawnedIdentity: tmux.PaneIdentity | undefined
      const rollback = (identity = spawnedIdentity): void => {
        let abandoned = false
        try {
          abandoned = abandonAdoptionAttempt({
            storage: deps.storage,
            projectDir: deps.project.dir,
            slug,
            attemptToken,
            sessionId,
            identity,
            runtime: adoptionRuntime,
          })
        } catch {
          // Leave the durable claim for boot recovery if tmux/storage is temporarily unavailable.
        }
        if (!abandoned) return
        if (scratchRel && built) cleanupDispatchFiles(scratchRel, built, sessionId)
        else cleanupAdoptionSessionFiles(deps.project.dir, sessionId)
      }

      // The adoption orientation is SYSTEM-level (the visible transcript carries only the human's own
      // words). Session-first: the legacy file is prior CONTEXT to read first, NOT a contract to maintain
      // — the worker works session-first from here (scratchpad + end-of-turn fences), leaving the file's
      // frontmatter untouched.
      const adoption =
        "ADOPTION: this thread predates you and has prior context recorded in `.fray/" +
        slug +
        ".md` (a previous agent or session worked it — you have no access to that conversation, and you don't need it). READ THAT FILE FIRST for context: `## Goal` is the mission, `## Status`/`## Decisions`/`## Next step` are where things stand. It is CONTEXT, not a contract — do NOT edit its frontmatter. You work session-first from here: keep your working state in your scratchpad and signal end-of-turn with the done/awaiting fences. The human's message below is your steer on top of that context."
      const task = message?.trim() || "Pick up this thread and continue from where the file says things stand."
      // Provision a scratchpad too (the adopted worker's durable memory); the legacy file stays read-only.
      try {
        scratchRel = writeScratchpad(deps.project.dir, sessionId, slug)
      } catch {
        rollback()
        throw unavailable()
      }
      const prompt = composePrompt(sessionId, task, settings.dispatchPreamble)
      const permissionMode = WORKER_DISPATCH_PERMISSION.claude
      const runtimeGate = settings.runtimeGate !== false
      try {
        built = buildSpawnCommand({
          sessionId,
          permissionMode,
          model: settings.model,
          effort: settings.effort,
          prompt,
          extraSystemPrompt: [scratchpadOrientation(sessionId), frayConfigBlock(deps.project.dir), adoption].filter(Boolean).join("\n\n"),
          runtimeGate,
        })
      } catch {
        rollback()
        throw unavailable()
      }

      // Keep the authorized file identity stable through local provisioning and server startup. If
      // either step loses the source, remove only this UUID-keyed scratch/prewrite set and never spawn.
      const beforeEnsure = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!beforeEnsure || !sameFileStat(source, beforeEnsure)) {
        rollback()
        throw unavailable()
      }
      try {
        ensureServer()
      } catch {
        rollback()
        throw unavailable()
      }
      const beforeSpawn = resolveLegacyThreadFile(deps.project.dir, slug)
      if (!beforeSpawn || !sameFileStat(source, beforeSpawn)) {
        rollback()
        throw unavailable()
      }

      // The durable reservation predates new-session. The attempt token is installed by new-session
      // itself; its returned tuple is synchronously committed before either follow-up setup command.
      // Thus every post-create failure is recoverable even if this process is killed at the boundary.
      try {
        writePrewrites(built)
        const fenced = deps.storage.withAdoptionSpawnFence(
          slug,
          attemptToken,
          now() + ADOPTION_ATTEMPT_LEASE_MS,
          (bindPane) => spawn(
            slug,
            built!.argv,
            deps.project.dir,
            { ...built!.env, FRAY_UI_THREAD: slug, [PERM_DIR_ENV]: permRequestDir(deps.project) },
            {
              adoptionAttemptToken: attemptToken,
              onCreated: (identity) => {
                spawnedIdentity = identity
                const observedAt = now()
                if (!bindPane(identity, observedAt + ADOPTION_ATTEMPT_LEASE_MS)) {
                  throw new Error("adoption claim lost before pane binding")
                }
              },
            },
          ),
        )
        if (!fenced.acquired) throw new Error("adoption claim retired before spawn")
        spawnedIdentity = fenced.value
      } catch (error) {
        const identity = spawnedIdentity ?? (error instanceof tmux.TmuxSpawnError ? error.identity : undefined)
        rollback(identity)
        throw unavailable()
      }

      // Revalidate the exact identity and renew the lease across unusually slow post-create setup.
      // withAdoptionSpawnFence already rejects a spawn implementation that skipped onCreated.
      let rebound = false
      try {
        const reboundAt = now()
        rebound = deps.storage.recordAdoptionPane(
          slug,
          attemptToken,
          spawnedIdentity,
          reboundAt + ADOPTION_ATTEMPT_LEASE_MS,
        )
      } catch {
        rollback()
        throw unavailable()
      }
      if (!rebound) {
        rollback()
        throw unavailable()
      }

      const adopted = {
        slug,
        session_id: sessionId,
        tmux_name: tmuxSessionName(slug),
        spawned_at: new Date(now()).toISOString(),
        last_read_at: null,
        unread: 0,
        exited: 0,
        archived: 0,
        rested_at: null,
        title_auto: 0, // adopted threads keep their file title
        title: null,
        state: "open",
        meta: null,
        seen_at: null,
        plan_path: null,
        transcript_id: null,
        // Adoption starts a NEW session using the dispatch defaults in force at that moment. Pin those
        // values now; a later settings change must not relabel this adopted conversation.
        model: settings.model ?? null,
        effort: settings.effort ?? null,
        permission_mode: permissionMode,
        // Adoption always starts a fresh Claude session. Keep both identity columns in the SAME atomic
        // insert so a prior/competing Codex owner can never leak its native id into this row.
        backend: "claude",
        agent_session_id: null,
      } satisfies SessionRow

      let claimed = false
      try {
        claimed = deps.storage.finalizeAdoptionClaim(slug, attemptToken, adopted, now())
      } catch {
        rollback()
        throw unavailable()
      }
      if (!claimed) {
        rollback()
        throw unavailable()
      }

      void deps.board.rebuild().catch(() => {})
      return { slug, sessionId }
    },
  }
}
