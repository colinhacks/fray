import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { tmuxSessionName, type DispatchInput, type Settings, type PermissionMode } from "@fray-ui/shared"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import * as tmux from "./tmux.ts"

// Dispatch = provision the thread's scratchpad + compose the full prompt + spawn a detached `claude`
// in a tmux session + register the session row. Session-first (2026-07-09): a new dispatch writes NO
// .fray/<slug>.md thread file — the session IS the thread, and its durable working memory is a
// scratchpad (.fray/scratch/<sessionId>.md). The prompt is the ONLY intelligence: settings'
// dispatchPreamble (all orchestration wisdom) + scratchpad orientation + the task.

// title -> slug matching the board's id regex (^[a-z0-9][a-z0-9-]*$). Non-alnum collapses to a
// single '-'; leading/trailing '-' trimmed; empty falls back to "thread".
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return s || "thread"
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
  const isTaken = (slug: string) => existsSync(join(frayDir, `${slug}.md`)) || (taken?.(slug) ?? false)
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!isTaken(candidate)) return candidate
  }
}

// The scratchpad skeleton (a CONVENTION, never validated): an H1, a one-line orientation, and the three
// working sections. The worker owns it from here — this is only the starting shape.
export function scratchpadContent(title: string): string {
  return `# Scratchpad — ${title}

Your compaction-proof working memory and the fleet blackboard — keep your task list and any state that must survive a compaction or be shared with your sub-agents here.

## Task list

- [ ]

## Shared context

## Notes
`
}

// Provision the thread's scratchpad (.fray/scratch/<sessionId>.md), atomic tmp+rename. Returns the
// project-relative path. sessionId is a fresh UUID at both dispatch and adopt, so this never clobbers.
export function writeScratchpad(projectDir: string, sessionId: string, title: string): string {
  const dir = join(projectDir, ".fray", "scratch")
  mkdirSync(dir, { recursive: true })
  const rel = `.fray/scratch/${sessionId}.md`
  const path = join(projectDir, rel)
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, scratchpadContent(title))
  renameSync(tmp, path)
  return rel
}

// The FIXED worker system prompt: ui/WORKER_PROMPT.md below its provenance header. Not
// user-modifiable — the settings dispatchPreamble (custom instructions) is appended separately.
export function loadWorkerPrompt(): string {
  try {
    const md = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../WORKER_PROMPT.md"), "utf8")
    const cut = md.indexOf("\n---\n")
    return cut === -1 ? md.trim() : md.slice(cut + 5).trim()
  } catch {
    return ""
  }
}

// The first USER message a dispatched agent receives: scratchpad orientation + custom instructions +
// task. Session-first (2026-07-09) — the old thread-ownership contract is REPLACED by scratchpad
// orientation (a new dispatch owns no .fray file). The fixed worker prompt (WORKER_PROMPT.md) and the
// same scratchpad line at SYSTEM level travel via --append-system-prompt (see buildClaudeCommand) so
// they survive compaction and re-apply on resume; this composes the visible-message half.
export function composePrompt(sessionId: string, prompt: string, customInstructions: string): string {
  const scratch = `Your scratchpad is \`.fray/scratch/${sessionId}.md\` — your compaction-proof working memory and the shared blackboard for your sub-agents. Keep your task list and any state that must survive a compaction or be shared with sub-agents IN it, and pass its path to every sub-agent you dispatch.`
  const custom = customInstructions.trim()
    ? `\n\nPROJECT INSTRUCTIONS (from the human operator):\n${customInstructions.trim()}`
    : ""
  return `${scratch}${custom}\n\nTASK:\n${prompt}`
}

// The SYSTEM-level scratchpad orientation (survives compaction, rebuilds on every resume): a scratchpad
// line, plus a PLAN line when the thread is associated with a plan artifact. Passed as extraSystemPrompt
// on dispatch, adopt, AND the followUp resume path.
export function scratchpadOrientation(sessionId: string, planPath?: string | null): string {
  const lines = [
    `SCRATCHPAD: .fray/scratch/${sessionId}.md — your compaction-proof working memory and the shared blackboard for your sub-agents (write shared state + your task list there; pass this path in every sub-agent prompt).`,
  ]
  if (planPath) lines.push(`PLAN: ${planPath} — the durable plan artifact this thread works from; read it FIRST.`)
  return lines.join("\n")
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

// The assembled system prompt (worker norms + spawn-specific orientation) is ~16KB — passing it
// inline as `--append-system-prompt <text>` on the tmux `new-session` command line EXCEEDS tmux's
// command-length limit and fails EVERY spawn with a silent "command too long" (found 2026-07-09:
// 100% of dispatch/adopt/resume broken). claude accepts `--append-system-prompt-file <path>`, so we
// write the prompt to a per-session file and pass the (short) path instead — the tmux command stays
// tiny. Written per invocation (dispatch AND resume) into a stable per-session path, so a resume
// after OS temp-cleanup just rewrites it. Returns the flag pair to splice into argv (empty if no
// system prompt). NOTE: keep using `--append-system-prompt` for genuinely SHORT text would also
// work, but a single file path is uniformly safe regardless of prompt growth.
const SYSPROMPT_DIR = join(tmpdir(), "fray-sysprompts")
function systemPromptFlags(sessionId: string, system: string): string[] {
  if (!system) return []
  mkdirSync(SYSPROMPT_DIR, { recursive: true })
  const path = join(SYSPROMPT_DIR, `${sessionId}.md`)
  writeFileSync(path, system)
  return ["--append-system-prompt-file", path]
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
  // Injectable for tests; defaults to the shipped WORKER_PROMPT.md ("" disables the append).
  workerPrompt?: string
  // Extra spawn-specific system-prompt text appended AFTER the worker norms (e.g. the adoption
  // orientation) — system-level so the visible transcript carries only the human's own words.
  extraSystemPrompt?: string
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--session-id", opts.sessionId, "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.model) argv.push("--model", opts.model)
  if (opts.effort) argv.push("--effort", opts.effort)
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  // The fixed worker norms live in the SYSTEM prompt: rebuilt on every invocation (incl. resume)
  // and immune to compaction, unlike a first user message.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push(opts.prompt)
  return argv
}

// The fray-worker plugin (single-thread worker contract + hooks), a sibling of cc/ in the fray
// monorepo. Its hooks gate on FRAY_UI_THREAD, so passing it is safe even for non-fray repos.
// FRAY_WORKER_PLUGIN_DIR overrides for standalone installs where the monorepo layout is absent.
export function workerPluginDir(): string | undefined {
  const override = process.env.FRAY_WORKER_PLUGIN_DIR
  const candidate = override ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../cc-worker")
  return existsSync(join(candidate, ".claude-plugin", "plugin.json")) ? candidate : undefined
}

// The `claude` argv to RESUME an existing session with a follow-up (used when the tmux session
// has died and a live sendKeys is impossible).
export function buildClaudeResumeCommand(opts: {
  sessionId: string
  permissionMode: PermissionMode
  message: string
  claudeBin?: string
  pluginDir?: string
  workerPrompt?: string
  // Extra system-prompt text appended AFTER the worker norms (e.g. the scratchpad orientation) — the
  // system prompt is rebuilt per invocation, so a resume must re-carry it or the scratchpad is forgotten.
  extraSystemPrompt?: string
}): string[] {
  const argv = [opts.claudeBin ?? "claude", "--permission-mode", workerPermissionMode(opts.permissionMode)]
  if (opts.pluginDir) argv.push("--plugin-dir", opts.pluginDir)
  // The system prompt is rebuilt per invocation — the resume must re-carry the worker norms too.
  // Same file-based path as buildClaudeCommand (see systemPromptFlags): inline would blow tmux's
  // command-length limit.
  const worker = opts.workerPrompt ?? loadWorkerPrompt()
  const system = [worker, opts.extraSystemPrompt?.trim()].filter(Boolean).join("\n\n")
  argv.push(...systemPromptFlags(opts.sessionId, system))
  argv.push("-r", opts.sessionId, opts.message)
  return argv
}

export interface Dispatcher {
  dispatch(input: DispatchInput): Promise<{ slug: string; sessionId: string }>
  // Cold-adopt an EXISTING thread fray-ui didn't originate (e.g. a repo with a pre-existing .fray
  // board): spawn a fresh worker pointed at the thread file. Fray's contract makes this sound —
  // the doc, not the conversation, is the durable context; the worker reads it and continues.
  adopt(slug: string, message?: string): Promise<{ slug: string; sessionId: string }>
}

export interface DispatchDeps {
  project: Project
  storage: Storage
  board: BoardManager
  getSettings: () => Settings
  claudeBin?: string // injectable (tests / a stand-in command)
  spawn?: typeof tmux.spawn // injectable so tests don't touch tmux
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const spawn = deps.spawn ?? tmux.spawn
  const frayDir = join(deps.project.dir, ".fray")

  return {
    async dispatch(input) {
      const settings = deps.getSettings()
      // Title: explicit human title, else the heuristic chop. (A headless `claude -p` titling pass
      // was tried and REMOVED — print mode is going away for Max subscription auth, which is the
      // whole reason the workers run as interactive tmux sessions. Claude's own evolving ai-title
      // takes over the display name seconds after the session starts; only the slug is heuristic.)
      const title = input.title?.trim() || fallbackTitle(input.prompt)
      const base = input.slug ?? slugify(title)
      const slug = resolveSlug(frayDir, base, (s) => deps.storage.getSession(s) !== undefined)
      const sessionId = randomUUID()
      const permissionMode = input.permissionMode ?? settings.permissionMode
      const planPath = validPlanPath(deps.project.dir, input.planPath)

      // Session-first: provision the scratchpad (the durable working memory) — NO .fray/<slug>.md file.
      const scratchRel = writeScratchpad(deps.project.dir, sessionId, title)

      const prompt = composePrompt(sessionId, input.prompt, settings.dispatchPreamble)
      const cmd = buildClaudeCommand({
        sessionId,
        permissionMode,
        model: input.model ?? settings.model,
        effort: input.effort ?? settings.effort,
        prompt,
        claudeBin: deps.claudeBin,
        pluginDir: workerPluginDir(),
        extraSystemPrompt: scratchpadOrientation(sessionId, planPath),
      })

      // Spawn BEFORE writing the registry row so a spawn failure never strands a contentless row on
      // the board (C1). If the spawn throws, roll back the scratchpad we just provisioned too — a
      // failed dispatch must leave NO trace (no orphan row, no litter) — then surface the concise error.
      tmux.ensureServer()
      try {
        spawn(slug, cmd, deps.project.dir, { FRAY_UI_THREAD: slug })
      } catch (err) {
        try {
          rmSync(join(deps.project.dir, scratchRel))
        } catch {
          // best-effort cleanup — a leftover scratchpad is inert (never enumerated as a thread)
        }
        throw err
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
        // No explicit human title → Claude's evolving ai-title becomes the display name (row.title is the
        // fallback; there's no thread file to sync into anymore).
        rested_at: null,
        title_auto: input.title?.trim() ? 0 : 1,
        title,
        state: "open",
        meta: null,
        seen_at: null,
        plan_path: planPath,
      })

      // Respond immediately — the client switches views on the slug; the rebuild (a shell-out to
      // the fray board scripts) fans out over SSE moments later.
      void deps.board.rebuild()
      return { slug, sessionId }
    },

    async adopt(slug, message) {
      if (!existsSync(join(frayDir, `${slug}.md`))) throw new Error(`no thread file for ${slug}`)
      const settings = deps.getSettings()
      const sessionId = randomUUID()
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
      const scratchRel = writeScratchpad(deps.project.dir, sessionId, slug)
      const prompt = composePrompt(sessionId, task, settings.dispatchPreamble)
      const cmd = buildClaudeCommand({
        sessionId,
        permissionMode: settings.permissionMode,
        model: settings.model,
        effort: settings.effort,
        prompt,
        claudeBin: deps.claudeBin,
        pluginDir: workerPluginDir(),
        extraSystemPrompt: [scratchpadOrientation(sessionId), adoption].join("\n\n"),
      })

      tmux.ensureServer()
      tmux.killSession(slug) // clear any dead remain-on-exit pane holding the name
      // Row is written only AFTER a successful spawn (C1); a spawn failure rolls the scratchpad back
      // and rethrows so the board never shows a stuck row for an adopt that never spawned.
      try {
        spawn(slug, cmd, deps.project.dir, { FRAY_UI_THREAD: slug })
      } catch (err) {
        try {
          rmSync(join(deps.project.dir, scratchRel))
        } catch {
          // best-effort cleanup
        }
        throw err
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
        rested_at: null,
        title_auto: 0, // adopted threads keep their file title
        title: null,
        state: "open",
        meta: null,
        seen_at: null,
        plan_path: null,
      })

      void deps.board.rebuild()
      return { slug, sessionId }
    },
  }
}
