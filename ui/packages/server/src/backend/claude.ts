import { join } from "node:path"
import { buildClaudeCommand, buildClaudeResumeCommand, workerPluginDir } from "../dispatch.ts"
import { parseLine as parseClaudeRecord, applyRecord, matchesPermPrompt, isRealUserMessage, type TailState } from "../tailer.ts"
import type { AgentBackend, BuiltCommand, FoldState, NormalizedEvent, ResumeOpts, SpawnOpts } from "./types.ts"

// ClaudeBackend: everything Claude-Code-specific behind the AgentBackend seam — the spawn/resume argv
// (Claude's `--session-id` pin + `--append-system-prompt-file` worker-contract injection), the
// deterministic transcript path (~/.claude/projects/<cwdSlug>/<sessionId>.jsonl), the corpus-verified
// line fold (foldLine → the tailer's applyRecord), a normalized parseLine view, and the perm-prompt
// pane matcher. The heavy Claude derivation (applyRecord + helpers, computeTurn, the fence grammar)
// still LIVES in tailer.ts — behavior-critical and corpus-verified — and this backend reuses it
// verbatim, so Phase 1 is byte-for-byte no-behavior-change. This module is a facade over those.

export interface ClaudeBackendOptions {
  // The Claude Code per-project transcript dir (~/.claude/projects/<cwdSlug>). transcriptPath appends
  // <sessionId>.jsonl. Injected by the composition layer so it matches the tailer's foreign-scan dir.
  logDir: string
  claudeBin?: string // injectable dispatch executable (tests use a stand-in)
}

// Flatten a tool_result's `content` (an array of {type:"text", text} blocks, or a bare string) into
// one string — a small local mirror of the tailer's private helper (kept here so parseLine stays
// self-contained; it is the codex-facing normalized view, not the behavior-critical fold).
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") out += t
    }
  }
  return out
}

// Re-express one raw Claude JSONL line as NormalizedEvents (§4.2). Pure + defensive: a malformed line,
// or a record with no derivable events, yields []. This is the codex-facing seam + the unit-test
// surface; Phase-1 Claude folding uses foldLine (applyRecord), NOT this (see the NOTE on
// NormalizedEvent in ./types.ts — Claude's 3-way stop_reason turn model can't round-trip through the
// normalized union). `final` mirrors the corpus rule: an assistant text block is the final answer iff
// its record's stop_reason is "end_turn"; a "tool_use" (or preamble) block is commentary.
export function parseClaudeLine(line: string): NormalizedEvent[] {
  const rec = parseClaudeRecord(line)
  if (!rec) return []
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  const out: NormalizedEvent[] = []

  if (rec.type === "assistant") {
    const stop = typeof rec.message?.stop_reason === "string" ? rec.message.stop_reason : undefined
    const content = rec.message?.content
    let lastText: string | undefined
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown }
        if (b.type === "text" && typeof b.text === "string") {
          lastText = b.text
          // `final` marks EACH text block of an end_turn record (multi-block end_turn is rare); a
          // consumer wanting strictly "the answer" should read turn-end.finalText (the LAST block).
          out.push({ kind: "assistant-text", at, text: b.text, final: stop === "end_turn" })
        } else if (b.type === "tool_use") {
          out.push({ kind: "tool-call", at, id: typeof b.id === "string" ? b.id : "", name: typeof b.name === "string" ? b.name : "", input: b.input })
        }
      }
    }
    // A completed turn brackets on end_turn — the fence lives in the last text block.
    if (stop === "end_turn") out.push({ kind: "turn-end", at, finalText: lastText })
    return out
  }

  if (rec.type === "user") {
    const content = rec.message?.content
    const synthetic = rec.promptSource === "system"
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as { type?: string; tool_use_id?: unknown; content?: unknown }
        if (b.type === "tool_result") out.push({ kind: "tool-result", at, id: typeof b.tool_use_id === "string" ? b.tool_use_id : "", text: toolResultText(b.content) })
      }
      // A record carrying at least one non-tool_result block is a real human/peer turn; a
      // tool_result-only record is agent activity (no user-message event). Block-form user text is
      // intentionally NOT reconstructed here (Claude's fold never needs it; the field stays absent).
      if (isRealUserMessage(content)) out.push({ kind: "user-message", at, synthetic })
      return out
    }
    if (typeof content === "string") out.push({ kind: "user-message", at, text: content, synthetic })
    return out
  }

  if (rec.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim()) return [{ kind: "title", title: rec.aiTitle.trim() }]
  if (rec.type === "custom-title" && typeof rec.customTitle === "string" && rec.customTitle.trim()) return [{ kind: "title", title: rec.customTitle.trim() }]
  return []
}

export function createClaudeBackend(opts: ClaudeBackendOptions): AgentBackend {
  return {
    kind: "claude",

    buildSpawn(o: SpawnOpts): BuiltCommand {
      // workerPluginDir() is resolved per-call (not cached at construction) so a mid-run env/plugin
      // change is honored — matching the pre-refactor dispatch(), which called it on every spawn.
      const argv = buildClaudeCommand({
        sessionId: o.sessionId,
        permissionMode: o.permissionMode,
        model: o.model,
        effort: o.effort,
        prompt: o.prompt,
        claudeBin: opts.claudeBin,
        pluginDir: workerPluginDir(),
        workerPrompt: o.workerContract,
        extraSystemPrompt: o.extraSystemPrompt,
      })
      return { argv, env: {}, prewrite: [] }
    },

    buildResume(o: ResumeOpts): BuiltCommand {
      // Resume re-attaches a pinned conversation, so `o.model`/`o.effort` are intentionally NOT
      // forwarded (the model can't be retargeted mid-session).
      const argv = buildClaudeResumeCommand({
        sessionId: o.sessionId,
        permissionMode: o.permissionMode,
        message: o.message,
        claudeBin: opts.claudeBin,
        pluginDir: workerPluginDir(),
        workerPrompt: o.workerContract,
        extraSystemPrompt: o.extraSystemPrompt,
      })
      return { argv, env: {}, prewrite: [] }
    },

    transcriptPath(sessionId: string): string {
      return join(opts.logDir, `${sessionId}.jsonl`)
    },

    parseLine(line: string): NormalizedEvent[] {
      return parseClaudeLine(line)
    },

    // The authoritative fold: reuse the tailer's corpus-verified applyRecord verbatim so behavior is
    // provably unchanged (bad line → parseClaudeRecord returns null → skipped, exactly as before). The
    // tailer only ever drives ClaudeBackend with the concrete TailState it constructs, so narrowing the
    // neutral FoldState back to TailState (applyRecord needs Claude's full accumulator) is safe.
    foldLine(state: FoldState, line: string): void {
      const rec = parseClaudeRecord(line)
      if (rec) applyRecord(state as TailState, rec)
    },

    matchesPermPrompt(pane: string): boolean {
      return matchesPermPrompt(pane)
    },
  }
}
