import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createCodexBackend,
  parseCodexLine,
  parseCodexSessionProfile,
  codexSandbox,
  codexEffort,
  codexSessionSentinel,
  discoverCodexRollout,
  findRolloutById,
  ensureCwdTrusted,
  detectCodexNativeInput,
  FRAY_UI_MAX_CONCURRENT_THREADS,
  FRAY_UI_MULTI_AGENT_V2_CONFIG,
  FRAY_UI_DISABLED_SKILLS_CONFIG,
  FRAY_CODEX_OUTPUT_DEFAULTS,
  CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS,
  extractCodexFrayTitle,
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
const execWrapperCommonTools = readFileSync(join(FIX_DIR, "exec-wrapper-common-tools.jsonl"), "utf8")
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

test("codex spawn/resume inject the spawn-thread MCP server as additive -c overrides (TOML-quoted)", () => {
  const backend = createCodexBackend()
  const mcp = { scriptPath: '/abs/plug in/bin/spawn-thread-mcp.mjs', stateDir: "/home/.fray/projects/pid" }
  const base = { sessionId: "sid", cwd: "/repo", workerContract: "c", permissionMode: "default" as const, spawnThreadMcp: mcp }
  const spawn = backend.buildSpawn({ ...base, prompt: "hi" }).argv
  const resume = backend.buildResume({ ...base, message: "go" }).argv
  for (const [label, argv] of [["spawn", spawn], ["resume", resume]] as const) {
    // Each -c flag is its own argv pair; find the mcp_servers assignments (execvp passes them literally).
    const cVals = argv.map((a, i) => (a === "-c" ? argv[i + 1] : null)).filter(Boolean) as string[]
    assert.ok(cVals.includes(`mcp_servers.fray_spawn.command="${process.execPath}"`), `${label}: command flag`)
    // Path with a space stays a valid TOML basic string inside the array value.
    assert.ok(cVals.includes('mcp_servers.fray_spawn.args=["/abs/plug in/bin/spawn-thread-mcp.mjs"]'), `${label}: args flag`)
    assert.ok(cVals.includes('mcp_servers.fray_spawn.env={FRAY_STATE_DIR="/home/.fray/projects/pid"}'), `${label}: env flag`)
  }
})

test("codex spawn omits the spawn-thread MCP flags when no descriptor is supplied", () => {
  const argv = createCodexBackend().buildSpawn({ sessionId: "sid", cwd: "/repo", prompt: "hi", workerContract: "c", permissionMode: "default" }).argv
  assert.ok(!argv.some((a) => typeof a === "string" && a.startsWith("mcp_servers.fray_spawn")))
})

// ==== native TUI modal detection (real Codex 0.144.1 chrome, pane-only) ====

const githubApprovalPane = `
  Field 1/1
  Allow GitHub to create a Git blob?

  Repository: nubjs/nub
  Content: secret-content-that-must-never-cross-the-wire
  encoding: base64

  › 1. Allow                   Run the tool and continue.
    2. Allow for this session  Allow this tool for the rest of the session.
    3. Always allow            Always allow this tool.
    4. Cancel                  Cancel this tool call.
  enter to submit | esc to cancel
`

test("detectCodexNativeInput: captured GitHub tool approval emits only a fixed safe kind/title", () => {
  const found = detectCodexNativeInput(githubApprovalPane)
  assert.deepEqual(found, { kind: "tool-approval", title: "GitHub tool approval required" })
  const serialized = JSON.stringify(found)
  assert.doesNotMatch(serialized, /nubjs|secret-content|base64|Always allow/)
})

test("detectCodexNativeInput: unsafe tool question text is never copied into telemetry", () => {
  const pane = githubApprovalPane
    .replace("Allow GitHub to create a Git blob?", "Allow SecretConnector to expose sk-live-do-not-leak?")
  assert.deepEqual(detectCodexNativeInput(pane), { kind: "tool-approval", title: "Tool approval required" })
  assert.doesNotMatch(JSON.stringify(detectCodexNativeInput(pane)), /SecretConnector|sk-live/)
})

test("detectCodexNativeInput: verified permission menus and generic field selectors are classified", () => {
  assert.deepEqual(
    detectCodexNativeInput(
      "Update Model Permissions\n› 1. Ask for approval\n  2. Approve for me\n  3. Full Access\nPress enter to confirm or esc to go back",
    ),
    { kind: "permission", title: "Choose model permissions" },
  )
  assert.deepEqual(
    detectCodexNativeInput(
      "Enable full access?\n› 1. Yes, continue anyway\n  2. Yes, and don't ask again\n  3. Cancel\nPress enter to confirm or esc to go back",
    ),
    { kind: "permission", title: "Confirm full access" },
  )
  assert.deepEqual(
    detectCodexNativeInput("Field 1/1\nChoose a target\n› 1. Current target\n  2. New target\n  3. Cancel\nenter to submit | esc to cancel"),
    { kind: "selection", title: "Terminal choice required" },
  )
  assert.deepEqual(
    detectCodexNativeInput("Field 1/1\nContinue?\n› 1. Yes\n  2. No\n  3. Cancel\nenter to submit | esc to cancel"),
    { kind: "confirmation", title: "Confirmation required" },
  )
})

test("detectCodexNativeInput: normal activity and prompt-like transcript prose do not trigger", () => {
  assert.equal(
    detectCodexNativeInput("Working on it…\n\n› Add tests\n\n  gpt-5.6 high · 97% left · esc to interrupt"),
    undefined,
  )
  // Even an exact-looking block in scrollback is inert once the real Codex composer/status chrome is
  // below it. Detection is anchored to the final nonblank line, never a global prose search.
  assert.equal(
    detectCodexNativeInput(`${githubApprovalPane}\n\n› Describe what you want changed\n\n  ? for shortcuts`),
    undefined,
  )
  // A submit footer alone, arbitrary numbered prose, or an unverified modal family fails closed.
  assert.equal(detectCodexNativeInput("1. one\n2. two\nenter to submit | esc to cancel"), undefined)
})

// ==== parseCodexLine — the rollout → NormalizedEvent mapping, asserted on REAL fixture lines ====

test("extractCodexFrayTitle: first-line attribute comment is primary; H1 and legacy comments remain compatible", () => {
  assert.deepEqual(
    extractCodexFrayTitle('<!-- fray title="Fix queue focus" -->\nVisible answer'),
    { markerFound: true, title: "Fix queue focus", text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrayTitle('<!-- fray title="Fix &quot;queue&quot; \\&quot;focus\\&quot;" -->\nVisible answer'),
    { markerFound: true, title: 'Fix "queue" "focus"', text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrayTitle("# Fix queue focus\nVisible answer"),
    { markerFound: true, title: "Fix queue focus", text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrayTitle("<!-- fray-title: Fix queue focus -->\nVisible answer"),
    { markerFound: true, title: "Fix queue focus", text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrayTitle("<!-- fray-title: Fix\tqueue\u202e focus -->\r\nVisible"),
    { markerFound: true, title: "Fix queue focus", text: "Visible" },
  )
  assert.equal(extractCodexFrayTitle(`<!-- fray-title: ${"x".repeat(240)} -->\nBody`).title?.length, 200)
  assert.deepEqual(
    extractCodexFrayTitle("<!-- fray-title: <unsafe> -->\nBody"),
    { markerFound: true, text: "Body" },
  )
  const quoted = "Answer first\n<!-- fray title=\"Quoted example\" -->"
  assert.deepEqual(extractCodexFrayTitle(quoted), { markerFound: false, text: quoted })
  const ordinaryComment = "<!-- fray title=unquoted -->\nBody"
  assert.deepEqual(extractCodexFrayTitle(ordinaryComment), { markerFound: false, text: ordinaryComment })
  const malformed = "<!-- fray-title:Missing space -->\nBody"
  assert.deepEqual(extractCodexFrayTitle(malformed), { markerFound: false, text: malformed })
  for (const malformedH1 of ["## Too deep\nBody", "#No space\nBody", " # Indented\nBody"]) {
    assert.deepEqual(extractCodexFrayTitle(malformedH1), { markerFound: false, text: malformedH1 })
  }
  assert.deepEqual(
    extractCodexFrayTitle("# H1 wins\n<!-- fray-title: Legacy loses -->\nBody"),
    { markerFound: true, title: "H1 wins", text: "Body" },
    "legacy H1 precedence keeps the prior compatibility pair hidden",
  )
})

test("extractCodexFrayTitle: strips every Bidi_Control and unsafe default-ignorable character", () => {
  // Full Unicode Bidi_Control set: ALM, LRM/RLM, embeddings/overrides, and isolates.
  const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
  // Representative non-semantic Default_Ignorable_Code_Point values, including the reported U+200B.
  const invisibleControls = "\u00ad\u034f\u180e\u200b\u2060\ufeff"
  assert.deepEqual(
    extractCodexFrayTitle(`<!-- fray-title: Fix${bidiControls}${invisibleControls} queue -->\nBody`),
    { markerFound: true, title: "Fix queue", text: "Body" },
  )
  assert.deepEqual(
    extractCodexFrayTitle(`<!-- fray-title: ${bidiControls}${invisibleControls} -->\nBody`),
    { markerFound: true, text: "Body" },
    "an all-invisible candidate is stripped but never persisted as a title",
  )
})

test("extractCodexFrayTitle: preserves emoji and language-shaping default ignorables", () => {
  const englandFlag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"
  const title = `Ship 👩🏽‍💻 and ❤️‍🔥 ${englandFlag} alerts with می‌خواهم, ᠠ\u180b, and 漢\u{e0100}`
  assert.deepEqual(
    extractCodexFrayTitle(`<!-- fray-title: ${title} -->\nBody`),
    { markerFound: true, title, text: "Body" },
    "ZWJ, ZWNJ, variation selectors, and complete emoji tag sequences carry visible semantics",
  )
  assert.equal(
    extractCodexFrayTitle("<!-- fray-title: Fix\u{e0061} queue -->\nBody").title,
    "Fix queue",
    "a free-standing invisible tag is not an emoji and is stripped",
  )
})

test("extractCodexFrayTitle: preserves Indic virama sequences before ZWJ and ZWNJ", () => {
  for (const title of ["क्‍ष परीक्षण", "क्‌ष परीक्षण", "á‍b check"]) {
    assert.deepEqual(
      extractCodexFrayTitle(`<!-- fray-title: ${title} -->\nBody`),
      { markerFound: true, title, text: "Body" },
    )
  }
})

test("extractCodexFrayTitle: joiners and selectors cannot form invisible or orphan titles", () => {
  const invisibleOnly = [
    "\u200d", // ZWJ
    "\u200c", // ZWNJ
    "\ufe0f", // VS16
    "\u180b", // Mongolian FVS1
    "\u{e0100}", // supplementary VS
    "\u0301", // a combining mark is not a visible base by itself
  ]
  for (const invisible of invisibleOnly) {
    assert.deepEqual(
      extractCodexFrayTitle(`<!-- fray-title: ${invisible} -->\nBody`),
      { markerFound: true, text: "Body" },
    )
  }
  const orphanCases = [
    "\u200dFix", "Fix\u200d",
    "\u200cFix", "Fix\u200c",
    "\ufe0fFix", "Fix \ufe0f",
    "\u180bFix", "Fix \u180b",
    "\u{e0100}Fix", "Fix \u{e0100}",
    "\u{e0061}Fix", "Fix\u{e0061}",
  ]
  for (const candidate of orphanCases) {
    assert.equal(
      extractCodexFrayTitle(`<!-- fray-title: ${candidate} -->\nBody`).title,
      "Fix",
      "leading/trailing joiners, selectors, and free-standing tags are stripped",
    )
  }
})

test("extractCodexFrayTitle: the 200-code-point cap stops at a complete emoji grapheme", () => {
  const prefix = "x".repeat(198)
  const emoji = "👩🏽‍💻" // four code points and one extended grapheme
  const signal = extractCodexFrayTitle(`<!-- fray-title: ${prefix}${emoji}tail -->\nBody`)
  assert.equal(signal.title, prefix)
  assert.equal(Array.from(signal.title ?? "").length, 198)
  assert.doesNotMatch(signal.title ?? "", /\u200d|�/, "the cap cannot retain a dangling joiner or surrogate")

  const persianBoundary = extractCodexFrayTitle(`<!-- fray-title: ${"x".repeat(198)}ی‌خ -->\nBody`).title ?? ""
  assert.ok(Array.from(persianBoundary).length <= 200)
  assert.doesNotMatch(persianBoundary, /\u200c$/, "post-cap validation cannot leave a trailing ZWNJ")
})

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

test("parseCodexLine: unified custom-tool content blocks flatten to ordered text, not JSON plumbing", () => {
  const line = execWrapperCommonTools
    .split("\n")
    .find((raw) => {
      const rec = JSON.parse(raw)
      return rec.payload?.type === "custom_tool_call_output" && rec.payload?.call_id === "call_fail"
    })
  assert.ok(line)
  const ev = parseCodexLine(line)[0] as Extract<NormalizedEvent, { kind: "tool-result" }>
  assert.equal(ev.kind, "tool-result")
  assert.match(ev.text, /^Script completed/)
  assert.match(ev.text, /"exit_code":7/)
  assert.doesNotMatch(ev.text, /"type":"input_text"/)
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
  // The captured reasoning records are encryption-only (summary: []) → no reasoning event: the raw
  // encrypted CoT is never surfaced. A summary-BEARING reasoning record is covered separately below.
  const reasoning = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "reasoning")
  assert.deepEqual(parseCodexLine(reasoning), [])
})

test("parseCodexLine: response_item/reasoning WITH summary[] → one reasoning event joining the summary_text items", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-15T14:42:06.000Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      encrypted_content: "gAAAAAB-opaque-blob",
      summary: [
        { type: "summary_text", text: "**Checking the config**" },
        { type: "summary_text", text: "The user wants X, so I'll read Y first." },
      ],
    },
  })
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "reasoning")
  assert.equal(ev.at, "2026-07-15T14:42:06.000Z")
  // summary_text items join with a blank line; the encrypted CoT never leaks into the text.
  assert.equal(ev.text, "**Checking the config**\n\nThe user wants X, so I'll read Y first.")
  assert.ok(!ev.text.includes("gAAAA"))
})

test("parseCodexLine: reasoning with an empty / whitespace-only / absent summary → no event (encryption-only)", () => {
  const mk = (summary: unknown) => JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary } })
  assert.deepEqual(parseCodexLine(mk([])), [])
  assert.deepEqual(parseCodexLine(mk([{ type: "summary_text", text: "   " }])), [])
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })), [])
})

test("parseCodexSessionProfile: turn_context exposes the actual model/effort without rendering an event", () => {
  const line = firstLineOf((r) => r.type === "turn_context")
  assert.deepEqual(parseCodexSessionProfile(line), {
    model: "gpt-5.5",
    effort: "high",
    profileAt: "2026-07-10T21:58:44.858Z",
    permissionMode: "bypassPermissions",
    permissionModeAt: "2026-07-10T21:58:44.858Z",
  })
  assert.deepEqual(parseCodexLine(line), [], "profile telemetry stays out of the conversation event stream")
  assert.equal(parseCodexSessionProfile("{not json"), undefined)
})

test("parseCodexSessionProfile: thread_settings_applied maps verified Codex permission telemetry", () => {
  const settings = (thread_settings: object) =>
    JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings } })
  assert.equal(
    parseCodexSessionProfile(settings({ permission_profile: { type: "managed" }, active_permission_profile: { id: ":workspace" } }))?.permissionMode,
    "default",
  )
  assert.equal(
    parseCodexSessionProfile(settings({ permission_profile: { type: "disabled" }, active_permission_profile: { id: ":danger-full-access" } }))?.permissionMode,
    "bypassPermissions",
  )
  assert.equal(parseCodexSessionProfile(JSON.stringify({ type: "turn_context", payload: { sandbox_policy: { type: "read-only" } } }))?.permissionMode, "plan")
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

test("foldLine: folding the whole 2-turn fixture keeps its malformed legacy timer visible and inert", () => {
  const state = foldAll(execTwoTurn)
  assert.equal(state.turn, "idle")
  assert.ok(state.sawRecords)
  assert.equal(state.model, "gpt-5.5", "turn_context pins the backend-observed model")
  assert.equal(state.effort, "high", "turn_context pins the backend-observed effort")
  assert.equal(state.permissionMode, "bypassPermissions", "turn_context pins the backend-observed sandbox")
  // Turn 2's captured final uses `timer: 5m`, which is not an ISO instant. It remains visible fence
  // prose and cannot become a current wait registration.
  assert.equal(state.lastFence?.kind, "awaiting")
  assert.equal(state.lastFence?.hint, undefined)
  assert.match(state.lastFence?.body ?? "", /timer: 5m/)
  // Preview reflects the final answer, not a commentary line.
  assert.match(state.lastAssistant ?? "", /1 line/)
  // The genuine human turns bumped the row-order key.
  assert.equal(typeof state.lastUserAt, "string")
  assert.match(state.lastUserText ?? "", /^Now do three things/, "latest exact user text is available for durable input confirmation")
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

test("foldLine: the first commentary title comment is persisted immediately and never enters preview telemetry", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-01T00:00:01.000Z",
    payload: {
      type: "agent_message",
      phase: "commentary",
      message: '<!-- fray title="Fix reliable Codex titles" -->\nI’m tracing the launch path.',
    },
  }))
  assert.equal(state.aiTitle, "Fix reliable Codex titles")
  assert.equal(state.autoTitleSource, "fray")
  assert.equal(state.lastAssistant, "I’m tracing the launch path.")

  backend.foldLine(state, JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-01T00:00:02.000Z",
    payload: { type: "agent_message", phase: "final_answer", message: "Finished." },
  }))
  assert.equal(state.aiTitle, "Fix reliable Codex titles", "the final response cannot churn an early title")
})

test("foldLine: legacy H1 is not interpreted as title metadata in commentary", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "# Ordinary progress heading\nStill working." },
  }))
  assert.equal(state.aiTitle, undefined)
  assert.match(state.lastAssistant ?? "", /Ordinary progress heading/)
})

test("foldLine: legacy H1 compatibility remains first-final-only; omitted primary markers retain the dispatch fallback", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  const final = (message: string) => JSON.stringify({
    timestamp: "2026-07-01T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "final_answer", message },
  })

  // Legacy transcript compatibility only: newly dispatched workers are instructed to emit the
  // invisible `<!-- fray title="…" -->` transport instead.
  backend.foldLine(state, final("# Fix queue focus\nVisible answer"))
  assert.equal(state.aiTitle, "Fix queue focus")
  assert.equal(state.lastAssistant, "Visible answer", "the hidden marker never enters preview telemetry")
  assert.equal(state.titleCandidateFinalSeen, true)

  backend.foldLine(state, JSON.stringify({
    timestamp: "2026-07-01T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      last_agent_message: "# Fix queue focus\nVisible answer",
    },
  }))
  assert.equal(state.lastAssistant, "Visible answer", "task_complete's echo cannot restore the hidden marker")

  backend.foldLine(state, final("# Later rewrite\nSecond answer"))
  assert.equal(state.aiTitle, "Fix queue focus", "later turns cannot rename the thread")

  const omitted = newTailState("t", "sid", "/x")
  backend.foldLine(omitted, final("First final omitted the marker"))
  assert.equal(omitted.aiTitle, undefined, "the useful dispatch fallback stays in storage, not generic telemetry")
  assert.equal(omitted.autoTitleSource, "fallback")
  backend.foldLine(omitted, final("# Too late\nSecond answer"))
  assert.equal(omitted.aiTitle, "Too late", "a later marker repairs only the neutral auto fallback")
  assert.equal(omitted.autoTitleSource, "fray")

  backend.foldLine(omitted, final("# Still too late\nThird answer"))
  assert.equal(omitted.aiTitle, "Too late", "a generated title is stable after recovery")
})

test("foldLine: task_complete-only finals can title once, while an existing native title wins", () => {
  const backend = createCodexBackend()
  const completion = (text: string) => JSON.stringify({
    timestamp: "2026-07-01T00:00:02.000Z",
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: text },
  })
  const fallback = newTailState("t", "sid", "/x")
  backend.foldLine(fallback, completion("<!-- fray-title: Completion fallback -->\nVisible"))
  assert.equal(fallback.aiTitle, "Completion fallback")
  assert.equal(fallback.lastAssistant, "Visible")

  const native = newTailState("t", "sid", "/x")
  applyEvent(native, { kind: "title", title: "Provider native title" })
  backend.foldLine(native, completion("<!-- fray-title: Fray fallback -->\nVisible"))
  assert.equal(native.aiTitle, "Provider native title")
})

test("foldLine: real interactive Codex rollout without a marker marks the dispatch fallback as replaceable", () => {
  const state = foldAll(tuiSingleTurn)
  assert.equal(state.aiTitle, undefined)
  assert.equal(state.autoTitleSource, "fallback")
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
  const developerOverride = argv.find((arg) => arg.startsWith("developer_instructions="))
  assert.ok(developerOverride, "fresh workers receive a hidden invocation-scoped developer instruction")
  assert.equal(
    JSON.parse(developerOverride.slice("developer_instructions=".length)),
    CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS,
  )
  assert.match(CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS, /very first assistant message/)
  assert.match(CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS, /before any commentary[\s\S]*tool call/)
  assert.match(CODEX_FIRST_OUTPUT_TITLE_DEVELOPER_INSTRUCTIONS, /<!-- fray title=/)
  assert.ok(argv.includes("check_for_update_on_startup=false"), "detached workers never stall on Codex's update chooser")
  for (const config of FRAY_UI_MULTI_AGENT_V2_CONFIG) assert.ok(argv.includes(config), `spawn enables ${config}`)
  assert.ok(argv.includes(FRAY_UI_DISABLED_SKILLS_CONFIG), "fresh workers selectively suppress portfolio-orchestrator skills")
  const prompt = argv[argv.length - 1]
  assert.match(prompt, /^CONTRACT\n\nSCRATCHPAD: \/tmp\/x\n\ndo the task/) // contract + orientation prepended
  assert.match(prompt, /FRAY TITLE TRANSPORT \(required\):[\s\S]*<!-- fray title="Concise thread title" -->/)
  assert.ok(prompt.indexOf("do the task") < prompt.indexOf("FRAY TITLE TRANSPORT"), "title reminder follows the human task")
  assert.ok(prompt.indexOf("FRAY TITLE TRANSPORT") < prompt.indexOf("<!-- fray-session:"), "sentinel remains last")
  assert.match(prompt, new RegExp(codexSessionSentinel("disp-1"))) // discovery sentinel embedded
  assert.deepEqual(env, {})
  assert.deepEqual(prewrite, []) // no AGENTS.md written — contract rides the prompt (see report)
})

test("createCodexBackend: buildSpawn plan mode → read-only sandbox; unset model/effort omit their flags", () => {
  const { argv } = createCodexBackend().buildSpawn({ sessionId: "d", cwd: "/r", prompt: "p", workerContract: "", permissionMode: "plan" })
  assert.ok(argv.includes("read-only"))
  assert.ok(!argv.includes("-m"))
  assert.ok(!argv.includes('model_reasoning_effort="high"')) // no effort → no model_reasoning_effort override
  assert.ok(argv.includes("check_for_update_on_startup=false"))
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
  assert.ok(argv.includes("check_for_update_on_startup=false"), "resume suppresses the detached update chooser")
  for (const config of FRAY_UI_MULTI_AGENT_V2_CONFIG) assert.ok(argv.includes(config), `resume enables ${config}`)
  assert.ok(argv.includes(FRAY_UI_DISABLED_SKILLS_CONFIG), "resumed workers keep the same selective skill isolation")
  assert.equal(
    argv.some((arg) => arg.startsWith("developer_instructions=")),
    false,
    "resume never requests a second first-message title",
  )
  assert.deepEqual(prewrite, [])
})

function configOverrides(argv: string[]): string[] {
  return argv.flatMap((arg, index) => arg === "-c" && argv[index + 1] ? [argv[index + 1]!] : [])
}

test("createCodexBackend: spawn and resume carry identical bounded V2 routing overrides", () => {
  const backend = createCodexBackend()
  const spawn = backend.buildSpawn({ sessionId: "v2", cwd: "/repo", prompt: "task", workerContract: "", permissionMode: "default" })
  const resume = backend.buildResume({ sessionId: "native-v2", cwd: "/repo", workerContract: "", permissionMode: "default" })
  const spawnV2 = configOverrides(spawn.argv).filter((config) => config.startsWith("features.multi_agent_v2."))
  const resumeV2 = configOverrides(resume.argv).filter((config) => config.startsWith("features.multi_agent_v2."))
  assert.deepEqual(spawnV2, FRAY_UI_MULTI_AGENT_V2_CONFIG)
  assert.deepEqual(resumeV2, FRAY_UI_MULTI_AGENT_V2_CONFIG)
  assert.equal(FRAY_UI_MAX_CONCURRENT_THREADS, 4)
  assert.ok(FRAY_UI_MAX_CONCURRENT_THREADS > 0 && FRAY_UI_MAX_CONCURRENT_THREADS <= 4, "Fray keeps a bounded per-worker cap")
})

test("Codex V2 routing is process-scoped: fresh and conflicting CODEX_HOME config stay untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    const authPath = join(home, "auth.json")
    const auth = '{"tokens":{"access_token":"fresh-authenticated-user"}}\n'
    writeFileSync(authPath, auth, { mode: 0o600 })
    const backend = createCodexBackend({ codexHome: home })
    const fresh = backend.buildSpawn({ sessionId: "fresh", cwd: "/repo", prompt: "task", workerContract: "", permissionMode: "default" })
    assert.equal(fresh.env.CODEX_HOME, undefined, "the real CODEX_HOME/auth environment is inherited unchanged")
    assert.equal(fresh.env.HOME, undefined, "the real HOME/auth environment is inherited unchanged")
    assert.equal(readFileSync(authPath, "utf8"), auth, "routing does not replace fresh authenticated Codex credentials")
    assert.throws(() => readFileSync(join(home, "config.toml")), { code: "ENOENT" })

    const configPath = join(home, "config.toml")
    const conflicting = '[features.multi_agent_v2]\nenabled = false\ntool_namespace = "other"\nmax_concurrent_threads_per_session = 99\n'
    writeFileSync(configPath, conflicting)
    const resume = backend.buildResume({ sessionId: "native", cwd: "/repo", workerContract: "", permissionMode: "default" })
    assert.equal(readFileSync(configPath, "utf8"), conflicting, "routing overrides never rewrite user config")
    for (const config of FRAY_UI_MULTI_AGENT_V2_CONFIG) assert.ok(resume.argv.includes(config))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---- opinionated Codex output defaults (presence-gated, process-scoped) ----
const OUTPUT_DEFAULT_KEYS = FRAY_CODEX_OUTPUT_DEFAULTS.map(([key]) => key)
const expectedDefaultFlag = ([key, value]: readonly [string, string]) => `${key}="${value}"`
function injectedOutputDefaults(argv: string[]): string[] {
  return configOverrides(argv).filter((config) => OUTPUT_DEFAULT_KEYS.some((key) => config.startsWith(`${key}=`)))
}

test("createCodexBackend: an unconfigured operator receives every Codex output default on spawn AND resume", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-defaults-")) // no config.toml at all
  try {
    const backend = createCodexBackend({ codexHome: home })
    const spawn = backend.buildSpawn({ sessionId: "d", cwd: "/repo", prompt: "p", workerContract: "", permissionMode: "default" })
    const resume = backend.buildResume({ sessionId: "id", cwd: "/repo", workerContract: "", permissionMode: "default" })
    const expected = FRAY_CODEX_OUTPUT_DEFAULTS.map(expectedDefaultFlag)
    assert.deepEqual(expected, ['model_reasoning_summary="detailed"', 'model_verbosity="low"', 'personality="pragmatic"'])
    assert.deepEqual(injectedOutputDefaults(spawn.argv), expected, "a bare Codex install gets all fray defaults on spawn")
    assert.deepEqual(injectedOutputDefaults(resume.argv), expected, "resume carries the identical defaults")
    // Reading config must never create or mutate it — these are pure argv overrides.
    assert.throws(() => readFileSync(join(home, "config.toml")), { code: "ENOENT" }, "defaults never write the operator's config")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("createCodexBackend: a Codex value the operator set is respected — only the unset defaults inject, never an override", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-partial-"))
  try {
    // Operator has their OWN model_verbosity. `codex -c` is highest precedence, so we must not emit one.
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.6-sol"\nmodel_verbosity = "high"\n')
    const { argv } = createCodexBackend({ codexHome: home }).buildSpawn(
      { sessionId: "d", cwd: "/repo", prompt: "p", workerContract: "", permissionMode: "default" },
    )
    assert.ok(!argv.some((arg) => arg.startsWith("model_verbosity=")), "the operator's model_verbosity is left entirely alone")
    assert.deepEqual(injectedOutputDefaults(argv), ['model_reasoning_summary="detailed"', 'personality="pragmatic"'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("createCodexBackend: a default in a [profiles.*] block counts as declared; a commented-out key still gets the default", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-profile-"))
  try {
    // personality is only COMMENTED (not active) → default applies. summary is set inside a profile
    // table → declared → skip. model_verbosity is absent → default applies.
    writeFileSync(join(home, "config.toml"), '# personality = "sarcastic"\n[profiles.fast]\nmodel_reasoning_summary = "detailed"\n')
    const { argv } = createCodexBackend({ codexHome: home }).buildSpawn(
      { sessionId: "d", cwd: "/repo", prompt: "p", workerContract: "", permissionMode: "default" },
    )
    assert.deepEqual(injectedOutputDefaults(argv), ['model_verbosity="low"', 'personality="pragmatic"'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("createCodexBackend: a QUOTED or DOTTED key spelling is still the operator's own value — never overridden", () => {
  // These are all the SAME TOML key. `codex -c` is highest precedence, so a bare-identifier check that
  // missed any of them would inject an override on top of the operator — the one thing we promise never
  // to do. Each operator declaration below must fully suppress our matching default.
  for (const declaration of [
    '"personality" = "sarcastic"', // quoted key
    "'personality' = \"sarcastic\"", // literal-string key
    'profiles.fast.personality = "sarcastic"', // dotted key
  ]) {
    const home = mkdtempSync(join(tmpdir(), "codexhome-spelling-"))
    try {
      writeFileSync(join(home, "config.toml"), `${declaration}\n`)
      const { argv } = createCodexBackend({ codexHome: home }).buildSpawn(
        { sessionId: "d", cwd: "/repo", prompt: "p", workerContract: "", permissionMode: "default" },
      )
      assert.ok(!argv.some((arg) => arg.startsWith("personality=")), `no personality override injected for: ${declaration}`)
      // The other two, genuinely unset, still apply.
      assert.deepEqual(injectedOutputDefaults(argv), ['model_reasoning_summary="detailed"', 'model_verbosity="low"'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test("createCodexBackend: an operator who declared ALL of the defaults gets ZERO injected overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-all-"))
  try {
    writeFileSync(
      join(home, "config.toml"),
      'model_reasoning_summary = "detailed"\nmodel_verbosity = "high"\npersonality = "chatty"\n',
    )
    const backend = createCodexBackend({ codexHome: home })
    const spawn = backend.buildSpawn({ sessionId: "d", cwd: "/repo", prompt: "p", workerContract: "", permissionMode: "default" })
    const resume = backend.buildResume({ sessionId: "id", cwd: "/repo", workerContract: "", permissionMode: "default" })
    assert.deepEqual(injectedOutputDefaults(spawn.argv), [], "a fully-configured operator is never second-guessed on spawn")
    assert.deepEqual(injectedOutputDefaults(resume.argv), [], "…nor on resume")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("createCodexBackend: resume re-evaluates gating against the CURRENT config, respecting a set value", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-resume-"))
  try {
    writeFileSync(join(home, "config.toml"), 'personality = "chatty"\n')
    const { argv } = createCodexBackend({ codexHome: home }).buildResume(
      { sessionId: "id", cwd: "/repo", workerContract: "", permissionMode: "default" },
    )
    assert.ok(!argv.some((arg) => arg.startsWith("personality=")), "resume respects the operator's personality just like spawn")
    assert.deepEqual(injectedOutputDefaults(argv), ['model_reasoning_summary="detailed"', 'model_verbosity="low"'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("createCodexBackend: a release that rejects private V2 config exits visibly with the exact requested overrides", () => {
  const { argv } = createCodexBackend().buildSpawn({
    sessionId: "reject-v2",
    cwd: "/repo",
    prompt: "task",
    workerContract: "",
    permissionMode: "default",
  })
  const rejectPrivateV2 = `const required = ${JSON.stringify(FRAY_UI_MULTI_AGENT_V2_CONFIG)}; const args = process.argv.slice(1); if (!required.every((key) => args.includes(key))) process.exit(99); console.error("unknown config key: features.multi_agent_v2"); process.exit(78)`
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      rejectPrivateV2,
      "--",
      ...argv.slice(1),
    ],
    { encoding: "utf8" },
  )
  assert.equal(result.status, 78, "a rejected private key is an observable launch failure, never a silent no-routing launch")
  assert.match(result.stderr, /unknown config key: features\.multi_agent_v2/)
})

test("createCodexBackend: reattach changes sandbox+profile without fabricating a prompt", () => {
  const { argv } = createCodexBackend({ codexBin: "codex" }).buildResume({
    sessionId: "codex-rollout-id",
    cwd: "/repo",
    workerContract: "CONTRACT",
    extraSystemPrompt: "SCRATCHPAD: /tmp/x",
    permissionMode: "bypassPermissions",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.deepEqual(argv.slice(-2), ["danger-full-access", "codex-rollout-id"])
  assert.ok(!argv.some((arg) => arg.includes("SCRATCHPAD")), "reattach-only does not create an orientation user turn")
  assert.ok(argv.includes("-m") && argv.includes("gpt-5.6-sol"))
  assert.ok(argv.includes("-c") && argv.includes('model_reasoning_effort="ultra"'))
})

// ==== effort / sandbox mappings ====

test("codexEffort: passes through codex's full universe (incl. max/ultra), unknown → undefined", () => {
  assert.equal(codexEffort("low"), "low")
  assert.equal(codexEffort("medium"), "medium")
  assert.equal(codexEffort("high"), "high")
  assert.equal(codexEffort("xhigh"), "xhigh")
  // max/ultra are REAL codex levels (per-model gated in the UI) — no longer clamped down (the old
  // max→xhigh clamp WRONGLY downgraded a 5.6 model that supports them).
  assert.equal(codexEffort("max"), "max")
  assert.equal(codexEffort("ultra"), "ultra")
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
function writeRollout(codexHome: string, id: string, cwd: string, sentinel: string, shard = "2026/07/10"): string {
  const dir = join(codexHome, "sessions", ...shard.split("/"))
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
    const pA = writeRollout(home, "AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/repo/shared", codexSessionSentinel("disp-A"), "2026/07/10")
    const pB = writeRollout(home, "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "/repo/shared", codexSessionSentinel("disp-B"), "2026/07/11")
    const tied = new Date()
    utimesSync(pA, tied, tied)
    utimesSync(pB, tied, tied)
    const got = discoverCodexRollout({ cwd: "/repo/shared", spawnedAtMs: Date.now() - 1000, sentinel: codexSessionSentinel("disp-B"), codexHome: home })
    assert.equal(got?.sessionId, "BBBBBBBB-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    assert.equal(got?.path, pB)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("discoverCodexRollout: a requested sentinel never falls back to a fresh same-cwd neighbor", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    writeRollout(home, "NEIGHBOR-neighbor-neighbor-neighbor0001", "/repo/shared", codexSessionSentinel("someone-else"))
    assert.equal(
      discoverCodexRollout({
        cwd: "/repo/shared",
        spawnedAtMs: Date.now() - 1000,
        sentinel: codexSessionSentinel("not-written-yet"),
        codexHome: home,
      }),
      undefined,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("discoverCodexRollout: partial files retry safely, then resolve from one complete snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    const id = "PARTIAL-partial-partial-partial0000001"
    const sentinel = codexSessionSentinel("delayed")
    const dir = join(home, "sessions", "2026", "07", "12")
    const path = join(dir, `rollout-partial-${id}.jsonl`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `{"type":"session_meta","payload":{"session_id":"${id}"\n${sentinel}`)
    const opts = { cwd: "/repo/shared", spawnedAtMs: Date.now() - 1000, sentinel, codexHome: home }
    assert.equal(discoverCodexRollout(opts), undefined, "a sentinel beside incomplete metadata proves no ownership")

    writeFileSync(
      path,
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: id, cwd: "/repo/shared" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `task <!-- ${sentinel} -->` } }),
      ].join("\n") + "\n",
    )
    assert.deepEqual(discoverCodexRollout(opts), { sessionId: id, path })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("discoverCodexRollout: an mtime tie at the scan cap never excludes the exact sentinel", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    const tied = new Date()
    const targetSentinel = codexSessionSentinel("tie-target")
    let targetPath = ""
    for (let i = 0; i < 70; i++) {
      // Lexically smallest target sorts after the first 64 when mtimes tie.
      const id = `${String(i).padStart(4, "0")}-tie-session`
      const path = writeRollout(home, id, "/repo/tied", i === 0 ? targetSentinel : codexSessionSentinel(`other-${i}`))
      utimesSync(path, tied, tied)
      if (i === 0) targetPath = path
    }
    assert.deepEqual(
      discoverCodexRollout({ cwd: "/repo/tied", spawnedAtMs: Date.now() - 1000, sentinel: targetSentinel, codexHome: home }),
      { sessionId: "0000-tie-session", path: targetPath },
    )
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
