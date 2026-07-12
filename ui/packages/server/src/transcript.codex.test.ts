import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseCodexTranscript } from "./transcript.ts"

// ---- codex rollout → TranscriptMessage[] (the chat-drawer render path) ----
// Grounded in REAL captured rollouts (codex-cli 0.144.1) — the SAME fixtures backend/codex.test.ts folds
// for board telemetry, so the drawer render and the board can never disagree about a record's meaning.
// Every record shape codex emits must map onto a renderable card or degrade cleanly (never throw, never
// a blank pane). Synthetic cases below cover shapes the two fixtures don't exercise (apply_patch, the
// argv `shell` tool, the dispatch-scaffolding strip, malformed lines).

const FIX = join(import.meta.dirname, "backend", "codex.fixtures")
const tuiSingleTurn = readFileSync(join(FIX, "tui-single-turn.jsonl"), "utf8")
const execTwoTurn = readFileSync(join(FIX, "exec-two-turn.jsonl"), "utf8")
// A REAL captured rollout (codex-cli 0.144.1) of a worker that read/wrote/edited files, listed the dir,
// and ran git status — the diverse tool surface, INCLUDING two apply_patch edits delivered as codex
// `custom_tool_call` records (which parseCodexLine had to be extended to map, else every edit vanished).
const tuiApplyPatch = readFileSync(join(FIX, "tui-apply-patch.jsonl"), "utf8")

test("codex fixture (tui-single-turn): user prompt + assistant turn with an exec Bash card carrying its output", () => {
  const msgs = parseCodexTranscript(tuiSingleTurn)
  assert.equal(msgs.length, 2)

  assert.equal(msgs[0].role, "user")
  assert.match(msgs[0].text, /Read hello\.txt with cat/)

  const a = msgs[1]
  assert.equal(a.role, "assistant")
  // The final answer (with its ```done fence) renders as the assistant prose.
  assert.match(a.text, /```done\ntui-ok\n```/)
  // The exec_command call renders as a Bash card carrying the command AND its (envelope-stripped) output.
  assert.equal(a.tools.length, 1)
  assert.equal(a.tools[0].name, "Bash")
  assert.equal(a.tools[0].command, "cat hello.txt")
  assert.equal(a.tools[0].output, "tui file")
  assert.equal(a.tools[0].edit, undefined)
  // parts preserve tool-then-text order (the card sits above the answer it introduced).
  assert.deepEqual(
    a.parts.map((p) => p.kind),
    ["tools", "text"],
  )
})

test("codex fixture (exec-two-turn): two turns; multi-tool run; empty output dropped; commentary interleaves", () => {
  const msgs = parseCodexTranscript(execTwoTurn)
  assert.equal(msgs.length, 4)
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  )

  // Turn 1: two exec calls in one run → one coalesced tools band, results back-filled by call_id.
  const t1 = msgs[1]
  assert.deepEqual(
    t1.tools.map((t) => t.command),
    ["cat hello.txt", "printf 'ok' > note.txt"],
  )
  assert.equal(t1.tools[0].output, "test file")
  // The write produced no stdout → no output pane (an empty result is dropped, not a blank card).
  assert.equal(t1.tools[1].output, undefined)
  assert.match(t1.text, /```done\nall-good\n```/)

  // Turn 2: commentary before each tool → text/tools/text/tools/text/tools/text interleave.
  const t2 = msgs[3]
  assert.deepEqual(
    t2.tools.map((t) => t.command),
    ["date", "ls", "wc -l hello.txt"],
  )
  assert.match(t2.tools[1].output ?? "", /hello\.txt/) // the ls listing
  assert.deepEqual(
    t2.parts.map((p) => p.kind),
    ["text", "tools", "text", "tools", "text", "tools", "text"],
  )
  // The final answer's ```awaiting fence rides the assistant prose.
  assert.match(t2.text, /```awaiting/)
})

test("codex fixture (tui-apply-patch): the full tool surface — reads, a write, apply_patch EDITS, ls, git — all render", () => {
  const msgs = parseCodexTranscript(tuiApplyPatch)
  assert.equal(msgs.length, 2)
  const a = msgs[1]
  assert.equal(a.role, "assistant")

  // Shell commands render as Bash cards carrying their output.
  const bash = a.tools.filter((t) => t.command)
  assert.deepEqual(
    bash.map((t) => t.command),
    ["cat hello.txt", "printf 'codex-was-here' > note.txt", "cat greeter.js", "ls -la", "git status"],
  )
  assert.equal(bash[0].output, "test file")
  assert.match(bash[4].output ?? "", /On branch main/)

  // apply_patch edits (codex custom_tool_call) render as Edit diff cards — the whole point of the
  // custom_tool_call extension; without it these two edits would be invisible.
  const edits = a.tools.filter((t) => t.edit)
  assert.equal(edits.length, 2)
  assert.ok(edits.every((t) => t.name === "Edit" && t.edit?.file.endsWith("greeter.js")))
  // The successful patch flips "hi " → "hello " in greet().
  assert.ok(edits.some((t) => /hello " \+ name/.test(t.edit?.new ?? "")))

  // The final answer (the ```done fence) rides the assistant prose.
  assert.match(a.text, /```\ndone\ne2e-tools-ok\n```/)
})

// A minimal well-formed rollout builder for synthetic shapes (session_meta is sidecar → skipped).
function rollout(lines: Array<{ type: string; payload: Record<string, unknown> }>): string {
  return lines.map((l) => JSON.stringify({ timestamp: "2026-07-11T00:00:00.000Z", ...l })).join("\n")
}

test("codex apply_patch (Add File) → an Edit diff card (old empty, new = added lines)", () => {
  const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+export const x = 1", "+export const y = 2", "*** End Patch"].join("\n")
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "make the file" } },
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Success. Updated the file src/new.ts" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "done" } },
  ])
  const msgs = parseCodexTranscript(raw)
  const call = msgs[1].tools[0]
  assert.equal(call.name, "Edit")
  assert.equal(call.edit?.file, "src/new.ts")
  assert.equal(call.edit?.old, "")
  assert.equal(call.edit?.new, "export const x = 1\nexport const y = 2")
})

test("codex apply_patch (Update File) → an Edit diff card (old/new reconstructed from the hunk)", () => {
  const patch = ["*** Begin Patch", "*** Update File: a.txt", "@@", " keep", "-old line", "+new line", "*** End Patch"].join("\n")
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.name, "Edit")
  assert.equal(call.edit?.file, "a.txt")
  assert.equal(call.edit?.old, "keep\nold line")
  assert.equal(call.edit?.new, "keep\nnew line")
})

test("codex `shell` tool with an argv command (['bash','-lc','<script>']) → the script as the Bash command", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "grep -r foo ."] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: x\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nfoo\n" } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.name, "Bash")
  assert.equal(call.command, "grep -r foo .")
  assert.equal(call.output, "foo")
})

test("codex non-zero exit → the output pane is prefixed with [exit N]", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: x\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n" } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.command, "false")
  assert.equal(call.output, "[exit 1]")
})

test("codex unknown tool degrades to a generic card (name + a hint), never a throw or blank", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "web_search", arguments: JSON.stringify({ query: "codex rollout schema" }) } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.name, "web_search")
  assert.equal(call.detail, "codex rollout schema")
  assert.equal(call.command, undefined)
  assert.equal(call.edit, undefined)
})

test("codex first user message strips the dispatch scaffolding (before \\nTASK:\\n) and the discovery sentinel", () => {
  const composed = "WORKER CONTRACT stuff\n\nscratchpad orientation\n\nSome preamble\nTASK:\nActually do the thing\n\n<!-- fray-session:abc-123 -->"
  const raw = rollout([{ type: "event_msg", payload: { type: "user_message", message: composed } }])
  const msgs = parseCodexTranscript(raw)
  assert.equal(msgs[0].text, "Actually do the thing")
})

test("codex follow-up (resume) user message renders in full (no first-message strip, no sentinel)", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "first\nTASK:\nthe task\n\n<!-- fray-session:s1 -->" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "ok" } },
    { type: "event_msg", payload: { type: "user_message", message: "now also handle the edge case" } },
  ])
  const msgs = parseCodexTranscript(raw)
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
  )
  assert.equal(msgs[0].text, "the task")
  assert.equal(msgs[2].text, "now also handle the edge case")
})

test("codex turn-end fallback: a commentary-only turn's answer (only on task_complete) is surfaced, not dropped", () => {
  // A turn that emits commentary but NO agent_message/final_answer, whose real answer rides only
  // task_complete.last_agent_message. Gating on sawFinalAnswer (not "any text") keeps this from being
  // suppressed by the commentary, while the ordinary echo case still never double-renders.
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "do it" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "working on it" } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "the real answer" } },
  ])
  const msgs = parseCodexTranscript(raw)
  const a = msgs.find((m) => m.role === "assistant")!
  assert.match(a.text, /working on it/)
  assert.match(a.text, /the real answer/) // would be DROPPED under the old !turnHasText gate
})

test("codex turn-end: the ordinary case never double-renders the final answer echoed on task_complete", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "the answer" } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "the answer" } },
  ])
  const a = parseCodexTranscript(raw).find((m) => m.role === "assistant")!
  assert.equal(a.text, "the answer") // exactly once
})

test("codex parser is defensive: empty input, blank/malformed lines, and sidecar-only records → no throw", () => {
  assert.deepEqual(parseCodexTranscript(""), [])
  assert.deepEqual(parseCodexTranscript("\n  \nnot json\n{bad"), [])
  // session_meta / token_count / reasoning / the raw response_item/message echo are all sidecar → nothing.
  const sidecar = rollout([
    { type: "session_meta", payload: { session_id: "s", cwd: "/tmp" } },
    { type: "event_msg", payload: { type: "token_count", info: {} } },
    { type: "response_item", payload: { type: "reasoning", content: "secret" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "echo dup" }] } },
  ])
  assert.deepEqual(parseCodexTranscript(sidecar), [])
})
