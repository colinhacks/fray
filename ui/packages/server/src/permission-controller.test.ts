import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexComposerMatches, codexNativeQueuedInputMatches, createPermissionController, detectClaudePermissionMode, inspectClaudeComposer, inspectCodexComposer, STEER_FAILURE_PREFIX, type PermissionTerminal } from "./permission-controller.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-12T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: "default",
    permission_pending: null,
    backend: "codex",
    ...over,
  }
}

function harness(storageOverride?: Storage) {
  const storage = storageOverride ?? createStorage(join(mkdtempSync(join(tmpdir(), "fray-permission-controller-")), "ui.db"))
  let telemetry: SessionTelemetry | undefined = {
    turn: "in-flight",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
  }
  let pane = ""
  let escaped = ""
  let live = true
  let clock = 1_000
  let onTailerTick = () => {}
  const sent: string[] = []
  const reattached: string[] = []
  const keyQueueSnapshots: Array<string | null | undefined> = []
  const terminal: PermissionTerminal = {
    isLive: () => live,
    capturePane: () => pane,
    capturePaneEscaped: () => escaped,
    sendLiteral: (_slug, text) => sent.push(`literal:${text}`),
    sendKey: (slug, key) => {
      keyQueueSnapshots.push(storage.getSession(slug)?.codex_input_queue)
      sent.push(`key:${key}`)
    },
  }
  let refreshes = 0
  const board = { refresh: () => void refreshes++ } as unknown as BoardManager
  const tailer = { get: () => telemetry, tick: () => onTailerTick() } as unknown as Tailer
  const controller = createPermissionController({
    storage,
    tailer,
    board,
    terminal,
    reattach: async (slug, current, requested) => {
      reattached.push(`${slug}:${current}->${requested}`)
      if (storage.getSession(slug)?.backend === "claude") {
        const footer = requested === "bypassPermissions"
          ? "bypass permissions on"
          : requested === "acceptEdits"
            ? "accept edits on"
            : requested === "auto"
              ? "auto mode on"
              : "manual mode on"
        pane = `history\n❯\u00a0\n────────\n  ${footer}`
      }
    },
    now: () => clock,
  })
  return {
    storage,
    controller,
    sent,
    reattached,
    setPane(plain: string, withEscapes = plain) {
      pane = plain
      escaped = withEscapes
    },
    setTelemetry(next: SessionTelemetry | undefined) {
      telemetry = next
    },
    setLive(next: boolean) {
      live = next
    },
    setNow(next: number) {
      clock = next
    },
    setTailerTick(next: () => void) {
      onTailerTick = next
    },
    refreshes: () => refreshes,
    keyQueueSnapshots,
    terminal,
    tailer,
    board,
  }
}

const emptyComposer =
  "OpenAI Codex (v0.144.1)\n\u001b[1m›\u001b[0m \u001b[2mSummarize recent commits\u001b[0m\n  gpt-5.6-sol default"

const liveNubDraft =
  "\n\n\u001b[1m›\u001b[0m works for sandboxed dev servers etc...doesn't work for per-tool-call sandboxing\n  (presumably0\n\n  \u001b[38;2;246;226;183mgpt-5.6-sol high\u001b[2m\u001b[39m · \u001b[0m~/Documents/projects/nub\n"

test("composer inspection matches the exact wrapped nonempty Nub pane and the dim empty state", () => {
  assert.deepEqual(inspectCodexComposer(liveNubDraft), {
    kind: "typed",
    text: "works for sandboxed dev servers etc...doesn't work for per-tool-call sandboxing (presumably0",
    queueHint: false,
  })
  assert.deepEqual(inspectCodexComposer(emptyComposer), { kind: "empty" })
  assert.deepEqual(inspectCodexComposer("\u001b[0;1m›\u001b[0m Reply exactly REDRAW_VARIANT."), {
    kind: "typed",
    text: "Reply exactly REDRAW_VARIANT.",
    queueHint: false,
  })
  assert.deepEqual(
    inspectCodexComposer(
      "old user text said tab to queue message\n\u001b[1m›\u001b[0m Do the safe thing\n\n  \u001b[2m100% context left\u001b[0m",
    ),
    { kind: "typed", text: "Do the safe thing", queueHint: false },
    "a stale transcript phrase is not an active-turn footer",
  )
  assert.deepEqual(
    inspectCodexComposer("\u001b[1m›\u001b[0m Please explain tab to queue message\n\n  \u001b[2m100% context left\u001b[0m"),
    { kind: "typed", text: "Please explain tab to queue message", queueHint: false },
    "user-authored composer text is not a native queue hint",
  )
  assert.deepEqual(
    inspectCodexComposer(
      "\u001b[1m›\u001b[0m Call the connector for fray-native-audit/restart-\n  test and wait.\n\n  \u001b[2m100% context left\u001b[0m",
    ),
    { kind: "typed", text: "Call the connector for fray-native-audit/restart-test and wait.", queueHint: false },
    "Codex's visual line break after a word hyphen does not invent a space in the draft",
  )
  assert.deepEqual(
    inspectCodexComposer("\u001b[1m›\u001b[0m Compare alpha -\n  beta before proceeding."),
    { kind: "typed", text: "Compare alpha - beta before proceeding.", queueHint: false },
    "a standalone punctuation hyphen preserves the real following space",
  )
})

// Regression: a MULTI-PARAGRAPH draft (blank rows between paragraphs) is the common shape of a real
// steer. captureCodexComposer used to break at the first blank row, truncating the capture to the
// first paragraph; codexComposerMatches then compared that prefix against the full normalized text
// and returned false, so the durable queue wedged forever on "existing draft". The blank row is an
// internal paragraph break, not the composer's end — only the footer/status line ends it.
test("composer inspection captures a multi-paragraph draft across internal blank lines", () => {
  const twoParagraphs =
    "[1m›[0m First paragraph line one\n  continues on row two\n\n  Second paragraph after a blank line\n\n  gpt-5.6-sol xhigh · ~/Documents/projects/fray · Context 66% used"
  assert.equal(inspectCodexComposer(twoParagraphs).kind, "typed", "a multi-paragraph draft is a typed composer")
  assert.equal(
    codexComposerMatches(twoParagraphs, "First paragraph line one continues on row two\n\nSecond paragraph after a blank line"),
    true,
    "the exact multi-paragraph staged text matches and can be submitted",
  )
  // Three-blank-line gaps collapse identically (normalizedInput turns any whitespace run into one space).
  const threeBlanks =
    "[1m›[0m Alpha\n\n\n  Bravo\n\n  gpt-5.6-sol xhigh · ~/x · 100% context left"
  assert.equal(codexComposerMatches(threeBlanks, "Alpha\n\nBravo"), true)
  // Fail-closed preserved: a genuinely different draft is never accepted just because we scan further.
  assert.equal(
    codexComposerMatches(twoParagraphs, "First paragraph line one continues on row two\n\nA DIFFERENT second paragraph"),
    false,
    "a non-matching multi-paragraph draft still fails closed",
  )
  // A footer hint rendered TIGHT under the draft (no blank between) still ends the draft — parity with
  // the old parts-based capture, so delivery never re-wedges if Codex drops the pre-footer blank row.
  const esc = String.fromCharCode(27)
  assert.equal(codexComposerMatches(`${esc}[1m›${esc}[0m Do the safe thing\n  ${esc}[2m100% context left${esc}[0m`, "Do the safe thing"), true)
})

test("Claude composer inspection distinguishes the idle prompt from an unsent draft or modal", () => {
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0\n────────\n  ⏵⏵ auto mode on"), { kind: "empty" })
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0UNSENT_DRAFT_PROBE\n────────"), { kind: "typed", text: "UNSENT_DRAFT_PROBE" })
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0\n  unsent second line\n────────\n  project · main"), { kind: "typed", text: "unsent second line" })
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0\n────────\n  project · main\nUnrecognized confirmation modal"), { kind: "unavailable" })
  assert.deepEqual(inspectClaudeComposer("Accessing workspace\n ❯ 1. Yes, I trust this folder"), { kind: "unavailable" })
})

test("Claude permission footer reports the active new-pane mode without reading transcript history", () => {
  assert.equal(detectClaudePermissionMode("old text: auto mode on\n…\n❯\u00a0\n────\n  bypass permissions on"), "bypassPermissions")
  assert.equal(detectClaudePermissionMode("history\n❯\u00a0\n────\n  accept edits mode on"), "acceptEdits")
  assert.equal(detectClaudePermissionMode("history\n❯\u00a0\n────\n  ⏵⏵ auto mode on"), "auto")
  assert.equal(detectClaudePermissionMode("history\n❯\u00a0\n────\n  ⏸ manual mode on"), "default")
  assert.equal(detectClaudePermissionMode(`${"auto mode on\n".repeat(15)}❯\u00a0\n────\n  no status footer`), undefined)
})

test("a queued follow-up whose Codex visual wrap splits a hyphenated token still submits exactly once", () => {
  const h = harness()
  h.storage.upsertSession(row("wrapped-hyphen"))
  h.storage.setBackend("wrapped-hyphen", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", emptyComposer)
  const message = "Call the connector for fray-native-audit/restart-test and wait."

  h.controller.queueFollowUp("wrapped-hyphen", message)
  assert.deepEqual(h.sent, [`literal:${message}`])

  h.setPane(
    "",
    "\u001b[1m›\u001b[0m Call the connector for fray-native-audit/restart-\n  test and wait.\n\n  \u001b[2m100% context left\u001b[0m",
  )
  h.controller.tick()
  assert.deepEqual(h.sent, [`literal:${message}`, "key:Enter"])
})

test("native queued-follow-up ownership requires Codex's local label and the exact queued text", () => {
  assert.equal(codexNativeQueuedInputMatches("Queued follow-ups\n  KEEP_PENDING\n\n›", "KEEP_PENDING"), true)
  assert.equal(
    codexNativeQueuedInputMatches(`Queued follow-ups (1)\n${Array.from({ length: 18 }, (_, i) => `  wrapped row ${i + 1}`).join("\n")}\n  LONG_TAIL\n›`, "wrapped row 1 wrapped row 2 wrapped row 3 wrapped row 4 wrapped row 5 wrapped row 6 wrapped row 7 wrapped row 8 wrapped row 9 wrapped row 10 wrapped row 11 wrapped row 12 wrapped row 13 wrapped row 14 wrapped row 15 wrapped row 16 wrapped row 17 wrapped row 18 LONG_TAIL"),
    true,
    "a long native block is bounded by the next composer, not a short visual-line window",
  )
  assert.equal(codexNativeQueuedInputMatches("old transcript: Queued follow-ups KEEP_PENDING\n\n›", "KEEP_PENDING"), false)
  assert.equal(codexNativeQueuedInputMatches("Queued follow-ups\n  another message\n\n›", "KEEP_PENDING"), false)
  assert.equal(codexNativeQueuedInputMatches("KEEP_PENDING\n\n›", "KEEP_PENDING"), false)
})

test("a live Codex queue owner atomically accepts a second follow-up", () => {
  const h = harness()
  h.storage.upsertSession(row("append-queued-follow-up"))
  h.storage.setBackend("append-queued-follow-up", "codex")
  h.setTelemetry({ turn: "in-flight", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane(emptyComposer)

  h.controller.queueFollowUp("append-queued-follow-up", "first queued follow-up")
  h.controller.queueFollowUp("append-queued-follow-up", "second queued follow-up")

  const current = h.storage.getSession("append-queued-follow-up")!
  assert.equal(current.runtime_control, "codex-input")
  assert.deepEqual(JSON.parse(current.codex_input_queue ?? "[]").map((item: { text: string }) => item.text), [
    "first queued follow-up",
    "second queued follow-up",
  ])
})

test("queued input matching tolerates only Codex visual-row boundaries, not changed row content", () => {
  const pane = "\u001b[1m›\u001b[0m Reply with this block:\n  \\nField 1/1\\nAllow GitHub?\n\n  \u001b[2m100% context left\u001b[0m"
  assert.equal(codexComposerMatches(pane, "Reply with this block:\\nField 1/1\\nAllow GitHub?"), true)
  assert.equal(codexComposerMatches(pane, "Reply with that block:\\nField 1/1\\nAllow GitHub?"), false)
  assert.equal(codexComposerMatches(pane, "Reply with this block:\\nField 2/2\\nAllow GitHub?"), false)
})

test("a CAS-loss adoption claim blocks Codex follow-up queueing and tick injection by reusable slug", () => {
  const h = harness()
  const slug = "cas-loss-codex"
  const token = "11111111-1111-4111-8111-111111111111"
  assert.equal(h.storage.reserveAdoptionClaim({ slug, attemptToken: token, sessionId: "losing-adoption", reservedAtMs: 1, leaseExpiresAtMs: 10_000 }), true)
  assert.equal(h.storage.recordAdoptionPane(slug, token, { paneId: "%55", panePid: 5500, sessionCreated: 55000 }, 10_000), true)
  assert.equal(h.storage.insertSessionIfAbsent(row(slug, { session_id: "winning-codex" })), true)

  assert.throws(() => h.controller.queueFollowUp(slug, "must not reach loser"), /not available/)
  h.storage.setCodexInputQueue(slug, JSON.stringify([{ text: "durable but blocked", enqueuedAt: new Date(0).toISOString(), state: "pending" }]))
  h.controller.tick()
  assert.deepEqual(h.sent, [])
  assert.match(h.storage.getSession(slug)?.control_error ?? "", /exact runtime identity is unavailable/)
})

test("permission/input controller rejects a stale row snapshot without name capture or send", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-permission-aba-")), "ui.db"))
  const slug = "permission-stale-row"
  const stale = row(slug, { session_id: "owner-a", runtime_generation: 5 })
  storage.upsertSession(stale)
  storage.upsertSession(row(slug, { session_id: "owner-b", runtime_generation: 0 }))
  let first = true
  const staleStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "getSession") return (value: string) => value === slug && first
        ? (first = false, stale)
        : target.getSession(value)
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const h = harness(staleStorage)
  assert.throws(() => h.controller.queueFollowUp(slug, "do not send"), /not available/)
  assert.deepEqual(h.sent, [])
})

test("an idle Codex permission change reattaches with the exact target and never navigates a TUI menu", async () => {
  const h = harness()
  h.storage.upsertSession(row("long-transcript"))
  h.storage.setBackend("long-transcript", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("", "old transcript\n\u001b[1m›\u001b[0m \u001b[2mExplain this codebase\u001b[0m\n  gpt-5.6-sol low · /repo")

  assert.deepEqual(await h.controller.request("long-transcript", "bypassPermissions"), { effect: "applied" })

  assert.deepEqual(h.reattached, ["long-transcript:default->bypassPermissions"])
  assert.deepEqual(h.sent, [], "permission changes never inject text, arrows, Enter, or control characters")
  assert.equal(h.storage.getSession("long-transcript")?.permission_mode, "bypassPermissions")
  assert.equal(h.storage.getSession("long-transcript")?.permission_pending, null)
  assert.equal(h.storage.getSession("long-transcript")?.control_error, null)
})

test("an idle Claude permission change uses the same controlled reattach path", async () => {
  const h = harness()
  h.storage.upsertSession(row("claude", { backend: "claude", permission_mode: "auto" }))
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "auto" })
  h.setPane("history\n❯\u00a0\n────────\n  ⏵⏵ auto mode on")
  assert.deepEqual(await h.controller.request("claude", "bypassPermissions"), { effect: "applied" })
  assert.deepEqual(h.reattached, ["claude:auto->bypassPermissions"])
  assert.equal(h.storage.getSession("claude")?.permission_mode, "bypassPermissions")
  assert.equal(h.storage.getSession("claude")?.permission_pending, null)
})

test("a live change folds pending backend sidecars before choosing its rollback mode", async () => {
  const h = harness()
  h.storage.upsertSession(row("fresh-current", { backend: "claude", permission_mode: "default" }))
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("history\n❯\u00a0\n────────")
  h.setTailerTick(() => {
    h.storage.setPermissionMode("fresh-current", "auto")
    h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "auto" })
  })
  await h.controller.request("fresh-current", "bypassPermissions")
  assert.deepEqual(h.reattached, ["fresh-current:auto->bypassPermissions"])
})

test("a fresh backend profile that rejects the requested mode wins over the launch flag", async () => {
  const h = harness()
  const slug = "backend-coercion"
  h.storage.upsertSession(row(slug, { backend: "claude", permission_mode: "default" }))
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "default",
    permissionModeRevision: 1,
  })
  h.setPane("history\n❯\u00a0\n────────")
  let ticks = 0
  h.setTailerTick(() => {
    ticks++
    if (ticks === 2) {
      h.setPane("history\n❯\u00a0\n────────\n  manual mode on")
      h.setTelemetry({
        turn: "idle",
        permPrompt: false,
        subAgents: [],
        bgShells: [],
        pendingQuestion: false,
        permissionMode: "default",
        permissionModeRevision: 2,
      })
    }
  })

  await assert.rejects(h.controller.request(slug, "bypassPermissions"), /Backend did not apply bypassPermissions; it reported default/)
  assert.deepEqual(h.reattached, [`${slug}:default->bypassPermissions`])
  assert.equal(h.storage.getSession(slug)?.permission_mode, "default")
  assert.equal(h.storage.getSession(slug)?.permission_pending, null)
  assert.match(h.storage.getSession(slug)?.control_error ?? "", /Backend did not apply/)
  assert.ok(h.refreshes() >= 2, "the terminal coercion state is emitted after the earlier pending snapshot")
})

test("a new Claude pane footer wins over the replaced pane's delayed shutdown sidecar", async () => {
  const h = harness()
  const slug = "old-shutdown-sidecar"
  h.storage.upsertSession(row(slug, { backend: "claude", permission_mode: "acceptEdits" }))
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "acceptEdits",
    permissionModeRevision: 1,
  })
  h.setPane("history\n❯\u00a0\n────────\n  ⏵⏵ accept edits on")
  let ticks = 0
  h.setTailerTick(() => {
    ticks++
    if (ticks === 2) {
      h.setTelemetry({
        turn: "idle",
        permPrompt: false,
        subAgents: [],
        bgShells: [],
        pendingQuestion: false,
        permissionMode: "acceptEdits",
        permissionModeRevision: 2,
      })
    }
  })

  assert.deepEqual(await h.controller.request(slug, "bypassPermissions"), { effect: "applied" })
  assert.equal(h.storage.getSession(slug)?.permission_mode, "bypassPermissions")
  assert.equal(h.storage.getSession(slug)?.permission_pending, null)
  assert.equal(h.storage.getSession(slug)?.control_error, null)
})

test("an old buffered Codex profile cannot masquerade as current-generation coercion", async () => {
  const h = harness()
  const slug = "old-codex-profile"
  h.storage.upsertSession(row(slug, {
    backend: "codex",
    spawned_at: "2026-07-12T00:00:00.000Z",
    permission_mode: "default",
  }))
  h.storage.setBackend(slug, "codex")
  h.setPane("", emptyComposer)
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "default",
    permissionModeAt: "2026-07-12T00:00:01.000Z",
    permissionModeRevision: 1,
  })
  let ticks = 0
  h.setTailerTick(() => {
    ticks++
    if (ticks === 2) {
      h.setTelemetry({
        turn: "idle",
        permPrompt: false,
        subAgents: [],
        bgShells: [],
        pendingQuestion: false,
        permissionMode: "plan",
        permissionModeAt: "2026-07-11T23:59:59.000Z",
        permissionModeRevision: 2,
      })
    }
  })
  assert.deepEqual(await h.controller.request(slug, "bypassPermissions"), { effect: "applied" })
  assert.equal(h.storage.getSession(slug)?.permission_mode, "bypassPermissions")
  assert.equal(h.storage.getSession(slug)?.permission_pending, null)
})

test("the cleanup timer cannot invalidate a readiness-checked permission handoff in progress", async () => {
  const h = harness()
  h.storage.upsertSession(row("slow-handoff"))
  h.storage.setBackend("slow-handoff", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("", emptyComposer)
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = createPermissionController({
    storage: h.storage,
    tailer: h.tailer,
    board: h.board,
    terminal: h.terminal,
    reattach: async () => ready,
  })

  const changing = controller.request("slow-handoff", "bypassPermissions")
  controller.tick()
  assert.equal(h.storage.getSession("slow-handoff")?.permission_pending, "bypassPermissions")
  assert.equal(h.storage.getSession("slow-handoff")?.control_error, null)
  h.setLive(false)
  await assert.rejects(controller.request("slow-handoff", "plan"), /already in progress/)
  assert.equal(h.storage.getSession("slow-handoff")?.permission_pending, "bypassPermissions")
  h.setLive(true)

  release()
  assert.deepEqual(await changing, { effect: "applied" })
  assert.equal(h.storage.getSession("slow-handoff")?.permission_pending, null)
})

test("an old permission request cannot clear or relabel a replacement session", async () => {
  const h = harness()
  const slug = "replace-flight"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("", emptyComposer)
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = createPermissionController({
    storage: h.storage,
    tailer: h.tailer,
    board: h.board,
    terminal: h.terminal,
    reattach: async () => ready,
  })

  const changing = controller.request(slug, "bypassPermissions")
  assert.equal(h.storage.getSession(slug)?.permission_pending, "bypassPermissions")
  h.storage.upsertSession(row(slug, {
    session_id: "sid-replacement",
    permission_mode: "plan",
    permission_pending: "plan",
    control_error: "replacement-owned state",
  }))
  release()

  await assert.rejects(changing, /deleted or replaced/)
  const replacement = h.storage.getSession(slug)!
  assert.equal(replacement.session_id, "sid-replacement")
  assert.equal(replacement.permission_mode, "plan")
  assert.equal(replacement.permission_pending, "plan")
  assert.equal(replacement.control_error, "replacement-owned state")
})

test("active work and an unsent native draft fail immediately without writing false pending state", async () => {
  const h = harness()
  h.storage.upsertSession(row("busy"))
  h.storage.setBackend("busy", "codex")
  await assert.rejects(h.controller.request("busy", "bypassPermissions"), /idle thread/)
  assert.equal(h.storage.getSession("busy")?.permission_pending, null)
  assert.deepEqual(h.reattached, [])

  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("", liveNubDraft)
  await assert.rejects(h.controller.request("busy", "bypassPermissions"), /submit or clear/)
  assert.equal(h.storage.getSession("busy")?.permission_pending, null)
  assert.match(h.storage.getSession("busy")?.control_error ?? "", /submit or clear the existing Codex terminal draft/)
})

test("quiet stale background work still blocks a live permission reattach", async () => {
  const h = harness()
  h.storage.upsertSession(row("stale-child"))
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [{ id: "child", label: "quiet long-running child", startedAt: "2026-07-12T00:00:00.000Z", state: "stale" }],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "default",
  })
  h.setPane("", emptyComposer)

  await assert.rejects(h.controller.request("stale-child", "bypassPermissions"), /no unresolved background work/)
  assert.deepEqual(h.reattached, [])
  assert.equal(h.storage.getSession("stale-child")?.permission_pending, null)
})

test("a stale pending permission is failed closed on controller restart instead of spinning forever", () => {
  const h = harness()
  h.storage.upsertSession(row("restart"))
  h.storage.setBackend("restart", "codex")
  h.storage.setPermissionPending("restart", "bypassPermissions")
  const restarted = createPermissionController({ storage: h.storage, tailer: h.tailer, board: h.board, terminal: h.terminal })
  restarted.tick()
  assert.equal(h.storage.getSession("restart")?.permission_pending, null)
  assert.match(h.storage.getSession("restart")?.control_error ?? "", /prior permission change was not observed/)
  assert.deepEqual(h.sent, [])
})

test("invalid durable pending state blocks input and fails closed without typing", () => {
  const h = harness()
  h.storage.upsertSession(row("invalid-pending", { permission_pending: "future-mode" }))
  h.storage.setBackend("invalid-pending", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", emptyComposer)
  assert.throws(() => h.controller.queueFollowUp("invalid-pending", "must wait"), /permission change/i)
  h.controller.tick()
  assert.deepEqual(h.sent, [])
  assert.equal(h.storage.getSession("invalid-pending")?.permission_pending, "future-mode")
  assert.match(h.storage.getSession("invalid-pending")?.control_error ?? "", /invalid.*permission/i)
})

test("restart reconciliation never treats historical or dead telemetry as a completed handoff", () => {
  for (const config of [
    { slug: "dead-claude-history", backend: "claude", live: false, permissionModeAt: undefined },
    { slug: "old-codex-history", backend: "codex", live: true, permissionModeAt: "2026-07-12T00:00:00.000Z" },
  ] as const) {
    const h = harness()
    h.storage.upsertSession(row(config.slug, {
      backend: config.backend,
      spawned_at: "2026-07-13T00:00:00.000Z",
      permission_mode: "default",
      permission_pending: "bypassPermissions",
    }))
    h.storage.setBackend(config.slug, config.backend)
    h.setLive(config.live)
    h.setTelemetry({
      turn: "idle",
      permPrompt: false,
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      permissionMode: "bypassPermissions",
      permissionModeAt: config.permissionModeAt,
    })
    h.controller.tick()
    const saved = h.storage.getSession(config.slug)!
    assert.equal(saved.permission_mode, "default")
    assert.equal(saved.permission_pending, null)
    assert.match(saved.control_error ?? "", /not observed|retry/i)
  }
})

test("a partially malformed durable Codex queue is byte-preserved and never typed", () => {
  const h = harness()
  const slug = "partial-invalid-queue"
  const raw = JSON.stringify([
    { futureOwnershipRecord: true },
    { text: "VALID_TAIL", enqueuedAt: "2026-07-13T00:00:00.000Z", state: "pending" },
  ])
  h.storage.upsertSession(row(slug, { codex_input_queue: raw }))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexInputQueue(slug, raw)
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", emptyComposer)
  assert.throws(() => h.controller.queueFollowUp(slug, "NEW"), /invalid/i)
  h.controller.tick()
  assert.deepEqual(h.sent, [])
  assert.equal(h.storage.getSession(slug)?.codex_input_queue, raw)
  assert.match(h.storage.getSession(slug)?.control_error ?? "", /invalid/i)
})

test("an old permission completion cannot clear a newer same-session process generation", async () => {
  const h = harness()
  const slug = "generation-flight"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("", emptyComposer)
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = createPermissionController({
    storage: h.storage,
    tailer: h.tailer,
    board: h.board,
    terminal: h.terminal,
    reattach: async () => ready,
  })
  const changing = controller.request(slug, "bypassPermissions")
  const current = h.storage.getSession(slug)!
  const newer = h.storage.beginRuntimeGeneration(
    slug,
    { sessionId: current.session_id, generation: current.runtime_generation ?? 0, permissionPending: "bypassPermissions", runtimeControl: "permission" },
    "2026-07-13T12:00:00.000Z",
  )
  assert.equal(newer, 1)
  h.storage.setPermissionStateIfCurrent(
    slug,
    { sessionId: current.session_id, generation: newer!, permissionPending: "bypassPermissions", runtimeControl: "permission" },
    { permissionMode: "plan", permissionPending: "bypassPermissions", controlError: "new generation owns state", exited: false },
  )
  release()
  await assert.rejects(changing, /canceled|generation|replaced/i)
  const saved = h.storage.getSession(slug)!
  assert.equal(saved.runtime_generation, 1)
  assert.equal(saved.permission_mode, "plan")
  assert.equal(saved.permission_pending, "bypassPermissions")
  assert.equal(saved.control_error, "new generation owns state")
})

test("durable live Codex follow-up separates typing from idle Enter and clears only on rollout telemetry", () => {
  const h = harness()
  h.storage.upsertSession(row("idle-input"))
  h.storage.setBackend("idle-input", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", emptyComposer)

  h.controller.queueFollowUp("idle-input", "Reply exactly IDLE_OK.")
  assert.deepEqual(h.sent, ["literal:Reply exactly IDLE_OK."])
  assert.equal(JSON.parse(h.storage.getSession("idle-input")?.codex_input_queue ?? "[]")[0].state, "pending")

  h.sent.length = 0
  h.setPane("", "\u001b[1m›\u001b[0m Reply exactly IDLE_OK.\n\n  gpt-5.6-sol")
  h.controller.tick()
  assert.deepEqual(h.sent, ["key:Enter"])
  assert.equal(JSON.parse(h.storage.getSession("idle-input")?.codex_input_queue ?? "[]")[0].state, "submitted")
  assert.equal(JSON.parse(h.keyQueueSnapshots.at(-1) ?? "[]")[0].state, "submitted", "barrier is durable before Enter")

  h.setTelemetry({
    turn: "in-flight",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    lastUserText: "Reply exactly IDLE_OK.",
    lastUserAt: "2026-07-12T20:00:00.000Z",
  })
  h.controller.tick()
  assert.equal(h.storage.getSession("idle-input")?.codex_input_queue, null)
})

test("a scheduler delivery id makes durable Codex wake enqueue idempotent", () => {
  const h = harness()
  const slug = "idempotent-wake"
  const message = "Wake once.\n\n<!-- fray-wake:wake-1 -->"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", emptyComposer)

  h.controller.queueFollowUp(slug, message, "wake-1")
  h.controller.queueFollowUp(slug, message, "wake-1") // crash-window replay of the same outbox item
  const queue = JSON.parse(h.storage.getSession(slug)?.codex_input_queue ?? "[]")
  assert.equal(queue.length, 1)
  assert.equal(queue[0].deliveryId, "wake-1")
  assert.deepEqual(h.sent, [`literal:${message}`], "the duplicate acceptance never types or queues twice")
  assert.throws(
    () => h.controller.queueFollowUp(slug, "different payload", "wake-1"),
    /reused with different input/,
  )
})

test("an active Codex composer uses its verified Tab queue hint, never Enter", () => {
  const h = harness()
  h.storage.upsertSession(row("active-input"))
  h.storage.setBackend("active-input", "codex")
  h.setPane("", emptyComposer)
  h.controller.queueFollowUp("active-input", "ACTIVE_FOLLOWUP exact text")

  h.sent.length = 0
  h.setPane(
    "",
    "\u001b[1m›\u001b[0m ACTIVE_FOLLOWUP exact text\n\n  \u001b[2mtab to queue message\u001b[0m  100% context left",
  )
  h.controller.tick()
  assert.deepEqual(h.sent, ["key:Tab"])
  assert.equal(JSON.parse(h.keyQueueSnapshots.at(-1) ?? "[]")[0].state, "submitted", "barrier is durable before Tab")
})

test("a queued follow-up waits behind a native tool modal and resumes only after the human clears it", () => {
  const h = harness()
  h.storage.upsertSession(row("modal-input"))
  h.storage.setBackend("modal-input", "codex")
  h.setTelemetry({
    turn: "in-flight",
    permPrompt: false,
    nativeInputRequired: { kind: "tool-approval", title: "GitHub tool approval required" },
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
  })
  h.setPane(
    "Field 1/1\nAllow GitHub to create a Git blob?\n› 1. Allow\n  2. Allow for this session\n  3. Always allow\n  4. Cancel\nenter to submit | esc to cancel",
  )

  h.controller.queueFollowUp("modal-input", "continue after the approval")
  assert.deepEqual(h.sent, [], "the controller never answers or types through the modal")
  assert.match(h.storage.getSession("modal-input")?.control_error ?? "", /current Codex modal/)
  assert.equal(JSON.parse(h.storage.getSession("modal-input")?.codex_input_queue ?? "[]")[0].state, "pending")

  // The human presses Escape/Cancel in Terminal. On the next controller tick, the verified empty
  // composer is available again and the durable follow-up resumes without any replayed modal key.
  h.setPane("", emptyComposer)
  h.controller.tick()
  assert.deepEqual(h.sent, ["literal:continue after the approval"])
  assert.equal(h.storage.getSession("modal-input")?.control_error, null)
})

test("identical consecutive follow-ups each require their own post-submission rollout", () => {
  const h = harness()
  h.storage.upsertSession(row("duplicate-input"))
  h.storage.setBackend("duplicate-input", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", emptyComposer)

  h.setNow(1_000)
  h.controller.queueFollowUp("duplicate-input", "SAME")
  h.setPane("", "\u001b[1m›\u001b[0m SAME\n\n  gpt-5.6-sol")
  h.setNow(1_050)
  h.controller.queueFollowUp("duplicate-input", "SAME")
  assert.deepEqual(h.sent, ["literal:SAME", "key:Enter"])

  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    lastUserText: "SAME",
    lastUserAt: "1970-01-01T00:00:01.200Z",
  })
  h.controller.tick()
  let queue = JSON.parse(h.storage.getSession("duplicate-input")?.codex_input_queue ?? "[]")
  assert.equal(queue.length, 1)
  assert.equal(queue[0].state, "pending", "the first rollout cannot dequeue an unsubmitted duplicate")

  h.setPane("", emptyComposer)
  h.setNow(1_300)
  h.controller.tick()
  h.setPane("", "\u001b[1m›\u001b[0m SAME\n\n  gpt-5.6-sol")
  h.setNow(1_400)
  h.controller.tick()
  queue = JSON.parse(h.storage.getSession("duplicate-input")?.codex_input_queue ?? "[]")
  assert.equal(queue[0].submittedAt, "1970-01-01T00:00:01.400Z")

  h.controller.tick()
  assert.equal(
    JSON.parse(h.storage.getSession("duplicate-input")?.codex_input_queue ?? "[]").length,
    1,
    "the earlier identical rollout predates this native submission",
  )

  h.setTelemetry({
    turn: "in-flight",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    lastUserText: "SAME",
    lastUserAt: "1970-01-01T00:00:01.500Z",
  })
  h.controller.tick()
  assert.equal(h.storage.getSession("duplicate-input")?.codex_input_queue, null)
})

test("a different existing draft blocks a queued follow-up without overwriting or submitting it", () => {
  const h = harness()
  h.storage.upsertSession(row("draft-input"))
  h.storage.setBackend("draft-input", "codex")
  h.setPane("", liveNubDraft)
  h.controller.queueFollowUp("draft-input", "new queued message")
  assert.deepEqual(h.sent, [])
  assert.match(h.storage.getSession("draft-input")?.control_error ?? "", /submit or clear/)
  assert.equal(JSON.parse(h.storage.getSession("draft-input")?.codex_input_queue ?? "[]").length, 1)
})

test("terminal replacement preparation captures the live draft but never clears, sends, or rewrites either message", () => {
  const h = harness()
  h.storage.upsertSession(row("replace-draft"))
  h.storage.setBackend("replace-draft", "codex")
  h.setPane("", liveNubDraft)
  h.controller.queueFollowUp("replace-draft", "queued replacement message")

  assert.deepEqual(h.controller.prepareCodexDraftReplacement("replace-draft"), { queuedMessage: "queued replacement message" })
  assert.deepEqual(h.sent, [], "preparing copy-to-terminal recovery must not touch the pane")
  assert.deepEqual(JSON.parse(h.storage.getSession("replace-draft")?.codex_input_queue ?? "[]"), [
    { text: "queued replacement message", enqueuedAt: "1970-01-01T00:00:01.000Z", state: "pending" },
  ])

  h.setPane("", emptyComposer)
  assert.throws(() => h.controller.prepareCodexDraftReplacement("replace-draft"), /draft changed/)
  assert.deepEqual(h.sent, [], "a changed composer must fail closed without submitting the queued message")
  assert.equal(JSON.parse(h.storage.getSession("replace-draft")?.codex_input_queue ?? "[]")[0].text, "queued replacement message")
})

test("explicit idle recovery submits the verified existing draft first, confirms telemetry, then releases the queued follow-up", () => {
  const h = harness()
  h.storage.upsertSession(row("recover-idle"))
  h.storage.setBackend("recover-idle", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.setPane("", liveNubDraft)
  h.controller.queueFollowUp("recover-idle", "queued after recovery")
  h.sent.length = 0

  assert.deepEqual(h.controller.submitExistingDraft("recover-idle"), { effect: "submitted" })
  assert.deepEqual(h.sent, ["key:Enter"])
  let queue = JSON.parse(h.storage.getSession("recover-idle")?.codex_input_queue ?? "[]")
  assert.equal(queue.length, 2)
  assert.equal(queue[0].source, "existing-draft")
  assert.equal(queue[0].state, "submitted")
  assert.equal(queue[1].text, "queued after recovery")

  h.sent.length = 0
  h.setTelemetry({
    turn: "in-flight",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    lastUserText: "works for sandboxed dev servers etc...doesn't work for per-tool-call sandboxing (presumably0",
    lastUserAt: "2026-07-12T20:00:00.000Z",
  })
  h.controller.tick()
  queue = JSON.parse(h.storage.getSession("recover-idle")?.codex_input_queue ?? "[]")
  assert.deepEqual(queue.map((item: { text: string }) => item.text), ["queued after recovery"])
  assert.deepEqual(h.sent, [], "the next message never shares the recovery-confirmation tick")

  h.setPane("", emptyComposer)
  h.controller.tick()
  assert.deepEqual(h.sent, ["literal:queued after recovery"])
})

test("explicit active recovery uses only Codex's advertised Tab queue control", () => {
  const h = harness()
  h.storage.upsertSession(row("recover-active"))
  h.storage.setBackend("recover-active", "codex")
  h.setPane("", `${liveNubDraft}\n  \u001b[2mtab to queue message\u001b[0m`)
  assert.deepEqual(h.controller.submitExistingDraft("recover-active"), { effect: "submitted" })
  assert.deepEqual(h.sent, ["key:Tab"])
})

test("draft recovery fails closed on a modal or ambiguous running composer and cannot double-submit", () => {
  const h = harness()
  h.storage.upsertSession(row("recover-guard"))
  h.storage.setBackend("recover-guard", "codex")
  h.setPane("", "Enable full access?\nPress enter to confirm or esc to go back")
  assert.throws(() => h.controller.submitExistingDraft("recover-guard"), /modal/)
  assert.deepEqual(h.sent, [])

  h.setPane("", liveNubDraft)
  assert.throws(() => h.controller.submitExistingDraft("recover-guard"), /neither idle nor advertising/)
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false })
  h.controller.submitExistingDraft("recover-guard")
  assert.throws(() => h.controller.submitExistingDraft("recover-guard"), /already submitted/)
  assert.deepEqual(h.sent, ["key:Enter"])
})

test("native Codex queue ownership persists before timeout, survives restart, and later clears once from transcript evidence", () => {
  const h = harness()
  h.storage.upsertSession(row("native-queued-input"))
  h.storage.setBackend("native-queued-input", "codex")
  h.storage.setCodexInputQueue(
    "native-queued-input",
    JSON.stringify([
      { text: "PROVIDER_QUEUED", enqueuedAt: "1970-01-01T00:00:01.000Z", state: "submitted", submittedAt: "1970-01-01T00:00:01.000Z", deliveryId: "delivery-native" },
    ]),
  )
  h.setPane("", "Queued follow-ups\n  PROVIDER_QUEUED\n›")
  h.setNow(2_000)
  h.controller.tick()
  let queue = JSON.parse(h.storage.getSession("native-queued-input")?.codex_input_queue ?? "[]")
  assert.equal(queue.length, 1)
  assert.equal(queue[0].state, "submitted")
  assert.equal(queue[0].providerQueuedAt, "1970-01-01T00:00:02.000Z", "positive native ownership is durable before timeout")
  assert.equal(h.storage.getSession("native-queued-input")?.control_error, null)

  // Codex redraws/scrolls its native queue block away. The durable proof remains enough after the
  // former timeout and after a controller restart; neither path may type or submit again.
  h.setPane("", emptyComposer)
  h.setNow(31_000)
  h.controller.tick()
  queue = JSON.parse(h.storage.getSession("native-queued-input")?.codex_input_queue ?? "[]")
  assert.equal(queue.length, 1)
  assert.equal(queue[0].providerQueuedAt, "1970-01-01T00:00:02.000Z")

  const restarted = createPermissionController({ storage: h.storage, tailer: h.tailer, board: h.board, terminal: h.terminal, now: () => 31_000 })
  restarted.tick()
  assert.equal(JSON.parse(h.storage.getSession("native-queued-input")?.codex_input_queue ?? "[]").length, 1)
  assert.deepEqual(h.sent, [], "positive native ownership never retries or replays")

  h.setTelemetry({
    turn: "in-flight",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    lastUserText: "PROVIDER_QUEUED",
    lastUserAt: "1970-01-01T00:00:31.500Z",
  })
  restarted.tick()
  assert.equal(h.storage.getSession("native-queued-input")?.codex_input_queue, null)
  restarted.tick()
  assert.equal(h.storage.getSession("native-queued-input")?.codex_input_queue, null, "the same rollout cannot clear twice")
})

test("an indeterminate Codex submission rolls back its durable barrier without replaying", () => {
  const h = harness()
  h.storage.upsertSession(row("indeterminate-input"))
  h.storage.setBackend("indeterminate-input", "codex")
  h.storage.setCodexInputQueue(
    "indeterminate-input",
    JSON.stringify([
      { text: "MAYBE_SENT", enqueuedAt: "1970-01-01T00:00:01.000Z", state: "submitted", submittedAt: "1970-01-01T00:00:01.000Z", deliveryId: "delivery-ambiguous" },
    ]),
  )
  h.setPane("", emptyComposer)
  h.setNow(31_000)
  h.controller.tick()
  assert.equal(h.storage.getSession("indeterminate-input")?.codex_input_queue, null)
  assert.equal(h.storage.getSession("indeterminate-input")?.control_error, `${STEER_FAILURE_PREFIX}delivery-ambiguous`)
  assert.deepEqual(h.sent, [], "indeterminate evidence never retries or replays")
})

test("an exited mode saves for native resume while a live read-only request reattaches", async () => {
  const h = harness()
  h.storage.upsertSession(row("exited", { exited: 1 }))
  h.storage.setBackend("exited", "codex")
  h.setLive(false)
  assert.deepEqual(await h.controller.request("exited", "plan"), { effect: "next-resume" })
  assert.equal(h.storage.getSession("exited")?.permission_mode, "plan")
  assert.equal(h.storage.getSession("exited")?.permission_pending, null)
  assert.deepEqual(h.sent, [])

  h.storage.upsertSession(row("live-read"))
  h.storage.setBackend("live-read", "codex")
  h.setLive(true)
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("", emptyComposer)
  assert.deepEqual(await h.controller.request("live-read", "plan"), { effect: "applied" })
  assert.equal(h.storage.getSession("live-read")?.permission_mode, "plan")
  assert.equal(h.storage.getSession("live-read")?.permission_pending, null)
  assert.deepEqual(h.reattached, ["live-read:default->plan"])
  assert.deepEqual(h.sent, [])
})
