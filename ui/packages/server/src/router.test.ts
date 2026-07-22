import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { mountRouter } from "@fray-ui/rpc/server"
import type { BoardSnapshot, Settings, ThreadView } from "@fray-ui/shared"
import type { BoardManager } from "./board.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import {
  createRouter,
  completeRegisteredThread,
  completionNeedsConfirmation,
  githubDispatcherRequest,
  hasPendingPermissionChange,
  hasUnresolvedBackgroundOps,
  stopAndForgetRegisteredRuntime,
  stopRegisteredRuntime,
  stopRuntimeBySlug,
  validateGithubDispatchProfile,
} from "./router.ts"
import { createStorage, type AdoptionClaimRow, type SessionRow } from "./storage.ts"
import type { AdoptionPaneLookup, PaneIdentity, PaneSnapshot } from "./tmux.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { createPermissionController } from "./permission-controller.ts"
import { providerResumeCommand, shellQuote } from "./external-terminal.ts"
import { awaitingFenceIdentity } from "./awaiting.ts"

test("provider resume command is shell-safe", () => {
  assert.equal(shellQuote("fray's socket"), "'fray'\"'\"'s socket'")
  assert.equal(providerResumeCommand("codex", "/work/it's fray", "session-id"), "cd '/work/it'\"'\"'s fray' && codex resume 'session-id'")
  assert.equal(providerResumeCommand("claude", "/work/fray", "session-id"), "cd '/work/fray' && claude --resume 'session-id'")
})

const noopTailer: Tailer = {
  get: () => undefined,
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

test("GitHub dispatch payload preserves the exact captured backend profile (no permission passthrough)", () => {
  const batch = {
    items: [{ kind: "pr" as const, number: 91 }],
    backend: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "ultra" as const,
  }
  assert.deepEqual(
    githubDispatcherRequest(batch, { prompt: "review", title: "Review owner/repo#91", slug: "review-owner-repo-91" }),
    {
      payload: {
        prompt: "review",
        title: "Review owner/repo#91",
        slug: "review-owner-repo-91",
        backend: "codex",
        model: "gpt-5.6-sol",
        effort: "ultra",
      },
      options: { backend: "codex" },
    },
  )
})

test("GitHub dispatch validation rejects invalid pairs visibly and ignores permission entirely", () => {
  const base = {
    items: [{ kind: "issue" as const, number: 1 }],
    backend: "claude" as const,
    model: "opus",
    effort: "high" as const,
  }
  assert.doesNotThrow(() => validateGithubDispatchProfile(base))
  assert.throws(
    () => validateGithubDispatchProfile({ ...base, effort: "ultra" }),
    /Unsupported claude model\/effort pair: opus \/ ultra/,
  )
  // Permission is not part of the captured tuple: dispatch stamps the fixed non-interactive mode
  // server-side, so even a stale client-sent value passes validation untouched.
  assert.doesNotThrow(() => validateGithubDispatchProfile({ ...base, permissionMode: "plan" }))
})

function row(slug: string): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-12T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 1,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: null,
  }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "fray-router-permission-"))
  const project: Project = { dir, id: "router-permission", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"))
  const telemetry = new Map<string, SessionTelemetry>()
  const tailer: Tailer = {
    ...noopTailer,
    get: (slug) => telemetry.get(slug),
  }
  const snapshot: BoardSnapshot = {
    projectDir: dir,
    projectName: "test",
    projectLabel: "test",
    frayActive: false,
    threads: [],
    errors: [],
    warnings: [],
  }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => {
      refreshes++
      return snapshot
    },
    start: async () => {},
    stop: async () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  const settings = { permissionMode: "auto" } as unknown as Settings
  const permissionController = createPermissionController({
    storage,
    tailer,
    board,
    terminal: {
      isLive: () => false,
      capturePane: () => "",
      capturePaneEscaped: () => "",
      sendLiteral: () => {},
      sendKey: () => {},
    },
  })
  let adoptCalls = 0
  let schedulerChanges = 0
  // createRouter is lazy: unrelated procedures do not read the omitted context fields. Keep this
  // focused on the permission route's real storage/board/backend dependencies.
  const ctx = {
    project,
    storage,
    board,
    tailer,
    backendFor: () => backend,
    getSettings: () => settings,
    permissionController,
    scheduler: {
      start: () => {},
      stop: async () => {},
      tick: async () => {},
      waitChanged: () => { schedulerChanges++ },
    },
    dispatcher: {
      dispatch: async () => ({ slug: "dispatched", sessionId: "sid-dispatched" }),
      adopt: async (slug: string) => {
        adoptCalls++
        return { slug, sessionId: `sid-${slug}` }
      },
    },
  } as unknown as AppContext
  const addExitedThread = (slug: string) =>
    snapshot.threads.push({
      id: slug,
      title: slug,
      status: "active",
      hasPlan: false,
      mechanism: null,
      humanBlocked: false,
      ready: false,
      dependsOn: [],
      externalDeps: [],
      agents: [],
      errors: [],
      warnings: [],
      runtime: "exited",
      unread: false,
      archived: false,
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      kind: "session",
      foreign: false,
    } satisfies ThreadView)
  return {
    dir, storage, board, snapshot, telemetry, router: createRouter(ctx), addExitedThread,
    refreshes: () => refreshes, adoptCalls: () => adoptCalls, schedulerChanges: () => schedulerChanges,
  }
}

test("threadTerminalCommand offers the verified provider resume command in every runtime state", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("codex-resume"))
    h.storage.setBackend("codex-resume", "codex")
    h.storage.setAgentSession("codex-resume", "codex-rollout-id")
    h.addExitedThread("codex-resume")
    h.snapshot.threads.at(-1)!.backend = "codex"

    const expected = { command: `cd '${h.dir}' && codex resume 'codex-rollout-id'`, mode: "resume", reason: null }

    h.board.snapshot = async () => {
      throw new Error("the copy path must not rebuild the board")
    }
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-resume" } }),
      expected,
      "Codex resumes its provider rollout ID directly from the owned registry row",
    )

    // Resuming a live session in another terminal is safe + supported, so the command is offered while
    // Fray still drives it — no paternalistic "wait for it to exit" block.
    h.snapshot.threads.at(-1)!.runtime = "turn-idle"
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-resume" } }),
      expected,
      "a live/turn-idle session still yields the resume command",
    )

    // Codex before its rollout id is discovered has no resumable native id — the Fray UUID would not
    // resume it, so fail closed with an explanatory reason rather than a broken command.
    h.storage.upsertSession(row("codex-pending"))
    h.storage.setBackend("codex-pending", "codex")
    h.addExitedThread("codex-pending")
    h.snapshot.threads.at(-1)!.backend = "codex"
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-pending" } }),
      {
        command: null,
        mode: "unavailable",
        reason: "Codex hasn't reported its resumable session id yet — it appears once the first turn begins.",
      },
    )

    await assert.rejects(
      h.router.threadTerminalCommand.handler({ input: { slug: "foreign-or-legacy" } }),
      /No Fray-owned terminal session is available/,
    )
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("planBody RPC returns only a securely resolved direct plan file", async () => {
  const h = harness()
  const plans = join(h.dir, ".fray", "plans")
  const outside = join(h.dir, "outside.md")
  try {
    mkdirSync(plans, { recursive: true })
    writeFileSync(join(plans, "safe.md"), "# Safe plan\n")
    writeFileSync(outside, "outside\n")
    symlinkSync(outside, join(plans, "linked.md"))

    assert.deepEqual(
      await h.router.planBody.handler({ input: { path: ".fray/plans/safe.md" } }),
      { markdown: "# Safe plan\n" },
    )
    for (const path of [
      ".fray/plans/linked.md",
      ".fray/plans/../../outside.md",
      ".fray/plans/nested/safe.md",
      "/absolute.md",
    ]) {
      assert.deepEqual(await h.router.planBody.handler({ input: { path } }), { markdown: "" }, path)
    }
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("auto-titled sessions never read or mutate a same-slug legacy file through RPCs", async () => {
  const h = harness()
  const fray = join(h.dir, ".fray")
  const regular = join(fray, "auto-file.md")
  const repair = join(fray, "auto-repair.md")
  const external = join(h.dir, "outside.md")
  const linked = join(fray, "auto-link.md")
  const regularBody = "---\ntitle: Planted\nstatus: active\n---\nregular sentinel\n"
  try {
    mkdirSync(fray)
    writeFileSync(regular, regularBody)
    writeFileSync(repair, "repair sentinel\n")
    writeFileSync(external, "external sentinel\n")
    symlinkSync(external, linked)
    for (const slug of ["auto-file", "auto-repair", "auto-link"]) {
      h.storage.upsertSession({ ...row(slug), title_auto: 1 })
    }
    h.addExitedThread("auto-file")

    assert.deepEqual(await h.router.threadBody.handler({ input: { slug: "auto-file" } }), { markdown: "" })
    assert.deepEqual(await h.router.threadBody.handler({ input: { slug: "auto-link" } }), { markdown: "" })

    for (const mutation of [
      () => h.router.archiveThread.handler({ input: { slug: "auto-file" } }),
      () => h.router.markComplete.handler({ input: { slug: "auto-file" } }),
      () => h.router.setThreadStatus.handler({ input: { slug: "auto-file", status: "done" } }),
      () => h.router.dismissThread.handler({ input: { slug: "auto-file" } }),
      () => h.router.repairThread.handler({ input: { file: "auto-repair.md" } }),
    ]) {
      await assert.rejects(mutation, /session-first threads do not own a legacy thread file/)
    }

    assert.equal(readFileSync(regular, "utf8"), regularBody)
    assert.equal(readFileSync(repair, "utf8"), "repair sentinel\n")
    assert.equal(readFileSync(external, "utf8"), "external sentinel\n")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("renameThread RPC: commits a trimmed human title for Codex without touching the running agent", async () => {
  const h = harness()
  h.storage.upsertSession({ ...row("generated-slug"), title: "generated-slug", title_auto: 1, exited: 0 })
  h.storage.setBackend("generated-slug", "codex")
  const proc = h.router.renameThread
  const input = proc.input.parse({ slug: "generated-slug", title: "  Human-readable thread title  " })

  await proc.handler({ input })

  const saved = h.storage.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0)
  assert.equal(saved.exited, 0, "renaming metadata must not stop or reattach the live process")
  assert.equal(saved.backend, "codex")
  assert.equal(h.refreshes(), 1, "the saved title is published immediately through a board delta")
  h.storage.close()
})

test("adoptThread RPC rejects malformed or extended identities before handler dispatch", () => {
  const h = harness()
  const proc = h.router.adoptThread
  assert.equal(proc.input.safeParse({ slug: "valid-thread", message: "continue" }).success, true)
  for (const slug of ["../escape", "/absolute", ".", "%2e%2e", "Ünicode", "line\nbreak", "-option", "a".repeat(201)]) {
    assert.equal(proc.input.safeParse({ slug }).success, false, JSON.stringify(slug))
  }
  assert.equal(proc.input.safeParse({ slug: "valid-thread", unexpected: true }).success, false)
  h.storage.close()
})

test("mounted adoptThread HTTP RPC returns 400 with zero dispatcher calls for hostile input", async () => {
  const h = harness()
  const app = new Hono()
  mountRouter(app, "/rpc", h.router)
  for (const input of [{ slug: "../escape" }, { slug: "safe", extra: true }, { slug: "a".repeat(201) }]) {
    const response = await app.request("http://localhost/rpc/adoptThread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    assert.equal(response.status, 400, JSON.stringify(input))
  }
  assert.equal(h.adoptCalls(), 0)
  h.storage.close()
})

test("renameThread RPC: empty titles are rejected and rowless/foreign threads remain read-only", async () => {
  const h = harness()
  const proc = h.router.renameThread
  assert.equal(proc.input.safeParse({ slug: "t", title: "   " }).success, false)
  assert.equal(proc.input.safeParse({ slug: "t", title: "x".repeat(201) }).success, false)
  await assert.rejects(proc.handler({ input: { slug: "external", title: "No row" } }), /not editable/)
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

test("aiRenameThread RPC: Codex sessions are manual-only", async () => {
  const h = harness()
  h.storage.upsertSession({ ...row("codex-title"), exited: 0 })
  h.storage.setBackend("codex-title", "codex")
  await assert.rejects(h.router.aiRenameThread.handler({ input: { slug: "codex-title" } }), /Codex does not support AI rename/)
  assert.equal(h.storage.getSession("codex-title")?.title, "codex-title")
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

test("setThreadPermission RPC: validates input and persists an exited thread override for next resume", async () => {
  const h = harness()
  h.storage.upsertSession(row("rpc-permission"))
  h.addExitedThread("rpc-permission")
  const proc = h.router.setThreadPermission
  assert.equal(proc.input.safeParse({ slug: "rpc-permission", permissionMode: "bogus" }).success, false)
  const result = await proc.handler({ input: { slug: "rpc-permission", permissionMode: "bypassPermissions" } })
  assert.deepEqual(result, { effect: "next-resume" })
  assert.equal(h.storage.getSession("rpc-permission")?.permission_mode, "bypassPermissions")
  h.storage.close()
})

test("setThreadPermission RPC: rowless/foreign-style threads are read-only", async () => {
  const h = harness()
  await assert.rejects(
    h.router.setThreadPermission.handler({ input: { slug: "external", permissionMode: "bypassPermissions" } }),
    /not editable/,
  )
  h.storage.close()
})

test("setThreadSnooze RPC validates canonical future UTC and persists any owned open queue card", async () => {
  const h = harness()
  const slug = "rpc-snooze"
  h.storage.upsertSession(row(slug))
  h.addExitedThread(slug)
  const thread = h.snapshot.threads.at(-1)!
  thread.needsYou = true // ordinary clean rest is queue-worthy but still snoozable
  thread.crashed = false
  const proc = h.router.setThreadSnooze
  const sessionId = `sid-${slug}`
  for (const until of ["tomorrow", "2026-07-14T08:45:00Z", "2026-07-14 08:45:00.000Z", "2026-07-14T08:45:00.000+00:00", "2099-02-31T08:45:00.000Z"]) {
    assert.equal(proc.input.safeParse({ slug, sessionId, until }).success, false, until)
  }
  assert.equal(proc.input.safeParse({ slug, sessionId, until: "2099-07-14T08:45:00.000Z", extra: true }).success, false)
  await assert.rejects(
    proc.handler({ input: { slug, sessionId, until: "2000-01-01T00:00:00.000Z" } }),
    /future/,
  )

  const exact = "2099-07-14T08:45:00.000Z"
  await proc.handler({ input: { slug, sessionId, until: exact } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, exact)
  assert.equal(h.refreshes(), 1)

  thread.pendingQuestion = true
  const replacement = "2099-07-15T08:45:00.000Z"
  await proc.handler({ input: { slug, sessionId, until: replacement } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, replacement, "an unresolved question remains explicitly snoozable")

  await proc.handler({ input: { slug, sessionId, until: null } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, null, "wake-now remains available with the same validation contract")
  h.storage.close()
})

test("confirmAwaiting RPC arms only the exact current final-message generation", async () => {
  const h = harness()
  const reviewSlug = "confirm-review"
  const timerSlug = "confirm-timer"
  const reviewAt = "2099-07-14T08:00:00.000Z"
  const timerAt = "2099-07-14T08:05:00.000Z"
  const review = { kind: "github-review" as const, value: "acme/app#391" }
  const timer = { kind: "timer" as const, value: "2099-07-15T08:45:00.000Z" }
  for (const slug of [reviewSlug, timerSlug]) h.storage.upsertSession(row(slug))
  h.addExitedThread(timerSlug)
  h.telemetry.set(reviewSlug, {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastFence: { kind: "awaiting", body: "Waiting for review.", hint: review, at: reviewAt },
    lastAssistantAt: reviewAt,
    lastActivityAt: "2099-07-14T08:01:00.000Z",
  })
  h.telemetry.set(timerSlug, {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastFence: { kind: "awaiting", body: "Re-check later.", hint: timer, at: timerAt },
    lastAssistantAt: timerAt,
    lastActivityAt: "2099-07-14T08:06:00.000Z",
  })

  const proc = h.router.confirmAwaiting
  assert.equal(proc.input.safeParse({ slug: reviewSlug, sessionId: `sid-${reviewSlug}`, fenceAt: reviewAt }).success, false)
  assert.equal(proc.input.safeParse({ slug: reviewSlug, sessionId: `sid-${reviewSlug}`, fenceAt: reviewAt, hint: review, extra: true }).success, false)

  await proc.handler({ input: { slug: reviewSlug, sessionId: `sid-${reviewSlug}`, fenceAt: reviewAt, hint: review } })
  const reviewRow = h.storage.getSession(reviewSlug)!
  assert.equal(reviewRow.awaiting_fence_id, awaitingFenceIdentity(review, reviewAt))
  assert.ok(reviewRow.awaiting_confirmed_at)
  assert.equal(reviewRow.snoozed_until, null, "a review watcher is activity-based, not a synthetic timer")

  await proc.handler({ input: { slug: timerSlug, sessionId: `sid-${timerSlug}`, fenceAt: timerAt, hint: timer } })
  const timerRow = h.storage.getSession(timerSlug)!
  assert.equal(timerRow.awaiting_fence_id, awaitingFenceIdentity(timer, timerAt))
  assert.ok(timerRow.awaiting_confirmed_at)
  assert.equal(timerRow.snoozed_until, timer.value, "a timer confirmation atomically parks to its exact instant")
  assert.equal(h.refreshes(), 2)
  assert.equal(h.schedulerChanges(), 2, "each confirmation immediately updates the scheduler")

  await h.router.setThreadSnooze.handler({ input: { slug: timerSlug, sessionId: `sid-${timerSlug}`, until: null } })
  const wokenRow = h.storage.getSession(timerSlug)!
  assert.equal(wokenRow.snoozed_until, null)
  assert.equal(wokenRow.awaiting_fence_id, null, "Wake now cancels the durable timer registration")
  assert.equal(wokenRow.awaiting_confirmed_at, null)
  assert.equal(h.refreshes(), 3)

  h.storage.close()
  rmSync(h.dir, { recursive: true, force: true })
})

test("confirmAwaiting RPC rejects stale cards, changed hints, busy turns, and elapsed timers", async () => {
  const h = harness()
  const slug = "confirm-stale"
  const oldAt = "2099-07-14T08:00:00.000Z"
  const currentAt = "2099-07-14T09:00:00.000Z"
  const oldHint = { kind: "github-review" as const, value: "acme/app#390" }
  const currentHint = { kind: "github-review" as const, value: "acme/app#391" }
  h.storage.upsertSession(row(slug))
  h.telemetry.set(slug, {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastFence: { kind: "awaiting", body: "Current.", hint: currentHint, at: currentAt },
    lastAssistantAt: currentAt,
    lastActivityAt: currentAt,
  })

  await assert.rejects(
    h.router.confirmAwaiting.handler({ input: { slug, sessionId: `sid-${slug}`, fenceAt: oldAt, hint: oldHint } }),
    /changed before it could be confirmed/,
  )
  assert.equal(h.storage.getSession(slug)?.awaiting_fence_id, null, "a stale click must not arm the newer fence")

  h.telemetry.get(slug)!.turn = "in-flight"
  await assert.rejects(
    h.router.confirmAwaiting.handler({ input: { slug, sessionId: `sid-${slug}`, fenceAt: currentAt, hint: currentHint } }),
    /no longer current/,
  )

  const elapsed = { kind: "timer" as const, value: "2000-01-01T00:00:00.000Z" }
  h.telemetry.set(slug, {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastFence: { kind: "awaiting", body: "Too late.", hint: elapsed, at: currentAt },
    lastAssistantAt: currentAt,
    lastActivityAt: currentAt,
  })
  await assert.rejects(
    h.router.confirmAwaiting.handler({ input: { slug, sessionId: `sid-${slug}`, fenceAt: currentAt, hint: elapsed } }),
    /already passed/,
  )
  assert.equal(h.storage.getSession(slug)?.awaiting_fence_id, null)

  h.storage.close()
  rmSync(h.dir, { recursive: true, force: true })
})

test("session-scoped lifecycle and follow-up actions cannot mutate a same-slug replacement", async () => {
  const h = harness()
  const slug = "replaced-action"
  h.storage.upsertSession({ ...row(slug), session_id: "current-session" })
  h.addExitedThread(slug)
  const stale = "old-session"

  const actions = [
    () => h.router.followUp.handler({ input: { slug, sessionId: stale, message: "stale steer" } }),
    () => h.router.setThreadState.handler({ input: { slug, sessionId: stale, state: "archived" } }),
    () => h.router.completeThread.handler({ input: { slug, sessionId: stale, terminateLive: false } }),
    () => h.router.setThreadSnooze.handler({ input: { slug, sessionId: stale, until: "2099-07-14T08:45:00.000Z" } }),
    () => h.router.confirmAwaiting.handler({
      input: {
        slug, sessionId: stale, fenceAt: "2099-07-14T08:00:00.000Z",
        hint: { kind: "github-review", value: "acme/app#391" },
      },
    }),
  ]
  for (const action of actions) await assert.rejects(action, /thread was replaced/)

  const current = h.storage.getSession(slug)!
  assert.equal(current.session_id, "current-session")
  assert.equal(current.state, "open")
  assert.equal(current.snoozed_until, null)
  assert.equal(current.awaiting_fence_id, null)
  assert.equal(h.refreshes(), 0)
  h.storage.close()
  rmSync(h.dir, { recursive: true, force: true })
})

test("clearAmbiguousCodexInput RPC: explicitly removes only a timed-out submitted barrier", async () => {
  const h = harness()
  h.storage.upsertSession(row("rpc-ambiguous"))
  h.storage.setBackend("rpc-ambiguous", "codex")
  h.storage.setCodexInputQueue(
    "rpc-ambiguous",
    JSON.stringify([
      { text: "MAYBE", enqueuedAt: "1970-01-01T00:00:00.000Z", state: "submitted", submittedAt: "1970-01-01T00:00:00.000Z" },
      { text: "LATER", enqueuedAt: "1970-01-01T00:00:01.000Z", state: "pending" },
    ]),
  )
  h.addExitedThread("rpc-ambiguous")
  h.snapshot.threads.at(-1)!.backend = "codex"

  const result = await h.router.clearAmbiguousCodexInput.handler({ input: { slug: "rpc-ambiguous" } })
  assert.deepEqual(result, { effect: "cleared" })
  const queue = JSON.parse(h.storage.getSession("rpc-ambiguous")?.codex_input_queue ?? "[]")
  assert.deepEqual(queue.map((item: { text: string }) => item.text), ["LATER"])
  h.storage.close()
})

test("setThreadPermission RPC safety: running and stale background entries are unresolved", () => {
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [{ state: "stale" }], bgShells: [{ state: "stale" }] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [{ state: "running" }], bgShells: [] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [], bgShells: [{ state: "running" }] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [], bgShells: [] }), false)
})

test("follow-up safety: a durable permission handoff blocks every composer surface", () => {
  assert.equal(hasPendingPermissionChange({ permission_pending: "bypassPermissions" }), true)
  assert.equal(hasPendingPermissionChange({ permission_pending: null }), false)
  assert.equal(hasPendingPermissionChange({ permission_pending: "future-mode" }), true, "unknown durable state fails closed")
})

function finalizedClaim(slug: string): AdoptionClaimRow {
  return {
    slug,
    attempt_token: "11111111-1111-4111-8111-111111111111",
    session_id: `sid-${slug}`,
    state: "finalized",
    reserved_at_ms: 1,
    lease_expires_at_ms: 2,
    recovery_token: null,
    pane_id: "%41",
    pane_pid: 4241,
    session_created: 741,
    finalized_at_ms: 3,
  }
}

function terminatorHarness(initial: AdoptionPaneLookup) {
  let pane = initial
  const killedPanes: PaneIdentity[] = []
  const killedSessions: string[] = []
  return {
    runtime: {
      findExpectedAdoptionPane: () => pane,
      killExpectedAdoptionPane: (expected: AdoptionClaimRow) => {
        if (
          pane.kind !== "found" || pane.pane.adoptionAttemptToken !== expected.attempt_token ||
          pane.pane.paneId !== expected.pane_id || pane.pane.panePid !== expected.pane_pid ||
          pane.pane.sessionCreated !== expected.session_created
        ) return false
        killedPanes.push({
          paneId: pane.pane.paneId,
          panePid: pane.pane.panePid,
          sessionCreated: pane.pane.sessionCreated,
        })
        pane = { kind: "absent" }
        return true
      },
      killPane: (identity: PaneIdentity) => {
        killedPanes.push(identity)
        pane = { kind: "absent" }
      },
      killSession: (slug: string) => killedSessions.push(slug),
      isLive: () => pane.kind === "found" && !pane.pane.dead,
    },
    killedPanes,
    killedSessions,
  }
}

test("completeRegisteredThread asks before ending a live session, then stops and archives only after confirmation", () => {
  const h = harness()
  const slug = "live-complete"
  const saved = { ...row(slug), exited: 0 }
  let live = true
  const kills: string[] = []
  try {
    h.storage.upsertSession(saved)
    const runtime = {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: (target: string) => { kills.push(target); live = false },
      isLive: () => live,
    }
    assert.deepEqual(completeRegisteredThread(h.storage, saved, false, runtime), { needsConfirmation: true })
    assert.equal(h.storage.getSession(slug)?.state, "open", "cancel/initial click leaves the live session open")
    assert.deepEqual(kills, [])

    assert.deepEqual(completeRegisteredThread(h.storage, saved, true, runtime), { needsConfirmation: false })
    assert.deepEqual(kills, [slug])
    assert.equal(h.storage.getSession(slug)?.state, "archived")
    assert.equal(h.storage.getSession(slug)?.exited, 1)
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completeRegisteredThread ends an idle live provider shell without confirmation and archives it", () => {
  const h = harness()
  const slug = "idle-live-complete"
  const saved = { ...row(slug), exited: 0 }
  let live = true
  const kills: string[] = []
  try {
    h.storage.upsertSession(saved)
    const telemetry = {
      turn: "idle" as const,
      permPrompt: false,
      pendingQuestion: false,
      subAgents: [],
      bgShells: [],
    }
    assert.equal(completionNeedsConfirmation(telemetry), false)
    assert.deepEqual(completeRegisteredThread(h.storage, saved, false, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: (target: string) => { kills.push(target); live = false },
      isLive: () => live,
    }, telemetry), { needsConfirmation: false })
    assert.deepEqual(kills, [slug], "Done terminates the resting shell rather than orphaning it")
    assert.equal(h.storage.getSession(slug)?.state, "archived")
    assert.equal(h.storage.getSession(slug)?.exited, 1)
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completeRegisteredThread requires confirmation for an executing turn or live background work", () => {
  const h = harness()
  try {
    const executing = {
      turn: "in-flight" as const,
      permPrompt: false,
      pendingQuestion: false,
      subAgents: [],
      bgShells: [],
    }
    const childWorking = {
      ...executing,
      turn: "idle" as const,
      subAgents: [{ id: "child-1", label: "Child", startedAt: "2026-07-15T00:00:00.000Z", state: "running" as const }],
    }
    const staleShell = {
      ...executing,
      turn: "idle" as const,
      bgShells: [{ label: "Watch CI", startedAt: "2026-07-15T00:00:00.000Z", state: "stale" as const }],
    }
    assert.equal(completionNeedsConfirmation(executing), true)
    assert.equal(completionNeedsConfirmation(childWorking), true)
    assert.equal(completionNeedsConfirmation(staleShell), true)

    for (const [slug, telemetry] of [["executing-complete", executing], ["child-complete", childWorking]] as const) {
      const saved = { ...row(slug), exited: 0 }
      h.storage.upsertSession(saved)
      let kills = 0
      assert.deepEqual(completeRegisteredThread(h.storage, saved, false, {
        findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
        killExpectedAdoptionPane: () => false,
        killSession: () => { kills++ },
        isLive: () => true,
      }, telemetry), { needsConfirmation: true })
      assert.equal(kills, 0)
      assert.equal(h.storage.getSession(slug)?.state, "open")
    }
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completion only trusts known resting telemetry; a live unobservable runtime remains protected", () => {
  assert.equal(completionNeedsConfirmation(undefined), true)
  assert.equal(completionNeedsConfirmation({
    turn: "in-flight",
    permPrompt: true,
    pendingQuestion: false,
    subAgents: [],
    bgShells: [],
  }), false, "a verified native permission pause is not executing work")
})

test("completeRegisteredThread archives an inactive session without a confirmation or termination", () => {
  const h = harness()
  const slug = "inactive-complete"
  const saved = row(slug)
  let kills = 0
  try {
    h.storage.upsertSession(saved)
    assert.deepEqual(completeRegisteredThread(h.storage, saved, false, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: () => { kills++ },
      isLive: () => false,
    }), { needsConfirmation: false })
    assert.equal(kills, 0)
    assert.equal(h.storage.getSession(slug)?.state, "archived")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completeRegisteredThread never archives when a live provider shell survives termination", () => {
  const h = harness()
  const slug = "termination-failed"
  const saved = { ...row(slug), exited: 0 }
  try {
    h.storage.upsertSession(saved)
    assert.throws(() => completeRegisteredThread(h.storage, saved, true, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: () => {},
      isLive: () => true,
    }), /could not be confirmed stopped/)
    assert.equal(h.storage.getSession(slug)?.state, "open")
    assert.equal(h.storage.getSession(slug)?.exited, 0)
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("adoption teardown: forget/dismiss/stop kill only the finalized token + exact tuple", () => {
  const slug = "adopted-owner"
  const claim = finalizedClaim(slug)
  const pane: PaneSnapshot = {
    paneId: claim.pane_id!,
    panePid: claim.pane_pid!,
    sessionCreated: claim.session_created!,
    adoptionAttemptToken: claim.attempt_token,
    dead: true,
  }
  const h = terminatorHarness({ kind: "found", pane })

  assert.equal(stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), h.runtime), "stopped")
  assert.deepEqual(h.killedPanes, [{ paneId: "%41", panePid: 4241, sessionCreated: 741 }])
  assert.deepEqual(h.killedSessions, [], "a finalized adoption never falls back to reusable slug teardown")
})

test("adoption teardown: a same-tuple token mismatch or competing claim is never killed", () => {
  const slug = "adopted-competitor"
  const claim = finalizedClaim(slug)
  const h = terminatorHarness({
    kind: "found",
    pane: {
      paneId: claim.pane_id!,
      panePid: claim.pane_pid!,
      sessionCreated: claim.session_created!,
      adoptionAttemptToken: "22222222-2222-4222-8222-222222222222",
      dead: false,
    },
  })
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), h.runtime),
    /exact runtime identity is unavailable/,
  )
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedSessions, [])

  const reserved = { ...claim, state: "reserved" as const, finalized_at_ms: null }
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => reserved }, row(slug), h.runtime),
    /competing adoption attempt/,
  )
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedSessions, [])
})

test("adoption teardown cannot kill a pane retokened between proof and the atomic action", () => {
  const slug = "adopted-retoken-race"
  const claim = finalizedClaim(slug)
  const competitorToken = "55555555-5555-4555-8555-555555555555"
  let pane: PaneSnapshot = {
    paneId: claim.pane_id!, panePid: claim.pane_pid!, sessionCreated: claim.session_created!,
    adoptionAttemptToken: claim.attempt_token, dead: false,
  }
  let kills = 0
  const runtime = {
    findExpectedAdoptionPane: (expected: AdoptionClaimRow): AdoptionPaneLookup =>
      pane.adoptionAttemptToken === expected.attempt_token
        ? { kind: "found", pane }
        : { kind: "unknown" },
    killExpectedAdoptionPane: (expected: AdoptionClaimRow) => {
      // Deterministically inject the ABA at the exact proof→action boundary. The atomic helper sees
      // the new token and must decline even though pane id/pid/session-created are unchanged.
      pane = { ...pane, adoptionAttemptToken: competitorToken }
      if (pane.adoptionAttemptToken !== expected.attempt_token) return false
      kills++
      return true
    },
    killSession: () => { throw new Error("must not name-kill") },
    isLive: () => true,
  }
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), runtime),
    /changed before it could be stopped/,
  )
  assert.equal(kills, 0)
  assert.equal(pane.adoptionAttemptToken, competitorToken)
})

test("legacy teardown retains name behavior while an absent finalized owner is a safe no-op", () => {
  const slug = "legacy-owner"
  const legacy = terminatorHarness({ kind: "absent" })
  assert.equal(stopRegisteredRuntime({ getAdoptionClaim: () => undefined }, row(slug), legacy.runtime), "stopped")
  assert.deepEqual(legacy.killedSessions, [slug])

  const adopted = terminatorHarness({ kind: "absent" })
  assert.equal(
    stopRegisteredRuntime({ getAdoptionClaim: () => finalizedClaim(slug) }, row(slug), adopted.runtime),
    "absent",
  )
  assert.deepEqual(adopted.killedSessions, [])
  assert.deepEqual(adopted.killedPanes, [])
})

test("router teardown never downgrades a stale replaced row to reusable-name control", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-router-aba-")), "ui.db"))
  const slug = "router-stale-row"
  const stale = row(slug)
  storage.upsertSession(stale)
  storage.upsertSession({ ...stale, session_id: "replacement", runtime_generation: 0 })
  const h = terminatorHarness({ kind: "absent" })
  assert.throws(() => stopRegisteredRuntime(storage, stale, h.runtime), /competing adoption attempt/)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless reserved/spawned adoption claims fail closed without a name or exact kill", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-rowless-adopt-")), "ui.db"))
  const slug = "rowless-adoption"
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: "33333333-3333-4333-8333-333333333333",
    sessionId: "reserved-owner",
    reservedAtMs: 1,
    leaseExpiresAtMs: 100,
  }), true)
  const h = terminatorHarness({ kind: "absent" })
  assert.throws(() => stopRuntimeBySlug(storage, slug, h.runtime), /adoption attempt is in progress/i)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless name teardown is fenced against a claim appearing after the optimistic read", () => {
  const h = terminatorHarness({ kind: "absent" })
  const storage = {
    getSession: () => undefined,
    getAdoptionClaim: () => undefined,
    withUnclaimedRuntimeFence: () => ({ acquired: false as const }),
  }
  assert.throws(() => stopRuntimeBySlug(storage, "rowless-race", h.runtime), /nothing was stopped/)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless adoption claim blocks kill, dismiss-status, and forget RPC handlers before tmux", async () => {
  const h = harness()
  const slug = "rowless-rpc-adoption"
  assert.equal(h.storage.reserveAdoptionClaim({
    slug,
    attemptToken: "66666666-6666-4666-8666-666666666666",
    sessionId: "rowless-rpc-owner",
    reservedAtMs: 1,
    leaseExpiresAtMs: 100,
  }), true)
  await assert.rejects(h.router.killAgent.handler({ input: { slug } }), /adoption attempt is in progress/i)
  await assert.rejects(
    h.router.setThreadStatus.handler({ input: { slug, status: "dismissed" } }),
    /adoption attempt is in progress/i,
  )
  await assert.rejects(h.router.forgetThread.handler({ input: { slug } }), /adoption attempt is in progress/i)
  assert.equal(h.storage.getAdoptionClaim(slug)?.state, "reserved")
})

test("stale forget loses to a finalized successor token and preserves its row and pane binding", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-forget-rotation-")), "ui.db"))
  const slug = "forget-successor"
  const original = finalizedClaim(slug)
  const saved = row(slug)
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: original.attempt_token,
    sessionId: saved.session_id,
    reservedAtMs: 1,
    leaseExpiresAtMs: 2,
  }), true)
  assert.equal(storage.recordAdoptionPane(slug, original.attempt_token, {
    paneId: original.pane_id!, panePid: original.pane_pid!, sessionCreated: original.session_created!,
  }, 2), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, original.attempt_token, saved, 2), true)

  const successorToken = "44444444-4444-4444-8444-444444444444"
  let rotated = false
  const originalPane: PaneSnapshot = {
    paneId: original.pane_id!, panePid: original.pane_pid!, sessionCreated: original.session_created!,
    adoptionAttemptToken: original.attempt_token, dead: true,
  }
  const runtime = {
    findExpectedAdoptionPane: (expected: AdoptionClaimRow): AdoptionPaneLookup => {
      if (!rotated && expected.attempt_token === original.attempt_token) return { kind: "found", pane: originalPane }
      if (rotated && expected.attempt_token === successorToken) return { kind: "found", pane: {
        paneId: "%99", panePid: 9900, sessionCreated: 99000,
        adoptionAttemptToken: successorToken, dead: false,
      } }
      return { kind: "absent" }
    },
    killExpectedAdoptionPane: () => {
    assert.equal(storage.rearmFinalizedAdoptionClaim({
      slug,
      attemptToken: successorToken,
      sessionId: saved.session_id,
      reservedAtMs: 3,
      leaseExpiresAtMs: 4,
    }, original.attempt_token), true)
    assert.equal(storage.recordAdoptionPane(slug, successorToken, {
      paneId: "%99", panePid: 9900, sessionCreated: 99000,
    }, 4), true)
    assert.equal(storage.finalizeAdoptionRespawnClaim(slug, successorToken, saved.session_id, 4), true)
    rotated = true
    return true
    },
    killPane: () => {},
    killSession: () => {},
    isLive: () => false,
  }

  assert.throws(
    () => stopAndForgetRegisteredRuntime(storage, saved, runtime),
    /new worker was preserved/,
  )
  assert.equal(storage.getSession(slug)?.session_id, saved.session_id)
  assert.equal(storage.getAdoptionClaim(slug)?.attempt_token, successorToken)
})
