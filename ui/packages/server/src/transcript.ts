import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { TranscriptMessage, TranscriptToolCall } from "@fray-ui/shared"
import type { Project } from "./project.ts"
import type { Storage } from "./storage.ts"
import type { AgentBackend, NormalizedEvent } from "./backend/types.ts"
import { parseCodexLine, createCodexBackend } from "./backend/codex.ts"
import { discoverTranscriptId, DISCOVERY_GRACE_MS } from "./discover.ts"

// Parse a session JSONL into a renderable conversation — mechanically, no AI. Same defensive
// posture as the tailer: bad line → skip, unknown type → ignore, never throw. Assistant messages
// arrive one record per content block sharing message.id, so consecutive assistant records with
// the same id merge into one rendered message. User records carrying only tool_result blocks are
// tool plumbing, not something the human typed — skipped.

type Raw = Record<string, any>

const MAX_MESSAGES = 300

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

export function parseTranscript(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  let lastAssistantId: string | null = null
  // Read calls awaiting their tool_result excerpt, keyed by the tool_use id. A Read's content isn't
  // in the tool_use block — it arrives later in a `user` record carrying tool_result blocks — so we
  // register the call here and back-fill its `read` excerpt when that result record streams by.
  const pendingReads = new Map<string, TranscriptToolCall>()
  // Live Agent dispatches keyed by tool_use id → the dispatch's timestamp + the emitted call object.
  // When a matching completion <task-notification> streams by we (a) back-fill the call's terminal
  // state and (b) emit an inline "event" punctuation message at that position. Delete-on-emit dedupes
  // a task-id that re-notifies. (This mirrors the tailer's completion correlation; kept separate here
  // so the transcript's mechanical parse stays decoupled from the tailer's liveness telemetry.)
  const agentDispatches = new Map<string, { at?: string; call: TranscriptToolCall }>()
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

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let rec: Raw
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }

    // A sub-agent completion notification (a queue-operation record with a top-level <task-notification>
    // content string) emits an inline event line at its position and back-fills the dispatch card.
    const ev = completionEvent(rec, agentDispatches)
    if (ev) {
      out.push(ev)
      lastAssistantId = null // an event breaks the assistant-record merge chain
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
            out.push({ role: "assistant", kind: "event", text: `Thought for ${fmtThinkDur(gap)}`, tools: [], parts: [], at: thisTs })
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
        const m: TranscriptMessage = { role: "user", text: content, tools: [], parts: [], at: thisTs, queued: true }
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
          out.push({ role: "user", text: prompt, tools: [], parts: [], at: thisTs })
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
      attachReadResults(rec, pendingReads)
      // isMeta marks harness-injected user records (hook feedback, reminders) — plumbing the
      // human never typed, so it must not render as their bubble.
      if (rec.isMeta === true) continue
      let text = userText(rec)
      // Harness/orchestrator injections that arrive as ordinary user records (task-notifications,
      // system reminders, fray pulses) are ALSO not the human's words — drop them from the chat.
      if (text && isInjectedNoise(text)) continue
      if (text) {
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
        out.push({ role: "user", text, tools: [], parts: [], at: rec.timestamp })
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
      const m: TranscriptMessage = target ?? { role: "assistant", text: "", tools: [], parts: [], at: rec.timestamp }
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
            pushToolPart(m, call)
            m.tools.push(call)
            // An Agent dispatch is registered by its tool_use id so a later completion notification can
            // back-fill its terminal state and drop an inline event line into the flow.
            if (call.agentId) agentDispatches.set(call.agentId, { at: rec.timestamp, call })
          }
          // A Read call renders as an expandable card showing WHAT it read; register it so the
          // matching tool_result record (streaming later) can back-fill the excerpt onto this object.
          if (block.name === "Read" && typeof block.id === "string" && calls.length === 1) {
            pendingReads.set(block.id, calls[0])
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

function capEdit(s: string): string {
  return s.length > EDIT_CAP ? s.slice(0, EDIT_CAP) + TRUNC_MARKER : s
}

// An Agent dispatch prompt is a full worker contract — often thousands of chars. Cap it like the
// edit/command payloads so a transcript riding the board snapshot stays light; the marker signals the
// client's AgentBlock body that the prompt is truncated.
const AGENT_PROMPT_CAP = 4000
function capAgentPrompt(s: string): string {
  return s.length > AGENT_PROMPT_CAP ? s.slice(0, AGENT_PROMPT_CAP) + TRUNC_MARKER : s
}

// A SendMessage body is peer-to-peer prose — usually short, but a steer can run long. Cap it like the
// prompt/edit payloads so a transcript riding the board snapshot stays light; the marker signals the
// client's SendMessageCard that the body is truncated.
const SEND_BODY_CAP = 4000
function capSendBody(s: string): string {
  return s.length > SEND_BODY_CAP ? s.slice(0, SEND_BODY_CAP) + TRUNC_MARKER : s
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
  return s.length > COMMAND_CAP ? s.slice(0, COMMAND_CAP) + TRUNC_MARKER : s
}
// One-line summary for a block command: its first non-blank line, with a trailing ellipsis when more
// content follows. Feeds the inline renderer and dense card previews; the full command rides `command`.
function bashSummary(cmd: string): string {
  const lines = cmd.split("\n")
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
  let out = s
  const lines = out.split("\n")
  if (lines.length > READ_LINE_CAP) out = lines.slice(0, READ_LINE_CAP).join("\n") + TRUNC_MARKER
  if (out.length > READ_BYTE_CAP) out = out.slice(0, READ_BYTE_CAP) + TRUNC_MARKER
  return out
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

// Back-fill Read excerpts: for each tool_result in this user record whose id matches a pending Read,
// attach the capped excerpt to that call object (which lives in an already-emitted assistant message).
function attachReadResults(rec: Raw, pending: Map<string, TranscriptToolCall>): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue
    const call = pending.get(b.tool_use_id)
    if (!call) continue
    pending.delete(b.tool_use_id)
    const text = toolResultText(b.content)
    if (text) call.read = capRead(text)
  }
}

// Expand one tool_use block into transcript tool calls. Usually one, but MultiEdit fans out to one
// call per sub-edit so each renders as its own diff. Edit/Write/MultiEdit additionally carry a
// structured `edit` payload (Write's old side is "" — the whole file is new).
function toolCalls(block: any): TranscriptToolCall[] {
  const name = String(block?.name ?? "tool")
  const input = block?.input
  const detail = toolDetail(input)

  if (input && typeof input === "object") {
    const file = typeof input.file_path === "string" ? input.file_path : undefined
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
      const desc = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 160) : undefined
      return [{ name, detail: bashSummary(input.command), command: capCommand(input.command), desc }]
    }
    // An Agent dispatch carrying a prompt renders as its own AgentBlock card (Bash/Read family): the
    // description is the header one-liner, subagent_type the model+effort tag, the (capped) prompt the
    // expandable body, and block.id the correlation key to the live tracked sub-agent + its drawer.
    if (name === "Agent" && typeof input.prompt === "string" && input.prompt.trim()) {
      const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : undefined
      const subagentType = typeof input.subagent_type === "string" && input.subagent_type.trim() ? input.subagent_type.trim() : undefined
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
  }

  return [{ name, detail }]
}

// A trimmed non-empty string field, else undefined — for optional input fields (SendMessage's
// to/summary/type) where empty/absent should collapse to undefined, not "".
function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

// One human-scannable hint per tool call, in preference order of what the input reveals.
function toolDetail(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined
  let cand: unknown =
    input.file_path ?? input.path ?? input.command ?? input.description ?? input.pattern ?? input.query ?? input.url
  // Generic fallback so a tool outside the known set (Monitor, custom MCP tools, …) still shows a
  // hint instead of rendering as a bare name: the first non-empty string-valued input field.
  if (typeof cand !== "string" || !cand.trim()) {
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.trim()) {
        cand = v
        break
      }
    }
  }
  if (typeof cand !== "string" || !cand.trim()) return undefined
  const s = cand.trim().replace(/\s+/g, " ")
  // Generous cap: an 80-char cut ate file paths mid-word (and its "…" broke the client's path-link
  // detection). Display truncation is the CLIENT's job (CSS ellipsis over the card's full width).
  return s.length > 400 ? `${s.slice(0, 399)}…` : s
}

// A sub-agent completion event, or null when this record isn't a terminal notification for a tracked
// Agent dispatch. Mirrors the tailer's <task-notification> parse: the notification rides a
// queue-operation record as a top-level `content` string. Only completed/failed/killed are terminal
// (a non-terminal "running" ping also exists), and only ids we registered as Agent dispatches match
// (a background-Bash task-notification carries a tool-use-id we never tracked → ignored). Back-fills
// the dispatch card's terminal state as a side effect and deletes the entry so a re-notify is a no-op.
function completionEvent(rec: Raw, dispatches: Map<string, { at?: string; call: TranscriptToolCall }>): TranscriptMessage | null {
  const raw = typeof rec.content === "string" ? rec.content : undefined
  if (!raw || !raw.includes("<task-notification>")) return null
  const status = raw.match(/<status>([^<]*)<\/status>/)?.[1]
  if (status !== "completed" && status !== "failed" && status !== "killed") return null
  const id = raw.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)?.[1]
  if (!id) return null
  const d = dispatches.get(id)
  if (!d) return null // not an Agent dispatch we're tracking (e.g. a background Bash), or already emitted
  dispatches.delete(id)
  const desc = d.call.detail ?? "sub-agent"
  const start = d.at ? Date.parse(d.at) : NaN
  const end = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN
  const elapsedMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
  d.call.agentStatus = status
  d.call.agentElapsedMs = elapsedMs
  return { role: "assistant", kind: "event", text: eventText(status, desc, elapsedMs), tools: [], parts: [], at: typeof rec.timestamp === "string" ? rec.timestamp : undefined }
}

// The inline event line: `Agent "<desc>" finished — 35m` (completed) / `… failed after 12m` /
// `… killed after 12m`. The duration is omitted when the timestamps didn't parse.
function eventText(status: "completed" | "failed" | "killed", desc: string, elapsedMs: number | undefined): string {
  const dur = elapsedMs !== undefined ? fmtDur(elapsedMs) : ""
  if (status === "completed") return `Agent "${desc}" finished${dur ? ` — ${dur}` : ""}`
  const verb = status === "failed" ? "failed" : "killed"
  return `Agent "${desc}" ${verb}${dur ? ` after ${dur}` : ""}`
}

// Coarse human duration for the event line / finished header: "<1m", "42m", "1h 3m".
function fmtDur(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "<1m"
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export function readTranscript(project: Project, sessionId: string): TranscriptMessage[] {
  try {
    const path = join(homedir(), ".claude", "projects", project.cwdSlug, `${sessionId}.jsonl`)
    return parseTranscript(readFileSync(path, "utf8"))
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
//   turn-start     → ignored (a bracket, not content)
//   turn-end       → ignored unless it carries finalText no assistant-text already surfaced (defensive)
//   title          → ignored (board telemetry only)
// Same defensive posture as parseTranscript: a bad line → parseCodexLine [] → skipped, never throws.
export function parseCodexTranscript(raw: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  // The open assistant message the current turn's text/tool events append to. A user turn closes it
  // (→ null) so the next assistant content starts a fresh message.
  let cur: TranscriptMessage | null = null
  // Tool calls awaiting their function_call_output, keyed by call_id — the codex analogue of pendingReads.
  const pendingCalls = new Map<string, TranscriptToolCall>()
  // The last FINAL assistant text rendered, so a task_complete.last_agent_message that merely echoes it
  // isn't surfaced twice (the common case); a genuinely-different finalText is a defensive fallback.
  let lastFinalText: string | null = null
  // Whether the CURRENT turn already emitted a FINAL answer (agent_message/final_answer) — reset by
  // turn-start / a user turn. Gates the turn-end fallback: only a turn that produced NO final answer
  // falls back to task_complete.last_agent_message, so a commentary-only turn whose answer lives ONLY
  // on the bracket is still surfaced, while a normal turn's echoed answer never double-renders. Tracked
  // as a flag (not read off `cur`) because TS can't narrow the closure-mutated `cur`.
  let sawFinalAnswer = false

  const openAssistant = (at?: string): TranscriptMessage => {
    if (cur) return cur
    cur = { role: "assistant", text: "", tools: [], parts: [], at }
    out.push(cur)
    return cur
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    for (const ev of parseCodexLine(line)) {
      switch (ev.kind) {
        case "assistant-text": {
          const m = openAssistant(ev.at)
          pushTextPart(m, ev.text)
          m.text = m.text ? `${m.text}\n\n${ev.text}` : ev.text
          if (ev.final) {
            lastFinalText = ev.text
            sawFinalAnswer = true
          }
          break
        }
        case "tool-call": {
          const m = openAssistant(ev.at)
          const call = codexToolCall(ev.name, ev.input)
          pushToolPart(m, call)
          m.tools.push(call)
          if (ev.id) pendingCalls.set(ev.id, call)
          break
        }
        case "tool-result": {
          const call = ev.id ? pendingCalls.get(ev.id) : undefined
          if (!call) break
          pendingCalls.delete(ev.id)
          const cleaned = cleanExecOutput(ev.text)
          if (cleaned) call.output = capRead(cleaned)
          break
        }
        case "user-message": {
          cur = null // a human turn closes the assistant message and breaks the merge chain
          sawFinalAnswer = false
          let text = typeof ev.text === "string" ? normalizeNewlines(ev.text).trim() : ""
          text = stripCodexSentinel(text)
          if (!text || isInjectedNoise(text)) break
          // The first user message is the composed dispatch prompt (worker contract + orientation + TASK
          // + sentinel). Only the TASK is the human's words — mirror parseTranscript's first-message strip.
          if (out.length === 0) {
            const cut = text.indexOf("\nTASK:\n")
            if (cut !== -1) text = text.slice(cut + "\nTASK:\n".length).trim()
          }
          if (text) out.push({ role: "user", text, tools: [], parts: [], at: ev.at })
          break
        }
        case "turn-start":
          sawFinalAnswer = false // a fresh turn opens; a later final_answer sets this
          break
        case "turn-end": {
          // Defensive: a turn that produced NO final_answer but whose task_complete carried a distinct
          // last_agent_message still surfaces it (commentary-only turns). The lastFinalText dedupe keeps
          // the ordinary case — where final_answer already rendered the identical text — from doubling.
          const ft = ev.finalText?.trim()
          if (ft && !sawFinalAnswer && ft !== lastFinalText?.trim()) {
            const m = openAssistant(ev.at)
            pushTextPart(m, ev.finalText!)
            m.text = m.text ? `${m.text}\n\n${ev.finalText!}` : ev.finalText!
            sawFinalAnswer = true
          }
          break
        }
        // title: sidecar, not renderable content.
        default:
          break
      }
    }
  }

  return out.length > MAX_MESSAGES ? out.slice(-MAX_MESSAGES) : out
}

// A codex tool_call → a renderable TranscriptToolCall. Codex's tool surface differs from Claude's: the
// dominant tool is exec_command/shell (a shell command whose stdout/stderr rides the rollout, unlike
// Claude), and file edits arrive either as shell redirects or an apply_patch call. We normalize onto the
// SAME card family Claude uses — a shell command → the Bash card (carrying its captured output),
// apply_patch → a diff card — so a codex thread reads just like a Claude one. An unrecognized tool
// degrades to a generic card carrying whatever hint its input reveals (never a throw, never a blank).
function codexToolCall(name: string, input: unknown): TranscriptToolCall {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const cmd = extractShellCommand(obj)
  if (cmd) return { name: "Bash", detail: bashSummary(cmd), command: capCommand(cmd) }
  const patch = name === "apply_patch" || name === "patch" ? extractPatch(input, obj) : undefined
  if (patch) {
    const edit = parseApplyPatch(patch)
    if (edit) return { name: "Edit", detail: edit.file, edit }
    // Unparseable/complex patch → still show the raw patch body as a command card so the edit isn't invisible.
    return { name: "apply_patch", detail: patchSummary(patch), command: capCommand(patch) }
  }
  return { name: name && name.trim() ? name.trim() : "tool", detail: toolDetail(input) }
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

// Parse a codex rollout from an ABSOLUTE file path (the located ~/.codex/sessions/**/rollout-*.jsonl).
// Missing/unreadable file → [] (the drawer renders its spinner / "transcript unavailable" state).
export function readCodexTranscriptFile(absPath: string): TranscriptMessage[] {
  try {
    return parseCodexTranscript(readFileSync(absPath, "utf8"))
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
      const path = backend.transcriptPath(row.agent_session_id ?? row.session_id)
      return path ? readCodexTranscriptFile(path) : []
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
    return parseTranscript(readFileSync(absPath, "utf8"))
  } catch {
    return []
  }
}
