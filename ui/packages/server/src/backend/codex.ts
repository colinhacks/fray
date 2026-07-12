import { join } from "node:path"
import { homedir } from "node:os"
import { readdirSync, statSync, readFileSync, appendFileSync, mkdirSync, realpathSync } from "node:fs"
import type { PermissionMode } from "@fray-ui/shared"
import { applyEvent } from "../tailer.ts"
import type { AgentBackend, BuiltCommand, FoldState, NormalizedEvent, ResumeOpts, SpawnOpts } from "./types.ts"

// CodexBackend: everything Codex-CLI-specific behind the AgentBackend seam (Codex-support epic,
// Phase 2). Unlike ClaudeBackend — which reuses the tailer's corpus-verified applyRecord — codex's
// rollout brackets turns EXPLICITLY (event_msg/task_started .. task_complete), so its turn model maps
// cleanly onto NormalizedEvent and its authoritative fold IS `for (ev of parseLine) applyEvent(state,
// ev)` (the generic driver added in the Phase-2 PREP refactor). This module owns: the interactive-TUI
// spawn/resume argv, the worker-contract injection (prompt-prepend — see the AGENTS.md-placement note
// below), the transcript LOCATION (codex has no --session-id pin, so the rollout id is DISCOVERED
// post-spawn), and the rollout→NormalizedEvent parser. Everything is grounded in real captured
// rollouts from codex-cli 0.144.1 (see ./codex.fixtures/*.jsonl).

// ---- codex home / sessions dir ----
// Codex writes rollouts under $CODEX_HOME/sessions (default ~/.codex/sessions), date-sharded
// (YYYY/MM/DD) with the session UUID embedded in the filename: rollout-<ISO8601>-<uuid>.jsonl.
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim() ? process.env.CODEX_HOME : join(homedir(), ".codex")
}
function sessionsDir(codexHome: string): string {
  return join(codexHome, "sessions")
}

// A discovered rollout must be no older than the spawn (minus a clock-skew tolerance): codex creates
// the file AT session start, so its mtime is >= spawn time. The skew guards against fs mtime coarseness
// / small clock differences between the spawner's `Date.now()` and the filesystem.
const DISCOVERY_SKEW_MS = 10_000
// Defensive cap on how many fresh rollout candidates discovery will open (newest-first). A tight spawn
// window holds only a handful; the cap bounds a pathological "thousands of fresh sessions" scan.
const DISCOVERY_MAX_CANDIDATES = 64

// ---- worker-contract injection (prompt-prepend) ----
// A UNIQUE per-dispatch sentinel embedded in the first prompt so post-spawn discovery can pin the
// exact rollout even when concurrent codex dispatches share one repo cwd (the §6 discovery race). The
// fray-minted `sessionId` (advisory for codex — codex mints its OWN rollout id) is a perfect unique
// key: it rides the first user_message (which the rollout records verbatim) and discovery scans for it.
export function codexSessionSentinel(sessionId: string): string {
  return `fray-session:${sessionId}`
}

// Compose the first user prompt: the worker contract + scratchpad/plan orientation prepended (codex
// has NO --append-system-prompt flag; AGENTS.md pollutes the repo and ~/.codex/AGENTS.md leaks into
// every unrelated codex session — see the placement note in the report). The sentinel rides an
// unobtrusive trailing HTML comment the model ignores but discovery can grep.
function composeSpawnPrompt(o: SpawnOpts): string {
  const sentinel = codexSessionSentinel(o.sessionId)
  return [o.workerContract?.trim(), o.extraSystemPrompt?.trim(), o.prompt, `<!-- ${sentinel} -->`].filter(Boolean).join("\n\n")
}

// ---- spawn / resume argv ----
// Codex reasoning-effort values are {minimal,low,medium,high}; fray's effort enum adds xhigh/max which
// codex doesn't accept — clamp them to "high" (codex's ceiling). Unknown → undefined (codex default).
const CODEX_EFFORTS = new Set(["minimal", "low", "medium", "high"])
export function codexEffort(effort?: string): string | undefined {
  if (!effort) return undefined
  if (CODEX_EFFORTS.has(effort)) return effort
  if (effort === "xhigh" || effort === "max") return "high"
  return undefined
}

// fray permissionMode → codex --sandbox. codex "sandbox" is a different axis than Claude "permission
// mode" (§6), so this is a best-effort map, not an isomorphism: plan → read-only (no writes),
// bypassPermissions → danger-full-access (unrestricted), everything else → workspace-write (edit inside
// the repo, denied elsewhere). Approvals are ALWAYS `never` so an unattended worker NEVER blocks on an
// approval modal (a sandbox-denied action fails back to the model instead of prompting).
export function codexSandbox(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "read-only"
    case "bypassPermissions":
      return "danger-full-access"
    default:
      return "workspace-write"
  }
}

function modelFlags(model?: string): string[] {
  return model && model.trim() ? ["-m", model] : []
}
function effortFlags(effort?: string): string[] {
  const eff = codexEffort(effort)
  return eff ? ["-c", `model_reasoning_effort="${eff}"`] : []
}

export interface CodexBackendOptions {
  codexHome?: string // $CODEX_HOME override (~/.codex); tests inject a tmp dir
  codexBin?: string // dispatch executable ("codex" by default); tests use a stand-in
}

// ---- rollout → NormalizedEvent parser ----
// Every rollout line is {timestamp, type, payload}. The mapping (grounded in captured 0.144.1
// rollouts, §2.2-2.4):
//   event_msg/task_started        → turn-start           (a turn opened → in-flight)
//   event_msg/task_complete       → turn-end(finalText=last_agent_message)  (turn bracketed → idle)
//   event_msg/agent_message       → assistant-text(final = phase==="final_answer")  (text in .message)
//   event_msg/user_message        → user-message (genuine human turn; codex has no synthetic peer echo)
//   response_item/function_call        → tool-call  (args JSON in .arguments, id in .call_id)
//   response_item/function_call_output → tool-result (output in .output, id in .call_id)
//   response_item/custom_tool_call        → tool-call  (freeform tools — apply_patch: .input is the raw
//                                          V4A patch STRING, not a JSON args object; id in .call_id)
//   response_item/custom_tool_call_output → tool-result (output in .output, id in .call_id)
// DELIBERATELY SKIPPED (the no-double-count rule, §6):
//   response_item/message          — the raw API echo of agent_message (role=assistant) AND the prompt
//                                    echo (role=user/developer). Counting it would double the assistant
//                                    text / fabricate user turns. The SEMANTIC events live in event_msg.
//   response_item/reasoning        — encrypted; fray never renders model reasoning.
//   event_msg/token_count, thread_settings_applied, session_meta, turn_context, world_state — sidecar.
// Pure + defensive: a malformed line, or one with no derivable events, yields [].
export function parseCodexLine(line: string): NormalizedEvent[] {
  const s = line.trim()
  if (!s) return []
  let rec: { timestamp?: unknown; type?: unknown; payload?: unknown }
  try {
    const v = JSON.parse(s)
    if (!v || typeof v !== "object") return []
    rec = v as typeof rec
  } catch {
    return []
  }
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  const type = rec.type
  const payload = rec.payload
  if (!payload || typeof payload !== "object") return []
  const p = payload as Record<string, unknown>
  const pt = typeof p.type === "string" ? p.type : undefined

  if (type === "event_msg") {
    switch (pt) {
      case "task_started":
        return [{ kind: "turn-start", at }]
      case "task_complete": {
        // The final message (with the fence) is authoritative here; agent_message/final_answer usually
        // carries the same text a beat earlier, but task_complete is the definitive turn bracket.
        const finalText = typeof p.last_agent_message === "string" ? p.last_agent_message : undefined
        return [{ kind: "turn-end", at, finalText }]
      }
      case "agent_message": {
        const text = typeof p.message === "string" ? p.message : ""
        if (!text) return []
        // phase discriminates the ANSWER (final_answer) from intermediate narration (commentary); only
        // the final answer may carry a done/awaiting excusal fence (a quoted fence in commentary must
        // never excuse the thread — applyEvent's final:false arm refreshes only the preview).
        return [{ kind: "assistant-text", at, text, final: p.phase === "final_answer" }]
      }
      case "user_message": {
        const text = typeof p.message === "string" ? p.message : undefined
        // Codex's rollout has no peer/notification/tool-result-echo user record (Claude's promptSource:
        // "system"), so a user_message is ALWAYS a genuine human turn (synthetic:false → bumps the row).
        return [{ kind: "user-message", at, text, synthetic: false }]
      }
      default:
        return []
    }
  }

  if (type === "response_item") {
    if (pt === "function_call") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const name = typeof p.name === "string" ? p.name : ""
      return [{ kind: "tool-call", at, id, name, input: parseToolArguments(p.arguments) }]
    }
    if (pt === "function_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const text = typeof p.output === "string" ? p.output : stringifyOutput(p.output)
      return [{ kind: "tool-result", at, id, text }]
    }
    // Freeform ("custom") tools — codex delivers apply_patch (its file-edit tool) this way, NOT as a
    // function_call. The payload carries `input` as a RAW STRING (the V4A patch for apply_patch), so we
    // pass it through as-is; the renderer/fold sees a normal tool-call and maps the patch to a diff.
    // Without this, every codex file edit was invisible in the board fold AND the chat drawer.
    if (pt === "custom_tool_call") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const name = typeof p.name === "string" ? p.name : ""
      return [{ kind: "tool-call", at, id, name, input: typeof p.input === "string" ? p.input : (p.input ?? {}) }]
    }
    if (pt === "custom_tool_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : ""
      const text = typeof p.output === "string" ? p.output : stringifyOutput(p.output)
      return [{ kind: "tool-result", at, id, text }]
    }
    // response_item/message (the duplicate) + reasoning (encrypted) are intentionally dropped.
    return []
  }

  // session_meta / turn_context / world_state and any unknown envelope type: sidecar → no events.
  return []
}

// A function_call's `arguments` is a JSON STRING (e.g. {"cmd":"cat x","workdir":"/p"}); parse it to the
// object form (matching Claude tool-call input shape) or fall back to the raw string on any surprise.
function parseToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}
// function_call_output.output is normally a string; defensively flatten a non-string to JSON text.
function stringifyOutput(output: unknown): string {
  if (output == null) return ""
  try {
    return JSON.stringify(output)
  } catch {
    return ""
  }
}

// ---- transcript discovery (codex has NO --session-id pin) ----
// Recursively collect rollout-*.jsonl under $CODEX_HOME/sessions (flat legacy files + date-sharded
// YYYY/MM/DD dirs), spending the budget NEWEST-FIRST so a `budget` truncation can never drop the
// just-spawned rollout: subdirectories are visited in DESCENDING name order (2026 before 2025, the
// newest date shard first) BEFORE this dir's own files, and the flat legacy files that live directly
// under sessions/ (pre-date-sharding, hence oldest) are therefore collected last. Within a dir, files
// sort descending too (rollout-<ISO8601> filenames sort lexically = chronologically). The final
// mtime sort in allRolloutsByMtime still orders results; this ordering only governs WHAT the budget
// keeps. Defensive: any fs error degrades to fewer/no results, never throws.
const descByName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)
function collectRollouts(dir: string, out: { path: string; mtimeMs: number }[], budget: { n: number }): void {
  if (budget.n <= 0) return
  const entries = safeReaddir(dir)
  const dirs = entries.filter((e) => e.isDirectory()).sort(descByName)
  const files = entries.filter((e) => e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")).sort(descByName)
  // Newest date-shards first, so today's shard (holding a fresh spawn) always fits the budget.
  for (const d of dirs) {
    if (budget.n <= 0) return
    collectRollouts(join(dir, d.name), out, budget)
  }
  for (const f of files) {
    if (budget.n <= 0) return
    let mtimeMs: number
    try {
      mtimeMs = statSync(join(dir, f.name)).mtimeMs
    } catch {
      continue
    }
    out.push({ path: join(dir, f.name), mtimeMs })
    budget.n--
  }
}
// readdir with dirents, degrading to [] on any fs error (missing dir, permissions) — never throws.
function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function allRolloutsByMtime(codexHome: string, cap = 4096): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = []
  collectRollouts(sessionsDir(codexHome), out, { n: cap })
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

// Read a rollout's session_meta (first line) → {session_id, cwd}. Defensive: unreadable/misshaped → {}.
function readSessionMeta(path: string): { sessionId?: string; cwd?: string } {
  let firstLine: string
  try {
    // The first line is session_meta; reading the whole file is fine (callers only do this for the small
    // set of fresh candidates), but slice at the first newline to keep it cheap.
    const content = readFileSync(path, "utf8")
    const nl = content.indexOf("\n")
    firstLine = nl === -1 ? content : content.slice(0, nl)
  } catch {
    return {}
  }
  try {
    const rec = JSON.parse(firstLine.trim())
    const p = rec?.payload
    if (!p || typeof p !== "object") return {}
    const sessionId = typeof p.session_id === "string" ? p.session_id : undefined
    const cwd = typeof p.cwd === "string" ? p.cwd : undefined
    return { sessionId, cwd }
  } catch {
    return {}
  }
}

// Canonicalize a path for cwd comparison (codex stores the REAL cwd, e.g. /private/tmp/..). Falls back
// to the raw string when realpath fails (path gone) so a match is still possible.
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export interface DiscoverOpts {
  cwd: string
  spawnedAtMs: number
  sentinel?: string // preferred disambiguator for concurrent same-cwd dispatches (the fray sessionId)
  codexHome?: string
}

// Resolve the rollout a freshly-spawned codex session wrote — the core of the §6 discovery spike.
// Strategy (most-reliable first):
//   1. SENTINEL: among fresh rollouts, the one whose transcript contains the unique per-dispatch
//      sentinel (embedded in the first prompt by buildSpawn). Race-proof across concurrent same-cwd
//      dispatches — each has a distinct sentinel appearing in exactly one rollout.
//   2. CWD + NEWEST: no sentinel (or none matched) → the newest fresh rollout whose session_meta.cwd
//      matches. Correct when dispatches are serialized; racy under true concurrency (hence the sentinel).
// Returns {sessionId, path} or undefined if nothing fresh matches (caller retries next tick — the
// rollout may not be written yet).
export function discoverCodexRollout(opts: DiscoverOpts): { sessionId: string; path: string } | undefined {
  const codexHome = opts.codexHome ?? defaultCodexHome()
  const floor = opts.spawnedAtMs - DISCOVERY_SKEW_MS
  const fresh = allRolloutsByMtime(codexHome).filter((r) => r.mtimeMs >= floor).slice(0, DISCOVERY_MAX_CANDIDATES)
  const wantCwd = canonical(opts.cwd)

  // 1. sentinel match (scan candidate contents newest-first).
  if (opts.sentinel) {
    for (const cand of fresh) {
      let content: string
      try {
        content = readFileSync(cand.path, "utf8")
      } catch {
        continue
      }
      if (content.includes(opts.sentinel)) {
        const meta = readSessionMeta(cand.path)
        if (meta.sessionId) return { sessionId: meta.sessionId, path: cand.path }
      }
    }
  }

  // 2. cwd + newest fallback.
  for (const cand of fresh) {
    const meta = readSessionMeta(cand.path)
    if (!meta.sessionId) continue
    if (meta.cwd && canonical(meta.cwd) === wantCwd) return { sessionId: meta.sessionId, path: cand.path }
  }
  return undefined
}

// Locate an ALREADY-DISCOVERED session's rollout by its codex id (filename suffix -<id>.jsonl). Used by
// the tailer once the id is pinned on the registry row. Returns the path or undefined (not yet written).
export function findRolloutById(sessionId: string, codexHome = defaultCodexHome()): string | undefined {
  const suffix = `-${sessionId}.jsonl`
  for (const r of allRolloutsByMtime(codexHome)) {
    if (r.path.endsWith(suffix)) return r.path
  }
  return undefined
}

// ---- trust-gate pre-arm (the interactive TUI blocks on an untrusted dir) ----
// The `codex` TUI (unlike `codex exec`) shows a blocking "Do you trust this directory?" modal for any
// cwd not recorded as trusted in $CODEX_HOME/config.toml — an unattended worker would hang on it
// forever, and NEITHER -a never NOR --dangerously-bypass-approvals-and-sandbox skips it (verified).
// The persisted-trust entry a user's "Yes" writes is the only reliable bypass. This idempotently
// appends it when absent (and NEVER overrides an existing [projects."<cwd>"] block — respecting a
// user's own trust choice). The dispatch layer must call this BEFORE spawning a codex TUI.
export function ensureCwdTrusted(cwd: string, codexHome = defaultCodexHome()): void {
  const real = canonical(cwd)
  const configPath = join(codexHome, "config.toml")
  let content = ""
  try {
    content = readFileSync(configPath, "utf8")
  } catch {
    content = ""
  }
  const header = `[projects."${real}"]`
  if (content.includes(header)) return // already declared (trusted or otherwise) — respect it
  try {
    mkdirSync(codexHome, { recursive: true })
    const sep = content === "" || content.endsWith("\n") ? "" : "\n"
    appendFileSync(configPath, `${sep}\n[projects."${real}"]\ntrust_level = "trusted"\n`)
  } catch {
    // best-effort: a write failure just means the worker may hit the trust modal — surfaced, not fatal.
  }
}

export function createCodexBackend(opts: CodexBackendOptions = {}): AgentBackend {
  const codexHome = opts.codexHome ?? defaultCodexHome()
  const bin = opts.codexBin ?? "codex"

  return {
    kind: "codex",

    buildSpawn(o: SpawnOpts): BuiltCommand {
      // codex --cd <cwd> [-m <model>] -s <sandbox> -a never [-c model_reasoning_effort=<eff>] <prompt>
      const argv = [
        bin,
        "--cd",
        o.cwd,
        ...modelFlags(o.model),
        "-s",
        codexSandbox(o.permissionMode),
        "-a",
        "never",
        ...effortFlags(o.effort),
        composeSpawnPrompt(o),
      ]
      // No prewrite: the worker contract rides the prompt (see the AGENTS.md-placement note). The
      // trust-gate pre-arm (ensureCwdTrusted) is a config MERGE the dispatch layer runs separately — it
      // can't be expressed as a whole-file prewrite without clobbering the user's config.
      return { argv, env: {}, prewrite: [] }
    },

    buildResume(o: ResumeOpts): BuiltCommand {
      // codex resume [-C cwd] -a never -s <sandbox> <sessionId> <message>. `o.sessionId` is the
      // DISCOVERED codex rollout id (pinned on the row). Model/effort are NOT re-sent — a resumed
      // conversation can't be retargeted (mirrors ClaudeBackend). The scratchpad orientation rides the
      // message; the worker contract is already in conversation history from turn 1.
      const message = [o.extraSystemPrompt?.trim(), o.message].filter(Boolean).join("\n\n")
      const argv = [bin, "resume", "--cd", o.cwd, "-a", "never", "-s", codexSandbox(o.permissionMode), o.sessionId, message]
      return { argv, env: {}, prewrite: [] }
    },

    // Codex's id is minted by codex and not known until it writes session_meta, so there is no
    // deterministic path from the fray-advisory sessionId. Once the DISCOVERED id is pinned on the row,
    // the tailer calls this with that id and we locate the (date-sharded) rollout by filename suffix.
    transcriptPath(sessionId: string): string | undefined {
      return findRolloutById(sessionId, codexHome)
    },

    // Post-spawn discovery (the tailer resolves the id, then pins it on the row). The AgentBackend
    // signature carries no sentinel; the sentinel path (race-proof) is reached via discoverCodexRollout
    // directly by the dispatch wiring, which knows the fray sessionId. Here we do the cwd+newest match.
    discoverSession(cwd: string, spawnedAtMs: number): { sessionId: string; path: string } | undefined {
      return discoverCodexRollout({ cwd, spawnedAtMs, codexHome })
    },

    // Codex's rollout brackets turns explicitly, so — unlike Claude — its authoritative fold DOES route
    // through the normalized union: drive parseCodexLine through the generic applyEvent. Pure/defensive
    // (a bad line → parseCodexLine [] → no applyEvent calls).
    parseLine(line: string): NormalizedEvent[] {
      return parseCodexLine(line)
    },

    foldLine(state: FoldState, line: string): void {
      for (const ev of parseCodexLine(line)) applyEvent(state, ev)
    },

    // matchesPermPrompt is intentionally OMITTED: codex runs with `-a never`, so no in-turn approval
    // modal ever appears (the one-time trust-directory modal is pre-armed away by ensureCwdTrusted).
  }
}
