import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import {
  GITHUB_DISPATCH_UI_BOUNDARY,
  ATTACHMENT_IMAGE_EXTENSIONS,
  attachmentExtension,
  type TranscriptMessage,
  type TranscriptPage,
  type TranscriptToolCall,
} from "@fray-ui/shared"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { AgentBackend, NormalizedEvent } from "./backend/types.ts"
import { CODEX_FIRST_FINAL_TITLE_TRANSPORT, CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT, parseCodexLine, createCodexBackend, extractCodexFrayTitle } from "./backend/codex.ts"
import { discoverTranscriptId, DISCOVERY_GRACE_MS } from "./discover.ts"
import { redactCredentialStructure, redactCredentialSyntax } from "./credential-redaction.ts"

// Parse a session JSONL into a renderable conversation — mechanically, no AI. Same defensive
// posture as the tailer: bad line → skip, unknown type → ignore, never throw. Assistant messages
// arrive one record per content block sharing message.id, so consecutive assistant records with
// the same id merge into one rendered message. User records carrying only tool_result blocks are
// tool plumbing, not something the human typed — skipped.

type Raw = Record<string, any>

export const MAX_MESSAGES = 300

// A user-record that is actually harness plumbing: task-notifications from background children,
// bare system-reminder wrappers, fray orchestrator pulses. Matched on the LEADING tag so a human
// message that merely quotes one of these somewhere inside still renders.
const NOISE_PREFIXES = ["<task-notification>", "[SYSTEM NOTIFICATION", "<system-reminder>", "<fray-", "[fray]"]
export function isInjectedNoise(text: string): boolean {
  const t = text.trimStart()
  return NOISE_PREFIXES.some((p) => t.startsWith(p))
}

// Normalize line endings to LF. A human follow-up injected through the agent's TERMINAL round-trips with
// CARRIAGE-RETURN separators (the tty translates newlines to \r), so a multi-line message — notably the
// composed "Answers:\r1. …\r2. …" — arrives CR-separated. The client renders user text in a
// `white-space: pre-wrap` bubble, which honors \n but NOT a lone \r, so those breaks silently collapse
// into a run-on. Normalizing here fixes every downstream consumer at once (render, the answers-card
// detection, AND the client's optimistic-vs-server text match, which compares raw strings).
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n")
}

// Display-only projection for the FIRST user turn of a generated GitHub dispatch. Deliberately
// require the complete server-generated envelope, including the exact versioned marker, so ordinary
// HTML comments and code examples stay literal. `text` itself is never changed: workers, persistence,
// search, and transcript logic retain the full machine-facing prompt below the boundary.
export function githubDispatchDisplayText(text: string): string | undefined {
  const marker = `\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n`
  const cut = text.indexOf(marker)
  if (cut === -1) return undefined
  const head = text.slice(0, cut)
  const match = head.match(/^THREAD: [a-z0-9][a-z0-9-]*\n\n(Investigate this issue and make recommendations\n\n(?:Issue|PR) #\d+: [^\n]+\nRepository: [^\n]+\nURL: \S+)$/)
  return match?.[1]
}

// Append a text block to a message's ordered parts, coalescing into a trailing text part (so several
// text blocks in a row read as one prose run) — otherwise starting a fresh text part after a tools run.
function pushTextPart(m: TranscriptMessage, text: string): void {
  const last = m.parts[m.parts.length - 1]
  if (last && last.kind === "text") last.text = last.text ? `${last.text}\n\n${text}` : text
  else m.parts.push({ kind: "text", text })
}
// Append a tool call, coalescing into a trailing tools part (a contiguous run of calls = one card
// band) — otherwise starting a fresh tools part after a text run, which is what keeps a lead-in colon
// directly above ITS band and not hoisted above earlier prose.
function pushToolPart(m: TranscriptMessage, call: TranscriptToolCall): void {
  const last = m.parts[m.parts.length - 1]
  if (last && last.kind === "tools") last.tools.push(call)
  else m.parts.push({ kind: "tools", tools: [call] })
}

export function projectClaudeTranscript(raw: string, identityPrefix = "claude"): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  let lastAssistantId: string | null = null
  // Tool calls awaiting their tool_result, keyed by tool_use id. Claude records every result as a
  // later synthetic `user` record, so the call card starts pending and is back-filled in place with
  // terminal state, elapsed time, and a bounded/redacted result excerpt. MultiEdit fans one tool_use
  // out into several cards; all share the one result lifecycle.
  const pendingTools = new Map<string, { calls: TranscriptToolCall[]; name: string; at?: string }>()
  // Live Agent dispatches keyed by tool_use id → the dispatch's timestamp + the emitted call object.
  // When a matching completion <task-notification> streams by we (a) back-fill the call's terminal
  // state and (b) emit an inline "event" punctuation message at that position. Delete-on-emit dedupes
  // a task-id that re-notifies. (This mirrors the tailer's completion correlation; kept separate here
  // so the transcript's mechanical parse stays decoupled from the tailer's liveness telemetry.)
  const agentDispatches = new Map<string, { at?: string; call: TranscriptToolCall }>()
  // Background Bash launch ids are provider-native lifecycle keys. Their immediate tool_result is
  // only a launch acknowledgement; task-notification is the terminal observation.
  const backgroundShells = new Map<string, { at?: string; call: TranscriptToolCall }>()
  // For "Thought for Ns" events: the previous SUBSTANTIVE (assistant/user) record's timestamp, and the
  // message id we last emitted a thinking event for (so a turn's several thinking records emit ≤1 line).
  let prevTs: string | undefined
  let thinkingMsgId: string | null = null
  // Human follow-ups QUEUED to a mid-turn worker (Claude Code's message queue). A human message sent
  // while the agent is working NEVER lands as a normal user record — the session JSONL records the
  // lifecycle only as sidecar: an `enqueue` queue-operation, a `remove`/`dequeue`, and finally a
  // `queued_command` attachment that materializes the text into the agent's context. Without the two
  // handlers below the message is SWALLOWED entirely. `queuedPending` maps a still-undelivered message's
  // TEXT → its emitted (grayed) bubble, so the delivering attachment (which carries the prompt verbatim)
  // resolves its enqueue regardless of the timestamp drift between the two records.
  const queuedPending = new Map<string, TranscriptMessage>()
  // A just-delivered queued message's text — so an immediately-following NORMAL user record carrying the
  // identical text (a belt-and-suspenders guard; unobserved in the evidence) doesn't double-render.
  let deliveredDedupe: string | null = null

  let byteOffset = 0
  for (const line of raw.split("\n")) {
    const lineOffset = byteOffset
    byteOffset += Buffer.byteLength(line) + 1
    if (!line.trim()) continue
    const sourceId = `${identityPrefix}:${lineOffset}`
    let rec: Raw
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }

    // A sub-agent completion notification (a queue-operation record with a top-level <task-notification>
    // content string) re-renders the dispatch's AgentBlock card inline at its position (clickable into
    // the run-log drawer) and back-fills the original launch card's terminal state.
    const ev = completionEvent(rec, agentDispatches, backgroundShells)
    if (ev) {
      ev.sourceId = sourceId
      out.push(ev)
      lastAssistantId = null // the completion card breaks the assistant-record merge chain
      continue
    }

    // Long THINKING window: an assistant record that opens a NEW turn with a (redacted) thinking block,
    // reached after a long quiet gap. Thinking CONTENT is redacted in the JSONL (a `signature` + an
    // empty `thinking` field — verified against real transcripts), so the only observable is the
    // wall-clock span from the previous substantive record; we surface that as a quiet event line.
    const thisTs = typeof rec.timestamp === "string" ? rec.timestamp : undefined
    if (rec.type === "assistant" && hasThinking(rec.message?.content)) {
      const mid = typeof rec.message?.id === "string" ? rec.message.id : null
      if (mid !== thinkingMsgId) {
        thinkingMsgId = mid
        if (thisTs && prevTs) {
          const gap = Date.parse(thisTs) - Date.parse(prevTs)
          if (Number.isFinite(gap) && gap >= THINK_MIN_MS) {
            out.push({ sourceId, role: "assistant", kind: "event", text: `Thought for ${fmtThinkDur(gap)}`, tools: [], parts: [], at: thisTs })
            lastAssistantId = null
          }
        }
      }
    }
    // Advance the substantive clock (assistant/user records bound a thinking window; sidecar and
    // notification records do not).
    if (thisTs && (rec.type === "assistant" || rec.type === "user")) prevTs = thisTs

    // A QUEUED human follow-up's enqueue/removal (the completion <task-notification> queue-operations were
    // already consumed above). `enqueue` emits a pending grayed bubble; a CONTENT-BEARING removal
    // supersedes it (see below); the delivery itself is the `queued_command` attachment handled next.
    if (rec.type === "queue-operation") {
      const op = typeof rec.operation === "string" ? rec.operation : ""
      const content = typeof rec.content === "string" ? normalizeNewlines(rec.content) : ""
      if (op === "enqueue" && content.trim() && !isInjectedNoise(content)) {
        // Undelivered → a grayed "queued" user bubble (queued:true reuses the client's optimistic-send
        // styling). Do NOT reset lastAssistantId: this bubble is transient (it may be spliced out on
        // delivery), and the assistant-merge tail-role check already blocks merging across a live bubble.
        const m: TranscriptMessage = { sourceId, role: "user", text: content, tools: [], parts: [], at: thisTs, queued: true }
        out.push(m)
        queuedPending.set(content, m)
      } else if ((op === "remove" || op === "dequeue" || op === "popAll") && content.trim()) {
        // A removal that ECHOES the queued text supersedes its pending bubble — either the message was
        // cancelled before delivery, or (in sessions whose `remove` carries the text) it's the delivery
        // handshake and the following attachment re-renders the delivered copy. Splice the pending bubble
        // so we never render both. An EMPTY-content removal is the ordinary handshake and is deliberately
        // IGNORED: matching it by anything but exact text could evict a genuinely-still-pending human
        // bubble when an unrelated queue item (e.g. a sub-agent task-notification) is dequeued.
        const m = queuedPending.get(content)
        if (m) {
          queuedPending.delete(content)
          const i = out.indexOf(m)
          if (i !== -1) out.splice(i, 1)
        }
      }
      continue
    }

    // The DELIVERY of a queued human follow-up: Claude Code materializes the queued text into the agent's
    // context as a `queued_command` attachment. This is the ONLY record carrying the delivered text in a
    // renderable place, so it renders as the human's user message at its position in the flow. Only
    // origin.kind "human" + commandMode "prompt" is a plain typed message; other commandModes (notably
    // "task-notification" — a sub-agent completion materialized the same way) are harness plumbing → skip.
    if (rec.type === "attachment" && rec.attachment?.type === "queued_command") {
      const att = rec.attachment
      const prompt = typeof att.prompt === "string" ? normalizeNewlines(att.prompt) : ""
      if (prompt.trim() && att.origin?.kind === "human" && att.commandMode === "prompt" && !isInjectedNoise(prompt)) {
        const pending = queuedPending.get(prompt)
        if (pending) {
          // Resolve the pending bubble IN PLACE — same object, same position, just un-gray it. Never emit
          // a second copy (the enqueue already placed it where the human hit send).
          queuedPending.delete(prompt)
          pending.queued = false
        } else {
          // Attachment-only: an older session with no queue-operations, or an enqueue that scrolled out of
          // the render window. Emit the delivered message fresh at the attachment's position.
          out.push({ sourceId, role: "user", text: prompt, tools: [], parts: [], at: thisTs })
        }
        deliveredDedupe = prompt
        if (thisTs) prevTs = thisTs // a delivered human turn is substantive — it bounds the next thinking window
        lastAssistantId = null // …and breaks the assistant-record merge chain, like any user message
      }
      continue
    }

    if (rec.type === "user") {
      // Back-fill any Read excerpts this record carries FIRST — a tool_result record is dropped as a
      // human bubble (isMeta / tool_result-only), but it still holds the file content we want to show.
      attachToolResults(rec, pendingTools)
      // isMeta marks harness-injected user records (hook feedback, reminders) — plumbing the
      // human never typed, so it must not render as their bubble.
      if (rec.isMeta === true) continue
      let text = userText(rec)
      // Harness/orchestrator injections that arrive as ordinary user records (task-notifications,
      // system reminders, fray pulses) are ALSO not the human's words — drop them from the chat.
      if (text && isInjectedNoise(text)) continue
      if (text) {
        // Claude Code 2.1.207's print/SDK path emits enqueue → empty dequeue → the ordinary user
        // record (no queued_command attachment). Resolve an identical pending bubble in place; adding
        // another here duplicated the first prompt in a real disposable session.
        const queued = queuedPending.get(text)
        if (queued) {
          queuedPending.delete(text)
          queued.queued = false
          queued.at = rec.timestamp
          lastAssistantId = null
          continue
        }
        // Belt-and-suspenders: a normal user record that echoes a JUST-delivered queued message would
        // otherwise render it twice. Skip the immediately-following identical text. (Unobserved in the
        // evidence — the queued text only ever arrives via the attachment — but cheap to guard.)
        if (deliveredDedupe !== null && text === deliveredDedupe) {
          deliveredDedupe = null
          continue
        }
        deliveredDedupe = null
        // The first user message is the composed dispatch prompt (fixed worker prompt + thread
        // contract + TASK). Only the TASK is the human's words — show just that.
        if (out.length === 0) {
          const cut = text.indexOf("\nTASK:\n")
          if (cut !== -1) text = text.slice(cut + "\nTASK:\n".length).trim()
        }
        const displayText = out.length === 0 ? githubDispatchDisplayText(text) : undefined
        out.push({ sourceId, role: "user", text, ...(displayText ? { displayText } : {}), tools: [], parts: [], at: rec.timestamp })
        lastAssistantId = null
      }
      continue
    }

    if (rec.type === "assistant") {
      const msg = rec.message
      if (!msg || !Array.isArray(msg.content)) continue
      const id = typeof msg.id === "string" ? msg.id : null
      // Never merge into an EVENT line (a "Thought for Ns" emitted from this same turn's thinking
      // record sits at the tail with role:"assistant") — an event is punctuation, not a message body.
      const tail = out.length > 0 ? out[out.length - 1] : undefined
      const target =
        id !== null && id === lastAssistantId && tail && tail.role === "assistant" && tail.kind === undefined
          ? tail
          : null
      const m: TranscriptMessage = target ?? { sourceId, role: "assistant", text: "", tools: [], parts: [], at: rec.timestamp }
      // Walk blocks in ARRAY ORDER (and record order for the split-record case), appending to `parts`
      // so text↔tool interleaving is preserved — a "Let me draft the notes:" lead-in stays directly
      // above the call it introduces. Contiguous same-kind blocks coalesce into one part. The legacy
      // flat text/tools fields stay populated for the pre-restart client window + flat-field consumers.
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          pushTextPart(m, block.text)
          m.text = m.text ? `${m.text}\n\n${block.text}` : block.text
        } else if (block?.type === "tool_use") {
          const calls = toolCalls(block)
          for (const call of calls) {
            call.status = "pending"
            pushToolPart(m, call)
            m.tools.push(call)
            // An Agent dispatch is registered by its tool_use id so a later completion notification can
            // back-fill its terminal state and drop an inline event line into the flow.
            if (call.agentId) agentDispatches.set(call.agentId, { at: rec.timestamp, call })
            if (call.backgroundState === "background" && typeof block.id === "string") backgroundShells.set(block.id, { at: rec.timestamp, call })
          }
          if (typeof block.id === "string" && calls.length > 0) {
            pendingTools.set(block.id, { calls, name: String(block.name ?? "tool"), at: rec.timestamp })
          }
        }
        // thinking blocks are deliberately not rendered
      }
      if (!target && (m.text || m.tools.length)) out.push(m)
      lastAssistantId = id
      deliveredDedupe = null // the turn moved on; the delivered-message dedupe window only spans the very next record
      continue
    }

    // Any other record type (attachment, queue-operation, ai-title, …) is sidecar — ignore, but
    // a non-user/assistant record between assistant chunks shouldn't break merging, so no reset.
  }

  return out
}

export function parseTranscript(raw: string, identityPrefix = "claude"): TranscriptMessage[] {
  const out = projectClaudeTranscript(raw, identityPrefix)
  return out.length > MAX_MESSAGES ? out.slice(-MAX_MESSAGES) : out
}

function userText(rec: Raw): string | null {
  const c = rec.message?.content
  if (typeof c === "string") return normalizeNewlines(c).trim() || null
  if (Array.isArray(c)) {
    const texts = c.filter((b: Raw) => b?.type === "text" && typeof b.text === "string").map((b: Raw) => b.text)
    const joined = normalizeNewlines(texts.join("\n\n")).trim()
    return joined || null // tool_result-only records land here as null
  }
  return null
}

// Per-string cap on structured edit payloads: transcripts ride the board snapshot and can hold
// hundreds of messages, so a single huge Write must not bloat the channel. Truncated content is
// still useful for a diff preview; the marker signals the client not to treat it as complete.
const EDIT_CAP = 4000
const TRUNC_MARKER = "\n… (truncated)"

// Tool payloads can contain copied credentials (shell exports/output, file excerpts, MCP arguments)
// or Codex collaboration's opaque encrypted `message` blobs. The transcript is a broad UI surface,
// so redact common secret forms before any payload is retained or summarized. This is deliberately
// presentation-only: the raw JSONL remains untouched.
function redactToolPayload(s: string): string {
  return redactCredentialSyntax(s)
    // Fernet payloads commonly end in base64 padding. A trailing word-boundary left that padding
    // behind (`[encrypted payload]==`) and made the redaction visibly incomplete.
    .replace(/gAAAA[A-Za-z0-9_-]{40,}={0,2}/g, "[encrypted payload]")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|sk_live_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[redacted]")
    // Inputs are usually JSON, so the key's closing quote sits between the word and colon. Accept it
    // here (and a quoted value) rather than protecting only shell-style `Authorization=...` forms.
    .replace(/(\bAuthorization\b["']?\s*[:=]\s*)(?:"(?:Bearer\s+)?[^"]*"|'(?:Bearer\s+)?[^']*'|(?:Bearer\s+)?[^\s,;]+)/gi, "$1[redacted]")
    .replace(
      /(\b(?:[a-z][a-z0-9_]*(?:_api_key|_token|_secret|_password|_passwd)|api[_-]?key|access[_-]?token|auth[_-]?token|token|credential|secret|password|passwd|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1[redacted]",
    )
}

function capEdit(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > EDIT_CAP ? safe.slice(0, EDIT_CAP) + TRUNC_MARKER : safe
}

// An Agent dispatch prompt is a full worker contract — often thousands of chars. Cap it like the
// edit/command payloads so a transcript riding the board snapshot stays light; the marker signals the
// client's AgentBlock body that the prompt is truncated.
const AGENT_PROMPT_CAP = 4000
function capAgentPrompt(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > AGENT_PROMPT_CAP ? safe.slice(0, AGENT_PROMPT_CAP) + TRUNC_MARKER : safe
}

// A SendMessage body is peer-to-peer prose — usually short, but a steer can run long. Cap it like the
// prompt/edit payloads so a transcript riding the board snapshot stays light; the marker signals the
// client's SendMessageCard that the body is truncated.
const SEND_BODY_CAP = 4000
function capSendBody(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > SEND_BODY_CAP ? safe.slice(0, SEND_BODY_CAP) + TRUNC_MARKER : safe
}

// A thinking window shorter than this doesn't earn an event line (routine sub-20s pauses are noise);
// ~20s catches the genuinely long "the model sat and thought" moments the maintainer wants surfaced.
const THINK_MIN_MS = 20_000
// True when an assistant record carries a (redacted) thinking block — the "the model thought" signal.
function hasThinking(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "thinking")
}
// Coarse seconds-granularity duration for a thinking window: "42s", "1m 20s".
function fmtThinkDur(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

// EVERY Bash call ships its `command` so the client renders it as a collapsed BashBlock card (the
// one-liner tool rendering was retired — every tool call is a card now). Multi-line/long commands
// expand to their full body; a short one-liner's body simply echoes its header. Capped so a huge
// command can't bloat the transcript channel.
const COMMAND_CAP = 2000
function capCommand(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > COMMAND_CAP ? safe.slice(0, COMMAND_CAP) + TRUNC_MARKER : safe
}
const TOOL_INPUT_CAP = 4000
function capToolInput(s: string): string {
  const safe = redactToolPayload(s)
  return safe.length > TOOL_INPUT_CAP ? safe.slice(0, TOOL_INPUT_CAP) + TRUNC_MARKER : safe
}
// One-line summary for a block command: its first non-blank line, with a trailing ellipsis when more
// content follows. Feeds the inline renderer and dense card previews; the full command rides `command`.
function bashSummary(cmd: string): string {
  const lines = redactToolPayload(cmd).split("\n")
  const first = (lines.find((l) => l.trim()) ?? "").trim()
  const hasMore = cmd.trim() !== first
  const base = first.length > 120 ? first.slice(0, 119) + "…" : first
  return hasMore && !base.endsWith("…") ? base + "…" : base
}

// A Read call's result excerpt: the file content it returned, capped like the edit/command payloads
// so a big file can't bloat the transcript channel (transcripts ride the board snapshot). Cap by BOTH
// a line budget and a byte budget — whichever bites first — and mark truncation so the client's
// "Show all N lines" affordance reads honestly.
const READ_LINE_CAP = 200
const READ_BYTE_CAP = 16000
function capRead(s: string): string {
  let out = redactToolPayload(s)
  const lines = out.split("\n")
  if (lines.length > READ_LINE_CAP) out = lines.slice(0, READ_LINE_CAP).join("\n") + TRUNC_MARKER
  if (out.length > READ_BYTE_CAP) out = out.slice(0, READ_BYTE_CAP) + TRUNC_MARKER
  return out
}

// Map a base64 image block's media_type to a file extension the /local-image route can serve. The route
// whitelists exactly these content types (app.ts). An unrecognized/absent media_type — notably svg, which
// the route deliberately omits as an XSS vector — is NEVER guessed at; such a block is skipped entirely so
// the card falls back to its text result rather than mislabeling foreign bytes as png.
const IMAGE_MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

// Directory for decoded tool-result screenshots. Under the OS temp dir so it is already a trusted root
// for the /local-image route (app.ts) — the client serves these paths without any allowlist change.
const SCREENSHOT_CACHE_DIR = join(tmpdir(), "fray-tool-images")
// Defensive cap on retained decoded images: a long-lived server driving many screenshot QA loops would
// otherwise grow the cache without bound. Oldest-by-mtime are pruned past this on the rare write path.
const SCREENSHOT_CACHE_MAX = 200
// Bound the base64 we will decode into memory for a single image block (~24 MB of image); a real
// screenshot is far below this. Guards against a pathologically large embedded payload.
const SCREENSHOT_MAX_BASE64 = 32_000_000
let screenshotTmpSeq = 0

// Only persist bytes that ACTUALLY are the image type the block claims — a garbage/mismatched/svg payload
// is skipped so the card shows its text result instead of a broken <img>. Matches the leading magic bytes.
function looksLikeImage(buf: Buffer, ext: string): boolean {
  if (ext === "png") return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  if (ext === "jpg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  if (ext === "gif") return buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 // "GIF"
  if (ext === "webp") return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP"
  return false
}

// Best-effort prune so the cache dir can't grow without bound. Cheap because it only runs on the RARE
// first-persist write path (never on a re-parse that hit the existsSync short-circuit). Opportunistic —
// any fs error is swallowed; pruning is never load-bearing.
function pruneScreenshotCache(): void {
  try {
    const entries = readdirSync(SCREENSHOT_CACHE_DIR).filter((n) => !n.startsWith("."))
    if (entries.length <= SCREENSHOT_CACHE_MAX) return
    const byMtime = entries
      .map((n) => {
        try {
          return { n, m: statSync(join(SCREENSHOT_CACHE_DIR, n)).mtimeMs }
        } catch {
          return { n, m: 0 }
        }
      })
      .sort((a, b) => b.m - a.m)
    for (const { n } of byMtime.slice(SCREENSHOT_CACHE_MAX)) {
      try {
        unlinkSync(join(SCREENSHOT_CACHE_DIR, n))
      } catch {
        /* already gone / concurrent unlink */
      }
    }
  } catch {
    /* dir missing or unreadable — nothing to prune */
  }
}

// A tool_result whose content carries a base64 image (chrome-devtools MCP `take_screenshot`, an image
// Read, any tool that returns a picture) → decode it ONCE to a file under the OS temp dir and return its
// absolute path, so the chat can render the screenshot inline via /local-image. The filename derives from
// the tool_use id (`idKey`), NOT the image bytes, so the existsSync guard short-circuits BEFORE the
// expensive base64 decode + write: the transcript parser runs on every poll and must not re-decode
// already-persisted screenshots each time. Persists only a KNOWN servable image type whose bytes match its
// magic signature. Publishes atomically (temp file + rename) so a concurrent /local-image read never sees a
// half-written image. Any fs error yields undefined → the card falls back to its text/summary rendering.
// Returns the FIRST qualifying image block (screenshots are single-image).
function persistResultImage(content: unknown, idKey: string): string | undefined {
  if (!Array.isArray(content) || !idKey) return undefined
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "image") continue
    const source = (block as { source?: unknown }).source
    if (!source || typeof source !== "object") continue
    const s = source as { type?: string; media_type?: string; data?: string }
    if (s.type !== "base64" || typeof s.data !== "string" || !s.data) continue
    const ext = IMAGE_MEDIA_EXT[typeof s.media_type === "string" ? s.media_type : ""]
    if (!ext) continue // unrecognized/absent media type (incl. svg) — never guess; let the text result win
    const name = createHash("sha256").update(idKey).digest("hex").slice(0, 32) // hashes the id, not the image (cheap)
    const path = join(SCREENSHOT_CACHE_DIR, `${name}.${ext}`)
    try {
      if (existsSync(path)) return path // already persisted this tool call — no decode, no write
      if (s.data.length > SCREENSHOT_MAX_BASE64) return undefined
      const buf = Buffer.from(s.data, "base64")
      if (buf.length === 0 || !looksLikeImage(buf, ext)) continue // not the image it claims — skip → text fallback
      mkdirSync(SCREENSHOT_CACHE_DIR, { recursive: true })
      const tmp = join(SCREENSHOT_CACHE_DIR, `.${name}.${process.pid}.${screenshotTmpSeq++}.tmp`)
      writeFileSync(tmp, buf)
      renameSync(tmp, path) // atomic publish
      pruneScreenshotCache()
      return path
    } catch {
      return undefined
    }
  }
  return undefined
}

// Max source image we will copy (bytes). A statSync check BEFORE readFileSync bounds memory — never load
// a multi-GB path the model named into a Buffer. A real screenshot is far below this.
const SENT_IMAGE_MAX_BYTES = 24_000_000
// Max files rendered from one SendUserFile call — a delivery of more than this is pathological; the extra
// are dropped so the card can't mount hundreds of images/chips.
const SENT_FILES_MAX = 24
// SendUserFile ships ABSOLUTE SOURCE paths (often the worker's scratchpad — a dir /local-image does NOT
// serve). For each IMAGE file, copy it ONCE into the servable screenshot cache and return the cached
// absolute path so the chat renders it inline via /local-image; a non-image, oversized, unreadable, or
// mismatched-bytes file → undefined (the caller records its basename as an openable chip instead).
// `idKey` (tool_use id + file index) makes the cache name UNIQUE PER CALL — so a re-projection on every
// poll short-circuits on existsSync, while a later call that reuses the same PATH with new content (a
// worker overwriting `shot.png`) gets a fresh copy instead of the stale first one. SVG is excluded (not
// in ATTACHMENT_IMAGE_EXTENSIONS — an XSS vector the /local-image route omits). Any fs error → undefined.
function persistSentFile(srcPath: string, idKey: string): string | undefined {
  const ext = attachmentExtension(srcPath)
  if (!(ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return undefined
  const outExt = ext === "jpeg" ? "jpg" : ext // /local-image serves png/jpg/gif/webp
  try {
    const name = createHash("sha256").update(idKey).digest("hex").slice(0, 32) // hashes the call+index, not the bytes (cheap)
    const dest = join(SCREENSHOT_CACHE_DIR, `${name}.${outExt}`)
    if (existsSync(dest)) return dest // already copied for this call — no re-read/write
    const size = statSync(srcPath).size // bound memory BEFORE reading (never buffer a huge file)
    if (size === 0 || size > SENT_IMAGE_MAX_BYTES) return undefined
    const buf = readFileSync(srcPath)
    if (!looksLikeImage(buf, outExt)) return undefined // not the image it claims → chip fallback
    mkdirSync(SCREENSHOT_CACHE_DIR, { recursive: true })
    const tmp = join(SCREENSHOT_CACHE_DIR, `.${name}.${process.pid}.${screenshotTmpSeq++}.tmp`)
    writeFileSync(tmp, buf)
    renameSync(tmp, dest) // atomic publish so a concurrent /local-image read never sees a half-written file
    pruneScreenshotCache()
    return dest
  } catch {
    return undefined
  }
}

// Pull the text payload out of a tool_result block's content (string, or an array of text parts).
// Non-text results (e.g. an image Read) yield nothing → the call keeps its plain one-line summary.
function toolResultText(content: any): string | null {
  if (typeof content === "string") return content.trim() || null
  if (Array.isArray(content)) {
    const joined = content
      .filter((b: Raw) => b?.type === "text" && typeof b.text === "string")
      .map((b: Raw) => b.text)
      .join("\n")
    return joined.trim() ? joined : null
  }
  return null
}

type PendingClaudeTool = { calls: TranscriptToolCall[]; name: string; at?: string }

function elapsedBetween(start: unknown, end: unknown): number | undefined {
  const a = typeof start === "string" ? Date.parse(start) : NaN
  const b = typeof end === "string" ? Date.parse(end) : NaN
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined
}

function cancelledToolResult(text: string): boolean {
  const t = text.trimStart()
  return (
    /^(?:cancelled|canceled|interrupted|aborted|killed)\b/i.test(t) ||
    /^(?:tool|command|process|operation|request|task)\s+(?:was\s+)?(?:cancelled|canceled|interrupted|aborted|killed)\b/i.test(t)
  )
}

// Back-fill real Claude tool results. Read keeps its dedicated excerpt field; ordinary tools expose a
// bounded result pane. Successful edits suppress their redundant prose acknowledgement (the diff is
// already the useful payload), while failures retain it. Agent's immediate result is only launch
// metadata explicitly marked non-user-facing, so its card stays pending until completionEvent.
function attachToolResults(rec: Raw, pending: Map<string, PendingClaudeTool>): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue
    const entry = pending.get(b.tool_use_id)
    if (!entry) continue
    pending.delete(b.tool_use_id)
    const text = toolResultText(b.content)
    // A successful Agent result is launch metadata, not child completion. Keep waiting for the
    // task-notification in that case. A launch error, however, may never produce a notification and
    // must not leave the card spinning forever.
    if (
      (entry.name === "Agent" || entry.calls.some((call) => call.backgroundState === "background")) &&
      b.is_error !== true &&
      !(text && (cancelledToolResult(text) || failedToolResult(text)))
    ) continue
    // Claude reports tool failures with `is_error`; keep a narrow text fallback for older logs that
    // omitted the flag. An unanchored search misclassified successful output such as "0 failed".
    const failed = b.is_error === true || Boolean(text && /^(?:error|failed|permission denied)\b/i.test(text.trim()))
    const status: NonNullable<TranscriptToolCall["status"]> = text && cancelledToolResult(text) ? "cancelled" : failed ? "failed" : "completed"
    const durationMs = elapsedBetween(entry.at, rec.timestamp)
    // A screenshot / image tool_result (e.g. chrome-devtools `take_screenshot`) carries a base64 image
    // block instead of — or alongside — text. Decode it to a temp file (keyed by the tool_use id) so the
    // card can render it inline. `b.tool_use_id` is a verified string by the guard at the loop head.
    const outputImage = status !== "failed" && status !== "cancelled" ? persistResultImage(b.content, b.tool_use_id) : undefined
    for (const call of entry.calls) {
      call.status = status
      if (durationMs !== undefined) call.durationMs = durationMs
      if (outputImage) call.outputImage = outputImage
      if (!text) continue
      if (entry.name === "Read") call.read = capRead(text)
      else if (!call.edit || status !== "completed") call.output = capRead(text)
    }
  }
}

// Expand one tool_use block into transcript tool calls. Usually one, but MultiEdit fans out to one
// call per sub-edit so each renders as its own diff. Edit/Write/MultiEdit additionally carry a
// structured `edit` payload (Write's old side is "" — the whole file is new).
function toolCalls(block: any): TranscriptToolCall[] {
  const name = redactToolPayload(String(block?.name ?? "tool"))
  const input = block?.input
  const detail = toolDetail(input)

  if (input && typeof input === "object") {
    const file = typeof input.file_path === "string" ? redactToolPayload(input.file_path) : undefined
    if (name === "Edit" && file && typeof input.old_string === "string" && typeof input.new_string === "string") {
      return [{ name, detail, edit: { file, old: capEdit(input.old_string), new: capEdit(input.new_string) } }]
    }
    if (name === "Write" && file && typeof input.content === "string") {
      return [{ name, detail, edit: { file, old: "", new: capEdit(input.content) } }]
    }
    if (name === "MultiEdit" && file && Array.isArray(input.edits)) {
      const calls = input.edits
        .filter((e: any) => e && typeof e.old_string === "string" && typeof e.new_string === "string")
        .map((e: any) => ({ name, detail, edit: { file, old: capEdit(e.old_string), new: capEdit(e.new_string) } }))
      if (calls.length) return calls
    }
    if (name === "Bash" && typeof input.command === "string" && input.command.trim()) {
      const desc = typeof input.description === "string" && input.description.trim() ? redactToolPayload(input.description.trim()).slice(0, 160) : undefined
      return [{
        name,
        detail: bashSummary(input.command),
        command: capCommand(input.command),
        desc,
        // A background Bash result only acknowledges that the child was launched. Keep the card live
        // until its later task-notification; no launch result can truthfully mean "done".
        backgroundState: input.run_in_background === true ? "background" : undefined,
      }]
    }
    // An Agent dispatch carrying a prompt renders as its own AgentBlock card (Bash/Read family): the
    // description is the header one-liner, subagent_type the model+effort tag, the (capped) prompt the
    // expandable body, and block.id the correlation key to the live tracked sub-agent + its drawer.
    if (name === "Agent" && typeof input.prompt === "string" && input.prompt.trim()) {
      const description = typeof input.description === "string" && input.description.trim() ? redactToolPayload(input.description.trim()) : undefined
      const subagentType = typeof input.subagent_type === "string" && input.subagent_type.trim() ? redactToolPayload(input.subagent_type.trim()) : undefined
      const agentId = typeof block.id === "string" ? block.id : undefined
      return [{ name, detail: description ?? detail, prompt: capAgentPrompt(input.prompt), subagentType, agentId }]
    }
    // A SendMessage (peer/agent-to-agent) renders as its own SendMessageCard (Bash/Agent family): the
    // recipient (`to`, alias `recipient`) rides the header as "→ <name>", the `summary` is the one-line
    // recap, the body (`message`, alias `content`) is the expandable card body, and a non-"message"
    // `type` (e.g. "shutdown_request") is surfaced as the label. `to` and `content`/`message` are the
    // canonical fields; `recipient`/`content` are duplicate aliases some emitters ship — take either.
    if (name === "SendMessage") {
      const to = strField(input.to) ?? strField(input.recipient)
      const bodyRaw = typeof input.message === "string" ? input.message : typeof input.content === "string" ? input.content : ""
      const summary = strField(input.summary)
      const sendType = strField(input.type)
      const body = normalizeNewlines(bodyRaw)
      if (to || body.trim() || summary) {
        return [{ name, detail: summary ?? to, sendTo: to, sendSummary: summary, sendBody: capSendBody(body), sendType }]
      }
    }
    // SendUserFile (Claude Code file delivery) → a SentFilesCard that shows the delivered files inline
    // instead of a generic tool block: image files are copied into the servable cache and rendered as
    // pictures; non-image (or display:"attach") files become openable chips; the `caption` shows below.
    if (name === "SendUserFile") {
      const raw = Array.isArray(input.files) ? input.files : typeof input.files === "string" ? [input.files] : []
      // Cap the count so a pathological call can't trigger hundreds of copies / <img> mounts.
      const files = raw.filter((f: unknown): f is string => typeof f === "string" && f.trim().length > 0).slice(0, SENT_FILES_MAX)
      if (files.length) {
        const caption = strField(input.caption)?.slice(0, 600) // one-line caption; bound it like other fields
        const attachOnly = strField(input.display) === "attach"
        const idBase = typeof block?.id === "string" && block.id ? block.id : caption ?? files[0]
        const sentImages: string[] = []
        const sentFiles: string[] = [] // full ABSOLUTE source paths (the client links them + shows the basename)
        files.forEach((f: string, i: number) => {
          const img = attachOnly ? undefined : persistSentFile(f, `${idBase}:${i}`) // reads the REAL path
          if (img) sentImages.push(img)
          else sentFiles.push(redactToolPayload(f)) // redact the DISPLAYED/linked path (as every other file_path)
        })
        return [{
          name,
          detail: caption ?? `${files.length} file${files.length === 1 ? "" : "s"} sent`,
          sentImages: sentImages.length ? sentImages : undefined,
          sentFiles: sentFiles.length ? sentFiles : undefined,
          caption,
        }]
      }
    }
  }

  return [{ name, detail, input: renderToolInput(input) }]
}

// A trimmed non-empty string field, else undefined — for optional input fields (SendMessage's
// to/summary/type) where empty/absent should collapse to undefined, not "".
function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? redactToolPayload(v.trim()) : undefined
}

// One human-scannable hint per tool call, in preference order of what the input reveals.
function toolDetail(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined
  if (typeof input.pattern === "string" && input.pattern.trim()) {
    const path = typeof input.path === "string" && input.path.trim() ? ` · ${input.path.trim()}` : ""
    return redactToolPayload(`${input.pattern.trim()}${path}`).slice(0, 400)
  }
  let cand: unknown =
    input.file_path ?? input.path ?? input.command ?? input.description ?? input.pattern ?? input.query ?? input.url
  // Generic fallback so a tool outside the known set (Monitor, custom MCP tools, …) still shows a
  // hint instead of rendering as a bare name: the first non-empty string-valued input field.
  if (typeof cand !== "string" || !cand.trim()) {
    for (const [key, v] of Object.entries(input)) {
      if (typeof v === "string" && v.trim()) {
        // A generic tool's first string field is often itself a credential (`TOKEN: value`). Once
        // detached from its key, the value alone is no longer recognizable by key-based redaction.
        // Preserve the key only when doing so proves the value is sensitive; otherwise retain the
        // concise value-only detail used by existing cards.
        const keyed = redactToolPayload(`${key}=${v.trim()}`)
        cand = keyed.includes("[redacted]") || keyed.includes("[encrypted payload]") ? keyed : v
        break
      }
    }
  }
  if (typeof cand !== "string" || !cand.trim()) return undefined
  const s = redactToolPayload(cand.trim()).replace(/\s+/g, " ")
  // Generous cap: an 80-char cut ate file paths mid-word (and its "…" broke the client's path-link
  // detection). Display truncation is the CLIENT's job (CSS ellipsis over the card's full width).
  return s.length > 400 ? `${s.slice(0, 399)}…` : s
}

// A concise cause label for the turn-boundary line emitted when a background-shell completion wakes
// the agent: "Woken by background task «<desc>» — exited N" (failed, exit code parsed from the
// notification <summary>), "… — finished" (completed), or "… — stopped" (killed). `desc` prefers the
// Bash `description`, falling back to the command summary; kept short so the divider label stays tidy.
function backgroundWakeLabel(call: TranscriptToolCall, status: string, raw: string): string {
  const rawDesc = (call.desc ?? call.detail ?? "background command").trim()
  const desc = rawDesc.length > 64 ? `${rawDesc.slice(0, 63)}…` : rawDesc
  let outcome: string
  if (status === "completed") outcome = "finished"
  else if (status === "killed") outcome = "stopped"
  else {
    const code = raw.match(/exit code (\d+)/)?.[1]
    outcome = code ? `exited ${code}` : "failed"
  }
  return `Woken by background task «${desc}» — ${outcome}`
}

// A completion <task-notification> (rides a queue-operation record as a top-level `content` string;
// only completed/failed/killed are terminal — a non-terminal "running" ping also exists). Two cases:
//   • A tracked AGENT dispatch → re-render its AgentBlock card inline at the notification's position
//     (clickable into the run-log drawer right there in the timeline) and back-fill the launch card.
//   • A tracked background SHELL → back-fill the shell card's terminal state AND emit a `boundary` event
//     line (the wake re-invoked the agent, opening a fresh turn that would otherwise merge visually).
// null when the id matches neither (an unrelated process, or an already-consumed child). Deletes the
// matched entry so a re-notify is a no-op.
function completionEvent(
  rec: Raw,
  dispatches: Map<string, { at?: string; call: TranscriptToolCall }>,
  backgroundShells: Map<string, { at?: string; call: TranscriptToolCall }>,
): TranscriptMessage | null {
  const raw = typeof rec.content === "string" ? rec.content : undefined
  if (!raw || !raw.includes("<task-notification>")) return null
  const status = raw.match(/<status>([^<]*)<\/status>/)?.[1]
  if (status !== "completed" && status !== "failed" && status !== "killed") return null
  const id = raw.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)?.[1]
  if (!id) return null
  const d = dispatches.get(id)
  if (!d) {
    const shell = backgroundShells.get(id)
    if (!shell) return null // an unrelated process, or an already-consumed child
    backgroundShells.delete(id)
    const elapsedMs = elapsedBetween(shell.at, rec.timestamp)
    shell.call.status = status === "completed" ? "completed" : status === "killed" ? "cancelled" : "failed"
    if (elapsedMs !== undefined) shell.call.durationMs = elapsedMs
    // The shell's disclosure card already carries the terminal status above; but this notification also
    // RE-INVOKES the agent, opening a fresh turn with no boundary from the prior one — two turns paint as
    // one bubble. Emit a `boundary` event line at the wake point so the timeline shows a divider carrying
    // the cause ("Woken by background task «…» — exited N"). The caller resets lastAssistantId, so this
    // also breaks the assistant-record merge chain across the wake.
    return {
      role: "assistant",
      kind: "event",
      boundary: true,
      text: backgroundWakeLabel(shell.call, status, raw),
      tools: [],
      parts: [],
      at: typeof rec.timestamp === "string" ? rec.timestamp : undefined,
    }
  }
  dispatches.delete(id)
  const start = d.at ? Date.parse(d.at) : NaN
  const end = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN
  const elapsedMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
  d.call.agentStatus = status
  d.call.agentElapsedMs = elapsedMs
  d.call.status = status === "completed" ? "completed" : status === "killed" ? "cancelled" : "failed"
  if (elapsedMs !== undefined) d.call.durationMs = elapsedMs
  // Re-render the SAME AgentBlock card inline at the completion point — reusing the dispatch's tool
  // call (now carrying its terminal status + duration) so the finished agent is clickable into its
  // run-log drawer RIGHT where it landed in the timeline, not only up-thread at the launch card. A
  // shallow copy keeps the two out-entries from sharing one mutable object. The client renders it via
  // the ordinary tools-part → AgentBlock path (no bubble chrome for an assistant tools-only message).
  const finishedCall: TranscriptToolCall = { ...d.call }
  return {
    role: "assistant",
    text: "", // tools-only message (no prose)
    tools: [finishedCall],
    parts: [{ kind: "tools", tools: [finishedCall] }],
    at: typeof rec.timestamp === "string" ? rec.timestamp : undefined,
  }
}

export function readTranscript(project: Project, sessionId: string): TranscriptMessage[] {
  try {
    const path = join(homedir(), ".claude", "projects", project.cwdSlug, `${sessionId}.jsonl`)
    return parseTranscript(readFileSync(path, "utf8"), `claude:${sessionId}`)
  } catch {
    return [] // file not created yet (agent still booting) — the UI shows the spinner
  }
}

// A thread slug that is ITSELF a session id — a FOREIGN thread (a maintainer terminal) has no registry
// row, and its thread id IS its session id. The regex admits only hex + dashes (a uuid shape), which
// forecloses path separators so the session-id join in readTranscript can't traverse out of the log dir.
export const FOREIGN_SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

// The Claude Code per-project transcript dir: ~/.claude/projects/<cwdSlug>/. (Mirrors the tailer's.)
function logDirOf(project: Project): string {
  return join(homedir(), ".claude", "projects", project.cwdSlug)
}

// ---- Codex rollout → renderable conversation ----
// Codex writes a DIFFERENT transcript schema than Claude: each rollout line is {timestamp,type,payload}
// (see ~/.codex/sessions/**/rollout-*.jsonl). The AUTHORITATIVE record→event mapping already lives in
// backend/codex.ts parseCodexLine — the SAME mapping the tailer folds for board telemetry — so we reuse
// it verbatim here; the drawer and the board can then never disagree about what a codex record means.
// This function GROUPS that normalized event stream into the TranscriptMessage[] the chat drawer
// renders: the codex analogue of parseTranscript. Event handling (see NormalizedEvent):
//   assistant-text → assistant prose (commentary + final_answer both render; final carries the fence)
//   tool-call      → a tool card (exec_command/shell → Bash; apply_patch → diff; else generic)
//   tool-result    → back-filled onto the matching call's `output` by call_id
//   user-message   → a human bubble (the first strips the dispatch scaffolding + discovery sentinel)
//   reasoning      → a standalone expandable "reasoning" message (codex's plaintext summary[])
//   turn-start     → ignored (a bracket, not content)
//   turn-end       → ignored unless it carries finalText no assistant-text already surfaced (defensive)
//   title          → ignored (board telemetry only)
// Same defensive posture as parseTranscript: a bad line → parseCodexLine [] → skipped, never throws.
export function projectCodexTranscript(raw: string, identityPrefix = "codex"): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  // The open assistant message the current turn's text/tool events append to. A user turn closes it
  // (→ null) so the next assistant content starts a fresh message.
  let cur: TranscriptMessage | null = null
  // Tool calls awaiting their function_call_output, keyed by call_id — the codex analogue of pendingReads.
  const pendingCalls = new Map<string, { call: TranscriptToolCall; at?: string; owner?: { call: TranscriptToolCall; at?: string }; orphanPoll?: boolean }>()
  // Codex yielded PTYs identify the real shell lifecycle by `session_id`, not by the wrapper call id.
  // Keep this map while projecting so later write_stdin polls back-fill the originating Bash card.
  const shellSessions = new Map<string, { call: TranscriptToolCall; at?: string }>()
  // The last FINAL assistant text rendered, so a task_complete.last_agent_message that merely echoes it
  // isn't surfaced twice (the common case); a genuinely-different finalText is a defensive fallback.
  let lastFinalText: string | null = null
  // Whether the CURRENT turn already emitted a FINAL answer (agent_message/final_answer) — reset by
  // turn-start / a user turn. Gates the turn-end fallback: only a turn that produced NO final answer
  // falls back to task_complete.last_agent_message, so a commentary-only turn whose answer lives ONLY
  // on the bracket is still surfaced, while a normal turn's echoed answer never double-renders. Tracked
  // as a flag (not read off `cur`) because TS can't narrow the closure-mutated `cur`.
  let sawFinalAnswer = false
  // The CURRENT turn's reasoning block. Codex emits its reasoning as a SEQUENCE of `reasoning` records
  // across the turn (think → act → think → act), each a short summary step. We COALESCE them into one
  // expandable "train of thought" block per turn — appending each step to this message — so the reader
  // sees the whole chain in one place rather than scattered single-step teasers. Reset (→ null) at each
  // turn boundary (turn-start / a human turn) so the next turn opens a fresh block.
  let turnReasoning: TranscriptMessage | null = null
  // Timestamp of the PREVIOUS event (any kind), so each reasoning step's THINKING time is its gap from
  // the event before it. Summed onto the turn's reasoning block as durationMs → the "Thought for Ns"
  // label. Tool-EXECUTION time never lands here: it's the gap on a function_call_output, not on a
  // reasoning record, so it's excluded. The large idle between turns sits on a turn-start, also excluded.
  let prevEventAt: string | undefined
  // Codex may omit Fray's requested first-final marker, then provide one on a later finalized
  // response. Strip an exact first-line marker from every final so a valid recovery signal never
  // leaks into rendered prose. Ordinary examples remain literal unless they occupy that control slot.

  const openAssistant = (at: string | undefined, sourceId: string): TranscriptMessage => {
    if (cur) return cur
    cur = { sourceId, role: "assistant", text: "", tools: [], parts: [], at }
    out.push(cur)
    return cur
  }

  let byteOffset = 0
  for (const line of raw.split("\n")) {
    const lineOffset = byteOffset
    byteOffset += Buffer.byteLength(line) + 1
    if (!line.trim()) continue
    let eventOrdinal = 0
    for (const ev of parseCodexLine(line)) {
      const sourceId = `${identityPrefix}:${lineOffset}:${eventOrdinal++}`
      switch (ev.kind) {
        case "assistant-text": {
          // New sessions send the invisible attribute comment in their first commentary message,
          // before any tool call. Strip that transport from every phase. Legacy H1/comment syntax is
          // final-only so normal commentary headings remain ordinary prose.
          let text = extractCodexFrayTitle(ev.text, ev.final).text
          if (text) {
            const m = openAssistant(ev.at, sourceId)
            pushTextPart(m, text)
            m.text = m.text ? `${m.text}\n\n${text}` : text
          }
          if (ev.final) {
            lastFinalText = text
            sawFinalAnswer = true
          }
          break
        }
        case "tool-call": {
          const m = openAssistant(ev.at, sourceId)
          const call = codexToolCall(ev.name, ev.input)
          call.status = "pending"
          const isPoll = call.name === "Poll process" && call.sessionId !== undefined
          const owner = isPoll ? shellSessions.get(String(call.sessionId)) : undefined
          // Polls are lifecycle updates, not independent shell work. Keep an unpaired poll visible as
          // UNKNOWN so a partial/reloaded transcript never fabricates a completed command.
          if (!owner) {
            if (isPoll) call.backgroundState = "unknown"
            pushToolPart(m, call)
            m.tools.push(call)
          }
          if (ev.id) pendingCalls.set(ev.id, { call, at: ev.at, owner, orphanPoll: isPoll && !owner })
          break
        }
        case "tool-result": {
          const pending = ev.id ? pendingCalls.get(ev.id) : undefined
          if (!pending) break
          pendingCalls.delete(ev.id)
          const result = codexToolResult(ev.text)
          if (result.durationMs === undefined) result.durationMs = elapsedBetween(pending.at, ev.at)
          if (pending.owner) {
            // A known write_stdin poll belongs to its originating exec_command disclosure. The wrapper
            // may complete after yielding without a process exit, so only an explicit exit_code ends it.
            const priorDuration = pending.owner.call.durationMs
            applyCodexToolResult(pending.owner.call, result)
            if (result.exitCode === undefined) {
              pending.owner.call.status = "pending"
              pending.owner.call.backgroundState = "background"
            } else {
              shellSessions.delete(String(pending.call.sessionId))
              const total = elapsedBetween(pending.owner.at, ev.at)
              // Transcript timestamps are sometimes coalesced by a rollout writer. Prefer a real
              // positive start→exit span; otherwise preserve the yielded result's own duration rather
              // than replacing it with a near-zero final poll wrapper duration.
              if (total !== undefined && total > 0) pending.owner.call.durationMs = total
              else if (priorDuration !== undefined) pending.owner.call.durationMs = priorDuration
            }
          } else if (pending.orphanPoll) {
            // No launch record to attach this poll to (history truncation/reload). Preserve the fact
            // that something may still exist, but never call that unknown process done.
            pending.call.status = "pending"
            pending.call.backgroundState = "unknown"
            if (result.output) pending.call.output = capRead(result.output)
          } else {
            applyCodexToolResult(pending.call, result)
            // Ctrl-C is a one-shot control action, never a detached process launch. Its receipt can
            // echo the target session id without meaning the interrupt itself remains live.
            if (pending.call.name !== "Interrupt process" && result.sessionId !== undefined && result.exitCode === undefined) {
              pending.call.sessionId = result.sessionId
              pending.call.status = "pending"
              pending.call.backgroundState = "background"
              shellSessions.set(String(result.sessionId), { call: pending.call, at: pending.at })
            }
          }
          break
        }
        case "reasoning": {
          // Codex's plaintext reasoning SUMMARY (summary[] of a rollout reasoning record). All of a
          // turn's reasoning steps COALESCE into one expandable block (turnReasoning): the first step
          // creates + positions the block at the top of the turn; each later step APPENDS to it, so the
          // reader gets the whole train of thought in one place. Null `cur` so the next assistant text/
          // tool opens a fresh message BELOW the reasoning row.
          const text = normalizeNewlines(ev.text).trim()
          if (text) {
            // This step's thinking time: its gap from the immediately-preceding event (clamped ≥0).
            const gap = prevEventAt && ev.at ? Date.parse(ev.at) - Date.parse(prevEventAt) : NaN
            const stepMs = Number.isFinite(gap) && gap > 0 ? gap : 0
            if (turnReasoning) {
              turnReasoning.text = `${turnReasoning.text}\n\n${text}`
              turnReasoning.durationMs = (turnReasoning.durationMs ?? 0) + stepMs
            } else {
              turnReasoning = { sourceId, role: "assistant", kind: "reasoning", text, tools: [], parts: [], at: ev.at, ...(stepMs ? { durationMs: stepMs } : {}) }
              out.push(turnReasoning)
            }
            cur = null
          }
          break
        }
        case "user-message": {
          cur = null // a human turn closes the assistant message and breaks the merge chain
          turnReasoning = null // …and starts a fresh reasoning block for the coming turn
          sawFinalAnswer = false
          let text = typeof ev.text === "string" ? normalizeNewlines(ev.text).trim() : ""
          // This must run before the general sentinel stripper: the strict complete suffix proves the
          // title reminder was Fray's append, rather than similarly-worded task prose.
          if (out.length === 0) text = stripCodexFirstPromptTitleTransport(text)
          text = stripCodexSentinel(text)
          if (!text || isInjectedNoise(text)) break
          // The first user message is the composed dispatch prompt (worker contract + orientation + TASK
          // + sentinel). Only the TASK is the human's words — mirror parseTranscript's first-message strip.
          if (out.length === 0) {
            const cut = text.indexOf("\nTASK:\n")
            if (cut !== -1) text = text.slice(cut + "\nTASK:\n".length).trim()
          }
          if (text) {
            const displayText = out.length === 0 ? githubDispatchDisplayText(text) : undefined
            out.push({ sourceId, role: "user", text, ...(displayText ? { displayText } : {}), tools: [], parts: [], at: ev.at })
          }
          break
        }
        case "turn-start":
          sawFinalAnswer = false // a fresh turn opens; a later final_answer sets this
          turnReasoning = null // …and its reasoning steps coalesce into a new block
          break
        case "turn-end": {
          // Defensive: a turn that produced NO final_answer but whose task_complete carried a distinct
          // last_agent_message still surfaces it (commentary-only turns). The lastFinalText dedupe keeps
          // the ordinary case — where final_answer already rendered the identical text — from doubling.
          let finalText = ev.finalText
          if (finalText !== undefined) finalText = extractCodexFrayTitle(finalText).text
          const ft = finalText?.trim()
          if (ft && !sawFinalAnswer && ft !== lastFinalText?.trim()) {
            const m = openAssistant(ev.at, sourceId)
            pushTextPart(m, finalText!)
            m.text = m.text ? `${m.text}\n\n${finalText!}` : finalText!
            sawFinalAnswer = true
          }
          break
        }
        // title: sidecar, not renderable content.
        default:
          break
      }
      // Advance the previous-event clock for the NEXT reasoning step's thinking-gap measurement.
      if ("at" in ev && typeof ev.at === "string") prevEventAt = ev.at
    }
  }

  return out
}

export function parseCodexTranscript(raw: string, identityPrefix = "codex"): TranscriptMessage[] {
  const out = projectCodexTranscript(raw, identityPrefix)
  return out.length > MAX_MESSAGES ? out.slice(-MAX_MESSAGES) : out
}

// Codex currently has two tool protocols: legacy function_call records and the unified custom exec
// wrapper whose raw JavaScript invokes tools.exec_command, tools.apply_patch, tools.update_plan, etc.
// Decode only static strings/structure from that wrapper (never evaluate it), then normalize both
// protocols onto the same Bash/Edit/generic card family. Unknown calls retain capped input, so the
// renderer always has something more useful than a bare tool name.
function codexToolCall(name: string, input: unknown): TranscriptToolCall {
  if (name === "exec" && typeof input === "string") return codexExecWrapperCall(input)

  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const direct = codexDirectToolCall(name, obj)
  if (direct) return direct
  const cmd = extractShellCommand(obj)
  if (cmd) {
    const cwd = strField(obj.workdir) ?? strField(obj.cwd)
    return { name: "Bash", detail: bashSummary(cmd), command: capCommand(cmd), cwd }
  }
  const patch = name === "apply_patch" || name === "patch" ? extractPatch(input, obj) : undefined
  if (patch) {
    const edit = parseApplyPatch(patch)
    if (edit) return { name: "Edit", detail: edit.file, edit, input: capToolInput(patch) }
    return { name: "Edit", detail: patchSummary(patch), input: capToolInput(patch) }
  }
  return {
    name: name && name.trim() ? redactToolPayload(name.trim()) : "tool",
    detail: toolDetail(input),
    input: renderToolInput(input),
  }
}

function codexDirectToolCall(name: string, obj: Record<string, unknown>): TranscriptToolCall | undefined {
  const target = strField(obj.target)
  switch (name) {
    case "spawn_agent":
      return {
        name: "Spawn agent",
        detail: strField(obj.task_name) ?? "sub-agent",
        input: compactFields(obj, ["model", "reasoning_effort", "fork_context", "fork_turns"]),
      }
    case "send_message":
      return { name: "Send message", detail: target }
    case "followup_task":
      return { name: "Follow up", detail: target }
    case "list_agents":
      return { name: "Agents", detail: "list live agents" }
    case "interrupt_agent":
      return { name: "Interrupt", detail: target }
    case "wait_agent": {
      const ms = typeof obj.timeout_ms === "number" ? obj.timeout_ms : undefined
      return { name: "Wait for agents", detail: ms !== undefined ? `up to ${formatCompactDuration(ms)}` : "mailbox update" }
    }
    case "wait":
      return { name: "Wait", detail: strField(obj.cell_id) ? `cell ${strField(obj.cell_id)}` : "running tool" }
    default:
      return undefined
  }
}

function compactFields(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const projected: Record<string, unknown> = {}
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value
  }
  return Object.keys(projected).length ? renderToolInput(projected) : undefined
}

function formatCompactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

interface WrappedInvocation {
  name: string
  args: string
}

function codexExecWrapperCall(source: string): TranscriptToolCall {
  const calls = wrappedInvocations(source)
  if (calls.length !== 1) {
    return {
      name: "Exec",
      detail: calls.length ? wrappedRunSummary(calls) : bashSummary(source),
      input: capToolInput(source.trim()),
    }
  }

  const call = calls[0]
  if (call.name === "exec_command") {
    const cmd = jsStringProperty(call.args, "cmd") ?? jsStringProperty(call.args, "command")
    const cwd = jsStringProperty(call.args, "workdir") ?? jsStringProperty(call.args, "cwd")
    if (cmd) return { name: "Bash", detail: bashSummary(cmd), command: capCommand(cmd), cwd }
  }

  if (call.name === "apply_patch") {
    const patch = wrappedPatch(source, call.args)
    if (patch) {
      const edit = parseApplyPatch(patch)
      if (edit) return { name: "Edit", detail: edit.file, edit, input: capToolInput(patch) }
      return { name: "Edit", detail: patchSummary(patch), input: capToolInput(patch) }
    }
  }

  if (call.name === "update_plan") {
    return { name: "Plan", detail: planSummary(call.args), input: capToolInput(call.args) }
  }

  if (call.name === "write_stdin") {
    const sessionId = jsNumberProperty(call.args, "session_id")
    const chars = jsStringProperty(call.args, "chars")
    const isPoll = chars === "" || chars === undefined
    const isInterrupt = chars === "\u0003"
    return {
      name: isPoll ? "Poll process" : isInterrupt ? "Interrupt process" : "Write stdin",
      detail: sessionId !== undefined ? `session ${sessionId}` : "running process",
      input: !isPoll ? capToolInput(isInterrupt ? "Ctrl-C" : chars!) : undefined,
      sessionId,
    }
  }

  if (call.name === "view_image") {
    const path = jsStringProperty(call.args, "path")
    return { name: "View image", detail: path }
  }

  if (call.name === "web__run") return wrappedWebCall(call.args)

  return {
    name: wrappedToolLabel(call.name),
    detail: wrappedArgumentDetail(call.args),
    input: capToolInput(call.args || source.trim()),
  }
}

// Find direct tools.name(...) invocations while respecting strings, comments, and balanced parens.
// This is intentionally a tiny structural scanner, not a JavaScript evaluator.
function wrappedInvocations(source: string): WrappedInvocation[] {
  const out: WrappedInvocation[] = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === "\"" || c === "'" || c.charCodeAt(0) === 96) {
      i = skipJsString(source, i)
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) break
      i = end
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (!source.startsWith("tools.", i) || (i > 0 && /[\w$.]/.test(source[i - 1]))) continue
    const nameStart = i + "tools.".length
    const nameMatch = source.slice(nameStart).match(/^([A-Za-z_$][\w$]*)/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    let open = nameStart + name.length
    while (/\s/.test(source[open] ?? "")) open++
    if (source[open] !== "(") continue
    const close = matchingParen(source, open)
    if (close === -1) break
    out.push({ name, args: source.slice(open + 1, close).trim() })
    i = close
  }
  return out
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === "\"" || c === "'" || c.charCodeAt(0) === 96) {
      i = skipJsString(source, i)
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) return i
  }
  return -1
}

function skipJsString(source: string, start: number): number {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++
    else if (source[i] === quote) return i
  }
  return source.length - 1
}

function readJsString(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source[start]
  if (quote !== "\"" && quote !== "'" && quote.charCodeAt(0) !== 96) return undefined
  const end = skipJsString(source, start)
  if (end <= start || source[end] !== quote) return undefined
  const raw = source.slice(start + 1, end)
  let value = ""
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      value += raw[i]
      continue
    }
    const n = raw[++i]
    if (n === undefined) {
      value += "\\"
      break
    }
    if (n === "n") value += "\n"
    else if (n === "r") value += "\r"
    else if (n === "t") value += "\t"
    else if (n === "b") value += "\b"
    else if (n === "f") value += "\f"
    else if (n === "v") value += "\v"
    else if (n === "0") value += "\0"
    else if (n === "\n" || n === "\r") {
      if (n === "\r" && raw[i + 1] === "\n") i++
    } else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
      value += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
    } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      value += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16))
      i += 4
    } else value += n
  }
  return { value, end }
}

function jsStringProperty(source: string, key: string): string | undefined {
  const re = new RegExp("(?:[\\\"']?" + key + "[\\\"']?)\\s*:\\s*", "g")
  const m = re.exec(source)
  if (!m) return undefined
  return readJsString(source, re.lastIndex)?.value
}

function jsNumberProperty(source: string, key: string): number | undefined {
  const re = new RegExp("(?:[\\\"']?" + key + "[\\\"']?)\\s*:\\s*(-?\\d+(?:\\.\\d+)?)")
  const raw = re.exec(source)?.[1]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function wrappedStringBindings(source: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const parsed = readJsString(source, re.lastIndex)
    if (parsed) out.set(m[1], parsed.value)
  }
  return out
}

function wrappedPatch(source: string, args: string): string | undefined {
  const direct = readJsString(args, 0)?.value
  if (direct?.includes("Begin Patch")) return direct
  const id = args.match(/^([A-Za-z_$][\w$]*)\b/)?.[1]
  const bound = id ? wrappedStringBindings(source).get(id) : undefined
  return bound?.includes("Begin Patch") ? bound : undefined
}

function planSummary(args: string): string {
  const total = (args.match(/["']?step["']?\s*:/g) ?? []).length
  const complete = (args.match(/["']?status["']?\s*:\s*["']completed["']/g) ?? []).length
  if (!total) return "update plan"
  return complete === total ? total + " steps · complete" : total + " steps · " + complete + "/" + total + " complete"
}

function wrappedRunSummary(calls: WrappedInvocation[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  const kinds = [...counts].map(([tool, count]) => (count > 1 ? tool + " ×" + count : tool)).join(", ")
  return calls.length + " calls · " + kinds
}

function wrappedToolLabel(name: string): string {
  if (name === "request_user_input") return "Ask"
  if (name === "view_image") return "View image"
  return name
}

function wrappedArgumentDetail(args: string): string | undefined {
  for (const key of ["file_path", "path", "uri", "url", "query", "q", "ref_id", "pattern", "location", "ticker", "target", "question", "prompt"]) {
    const value = jsStringProperty(args, key)
    if (value) return bashSummary(value)
  }
  return undefined
}

function wrappedWebCall(args: string): TranscriptToolCall {
  const kind = /\bsearch_query\s*:/.test(args)
    ? "Search web"
    : /\bopen\s*:/.test(args)
      ? "Open web"
      : /\bfind\s*:/.test(args)
        ? "Find on page"
        : /\bweather\s*:/.test(args)
          ? "Weather"
          : /\bfinance\s*:/.test(args)
            ? "Finance"
            : "Web"
  return { name: kind, detail: wrappedArgumentDetail(args), input: capToolInput(args) }
}

function renderToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() ? capToolInput(input.trim()) : undefined
  if (!input || typeof input !== "object") return undefined
  try {
    const json = JSON.stringify(redactCredentialStructure(input), null, 2)
    return json && json !== "{}" ? capToolInput(json) : undefined
  } catch {
    return undefined
  }
}

// The shell command a codex exec/shell tool ran. exec_command ships it as `cmd` (a string); the older
// `shell`/`local_shell` tool ships `command` as either a string or an argv array (often ["bash","-lc",
// "<script>"] — we surface the script the shell actually runs). Returns undefined for a non-shell tool.
function extractShellCommand(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.cmd === "string" && obj.cmd.trim()) return obj.cmd.trim()
  const command = obj.command
  if (typeof command === "string" && command.trim()) return command.trim()
  if (Array.isArray(command) && command.length) {
    const parts = command.filter((c): c is string => typeof c === "string")
    const flag = parts.findIndex((c) => c === "-c" || c === "-lc" || c === "-lic")
    if (flag !== -1 && typeof parts[flag + 1] === "string" && parts[flag + 1].trim()) return parts[flag + 1].trim()
    const joined = parts.join(" ").trim()
    if (joined) return joined
  }
  return undefined
}

// The V4A patch text an apply_patch call carried — `{input|patch|diff: "*** Begin Patch…"}`, or the raw
// string when codex passes the patch positionally. Undefined when no patch body is present.
function extractPatch(input: unknown, obj: Record<string, unknown>): string | undefined {
  if (typeof input === "string" && input.includes("Begin Patch")) return input
  return strField(obj.input) ?? strField(obj.patch) ?? strField(obj.diff)
}

// Best-effort parse of a codex apply_patch V4A body into a SINGLE-file diff. Handles the common
// "Update File"/"Add File" single-file hunk; anything more complex (multi-file, delete) returns
// undefined so the caller falls back to rendering the raw patch. old/new are reconstructed from the hunk
// lines (context shared, '-' removed-only, '+' added-only) with the leading marker stripped. CAVEATS
// (acceptable for a best-effort card): a multi-hunk single-file update concatenates its `@@` regions
// into one old/new pair (the hunk headers are dropped), and a `*** Move to:` rename renders the diff
// under the SOURCE path (the move directive is ignored) rather than the destination.
function parseApplyPatch(patch: string): TranscriptToolCall["edit"] | undefined {
  const lines = patch.split("\n")
  let file: string | undefined
  let mode: "update" | "add" | undefined
  const oldLines: string[] = []
  const newLines: string[] = []
  let started = false
  for (const raw of lines) {
    const m = raw.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)
    if (m) {
      if (file) return undefined // a second file → multi-file, bail to raw render
      file = m[2].trim()
      mode = m[1] === "Add" ? "add" : m[1] === "Update" ? "update" : undefined
      if (!mode) return undefined // Delete (no reconstructable body) → bail to raw render
      started = true
      continue
    }
    if (!started) continue
    if (raw.startsWith("*** ")) continue // *** End Patch / next-file marker
    if (raw.startsWith("@@")) continue // hunk header
    if (raw.startsWith("+")) newLines.push(raw.slice(1))
    else if (raw.startsWith("-")) oldLines.push(raw.slice(1))
    else {
      const ctx = raw.startsWith(" ") ? raw.slice(1) : raw
      oldLines.push(ctx)
      newLines.push(ctx)
    }
  }
  if (!file) return undefined
  return { file, old: mode === "add" ? "" : capEdit(oldLines.join("\n")), new: capEdit(newLines.join("\n")) }
}

// The file an apply_patch touches, for the fallback command-card header.
function patchSummary(patch: string): string {
  const m = patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)
  return m ? m[1].trim() : "apply_patch"
}

// Strip the trailing per-dispatch discovery sentinel (`<!-- fray-session:… -->`) buildSpawn appends to
// the FIRST codex prompt so post-spawn discovery can pin the rollout — plumbing the human never typed.
function stripCodexSentinel(text: string): string {
  return text.replace(/\n*<!--\s*fray-session:[^>]*-->\s*$/, "").replace(/\s+$/, "")
}

// The spawn path appends one of these exact contracts plus the Fray-owned discovery sentinel after the
// human's task. Strip only that complete suffix from the first projected prompt: similar ordinary prose,
// or a title-transport sentence without the Fray sentinel, remains the user's text.
function stripCodexFirstPromptTitleTransport(text: string): string {
  for (const transport of [CODEX_FIRST_FINAL_TITLE_TRANSPORT, CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT]) {
    const marker = `\n\n${transport}\n\n<!-- fray-session:`
    const at = text.lastIndexOf(marker)
    if (at === -1) continue
    const sentinel = text.slice(at + marker.length)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*-->$/i.test(sentinel)) {
      return text.slice(0, at).trimEnd()
    }
  }
  return text
}

interface CodexToolResult {
  output?: string
  status: NonNullable<TranscriptToolCall["status"]>
  exitCode?: number
  durationMs?: number
  sessionId?: string | number
}

// Unified exec returns response-content text blocks. Once backend/codex flattens them, the first block
// is a script envelope and the second is usually the nested tool's JSON result. Recover output, exit
// code, and status without depending on a particular nested tool name.
function codexToolResult(text: string): CodexToolResult {
  const unified = unifiedToolResult(text)
  if (unified) return unified

  const output = cleanExecOutput(text)
  const exitMatch = text.match(/(?:Process exited with code|Exit code:)\s*(\d+)/)
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined
  const status: CodexToolResult["status"] =
    exitCode !== undefined
      ? exitCode === 0
        ? "completed"
        : "failed"
      : cancelledToolResult(text)
        ? "cancelled"
      : failedToolResult(text)
        ? "failed"
        : "completed"
  const seconds = Number(text.match(/(?:Wall time:?|Wall time seconds:)\s*([0-9.]+)/i)?.[1])
  const durationMs = Number.isFinite(seconds) ? seconds * 1000 : undefined
  return { output: output || undefined, status, exitCode, durationMs }
}

// Result text is untrusted command/tool output: words such as "0 failed" and documentation about a
// killed process are ordinary successful output, not lifecycle telemetry. Prefer structured error
// envelopes, then narrow leading failure phrases. Explicit wrapper status/exit codes win above.
function failedToolResult(text: string): boolean {
  const t = text.trimStart()
  try {
    const parsed = JSON.parse(t) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (obj.error != null || obj.success === false || obj.ok === false || obj.status === "failed" || obj.status === "error") return true
    }
  } catch {
    // Plain text is the common result shape.
  }
  if (/^(?:0\s+failed\b|no\s+(?:errors?|failures?)\b)/i.test(t)) return false
  return (
    /^(?:error|failed|failure|permission denied|verification failed|script error|unknown process id)\b/i.test(t) ||
    /^(?:tool(?: call)?|command|process|operation|request|task|collab spawn|apply_patch)\s+(?:verification\s+)?failed\b/i.test(t)
  )
}

function unifiedToolResult(text: string): CodexToolResult | undefined {
  const raw = typeof text === "string" ? text : ""
  const header = raw.match(/^Script (completed|failed)\r?\nWall time:?\s*([0-9.]+) seconds\r?\nOutput:\r?\n/)
  if (!header) return undefined
  const wrapperStatus: "completed" | "failed" = header[1] === "failed" ? "failed" : "completed"
  const wrapperDurationMs = Number(header[2]) * 1000
  const body = raw.slice(header[0].length).trim()
  if (!body || body === "{}") return { status: wrapperStatus, durationMs: wrapperDurationMs }

  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const exitCode = typeof obj.exit_code === "number" && Number.isInteger(obj.exit_code) ? obj.exit_code : undefined
      const output = typeof obj.output === "string" ? obj.output.replace(/\s+$/, "") : undefined
      const nestedSeconds = typeof obj.wall_time_seconds === "number" && Number.isFinite(obj.wall_time_seconds) ? obj.wall_time_seconds : undefined
      const sessionId = typeof obj.session_id === "number" || typeof obj.session_id === "string" ? obj.session_id : undefined
      const nestedStatus: CodexToolResult["status"] =
        exitCode !== undefined
          ? exitCode === 0
            ? "completed"
            : "failed"
          : cancelledToolResult(output ?? body)
            ? "cancelled"
            : wrapperStatus === "failed" || failedToolResult(body)
              ? "failed"
              : "completed"
      return {
        output: output || undefined,
        status: nestedStatus,
        exitCode,
        durationMs: nestedSeconds !== undefined ? nestedSeconds * 1000 : wrapperDurationMs,
        sessionId,
      }
    }
  } catch {
    // A non-JSON result is still useful verbatim below.
  }

  const output = body.replace(/^Script error:\r?\n/, "").trim()
  return {
    output: output || undefined,
    status: cancelledToolResult(output) ? "cancelled" : wrapperStatus === "failed" || failedToolResult(output) ? "failed" : "completed",
    durationMs: wrapperDurationMs,
  }
}

function applyCodexToolResult(call: TranscriptToolCall, result: CodexToolResult): void {
  call.status = result.status
  if (result.exitCode !== undefined) call.exitCode = result.exitCode
  if (result.durationMs !== undefined) call.durationMs = result.durationMs
  if (result.sessionId !== undefined) {
    call.sessionId = typeof result.sessionId === "string" ? redactToolPayload(result.sessionId) : result.sessionId
  }
  if (!result.output) return

  const summary = codexResultSummary(call.name, result.output)
  if (summary) call.output = capRead(summary)
}

function codexResultSummary(name: string, output: string): string | undefined {
  if (name === "View image" && output === "[image output]") return undefined
  if (name === "Agents") {
    try {
      const parsed = JSON.parse(output) as { agents?: Array<{ agent_status?: unknown }> }
      if (Array.isArray(parsed.agents)) {
        const states = new Map<string, number>()
        for (const agent of parsed.agents) {
          const raw = agent?.agent_status
          const state = typeof raw === "string" ? raw : raw && typeof raw === "object" ? Object.keys(raw)[0] ?? "unknown" : "unknown"
          states.set(state, (states.get(state) ?? 0) + 1)
        }
        const detail = [...states].map(([state, count]) => `${count} ${state}`).join(" · ")
        return `${parsed.agents.length} agents${detail ? ` · ${detail}` : ""}`
      }
    } catch {
      // Fall through to the bounded raw result.
    }
  }
  if (name === "Wait for agents") {
    try {
      const parsed = JSON.parse(output) as { timed_out?: unknown; message?: unknown }
      if (parsed.timed_out === true) return "Timed out without an update"
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim()
    } catch {
      // Fall through.
    }
  }
  if (name === "Interrupt") {
    try {
      const parsed = JSON.parse(output) as { previous_status?: unknown }
      if (typeof parsed.previous_status === "string") return `Previous status: ${parsed.previous_status}`
    } catch {
      // Fall through.
    }
  }
  return output
}

// Codex's exec_command output rides an envelope: "Chunk ID: …\nWall time: …\nProcess exited with code
// N\nOriginal token count: …\nOutput:\n<stdout/stderr>". Strip it to the actual output, prepending a
// compact "[exit N]" only when the command FAILED (a non-zero exit is signal the reader wants). A result
// that doesn't match the envelope (a `shell`-tool result, an already-bare string) is returned trimmed.
function cleanExecOutput(text: string): string {
  const t = typeof text === "string" ? text : ""
  const marker = t.indexOf("\nOutput:\n")
  if (marker === -1) return t.trim()
  const body = t.slice(marker + "\nOutput:\n".length).replace(/\s+$/, "")
  const exit = t.match(/Process exited with code (\d+)/)
  if (exit && exit[1] !== "0") return `[exit ${exit[1]}]${body ? `\n${body}` : ""}`
  return body
}

// A lazily-built default CodexBackend for the render path when no per-request backendFor is threaded
// (e.g. a unit test that calls readThreadTranscript directly). Uses $CODEX_HOME (default ~/.codex), so
// prod behavior is identical whether or not the caller passes its wired backendFor.
let _defaultCodexBackend: AgentBackend | null = null
function defaultCodexBackend(): AgentBackend {
  return (_defaultCodexBackend ??= createCodexBackend({}))
}

// ── bounded, turn-aligned backward pagination ──────────────────────────────────────────────────────
// The normal live transcript remains the latest MAX_MESSAGES projection. Older history is fetched only
// on demand. A page walks backward to the previous PROJECTED user message; provider records that do not
// render have already disappeared by this point, so Claude/Codex plumbing can never manufacture a turn
// boundary. Pathological single turns continue in bounded chunks instead of creating an unbounded RPC.
export const TRANSCRIPT_EARLIER_MAX_ITEMS = 100
export const TRANSCRIPT_EARLIER_MAX_BYTES = 512 * 1024

interface TranscriptSourceBinding {
  slug: string
  sessionId: string
  nativeId: string
  backend: "claude" | "codex"
  runtimeGeneration: number
  path: string
}

interface FixedTranscriptSnapshot extends TranscriptSourceBinding {
  raw: string
  bytes: Buffer
  fileKey: string
  transcriptKey: string
}

interface TranscriptCursorPayload {
  v: 1
  slug: string
  sessionId: string
  nativeId: string
  backend: "claude" | "codex"
  runtimeGeneration: number
  fileKey: string
  snapshotBytes: number
  prefixDigest: string
  anchorSourceId: string
}

function sourceForThread(
  project: Project,
  storage: Storage,
  slug: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptSourceBinding | undefined {
  const row = storage.getSession(slug)
  if (row) {
    const backend = row.backend === "codex" ? "codex" : "claude"
    const nativeId = backend === "codex"
      ? row.agent_session_id ?? row.session_id
      : row.transcript_id ?? row.session_id
    const path = backend === "codex"
      ? (backendFor?.("codex") ?? defaultCodexBackend()).transcriptPath(nativeId)
      : join(logDirOf(project), `${nativeId}.jsonl`)
    if (!path) return undefined
    return {
      slug,
      sessionId: row.session_id,
      nativeId,
      backend,
      runtimeGeneration: row.runtime_generation ?? 0,
      path,
    }
  }
  if (!FOREIGN_SESSION_ID_RE.test(slug)) return undefined
  return {
    slug,
    sessionId: slug,
    nativeId: slug,
    backend: "claude",
    runtimeGeneration: 0,
    path: join(logDirOf(project), `${slug}.jsonl`),
  }
}

function discoveredClaudeSource(
  project: Project,
  storage: Storage,
  slug: string,
  expectedNativeId?: string,
): TranscriptSourceBinding | undefined {
  const row = storage.getSession(slug)
  if (!row || row.backend === "codex" || row.transcript_id) return undefined
  if (Date.now() - Date.parse(row.spawned_at) < DISCOVERY_GRACE_MS) return undefined
  const exclude = new Set<string>()
  for (const candidate of storage.allSessions()) {
    if (candidate.slug === row.slug) continue
    exclude.add(candidate.session_id)
    if (candidate.transcript_id) exclude.add(candidate.transcript_id)
  }
  const nativeId = discoverTranscriptId(logDirOf(project), row.session_id, { exclude })
  if (!nativeId || (expectedNativeId !== undefined && nativeId !== expectedNativeId)) return undefined
  return {
    slug,
    sessionId: row.session_id,
    nativeId,
    backend: "claude",
    runtimeGeneration: row.runtime_generation ?? 0,
    path: join(logDirOf(project), `${nativeId}.jsonl`),
  }
}

function fixedSnapshot(source: TranscriptSourceBinding): FixedTranscriptSnapshot | undefined {
  let fd: number | undefined
  try {
    fd = openSync(source.path, "r")
    const before = fstatSync(fd)
    if (!Number.isSafeInteger(before.size) || before.size < 0) throw new Error("transcript is too large to page safely")
    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    const after = fstatSync(fd)
    if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) {
      throw new Error("transcript changed while it was being read; retry")
    }
    const fileKey = `${before.dev}:${before.ino}:${Math.trunc(before.birthtimeMs)}`
    const transcriptKey = createHash("sha256")
      .update(`${source.slug}\0${source.sessionId}\0${source.nativeId}\0${source.backend}\0${source.runtimeGeneration}\0${fileKey}`)
      .digest("base64url")
      .slice(0, 32)
    return { ...source, raw: bytes.toString("utf8"), bytes, fileKey, transcriptKey }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function projectSnapshot(snapshot: FixedTranscriptSnapshot): TranscriptMessage[] {
  const prefix = `${snapshot.backend}:${snapshot.nativeId}`
  return snapshot.backend === "codex"
    ? projectCodexTranscript(snapshot.raw, prefix)
    : projectClaudeTranscript(snapshot.raw, prefix)
}

function digestPrefix(bytes: Buffer, length = bytes.length): string {
  return createHash("sha256").update(bytes.subarray(0, length)).digest("base64url")
}

function encodeTranscriptCursor(snapshot: FixedTranscriptSnapshot, anchorSourceId: string): string {
  const payload: TranscriptCursorPayload = {
    v: 1,
    slug: snapshot.slug,
    sessionId: snapshot.sessionId,
    nativeId: snapshot.nativeId,
    backend: snapshot.backend,
    runtimeGeneration: snapshot.runtimeGeneration,
    fileKey: snapshot.fileKey,
    snapshotBytes: snapshot.bytes.length,
    prefixDigest: digestPrefix(snapshot.bytes),
    anchorSourceId,
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function decodeTranscriptCursor(cursor: string): TranscriptCursorPayload {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error("invalid transcript cursor")
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new Error("invalid transcript cursor")
  }
  const p = value as Partial<TranscriptCursorPayload> | null
  const validText = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\0\r\n]/.test(s)
  if (
    !p || p.v !== 1 || !validText(p.slug, 256) || !validText(p.sessionId, 256) ||
    !validText(p.nativeId, 256) || (p.backend !== "claude" && p.backend !== "codex") ||
    !Number.isSafeInteger(p.runtimeGeneration) || (p.runtimeGeneration ?? -1) < 0 ||
    !validText(p.fileKey, 256) || !Number.isSafeInteger(p.snapshotBytes) || (p.snapshotBytes ?? -1) < 0 ||
    !validText(p.prefixDigest, 128) || !validText(p.anchorSourceId, 768)
  ) throw new Error("invalid transcript cursor")
  return p as TranscriptCursorPayload
}

function messageBytes(message: TranscriptMessage): number {
  return Buffer.byteLength(JSON.stringify(message))
}

export interface ProjectedEarlierPage {
  start: number
  messages: TranscriptMessage[]
  reachedTurnBoundary: boolean
}

// Pure page selection over the canonical projection. `anchor` is excluded: it is already rendered.
export function pageProjectedTranscript(
  messages: readonly TranscriptMessage[],
  anchor: number,
  limits: { maxItems?: number; maxBytes?: number } = {},
): ProjectedEarlierPage {
  if (!Number.isSafeInteger(anchor) || anchor <= 0 || anchor > messages.length) {
    return { start: Math.max(0, Math.min(messages.length, anchor || 0)), messages: [], reachedTurnBoundary: true }
  }
  let boundary = 0
  for (let i = anchor - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      boundary = i
      break
    }
  }
  const maxItems = Math.max(1, Math.floor(limits.maxItems ?? TRANSCRIPT_EARLIER_MAX_ITEMS))
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes ?? TRANSCRIPT_EARLIER_MAX_BYTES))
  let start = anchor
  let bytes = 0
  while (start > boundary && anchor - start < maxItems) {
    const nextBytes = messageBytes(messages[start - 1])
    // One canonical message is atomic. Fail explicitly instead of truncating its text/tools or silently
    // violating the response ceiling; ordinary provider output is well below this defensive bound.
    if (nextBytes > maxBytes) throw new Error("one transcript message exceeds the earlier-page byte limit")
    if (bytes + nextBytes > maxBytes) break
    start--
    bytes += nextBytes
  }
  return {
    start,
    messages: messages.slice(start, anchor),
    reachedTurnBoundary: start === boundary,
  }
}

function emptyTranscriptPage(source?: TranscriptSourceBinding): TranscriptPage {
  const keySeed = source
    ? `${source.slug}\0${source.sessionId}\0${source.nativeId}\0${source.backend}\0${source.runtimeGeneration}\0missing`
    : "unavailable"
  return {
    messages: [],
    beforeCursor: null,
    hasEarlier: false,
    reachedTurnBoundary: true,
    transcriptKey: createHash("sha256").update(keySeed).digest("base64url").slice(0, 32),
  }
}

export function readLatestThreadTranscriptPage(
  project: Project,
  storage: Storage,
  slug: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptPage {
  let source = sourceForThread(project, storage, slug, backendFor)
  if (!source) return emptyTranscriptPage()
  let snapshot = fixedSnapshot(source)
  if (!snapshot) {
    const discovered = discoveredClaudeSource(project, storage, slug)
    const discoveredSnapshot = discovered ? fixedSnapshot(discovered) : undefined
    if (!discoveredSnapshot) return emptyTranscriptPage(source)
    source = discovered!
    snapshot = discoveredSnapshot
  }
  let projected = projectSnapshot(snapshot)
  // Match the legacy reader's gated, bounded drift recovery for old Claude sessions whose real file
  // was minted under a different native id. The cursor binds that discovered id; the follow-up read
  // repeats the same sentinel proof until the tailer persists the re-link.
  if (!projected.length) {
    const discovered = discoveredClaudeSource(project, storage, slug)
    const discoveredSnapshot = discovered ? fixedSnapshot(discovered) : undefined
    if (discoveredSnapshot) {
      source = discovered!
      snapshot = discoveredSnapshot
      projected = projectSnapshot(snapshot)
    }
  }
  const start = Math.max(0, projected.length - MAX_MESSAGES)
  return {
    messages: projected.slice(start),
    beforeCursor: start > 0 ? encodeTranscriptCursor(snapshot, projected[start].sourceId!) : null,
    hasEarlier: start > 0,
    reachedTurnBoundary: true,
    transcriptKey: snapshot.transcriptKey,
  }
}

export function readEarlierThreadTranscriptPage(
  project: Project,
  storage: Storage,
  slug: string,
  cursor: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptPage {
  const payload = decodeTranscriptCursor(cursor)
  if (payload.slug !== slug) throw new Error("transcript cursor belongs to another thread")
  let source = sourceForThread(project, storage, slug, backendFor)
  if (
    source && source.sessionId === payload.sessionId && source.backend === payload.backend &&
    source.runtimeGeneration === payload.runtimeGeneration && source.nativeId !== payload.nativeId
  ) {
    source = discoveredClaudeSource(project, storage, slug, payload.nativeId) ?? source
  }
  if (
    !source || source.sessionId !== payload.sessionId || source.nativeId !== payload.nativeId ||
    source.backend !== payload.backend || source.runtimeGeneration !== payload.runtimeGeneration
  ) throw new Error("transcript cursor is stale because the session was replaced")
  const snapshot = fixedSnapshot(source)
  if (!snapshot || snapshot.fileKey !== payload.fileKey || snapshot.bytes.length < payload.snapshotBytes) {
    throw new Error("transcript cursor is stale because the transcript was replaced")
  }
  if (digestPrefix(snapshot.bytes, payload.snapshotBytes) !== payload.prefixDigest) {
    throw new Error("transcript cursor is stale because prior transcript bytes changed")
  }
  const projected = projectSnapshot(snapshot)
  const anchor = projected.findIndex((message) => message.sourceId === payload.anchorSourceId)
  if (anchor < 0) throw new Error("transcript cursor boundary is no longer present")
  const page = pageProjectedTranscript(projected, anchor)
  return {
    messages: page.messages,
    beforeCursor: page.start > 0 ? encodeTranscriptCursor(snapshot, projected[page.start].sourceId!) : null,
    hasEarlier: page.start > 0,
    reachedTurnBoundary: page.reachedTurnBoundary,
    transcriptKey: snapshot.transcriptKey,
  }
}

// Parse a codex rollout from an ABSOLUTE file path (the located ~/.codex/sessions/**/rollout-*.jsonl).
// Missing/unreadable file → [] (the drawer renders its spinner / "transcript unavailable" state).
export function readCodexTranscriptFile(absPath: string, nativeId = absPath): TranscriptMessage[] {
  try {
    return parseCodexTranscript(readFileSync(absPath, "utf8"), `codex:${nativeId}`)
  } catch {
    return []
  }
}

// Resolve a thread slug to its rendered transcript: a registry row's DISCOVERED transcript (transcript_id)
// if one was cached, else its pinned session_id; for a foreign thread the slug itself as a session id;
// else empty. When the pinned transcript renders empty and nothing's been cached yet, a best-effort
// content discovery (scratchpad sentinel, same as the tailer) re-links a drifted transcript so the drawer
// isn't blank while the tailer catches up. The single resolution the threadTranscript RPC and the /ws
// transcript producer share, so foreign threads render identically on both paths. Degrades to [].
export function readThreadTranscript(
  project: Project,
  storage: Storage,
  slug: string,
  backendFor?: (kind?: string) => AgentBackend,
): TranscriptMessage[] {
  const row = storage.getSession(slug)
  if (row) {
    // Codex threads write a DIFFERENT transcript schema in a DIFFERENT place (~/.codex/sessions,
    // date-sharded, located by the discovered rollout id) — route them through the codex reader+parser
    // so the drawer renders codex messages + tool calls instead of an empty pane. The rollout id is
    // `agent_session_id` (the id codex minted, pinned post-discovery); until discovery pins it,
    // transcriptPath returns undefined → [] and the drawer keeps its spinner (the tailer catches up).
    if (row.backend === "codex") {
      const backend = backendFor?.("codex") ?? defaultCodexBackend()
      const nativeId = row.agent_session_id ?? row.session_id
      const path = backend.transcriptPath(nativeId)
      return path ? readCodexTranscriptFile(path, nativeId) : []
    }
    const msgs = readTranscript(project, row.transcript_id ?? row.session_id)
    if (msgs.length || row.transcript_id) return msgs
    // The pinned transcript rendered empty and nothing's cached. GATE the fallback on the spin-up grace:
    // a fresh dispatch renders empty simply because its file isn't written yet, and this path runs on
    // every drawer view / WS subscribe — an ungated per-view directory scan would be wasted work on the
    // common case. Only a genuinely-overdue thread engages discovery (bounded; see discover.ts).
    if (Date.now() - Date.parse(row.spawned_at) < DISCOVERY_GRACE_MS) return msgs
    // Exclude ids owned by OTHER rows (their pinned + discovered transcripts) — never steal a claimed one.
    const exclude = new Set<string>()
    for (const r of storage.allSessions()) {
      if (r.slug === row.slug) continue
      exclude.add(r.session_id)
      if (r.transcript_id) exclude.add(r.transcript_id)
    }
    const found = discoverTranscriptId(logDirOf(project), row.session_id, { exclude })
    return found ? readTranscript(project, found) : msgs
  }
  if (FOREIGN_SESSION_ID_RE.test(slug)) return readTranscript(project, slug)
  return []
}

// Parse a transcript from an ABSOLUTE file path (vs. project+session_id). Used for a sub-agent's own
// JSONL (the tracked outputFile, a symlink to ~/.claude/projects/<cwd>/subagents/agent-<id>.jsonl),
// which shares the session record format exactly — so the same mechanical block/tool extraction
// applies. Missing/unreadable file → [] (the drawer renders its "transcript unavailable" state).
export function readTranscriptFile(absPath: string): TranscriptMessage[] {
  try {
    const pathKey = createHash("sha256").update(absPath).digest("base64url").slice(0, 16)
    return parseTranscript(readFileSync(absPath, "utf8"), `claude-file:${pathKey}`)
  } catch {
    return []
  }
}
