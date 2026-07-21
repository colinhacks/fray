import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { GITHUB_DISPATCH_UI_BOUNDARY } from "@fray-ui/shared"
import {
  githubDispatchDisplayText,
  pageProjectedTranscript,
  parseTranscript,
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  readThreadTranscript,
} from "./transcript.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"

// Build a minimal assistant JSONL record carrying one tool_use block.
function toolLine(name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", name, input }] },
  })
}

const githubTask = `THREAD: investigate-cli-cli-326

Investigate this issue and make recommendations

Issue #326: Support multiple accounts
Repository: cli/cli
URL: https://github.com/cli/cli/issues/326

${GITHUB_DISPATCH_UI_BOUNDARY}

You are triaging a GitHub issue. This full worker template must remain available.`

test("Claude GitHub dispatch retains full first-user text but exposes only the compact generated lead", () => {
  const raw = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { content: `scratchpad orientation\n\nTASK:\n${githubTask}` },
  })
  const [message] = parseTranscript(raw)
  assert.equal(message.text, githubTask)
  assert.equal(
    message.displayText,
    "Investigate this issue and make recommendations\n\nIssue #326: Support multiple accounts\nRepository: cli/cli\nURL: https://github.com/cli/cli/issues/326",
  )
  assert.match(message.text, /full worker template must remain available/)
  assert.doesNotMatch(message.displayText!, /worker template|github-dispatch-ui-boundary/)
})

test("GitHub display boundary is inert without the complete generated envelope", () => {
  const ordinary = `Example HTML comment:\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\nkeep this visible`
  assert.equal(githubDispatchDisplayText(ordinary), undefined)
  const nearMiss = githubTask.replace("github-dispatch-ui-boundary:v1", "github-dispatch-ui-boundary:v2")
  assert.equal(githubDispatchDisplayText(nearMiss), undefined)
})

test("Edit → structured edit payload (old/new captured)", () => {
  const msgs = parseTranscript(toolLine("Edit", { file_path: "/x/a.ts", old_string: "foo", new_string: "bar" }))
  const call = msgs[0].tools[0]
  assert.equal(call.name, "Edit")
  assert.deepEqual(call.edit, { file: "/x/a.ts", old: "foo", new: "bar" })
})

test("Write → edit with empty old side (whole file new)", () => {
  const msgs = parseTranscript(toolLine("Write", { file_path: "/x/n.ts", content: "hello" }))
  assert.deepEqual(msgs[0].tools[0].edit, { file: "/x/n.ts", old: "", new: "hello" })
})

test("MultiEdit → one tool call per sub-edit", () => {
  const msgs = parseTranscript(
    toolLine("MultiEdit", {
      file_path: "/x/m.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    }),
  )
  assert.equal(msgs[0].tools.length, 2)
  assert.deepEqual(msgs[0].tools[0].edit, { file: "/x/m.ts", old: "a", new: "A" })
  assert.deepEqual(msgs[0].tools[1].edit, { file: "/x/m.ts", old: "b", new: "B" })
})

test("edit strings are capped with a truncation marker", () => {
  const big = "x".repeat(5000)
  const msgs = parseTranscript(toolLine("Write", { file_path: "/x/big.ts", content: big }))
  const newVal = msgs[0].tools[0].edit!.new
  assert.ok(newVal.length < big.length)
  assert.ok(newVal.endsWith("(truncated)"))
})

test("non-edit tool → no edit payload, detail preserved", () => {
  const msgs = parseTranscript(toolLine("Bash", { command: "ls -la" }))
  const call = msgs[0].tools[0]
  assert.equal(call.edit, undefined)
  assert.equal(call.detail, "ls -la")
})

test("Edit missing new_string → falls back to plain tool call", () => {
  const msgs = parseTranscript(toolLine("Edit", { file_path: "/x/a.ts", old_string: "foo" }))
  assert.equal(msgs[0].tools[0].edit, undefined)
})

test("multi-line Bash → raw command block + first-line summary detail", () => {
  const cmd = "cd /tmp\nnpm run build\necho done"
  const call = parseTranscript(toolLine("Bash", { command: cmd })).at(0)!.tools[0]
  assert.equal(call.command, cmd) // newlines preserved verbatim
  assert.equal(call.detail, "cd /tmp…") // summary is the first line + ellipsis
})

test("long single-line Bash (>120 chars) → raw command block", () => {
  const cmd = "echo " + "x".repeat(200)
  const call = parseTranscript(toolLine("Bash", { command: cmd })).at(0)!.tools[0]
  assert.equal(call.command, cmd)
})

test("short one-line Bash → command block too (every Bash renders as a card)", () => {
  const call = parseTranscript(toolLine("Bash", { command: "git status" })).at(0)!.tools[0]
  assert.equal(call.command, "git status") // command shipped for ALL Bash now (no block-worthiness gate)
  assert.equal(call.detail, "git status")
})

test("short `a; b` Bash also ships a command block", () => {
  const call = parseTranscript(toolLine("Bash", { command: "a; b" })).at(0)!.tools[0]
  assert.equal(call.command, "a; b")
  assert.equal(call.detail, "a; b")
})

test("background Bash launch stays running through its acknowledgement and only task-notification ends it", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-bg", name: "Bash", input: { command: "watch ci", description: "Watch CI", run_in_background: true } }] },
  })
  const acknowledged = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-bg", content: "Command running in background" }] },
  })
  const live = parseTranscript([launch, acknowledged].join("\n"))[0].tools[0]
  assert.equal(live.status, "pending")
  assert.equal(live.backgroundState, "background")

  const completed = parseTranscript([launch, acknowledged, taskNotification("bash-bg", "completed", "2026-07-01T00:00:05.000Z")].join("\n"))[0].tools[0]
  assert.equal(completed.status, "completed")
  assert.equal(completed.durationMs, 5000)
  assert.equal(completed.backgroundState, "background")
})

test("a background shell completion emits a labeled turn-boundary event that breaks the merge chain", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-bg", name: "Bash", input: { command: "npx vite", description: "Start vite from web package dir", run_in_background: true } }] },
  })
  // A failed completion whose summary carries the exit code the wake label should surface.
  const notify = JSON.stringify({
    type: "queue-operation",
    timestamp: "2026-07-01T00:00:05.000Z",
    content: `<task-notification>\n<tool-use-id>bash-bg</tool-use-id>\n<status>failed</status>\n<summary>Background command "Start vite from web package dir" failed with exit code 143</summary>\n</task-notification>`,
  })
  // The wake re-invokes the agent; the following turn's records can even reuse the SAME message.id as
  // the launch (id "m-bg"). Without the boundary breaking the merge chain, that record would fold back
  // into the launch message; the boundary must keep it a SEPARATE rendered turn.
  const afterWake = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:06.000Z",
    message: { id: "m-bg", content: [{ type: "text", text: "That's the vite server I just killed." }] },
  })
  const msgs = parseTranscript([launch, notify, afterWake].join("\n"))
  // The shell card (launch message) is still back-filled with the terminal state + duration…
  assert.equal(msgs[0].tools[0].status, "failed")
  assert.equal(msgs[0].tools[0].durationMs, 5000)
  // …AND a boundary event line rides the wake point carrying the cause label (desc + exit code)…
  const boundary = msgs[1]
  assert.equal(boundary.kind, "event")
  assert.equal(boundary.boundary, true)
  assert.equal(boundary.text, "Woken by background task «Start vite from web package dir» — exited 143")
  // …and the post-wake turn is its OWN message (the merge chain was broken), not merged into the launch.
  assert.equal(msgs.length, 3)
  assert.equal(msgs[2].text, "That's the vite server I just killed.")
  assert.equal(msgs[0].text, "") // launch stayed tools-only — the post-wake prose did NOT fold into it
})

test("boundary wake label reads 'finished' on a clean exit and 'stopped' when killed", () => {
  const launch = (id: string) => JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 1", run_in_background: true } }] },
  })
  const done = parseTranscript([launch("s1"), taskNotification("s1", "completed", "2026-07-01T00:00:02.000Z")].join("\n"))[1]
  assert.match(done.text, /— finished$/)
  assert.equal(done.text, "Woken by background task «sleep 1» — finished") // desc falls back to the command summary
  const killed = parseTranscript([launch("s2"), taskNotification("s2", "killed", "2026-07-01T00:00:02.000Z")].join("\n"))[1]
  assert.match(killed.text, /— stopped$/)
})

test("background Bash with no completion remains live after transcript reload", () => {
  const raw = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-orphan", name: "Bash", input: { command: "watch ci", run_in_background: true } }] },
  })
  const once = parseTranscript(raw)[0].tools[0]
  const reloaded = parseTranscript(raw)[0].tools[0]
  assert.deepEqual({ status: reloaded.status, backgroundState: reloaded.backgroundState }, { status: once.status, backgroundState: once.backgroundState })
  assert.equal(reloaded.status, "pending")
})

test("Bash command block is capped with a truncation marker", () => {
  const cmd = "run\n" + "y".repeat(5000)
  const call = parseTranscript(toolLine("Bash", { command: cmd })).at(0)!.tools[0]
  assert.ok(call.command!.length < cmd.length)
  assert.ok(call.command!.endsWith("(truncated)"))
})

// ---- Agent dispatch card + completion event ----

// An assistant record carrying an Agent tool_use with an explicit block id (toolLine omits the id).
function agentDispatch(id: string, input: unknown, ts = "2026-07-01T00:00:00.000Z"): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "m1", content: [{ type: "tool_use", name: "Agent", id, input }] } })
}
function taskNotification(toolUseId: string, status: string, ts: string): string {
  return JSON.stringify({
    type: "queue-operation",
    timestamp: ts,
    content: `<task-notification>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
  })
}

test("Agent dispatch with a prompt → AgentBlock fields captured (detail/prompt/type/id)", () => {
  const rec = agentDispatch("toolu_a", { description: "Do the thing", prompt: "Long prompt here", subagent_type: "fray:fray-opus-high", run_in_background: true })
  const call = parseTranscript(rec).at(0)!.tools[0]
  assert.equal(call.name, "Agent")
  assert.equal(call.detail, "Do the thing")
  assert.equal(call.prompt, "Long prompt here")
  assert.equal(call.subagentType, "fray:fray-opus-high")
  assert.equal(call.agentId, "toolu_a")
})

test("Agent prompt is capped with a truncation marker", () => {
  const big = "z".repeat(6000)
  const call = parseTranscript(agentDispatch("toolu_a", { description: "x", prompt: big, run_in_background: true })).at(0)!.tools[0]
  assert.ok(call.prompt!.length < big.length)
  assert.ok(call.prompt!.endsWith("(truncated)"))
})

test("SendMessage → SendMessageCard fields captured (to/summary/body/type)", () => {
  const call = parseTranscript(toolLine("SendMessage", { to: "win-vm-provision", summary: "Steer to UTM path", message: "Try `utmctl` first.", type: "message" })).at(0)!.tools[0]
  assert.equal(call.name, "SendMessage")
  assert.equal(call.sendTo, "win-vm-provision")
  assert.equal(call.sendSummary, "Steer to UTM path")
  assert.equal(call.sendBody, "Try `utmctl` first.")
  assert.equal(call.sendType, "message")
  // detail falls back to the summary (else the recipient) so a degrading old client still shows something.
  assert.equal(call.detail, "Steer to UTM path")
})

test("SendMessage accepts the recipient/content aliases and a shutdown_request type", () => {
  const call = parseTranscript(toolLine("SendMessage", { recipient: "peer", content: "please rest", type: "shutdown_request" })).at(0)!.tools[0]
  assert.equal(call.sendTo, "peer")
  assert.equal(call.sendBody, "please rest")
  assert.equal(call.sendType, "shutdown_request")
  assert.equal(call.sendSummary, undefined)
})

test("SendMessage body is capped with a truncation marker", () => {
  const big = "z".repeat(6000)
  const call = parseTranscript(toolLine("SendMessage", { to: "x", message: big })).at(0)!.tools[0]
  assert.ok(call.sendBody!.length < big.length)
  assert.ok(call.sendBody!.endsWith("(truncated)"))
})

test("SendUserFile → an image is copied into the servable cache (sentImages) + caption captured", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-sent-"))
  const png = join(dir, "shot.png")
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])) // PNG magic + filler
  try {
    const call = parseTranscript(toolLine("SendUserFile", { files: [png], caption: "the fix", status: "proactive" })).at(0)!.tools[0]
    assert.equal(call.name, "SendUserFile")
    assert.equal(call.caption, "the fix")
    assert.equal(call.sentImages?.length, 1)
    assert.match(call.sentImages![0], /fray-tool-images\/[0-9a-f]{32}\.png$/) // servable cache copy, not the source
    assert.equal(call.sentFiles, undefined)
    assert.ok(readFileSync(call.sentImages![0]).length >= 12) // the copy exists on disk
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SendUserFile → a non-image file is an openable chip (sentFiles keeps the full path); no image copy", () => {
  const call = parseTranscript(toolLine("SendUserFile", { files: ["/abs/report.md"], caption: "the report" })).at(0)!.tools[0]
  assert.equal(call.sentImages, undefined)
  assert.deepEqual(call.sentFiles, ["/abs/report.md"]) // full path so the client can link it
  assert.equal(call.caption, "the report")
})

test("SendUserFile display:attach renders even an image as a chip, never inline", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-sent-"))
  const png = join(dir, "shot.png")
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
  try {
    const call = parseTranscript(toolLine("SendUserFile", { files: [png], display: "attach" })).at(0)!.tools[0]
    assert.equal(call.sentImages, undefined)
    assert.deepEqual(call.sentFiles, [png])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SendUserFile reusing a path with new content across calls is NOT served stale (cache keyed on the call)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-sent-"))
  const png = join(dir, "shot.png") // the SAME filename the worker overwrites each QA iteration
  const toolLineId = (id: string) => JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", id, name: "SendUserFile", input: { files: [png] } }] },
  })
  try {
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1]))
    const first = parseTranscript(toolLineId("sf-call-1")).at(0)!.tools[0].sentImages![0]
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 9, 9])) // overwrite, new bytes
    const second = parseTranscript(toolLineId("sf-call-2")).at(0)!.tools[0].sentImages![0]
    assert.notEqual(first, second) // distinct cache entries — the second call is not the stale first copy
    assert.deepEqual([...readFileSync(second)].slice(8), [9, 9, 9, 9, 9, 9]) // the fresh content
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Agent completion → inline AgentBlock re-render + back-filled terminal state", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "Do the thing", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:35:00.000Z"),
    ].join("\n"),
  )
  // The completion re-renders the dispatch's Agent tool call inline at the notification's position —
  // a plain assistant message carrying the finished call as a tools part (renders as a clickable
  // AgentBlock), NOT a text event line.
  const completion = msgs.at(-1)!
  assert.equal(completion.kind, undefined)
  const inline = completion.tools[0]
  assert.equal(inline.name, "Agent")
  assert.equal(inline.detail, "Do the thing")
  assert.equal(inline.agentId, "toolu_a", "carries the correlation id so the card links into the drawer")
  assert.equal(inline.agentStatus, "completed")
  assert.equal(inline.agentElapsedMs, 35 * 60_000)
  assert.deepEqual(completion.parts, [{ kind: "tools", tools: [inline] }])
  // the ORIGINAL launch card is also back-filled with the outcome
  const call = msgs[0].tools[0]
  assert.equal(call.agentStatus, "completed")
  assert.equal(call.agentElapsedMs, 35 * 60_000)
  assert.equal(call.status, "completed")
  assert.equal(call.durationMs, 35 * 60_000)
})

test("failed sub-agent → inline failed AgentBlock; a background-bash notification is ignored", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "X", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_bash", "completed", "2026-07-01T00:05:00.000Z"), // not a tracked Agent id
      taskNotification("toolu_a", "failed", "2026-07-01T00:12:00.000Z"),
    ].join("\n"),
  )
  // Dispatch card + ONE completion card; the untracked background-bash notification emits nothing.
  assert.equal(msgs.length, 2)
  const inline = msgs.at(-1)!.tools[0]
  assert.equal(inline.agentStatus, "failed")
  assert.equal(inline.agentElapsedMs, 12 * 60_000)
  assert.equal(inline.status, "failed")
})

test("an immediate Agent launch error terminates the card instead of leaving it pending forever", () => {
  const raw = [
    agentDispatch("tu1", { prompt: "review", description: "reviewer", subagent_type: "general" }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "Agent launch failed: thread limit reached" }] },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "failed")
  assert.match(call.output ?? "", /thread limit reached/)
})

test("a duplicate terminal notification re-renders the completion card only once", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "X", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:10:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:10:00.000Z"),
    ].join("\n"),
  )
  // First notification consumes the dispatch entry; the second matches nothing → no second card.
  assert.equal(msgs.length, 2) // dispatch card + exactly one completion card
})

// ---- long thinking windows ----
const userRec = (ts: string) => JSON.stringify({ type: "user", timestamp: ts, message: { content: "go" } })
const thinkRec = (ts: string, mid: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: [{ type: "thinking", signature: "sig", thinking: "" }] } })
const bashRec = (ts: string, mid: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } })

test("a long gap before a thinking block → 'Thought for Ns' event; the turn's card is not absorbed", () => {
  const msgs = parseTranscript([userRec("2026-07-01T00:00:00.000Z"), thinkRec("2026-07-01T00:00:30.000Z", "m1"), bashRec("2026-07-01T00:00:31.000Z", "m1")].join("\n"))
  const ev = msgs.find((m) => m.kind === "event")
  assert.ok(ev, "a long thinking gap emits an event")
  assert.equal(ev!.text, "Thought for 30s")
  const toolMsg = msgs.find((m) => m.role === "assistant" && m.kind === undefined && m.tools.length > 0)
  assert.ok(toolMsg, "the turn's tool card is its own message, never merged into the event line")
})

test("a short gap before a thinking block emits no event", () => {
  const msgs = parseTranscript([userRec("2026-07-01T00:00:00.000Z"), thinkRec("2026-07-01T00:00:05.000Z", "m2"), bashRec("2026-07-01T00:00:06.000Z", "m2")].join("\n"))
  assert.equal(msgs.filter((m) => m.kind === "event").length, 0)
})

test("a thinking-only record opening a NEW turn does not glue that turn onto the previous one", () => {
  // The interleave "wall of text" trap: turn A (text + tool) is out's tail, a tool_result sits between,
  // then turn B opens with a THINKING-ONLY record (short gap → no event line). A thinking-only record
  // renders nothing, so it must NOT claim the merge anchor for its new id — otherwise B's text+tools
  // fold into A's bubble (tool calls under the wrong turn, texts coalesced into one wall).
  const asstMulti = (mid: string, ts: string, blocks: unknown[]) =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: blocks } })
  const msgs = parseTranscript([
    asstMulti("mA", "2026-07-01T00:00:00.000Z", [
      { type: "text", text: "Answer A." },
      { type: "tool_use", id: "tu-a", name: "Read", input: { file_path: "/a" } },
    ]),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-a", content: "ok" }] } }),
    thinkRec("2026-07-01T00:00:03.000Z", "mB"), // short gap → no event; the trap record
    asstMulti("mB", "2026-07-01T00:00:04.000Z", [
      { type: "text", text: "Answer B." },
      { type: "tool_use", id: "tu-b", name: "Read", input: { file_path: "/b" } },
    ]),
  ].join("\n"))
  const assistant = msgs.filter((m) => m.role === "assistant" && m.kind === undefined)
  assert.equal(assistant.length, 2, "A and B are TWO separate assistant messages, not glued into one")
  assert.ok(assistant[0].text.includes("Answer A") && !assistant[0].text.includes("Answer B"), "A's bubble holds only A")
  assert.ok(assistant[1].text.includes("Answer B") && !assistant[1].text.includes("Answer A"), "B's bubble holds only B")
})

// ---- ordered parts (block-order fidelity) ----
const asstBlock = (mid: string, block: unknown) => JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { id: mid, content: [block] } })

test("parts preserve text↔tool block ORDER within a turn (the lead-in fix)", () => {
  // Same message id across split records: text lead-in, then its tool_use, then a trailing text.
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "text", text: "Let me draft the release notes:" }),
      asstBlock("m1", { type: "tool_use", name: "Write", input: { file_path: "/x/notes.md", content: "notes" } }),
      asstBlock("m1", { type: "text", text: "Done — notes written." }),
    ].join("\n"),
  )
  assert.equal(msgs.length, 1)
  const parts = msgs[0].parts
  assert.deepEqual(parts.map((p) => p.kind), ["text", "tools", "text"]) // ORDER preserved
  assert.equal(parts[0].kind === "text" && parts[0].text, "Let me draft the release notes:")
  assert.equal(parts[1].kind === "tools" && parts[1].tools[0].name, "Write")
  // legacy flat fields still populated for the pre-restart client window
  assert.equal(msgs[0].tools.length, 1)
  assert.ok(msgs[0].text.includes("Let me draft") && msgs[0].text.includes("Done"))
})

test("contiguous same-kind blocks coalesce into one part", () => {
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "tool_use", name: "Read", input: { file_path: "/a" } }),
      asstBlock("m1", { type: "tool_use", name: "Read", input: { file_path: "/b" } }),
      asstBlock("m1", { type: "text", text: "para one" }),
      asstBlock("m1", { type: "text", text: "para two" }),
    ].join("\n"),
  )
  const parts = msgs[0].parts
  assert.deepEqual(parts.map((p) => p.kind), ["tools", "text"]) // two Reads → one tools part; two texts → one text part
  assert.equal(parts[0].kind === "tools" && parts[0].tools.length, 2)
})

// ---- queued human follow-ups to a mid-turn worker (the message-swallow fix) ----
const enqueue = (content: string, ts = "2026-07-01T00:00:00.000Z") =>
  JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: ts, content })
const removeOp = (op: string, content: string, ts = "2026-07-01T00:00:01.000Z") =>
  JSON.stringify({ type: "queue-operation", operation: op, timestamp: ts, content })
const deliver = (prompt: string, ts = "2026-07-01T00:00:01.000Z", commandMode = "prompt", kind = "human") =>
  JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type: "queued_command", prompt, commandMode, origin: { kind } } })

test("enqueue with no delivery yet → a pending queued user bubble", () => {
  const msgs = parseTranscript(enqueue("ping the worker"))
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, "user")
  assert.equal(msgs[0].text, "ping the worker")
  assert.equal(msgs[0].queued, true)
})

test("enqueue + delivering attachment → ONE delivered user message (not two), un-queued", () => {
  const msgs = parseTranscript([enqueue("do the thing"), deliver("do the thing")].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].text, "do the thing")
  assert.equal(users[0].queued, false) // resolved in place — no longer grayed
})

test("real lifecycle enqueue → remove → attachment → ONE delivered user message (session 2cfe3c81 shape)", () => {
  const text = "Stop. Ask me the questions again."
  const msgs = parseTranscript([enqueue(text), removeOp("remove", text), deliver(text)].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].text, text)
  assert.ok(!users[0].queued)
})

test("attachment-only (older session, no enqueue seen) → a delivered user message", () => {
  const msgs = parseTranscript(deliver("hello from the past"))
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, "user")
  assert.equal(msgs[0].text, "hello from the past")
  assert.ok(!msgs[0].queued)
})

test("an EMPTY-content dequeue does NOT evict a still-pending human bubble (cross-talk guard)", () => {
  const msgs = parseTranscript(
    [enqueue("human still waiting"), JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-01T00:00:02.000Z" })].join("\n"),
  )
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].queued, true)
})

test("a non-'prompt' commandMode attachment (a task-notification materialized the same way) is not a human bubble", () => {
  const msgs = parseTranscript(deliver("<task-notification>x</task-notification>", "2026-07-01T00:00:01.000Z", "task-notification"))
  assert.equal(msgs.length, 0)
})

test("an enqueue carrying task-notification content is not rendered as a human bubble", () => {
  const msgs = parseTranscript(
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-01T00:00:00.000Z",
      content: "<task-notification>\n<tool-use-id>x</tool-use-id>\n<status>running</status>\n</task-notification>",
    }),
  )
  assert.equal(msgs.length, 0) // non-terminal notification → no completion event AND no queued bubble
})

test("a delivered queued message is deduped against an immediately-following identical user record", () => {
  const msgs = parseTranscript(
    [deliver("same text"), JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: "same text" } })].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.role === "user").length, 1)
})

test("a queued follow-up between assistant turns leaves the assistant cards intact", () => {
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "tool_use", name: "Bash", input: { command: "ls" } }),
      enqueue("interrupt!"),
      deliver("interrupt!"),
      asstBlock("m2", { type: "text", text: "resuming" }),
    ].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.role === "user").length, 1) // one delivered human message…
  assert.equal(msgs.filter((m) => m.role === "assistant" && m.kind === undefined).length, 2) // …between two intact assistant turns
})

test("real Claude Code 2.1.207 SDK lifecycle dedupes its prompt and back-fills common tool results", () => {
  const prompt = "Exercise the disposable tool fixture."
  const raw = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-13T06:23:55.650Z", content: prompt }),
    JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-13T06:23:55.651Z" }),
    JSON.stringify({ type: "user", timestamp: "2026-07-13T06:23:55.660Z", message: { role: "user", content: prompt }, promptSource: "sdk" }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: {
        id: "m-real",
        content: [
          { type: "tool_use", id: "grep", name: "Grep", input: { pattern: "FRAY_CLAUDE_RENDER_NEEDLE", path: "/tmp/README.md" } },
          { type: "tool_use", id: "bash", name: "Bash", input: { command: "printf ok", description: "Print output" } },
          { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "hello", new_string: "hello-renderer" } },
          { type: "tool_use", id: "cancel", name: "Bash", input: { command: "sleep 60" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "grep", content: "Found 1 file\nREADME.md" },
          { type: "tool_result", tool_use_id: "bash", is_error: false, content: "FRAY_API_TOKEN=secret-value\nok" },
          { type: "tool_result", tool_use_id: "edit", content: "The file /tmp/a.ts has been updated successfully." },
          { type: "tool_result", tool_use_id: "cancel", is_error: true, content: "Interrupted by user" },
        ],
      },
    }),
  ].join("\n")
  const messages = parseTranscript(raw)
  assert.equal(messages.filter((m) => m.role === "user").length, 1, "enqueue + ordinary SDK user record is one prompt")
  const [grep, bash, edit, cancelled] = messages.flatMap((m) => m.tools)
  assert.equal(grep.detail, "FRAY_CLAUDE_RENDER_NEEDLE · /tmp/README.md")
  assert.equal(grep.output, "Found 1 file\nREADME.md")
  assert.equal(grep.status, "completed")
  assert.equal(grep.durationMs, 2000)
  assert.equal(bash.output, "FRAY_API_TOKEN=[redacted]\nok")
  assert.equal(bash.status, "completed")
  assert.equal(edit.status, "completed")
  assert.equal(edit.output, undefined, "successful edit acknowledgement is redundant with its diff")
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.output, "Interrupted by user")
})

test("a recorded Claude call without its result remains visibly pending", () => {
  const call = parseTranscript(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id: "still-running", name: "Monitor", input: { description: "Await CI" } }] },
    }),
  )[0].tools[0]
  assert.equal(call.status, "pending")
  assert.equal(call.detail, "Await CI")
})

test("Claude generic JSON inputs redact quoted secrets and harmless killed prose stays completed", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: {
        id: "m",
        content: [{ type: "tool_use", id: "generic", name: "Custom", input: { FRAY_API_TOKEN: "json-secret-value", Authorization: "Bearer top-secret-value" } }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "generic", content: "0 killed processes; all checks passed" }] },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "completed")
  assert.doesNotMatch(JSON.stringify(call), /json-secret|top-secret/)
})

// ---- screenshot / image tool results render inline (take_screenshot) ----
// A minimal valid 1×1 PNG — decodes to real bytes so the persisted file is a genuine image.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

test("a screenshot tool_result carrying a base64 image is decoded to a servable outputImage path", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id: "shot", name: "mcp__chrome-devtools__take_screenshot", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:00.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shot",
          content: [
            { type: "text", text: "Took a screenshot of the current page." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1 } },
          ],
        }],
      },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "completed")
  assert.ok(call.outputImage, "outputImage path is set")
  assert.match(call.outputImage!, /fray-tool-images[/\\][0-9a-f]{32}\.png$/)
  // The decoded file exists on disk with the exact source bytes, so /local-image can serve it.
  const bytes = readFileSync(call.outputImage!)
  assert.deepEqual(bytes, Buffer.from(PNG_1x1, "base64"))
  // Accompanying text still renders as the output pane.
  assert.match(call.output ?? "", /Took a screenshot/)
})

test("a failed screenshot tool_result does not persist an image", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id: "shot", name: "take_screenshot", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "shot", is_error: true, content: "Error: no page open" }],
      },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "failed")
  assert.equal(call.outputImage, undefined)
})

// `id` must be UNIQUE per test: the cache filename derives from the tool_use id, so reusing an id that a
// prior test persisted would (correctly) short-circuit via existsSync and return that earlier file.
function screenshotResult(id: string, mediaType: string, dataB64: string): string {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id, name: "take_screenshot", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: dataB64 } }] }],
      },
    }),
  ].join("\n")
}

test("an unrecognized image media type (svg) is never persisted or guessed as png", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64")
  const call = parseTranscript(screenshotResult("shot-svg", "image/svg+xml", svg))[0].tools[0]
  assert.equal(call.status, "completed")
  assert.equal(call.outputImage, undefined, "svg is skipped — no png-mislabeled file")
})

test("a base64 payload whose bytes are not the claimed image type is skipped (no broken img)", () => {
  const garbage = Buffer.from("this is not a png at all").toString("base64")
  const call = parseTranscript(screenshotResult("shot-garbage", "image/png", garbage))[0].tools[0]
  assert.equal(call.status, "completed")
  assert.equal(call.outputImage, undefined, "magic-byte mismatch → text fallback, not a broken image")
})

test("Claude command, description, and result projections redact CLI and URL credential syntax", () => {
  const fixtures = {
    user: "fixture-claude-user-credential",
    token: "fixture-claude-token-credential",
    encoded: "%66%69%78%74%75%72%65-claude-url-credential",
    result: "fixture-claude-result-credential",
  }
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: {
        id: "m",
        content: [{
          type: "tool_use",
          id: "bash-credentials",
          name: "Bash",
          input: {
            command: `curl -u alice:${fixtures.user} --api-key=${fixtures.token} https://bob:${fixtures.encoded}@example.test/private`,
            description: `Retry https://ops:${fixtures.token}@example.test`,
          },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-credentials",
          is_error: true,
          content: `failed --password '${fixtures.result}' at https://service:${fixtures.result}@example.test`,
        }],
      },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  const rendered = JSON.stringify(call)
  for (const fixture of Object.values(fixtures)) assert.equal(rendered.includes(fixture), false, fixture)
  assert.match(call.command ?? "", /curl -u alice:\[redacted\] --api-key=\[redacted\]/)
  assert.match(call.command ?? "", /https:\/\/bob:\[redacted\]@example\.test/)
  assert.match(call.desc ?? "", /https:\/\/ops:\[redacted\]@example\.test/)
  assert.match(call.output ?? "", /--password \[redacted\].*https:\/\/service:\[redacted\]@example\.test/)
})

// ---- readThreadTranscript: transcript_id honoring + GATED discovery fallback (session-transcript-drift) ----
// These exercise the real path resolution, which reads ~/.claude/projects/<cwdSlug>/<id>.jsonl. We use a
// unique throwaway cwdSlug under the real log root and clean it up, so the test is hermetic in practice.

const DGRACE_MS = 60_000
function txHarness() {
  const slug = `-tmp-fray-tx-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", slug)
  mkdirSync(logDir, { recursive: true })
  const store = createStorage(join(mkdtempSync(join(tmpdir(), "fray-tx-")), "ui.db"))
  const project = { cwdSlug: slug } as unknown as Project
  const writeJsonl = (id: string, lines: string[]) => writeFileSync(join(logDir, `${id}.jsonl`), lines.map((l) => l + "\n").join(""))
  const cleanup = () => { try { rmSync(logDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
  return { slug, logDir, store, project, writeJsonl, cleanup }
}
function txRow(over: Partial<SessionRow>): SessionRow {
  return { slug: "t", session_id: "sid", tmux_name: "fray-t", spawned_at: new Date().toISOString(), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null, ...over }
}
const USER_LINE = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-07-10T18:00:00.000Z", message: { role: "user", content: text } })

test("readThreadTranscript: honors a cached transcript_id over the pinned session_id", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ transcript_id: "forked-x" }))
    h.writeJsonl("forked-x", [USER_LINE("render me from the drifted file")])
    // NO sid.jsonl written — resolution must pick the transcript_id file.
    const msgs = readThreadTranscript(h.project, h.store, "t")
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].text, "render me from the drifted file")
  } finally {
    h.cleanup()
  }
})

test("readThreadTranscript: within the spin-up grace, an empty pinned render does NOT trigger a discovery scan", () => {
  const h = txHarness()
  try {
    // Fresh dispatch (spawned NOW) with no transcript yet, but a drifted file WITH the sentinel exists.
    h.store.upsertSession(txRow({ spawned_at: new Date().toISOString() }))
    h.writeJsonl("forked-y", [USER_LINE("Your scratchpad is `.fray/threads/sid/scratch.md`. TASK:\nhi")])
    const msgs = readThreadTranscript(h.project, h.store, "t")
    assert.deepEqual(msgs, [], "within grace the fallback is gated off — returns the empty pinned render")
  } finally {
    h.cleanup()
  }
})

test("readThreadTranscript: past grace, an empty pinned render discovers the drifted transcript by sentinel", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ spawned_at: new Date(Date.now() - (DGRACE_MS + 5000)).toISOString() }))
    h.writeJsonl("forked-z", [USER_LINE("scratchpad `.fray/threads/sid/scratch.md` — work it")])
    const msgs = readThreadTranscript(h.project, h.store, "t")
    assert.equal(msgs.length, 1)
    assert.ok(msgs[0].text.includes("work it"), "past grace the sentinel discovery re-links the drifted render")
  } finally {
    h.cleanup()
  }
})

// ---- turn-aligned transcript pagination ----
const projected = (role: "user" | "assistant", sourceId: string, text = sourceId, kind?: "event") => ({
  sourceId,
  role,
  text,
  tools: [],
  parts: [],
  ...(kind ? { kind } : {}),
})

test("pagination: an assistant anchor and a user anchor both step to the immediately previous user boundary", () => {
  const messages = [
    projected("user", "u0"),
    projected("assistant", "a0"),
    projected("assistant", "tool-event", "tool finished", "event"),
    projected("user", "u1"),
    projected("assistant", "a1"),
  ]
  assert.deepEqual(pageProjectedTranscript(messages, 4).messages.map((m) => m.sourceId), ["u1"])
  assert.deepEqual(pageProjectedTranscript(messages, 3).messages.map((m) => m.sourceId), ["u0", "a0", "tool-event"])
})

test("pagination: consecutive user messages remain distinct one-click turn boundaries", () => {
  const messages = [projected("user", "u0"), projected("user", "u1"), projected("assistant", "a1")]
  assert.deepEqual(pageProjectedTranscript(messages, 2).messages.map((m) => m.sourceId), ["u1"])
  assert.deepEqual(pageProjectedTranscript(messages, 1).messages.map((m) => m.sourceId), ["u0"])
})

test("pagination: tool/event-only spans stay attached to their opening user turn", () => {
  const messages = [
    projected("user", "u0"),
    projected("assistant", "tool-only", ""),
    projected("assistant", "event-1", "agent finished", "event"),
    projected("assistant", "event-2", "thought for 1m", "event"),
    projected("user", "u1"),
  ]
  assert.deepEqual(pageProjectedTranscript(messages, 4).messages.map((m) => m.sourceId), ["u0", "tool-only", "event-1", "event-2"])
})

test("pagination: no prior user loads all remaining projected history", () => {
  const messages = [projected("assistant", "old-event", "old", "event"), projected("assistant", "old-tool", "")]
  const page = pageProjectedTranscript(messages, messages.length)
  assert.equal(page.start, 0)
  assert.equal(page.reachedTurnBoundary, true)
  assert.deepEqual(page.messages.map((m) => m.sourceId), ["old-event", "old-tool"])
})

test("pagination: a huge prior turn uses explicit continuation chunks and eventually reaches its user", () => {
  const messages = [projected("user", "u0")]
  for (let i = 0; i < 205; i++) messages.push(projected("assistant", `e${i}`, "event", "event"))
  messages.push(projected("user", "u1"))
  let anchor = messages.length - 1
  let clicks = 0
  while (anchor > 0) {
    const page = pageProjectedTranscript(messages, anchor, { maxItems: 50, maxBytes: 64 * 1024 })
    clicks++
    assert.ok(page.messages.length <= 50)
    anchor = page.start
    if (page.reachedTurnBoundary) break
  }
  assert.equal(anchor, 0)
  assert.ok(clicks > 1)
})

test("pagination: repeated clicks walk exactly one user turn backward", () => {
  const messages = [
    projected("user", "u0"), projected("assistant", "a0"),
    projected("user", "u1"), projected("assistant", "a1"),
    projected("user", "u2"), projected("assistant", "a2"),
  ]
  const first = pageProjectedTranscript(messages, messages.length)
  const second = pageProjectedTranscript(messages, first.start)
  assert.deepEqual(first.messages.map((m) => m.sourceId), ["u2", "a2"])
  assert.deepEqual(second.messages.map((m) => m.sourceId), ["u1", "a1"])
})

test("pagination cursor survives restart-like replay and concurrent append, but rejects session replacement", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ runtime_generation: 4 }))
    const lines: string[] = []
    for (let i = 0; i < 155; i++) {
      lines.push(USER_LINE(`user-${i}`))
      lines.push(JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-10T18:00:01.000Z",
        message: { id: `a-${i}`, content: [{ type: "text", text: `assistant-${i}` }] },
      }))
    }
    h.writeJsonl("sid", lines)
    const latest = readLatestThreadTranscriptPage(h.project, h.store, "t")
    assert.equal(latest.messages.length, 300)
    assert.ok(latest.beforeCursor)

    const first = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    const replay = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    assert.deepEqual(replay.messages.map((m) => m.sourceId), first.messages.map((m) => m.sourceId), "stateless cursor replay survives a server restart")

    appendFileSync(join(h.logDir, "sid.jsonl"), USER_LINE("concurrent-tail") + "\n")
    const afterAppend = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    assert.deepEqual(afterAppend.messages.map((m) => m.sourceId), first.messages.map((m) => m.sourceId), "append after the cursor snapshot cannot shift its boundary")

    h.store.upsertSession(txRow({ runtime_generation: 5 }))
    assert.throws(
      () => readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!),
      /session was replaced/,
      "a new runtime generation invalidates a request issued by the old generation",
    )

    h.store.upsertSession(txRow({ session_id: "replacement", runtime_generation: 0 }))
    assert.throws(
      () => readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!),
      /session was replaced/,
    )
  } finally {
    h.cleanup()
  }
})
