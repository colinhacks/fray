import { test } from "node:test"
import assert from "node:assert/strict"
import { createClaudeBackend, parseClaudeLine } from "./claude.ts"
import { newTailState, computeTurn } from "../tailer.ts"
import { buildClaudeCommand, buildClaudeResumeCommand, loadWorkerPrompt, workerPluginDir } from "../dispatch.ts"
import { spawnWithRunner } from "../tmux.ts"

// ---- parseClaudeLine: the normalized VIEW of a Claude JSONL line (codex-facing seam; NOT the
// behavior-critical fold — that is foldLine → applyRecord, covered by tailer.test.ts). ----

test("parseClaudeLine: a malformed / non-object / blank line yields no events", () => {
  assert.deepEqual(parseClaudeLine("{not json"), [])
  assert.deepEqual(parseClaudeLine(""), [])
  assert.deepEqual(parseClaudeLine("   "), [])
  assert.deepEqual(parseClaudeLine("5"), [])
})

test("parseClaudeLine: an end_turn assistant emits final assistant-text + a turn-end carrying the final text", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "all done\n\n```done\nshipped\n```" }] } }))
  assert.deepEqual(evs, [
    { kind: "assistant-text", at: "2026-07-01T00:00:01.000Z", text: "all done\n\n```done\nshipped\n```", final: true },
    { kind: "turn-end", at: "2026-07-01T00:00:01.000Z", finalText: "all done\n\n```done\nshipped\n```" },
  ])
})

test("parseClaudeLine: a tool_use assistant emits COMMENTARY text (final:false) + tool-call, no turn-end", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "assistant", timestamp: "t", message: { stop_reason: "tool_use", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } }))
  assert.deepEqual(evs, [
    { kind: "assistant-text", at: "t", text: "let me check", final: false },
    { kind: "tool-call", at: "t", id: "toolu_1", name: "Bash", input: { command: "ls" } },
  ])
})

test("parseClaudeLine: a typed user prompt emits a real (non-synthetic) user-message", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", message: { content: "go do the thing" } })), [
    { kind: "user-message", at: "t", text: "go do the thing", synthetic: false },
  ])
})

test("parseClaudeLine: a promptSource:system user message is SYNTHETIC (peer / notification)", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", promptSource: "system", message: { content: "<task-notification>…</task-notification>" } }))
  assert.deepEqual(evs, [{ kind: "user-message", at: "t", text: "<task-notification>…</task-notification>", synthetic: true }])
})

test("parseClaudeLine: a slash-command isMeta user reminder is metadata, not a model turn", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "user", isMeta: true, timestamp: "t", message: { content: "Session title is now Readable" } })), [])
})

test("parseClaudeLine: a tool_result-only user record emits tool-result(s), NOT a user-message", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }] } }))
  assert.deepEqual(evs, [{ kind: "tool-result", at: "t", id: "toolu_1", text: "ok" }])
})

test("parseClaudeLine: a mixed user record (text + tool_result) emits BOTH the tool-result and a real user-message", () => {
  const evs = parseClaudeLine(JSON.stringify({ type: "user", timestamp: "t", message: { content: [{ type: "text", text: "note" }, { type: "tool_result", tool_use_id: "toolu_1", content: "done" }] } }))
  assert.deepEqual(evs, [
    { kind: "tool-result", at: "t", id: "toolu_1", text: "done" },
    { kind: "user-message", at: "t", synthetic: false },
  ])
})

test("parseClaudeLine: ai-title becomes a title event while native custom-title stays observation-only", () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "ai-title", aiTitle: " Refined name " })), [{ kind: "title", title: "Refined name" }])
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "custom-title", customTitle: "machine-generated-slug" })), [])
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "ai-title", aiTitle: "   " })), [])
})

// ---- the ClaudeBackend facade (argv builders + path + fold + perm sniff) ----

test("createClaudeBackend: buildSpawn pins the session id + prompt and clears inherited profile overrides", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "sleep" })
  const { argv, env, prewrite } = backend.buildSpawn({ sessionId: "uuid-1", cwd: "/cwd", prompt: "hello", workerContract: "", extraSystemPrompt: undefined, permissionMode: "acceptEdits" })
  assert.equal(argv[0], "sleep")
  assert.equal(argv[1], "--session-id")
  assert.equal(argv[2], "uuid-1")
  assert.ok(argv.includes("--permission-mode"))
  assert.ok(argv.includes("acceptEdits"))
  assert.equal(argv[argv.length - 1], "hello")
  assert.deepEqual(env, {
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    CLAUDE_CODE_EFFORT_LEVEL: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  })
  assert.deepEqual(prewrite, [])
})

test("createClaudeBackend sanitizes both spawn and resume without replacing Claude config", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const spawned = backend.buildSpawn({ sessionId: "profile-env-spawn", cwd: "/cwd", prompt: "P", workerContract: "", permissionMode: "auto", model: "opus", effort: "high" })
  const resumed = backend.buildResume({ sessionId: "profile-env-resume", cwd: "/cwd", message: "M", workerContract: "", permissionMode: "auto", model: "opus", effort: "high" })
  for (const built of [spawned, resumed]) {
    assert.deepEqual(built.env, {
      CLAUDE_CODE_SUBAGENT_MODEL: "",
      CLAUDE_CODE_EFFORT_LEVEL: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    })
    assert.equal("CLAUDE_CONFIG_DIR" in built.env, false, "config discovery is left to the inherited environment")
  }
})

test("Claude worker profile sanitization reaches the tmux launch environment", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const built = backend.buildSpawn({ sessionId: "profile-env-tmux", cwd: "/clean-home/project", prompt: "P", workerContract: "", permissionMode: "auto", model: "opus", effort: "high" })
  const calls: string[][] = []
  spawnWithRunner("profile-env-tmux", built.argv, "/clean-home/project", built.env, {}, (argv) => {
    calls.push([...argv])
    return calls.length === 1 ? "%1\t123\t456\n" : ""
  })
  const launch = calls[0] ?? []
  assert.ok(launch.includes("CLAUDE_CODE_SUBAGENT_MODEL="))
  assert.ok(launch.includes("CLAUDE_CODE_EFFORT_LEVEL="))
  assert.equal(launch.some((entry) => entry.startsWith("CLAUDE_CONFIG_DIR=")), false)
})

// An inherited ANTHROPIC_API_KEY makes Claude Code open a blocking "Detected a custom API key"
// prompt that no worker pane can answer, so the session boots to a hang with no transcript. tmux
// cannot UNSET a variable, so the launch must carry an explicit empty `-e` entry to shadow whatever
// the (long-lived, environment-inheriting) tmux server holds.
test("Claude worker launch blanks inherited Anthropic API credentials so boot never hits the key prompt", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const built = backend.buildSpawn({ sessionId: "api-key-env", cwd: "/clean-home/project", prompt: "P", workerContract: "", permissionMode: "auto" })
  const calls: string[][] = []
  spawnWithRunner("api-key-env", built.argv, "/clean-home/project", built.env, {}, (argv) => {
    calls.push([...argv])
    return calls.length === 1 ? "%1\t123\t456\n" : ""
  })
  const launch = calls[0] ?? []
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    assert.ok(launch.includes(`${key}=`), `${key} is shadowed with an empty tmux env entry`)
    assert.equal(
      launch.some((entry) => entry.startsWith(`${key}=`) && entry !== `${key}=`),
      false,
      `${key} never carries an inherited value into the pane`,
    )
  }
})

test("createClaudeBackend: buildResume produces `-r <sessionId> <message>` and coerces plan mode to auto", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const { argv } = backend.buildResume({ sessionId: "sid", cwd: "/cwd", message: "more", workerContract: "", permissionMode: "plan" })
  assert.deepEqual(argv.slice(0, 3), ["claude", "--permission-mode", "auto"]) // plan → auto coercion
  assert.deepEqual(argv.slice(-3), ["-r", "sid", "more"]) // pinned conversation + follow-up at the tail
})

test("createClaudeBackend: reattach forwards model+effort without fabricating a user prompt", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const { argv } = backend.buildResume({ sessionId: "sid", cwd: "/cwd", workerContract: "", permissionMode: "bypassPermissions", model: "sonnet", effort: "xhigh" })
  assert.deepEqual(argv.slice(0, 3), ["claude", "--permission-mode", "bypassPermissions"])
  assert.deepEqual(argv.slice(-2), ["-r", "sid"], "the session id is the tail; no user prompt follows")
  assert.ok(argv.includes("--model") && argv.includes("sonnet"))
  assert.ok(argv.includes("--effort") && argv.includes("xhigh"))
})

test("createClaudeBackend: transcriptPath is <logDir>/<sessionId>.jsonl", () => {
  assert.equal(createClaudeBackend({ logDir: "/logs" }).transcriptPath("abc-123"), "/logs/abc-123.jsonl")
})

test("createClaudeBackend: foldLine folds a Claude record into the tail state; a bad line is a no-op", () => {
  const backend = createClaudeBackend({ logDir: "/logs" })
  const state = newTailState("t", "sid", "/logs/sid.jsonl")
  backend.foldLine(state, JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "hi there" }] } }))
  assert.equal(state.lastKind, "assistant")
  assert.equal(state.lastStopReason, "end_turn")
  assert.equal(state.lastAssistant, "hi there")
  assert.equal(state.model, "claude-opus-4-6", "assistant.message.model becomes session profile telemetry")
  assert.equal(state.effort, undefined, "Claude transcripts do not claim an unrecorded effort")
  backend.foldLine(state, "{not json") // defensive: never throws, no mutation
  assert.equal(state.lastAssistant, "hi there")
})

test("createClaudeBackend: matchesPermPrompt delegates to the empirical Claude markers", () => {
  const backend = createClaudeBackend({ logDir: "/logs" })
  assert.equal(backend.matchesPermPrompt?.("❯ 1. Yes\nDo you want to proceed?"), true)
  assert.equal(backend.matchesPermPrompt?.(""), false)
})

// The Phase-1 no-behavior-change guarantee, locked into the suite: the argv the injected backend
// builds (production path) must be BYTE-IDENTICAL to a direct legacy `buildClaude*` call (the path
// dispatch/resume take when no backend is injected). Regression fence against future backend edits.
test("createClaudeBackend: buildSpawn/buildResume argv == the legacy buildClaude* argv (byte-for-byte)", () => {
  const backend = createClaudeBackend({ logDir: "/logs", claudeBin: "claude" })
  const spawnCases = [
    { sessionId: "u1", permissionMode: "acceptEdits" as const, model: "opus", effort: "high", extra: "SCRATCHPAD: x" },
    { sessionId: "u2", permissionMode: "auto" as const, model: undefined, effort: undefined, extra: undefined },
    { sessionId: "u3", permissionMode: "plan" as const, model: "sonnet", effort: undefined, extra: "PLAN: y" }, // plan → auto coercion
  ]
  for (const c of spawnCases) {
    const direct = buildClaudeCommand({ sessionId: c.sessionId, permissionMode: c.permissionMode, model: c.model, effort: c.effort, prompt: "P", claudeBin: "claude", pluginDir: workerPluginDir(), extraSystemPrompt: c.extra })
    const built = backend.buildSpawn({ sessionId: c.sessionId, cwd: "/cwd", prompt: "P", workerContract: loadWorkerPrompt(), extraSystemPrompt: c.extra, permissionMode: c.permissionMode, model: c.model, effort: c.effort })
    assert.deepEqual(built.argv, direct, `spawn argv drift for ${c.sessionId}`)
  }
  const resumeCases = [
    { sessionId: "s1", permissionMode: "acceptEdits" as const, extra: "SCRATCHPAD: a" },
    { sessionId: "s2", permissionMode: "plan" as const, extra: undefined }, // plan → auto coercion
  ]
  for (const c of resumeCases) {
    const direct = buildClaudeResumeCommand({ sessionId: c.sessionId, permissionMode: c.permissionMode, message: "M", claudeBin: "claude", pluginDir: workerPluginDir(), extraSystemPrompt: c.extra })
    const built = backend.buildResume({ sessionId: c.sessionId, cwd: "/cwd", message: "M", workerContract: loadWorkerPrompt(), extraSystemPrompt: c.extra, permissionMode: c.permissionMode })
    assert.deepEqual(built.argv, direct, `resume argv drift for ${c.sessionId}`)
  }
})

// The normalized VIEW (parseLine) must not silently drift from the AUTHORITATIVE fold (foldLine →
// applyRecord → computeTurn): a `turn-end` event must appear exactly when the fold lands the turn idle
// on the clear (deterministic) stop_reasons.
test("parseClaudeLine's turn-end signal agrees with the authoritative fold (no drift)", () => {
  const backend = createClaudeBackend({ logDir: "/x" })
  const far = Date.parse("2026-07-01T01:00:00.000Z") // well past the 5s unknown-stop-reason backstop
  const cases = [
    { line: JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }), idle: true },
    { line: JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:01.000Z", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } }), idle: false },
    { line: JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { content: "go" } }), idle: false },
  ]
  for (const c of cases) {
    const hasTurnEnd = parseClaudeLine(c.line).some((e) => e.kind === "turn-end")
    const st = newTailState("t", "s", "/x")
    backend.foldLine(st, c.line)
    assert.equal(computeTurn(st, far) === "idle", c.idle, `fold idle verdict for ${c.line}`)
    assert.equal(hasTurnEnd, c.idle, `normalized turn-end agrees with fold for ${c.line}`)
  }
})
