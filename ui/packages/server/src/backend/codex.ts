import { join } from "node:path"
import { homedir } from "node:os"
import { readdirSync, statSync, readFileSync, appendFileSync, mkdirSync, realpathSync } from "node:fs"
import type { PermissionMode } from "@fray-ui/shared"
import { applyEvent } from "../tailer.ts"
import type { AgentBackend, BuiltCommand, FoldState, NativeInputRequiredData, NormalizedEvent, ResumeOpts, SpawnOpts, SpawnThreadMcp } from "./types.ts"

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

// The fixed worker contract still travels in the first user turn, but title creation has a stronger,
// invocation-scoped instruction below. Keep this tiny user-turn reminder as a redundant compatibility
// belt: it is machine metadata, stripped from the chat by the transcript projector, and requests an
// invisible attribute-style comment rather than a visible Markdown heading.
export const CODEX_FIRST_FINAL_TITLE_TRANSPORT =
  'FRAY TITLE TRANSPORT (required): your very first assistant message must begin with one concise `<!-- fray title="Concise thread title" -->` comment before any commentary, acknowledgement, or tool call. Fray removes that comment from chat and uses only its quoted title as this thread\'s automatic title.'

// Codex exposes no dedicated `--append-system-prompt` flag, but its documented `-c` overrides accept
// the `developer_instructions` config key for one invocation. Use that higher-priority, non-rendered
// surface for the small title protocol instead of relying on a task-adjacent user instruction alone.
// The full worker contract stays in the prompt because sending ~18KB as a `-c` value would reintroduce
// tmux's command-length failure. This instruction is spawn-only: replaying it on `codex resume` would
// incorrectly request a second title from an existing conversation.
export const CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS =
  'FRAY UI metadata protocol (mandatory): the very first assistant message in this new session, before any commentary, acknowledgement, tool call, or other action, MUST begin on its first line with exactly one `<!-- fray title="..." -->` HTML comment. Replace `...` with a concise human-readable 3-8 word title for the user\'s task. Put no text before the comment. You may continue the message normally after it. Emit this title comment exactly once. Do not explain the protocol. Fray removes the comment before displaying the conversation.'

function firstOutputTitleDeveloperInstructionFlags(): string[] {
  // JSON strings are valid TOML basic strings, which preserves quotes/backslashes without shell
  // interpretation because argv is passed directly. `-c` applies only to this Codex process.
  return ["-c", `developer_instructions=${JSON.stringify(CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS)}`]
}

// Historical first prompts used a visible H1 as the transport. It remains a parse-compatible title
// signal, and the transcript projector recognizes this exact retired trailer so old dispatch metadata
// never appears as human chat content.
export const CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT =
  "FRAY TITLE TRANSPORT (required): on your first final answer, put one concise `# Title` H1 on its first line before the answer. Fray removes that H1 from chat and uses it only as this thread's automatic title."

// Compose the first user prompt: the worker contract + scratchpad/plan orientation prepended (codex
// has NO --append-system-prompt flag; AGENTS.md pollutes the repo and ~/.codex/AGENTS.md leaks into
// every unrelated codex session — see the placement note in the report). The sentinel rides an
// unobtrusive trailing HTML comment the model ignores but discovery can grep.
function composeSpawnPrompt(o: SpawnOpts): string {
  const sentinel = codexSessionSentinel(o.sessionId)
  return [
    o.workerContract?.trim(),
    o.extraSystemPrompt?.trim(),
    o.prompt,
    CODEX_FIRST_FINAL_TITLE_TRANSPORT,
    `<!-- ${sentinel} -->`,
  ].filter(Boolean).join("\n\n")
}

// ---- spawn / resume argv ----
// Codex reasoning-effort universe (per ~/.codex/models_cache.json): low/medium/high/xhigh/max/ultra.
// It is PER-MODEL which of these a given model accepts (gpt-5.6-sol/terra → all six, luna → …max, 5.5 →
// …xhigh) — that gating happens in the UI, which offers only the chosen model's cache `efforts`. This
// server-side check is just the OUTER universe: pass through any real codex effort (no more max→xhigh
// clamp, which WRONGLY downgraded a 5.6 model that supports max/ultra); only a genuinely-unknown value →
// undefined (codex then uses the model's default_reasoning_level).
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"])
export function codexEffort(effort?: string): string | undefined {
  if (!effort) return undefined
  if (CODEX_EFFORTS.has(effort)) return effort
  return undefined
}

// A Fray UI worker already owns one dashboard effort. Suppress only the portfolio-orchestrator
// skill—standalone, plugin-qualified, and legacy names—while leaving every unrelated skill and the
// native `fray.*` Multi-Agent v2 tool namespace available. This is a session flag, not a persisted
// user-config mutation, and must be applied on both spawn and resume.
export const FRAY_UI_DISABLED_SKILLS_CONFIG =
  'skills.config=[{name="fray-orchestrator",enabled=false},{name="fray-codex:fray-orchestrator",enabled=false},{name="fray",enabled=false},{name="fray-codex:fray",enabled=false}]'

// These are deliberately process-scoped. A Fray UI worker needs the native V2 surface, but must not
// rewrite the operator's $CODEX_HOME/config.toml (or install the orchestrator plugin) to obtain it.
// The cap is intentionally conservative for a dashboard-owned worker session.
export const FRAY_UI_MAX_CONCURRENT_THREADS = 4
export const FRAY_UI_MULTI_AGENT_V2_CONFIG = [
  "features.multi_agent_v2.enabled=true",
  "features.multi_agent_v2.hide_spawn_agent_metadata=false",
  'features.multi_agent_v2.tool_namespace="fray"',
  `features.multi_agent_v2.max_concurrent_threads_per_session=${FRAY_UI_MAX_CONCURRENT_THREADS}`,
] as const

function frayUiRoutingFlags(): string[] {
  return FRAY_UI_MULTI_AGENT_V2_CONFIG.flatMap((config) => ["-c", config])
}

function workerSkillIsolationFlags(): string[] {
  return ["-c", FRAY_UI_DISABLED_SKILLS_CONFIG]
}

// Mount the fray spawn-thread MCP server as an ADDITIVE, process-scoped `-c` override — it deep-merges
// onto the operator's own `[mcp_servers.*]` and NEVER touches ~/.codex/config.toml on disk (verified:
// `codex mcp list --json` shows both fray_spawn and the user's servers). The `-c` value is parsed as
// TOML, so the path/table values are TOML basic strings (only `\` and `"` need escaping). Codex runs
// with `-a never`, so the tool executes without an approval prompt. A namespaced id (`fray_spawn`)
// avoids overriding a user's own server. Absent descriptor → no flags (parity with Claude).
function codexSpawnThreadMcpFlags(mcp?: SpawnThreadMcp): string[] {
  if (!mcp) return []
  const toml = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return [
    "-c", "mcp_servers.fray_spawn.command=node",
    "-c", `mcp_servers.fray_spawn.args=["${toml(mcp.scriptPath)}"]`,
    "-c", `mcp_servers.fray_spawn.env={FRAY_STATE_DIR="${toml(mcp.stateDir)}"}`,
  ]
}

// ---- opinionated Codex output defaults (process-scoped, presence-gated) ----
// Saner Codex defaults for a fray worker whose operator hasn't tuned Codex themselves — terse output,
// DETAILED reasoning summary, the pragmatic personality. These are the community-favorite starting
// points, injected as one-shot `-c` overrides so we NEVER write the operator's config or their repo.
//
// `model_reasoning_summary` is DETAILED (not concise) because Fray renders the reasoning summary as an
// expandable "train of thought" block: concise emits a single bold header per turn, so the block has
// nothing to expand; detailed emits the full sequence of reasoning steps the block is there to show.
//
// Critically these are DEFAULTS, not overrides: `codex -c` is Codex's HIGHEST-precedence layer (it
// beats config.toml), so we inject a key ONLY when the operator has not set it themselves. Anyone who
// declares the key — top-level or inside a [profiles.*] block — ALWAYS wins, which also makes "set it
// yourself" the opt-out. A UI-selected model/effort travels on its own axis (modelFlags/effortFlags);
// model_reasoning_effort is deliberately NOT one of these so the dashboard's effort control still leads.
export const FRAY_CODEX_OUTPUT_DEFAULTS: ReadonlyArray<readonly [key: string, value: string]> = [
  ["model_reasoning_summary", "detailed"],
  ["model_verbosity", "low"],
  ["personality", "pragmatic"],
]

// Active-assignment presence check (mirrors ensureCwdTrusted's string-level, TOML-dep-free approach):
// the key at the head of an assignment. Left-anchored on line start OR a `.` so it catches a bare
// top-level key, a key inside any [profiles.*] table, AND a dotted spelling (`profiles.fast.personality
// = …`); the optional surrounding quotes catch TOML quoted keys (`"personality" = …`, `'personality'
// = …`). All of these are the SAME key to TOML, so treating any of them as "declared" is what keeps the
// never-override invariant honest — a bare-identifier regex would false-negative on the quoted/dotted
// forms and we'd inject a `-c` override on top of the operator's own value. Comments (`# key = …`) and
// prose stay ignored (the `#` sits between the anchor and the key). Fail-safe direction: if we can read
// the file and see the key assigned anywhere — even in an inactive profile — we DEFER to the operator
// and skip our default; an unreadable/absent config means nothing is declared, so all defaults apply.
// Keys are fixed literals with no regex metacharacters, so no escaping is needed.
function codexConfigDeclaresKey(configText: string, key: string): boolean {
  return new RegExp(`(^|\\n|\\.)\\s*["']?${key}["']?\\s*=`).test(configText)
}

function outputDefaultFlags(codexHome: string): string[] {
  let configText = ""
  try {
    configText = readFileSync(join(codexHome, "config.toml"), "utf8")
  } catch {
    configText = "" // no config (or unreadable) → operator declared nothing → apply every default
  }
  return FRAY_CODEX_OUTPUT_DEFAULTS.flatMap(([key, value]) =>
    codexConfigDeclaresKey(configText, key) ? [] : ["-c", `${key}="${value}"`],
  )
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

// ---- native TUI modal detection ----
// Codex does not record connector/tool approvals (or its own selection/confirmation menus) in the
// rollout. They exist only in the rendered pane, so Fray recognizes the small set of 0.144.1 modal
// families we have captured. Detection is deliberately BOTTOM-ANCHORED on the modal's exact footer:
// prompt-like prose in transcript history is ignored once Codex's ordinary composer/status footer is
// below it. We also require the selector + multiple independent family markers. Most importantly, the
// return value is fixed presentation copy — repository/content/commands/options never leave the server.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const SUBMIT_FOOTER = /^enter to submit\s*\|\s*esc to cancel$/i
const CONFIRM_FOOTER = /^press enter to confirm or esc to go back$/i
const SELECTED_OPTION = /^[›>]\s*\d+\.\s+\S/
const OPTION = /^(?:[›>]\s*)?\d+\.\s+\S/
const CANCEL_OPTION = /^(?:[›>]\s*)?\d+\.\s+Cancel\b/i

function codexModalTail(pane: string): { lines: string[]; footer: "submit" | "confirm" } | undefined {
  if (!pane) return undefined
  const lines = pane
    .replace(ANSI_RE, "")
    .replace(/\r/g, "")
    .split("\n")
  while (lines.length && !lines.at(-1)?.trim()) lines.pop()
  const last = lines.at(-1)?.trim() ?? ""
  const footer = SUBMIT_FOOTER.test(last) ? "submit" : CONFIRM_FOOTER.test(last) ? "confirm" : undefined
  if (!footer) return undefined
  // A Codex modal fits comfortably in 32 rows. Bounding the window prevents matching a stale family
  // heading or option block much earlier in a long pane while a different footer happens to be last.
  return { lines: lines.slice(-32, -1).map((line) => line.trim()), footer }
}

export function detectCodexNativeInput(pane: string): NativeInputRequiredData | undefined {
  const modal = codexModalTail(pane)
  if (!modal) return undefined
  const { lines, footer } = modal
  const options = lines.filter((line) => OPTION.test(line))
  if (options.length < 2 || !lines.some((line) => SELECTED_OPTION.test(line))) return undefined

  // Human-owned `/permissions` menu and its Full Access confirmation. Fray's controller never drives
  // these selectors; it reopens only an idle saved conversation with the documented launch flag.
  if (
    footer === "confirm" &&
    lines.includes("Update Model Permissions") &&
    lines.some((line) => /^(?:[›>]\s*)?1\.\s+Ask for approval$/i.test(line)) &&
    lines.some((line) => /^(?:[›>]\s*)?2\.\s+Approve for me$/i.test(line)) &&
    lines.some((line) => /^(?:[›>]\s*)?3\.\s+Full Access$/i.test(line))
  ) {
    return { kind: "permission", title: "Choose model permissions" }
  }
  if (
    footer === "confirm" &&
    lines.includes("Enable full access?") &&
    lines.some((line) => /^(?:[›>]\s*)?1\.\s+Yes, continue anyway$/i.test(line)) &&
    lines.some((line) => /^(?:[›>]\s*)?2\.\s+Yes, and don't ask again$/i.test(line)) &&
    lines.some((line) => /^(?:[›>]\s*)?3\.\s+Cancel$/i.test(line))
  ) {
    return { kind: "permission", title: "Confirm full access" }
  }

  const hasFieldCounter = lines.some((line) => /^Field \d+\/\d+$/i.test(line))
  const hasCancel = lines.some((line) => CANCEL_OPTION.test(line))
  const question = lines.find((line) => /\?$/.test(line))

  // Captured connector approval family, e.g. "Allow GitHub to create a Git blob?". Require all of:
  // Field counter, Allow question, selected first Allow option, Cancel option, and submit footer.
  if (
    footer === "submit" &&
    hasFieldCounter &&
    hasCancel &&
    question &&
    /^Allow\b.*\?$/.test(question) &&
    lines.some((line) => /^[›>]\s*1\.\s+Allow\b/i.test(line))
  ) {
    return {
      kind: "tool-approval",
      title: /^Allow GitHub\b/i.test(question) ? "GitHub tool approval required" : "Tool approval required",
    }
  }

  // Other verified Codex field selectors share the Field x/y counter, numbered selector, Cancel, and
  // submit footer. We expose only the family. A yes/confirm/continue first option is a confirmation;
  // otherwise it is a selection. Unknown modal shapes fail closed (undefined).
  if (footer === "submit" && hasFieldCounter && hasCancel) {
    const affirmative = lines.some((line) => /^[›>]\s*1\.\s+(?:Yes\b|Confirm\b|Continue\b)/i.test(line))
    return affirmative
      ? { kind: "confirmation", title: "Confirmation required" }
      : { kind: "selection", title: "Terminal choice required" }
  }

  return undefined
}

function modelFlags(model?: string): string[] {
  return model && model.trim() ? ["-m", model] : []
}
function effortFlags(effort?: string): string[] {
  const eff = codexEffort(effort)
  return eff ? ["-c", `model_reasoning_effort="${eff}"`] : []
}
const NO_STARTUP_UPDATE_PROMPT = ["-c", "check_for_update_on_startup=false"]

export interface CodexBackendOptions {
  codexHome?: string // $CODEX_HOME override (~/.codex); tests inject a tmp dir
  codexBin?: string // dispatch executable ("codex" by default); tests use a stand-in
}

const FRAY_TITLE_MAX = 200
// The current, invisible title transport. Keep it intentionally strict: a first-line Fray comment
// with exactly one quoted title attribute. An ordinary HTML comment must remain ordinary prose.
const FRAY_TITLE_ATTRIBUTE = /^<!--\s*fray\s+title="((?:[^"\\\r\n]|\\[^\r\n])*)"\s*-->(?:\r?\n|$)/
const FRAY_TITLE_LINE = /^<!-- fray-title: (.*) -->(?:\r?\n|$)/
const FRAY_TITLE_H1 = /^# ([^\r\n]*)(?:\r?\n|$)/
// Unicode's Bidi_Control property includes ALM/LRM/RLM as well as the embedding, override, and
// isolate ranges; a handwritten range is easy to leave incomplete. Default-ignorables are likewise
// replaced unless they carry real shaping/emoji semantics (joiners, variation selectors, emoji tags).
const TITLE_CONTROL_OR_BIDI = /[\p{Cc}\p{Bidi_Control}]/u
const TITLE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
const TITLE_MARK = /\p{M}/u
const TITLE_GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" })

function titleCodePoint(char: string | undefined): number | undefined {
  return char?.codePointAt(0)
}

function isTitleVariationSelector(codePoint: number | undefined): boolean {
  return codePoint !== undefined && (
    (codePoint >= 0x180b && codePoint <= 0x180d) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  )
}

// A base must have independently visible content. Marks and default-ignorables can modify a base but
// cannot make an otherwise invisible title valid on their own.
function isVisibleTitleBase(char: string | undefined): boolean {
  return Boolean(
    char &&
    !/\s/u.test(char) &&
    !TITLE_MARK.test(char) &&
    !TITLE_CONTROL_OR_BIDI.test(char) &&
    !TITLE_DEFAULT_IGNORABLE.test(char),
  )
}

function hasVisibleBaseBeforeAttachedModifiers(chars: string[], index: number): boolean {
  let before = index - 1
  while (
    before >= 0 &&
    (TITLE_MARK.test(chars[before]) || isTitleVariationSelector(titleCodePoint(chars[before])))
  ) before--
  return isVisibleTitleBase(chars[before])
}

function emojiTagIndexes(chars: string[]): Set<number> {
  const meaningful = new Set<number>()
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].codePointAt(0) !== 0x1f3f4) continue // BLACK FLAG is the emoji tag-sequence base
    let end = i + 1
    while (end < chars.length) {
      const codePoint = chars[end].codePointAt(0)!
      if (codePoint < 0xe0020 || codePoint > 0xe007e) break
      end++
    }
    if (end === i + 1 || chars[end]?.codePointAt(0) !== 0xe007f) continue // CANCEL TAG terminator
    for (let tag = i + 1; tag <= end; tag++) meaningful.add(tag)
    i = end
  }
  return meaningful
}

function meaningfulTitleDefaultIgnorable(
  chars: string[],
  codePoint: number,
  index: number,
  semanticEmojiTags: Set<number>,
): boolean {
  if (semanticEmojiTags.has(index)) return true // only inside a complete black-flag tag sequence
  if (isTitleVariationSelector(codePoint)) return isVisibleTitleBase(chars[index - 1])
  if (codePoint !== 0x200c && codePoint !== 0x200d) return false

  // ZWNJ/ZWJ must connect meaningful content on both sides. The left base may carry attached marks
  // (for example Devanagari virama) and/or variation selectors before the joiner; walk through that
  // modifier sequence, but keep the right-side visible-base requirement immediate and strict.
  return hasVisibleBaseBeforeAttachedModifiers(chars, index) && isVisibleTitleBase(chars[index + 1])
}

function sanitizeFrayTitleValue(raw: string): string {
  const chars = Array.from(raw)
  const semanticEmojiTags = emojiTagIndexes(chars)
  let safe = ""
  for (const [index, char] of chars.entries()) {
    const codePoint = char.codePointAt(0)!
    const unsafe =
      TITLE_CONTROL_OR_BIDI.test(char) ||
      (TITLE_DEFAULT_IGNORABLE.test(char) && !meaningfulTitleDefaultIgnorable(
        chars,
        codePoint,
        index,
        semanticEmojiTags,
      ))
    safe += unsafe ? " " : char
  }
  const normalized = safe.replace(/\s+/g, " ").trim()
  return Array.from(normalized).some(isVisibleTitleBase) ? normalized : ""
}

// Retain the historical 200-code-point bound, but stop before a whole grapheme that would cross it.
// The caller sanitizes once more afterward because some scripts place ZWNJ at a grapheme boundary;
// that second pass removes any joiner/selector/tag that truncation could otherwise orphan.
function capFrayTitleValue(raw: string): string {
  let count = 0
  let capped = ""
  for (const { segment } of TITLE_GRAPHEME_SEGMENTER.segment(raw)) {
    const size = Array.from(segment).length
    if (count + size > FRAY_TITLE_MAX) break
    capped += segment
    count += size
  }
  return sanitizeFrayTitleValue(capped)
}

export interface CodexFrayTitleSignal {
  text: string
  title?: string
  markerFound: boolean
}

function decodeFrayTitleAttribute(value: string): string {
  const backslashDecoded = value.replace(/\\(.)/g, (_whole, escaped: string) => {
    switch (escaped) {
      case "n": return "\n"
      case "r": return "\r"
      case "t": return "\t"
      default: return escaped
    }
  })
  return backslashDecoded
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
}

// New workers emit a first-line attribute comment, which is invisible Markdown and carries a concise
// display title. H1 and `fray-title:` remain parse-only compatibility for already-running/old sessions.
// Every recognized transport is strict first-line only: ordinary comments and later headings stay prose.
export function extractCodexFrayTitle(text: string, allowLegacy = true): CodexFrayTitleSignal {
  const attribute = text.match(FRAY_TITLE_ATTRIBUTE)
  const h1 = attribute || !allowLegacy ? undefined : text.match(FRAY_TITLE_H1)
  const comment = attribute || h1 || !allowLegacy ? undefined : text.match(FRAY_TITLE_LINE)
  const match = attribute ?? h1 ?? comment
  if (!match) return { text, markerFound: false }
  let visible = text.slice(match[0].length)
  // During the prior H1 transition a worker could emit an H1 followed by the old sidecar. Keep that
  // compatibility pair hidden; the new comment transport is fully self-contained.
  if (h1) {
    const compatibility = visible.match(FRAY_TITLE_LINE)
    if (compatibility) visible = visible.slice(compatibility[0].length)
  }
  let title = sanitizeFrayTitleValue(attribute ? decodeFrayTitleAttribute(match[1]) : match[1])
  // Angle brackets would make the supposedly one-line value look like markup on another surface.
  if (!title || /[<>]/.test(title)) return { text: visible, markerFound: true }
  title = capFrayTitleValue(title)
  return { text: visible, title: title || undefined, markerFound: true }
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
//   response_item/reasoning        — the raw chain-of-thought (`encrypted_content`) is opaque and
//                                    stays dropped, BUT the plaintext `summary[]` (present because Fray
//                                    launches codex with model_reasoning_summary; see FRAY_CODEX_OUTPUT_DEFAULTS) is
//                                    surfaced as a `reasoning` event → an expandable summary block.
//   event_msg/token_count, thread_settings_applied, session_meta, turn_context, world_state — sidecar
//   for the renderable event stream. turn_context's model/effort are folded separately as session
//   profile telemetry (parseCodexSessionProfile), never emitted as conversation content.
// Pure + defensive: a malformed line, or one with no derivable events, yields [].
export function parseCodexSessionProfile(
  line: string,
): { model?: string; effort?: string; profileAt?: string; permissionMode?: PermissionMode; permissionModeAt?: string } | undefined {
  const s = line.trim()
  if (!s) return undefined
  let rec: unknown
  try {
    rec = JSON.parse(s)
  } catch {
    return undefined
  }
  if (!rec || typeof rec !== "object") return undefined
  const envelope = rec as { timestamp?: unknown; type?: unknown; payload?: unknown }
  if (!envelope.payload || typeof envelope.payload !== "object") return undefined
  const outer = envelope.payload as Record<string, unknown>
  const isTurnContext = envelope.type === "turn_context"
  const isThreadSettings =
    envelope.type === "event_msg" && outer.type === "thread_settings_applied" && outer.thread_settings && typeof outer.thread_settings === "object"
  if (!isTurnContext && !isThreadSettings) return undefined
  const payload = (isThreadSettings ? outer.thread_settings : outer) as Record<string, unknown>
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined
  let effort = typeof payload.effort === "string" && payload.effort.trim() ? payload.effort.trim() : undefined
  // Some codex versions repeat the value only under collaboration_mode.settings.
  if (!effort && payload.collaboration_mode && typeof payload.collaboration_mode === "object") {
    const settings = (payload.collaboration_mode as { settings?: unknown }).settings
    if (settings && typeof settings === "object") {
      const nested = (settings as { reasoning_effort?: unknown }).reasoning_effort
      if (typeof nested === "string" && nested.trim()) effort = nested.trim()
    }
  }
  const sandbox = payload.sandbox_policy && typeof payload.sandbox_policy === "object"
    ? (payload.sandbox_policy as { type?: unknown }).type
    : undefined
  const profile = payload.permission_profile && typeof payload.permission_profile === "object"
    ? (payload.permission_profile as { type?: unknown }).type
    : undefined
  const active = payload.active_permission_profile && typeof payload.active_permission_profile === "object"
    ? (payload.active_permission_profile as { id?: unknown }).id
    : undefined
  let permissionMode: PermissionMode | undefined
  if (sandbox === "danger-full-access" || profile === "disabled" || active === ":danger-full-access") permissionMode = "bypassPermissions"
  else if (sandbox === "read-only" || active === ":read-only") permissionMode = "plan"
  else if (sandbox === "workspace-write" || profile === "managed" || active === ":workspace") permissionMode = "default"
  const permissionModeAt = permissionMode && typeof envelope.timestamp === "string" ? envelope.timestamp : undefined
  const profileAt = (model || effort) && typeof envelope.timestamp === "string" ? envelope.timestamp : undefined
  return model || effort || permissionMode ? { model, effort, profileAt, permissionMode, permissionModeAt } : undefined
}

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
    if (pt === "reasoning") {
      // The raw CoT (`encrypted_content`) is opaque, but codex also emits a plaintext `summary`: an
      // array of {type:"summary_text", text} items (the gray reasoning headers its TUI shows), present
      // because Fray sets model_reasoning_summary. Join the items into one markdown body and surface it
      // as a reasoning event. An empty/absent summary (encryption-only) yields no event — unchanged.
      const summary = Array.isArray(p.summary) ? p.summary : []
      const text = summary
        .map((it) => (it && typeof it === "object" && typeof (it as { text?: unknown }).text === "string" ? (it as { text: string }).text : ""))
        .filter((t) => t.trim())
        .join("\n\n")
      return text ? [{ kind: "reasoning", at, text }] : []
    }
    // response_item/message (the duplicate API echo) is intentionally dropped.
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
// Legacy function-call results are strings. Unified custom-tool results are an ordered response-content
// array (`[{type:"input_text",text}, …]`) — flatten those text blocks in order so transcript parsing
// can recover the wrapper status/result instead of receiving an opaque one-line JSON serialization.
// Unknown structured results still degrade to JSON text.
function stringifyOutput(output: unknown): string {
  if (output == null) return ""
  if (Array.isArray(output)) {
    const parts = output.flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const p = part as Record<string, unknown>
      if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") return [p.text]
      if ((p.type === "input_image" || p.type === "output_image" || p.type === "image") && (typeof p.image_url === "string" || typeof p.url === "string")) return ["[image output]"]
      return []
    })
    if (parts.length) return parts.join("")
  }
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
  // Filesystems commonly give concurrent rollouts the same coarse mtime. Keep ordering deterministic
  // in that case; sentinel discovery does not depend on the order, while legacy cwd-only callers get a
  // stable newest-filename tie-break instead of readdir-order roulette.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
  return out
}

// Parse a rollout's session_meta (first line) → {session_id, cwd}. Keeping sentinel + meta parsing on
// one read snapshot prevents a growing/partially-rewritten file from mixing two observations.
function parseSessionMeta(content: string): { sessionId?: string; cwd?: string } {
  const nl = content.indexOf("\n")
  const firstLine = nl === -1 ? content : content.slice(0, nl)
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

// Read-side wrapper used by legacy cwd matching and id lookup. Unreadable/partial/misshaped → {};
// dispatch polling will simply retry after Codex appends the rest of the record.
function readSessionMeta(path: string): { sessionId?: string; cwd?: string } {
  try {
    return parseSessionMeta(readFileSync(path, "utf8"))
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
  // When present, this is an exact ownership proof, not a preference. Discovery must never degrade to
  // cwd-only matching: concurrent Codex starts legitimately share cwd and can have tied mtimes.
  sentinel?: string
  codexHome?: string
}

// Resolve the rollout a freshly-spawned codex session wrote — the core of the §6 discovery spike.
// Strategy is deliberately exclusive:
//   - SENTINEL PROVIDED: return only a fresh rollout containing that exact sentinel, with a complete
//     session_meta whose cwd also matches. A partial file is a miss for this poll, never permission to
//     claim a same-cwd neighbor.
//   - NO SENTINEL (legacy AgentBackend caller): retain newest cwd matching for backward compatibility.
// Returns {sessionId, path} or undefined if nothing fresh matches (caller retries next tick — the
// rollout may not be written yet).
export function discoverCodexRollout(opts: DiscoverOpts): { sessionId: string; path: string } | undefined {
  const codexHome = opts.codexHome ?? defaultCodexHome()
  const floor = opts.spawnedAtMs - DISCOVERY_SKEW_MS
  const allFresh = allRolloutsByMtime(codexHome).filter((r) => r.mtimeMs >= floor)
  const cutoff = allFresh[Math.min(allFresh.length, DISCOVERY_MAX_CANDIDATES) - 1]?.mtimeMs
  // Never split an mtime tie at the candidate cap: concurrent starts can all share the cutoff mtime.
  const fresh = allFresh.filter((r, index) => index < DISCOVERY_MAX_CANDIDATES || r.mtimeMs === cutoff)
  const wantCwd = canonical(opts.cwd)

  if (opts.sentinel !== undefined) {
    if (!opts.sentinel) return undefined
    for (const cand of fresh) {
      let content: string
      try {
        content = readFileSync(cand.path, "utf8")
      } catch {
        continue
      }
      if (content.includes(opts.sentinel)) {
        const meta = parseSessionMeta(content)
        if (meta.sessionId && meta.cwd && canonical(meta.cwd) === wantCwd) {
          return { sessionId: meta.sessionId, path: cand.path }
        }
      }
    }
    return undefined
  }

  // Legacy only: callers that genuinely have no per-dispatch sentinel retain cwd+newest behavior.
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
// user's own trust choice). The dispatch layer currently calls this BEFORE spawning a codex TUI.
// Routing must stay separate: its process-scoped V2 flags never mutate global config. Replacing this
// legacy trust pre-arm with an explicit product flow needs UI/security design and is intentionally
// deferred rather than treated as an implicit routing bypass.
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
        ...NO_STARTUP_UPDATE_PROMPT,
        ...firstOutputTitleDeveloperInstructionFlags(),
        ...frayUiRoutingFlags(),
        ...workerSkillIsolationFlags(),
        ...codexSpawnThreadMcpFlags(o.spawnThreadMcp),
        ...outputDefaultFlags(codexHome),
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
      // conversation can't be retargeted (mirrors ClaudeBackend). For a normal follow-up the scratchpad
      // orientation rides the message. For a permission-only reattach there is deliberately NO trailing
      // prompt: adding orientation alone would fabricate a user turn and wake the agent.
      const message = o.message ? [o.extraSystemPrompt?.trim(), o.message].filter(Boolean).join("\n\n") : undefined
      const argv = [
        bin,
        "resume",
        "--cd",
        o.cwd,
        ...modelFlags(o.model),
        "-a",
        "never",
        "-c",
        "check_for_update_on_startup=false",
        ...frayUiRoutingFlags(),
        ...workerSkillIsolationFlags(),
        ...codexSpawnThreadMcpFlags(o.spawnThreadMcp),
        ...outputDefaultFlags(codexHome),
        ...effortFlags(o.effort),
        "-s",
        codexSandbox(o.permissionMode),
        o.sessionId,
      ]
      if (message) argv.push(message)
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
      const profile = parseCodexSessionProfile(line)
      if (profile?.model) state.model = profile.model
      if (profile?.effort) state.effort = profile.effort
      if (profile?.model || profile?.effort) {
        state.profileAt = profile.profileAt
        state.profileRevision = (state.profileRevision ?? 0) + 1
      }
      if (profile?.permissionMode) {
        state.permissionMode = profile.permissionMode
        state.permissionModeAt = profile.permissionModeAt
        state.permissionModeRevision = (state.permissionModeRevision ?? 0) + 1
      }
      const applyTitleSignal = (signal: CodexFrayTitleSignal, firstFinal: boolean) => {
        // Native provider events always win. A valid later signal may repair only the bounded dispatch
        // fallback created after an omitted/malformed first signal; it cannot churn a good title.
        if (state.autoTitleSource === "native") return
        if (signal.title && (!state.aiTitle || state.autoTitleSource === "fallback")) {
          applyEvent(state, { kind: "title", title: signal.title })
          state.autoTitleSource = "fray"
          return
        }
        // The dispatcher already persisted a bounded, topic-oriented automatic title. Record only
        // its provenance here: applying a generic telemetry title would overwrite that useful value.
        if (firstFinal && !state.aiTitle) state.autoTitleSource = "fallback"
      }
      for (const ev of parseCodexLine(line)) {
        if (ev.kind === "assistant-text") {
          // The new developer instruction puts the title on Codex's very first assistant message,
          // which is normally commentary emitted before the first tool call. Attribute comments are
          // therefore recognized and hidden on every assistant phase. H1/legacy transports remain
          // final-only so an ordinary commentary heading can never be mistaken for metadata.
          const signal = extractCodexFrayTitle(ev.text, ev.final)
          applyEvent(state, { ...ev, text: signal.text })
          applyTitleSignal(signal, false)
          if (!ev.final) continue
          const firstFinal = !state.titleCandidateFinalSeen
          if (firstFinal) {
            state.titleCandidateFinalSeen = true
            state.titleCandidateFinalText = ev.text
          }
          applyTitleSignal(signal, firstFinal)
          continue
        }
        if (ev.kind === "turn-end" && ev.finalText !== undefined && !state.titleCandidateFinalSeen) {
          state.titleCandidateFinalSeen = true
          state.titleCandidateFinalText = ev.finalText
          const signal = extractCodexFrayTitle(ev.finalText)
          applyEvent(state, { ...ev, finalText: signal.text })
          applyTitleSignal(signal, true)
          continue
        }
        if (
          ev.kind === "turn-end" &&
          ev.finalText !== undefined &&
          ev.finalText === state.titleCandidateFinalText
        ) {
          // task_complete repeats the same first final_answer. Hide its transport line as part of the
          // same response, but never extract another candidate from a later, different final answer.
          applyEvent(state, { ...ev, finalText: extractCodexFrayTitle(ev.finalText).text })
          continue
        }
        if (ev.kind === "turn-end" && ev.finalText !== undefined) {
          const signal = extractCodexFrayTitle(ev.finalText)
          applyEvent(state, { ...ev, finalText: signal.text })
          applyTitleSignal(signal, false)
          continue
        }
        if (ev.kind === "title") {
          applyEvent(state, ev)
          state.autoTitleSource = "native"
          continue
        }
        applyEvent(state, ev)
      }
    },

    // `-a never` prevents ordinary shell approval prompts, but connector/tool approvals and Codex's
    // native selectors still exist outside the rollout. Surface them as a safe structured blocker;
    // never answer them here (the human must use Terminal).
    detectNativeInput: detectCodexNativeInput,
  }
}
