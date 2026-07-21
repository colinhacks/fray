import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildClaudeCommand, loadWorkerPrompt, composePrompt, resolveWorkerPluginDir, scratchpadOrientation, scratchpadContent, workerPluginDir, frayConfigBlock } from "./dispatch.ts"
import { CHROME_DEVTOOLS_MCP } from "./backend/types.ts"

// ---- Backend-aware worker contract (worker-contract-backend-aware) ----
// loadWorkerPrompt(kind) delegates to buildWorkerPrompt in workerPrompt.ts (a single compiled-in TS
// source, no runtime markdown/marker fill). The CLAUDE output must still reproduce the pre-split
// contract BYTE-FOR-BYTE (the regression bar); the CODEX output has its own golden.

const here = dirname(fileURLToPath(import.meta.url))
// The FROZEN pre-split claude contract body (the exact string a claude dispatch got before the split).
// Regenerate ONLY when the shipped claude contract is deliberately changed — an unexpected diff here is
// a regression (a core/claude-fragment edit that altered what a claude worker receives).
// The markdown loader trims the contract body; normalize the fixture's conventional POSIX newline
// before making the byte-for-byte comparison of the actual prompt content.
const CLAUDE_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.claude.golden.txt"), "utf8").trimEnd()
const CODEX_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.codex.golden.txt"), "utf8").trimEnd()
const SESSION_SEED = readFileSync(join(here, "../../../../cc-worker/hooks/session-seed.mjs"), "utf8")

test("loadWorkerPrompt: default kind is claude", () => {
  assert.equal(loadWorkerPrompt(), loadWorkerPrompt("claude"))
})

test("Claude dispatch supplies the discovered worker plugin via --plugin-dir", () => {
  const plugin = workerPluginDir()
  assert.ok(plugin, "the packaged worker plugin must be discoverable")
  assert.doesNotThrow(() => readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))
  const argv = buildClaudeCommand({
    sessionId: "plugin-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    pluginDir: plugin,
  })
  assert.deepEqual(argv.slice(argv.indexOf("--plugin-dir"), argv.indexOf("--plugin-dir") + 2), ["--plugin-dir", plugin])
})

test("Claude dispatch mounts chrome-devtools + the spawn-thread MCP server and pre-approves both", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    spawnThreadMcp: { scriptPath: "/abs/plugin/bin/spawn-thread-mcp.mjs", stateDir: "/home/.fray/projects/pid" },
  })
  const cfgRaw = argv[argv.indexOf("--mcp-config") + 1]
  assert.ok(cfgRaw, "argv must carry an inline --mcp-config")
  const cfg = JSON.parse(cfgRaw)
  // Chrome DevTools rides EVERY dispatch (runtime-gate browser QA, parity with the codex `-c`
  // injection — both derive from the canonical CHROME_DEVTOOLS_MCP spec).
  assert.deepEqual(cfg.mcpServers[CHROME_DEVTOOLS_MCP.name], {
    command: CHROME_DEVTOOLS_MCP.command,
    args: [...CHROME_DEVTOOLS_MCP.args],
  })
  assert.deepEqual(cfg.mcpServers.fray_spawn, {
    command: process.execPath, // absolute node path, not bare "node" (worker PATH-independence)
    args: ["/abs/plugin/bin/spawn-thread-mcp.mjs"],
    env: { FRAY_STATE_DIR: "/home/.fray/projects/pid" },
  })
  // Tools are pre-approved so a headless worker never blocks on a permission prompt. One comma-joined
  // EQUALS-form token: --allowedTools is variadic, so a space-separated value could swallow a
  // following positional (the prompt) — the equals form binds exactly one token.
  assert.ok(argv.includes("--allowedTools=mcp__chrome-devtools,mcp__fray_spawn__spawn_fray_thread"))
  // The prompt stays the trailing positional (flags never displace it).
  assert.equal(argv[argv.length - 1], "test")
})

test("Claude dispatch still mounts + pre-approves chrome-devtools when no spawn-thread descriptor is supplied", () => {
  const argv = buildClaudeCommand({ sessionId: "no-mcp", permissionMode: "auto", prompt: "test", workerPrompt: "" })
  const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1])
  assert.deepEqual(Object.keys(cfg.mcpServers), [CHROME_DEVTOOLS_MCP.name])
  assert.ok(argv.includes("--allowedTools=mcp__chrome-devtools"))
})

test("Claude worker surfaces share the canonical per-session scratchpad path", () => {
  const sessionId = "scratch-canonical"
  const canonical = `.fray/threads/${sessionId}/scratch.md`
  assert.match(composePrompt(sessionId, "task", "", "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(scratchpadOrientation(sessionId, null, "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(SESSION_SEED, /\.fray\/threads\/.*scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /\.fray\/scratch\//)
})

// ---- FRAY.md project-config injection (defer-to-project-norms) ----
// A repo-committed FRAY.md at the project root is injected into the worker SYSTEM prompt under an
// "overrides fray defaults" header, so a project's own norms win over fray's built-in defaults.
test("frayConfigBlock: absent FRAY.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-absent-"))
  assert.equal(frayConfigBlock(dir), "")
})

test("frayConfigBlock: empty/whitespace FRAY.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-empty-"))
  writeFileSync(join(dir, "FRAY.md"), "\n  \n")
  assert.equal(frayConfigBlock(dir), "")
})

test("frayConfigBlock: present FRAY.md is wrapped in an overrides-fray-defaults header", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-present-"))
  const body = "## Our norms\n- Gates: `pnpm check`\n- Skip adversarial review on small UI diffs."
  writeFileSync(join(dir, "FRAY.md"), body + "\n")
  const block = frayConfigBlock(dir)
  assert.match(block, /PROJECT FRAY CONFIG \(from this repo's FRAY\.md\)/)
  // Header is scoped to PROCESS defaults and explicitly does NOT relax the fray-mechanical contract —
  // so a FRAY.md can't contradict the "Defer" section's non-negotiable browser/signal gates.
  assert.match(block, /OVERRIDE the fray worker PROCESS defaults above/)
  assert.match(block, /do NOT relax the fray-mechanical contract/)
  assert.ok(block.includes(body), "the FRAY.md body must be present verbatim")
})

test("frayConfigBlock: an over-cap FRAY.md content is clipped with a truncation marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-clip-"))
  writeFileSync(join(dir, "FRAY.md"), "x".repeat(50_000)) // > 12k chars, < 64KB → read then clipped
  const block = frayConfigBlock(dir)
  assert.match(block, /\[FRAY\.md truncated\]/)
  assert.ok(block.length < 20_000, "the injected block must stay within the system-prompt budget")
})

test("frayConfigBlock: a runaway (>64KB) FRAY.md is rejected unread, not slurped", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-runaway-"))
  writeFileSync(join(dir, "FRAY.md"), "x".repeat(200_000)) // exceeds the read-size guard
  assert.equal(frayConfigBlock(dir), "")
})

test("frayConfigBlock: a non-regular FRAY.md (a directory) injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-dir-"))
  mkdirSync(join(dir, "FRAY.md"))
  assert.equal(frayConfigBlock(dir), "")
})

test("frayConfigBlock composes AFTER the worker contract (override position) in the system prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-md-order-"))
  writeFileSync(join(dir, "FRAY.md"), "PROJECT-NORM-SENTINEL")
  const sessionId = "fray-md-order"
  const system = [loadWorkerPrompt("claude"), scratchpadOrientation(sessionId, null, "claude"), frayConfigBlock(dir)]
    .filter(Boolean)
    .join("\n\n")
  assert.ok(system.indexOf("PROJECT-NORM-SENTINEL") > system.indexOf("Defer to the project's own norms"))
})

test("artifact worker resolver finds runtime/cc-worker through pnpm's nested module store", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-worker-plugin-resolver-"))
  const runtime = join(root, "runtime")
  const module = join(runtime, "node_modules", ".pnpm", "@fray-ui+server@fixture", "node_modules", "@fray-ui", "server", "src", "dispatch.js")
  const plugin = join(runtime, "cc-worker")
  mkdirSync(dirname(module), { recursive: true })
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
  writeFileSync(module, "export {}\n")
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}\n")
  assert.equal(resolveWorkerPluginDir(pathToFileURL(module).href, {}), plugin)
})

test("loadWorkerPrompt(claude) is BYTE-IDENTICAL to the pre-split contract (the regression bar)", () => {
  assert.equal(loadWorkerPrompt("claude"), CLAUDE_GOLDEN)
})

test("loadWorkerPrompt(codex) is BYTE-IDENTICAL to its golden (regenerate on deliberate codex edits)", () => {
  assert.equal(loadWorkerPrompt("codex"), CODEX_GOLDEN)
})

test("loadWorkerPrompt: no unresolved {{FRAY_*}} markers survive in either backend's contract", () => {
  assert.doesNotMatch(loadWorkerPrompt("claude"), /\{\{FRAY_/)
  assert.doesNotMatch(loadWorkerPrompt("codex"), /\{\{FRAY_/)
})

test("loadWorkerPrompt(claude) carries the Claude-Code-only guidance", () => {
  const c = loadWorkerPrompt("claude")
  assert.match(c, /a top-level `claude` session/)
  assert.match(c, /`claude -r`/)
  assert.match(c, /## Sub-agents/)
  assert.match(c, /Always plain Agent tool \+ `run_in_background: true`/)
  assert.match(c, /namespaced string `fray:<model>-<effort>`/)
  assert.match(c, /the shared blackboard for your sub-agents/)
  assert.match(c, /## Automated waits in Claude Code/)
  assert.match(c, /`Monitor`/)
  assert.match(c, /`persistent: true`/)
  assert.match(c, /TaskOutput[\s\S]{0,80}deprecated/)
  assert.match(c, /`Read` on that output path/)
})

test("loadWorkerPrompt(codex) OMITS every Claude-Code-only construct a codex worker can't use", () => {
  const c = loadWorkerPrompt("codex")
  // No Claude session/wake, no Agent tool, no fray profiles, no sub-agent blackboard framing.
  assert.doesNotMatch(c, /claude session/)
  assert.doesNotMatch(c, /claude -r/)
  assert.doesNotMatch(c, /## Sub-agents/)
  assert.doesNotMatch(c, /Agent tool/)
  assert.doesNotMatch(c, /run_in_background/)
  assert.doesNotMatch(c, /fray:<model>-<effort>/)
  assert.doesNotMatch(c, /fray:opus/)
  assert.doesNotMatch(c, /blackboard/)
})

test("loadWorkerPrompt(codex) carries codex's OWN session/wake + model/effort/sandbox framing", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /a top-level `codex` session/)
  assert.match(c, /`codex resume`/)
  assert.match(c, /## Own one task/)
  assert.match(c, /not the dashboard's portfolio orchestrator/)
  assert.match(c, /Work solo unless the TASK or a later human follow-up explicitly asks/)
  assert.match(c, /## Bounded native delegation/)
  assert.match(c, /### CI\/review monitor selection/)
  assert.match(c, /project-local `AGENTS\.md`/)
  assert.match(c, /terminal event\/exit semantics/)
  assert.match(c, /never silently shadow it with Fray/)
  assert.match(c, /persistent `exec_command` \/ `write_stdin` session/)
  assert.match(c, /Luna child is optional\nonly/)
  assert.match(c, /active native spawn tool/)
  assert.match(c, /configured namespace is `fray`/)
  assert.match(c, /`fork_context: false`/)
  assert.match(c, /`gpt-5\.6-luna` \+ `medium`/)
  assert.match(c, /`gpt-5\.6-terra` \+ `medium`/)
  assert.match(c, /`gpt-5\.6-sol` \+ `high` or `xhigh`/)
  assert.match(c, /Before any Sol or xhigh spawn/)
  assert.match(c, /why Terra \+ medium is inadequate/)
  assert.doesNotMatch(c, /do that work INLINE yourself/)
  // The effort enum must match what fray actually sends codex: codexEffort (backend/codex.ts) passes
  // the complete outer universe through; the selected model gates which levels it accepts.
  assert.match(c, /reasoning effort \(low \/ medium \/ high \/ xhigh \/ max \/ ultra\)/)
  assert.match(c, /read-only/)
  assert.match(c, /workspace-write/)
  assert.match(c, /danger-full-access/)
  assert.match(c, /## Automated waits in Codex/)
  assert.match(c, /persistent `exec_command` \/\n`write_stdin` monitor session/)
  assert.match(c, /`write_stdin`/)
  assert.match(c, /partial\n?`gh pr checks` rollup is not a CI-green verdict/)
  assert.match(c, /`ACTION_REQUIRED` fork gates as pending/)
})

test("loadWorkerPrompt(codex) requests exactly one first-output invisible title comment", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /## Thread title signal/)
  assert.match(c, /<!-- fray title="Fix queue focus" -->/)
  assert.match(c, /very FIRST assistant message/)
  assert.match(c, /before any[\s\S]*commentary[\s\S]*tool call/)
  assert.match(c, /3-8 word title/)
  assert.match(c, /strips this comment from visible chat/)
  assert.match(c, /human rename always wins/)
  assert.match(c, /Never use an H1\nfor the title signal/)
  assert.doesNotMatch(loadWorkerPrompt("claude"), /<!-- fray-title:/)
})

test("loadWorkerPrompt(codex) never turns an ordinary thread label into unconditional fan-out", () => {
  const c = loadWorkerPrompt("codex")
  assert.doesNotMatch(c, /Fan out one sub-agent per independent prong/)
  assert.doesNotMatch(c, /re-verified; fan out and loop/)
  assert.doesNotMatch(c, /Draft the plan → dispatch a critic sub-agent/)
  assert.doesNotMatch(c, /dispatch fresh-context reviewer\(s\) on the diff/)
  assert.match(c, /the audit label alone does not authorize fan-out/)
  assert.match(c, /Add fresh-context reviewer agents only under the explicit delegation policy/)
})

test("loadWorkerPrompt: the backend-AGNOSTIC core is present in BOTH contracts", () => {
  for (const kind of ["claude", "codex"] as const) {
    const c = loadWorkerPrompt(kind)
    assert.match(c, /```done/) // fence grammar
    assert.match(c, /```awaiting/)
    assert.match(c, /```question/)
    assert.match(c, /## Thread types/)
    assert.match(c, /## Git discipline/)
    assert.match(c, /## Quality bar/)
    assert.match(c, /## The stop criterion/)
    assert.match(c, /human: <actor \+ exact review\/approval>/) // current awaiting grammar
    assert.match(c, /timer: <ISO-8601 instant>/)
    assert.match(c, /`pr:` \/ `ci:` \/ `session:` remain/) // legacy readability is explicit
    assert.match(c, /## Agent completion invariant/)
    assert.match(c, /let it run to its terminal return/)
    assert.match(c, /partially applied edits, tests, and owned processes/)
    assert.match(c, /only the affected service, never by stopping\n?a writer/)
    assert.match(c, /!\[descriptive alt\]\(\/absolute\/path\.png\)/)
    assert.match(c, /eligible absolute local image paths through\n?its guarded local-image proxy/)
  }
})

test("awaiting re-entry: every worker-contract surface requires a fresh fence after a follow-up", () => {
  // This is deliberately pinned across the shipped backend contracts (the single source — the former
  // fray:worker skill copy was deleted; session-seed is a slim pointer, see its own test). A
  // human turn clears lastFence in the tailer, so merely saying "already parked" cannot restore the
  // state: the worker must make a fresh decision, then repeat a current human/timer fence or re-arm
  // the active backend wait for an automatable condition.
  for (const c of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    assert.match(c, /back to awaiting/)
    assert.match(c, /already parked/)
    assert.match(c, /re-emit/)
    assert.match(c, /human:[^\n]*timer:/)
    assert.match(c, /automatable[\s\S]{0,100}(?:arm|re-arm)/i)
  }
})

test("end-state contract: bare rest queues, done checks, awaiting parks human/timer only", () => {
  for (const c of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    assert.match(c, /bare rest[^\n]*(?:ordinary handoff|queues)/i)
    assert.match(c, /(?:enters|enter)[\s\S]{0,80}queue/i)
    assert.match(c, /(?:question|permission)[\s\S]{0,100}higher.priority/i)
    assert.match(c, /checked success card[^\n]*queue/)
    assert.match(c, /until the human (?:explicitly )?(?:A|a)rchives? it/)
    // done is gated on COMPLETED work (uncommitted is fine); a pre-fix bug/issue investigation never
    // earns it, while a commissioned research/audit effort's finished report does (done-requires-completed-work)
    assert.match(c, /COMPLETED\s+the effort's real work/)
    assert.match(c, /investigat(?:ed|ing|ion)[\s\S]{0,300}NOT `?done`?/i)
    assert.match(c, /research or audit EFFORT[\s\S]{0,200}earns `done`/)
    assert.match(c, /awaiting[\s\S]{0,140}(?:human|timestamp)/i)
    assert.match(c, /(?:CI|automatable)[\s\S]{0,180}(?:stay active|active wait|live operation)/i)
  }
  assert.doesNotMatch(SESSION_SEED, /BARE REST[^\n]*quiet/i)
  assert.doesNotMatch(SESSION_SEED, /```done \/ ```awaiting excuse/)
  assert.match(SESSION_SEED, /```done queues a checked completion until Archive \(completed work only[^)]*\); ```awaiting parks only a human:\/timer: gate/)
  assert.match(SESSION_SEED, /real work is COMPLETE/)
})

test("session-seed is a SLIM runtime pointer, not a fourth full contract copy", () => {
  // The full contract lives ONCE in the system prompt (loadWorkerPrompt) — the on-demand fray:worker
  // skill copy was deleted. The SessionStart hook only re-grounds: it points at the system prompt, carries the runtime
  // scratchpad path + a signal-at-rest anchor, and must NOT re-duplicate the gate / re-entry drill /
  // browser-QA checklist (that duplication is exactly what drifted and what this slim removes).
  assert.match(SESSION_SEED, /lives in your SYSTEM PROMPT/i)
  // The worker-skill copy is GONE — the seed must not tell workers to load a skill that no longer exists.
  assert.doesNotMatch(SESSION_SEED, /fray:worker/)
  assert.match(SESSION_SEED, /\.fray\/threads\/.*scratch\.md/)
  for (const fence of [/```done/, /```awaiting/, /```question/]) assert.match(SESSION_SEED, fence)
  assert.doesNotMatch(SESSION_SEED, /RUNTIME RELEASE GATE:/)
  assert.doesNotMatch(SESSION_SEED, /never build a bespoke screenshot tool/)
  assert.doesNotMatch(SESSION_SEED, /back to awaiting/)
})

test("runtime release gate: every worker surface carries the generalized, any-repo gate contract", () => {
  // The gate is REPO-AGNOSTIC now (not fray-ui's own stack) and settings-toggled; when present it must
  // read the same across all four delivery surfaces. loadWorkerPrompt defaults runtimeGate=on. Whitespace
  // is normalized so a phrase wrapped across a newline in WORKER_PROMPT.md still matches the single-line
  // session-seed/skill copies.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    assert.match(c, /INCOMPLETE/)
    assert.match(c, /whatever repo you are working in/i)
    assert.match(c, /driven it end-to-end in a real browser/i)
    assert.match(c, /rendered screenshot of the final UI in your handoff/i)
    // Standard tools only, in priority order — never a bespoke one.
    assert.match(c, /Chrome DevTools MCP/)
    assert.match(c, /agent-browser/)
    assert.match(c, /puppeteer/i)
    assert.match(c, /never build a bespoke screenshot tool/i)
    // Discover-in-repo, else ask the human (auto-install + persist-as-skill), same for launching.
    assert.match(c, /existing capability[\s\S]{0,60}in the repo/i)
    assert.match(c, /spin up the dev server yourself/i)
    assert.match(c, /ask the human/i)
    assert.match(c, /auto-install/i)
    assert.match(c, /permanent skill/i)
    assert.match(c, /disposable[\s\S]{0,120}never touch real data/i)
    // Retained rigor.
    assert.match(c, /active[\s\S]{0,80}idle[\s\S]{0,80}error[\s\S]{0,100}(?:restart|recovery)/i)
    assert.match(c, /desktop[\s\S]{0,80}narrow[\s\S]{0,80}screenshots/i)
    assert.match(c, /console[\s\S]{0,80}network/i)
    assert.match(c, /correctness[\s\S]{0,60}(?:and|\+)[\s\S]{0,60}aesthetics/i)
    assert.match(c, /implementer self-review/i)
    assert.match(c, /independent fresh-context adversarial review/i)
    assert.match(c, /(?:unit|integration)[\s\S]{0,120}(?:cannot|not)[\s\S]{0,60}(?:justify|alone)/i)
    assert.match(c, /trivial non-runtime docs[\s\S]{0,100}provably mechanical/i)
  }
})

test("runtime release gate: the settings toggle includes or excises the whole module", () => {
  const on = loadWorkerPrompt("claude")
  const off = loadWorkerPrompt("claude", false)
  // ON keeps the section (markers stripped); OFF excises it entirely.
  assert.match(on, /Runtime release gate/)
  assert.doesNotMatch(off, /Runtime release gate/)
  assert.doesNotMatch(off, /driven it end-to-end in a real browser/i)
  // Markers never survive in either mode.
  assert.doesNotMatch(on, /FRAY:GATE/)
  assert.doesNotMatch(off, /FRAY:GATE/)
  // The rest of the contract is untouched when the gate is off (signals, visual-evidence guidance).
  assert.match(off, /Visual evidence in handoffs/)
  assert.match(off, /End-of-turn signals/)
})

test("visual-evidence handoffs: provider contracts keep embeds safe, useful, and interpretable", () => {
  for (const c of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    assert.match(c, /meaningful alt text/i)
    assert.match(c, /eligible workspace[\s\S]{0,80}allowlisted image files/i)
    assert.match(c, /outside that safe boundary[\s\S]{0,80}non-navigable/i)
    assert.match(c, /(?:Do not[\s\S]{0,60}bulk-embed|screenshot bulk[\s\S]{0,30}forbidden)/i)
    assert.match(c, /concise textual finding[\s\S]{0,100}(?:cleanup|browser\/process)/i)
  }
})

// ---- composePrompt: the first VISIBLE user message's scratchpad line is backend-aware ----

test("composePrompt(claude) keeps the sub-agent blackboard framing; codex drops it", () => {
  const claude = composePrompt("sid", "do the thing", "", "claude")
  assert.match(claude, /shared blackboard for your sub-agents/)
  assert.match(claude, /pass its path to every sub-agent you dispatch/)
  assert.equal(composePrompt("sid", "do the thing", ""), claude) // default = claude (unchanged)

  const codex = composePrompt("sid", "do the thing", "", "codex")
  assert.doesNotMatch(codex, /sub-agent/)
  assert.doesNotMatch(codex, /blackboard/)
  assert.match(codex, /compaction-proof working memory/)
  assert.match(codex, /TASK:\ndo the thing/) // the task still rides through
})

// ---- scratchpadOrientation: the SYSTEM-level line is backend-aware ----

test("scratchpadOrientation(codex) drops the blackboard framing; claude keeps it (default unchanged)", () => {
  const claude = scratchpadOrientation("sid", null, "claude")
  assert.match(claude, /shared blackboard for your sub-agents/)
  assert.equal(scratchpadOrientation("sid", null), claude)

  const codex = scratchpadOrientation("sid", null, "codex")
  assert.doesNotMatch(codex, /sub-agent/)
  assert.doesNotMatch(codex, /blackboard/)
  assert.match(codex, /compaction-proof working memory/)

  // The plan line is agnostic and appended for both.
  assert.match(scratchpadOrientation("sid", ".fray/plans/x.md", "codex"), /PLAN: \.fray\/plans\/x\.md/)
})

// ---- scratchpadContent: the pad skeleton is backend-aware ----

test("scratchpadContent(codex) is compaction-only (no fleet-blackboard / Shared context section)", () => {
  const claude = scratchpadContent("t", "claude")
  assert.match(claude, /fleet blackboard/)
  assert.match(claude, /## Shared context/)
  assert.equal(scratchpadContent("t"), claude) // default = claude (unchanged)

  const codex = scratchpadContent("t", "codex")
  assert.doesNotMatch(codex, /blackboard/)
  assert.doesNotMatch(codex, /Shared context/)
  assert.doesNotMatch(codex, /sub-agent/)
  assert.match(codex, /## Task list/)
})
