import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createCodexBackend,
  parseCodexLine,
  codexSandbox,
  codexEffort,
  codexSessionSentinel,
  discoverCodexRollout,
  findRolloutById,
  ensureCwdTrusted,
} from "./codex.ts"
import { newTailState, applyEvent } from "../tailer.ts"
import type { NormalizedEvent } from "./types.ts"

// ---- REAL captured rollout fixtures (codex-cli 0.144.1, 2026-07-10) ----
// exec-two-turn: `codex exec --json` + `codex exec resume` — two turns in one rollout: turn 1 (done
// fence, 2 exec_command tools, final_answer), turn 2 (3 commentary agent_messages + 3 tools + an
// awaiting fence with a timer hint). tui-single-turn: an INTERACTIVE `codex` TUI session (source:"cli")
// — proves the TUI writes the SAME rollout schema as exec (the §6 interactive-parity risk, now closed).
const FIX_DIR = join(import.meta.dirname, "codex.fixtures")
const execTwoTurn = readFileSync(join(FIX_DIR, "exec-two-turn.jsonl"), "utf8")
const tuiSingleTurn = readFileSync(join(FIX_DIR, "tui-single-turn.jsonl"), "utf8")
const execLines = execTwoTurn.split("\n").filter((l) => l.trim())

// Fold a whole rollout string into a fresh accumulator via the backend's authoritative foldLine.
function foldAll(text: string) {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  for (const line of text.split("\n")) backend.foldLine(state, line)
  return state
}
// Every NormalizedEvent parseCodexLine emits across a rollout, flattened (fixture-grounded totals).
function allEvents(text: string): NormalizedEvent[] {
  return text
    .split("\n")
    .flatMap((l) => parseCodexLine(l))
}
// The first fixture line of a given rollout record type (+ optional event-payload subtype).
function firstLineOf(pred: (rec: any) => boolean): string {
  for (const l of execLines) {
    try {
      if (pred(JSON.parse(l))) return l
    } catch {}
  }
  throw new Error("no fixture line matched")
}

// ==== parseCodexLine — the rollout → NormalizedEvent mapping, asserted on REAL fixture lines ====

test("parseCodexLine: a malformed / non-object / blank / payload-less line yields no events", () => {
  assert.deepEqual(parseCodexLine("{not json"), [])
  assert.deepEqual(parseCodexLine(""), [])
  assert.deepEqual(parseCodexLine("   "), [])
  assert.deepEqual(parseCodexLine("42"), [])
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg" })), []) // no payload
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })), [])
})

test("parseCodexLine: event_msg/task_started → a single turn-start (carries the line timestamp)", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "task_started")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "turn-start")
  assert.equal(typeof (evs[0] as any).at, "string")
})

test("parseCodexLine: event_msg/task_complete → turn-end carrying last_agent_message as finalText", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "task_complete")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "turn-end")
  // Turn 1's final message carries the done fence verbatim.
  assert.match((evs[0] as any).finalText, /```done\nall-good\n```/)
})

test("parseCodexLine: event_msg/agent_message final_answer → assistant-text{final:true}; text from .message", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "agent_message" && r.payload?.phase === "final_answer")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.deepEqual({ kind: evs[0].kind, final: (evs[0] as any).final }, { kind: "assistant-text", final: true })
  assert.match((evs[0] as any).text, /```done\nall-good\n```/)
})

test("parseCodexLine: event_msg/agent_message commentary → assistant-text{final:false} (never the answer)", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "agent_message" && r.payload?.phase === "commentary")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "assistant-text")
  assert.equal((evs[0] as any).final, false)
})

test("parseCodexLine: event_msg/user_message → a genuine (non-synthetic) user-message with .message text", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "user_message")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "user-message")
  assert.equal((evs[0] as any).synthetic, false)
  assert.match((evs[0] as any).text, /FRAY-SENTINEL/) // the real first prompt carried a sentinel
})

test("parseCodexLine: response_item/function_call → tool-call with call_id + JSON-parsed arguments", () => {
  const line = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "function_call")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-call")
  assert.equal(ev.name, "exec_command")
  assert.ok(ev.id.startsWith("call_"))
  assert.equal(typeof ev.input, "object") // arguments JSON string parsed to an object
  assert.equal(ev.input.cmd, "cat hello.txt")
})

test("parseCodexLine: response_item/function_call_output → tool-result with call_id + output text", () => {
  const line = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "function_call_output")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-result")
  assert.ok(ev.id.startsWith("call_"))
  assert.match(ev.text, /test file/)
})

test("parseCodexLine: response_item/custom_tool_call (apply_patch) → tool-call carrying the raw patch STRING input", () => {
  // Codex delivers file edits (apply_patch) as a custom_tool_call whose .input is the V4A patch string,
  // NOT a function_call with JSON arguments. Missing this dropped every codex edit from the fold + drawer.
  const line = JSON.stringify({
    timestamp: "2026-07-11T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: "call_abc",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n",
    },
  })
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-call")
  assert.equal(ev.name, "apply_patch")
  assert.equal(ev.id, "call_abc")
  assert.equal(typeof ev.input, "string")
  assert.match(ev.input, /Begin Patch/)
})

test("parseCodexLine: response_item/custom_tool_call_output → tool-result with call_id + output text", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-11T00:00:00.000Z",
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "call_abc", output: "Success. Updated the following files:\nM a.txt\n" },
  })
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-result")
  assert.equal(ev.id, "call_abc")
  assert.match(ev.text, /Success/)
})

test("parseCodexLine: NO DOUBLE COUNT — response_item/message (the assistant/prompt echo) yields nothing", () => {
  const asstEcho = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "assistant")
  const userEcho = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "user")
  assert.deepEqual(parseCodexLine(asstEcho), [])
  assert.deepEqual(parseCodexLine(userEcho), [])
})

test("parseCodexLine: sidecar records (session_meta, turn_context, world_state, reasoning) yield nothing", () => {
  for (const type of ["session_meta", "turn_context", "world_state"]) {
    const line = firstLineOf((r) => r.type === type)
    assert.deepEqual(parseCodexLine(line), [], `${type} should be skipped`)
  }
  const reasoning = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "reasoning")
  assert.deepEqual(parseCodexLine(reasoning), [])
})

// ==== event totals across the whole real fixture (the no-double-count invariant, quantified) ====

test("parseCodexLine over the full 2-turn fixture: event counts match the raw record counts exactly", () => {
  const evs = allEvents(execTwoTurn)
  const count = (k: NormalizedEvent["kind"]) => evs.filter((e) => e.kind === k).length
  // 2 task_started / 2 task_complete brackets; the 5 agent_messages (2 final + 3 commentary) become 5
  // assistant-texts (NOT 10 — the 5 response_item/message duplicates are dropped); 5 exec tools.
  assert.equal(count("turn-start"), 2)
  assert.equal(count("turn-end"), 2)
  assert.equal(count("assistant-text"), 5)
  assert.equal(count("tool-call"), 5)
  assert.equal(count("tool-result"), 5)
  assert.equal(count("user-message"), 2)
  // exactly one final answer per turn
  assert.equal(evs.filter((e) => e.kind === "assistant-text" && (e as any).final).length, 2)
})

// ==== foldLine — the AUTHORITATIVE fold drives FoldState (codex turn-read flows in correctly) ====

test("foldLine: task_started flips the fold IN-FLIGHT, task_complete brackets it IDLE (codex turn-read)", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, firstLineOf((r) => r.payload?.type === "task_started"))
  assert.equal(state.turn, "in-flight")
  backend.foldLine(state, firstLineOf((r) => r.payload?.type === "task_complete"))
  assert.equal(state.turn, "idle")
})

test("foldLine: folding the whole 2-turn fixture lands idle with the LAST turn's awaiting+timer fence", () => {
  const state = foldAll(execTwoTurn)
  assert.equal(state.turn, "idle")
  assert.ok(state.sawRecords)
  // Turn 2's final message ends in ```awaiting / timer: 5m ``` → the excusal fence + parsed hint.
  assert.equal(state.lastFence?.kind, "awaiting")
  assert.deepEqual(state.lastFence?.hints, [{ kind: "timer", value: "5m" }])
  // Preview reflects the final answer, not a commentary line.
  assert.match(state.lastAssistant ?? "", /1 line/)
  // The genuine human turns bumped the row-order key.
  assert.equal(typeof state.lastUserAt, "string")
})

test("foldLine: after only turn 1 (through its task_complete) the fence is the ```done excusal", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  for (const l of execLines) {
    backend.foldLine(state, l)
    if (JSON.parse(l).payload?.type === "task_complete") break // stop at end of turn 1
  }
  assert.equal(state.turn, "idle")
  assert.equal(state.lastFence?.kind, "done")
  assert.equal(state.lastFence?.body, "all-good")
})

test("foldLine: a commentary agent_message refreshes the preview but carries NO fence", () => {
  // A quoted excusal fence inside a COMMENTARY message must never excuse the thread.
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, JSON.stringify({ type: "event_msg", timestamp: "2026-07-01T00:00:00.000Z", payload: { type: "task_started" } }))
  backend.foldLine(state, JSON.stringify({ type: "event_msg", timestamp: "2026-07-01T00:00:01.000Z", payload: { type: "agent_message", phase: "commentary", message: "working on it\n\n```done\nnope\n```" } }))
  assert.equal(state.turn, "in-flight")
  assert.equal(state.lastFence, undefined) // commentary never sets the excusal fence
  assert.match(state.lastAssistant ?? "", /working on it/)
})

test("foldLine: codex folds NO sub-agents / bg-shells / pending-ask (Claude-only surfaces stay empty)", () => {
  const state = foldAll(execTwoTurn)
  assert.equal(state.subAgents.size, 0)
  assert.equal(state.retiredSubAgents.size, 0)
  assert.equal(state.pendingAsk, undefined)
})

test("foldLine: the INTERACTIVE TUI rollout folds identically (source:\"cli\" parity) — idle + done fence", () => {
  const state = foldAll(tuiSingleTurn)
  assert.equal(state.turn, "idle")
  assert.equal(state.lastFence?.kind, "done")
  assert.equal(state.lastFence?.body, "tui-ok")
})

test("foldLine agrees with applyEvent(parseCodexLine): foldLine IS parseLine→applyEvent", () => {
  // Independently drive the events through applyEvent and assert the same terminal state.
  const backend = createCodexBackend()
  const a = newTailState("t", "s", "/x")
  const b = newTailState("t", "s", "/x")
  for (const l of execTwoTurn.split("\n")) {
    backend.foldLine(a, l)
    for (const ev of parseCodexLine(l)) applyEvent(b, ev)
  }
  assert.equal(a.turn, b.turn)
  assert.deepEqual(a.lastFence, b.lastFence)
  assert.equal(a.lastAssistant, b.lastAssistant)
  assert.equal(a.lastUserAt, b.lastUserAt)
})

// ==== spawn / resume argv ====

test("createCodexBackend: buildSpawn maps cwd/model/sandbox/effort and prompts with contract + sentinel", () => {
  const backend = createCodexBackend({ codexBin: "codex" })
  const { argv, env, prewrite } = backend.buildSpawn({
    sessionId: "disp-1",
    cwd: "/repo",
    prompt: "do the task",
    workerContract: "CONTRACT",
    extraSystemPrompt: "SCRATCHPAD: /tmp/x",
    permissionMode: "acceptEdits",
    model: "gpt-5.5",
    effort: "high",
  })
  assert.equal(argv[0], "codex")
  assert.deepEqual(argv.slice(1, 5), ["--cd", "/repo", "-m", "gpt-5.5"])
  assert.ok(argv.includes("-s") && argv.includes("workspace-write"))
  assert.deepEqual([argv[argv.indexOf("-a")], argv[argv.indexOf("-a") + 1]], ["-a", "never"]) // never blocks
  assert.ok(argv.includes("-c") && argv.includes('model_reasoning_effort="high"'))
  const prompt = argv[argv.length - 1]
  assert.match(prompt, /^CONTRACT\n\nSCRATCHPAD: \/tmp\/x\n\ndo the task/) // contract + orientation prepended
  assert.match(prompt, new RegExp(codexSessionSentinel("disp-1"))) // discovery sentinel embedded
  assert.deepEqual(env, {})
  assert.deepEqual(prewrite, []) // no AGENTS.md written — contract rides the prompt (see report)
})

test("createCodexBackend: buildSpawn plan mode → read-only sandbox; unset model/effort omit their flags", () => {
  const { argv } = createCodexBackend().buildSpawn({ sessionId: "d", cwd: "/r", prompt: "p", workerContract: "", permissionMode: "plan" })
  assert.ok(argv.includes("read-only"))
  assert.ok(!argv.includes("-m"))
  assert.ok(!argv.includes("-c")) // no effort → no model_reasoning_effort override
})

test("createCodexBackend: buildResume → `codex resume <id> <message>` with orientation prepended, never blocks", () => {
  const { argv, prewrite } = createCodexBackend({ codexBin: "codex" }).buildResume({
    sessionId: "codex-rollout-id",
    cwd: "/repo",
    message: "keep going",
    workerContract: "CONTRACT",
    extraSystemPrompt: "SCRATCHPAD: /tmp/x",
    permissionMode: "acceptEdits",
  })
  assert.deepEqual(argv.slice(0, 2), ["codex", "resume"])
  assert.equal(argv[argv.length - 2], "codex-rollout-id") // pinned discovered id, then the message
  assert.equal(argv[argv.length - 1], "SCRATCHPAD: /tmp/x\n\nkeep going")
  assert.ok(argv.includes("-a") && argv.includes("never"))
  assert.deepEqual(prewrite, [])
})

// ==== effort / sandbox mappings ====

test("codexEffort: passes through codex values, clamps xhigh/max → high, unknown → undefined", () => {
  assert.equal(codexEffort("low"), "low")
  assert.equal(codexEffort("medium"), "medium")
  assert.equal(codexEffort("high"), "high")
  assert.equal(codexEffort("xhigh"), "high")
  assert.equal(codexEffort("max"), "high")
  assert.equal(codexEffort(undefined), undefined)
  assert.equal(codexEffort("bogus"), undefined)
})

test("codexSandbox: plan→read-only, bypassPermissions→danger-full-access, else→workspace-write", () => {
  assert.equal(codexSandbox("plan"), "read-only")
  assert.equal(codexSandbox("bypassPermissions"), "danger-full-access")
  assert.equal(codexSandbox("acceptEdits"), "workspace-write")
  assert.equal(codexSandbox("auto"), "workspace-write")
  assert.equal(codexSandbox("default"), "workspace-write")
})

// ==== transcript discovery (the §6 session-id race) ====

// Build a temp $CODEX_HOME with a date-sharded rollout for a given id, cwd, and embedded sentinel.
function writeRollout(codexHome: string, id: string, cwd: string, sentinel: string): string {
  const dir = join(codexHome, "sessions", "2026", "07", "10")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-07-10T00-00-00-${id}.jsonl`)
  writeFileSync(
    path,
    [
      JSON.stringify({ timestamp: "2026-07-10T00:00:00.000Z", type: "session_meta", payload: { session_id: id, cwd } }),
      JSON.stringify({ timestamp: "2026-07-10T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: `task <!-- ${sentinel} --> more` } }),
    ].join("\n") + "\n",
  )
  return path
}

test("discoverCodexRollout: the SENTINEL disambiguates concurrent same-cwd dispatches (race-proof)", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    // Two sessions, SAME cwd (the race), each with its own dispatch sentinel.
    writeRollout(home, "AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/repo/shared", codexSessionSentinel("disp-A"))
    const pB = writeRollout(home, "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "/repo/shared", codexSessionSentinel("disp-B"))
    const got = discoverCodexRollout({ cwd: "/repo/shared", spawnedAtMs: Date.now() - 1000, sentinel: codexSessionSentinel("disp-B"), codexHome: home })
    assert.equal(got?.sessionId, "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    assert.equal(got?.path, pB)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("discoverCodexRollout: without a sentinel, matches by session_meta.cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    writeRollout(home, "CCCCCCCC-cccc-cccc-cccc-cccccccccccc", "/repo/other", codexSessionSentinel("disp-C"))
    const pD = writeRollout(home, "DDDDDDDD-dddd-dddd-dddd-dddddddddddd", "/repo/target", codexSessionSentinel("disp-D"))
    const got = discoverCodexRollout({ cwd: "/repo/target", spawnedAtMs: Date.now() - 1000, codexHome: home })
    assert.equal(got?.path, pD)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("discoverCodexRollout: a rollout older than the spawn window is ignored; none matched → undefined", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    writeRollout(home, "EEEEEEEE-eeee-eeee-eeee-eeeeeeeeeeee", "/repo/z", codexSessionSentinel("disp-E"))
    // spawnedAtMs far in the FUTURE → every existing rollout is "older than spawn" → no match.
    const got = discoverCodexRollout({ cwd: "/repo/z", spawnedAtMs: Date.now() + 60_000, codexHome: home })
    assert.equal(got, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Write a rollout at an ARBITRARY date-shard (or flat, shard="") to exercise the multi-shard,
// newest-date-shard-first traversal + the flat-legacy path.
function writeRolloutAt(codexHome: string, shard: string, id: string, cwd: string): string {
  const dir = shard ? join(codexHome, "sessions", ...shard.split("/")) : join(codexHome, "sessions")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-${shard.replace(/\//g, "-") || "flat"}-${id}.jsonl`)
  writeFileSync(path, JSON.stringify({ timestamp: "x", type: "session_meta", payload: { session_id: id, cwd } }) + "\n")
  return path
}

test("discovery traverses across date shards + flat legacy files, newest-mtime wins (fix: newest-first)", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    // A flat legacy file and an old date shard, then the NEWEST shard written LAST (freshest mtime).
    writeRolloutAt(home, "", "11111111-1111-1111-1111-111111111111", "/repo/multi")
    writeRolloutAt(home, "2025/01/01", "22222222-2222-2222-2222-222222222222", "/repo/multi")
    const newest = writeRolloutAt(home, "2026/07/10", "33333333-3333-3333-3333-333333333333", "/repo/multi")
    // cwd fallback returns the newest-mtime match regardless of which shard/flat dir it lives in.
    const got = discoverCodexRollout({ cwd: "/repo/multi", spawnedAtMs: Date.now() - 1000, codexHome: home })
    assert.equal(got?.path, newest)
    // and every one is still locatable by id (traversal reaches all shards + flat).
    assert.ok(findRolloutById("22222222-2222-2222-2222-222222222222", home))
    assert.ok(findRolloutById("11111111-1111-1111-1111-111111111111", home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("findRolloutById / transcriptPath: locate a rollout by its codex id suffix", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    const p = writeRollout(home, "FFFFFFFF-ffff-ffff-ffff-ffffffffffff", "/repo/w", codexSessionSentinel("disp-F"))
    assert.equal(findRolloutById("FFFFFFFF-ffff-ffff-ffff-ffffffffffff", home), p)
    assert.equal(findRolloutById("does-not-exist", home), undefined)
    const backend = createCodexBackend({ codexHome: home })
    assert.equal(backend.transcriptPath("FFFFFFFF-ffff-ffff-ffff-ffffffffffff"), p)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ==== trust-gate pre-arm ====

test("ensureCwdTrusted: idempotently appends a trusted [projects.<cwd>] block; never duplicates/overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    ensureCwdTrusted("/repo/proj", home)
    const cfg1 = readFileSync(join(home, "config.toml"), "utf8")
    assert.match(cfg1, /\[projects\."\/repo\/proj"\]\ntrust_level = "trusted"/)
    // second call: no-op (block already present) — exactly one occurrence.
    ensureCwdTrusted("/repo/proj", home)
    const cfg2 = readFileSync(join(home, "config.toml"), "utf8")
    assert.equal(cfg2.match(/\[projects\."\/repo\/proj"\]/g)?.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("ensureCwdTrusted: respects an EXISTING project block (does not override the user's trust choice)", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    const cfgPath = join(home, "config.toml")
    writeFileSync(cfgPath, `[projects."/repo/keep"]\ntrust_level = "untrusted"\n`)
    ensureCwdTrusted("/repo/keep", home)
    const cfg = readFileSync(cfgPath, "utf8")
    assert.match(cfg, /trust_level = "untrusted"/) // left as-is
    assert.doesNotMatch(cfg, /trust_level = "trusted"/) // NOT appended
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
