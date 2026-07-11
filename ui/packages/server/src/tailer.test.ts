import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { ServerEvent } from "@fray-ui/shared"
import type { Project } from "./project.ts"
import { parseLine, applyRecord, applyEvent, computeTurn, newTailState, createTailer, matchesPermPrompt, hasQuestionBlock, isRealUserMessage, parseSignalFence, FOREIGN_FRESH_MS } from "./tailer.ts"
import type { AgentBackend, NormalizedEvent } from "./backend/types.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { mkdirSync } from "node:fs"

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ---- pure parsing / derivation ----

test("parseLine: object → record; blank/garbage/non-object → null", () => {
  assert.deepEqual(parseLine('{"type":"assistant"}'), { type: "assistant" })
  assert.equal(parseLine(""), null)
  assert.equal(parseLine("   "), null)
  assert.equal(parseLine("{not json"), null)
  assert.equal(parseLine("5"), null) // valid JSON, not an object
  assert.equal(parseLine('"a string"'), null)
})

// A record's assistant text (last text block) becomes the preview; thinking/tool_use ignored.
test("applyRecord: extracts trimmed assistant preview + advances activity", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "  hello   world \n" }] },
  })
  assert.equal(s.lastAssistant, "hello world")
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:01.000Z")
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastStopReason, "end_turn")
})

test("applyRecord: a system-origin user record (peer / task-notification) RE-INVOKES (in-flight) but never reorders the row", () => {
  const s = newTailState("t", "sid", "/x")
  // Agent comes to rest with an unanswered ```question.
  applyRecord(s, {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "```question\nA or B?\n```" }] },
  })
  assert.equal(s.lastAssistantHasQuestion, true)
  const restedUserAt = s.lastUserAt
  // A sub-agent <task-notification> lands as a user record with promptSource:"system". It RE-INVOKES
  // the agent, so the turn flips to in-flight (the agent is resuming → shimmer, not idle) and the
  // question is superseded — but it must NOT bump lastUserAt (that would reorder the row from motion
  // the human didn't cause).
  applyRecord(s, {
    type: "user",
    timestamp: "2026-07-01T00:00:05.000Z",
    promptSource: "system",
    message: { content: "<task-notification>…done</task-notification>" },
  })
  assert.equal(s.lastKind, "user") // in-flight: the agent is resuming
  assert.equal(s.lastAssistantHasQuestion, false) // superseded; the next assistant record recomputes
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:05.000Z") // transcript grew
  assert.equal(s.lastUserAt, restedUserAt) // ROW ORDER unchanged — a notification never jumps the row
})

test("applyRecord: caps preview at 200 chars with an ellipsis", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "x".repeat(500) }] } })
  assert.equal(s.lastAssistant?.length, 201) // 200 + ellipsis
  assert.ok(s.lastAssistant?.endsWith("…"))
})

test("computeTurn: end_turn=idle, tool_use=in-flight, user=in-flight", () => {
  const now = Date.parse("2026-07-01T00:00:10.000Z")

  const endTurn = newTailState("t", "s", "/x")
  applyRecord(endTurn, { type: "assistant", timestamp: "2026-07-01T00:00:09.000Z", message: { stop_reason: "end_turn", content: [] } })
  assert.equal(computeTurn(endTurn, now), "idle")

  const toolUse = newTailState("t", "s", "/x")
  applyRecord(toolUse, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "tool_use", content: [] } })
  // even though >5s stale, a clear tool_use is NEVER timed out to idle
  assert.equal(computeTurn(toolUse, now), "in-flight")

  const user = newTailState("t", "s", "/x")
  applyRecord(user, { type: "user", timestamp: "2026-07-01T00:00:09.500Z", message: { content: [] } })
  assert.equal(computeTurn(user, now), "in-flight")

  const empty = newTailState("t", "s", "/x")
  assert.equal(computeTurn(empty, now), "in-flight") // nothing substantive yet
})

test("computeTurn: unknown stop_reason uses the 5s silence backstop", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { content: [] } })
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:03.000Z")), "in-flight") // 3s: still in flight
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:06.000Z")), "idle") // 6s: backstop fires
})

// ---- applyEvent: the backend-NEUTRAL fold over NormalizedEvents (the codex-facing seam) ----
// applyEvent is what a codex backend drives its foldLine off (`for (ev of parseLine(line)) applyEvent`),
// so these tests pin the same FoldState fields the tailer/board consume — with turn driven by explicit
// turn-start/turn-end brackets, NOT Claude's stop_reason vocab. `pendingQuestion` is derived exactly as
// get() derives it: an idle turn whose final message still carries an unanswered ```question fence.
const pendingQuestion = (s: { turn: string; lastAssistantHasQuestion: boolean }) => s.turn === "idle" && s.lastAssistantHasQuestion

test("applyEvent: a full codex-style turn folds to idle with the final preview + parsed done fence", () => {
  const s = newTailState("t", "s", "/x")
  const seq: NormalizedEvent[] = [
    { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" },
    { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "I'll read hello.txt to check.", final: false }, // commentary
    { kind: "tool-call", at: "2026-07-01T00:00:02.000Z", id: "call_1", name: "exec_command", input: { cmd: "cat hello.txt" } },
    { kind: "tool-result", at: "2026-07-01T00:00:03.000Z", id: "call_1", text: "hello world" },
    { kind: "assistant-text", at: "2026-07-01T00:00:04.000Z", text: "All set — shipped it.\n\n```done\nread the file\n```", final: true },
    { kind: "turn-end", at: "2026-07-01T00:00:05.000Z" },
  ]
  for (const ev of seq) applyEvent(s, ev)
  assert.equal(s.turn, "idle") // bracketed closed by turn-end, no stop_reason heuristic
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:05.000Z") // latest event's timestamp
  assert.equal(s.lastAssistant, "All set — shipped it. ```done read the file ```") // final preview (whitespace-collapsed)
  assert.deepEqual(s.lastFence, { kind: "done", body: "read the file", hints: [] }) // parsed off the FINAL message
  assert.equal(s.lastAssistantHasQuestion, false)
  assert.equal(pendingQuestion(s), false)
  assert.equal(s.lastUserAt, undefined) // no human turn in this sequence
})

test("applyEvent: commentary refreshes the preview but NEVER carries a fence; only the final answer does", () => {
  const s = newTailState("t", "s", "/x")
  // A commentary block that literally contains a done-shaped fence must NOT excuse the thread.
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "working on it\n\n```done\nnot really\n```", final: false })
  assert.equal(s.lastAssistant, "working on it ```done not really ```") // preview updated
  assert.equal(s.lastFence, undefined) // commentary carries NO fence
  assert.equal(s.lastAssistantHasQuestion, false)
})

test("applyEvent: turn-end.finalText derives the fence when the backend brackets the final message on task_complete", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  // No assistant-text{final} — the final message rides task_complete.last_agent_message instead.
  applyEvent(s, { kind: "turn-end", at: "2026-07-01T00:00:02.000Z", finalText: "Need your call.\n\n```awaiting\npr: owner/repo#7\nshould I merge?\n```" })
  assert.equal(s.turn, "idle")
  assert.deepEqual(s.lastFence, { kind: "awaiting", body: "should I merge?", hints: [{ kind: "pr", value: "owner/repo#7" }] })
  assert.equal(s.lastAssistant, "Need your call. ```awaiting pr: owner/repo#7 should I merge? ```")
})

test("applyEvent: an idle turn ending on a ```question fence surfaces pendingQuestion", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "```question\nWhich option do you want?\n```", final: true })
  assert.equal(pendingQuestion(s), false) // still in-flight — not yet at rest
  applyEvent(s, { kind: "turn-end", at: "2026-07-01T00:00:02.000Z" })
  assert.equal(s.turn, "idle")
  assert.equal(s.lastAssistantHasQuestion, true)
  assert.equal(pendingQuestion(s), true) // idle + unanswered question → pending
})

test("applyEvent: only a GENUINE user-message bumps lastUserAt; a synthetic one never does", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:00.000Z", text: "go do the thing", synthetic: false })
  assert.equal(s.turn, "in-flight") // a user turn re-opens → the model is about to respond
  assert.equal(s.lastUserAt, "2026-07-01T00:00:00.000Z")
  // A synthetic user-message (peer msg / notification) re-invokes the model (in-flight) but is machine
  // motion the human didn't cause — it must NOT jump the row, so lastUserAt is left untouched.
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:05.000Z", synthetic: true })
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, "2026-07-01T00:00:00.000Z") // NOT bumped to 00:05
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:05.000Z") // but activity clock did advance
})

test("applyEvent: a later user-message clears a prior excusal fence + pending question", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "Done.\n\n```done\nshipped\n```", final: true })
  applyEvent(s, { kind: "turn-end", at: "2026-07-01T00:00:02.000Z" })
  assert.deepEqual(s.lastFence, { kind: "done", body: "shipped", hints: [] })
  // A fresh human turn supersedes the fence (it only signals while it is the final message).
  applyEvent(s, { kind: "user-message", at: "2026-07-01T00:00:03.000Z", text: "one more thing", synthetic: false })
  assert.equal(s.lastFence, undefined)
  assert.equal(s.lastAssistantHasQuestion, false)
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, "2026-07-01T00:00:03.000Z")
})

test("applyEvent: a title event sets aiTitle and never disturbs turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyEvent(s, { kind: "turn-start", at: "2026-07-01T00:00:00.000Z" })
  applyEvent(s, { kind: "title", title: "Codex thread title" })
  assert.equal(s.aiTitle, "Codex thread title")
  assert.equal(s.turn, "in-flight") // title is a sidecar — turn untouched
  assert.equal(s.lastActivityAt, "2026-07-01T00:00:00.000Z") // a title has no `at`, so the clock is unmoved
})

// ai-title is a sidecar record carrying Claude's own session name; the LATEST non-empty wins and it
// never disturbs turn state.
test("applyRecord: ai-title captures latest non-empty title without moving turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })
  applyRecord(s, { type: "ai-title", aiTitle: "First guess at a name" })
  applyRecord(s, { type: "ai-title", aiTitle: "Refined session title" }) // latest wins
  applyRecord(s, { type: "ai-title", aiTitle: "  " }) // blank ignored — keeps the last good one
  applyRecord(s, { type: "ai-title" }) // missing field ignored
  assert.equal(s.aiTitle, "Refined session title")
  assert.equal(s.lastKind, "assistant") // turn state untouched
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:01.000Z")), "idle")
})

test("applyRecord: sidecar metadata records never move turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })
  applyRecord(s, { type: "ai-title" })
  applyRecord(s, { type: "last-prompt" })
  applyRecord(s, { type: "attachment", timestamp: "2026-07-01T00:00:05.000Z" })
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastStopReason, "end_turn")
  assert.equal(computeTurn(s, Date.parse("2026-07-01T00:00:01.000Z")), "idle")
})

// ---- live background sub-agent tracking (Agent dispatches + task-notifications) ----

// A background Agent dispatch (verified shape: tool_use name:"Agent", input.description +
// run_in_background). Registers a live sub-agent keyed by the tool_use id. (Return type left to
// inference so it stays structurally compatible with applyRecord's internal Record interface.)
// `subagentType: null` omits the field entirely (undefined would trip the default-param rule).
function dispatch(id: string, description: string, background = true, subagentType: string | null = "fray:fray-opus-high") {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id, input: { description, run_in_background: background, ...(subagentType != null ? { subagent_type: subagentType } : {}) } }] },
  }
}
// The launch tool_result (a user record) carries the child's output_file path.
function launch(id: string, outputFile: string) {
  return {
    type: "user",
    timestamp: "2026-07-01T00:00:01.500Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: abc123\noutput_file: ${outputFile}\nDo not read this file.` }] }] },
  }
}
// A completion <task-notification> rides a queue-operation record's top-level `content` string.
function taskNotification(id: string, status: string) {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-01T00:00:09.000Z",
    content: `<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`,
  }
}
// A BACKGROUND Bash launch (run_in_background:true) — a persist-across-rest shell.
function bashBg(id: string, description: string | null, command: string) {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id, input: { command, run_in_background: true, ...(description != null ? { description } : {}) } }] },
  }
}
// A native AskUserQuestion tool_use (the safety-net trigger).
function askUse(id: string, questions: unknown) {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "AskUserQuestion", id, input: { questions } }] },
  }
}
// A bare tool_result user record (answers/clears a pending ask).
function toolResult(id: string) {
  return { type: "user", timestamp: "2026-07-01T00:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "answered" }] }] } }
}

test("applyRecord: a BACKGROUND Bash registers a SHELL op; a FOREGROUND Bash does not", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch origin/main CI", "gh run watch"))
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_fg", input: { command: "ls" } }] } })
  assert.equal(s.subAgents.size, 1)
  const e = s.subAgents.get("toolu_sh")
  assert.equal(e?.kind, "shell")
  assert.equal(e?.label, "Watch origin/main CI")
})

test("applyRecord: a background shell without a description labels from the command's first line", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", null, "gh run watch 123\necho more"))
  assert.equal(s.subAgents.get("toolu_sh")?.label, "gh run watch 123")
})

test("applyRecord: a shell CLEARS on terminal notification and does NOT retain (display-only)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, taskNotification("toolu_sh", "completed"))
  assert.equal(s.subAgents.size, 0)
  assert.equal(s.retiredSubAgents.size, 0, "shells don't retain — nothing to drill into")
})

// A tool_result user record with arbitrary text for a given tool_use id (ack/report shapes below).
function resultText(id: string, text: string) {
  return { type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } }
}

test("applyRecord: a shell's REAL launch ack ('Command running in background…') keeps it tracked + resolves its output path", () => {
  // Regression: the corpus shell ack carries NO `output_file:` token — an earlier discriminator
  // retired the shell on its own ack, killing the bgShells feature one tick after launch.
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "Command running in background with ID: b8p363n40. Output is being written to: /tmp/tasks/b8p363n40.output. You will be notified when it completes."))
  assert.equal(s.subAgents.size, 1, "the launch ack must never retire a background shell")
  assert.equal(s.subAgents.get("toolu_sh")?.outputFile, "/tmp/tasks/b8p363n40.output", "sentence period stripped from the captured path")
})

test("applyRecord: a shell tool_result NEVER retires it, even non-ack-shaped (notification is the only terminal)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, bashBg("toolu_sh", "Watch CI", "gh run watch"))
  applyRecord(s, resultText("toolu_sh", "some unexpected result text"))
  assert.equal(s.subAgents.size, 1)
})

test("applyRecord: the mailbox agent ack ('Spawned successfully…', no path) keeps tracking + derives the subagents path from agentId", () => {
  const s = newTailState("t", "sid-1", "/logs/sid-1.jsonl")
  applyRecord(s, dispatch("toolu_bg", "researcher"))
  applyRecord(s, resultText("toolu_bg", "Spawned successfully. (This tool result is internal metadata — never quote it.)\nagentId: aXYZ-123\nThe agent is now running and will receive instructions via mailbox."))
  assert.equal(s.subAgents.size, 1, "a mailbox launch ack must never retire a live background agent")
  assert.equal(s.subAgents.get("toolu_bg")?.outputFile, "/logs/sid-1/subagents/agent-aXYZ-123.jsonl")
})

test("applyRecord: the path-less 'Async agent launched' ack keeps tracking (no retire, path from agentId)", () => {
  const s = newTailState("t", "sid-1", "/logs/sid-1.jsonl")
  applyRecord(s, dispatch("toolu_bg", "researcher"))
  applyRecord(s, resultText("toolu_bg", "Async agent launched successfully.\nagentId: abc9\nDo not mention this."))
  assert.equal(s.subAgents.size, 1)
  assert.equal(s.subAgents.get("toolu_bg")?.outputFile, "/logs/sid-1/subagents/agent-abc9.jsonl")
})

test("applyRecord: a FOREGROUND agent's tool_result (its final report — not an ack) retires it into the ring", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_fg2", "quick check"))
  applyRecord(s, resultText("toolu_fg2", "Here are my findings: the flag is unused.\n\n1. …"))
  assert.equal(s.subAgents.size, 0, "a synchronous completion must retire the tracked entry")
  assert.equal(s.retiredSubAgents.get("toolu_fg2")?.status, "completed")
})

test("applyRecord: an AskUserQuestion sets pendingAsk (structured); its tool_result clears it", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, askUse("toolu_ask", [{ question: "Which package manager?", header: "PM", multiSelect: false, options: [{ label: "pnpm", description: "fast" }, { label: "npm" }] }]))
  assert.ok(s.pendingAsk)
  assert.equal(s.pendingAsk?.id, "toolu_ask")
  assert.equal(s.pendingAsk?.questions[0].question, "Which package manager?")
  assert.equal(s.pendingAsk?.questions[0].header, "PM")
  assert.equal(s.pendingAsk?.questions[0].options.length, 2)
  assert.equal(s.pendingAsk?.questions[0].options[0].description, "fast")
  applyRecord(s, toolResult("toolu_ask")) // the human answered in the terminal
  assert.equal(s.pendingAsk, undefined)
})

test("applyRecord: a malformed AskUserQuestion input is ignored (no pendingAsk, no throw)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, askUse("toolu_ask", "not-an-array"))
  assert.equal(s.pendingAsk, undefined)
})

test("applyRecord: a BACKGROUND Agent dispatch registers a live sub-agent; foreground is ignored", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "Investigate issue 376"))
  applyRecord(s, dispatch("toolu_fg", "Blocking child", false)) // run_in_background:false → skipped
  assert.equal(s.subAgents.size, 1)
  const e = s.subAgents.get("toolu_bg")
  assert.equal(e?.label, "Investigate issue 376")
  assert.equal(e?.startedAt, "2026-07-01T00:00:01.000Z")
  assert.equal(e?.subagentType, "fray:fray-opus-high") // captured verbatim from input.subagent_type
  assert.equal(e?.outputFile, undefined) // not yet enriched
})

test("applyRecord: a dispatch WITHOUT subagent_type registers with an undefined type (no tag)", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child", true, null)) // null → omit subagent_type entirely
  assert.equal(s.subAgents.size, 1)
  assert.equal(s.subAgents.get("toolu_bg")?.subagentType, undefined)
})

test("applyRecord: the launch tool_result enriches the sub-agent with its output_file", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child"))
  applyRecord(s, launch("toolu_bg", "/tmp/tasks/abc123.output"))
  assert.equal(s.subAgents.get("toolu_bg")?.outputFile, "/tmp/tasks/abc123.output")
  // a launch result for an UNTRACKED id is ignored (no phantom entry)
  applyRecord(s, launch("toolu_unknown", "/tmp/tasks/zzz.output"))
  assert.equal(s.subAgents.size, 1)
})

test("applyRecord: a TERMINAL task-notification removes the sub-agent; a running ping does not", () => {
  for (const status of ["completed", "failed", "killed"]) {
    const s = newTailState("t", "s", "/x")
    applyRecord(s, dispatch("toolu_bg", "child"))
    applyRecord(s, taskNotification("toolu_bg", "running")) // non-terminal — kept
    assert.equal(s.subAgents.size, 1, `running ping keeps the entry (status under test: ${status})`)
    applyRecord(s, taskNotification("toolu_bg", status)) // terminal — removed
    assert.equal(s.subAgents.size, 0, `${status} clears the entry`)
    // a repeat terminal notify is idempotent (a resumed task-id may notify twice)
    applyRecord(s, taskNotification("toolu_bg", status))
    assert.equal(s.subAgents.size, 0)
  }
})

test("applyRecord: a terminal task-notification RETAINS the sub-agent for drawer review", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child"))
  applyRecord(s, launch("toolu_bg", "/tmp/tasks/abc123.output"))
  applyRecord(s, taskNotification("toolu_bg", "completed"))
  assert.equal(s.subAgents.size, 0, "removed from the LIVE set (banner/counts stay live-only)")
  const dead = s.retiredSubAgents.get("toolu_bg")
  assert.equal(dead?.status, "completed")
  assert.equal(dead?.label, "child")
  assert.equal(dead?.outputFile, "/tmp/tasks/abc123.output", "retains the output path so the drawer resolves")
})

test("applyRecord: sub-agent tracking never disturbs turn state", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, dispatch("toolu_bg", "child")) // an assistant tool_use record
  assert.equal(s.lastKind, "assistant")
  assert.equal(s.lastStopReason, "tool_use")
  applyRecord(s, taskNotification("toolu_bg", "completed")) // a queue-operation record
  assert.equal(s.lastKind, "assistant", "a queue-operation record is sidecar — turn state untouched")
})

test("tailer: surfaces running vs stale sub-agents (via injected mtime) and clears on completion", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const dispatchLine = JSON.stringify(dispatch("toolu_bg", "child"))
  const launchLine = JSON.stringify(launch("toolu_bg", "/tmp/tasks/abc123.output"))
  fixture(h.logDir, "sid", [IN_FLIGHT, dispatchLine, launchLine])
  // child transcript last written at t=00:00:02; the tailer's clock advances below.
  const childMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    capturePane: () => h.pane.text,
    sessionLogDir: h.logDir,
    mtimeMs: () => childMtime,
  })

  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z") // <5min since child mtime → running
  t.tick() // prime
  assert.deepEqual(t.get("t")?.subAgents, [{ label: "child", startedAt: "2026-07-01T00:00:01.000Z", state: "running", subagentType: "fray:fray-opus-high", id: "toolu_bg" }])

  h.clock.ms = Date.parse("2026-07-01T00:10:00.000Z") // >5min since child mtime → stale
  const before = h.changes.n
  t.tick()
  assert.equal(t.get("t")?.subAgents[0].state, "stale")
  assert.ok(h.changes.n > before, "a running→stale transition marks the board dirty")

  // completion notification clears the sub-agent
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(taskNotification("toolu_bg", "completed")) + "\n")
  const before2 = h.changes.n
  t.tick()
  assert.deepEqual(t.get("t")?.subAgents, [])
  assert.ok(h.changes.n > before2, "clearing a sub-agent marks the board dirty")
})

test("tailer: subAgent() resolves a LIVE child, then its RETAINED completion, then undefined for unknown", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, JSON.stringify(dispatch("toolu_bg", "child")), JSON.stringify(launch("toolu_bg", "/tmp/tasks/abc123.output"))])
  const childMtime = Date.parse("2026-07-01T00:00:02.000Z")
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    capturePane: () => h.pane.text,
    sessionLogDir: h.logDir,
    mtimeMs: () => childMtime,
  })
  h.clock.ms = Date.parse("2026-07-01T00:01:00.000Z") // < 5min since child mtime → running
  t.tick()
  assert.deepEqual(t.subAgent("t", "toolu_bg"), { outputFile: "/tmp/tasks/abc123.output", state: "running" })
  assert.equal(t.subAgent("t", "toolu_unknown"), undefined, "an id we never dispatched → undefined (router maps to gone)")

  // completion retains the child as "done" — still resolvable for review after it leaves the live set
  appendFileSync(join(h.logDir, "sid.jsonl"), JSON.stringify(taskNotification("toolu_bg", "completed")) + "\n")
  t.tick()
  assert.deepEqual(t.get("t")?.subAgents, [], "gone from the LIVE surface")
  assert.deepEqual(t.subAgent("t", "toolu_bg"), { outputFile: "/tmp/tasks/abc123.output", state: "done" })
})

test("tailer: a resolved-but-missing output file (deleted child transcript) degrades to stale", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, JSON.stringify(dispatch("toolu_bg", "child")), JSON.stringify(launch("toolu_bg", "/tmp/tasks/gone.output"))])
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    capturePane: () => h.pane.text,
    sessionLogDir: h.logDir,
    mtimeMs: () => undefined, // the child's transcript no longer stats (deleted / bridged elsewhere)
  })
  t.tick()
  // outputFile was resolved from the launch result, so an un-stattable path is a missed completion → stale
  assert.equal(t.get("t")?.subAgents[0].state, "stale")
})

// ---- derived pending-question detection (chat-only ```question the worker didn't encode as blocked) ----

test("hasQuestionBlock: detects a fenced ```question block; rejects prose and a plain code fence", () => {
  assert.equal(hasQuestionBlock("intro\n\n```question\nWhich one?\n\n- A. x\n- B. y\n```"), true)
  assert.equal(hasQuestionBlock("```question approval\nShip it?\n```"), true) // kind info-string
  // Multi-token info-strings the prompt teaches (```question approval danger, ```question multi) —
  // the old single-token grammar silently missed them and broke the pendingQuestion safety net.
  assert.equal(hasQuestionBlock("```question approval danger\nForce-merge?\n\n- A. Do it\n```"), true)
  assert.equal(hasQuestionBlock("```question multi\nWhich?\n\n- A. x\n- B. y\n```"), true)
  assert.equal(hasQuestionBlock("just prose, no fence at all"), false)
  assert.equal(hasQuestionBlock("```js\nconst q = 'question'\n```"), false) // a plain code fence is not a question
  assert.equal(hasQuestionBlock(undefined), false)
})

test("applyRecord: a ```question block sets lastAssistantHasQuestion; a real user reply clears it", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "context\n\n```question\nWhich default?\n\n- A. Foo\n- B. Bar\n```" }] } })
  assert.equal(s.lastAssistantHasQuestion, true)
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:20.000Z", message: { content: "Answers:\n1. A" } })
  assert.equal(s.lastAssistantHasQuestion, false, "a user reply supersedes the pending question")
})

test("tailer: derives pendingQuestion at rest, then clears it on the user's answer", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const QUESTION = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ctx\n\n```question\nWhich default?\n\n- A. Foo\n- B. Bar\n```" }] } })
  fixture(h.logDir, "sid", [IN_FLIGHT, QUESTION])
  const t = makeTailer(h)
  h.clock.ms = Date.parse("2026-07-01T00:00:10.000Z")
  t.tick() // prime: idle with an unanswered chat question
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.pendingQuestion, true)

  const ANSWER = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:20.000Z", message: { role: "user", content: "Answers:\n1. A" } })
  appendFileSync(join(h.logDir, "sid.jsonl"), ANSWER + "\n")
  t.tick()
  assert.equal(t.get("t")?.pendingQuestion, false, "the answer flips the turn in-flight and clears the flag")
})

// ---- chronological listing key: newest REAL user interaction (tool_results excluded) ----

test("isRealUserMessage: a typed prompt / text message counts; a tool_result-only record does not", () => {
  assert.equal(isRealUserMessage("go do the thing"), true) // a typed prompt (string content)
  assert.equal(isRealUserMessage([{ type: "text", text: "hi" }]), true) // a text message
  assert.equal(isRealUserMessage([{ type: "text", text: "note" }, { type: "tool_result", tool_use_id: "x" }]), true) // mixed → real
  assert.equal(isRealUserMessage([{ type: "tool_result", tool_use_id: "x", content: "ok" }]), false) // tool exchange only → not
  assert.equal(isRealUserMessage([]), false)
  assert.equal(isRealUserMessage(undefined), false)
})

test("tailer: lastUserAt tracks the newest REAL user message; a tool_result does not advance it", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // dispatch prompt "go" @ 00:00:00, then a tool_use turn
  const t = makeTailer(h)
  t.tick() // prime
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:00.000Z", "the dispatch prompt is the first interaction")

  // a tool_result is a USER-role record but AGENT activity — must not bump the interaction key
  const TOOLRESULT = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } })
  appendFileSync(join(h.logDir, "sid.jsonl"), TOOLRESULT + "\n")
  t.tick()
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:00.000Z", "a tool_result does not advance lastUserAt")

  // a real steer/answer does
  const STEER = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:30.000Z", message: { role: "user", content: "actually, do X instead" } })
  appendFileSync(join(h.logDir, "sid.jsonl"), STEER + "\n")
  t.tick()
  assert.equal(t.get("t")?.lastUserAt, "2026-07-01T00:00:30.000Z", "a real user steer bumps the interaction key")
})

// ---- permission-prompt pane matcher (empirical fixtures, claude 2.1.198) ----

// Real capture of a pending Bash-tool approval (--permission-mode default).
const PANE_PERM_BASH = [
  " Bash command",
  "   touch approved-me.txt",
  "   Create empty file approved-me.txt",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to permtest/ from this project",
  "   3. No",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n")

// Real capture of a pending Edit-tool approval — different question wording, same modal shape.
const PANE_PERM_EDIT = [
  " Edit file",
  " file.txt",
  " 1 -hello",
  " 1 +goodbye",
  " Do you want to make this edit to file.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  " Esc to cancel · Tab to amend",
].join("\n")

// Negative: a normal streaming turn (spinner + "esc to interrupt"), no modal.
const PANE_STREAMING = [
  "❯ Use the Edit tool to change the word hello to goodbye in file.txt",
  "  Reading 1 file…",
  "  ⎿  file.txt",
  "✳ Canoodling… (11s · ↑ 95 tokens)",
  "  esc to interrupt",
].join("\n")

// Negative: idle at the prompt.
const PANE_IDLE = ["⏺ Clean working tree on main, nothing to commit.", "❯ ", "  permtest · main · Fable 5 · 3%"].join("\n")

// Negative: the model printing its OWN numbered list (incl. "1. Yes") in prose — the two-signal
// guard (numbered Yes AND question/footer) must NOT fire on this.
const PANE_MODEL_LIST = [
  "⏺ Here are the options I'm weighing:",
  "  1. Yes, refactor the parser now",
  "  2. No, leave it for later",
  "  Which would you prefer?",
].join("\n")

test("matchesPermPrompt: fires on real Bash + Edit approval panes", () => {
  assert.equal(matchesPermPrompt(PANE_PERM_BASH), true)
  assert.equal(matchesPermPrompt(PANE_PERM_EDIT), true)
})

test("matchesPermPrompt: rejects streaming / idle / a model's own numbered list / empty", () => {
  assert.equal(matchesPermPrompt(PANE_STREAMING), false)
  assert.equal(matchesPermPrompt(PANE_IDLE), false)
  assert.equal(matchesPermPrompt(PANE_MODEL_LIST), false) // has "1. Yes" but no question/footer
  assert.equal(matchesPermPrompt(""), false)
})

// ---- integration: tick loop over a fixture transcript ----

// A couple of real-shaped lines (copied from the corpus schema) plus sidecar noise.
const IN_FLIGHT = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { role: "user", content: "go" } })
const TOOL = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } })
const DONE = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "all done" }] } })
const TITLE = JSON.stringify({ type: "ai-title", aiTitle: "x" })

function fixture(dir: string, sessionId: string, lines: string[]) {
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => l + "\n").join(""))
}

interface Harness {
  storage: Storage
  bus: Bus
  events: ServerEvent[]
  logDir: string
  changes: { n: number }
  clock: { ms: number }
  dead: { v: boolean }
  pane: { text: string }
}

function harness(): Harness {
  const dir = tmp("fray-tail-")
  const storage = createStorage(join(dir, "ui.db"))
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.subscribe((e) => events.push(e))
  return { storage, bus, events, logDir: dir, changes: { n: 0 }, clock: { ms: 1000 }, dead: { v: false }, pane: { text: "" } }
}

function makeTailer(h: Harness) {
  return createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    capturePane: () => h.pane.text,
    sessionLogDir: h.logDir,
  })
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return { slug: "t", session_id: "sid", tmux_name: "fray-t", spawned_at: "2026-07-01T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, plan_path: null, ...over }
}

test("tailer: primes an already-finished transcript WITHOUT a turn-done notify", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE, TITLE])
  const t = makeTailer(h)

  t.tick() // prime
  assert.equal(h.events.length, 0, "boot prime must not notify")
  assert.equal(h.storage.getSession("t")?.unread, 0)
  const tele = t.get("t")
  assert.equal(tele?.turn, "idle")
  assert.equal(tele?.lastAssistant, "all done")
  assert.equal(tele?.lastActivityAt, "2026-07-01T00:00:02.000Z")
  assert.equal(tele?.aiTitle, "x") // ai-title sidecar surfaces through telemetry
})

test("tailer: in-flight → idle fires exactly one turn-done + sets unread", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // mid-turn
  const t = makeTailer(h)

  t.tick() // prime: in-flight
  assert.equal(t.get("t")?.turn, "in-flight")
  assert.equal(h.events.length, 0)

  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n")
  t.tick() // turn completes
  const notifies = h.events.filter((e) => e.type === "notify")
  assert.equal(notifies.length, 1)
  assert.equal(notifies[0].type === "notify" && notifies[0].kind, "turn-done")
  assert.equal(notifies[0].type === "notify" && notifies[0].body, "all done")
  assert.equal(h.storage.getSession("t")?.unread, 1)

  t.tick() // no new bytes → no duplicate notify (dedupe by transition)
  assert.equal(h.events.filter((e) => e.type === "notify").length, 1)
})

test("tailer: unread is gated on last_read_at (a read-past turn does not re-badge)", () => {
  const h = harness()
  // user already read at a time AFTER the (only) turn-end record's timestamp
  h.storage.upsertSession(row({ last_read_at: "2026-07-01T00:00:05.000Z" }))
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL])
  const t = makeTailer(h)
  t.tick() // prime in-flight

  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n") // end_turn ts = 00:00:02, before last_read
  t.tick()
  // notify still fires (it's a real transition) but unread stays cleared
  assert.equal(h.events.filter((e) => e.type === "notify").length, 1)
  assert.equal(h.storage.getSession("t")?.unread, 0)
})

test("tailer: pane death fires one exited notify + stamps exited (and not at boot)", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE])
  h.dead.v = true // already dead at boot
  const t = makeTailer(h)

  t.tick() // prime: adopts dead state silently
  assert.equal(h.events.length, 0, "a session already dead at boot must not notify")

  // now simulate a live→dead transition observed by the tailer
  h.dead.v = false
  const t2 = makeTailer(h) // fresh tailer, session now live
  h.storage.markRead("t") // clear any prior unread
  t2.tick() // prime live
  h.dead.v = true
  t2.tick() // observe death
  const exited = h.events.filter((e) => e.type === "notify" && e.kind === "exited")
  assert.equal(exited.length, 1)
  assert.equal(h.storage.getSession("t")?.exited, 1)

  t2.tick() // still dead → no duplicate
  assert.equal(h.events.filter((e) => e.type === "notify" && e.kind === "exited").length, 1)
})

test("tailer: incremental read handles a trailing partial line across ticks", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const path = join(h.logDir, "sid.jsonl")
  writeFileSync(path, IN_FLIGHT + "\n")
  const t = makeTailer(h)
  t.tick() // prime: in-flight

  // write a record WITHOUT its terminating newline — must be buffered, not mis-parsed
  appendFileSync(path, DONE)
  t.tick()
  assert.equal(t.get("t")?.turn, "in-flight", "a partial (unterminated) line is not yet a record")

  appendFileSync(path, "\n") // complete the line
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
})

test("tailer: sniffs perm-prompt only when an in-flight turn goes quiet; clears on resume", () => {
  const h = harness()
  h.storage.upsertSession(row())
  fixture(h.logDir, "sid", [IN_FLIGHT, TOOL]) // in-flight; last activity ts = 00:00:01
  h.pane.text = PANE_PERM_BASH
  const t = makeTailer(h)

  // clock only 2s past the tool_use record: below PERM_SNIFF_MS, so no sniff yet
  h.clock.ms = Date.parse("2026-07-01T00:00:03.000Z")
  t.tick() // prime
  assert.equal(t.get("t")?.permPrompt, false, "not quiet long enough to sniff")
  assert.equal(h.events.length, 0, "perm-prompt never notifies")
  assert.equal(h.storage.getSession("t")?.unread, 0, "perm-prompt never sets unread")

  // now 9s of silence on a still-in-flight turn + a matching pane → perm-prompt
  h.clock.ms = Date.parse("2026-07-01T00:00:10.000Z")
  t.tick()
  assert.equal(t.get("t")?.permPrompt, true)
  assert.equal(h.events.length, 0, "still no notify/unread for perm-prompt")
  assert.equal(h.storage.getSession("t")?.unread, 0)

  // the human answers → the pane stops matching → cleared even before jsonl moves
  h.pane.text = PANE_STREAMING
  t.tick()
  assert.equal(t.get("t")?.permPrompt, false)

  // and once the turn completes, an idle turn is never sniffed regardless of pane text
  h.pane.text = PANE_PERM_BASH
  appendFileSync(join(h.logDir, "sid.jsonl"), DONE + "\n")
  t.tick()
  assert.equal(t.get("t")?.turn, "idle")
  assert.equal(t.get("t")?.permPrompt, false)
})

// ---- signal-fence grammar (done/awaiting excusal fences) ----

test("parseSignalFence: a done fence captures the trimmed body, no hints", () => {
  assert.deepEqual(parseSignalFence("intro line\n\n```done\nShipped and merged.\n```"), { kind: "done", body: "Shipped and merged.", hints: [] })
})

test("parseSignalFence: END-ANCHORED — a fence with prose after it is quoted/explanatory, never an excusal", () => {
  // A worker EXPLAINING the protocol must not silently drop out of the Needs-you queue.
  assert.equal(parseSignalFence("```done\nexample fence\n```\n\nSo: should I use this format going forward?"), undefined)
  // Trailing whitespace after the closing fence is fine.
  assert.deepEqual(parseSignalFence("all done\n\n```done\nShipped.\n```\n  \n"), { kind: "done", body: "Shipped.", hints: [] })
})

test("parseSignalFence: an awaiting fence parses pr/ci/timer/session hints + a prose body", () => {
  const f = parseSignalFence("```awaiting\npr: 391\nci: build #42\ntimer: 2026-07-02T00:00:00Z\nsession: abc-123\nWaiting on green CI before merge.\n```")
  assert.equal(f?.kind, "awaiting")
  assert.equal(f?.body, "Waiting on green CI before merge.")
  assert.deepEqual(f?.hints, [
    { kind: "pr", value: "391" },
    { kind: "ci", value: "build #42" },
    { kind: "timer", value: "2026-07-02T00:00:00Z" },
    { kind: "session", value: "abc-123" },
  ])
})

test("parseSignalFence: hint kind is case-insensitive, lowercased on output; hints-only body is empty", () => {
  const f = parseSignalFence("```awaiting\nPR: 391\nCi: green\n```")
  assert.deepEqual(f?.hints, [{ kind: "pr", value: "391" }, { kind: "ci", value: "green" }])
  assert.equal(f?.body, "")
})

test("parseSignalFence: the LAST signal fence in a text wins", () => {
  const f = parseSignalFence("```awaiting\npr: 1\n```\n\nnever mind\n\n```done\nactually finished\n```")
  assert.deepEqual(f, { kind: "done", body: "actually finished", hints: [] })
})

test("parseSignalFence: an unclosed / mis-worded / trailing-junk fence is ignored", () => {
  assert.equal(parseSignalFence("```done\nno closing fence here"), undefined) // unclosed
  assert.equal(parseSignalFence("```shipped\nwrong language word\n```"), undefined) // not done/awaiting
  assert.equal(parseSignalFence("```done extra stuff\nbody\n```"), undefined) // junk after the language word
  assert.equal(parseSignalFence(undefined), undefined)
})

test("parseSignalFence: a ```question fence is NOT a signal fence", () => {
  assert.equal(parseSignalFence("```question\nWhich one?\n\n- A. x\n- B. y\n```"), undefined)
})

test("parseSignalFence: tolerates CRLF line endings", () => {
  assert.deepEqual(parseSignalFence("```done\r\nWindows body\r\n```"), { kind: "done", body: "Windows body", hints: [] })
})

test("parseSignalFence: the body is capped at 500 chars with a trailing ellipsis", () => {
  const f = parseSignalFence("```done\n" + "x".repeat(900) + "\n```")
  assert.equal(f?.body.length, 501) // 500 + the ellipsis char
  assert.ok(f?.body.endsWith("…"))
})

// ---- signal-fence lifecycle (set by final assistant text, cleared by newer activity) ----

test("applyRecord: a signal fence is set by the final assistant text and cleared by a later user record", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "shipped it\n\n```done\nMerged PR 391\n```" }] } })
  assert.deepEqual(s.lastFence, { kind: "done", body: "Merged PR 391", hints: [] })
  applyRecord(s, { type: "user", timestamp: "2026-07-01T00:00:20.000Z", message: { content: "thanks, next task" } })
  assert.equal(s.lastFence, undefined, "a newer user record clears the excusal fence")
})

test("applyRecord: a later assistant text without a fence clears it; with a fence replaces it", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```awaiting\npr: 391\nwatching CI\n```" }] } })
  assert.equal(s.lastFence?.kind, "awaiting")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "actually still working on it" }] } })
  const cleared = s.lastFence // snapshot: assert on a local so the strict-equal narrowing doesn't poison s.lastFence below
  assert.equal(cleared, undefined, "a fence-less assistant text clears it — the fence only signals as the final message")
  applyRecord(s, { type: "assistant", timestamp: "2026-07-01T00:00:09.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```done\nall set\n```" }] } })
  assert.equal(s.lastFence?.kind, "done", "a fresh fence replaces the cleared one")
})

test("applyRecord: an assistant record with no text block leaves the fence intact", () => {
  const s = newTailState("t", "s", "/x")
  applyRecord(s, { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```done\nfinished\n```" }] } })
  assert.equal(s.lastFence?.kind, "done")
  applyRecord(s, { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } })
  assert.equal(s.lastFence?.kind, "done", "a text-less assistant record does not recompute the fence (mirrors the question flag)")
})

test("tailer: surfaces a signal fence through get()", () => {
  const h = harness()
  h.storage.upsertSession(row())
  const FENCED = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:02.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "```awaiting\npr: 391\nWaiting on CI.\n```" }] } })
  fixture(h.logDir, "sid", [IN_FLIGHT, FENCED])
  const t = makeTailer(h)
  t.tick()
  assert.deepEqual(t.get("t")?.lastFence, { kind: "awaiting", body: "Waiting on CI.", hints: [{ kind: "pr", value: "391" }] })
})

// ---- whole-directory FOREIGN session discovery (maintainer terminals: read-only threads) ----

// A tailer whose paneDead/capturePane are SPIES — records every slug they're asked about, so a test
// can prove a foreign thread never triggers a tmux shell-out.
function foreignTailer(h: Harness) {
  const paneCalls: string[] = []
  const deadCalls: string[] = []
  const t = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: (slug) => { deadCalls.push(slug); return h.dead.v },
    capturePane: (slug) => { paneCalls.push(slug); return h.pane.text },
    sessionLogDir: h.logDir,
  })
  return { t, paneCalls, deadCalls }
}

// Write a foreign transcript with a controlled mtime (drives the freshness window against now()).
function foreignFile(dir: string, id: string, lines: string[], mtimeMs: number) {
  const p = join(dir, `${id}.jsonl`)
  writeFileSync(p, lines.map((l) => l + "\n").join(""))
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
}

const FCLOCK = Date.parse("2026-07-01T12:00:00.000Z")
const FRESH_MTIME = FCLOCK - 60 * 60_000 // 1h before the injected clock → within the 24h window
const STALE_MTIME = FCLOCK - (FOREIGN_FRESH_MS + 60 * 60_000) // just past the window → aged out

test("tailer: a FRESH unregistered .jsonl surfaces as a foreign thread with derived telemetry", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "foreign-1", [IN_FLIGHT, TOOL, DONE], FRESH_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["foreign-1"])
  const tele = t.get("foreign-1")
  assert.equal(tele?.turn, "idle")
  assert.equal(tele?.lastAssistant, "all done")
  assert.equal(tele?.permPrompt, false)
})

test("tailer: a REGISTERED session_id's file is never foreign (registered rows win)", () => {
  const h = harness()
  h.storage.upsertSession(row()) // session_id "sid"
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "sid", [IN_FLIGHT, TOOL, DONE], FRESH_MTIME) // fresh, but registered
  foreignFile(h.logDir, "foreign-2", [IN_FLIGHT], FRESH_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["foreign-2"], "the registered session_id is excluded; only the unregistered file is foreign")
})

test("tailer: a STALE (>24h mtime) foreign file ages out of foreignIds()", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "fresh-one", [IN_FLIGHT], FRESH_MTIME)
  foreignFile(h.logDir, "stale-one", [IN_FLIGHT], STALE_MTIME)
  t.tick()
  assert.deepEqual(t.foreignIds(), ["fresh-one"], "only the fresh file is a live foreign thread")
})

test("tailer: foreign ids are ordered most-recent-mtime first", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  foreignFile(h.logDir, "older", [IN_FLIGHT], FCLOCK - 6 * 60 * 60_000) // 6h ago
  foreignFile(h.logDir, "newer", [IN_FLIGHT], FCLOCK - 1 * 60 * 60_000) // 1h ago
  t.tick()
  assert.deepEqual(t.foreignIds(), ["newer", "older"])
})

test("tailer: NEVER pane-sniffs or pane-death-checks a foreign thread (structural)", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  h.pane.text = PANE_PERM_BASH // would trip a perm-prompt IF a foreign thread were ever sniffed
  const { t, paneCalls, deadCalls } = foreignTailer(h)
  foreignFile(h.logDir, "foreign-q", [IN_FLIGHT, TOOL], FRESH_MTIME) // in-flight, then quiet
  t.tick() // prime
  h.clock.ms = FCLOCK + 60_000 // long past PERM_SNIFF_MS with no new bytes
  t.tick()
  assert.equal(t.get("foreign-q")?.turn, "in-flight")
  assert.equal(t.get("foreign-q")?.permPrompt, false, "a foreign thread's perm-prompt is structurally false")
  assert.ok(!paneCalls.includes("foreign-q"), "capturePane is never called for a foreign id")
  assert.ok(!deadCalls.includes("foreign-q"), "paneDead is never called for a foreign id")
})

test("tailer: a foreign turn derives in-flight vs idle and transitions WITHOUT notify or storage write", () => {
  const h = harness()
  h.clock.ms = FCLOCK
  const { t } = foreignTailer(h)
  const path = join(h.logDir, "f-turn.jsonl")
  writeFileSync(path, [IN_FLIGHT, TOOL].map((l) => l + "\n").join("")) // in-flight
  utimesSync(path, new Date(FRESH_MTIME), new Date(FRESH_MTIME))
  t.tick() // prime
  assert.equal(t.get("f-turn")?.turn, "in-flight")

  appendFileSync(path, DONE + "\n") // complete the turn (scan is cached this tick — still tailed)
  h.clock.ms = FCLOCK + 5000
  t.tick()
  assert.equal(t.get("f-turn")?.turn, "idle", "the foreign turn transitions like a registered one")
  assert.equal(h.events.length, 0, "a foreign turn-done NEVER notifies")
  assert.equal(h.storage.getSession("f-turn"), undefined, "no storage row is created for a foreign thread")
})

// ---- codex: a rollout folds THROUGH THE TICK to idle (the computeTurn regression) ----
// Codex brackets turns EXPLICITLY (task_started .. task_complete → applyEvent writes state.turn) and
// never sets lastKind. BEFORE the computeTurn patch, the tick's computeTurn — which reads only Claude's
// lastKind/lastStopReason (undefined for codex) — fell through to "in-flight", CLOBBERING the `idle`
// applyEvent set, so a wired codex row was stuck in-flight forever. These drive a REAL CodexBackend
// through the tick (not applyEvent directly — codex.test.ts covers that) so computeTurn actually runs.

// Codex rollout record builders (real 0.144.1 schema — see backend/codex.fixtures/*.jsonl).
const cxMeta = (codexId: string, cwd: string) => JSON.stringify({ timestamp: "2026-07-10T21:58:43.000Z", type: "session_meta", payload: { session_id: codexId, cwd } })
const cxTaskStarted = JSON.stringify({ timestamp: "2026-07-10T21:58:43.255Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } })
const cxAgentFinal = (text: string) => JSON.stringify({ timestamp: "2026-07-10T21:58:50.000Z", type: "event_msg", payload: { type: "agent_message", message: text, phase: "final_answer" } })
const cxTaskComplete = (last: string) => JSON.stringify({ timestamp: "2026-07-10T21:59:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: last } })
const CX_DONE = "All wired.\n\n```done\nwired\n```"

// Write a rollout into a $CODEX_HOME date-sharded sessions dir (filename suffix = the codex id, which
// findRolloutById locates by). Returns the path so the test can append to it mid-tick.
function writeCodexRollout(codexHome: string, codexId: string, lines: string[]): string {
  const dir = join(codexHome, "sessions", "2026", "07", "10")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-07-10T21-58-43-${codexId}.jsonl`)
  writeFileSync(path, lines.map((l) => l + "\n").join(""))
  return path
}

// A tailer whose backendFor routes codex rows to a real CodexBackend (tmp $CODEX_HOME) and everything
// else to a real ClaudeBackend — mirroring context.ts's resolver.
function codexTailer(h: Harness, codexHome: string) {
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: h.logDir })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  return createTailer({
    project: { cwdSlug: "x" } as Project,
    storage: h.storage,
    bus: h.bus,
    onChange: () => h.changes.n++,
    now: () => h.clock.ms,
    paneDead: () => h.dead.v,
    capturePane: () => h.pane.text,
    sessionLogDir: h.logDir,
    backendFor,
  })
}

// Pin a codex row the way dispatch does: backend + the discovered rollout id land via the dedicated
// setters (the shared upsert never writes them), leaving session_id as the fray-minted key.
function pinCodexRow(h: Harness, codexId: string) {
  h.storage.upsertSession(row({ session_id: "fray-uuid" }))
  h.storage.setBackend("t", "codex")
  h.storage.setAgentSession("t", codexId)
}

test("tailer: a codex rollout primes to in-flight, then transitions to idle+fence THROUGH the tick", () => {
  const h = harness()
  const codexHome = tmp("fray-codexhome-")
  const codexId = "019f4e0a-42cb-7891-9cbf-325e93ae587c"
  const path = writeCodexRollout(codexHome, codexId, [cxMeta(codexId, "/x"), cxTaskStarted]) // turn open
  pinCodexRow(h, codexId)
  const t = codexTailer(h, codexHome)

  h.clock.ms = Date.parse("2026-07-10T21:58:45.000Z")
  t.tick() // prime while the turn is open
  assert.equal(t.get("t")?.turn, "in-flight", "an open codex turn (task_started, no task_complete) is in-flight")
  assert.equal(h.events.length, 0, "priming an in-flight codex turn never notifies")

  // The turn brackets closed with a done fence on the final message.
  appendFileSync(path, cxAgentFinal(CX_DONE) + "\n" + cxTaskComplete(CX_DONE) + "\n")
  h.clock.ms = Date.parse("2026-07-10T21:59:05.000Z")
  t.tick()
  const tele = t.get("t")
  // THE REGRESSION: without the patch computeTurn clobbers this back to "in-flight".
  assert.equal(tele?.turn, "idle", "task_complete's explicit bracket survives the tick's computeTurn")
  assert.deepEqual(tele?.lastFence, { kind: "done", body: "wired", hints: [] }, "the done fence is derived from the final message")
  assert.equal(tele?.lastAssistant, "All wired. ```done wired ```", "the final answer is the preview")
  const notifies = h.events.filter((e) => e.type === "notify")
  assert.equal(notifies.length, 1, "the in-flight→idle transition fires exactly one turn-done notify")
  assert.equal(notifies[0].type === "notify" && notifies[0].kind, "turn-done")
  assert.equal(h.storage.getSession("t")?.unread, 1, "a completed codex turn badges unread")
})

test("tailer: a codex rollout already at task_complete PRIMES straight to idle (not clobbered to in-flight)", () => {
  const h = harness()
  const codexHome = tmp("fray-codexhome-")
  const codexId = "019f4e0b-1111-2222-3333-444455556666"
  writeCodexRollout(codexHome, codexId, [cxMeta(codexId, "/x"), cxTaskStarted, cxAgentFinal(CX_DONE), cxTaskComplete(CX_DONE)])
  pinCodexRow(h, codexId)
  const t = codexTailer(h, codexHome)

  h.clock.ms = Date.parse("2026-07-10T22:05:00.000Z")
  t.tick() // prime a fully-bracketed rollout
  assert.equal(t.get("t")?.turn, "idle", "a primed, fully-bracketed codex rollout is idle — computeTurn respects it")
  assert.equal(h.events.length, 0, "priming never notifies (the completion pre-dates first sight)")
})
