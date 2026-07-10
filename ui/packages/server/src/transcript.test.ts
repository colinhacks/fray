import { test } from "node:test"
import assert from "node:assert/strict"
import { parseTranscript } from "./transcript.ts"

// Build a minimal assistant JSONL record carrying one tool_use block.
function toolLine(name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", name, input }] },
  })
}

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

test("Agent completion → inline event line + back-filled terminal state", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "Do the thing", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:35:00.000Z"),
    ].join("\n"),
  )
  const event = msgs.find((m) => m.kind === "event")
  assert.ok(event, "an event message is emitted at the notification's position")
  assert.equal(event!.text, 'Agent "Do the thing" finished — 35m')
  // the dispatch card is back-filled with the outcome
  const call = msgs[0].tools[0]
  assert.equal(call.agentStatus, "completed")
  assert.equal(call.agentElapsedMs, 35 * 60_000)
})

test("failed sub-agent → 'failed after' event; a background-bash notification is ignored", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "X", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_bash", "completed", "2026-07-01T00:05:00.000Z"), // not a tracked Agent id
      taskNotification("toolu_a", "failed", "2026-07-01T00:12:00.000Z"),
    ].join("\n"),
  )
  const events = msgs.filter((m) => m.kind === "event")
  assert.equal(events.length, 1, "only the tracked Agent id emits; the background-bash id is ignored")
  assert.equal(events[0].text, 'Agent "X" failed after 12m')
})

test("a duplicate terminal notification emits the event only once", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "X", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:10:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:10:00.000Z"),
    ].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.kind === "event").length, 1)
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
