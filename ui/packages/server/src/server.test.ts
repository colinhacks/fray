import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { getSettings, setSettings, defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import {
  slugify,
  resolveSlug,
  composePrompt,
  buildClaudeCommand,
  buildClaudeResumeCommand,
  fallbackTitle,
  scratchpadOrientation,
  validPlanPath,
  createDispatcher,
} from "./dispatch.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend } from "./backend/codex.ts"
import type { AgentBackend } from "./backend/types.ts"
import type { PaneIdentity, TmuxSpawnOptions } from "./tmux.ts"

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakePaneIdentity(n = 1): PaneIdentity {
  return { paneId: `%${n}`, panePid: 10_000 + n, sessionCreated: 20_000 + n }
}

// A dispatcher wired to a tmp project + real storage + a stub board + injected tmux seams. No test in
// this harness contacts the live project socket or starts a real worker.
function dispatcherHarness(settings = defaultSettings()) {
  const dir = tmp("fray-dispatch-")
  const storage = createStorage(join(dir, "ui.db"))
  const project: Project = { dir, id: "id", name: "test", label: "o/test", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const spawned: { slug: string; cmd: string[]; cwd: string; env?: Record<string, string>; promptText?: string; promptMode?: number }[] = []
  const board: BoardManager = {
    snapshot: async () => ({}) as never,
    currentSeq: () => 0,
    rebuild: async () => ({}) as never,
    refresh: () => ({}) as never,
    start: async () => {},
    stop: async () => {},
  }
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    readBoard: async () => ({
      config: {},
      threads: existsSync(join(dir, ".fray"))
        ? readdirSync(join(dir, ".fray"), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => ({
              id: entry.name.slice(0, -3),
              title: entry.name.slice(0, -3),
              status: "active",
              owner: null,
              agents: [],
              errors: [],
              warnings: [],
            }))
        : [],
      errors: [],
      warnings: [],
      errorItems: [],
    }),
    getSettings: () => settings,
    spawn: (slug, cmd, cwd, env, options: TmuxSpawnOptions = {}) => {
      spawned.push({ slug, cmd, cwd, env })
      const identity = fakePaneIdentity(spawned.length)
      options.onCreated?.(identity)
      return identity
    },
    ensureServer: () => {},
    hasSession: () => false,
  })
  return { dir, storage, project, spawned, dispatcher }
}

// The system prompt a spawn carries. It rides `--append-system-prompt-file <path>` (inline text
// would blow tmux's command-length limit), so resolve the path and read the file. Falls back to a
// legacy inline `--append-system-prompt <text>` if present. "" when neither is set.
function systemPromptOf(cmd: string[]): string {
  const fi = cmd.indexOf("--append-system-prompt-file")
  if (fi !== -1) {
    try {
      return readFileSync(cmd[fi + 1], "utf8")
    } catch {
      return ""
    }
  }
  const i = cmd.indexOf("--append-system-prompt")
  return i === -1 ? "" : cmd[i + 1]
}

test("storage: session roundtrip + markRead + exited", () => {
  const dir = tmp("fray-store-")
  const s = createStorage(join(dir, "ui.db"))
  assert.equal(s.getSession("t"), undefined)

  s.upsertSession({
    slug: "t",
    session_id: "sid-1",
    tmux_name: "fray-t",
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 1,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
  })
  let row = s.getSession("t")
  assert.equal(row?.session_id, "sid-1")
  assert.equal(row?.unread, 1)
  assert.equal(s.allSessions().length, 1)

  s.markRead("t", "2026-07-01T01:00:00.000Z")
  row = s.getSession("t")
  assert.equal(row?.unread, 0)
  assert.equal(row?.last_read_at, "2026-07-01T01:00:00.000Z")

  s.setExited("t", true)
  assert.equal(s.getSession("t")?.exited, 1)

  // upsert is idempotent on the slug PK
  s.upsertSession({ ...row!, session_id: "sid-2", unread: 1, exited: 0 })
  assert.equal(s.allSessions().length, 1)
  assert.equal(s.getSession("t")?.session_id, "sid-2")
  s.close()
})

test("storage: transcript_id cache round-trips, survives restart, resets on re-dispatch, preserves on resume", () => {
  const dir = tmp("fray-store-tid-")
  const dbPath = join(dir, "ui.db")
  const s = createStorage(dbPath)
  s.upsertSession({
    slug: "t", session_id: "sid-1", tmux_name: "fray-t", spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  })
  // The tailer's discovery caches the drifted transcript's id.
  s.setTranscriptId("t", "forked-id")
  assert.equal(s.getSession("t")?.transcript_id, "forked-id")
  s.close()

  // Survives a server restart (persisted to disk, read back on reopen).
  const s2 = createStorage(dbPath)
  assert.equal(s2.getSession("t")?.transcript_id, "forked-id", "the cached id persists across restart")

  // A RESUME spreads the existing row (same session_id) → the cached discovery is preserved.
  const row = s2.getSession("t")!
  s2.upsertSession({ ...row, spawned_at: "2026-07-01T01:00:00.000Z", exited: 0 })
  assert.equal(s2.getSession("t")?.transcript_id, "forked-id", "resume preserves the cache")

  // A RE-DISPATCH/ADOPT carries a FRESH session_id + transcript_id:null → the stale cache is cleared.
  s2.upsertSession({ ...row, session_id: "sid-2", transcript_id: null })
  assert.equal(s2.getSession("t")?.transcript_id ?? null, null, "a fresh session_id resets the cache")
  s2.close()
})

test("settings: defaults, roundtrip, merge-over-defaults", () => {
  const dir = tmp("fray-settings-")
  const s = createStorage(join(dir, "ui.db"))
  const def = getSettings(s)
  assert.deepEqual(def, defaultSettings())
  // dispatchPreamble is the USER's custom instructions — empty by default. The invariant worker
  // system prompt ships separately (ui/WORKER_PROMPT.md via dispatch.ts) and is not a setting.
  assert.equal(def.dispatchPreamble, "")
  assert.equal(def.permissionMode, "auto")
  assert.equal(def.notifications, true)

  setSettings(s, { ...def, permissionMode: "plan", model: "opus", notifications: false })
  const got = getSettings(s)
  assert.equal(got.permissionMode, "plan")
  assert.equal(got.model, "opus")
  assert.equal(got.notifications, false)
  s.close()
})

test("slugify: normalizes titles to the board id regex", () => {
  const re = /^[a-z0-9][a-z0-9-]*$/
  assert.equal(slugify("Fix the Board!"), "fix-the-board")
  assert.equal(slugify("  Multiple   spaces  "), "multiple-spaces")
  assert.equal(slugify("CamelCase & Symbols #1"), "camelcase-symbols-1")
  assert.match(slugify("Ünïcödé weird"), re)
  assert.equal(slugify("!!!"), "thread")
})

test("fallbackTitle: never ends mid-phrase and drops topic-free lead-ins", () => {
  // The exact garbage case ("also-spin-up-a-sub-agent-to"): "also" stripped, the 6-word window
  // lands on "to", and the trail backoff drops it.
  assert.equal(fallbackTitle("also spin up a sub agent to review the docs"), "spin up a sub agent…")
  // Window landing on an article backs off as well.
  assert.equal(fallbackTitle("please fix the bug found in the parser module"), "fix the bug found…")
  // Never trims below two words.
  assert.equal(fallbackTitle("fix the"), "fix the")
})

test("fallbackTitle: first ~6 words of the first line, capped + ellipsized", () => {
  // short prompt: whole thing, no ellipsis
  assert.equal(fallbackTitle("Fix the board parser"), "Fix the board parser")
  // >6 words → first 6 + ellipsis
  assert.equal(fallbackTitle("one two three four five six seven eight"), "one two three four five six…")
  // only the first line is considered
  assert.equal(fallbackTitle("Investigate the flake\nthen write it up"), "Investigate the flake")
  // leading/trailing whitespace trimmed
  assert.equal(fallbackTitle("   Refactor tailer   "), "Refactor tailer")
  // 48-char cap even within 6 words (single long token)
  const long = fallbackTitle("supercalifragilisticexpialidocioussupercalifragilistic tail")
  assert.ok(long.length <= 48)
  assert.ok(long.endsWith("…"))
  // empty / whitespace-only → the "thread" sentinel (never empty; slug needs it)
  assert.equal(fallbackTitle("   "), "thread")
})

test("fallbackTitle: derived title slugifies to a valid board id", () => {
  const re = /^[a-z0-9][a-z0-9-]*$/
  assert.match(slugify(fallbackTitle("Fix the board parser bug now please")), re)
  assert.match(slugify(fallbackTitle("!!! ???")), re) // slugify falls back to "thread"
  assert.equal(slugify(fallbackTitle("one two three four five six seven")), "one-two-three-four-five-six")
})

test("resolveSlug: appends -N on collision", () => {
  const dir = tmp("fray-slug-")
  const frayDir = join(dir, ".fray")
  mkdirSync(frayDir, { recursive: true })
  assert.equal(resolveSlug(frayDir, "foo"), "foo")

  writeFileSync(join(frayDir, "foo.md"), "x")
  assert.equal(resolveSlug(frayDir, "foo"), "foo-2")

  writeFileSync(join(frayDir, "foo-2.md"), "x")
  assert.equal(resolveSlug(frayDir, "foo"), "foo-3")

  // A taken REGISTRY slug (a fileless session dispatch) also bumps — uniqueness spans rows, not just files.
  const taken = new Set(["bar", "bar-2"])
  assert.equal(resolveSlug(frayDir, "bar", (s) => taken.has(s)), "bar-3")
  assert.equal(resolveSlug(frayDir, "baz", (s) => taken.has(s)), "baz")
})

test("composePrompt: scratchpad orientation + custom instructions + task (no thread-ownership contract)", () => {
  const out = composePrompt("sid-123", "Do the thing.", "PREAMBLE_TEXT")
  // Session-first: the visible first message points at the scratchpad, NOT a .fray file to own. The
  // fixed worker prompt still rides --append-system-prompt (buildClaudeCommand), not this message.
  assert.ok(out.includes(".fray/threads/sid-123/scratch.md"))
  assert.ok(!out.includes("You are a dispatched worker agent"))
  assert.ok(!out.includes("You own")) // the old ownership contract is gone
  assert.ok(!out.includes("status: blocked"))
  assert.ok(out.includes("PROJECT INSTRUCTIONS (from the human operator):\nPREAMBLE_TEXT"))
  assert.ok(!composePrompt("s", "x", "").includes("PROJECT INSTRUCTIONS"))
  assert.ok(out.includes("TASK:\nDo the thing."))
})

test("scratchpadOrientation: scratchpad line always; PLAN line only when a plan is associated", () => {
  const bare = scratchpadOrientation("sid-1")
  assert.ok(bare.includes("SCRATCHPAD: .fray/threads/sid-1/scratch.md"))
  assert.ok(!bare.includes("PLAN:"))
  const withPlan = scratchpadOrientation("sid-1", ".fray/plans/p.md")
  assert.ok(withPlan.includes("SCRATCHPAD: .fray/threads/sid-1/scratch.md"))
  assert.ok(withPlan.includes("PLAN: .fray/plans/p.md"))
})

test("validPlanPath: accepts an existing .fray/plans/*.md; rejects bad shape / missing file / undefined", () => {
  const dir = tmp("fray-plan-")
  mkdirSync(join(dir, ".fray", "plans"), { recursive: true })
  writeFileSync(join(dir, ".fray", "plans", "ok.md"), "# ok")
  assert.equal(validPlanPath(dir, ".fray/plans/ok.md"), ".fray/plans/ok.md")
  assert.equal(validPlanPath(dir, ".fray/plans/missing.md"), null) // well-formed but no file
  assert.equal(validPlanPath(dir, "../secrets.md"), null) // wrong shape
  assert.equal(validPlanPath(dir, ".fray/plans/../../etc/passwd.md"), null) // traversal (has a '/')
  assert.equal(validPlanPath(dir, undefined), null)
})

test("buildClaudeCommand: pins session-id, permission mode, optional model/effort, worker system prompt", () => {
  const base = buildClaudeCommand({
    sessionId: "uuid-1",
    permissionMode: "acceptEdits",
    prompt: "hello",
    claudeBin: "sleep",
    workerPrompt: "", // disabled for the argv-shape assertion
  })
  assert.deepEqual(base, ["sleep", "--session-id", "uuid-1", "--permission-mode", "acceptEdits", "hello"])

  const full = buildClaudeCommand({
    sessionId: "uuid-2",
    permissionMode: "acceptEdits",
    model: "opus",
    effort: "high",
    prompt: "go",
    workerPrompt: "WORKER_NORMS",
  })
  // The worker norms ride --append-system-prompt-file (a path), not inline text — inline would blow
  // tmux's command-length limit. Assert the fixed head, the file-flag, the file CONTENT, and the
  // trailing prompt.
  assert.deepEqual(full.slice(0, 9), [
    "claude",
    "--session-id",
    "uuid-2",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "opus",
    "--effort",
    "high",
  ])
  assert.equal(full[9], "--append-system-prompt-file")
  assert.equal(systemPromptOf(full), "WORKER_NORMS")
  assert.equal(full[full.length - 1], "go")

  // A worker is NEVER spawned in interactive plan mode (no coherent headless semantics + softlock):
  // `plan` is coerced to the safe default `auto` in the argv, on both dispatch and resume.
  const planned = buildClaudeCommand({ sessionId: "u", permissionMode: "plan", prompt: "p", workerPrompt: "" })
  assert.deepEqual(planned, ["claude", "--session-id", "u", "--permission-mode", "auto", "p"])
  const rplan = buildClaudeResumeCommand({ sessionId: "s", permissionMode: "plan", message: "m", workerPrompt: "" })
  assert.deepEqual(rplan, ["claude", "--permission-mode", "auto", "-r", "s", "m"])

  // Default (no injection): the shipped WORKER_PROMPT.md rides --append-system-prompt-file.
  const dflt = buildClaudeCommand({ sessionId: "u", permissionMode: "auto", prompt: "p" })
  assert.ok(dflt.includes("--append-system-prompt-file"))
  assert.ok(systemPromptOf(dflt).startsWith("You are a dispatched worker agent"))
})

test("buildClaudeResumeCommand: -r <sessionId> with the follow-up + worker system prompt", () => {
  const cmd = buildClaudeResumeCommand({ sessionId: "sid", permissionMode: "acceptEdits", message: "more", workerPrompt: "" })
  assert.deepEqual(cmd, ["claude", "--permission-mode", "acceptEdits", "-r", "sid", "more"])
  // Resume re-carries the worker norms (system prompt is rebuilt per invocation) via the file flag.
  const dflt = buildClaudeResumeCommand({ sessionId: "sid", permissionMode: "auto", message: "m" })
  assert.ok(dflt.includes("--append-system-prompt-file"))
  const system = systemPromptOf(dflt)
  assert.ok(system.startsWith("You are a dispatched worker agent"))
  // A dead-session follow-up rebuilds the system prompt, so the awaiting re-entry invariant must ride
  // the ACTUAL `claude -r` invocation—not live only in a companion skill the worker may not reload.
  assert.match(system, /back to awaiting/)
  assert.match(system, /NEVER say it is "already parked"/)
  assert.match(system, /MUST re-emit a fresh terminal/)
})

test("build*Command: extraSystemPrompt is appended AFTER the worker norms in the system prompt", () => {
  const scratch = "SCRATCHPAD: .fray/threads/u/scratch.md — memory"
  const disp = buildClaudeCommand({ sessionId: "u", permissionMode: "auto", prompt: "p", workerPrompt: "WORKER", extraSystemPrompt: scratch })
  const dSys = systemPromptOf(disp)
  assert.ok(dSys.startsWith("WORKER"))
  assert.ok(dSys.includes(scratch))
  // Same seam on resume — the scratchpad orientation must survive a session bounce.
  const res = buildClaudeResumeCommand({ sessionId: "s", permissionMode: "auto", message: "m", workerPrompt: "WORKER", extraSystemPrompt: scratch })
  const rSys = systemPromptOf(res)
  assert.ok(rSys.startsWith("WORKER"))
  assert.ok(rSys.includes(scratch))
})

test("dispatch: writes a scratchpad (not a thread file), argv carries the scratchpad, stores an open row", async () => {
  const h = dispatcherHarness()
  const { slug, sessionId } = await h.dispatcher.dispatch({ prompt: "Do the thing.", model: "opus", effort: "high" })

  // Session-first: NO .fray/<slug>.md thread file is written on dispatch.
  assert.ok(!existsSync(join(h.dir, ".fray", `${slug}.md`)), "no thread file written")

  // The scratchpad is provisioned with the conventional skeleton.
  const scratch = join(h.dir, ".fray", "threads", sessionId, "scratch.md")
  assert.ok(existsSync(scratch), "scratchpad file created")
  const body = readFileSync(scratch, "utf8")
  assert.ok(body.startsWith("# Scratchpad — "))
  assert.ok(body.includes("## Task list"))
  assert.ok(body.includes("## Shared context"))
  assert.ok(body.includes("## Notes"))

  // argv: the SCRATCHPAD orientation rides the system prompt; the user message carries the path + TASK
  // and NONE of the retired thread-ownership contract.
  const cmd = h.spawned[0].cmd
  assert.ok(systemPromptOf(cmd).includes(`SCRATCHPAD: .fray/threads/${sessionId}/scratch.md`))
  const userPrompt = cmd[cmd.length - 1]
  assert.ok(userPrompt.includes(`.fray/threads/${sessionId}/scratch.md`))
  assert.ok(userPrompt.includes("TASK:\nDo the thing."))
  assert.ok(!userPrompt.includes("You own"))
  assert.equal(h.spawned[0].env?.FRAY_UI_THREAD, slug)

  // The row is stored open with no plan association by default.
  const row = h.storage.getSession(slug)
  assert.equal(row?.session_id, sessionId)
  assert.equal(row?.state, "open")
  assert.equal(row?.plan_path, null)
  assert.equal(row?.model, "opus", "the dispatch model is pinned on the session row")
  assert.equal(row?.effort, "high", "the dispatch effort is pinned on the session row")
  assert.equal(row?.permission_mode, "auto", "the concrete launch permission is pinned on the session row")
})

test("dispatch: a valid planPath is stored + named in the system prompt; invalid ones are ignored", async () => {
  const h = dispatcherHarness()
  mkdirSync(join(h.dir, ".fray", "plans"), { recursive: true })
  writeFileSync(join(h.dir, ".fray", "plans", "my-plan.md"), "# My Plan\n")

  const ok = await h.dispatcher.dispatch({ prompt: "go", planPath: ".fray/plans/my-plan.md" })
  assert.equal(h.storage.getSession(ok.slug)?.plan_path, ".fray/plans/my-plan.md")
  assert.ok(systemPromptOf(h.spawned[0].cmd).includes("PLAN: .fray/plans/my-plan.md"))

  // Missing file → ignored (stored null); traversal shape → ignored.
  const gone = await h.dispatcher.dispatch({ prompt: "go2", planPath: ".fray/plans/nope.md" })
  assert.equal(h.storage.getSession(gone.slug)?.plan_path, null)
  const bad = await h.dispatcher.dispatch({ prompt: "go3", planPath: "../etc/passwd" })
  assert.equal(h.storage.getSession(bad.slug)?.plan_path, null)
})

test("adopt: requires the legacy file, provisions a scratchpad, orientation is context-not-contract", async () => {
  const h = dispatcherHarness({ ...defaultSettings(), model: "sonnet", effort: "xhigh" })
  // No file → clean rejection.
  await assert.rejects(h.dispatcher.adopt("adopt-fixture"), /thread is not available for adoption/)

  mkdirSync(join(h.dir, ".fray"), { recursive: true })
  writeFileSync(join(h.dir, ".fray", "adopt-fixture.md"), "---\ntitle: x\nstatus: active\n---\n\n## Goal\n\ng\n")
  const { slug, sessionId } = await h.dispatcher.adopt("adopt-fixture", "keep going")
  assert.equal(slug, "adopt-fixture")

  // Scratchpad provisioned even for an adopted thread.
  assert.ok(existsSync(join(h.dir, ".fray", "threads", sessionId, "scratch.md")))

  // System prompt: scratchpad orientation + the adoption note framing the file as CONTEXT, not a contract.
  const sys = systemPromptOf(h.spawned[0].cmd)
  assert.ok(sys.includes(`SCRATCHPAD: .fray/threads/${sessionId}/scratch.md`))
  assert.ok(sys.includes("CONTEXT, not a contract"))
  assert.ok(sys.includes("adopt-fixture.md"))
  const row = h.storage.getSession(slug)
  assert.equal(row?.model, "sonnet", "adoption pins the model default used for its new session")
  assert.equal(row?.effort, "xhigh", "adoption pins the effort default used for its new session")
  assert.equal(row?.permission_mode, "auto", "adoption pins the concrete launch permission")
})

test("cwdSlug: replaces / and . with - (Claude Code project-log convention)", () => {
  assert.equal(cwdSlug("/Users/x/Documents/projects/fray"), "-Users-x-Documents-projects-fray")
  assert.equal(cwdSlug("/Users/x/.workshell/wt"), "-Users-x--workshell-wt")
})

// ---- Codex dispatch wiring (Codex-support epic, Phase 2): the COMPOSED spawn orchestration ----
// createCodexBackend + createClaudeBackend behind a backendFor resolver (mirrors context.ts). A codex
// dispatch must: pre-arm the cwd trust gate, spawn the codex argv (worker contract in the prompt), then
// sentinel-discover the rollout id and PIN it on the row (session_id stays the fray key). A claude
// dispatch through the SAME dispatcher is byte-identical — no trust write, backend stays 'claude'.
function codexDispatcherHarness() {
  const dir = tmp("fray-dispatch-codex-")
  const codexHome = tmp("fray-codexhome-")
  const storage = createStorage(join(dir, "ui.db"))
  const project: Project = { dir, id: "id", name: "test", label: "o/test", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const spawned: {
    slug: string
    cmd: string[]
    cwd: string
    env?: Record<string, string>
    promptText?: string
    promptMode?: number
  }[] = []
  const CODEX_ID = "019f4e0a-cafe-7891-9cbf-00000000abcd"
  // A spawn that SIMULATES codex: extract the per-dispatch sentinel from the prompt (codex spawns via an
  // `sh -c` wrapper that reads the prompt from a temp FILE — the last argv element — so read it) and write
  // a fresh rollout carrying it (+ a session_meta id/cwd) so the dispatcher's sentinel discovery resolves
  // it. A claude spawn (no `fray-session:` sentinel) writes nothing — the resolver stayed off codex.
  const spawn = (slug: string, cmd: string[], cwd: string, env?: Record<string, string>) => {
    const last = cmd[cmd.length - 1] ?? ""
    const promptText = cmd[0] === "sh" ? readFileSync(last, "utf8") : last
    const promptMode = cmd[0] === "sh" ? statSync(last).mode & 0o777 : undefined
    spawned.push({ slug, cmd, cwd, env, promptText, promptMode })
    const sentinel = promptText.match(/fray-session:[0-9a-f-]+/)?.[0]
    if (!sentinel) return fakePaneIdentity(spawned.length)
    const sdir = join(codexHome, "sessions", "2026", "07", "10")
    mkdirSync(sdir, { recursive: true })
    const meta = JSON.stringify({ timestamp: "2026-07-10T22:00:00.000Z", type: "session_meta", payload: { session_id: CODEX_ID, cwd } })
    const um = JSON.stringify({ timestamp: "2026-07-10T22:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: `do the task <!-- ${sentinel} -->` } })
    writeFileSync(join(sdir, `rollout-2026-07-10T22-00-00-${CODEX_ID}.jsonl`), meta + "\n" + um + "\n")
    return fakePaneIdentity(spawned.length)
  }
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: join(dir, "logs") })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const board: BoardManager = {
    snapshot: async () => ({}) as never,
    currentSeq: () => 0,
    rebuild: async () => ({}) as never,
    refresh: () => ({}) as never,
    start: async () => {},
    stop: async () => {},
  }
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => defaultSettings(),
    spawn,
    ensureServer: () => {},
    backendFor,
    codexHome,
  })
  return { dir, codexHome, storage, project, spawned, dispatcher, CODEX_ID }
}

test("dispatch(codex): pre-arms cwd trust, spawns the codex argv, and pins the discovered rollout id", async () => {
  const h = codexDispatcherHarness()
  const { slug, sessionId } = await h.dispatcher.dispatch({ prompt: "Wire codex." }, { backend: "codex" })

  // 1. trust pre-arm: the global codex config gained a trusted entry for the (realpath'd) cwd.
  const cfg = readFileSync(join(h.codexHome, "config.toml"), "utf8")
  assert.ok(cfg.includes('trust_level = "trusted"'), "ensureCwdTrusted wrote a trusted entry")
  assert.ok(cfg.includes(`[projects."${realpathSync(h.project.dir)}"]`), "trusted entry keys on the realpath'd cwd")

  // 2. codex argv: the ~18KB worker contract would blow tmux's command-length limit inline, so the
  //    prompt is spilled to a temp FILE and codex spawns via a short `sh -c` wrapper that reads it. The
  //    tmux command line stays tiny; the full contract + sentinel ride the file (codex's prompt arg).
  const cmd = h.spawned[0].cmd
  assert.equal(cmd[0], "sh")
  assert.equal(cmd[1], "-c")
  const script = cmd[2]
  assert.ok(script.includes(`exec 'codex' '--cd' '${h.project.dir}'`), "the wrapper execs the real codex argv")
  assert.ok(script.includes("'-a' 'never'"), "approvals never (unattended)")
  const promptFile = cmd[cmd.length - 1]
  const promptText = h.spawned[0].promptText!
  assert.ok(promptText.includes(`fray-session:${sessionId}`), "the discovery sentinel rides the prompt file")
  assert.ok(promptText.length > 10_000, "the ~18KB worker contract rides the prompt file")
  assert.equal(h.spawned[0].promptMode, 0o600, "the full task/contract is owner-readable only while Codex consumes it")
  assert.equal(existsSync(promptFile), false, "verified discovery removes the successful dispatch's prompt transport")
  assert.ok(cmd.join(" ").length < 2_000, "the tmux command line stays well under the length limit")

  // 2b. the contract a codex worker receives is the CODEX variant — codex's own session/wake +
  //     model/effort/sandbox framing, and NONE of the Claude-Code-only guidance it can't act on
  //     (the Agent tool + fray:<model>-<effort> profiles, "claude session"/`claude -r`).
  assert.ok(promptText.includes("a top-level `codex` session"), "codex worker gets the codex session framing")
  assert.ok(promptText.includes("## Own one task"), "codex worker gets the one-task leaf section")
  assert.ok(promptText.includes("## Bounded native delegation"), "codex worker retains explicitly authorized delegation")
  assert.ok(promptText.includes("FRAY TITLE TRANSPORT (required)"), "the final-answer title transport survives the prompt-file wrapper")
  assert.ok(promptText.indexOf("TASK:\nWire codex.") < promptText.indexOf("FRAY TITLE TRANSPORT"), "the title reminder stays after the human task, where an exact-output task cannot eclipse it")
  assert.ok(promptText.indexOf("FRAY TITLE TRANSPORT") < promptText.indexOf(`<!-- fray-session:${sessionId} -->`), "the sentinel remains the final transport segment")
  assert.ok(!promptText.includes("## Sub-agents"), "codex worker never gets the Claude Sub-agents section")
  assert.ok(!promptText.includes("fray:<model>-<effort>"), "codex worker never gets the fray profile ladder")
  assert.ok(!promptText.includes("claude -r"), "codex worker never gets the `claude -r` wake")

  // 3. the row: backend pinned codex, agent_session_id = the discovered rollout id, session_id = the
  //    fray key (unchanged — the scratchpad lives under it).
  const rowdb = h.storage.getSession(slug)!
  assert.equal(rowdb.backend, "codex")
  assert.equal(rowdb.agent_session_id, h.CODEX_ID, "the discovered codex rollout id is pinned")
  assert.equal(rowdb.session_id, sessionId, "session_id stays the fray-minted key")
  assert.equal(rowdb.permission_mode, "bypassPermissions", "every created codex worker launches full-access (WORKER_DISPATCH_PERMISSION)")
  assert.ok(existsSync(join(h.dir, ".fray", "threads", sessionId, "scratch.md")), "scratchpad keyed on the fray session_id")
})

test("dispatch(codex): concurrent same-cwd starts wait for their own delayed sentinel and survive storage restart", async () => {
  const dir = tmp("fray-dispatch-codex-race-")
  const codexHome = tmp("fray-codexhome-race-")
  const dbPath = join(dir, "ui.db")
  const storage = createStorage(dbPath)
  const project: Project = { dir, id: "race-id", name: "race", label: "o/race", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => ({}),
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: join(dir, "logs") })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const ids = {
    "race-a": "019f-race-a-native",
    "race-b": "019f-race-b-native",
  } as const
  const launches = new Map<string, { sentinel: string; path: string }>()
  const tied = new Date()

  const spawn = (slug: string, cmd: string[], cwd: string) => {
    const prompt = readFileSync(cmd.at(-1)!, "utf8")
    const sentinel = prompt.match(/fray-session:[0-9a-f-]+/)?.[0]
    assert.ok(sentinel)
    const shard = slug === "race-a" ? ["2026", "07", "11"] : ["2026", "07", "12"]
    const rolloutDir = join(codexHome, "sessions", ...shard)
    const nativeId = ids[slug as keyof typeof ids]
    const path = join(rolloutDir, `rollout-${slug}-${nativeId}.jsonl`)
    mkdirSync(rolloutDir, { recursive: true })
    launches.set(slug, { sentinel, path })

    // B materializes completely while A is in its first poll sleep. With the old cwd fallback, A's
    // next poll immediately stole B. A deliberately has no file until the second sleep below.
    if (slug === "race-b") {
      writeFileSync(
        path,
        [
          JSON.stringify({ type: "session_meta", payload: { session_id: nativeId, cwd } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `B <!-- ${sentinel} -->` } }),
        ].join("\n") + "\n",
      )
      utimesSync(path, tied, tied)
    }
    return fakePaneIdentity(slug === "race-a" ? 41 : 42)
  }

  let sleeps = 0
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => defaultSettings(),
    spawn,
    ensureServer: () => {},
    backendFor,
    codexHome,
    codexDiscoveryTimeoutMs: 20,
    codexDiscoveryIntervalMs: 1,
    codexDiscoverySleep: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      sleeps++
      if (sleeps !== 2) return
      const launch = launches.get("race-a")!
      writeFileSync(
        launch.path,
        [
          JSON.stringify({ type: "session_meta", payload: { session_id: ids["race-a"], cwd: project.dir } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `A <!-- ${launch.sentinel} -->` } }),
        ].join("\n") + "\n",
      )
      utimesSync(launch.path, tied, tied)
    },
  })

  const [a, b] = await Promise.all([
    dispatcher.dispatch({ slug: "race-a", prompt: "First concurrent Codex." }, { backend: "codex" }),
    dispatcher.dispatch({ slug: "race-b", prompt: "Second concurrent Codex." }, { backend: "codex" }),
  ])
  assert.equal(a.slug, "race-a")
  assert.equal(b.slug, "race-b")
  assert.equal(storage.getSession("race-a")?.agent_session_id, ids["race-a"])
  assert.equal(storage.getSession("race-b")?.agent_session_id, ids["race-b"])
  assert.notEqual(storage.getSession("race-a")?.agent_session_id, storage.getSession("race-b")?.agent_session_id)

  storage.close()
  const reopened = createStorage(dbPath)
  assert.equal(reopened.getSession("race-a")?.agent_session_id, ids["race-a"], "A remains pinned after control-plane restart")
  assert.equal(reopened.getSession("race-b")?.agent_session_id, ids["race-b"], "B remains pinned after control-plane restart")
  reopened.close()
})

test("dispatch(codex): sentinel timeout stops only its unregistered worker and leaves no resumable lie", async () => {
  const dir = tmp("fray-dispatch-codex-timeout-")
  const codexHome = tmp("fray-codexhome-timeout-")
  const storage = createStorage(join(dir, "ui.db"))
  const project: Project = { dir, id: "timeout-id", name: "timeout", label: "o/timeout", stateDir: dir, cwdSlug: cwdSlug(dir) }
  let rebuilds = 0
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => void rebuilds++,
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: join(dir, "logs") })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const killed: string[] = []
  let promptFile = ""
  let fraySessionId = ""
  const spawn = (slug: string, cmd: string[], cwd: string) => {
    promptFile = cmd.at(-1)!
    const prompt = readFileSync(promptFile, "utf8")
    fraySessionId = prompt.match(/fray-session:([0-9a-f-]+)/)?.[1] ?? ""
    assert.ok(fraySessionId)
    const rolloutDir = join(codexHome, "sessions", "2026", "07", "12")
    mkdirSync(rolloutDir, { recursive: true })
    // A complete same-cwd neighbor plus this launch's metadata-without-sentinel must never be accepted.
    writeFileSync(
      join(rolloutDir, "rollout-neighbor.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "unrelated-native", cwd } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "neighbor <!-- fray-session:someone-else -->" } }),
      ].join("\n") + "\n",
    )
    writeFileSync(
      join(rolloutDir, `rollout-${slug}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { session_id: "own-native-without-proof", cwd } }) + "\n",
    )
    return fakePaneIdentity(51)
  }
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => defaultSettings(),
    spawn,
    ensureServer: () => {},
    backendFor,
    codexHome,
    killSession: (slug) => void killed.push(slug),
    codexDiscoveryTimeoutMs: 2,
    codexDiscoveryIntervalMs: 1,
    codexDiscoverySleep: async () => {},
  })

  await assert.rejects(
    dispatcher.dispatch({ slug: "timeout-owner", prompt: "This rollout never records its sentinel." }, { backend: "codex" }),
    /could not verify its rollout within 2ms.*stopped; please retry/i,
  )
  assert.deepEqual(killed, ["timeout-owner"], "cleanup targets only the uniquely spawned slug")
  assert.equal(storage.getSession("timeout-owner"), undefined, "no row can later resume with a false/null native id")
  assert.equal(storage.allSessions().length, 0)
  assert.equal(rebuilds, 0, "a failed dispatch never publishes a phantom row")
  assert.equal(existsSync(join(dir, ".fray", "threads", fraySessionId, "scratch.md")), false, "scratch artifact is rolled back")
  assert.equal(existsSync(promptFile), false, "prompt transport artifact is rolled back")
})

test("dispatch(claude) through the same resolver is UNCHANGED — no trust write, backend stays claude", async () => {
  const h = codexDispatcherHarness()
  const { slug } = await h.dispatcher.dispatch({ prompt: "Business as usual." }) // no opts → claude

  assert.ok(!existsSync(join(h.codexHome, "config.toml")), "a claude dispatch never touches the codex trust config")
  const rowdb = h.storage.getSession(slug)!
  assert.equal(rowdb.backend, "claude", "backend stays the column default")
  assert.equal(rowdb.agent_session_id ?? null, null, "no codex rollout id pinned")
  assert.equal(h.spawned[0].cmd[0], "claude", "the claude argv builder ran")
})
