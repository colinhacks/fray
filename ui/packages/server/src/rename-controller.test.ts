import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { BoardManager } from "./board.ts"
import { createClaudeRenameController, humanizeClaudeTitle, type RenameTerminal } from "./rename-controller.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

function session(slug: string, backend: "claude" | "codex" = "claude"): SessionRow {
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
    title_auto: 1,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: null,
    backend,
  }
}

function telemetry(overrides: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    turn: "idle",
    permPrompt: false,
    pendingQuestion: false,
    subAgents: [],
    bgShells: [],
    customTitleRevision: 0,
    ...overrides,
  }
}

function harness(opts: {
  slug?: string
  backend?: "claude" | "codex"
  tele?: SessionTelemetry
  pane?: string
  live?: boolean
  titlesAfterSubmit?: string[]
  literalError?: boolean
  literalErrorAt?: number
  enterError?: boolean
  onFirstWait?: (storage: ReturnType<typeof createStorage>, slug: string) => void
}) {
  const slug = opts.slug ?? "generated-slug"
  const dir = mkdtempSync(join(tmpdir(), "fray-rename-controller-"))
  const storage = createStorage(join(dir, "ui.db"))
  storage.upsertSession(session(slug, opts.backend))
  if (opts.backend === "codex") storage.setBackend(slug, "codex")
  let current = opts.tele ?? telemetry()
  let now = 0
  let submissions = 0
  let literalCalls = 0
  let refreshes = 0
  let waited = false
  const calls: string[] = []
  const tailer = {
    get: () => current,
    tick: () => {},
  } as unknown as Tailer
  const board = {
    refresh: () => { refreshes++; return undefined },
  } as unknown as BoardManager
  const terminal: RenameTerminal = {
    isLive: () => opts.live ?? true,
    capturePane: () => opts.pane ?? "❯\u00a0\n────────────────────────────\n",
    sendLiteral: (_slug, text) => {
      literalCalls++
      if (opts.literalError || opts.literalErrorAt === literalCalls) throw new Error("send failed")
      calls.push(`literal:${text}`)
    },
    sendKey: (_slug, key) => {
      if (opts.enterError) throw new Error("enter failed")
      calls.push(`key:${key}`)
      submissions++
    },
  }
  const controller = createClaudeRenameController({
    storage,
    tailer,
    board,
    terminal,
    now: () => now,
    timeoutMs: 300,
    wait: async (ms) => {
      now += ms
      if (!waited) {
        waited = true
        opts.onFirstWait?.(storage, slug)
      }
      const nextTitle = opts.titlesAfterSubmit?.[submissions - 1]
      if (submissions > 0 && nextTitle !== undefined && (current.customTitleRevision ?? 0) < submissions) {
        current = telemetry({ customTitle: nextTitle, customTitleRevision: submissions, aiTitle: nextTitle })
      }
    },
  })
  return { slug, storage, controller, calls, refreshes: () => refreshes }
}

test("humanizeClaudeTitle converts Claude's semantic slug without altering a readable native title", () => {
  // SENTENCE case — first word capitalized, the rest left lowercase (repo copy rule; see AGENTS.md).
  assert.equal(humanizeClaudeTitle("conversation-acknowledgment"), "Conversation acknowledgment")
  assert.equal(humanizeClaudeTitle("fix-queue-focus"), "Fix queue focus")
  assert.equal(humanizeClaudeTitle("Readable native title"), "Readable native title")
  assert.equal(humanizeClaudeTitle(""), undefined)
})

test("Claude AI rename generates, sets, observes, and persists an exact human-readable native title", async () => {
  const h = harness({ titlesAfterSubmit: ["conversation-acknowledgment", "Conversation acknowledgment"] })
  const result = await h.controller.rename(h.slug)
  assert.deepEqual(result, { title: "Conversation acknowledgment" })
  assert.deepEqual(h.calls, ["literal:/rename", "key:Enter", "literal:/rename Conversation acknowledgment", "key:Enter"])
  assert.equal(h.storage.getSession(h.slug)?.title, "Conversation acknowledgment")
  assert.equal(h.storage.getSession(h.slug)?.title_auto, 0, "later ai-title/slug records cannot replace the observed result")
  assert.equal(h.refreshes(), 1)
  h.storage.close()
})

test("Claude AI rename fails before terminal input for busy turns, terminal drafts, dead sessions, and Codex", async (t) => {
  const cases = [
    { name: "busy", opts: { tele: telemetry({ turn: "in-flight" }) }, error: /idle Claude thread/ },
    { name: "draft", opts: { pane: "❯ write this first\n────────────────────────────\n" }, error: /submit or clear.*draft/ },
    { name: "dead", opts: { live: false }, error: /live Claude session/ },
    { name: "codex", opts: { backend: "codex" as const }, error: /Codex does not support AI rename/ },
  ]
  for (const c of cases) await t.test(c.name, async () => {
    const h = harness(c.opts)
    await assert.rejects(h.controller.rename(h.slug), c.error)
    assert.deepEqual(h.calls, [], "failed preconditions never inject terminal input")
    h.storage.close()
  })
})

test("AI rename rejects a stale row snapshot without capturing or sending to its same-slug replacement", async () => {
  const slug = "rename-stale-row"
  const dir = mkdtempSync(join(tmpdir(), "fray-rename-aba-"))
  const storage = createStorage(join(dir, "ui.db"))
  const stale = { ...session(slug), session_id: "owner-a", runtime_generation: 2 }
  storage.upsertSession(stale)
  storage.upsertSession({ ...session(slug), session_id: "owner-b", runtime_generation: 0 })
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
  const calls: string[] = []
  const controller = createClaudeRenameController({
    storage: staleStorage,
    tailer: { get: () => telemetry(), tick: () => {} } as unknown as Tailer,
    board: { refresh: () => undefined } as unknown as BoardManager,
    terminal: {
      isLive: () => (calls.push("live"), true),
      capturePane: () => (calls.push("capture"), "❯\u00a0\n────────\n"),
      sendLiteral: () => void calls.push("send"),
      sendKey: () => void calls.push("key"),
    },
  })
  await assert.rejects(controller.rename(slug), /competing adoption attempt|no worker was contacted|runtime control/)
  assert.deepEqual(calls, [])
})

test("Claude AI rename never persists the generated slug when readable-title confirmation is ambiguous", async () => {
  const h = harness({ titlesAfterSubmit: ["generated-slug", "different-title"] })
  await assert.rejects(h.controller.rename(h.slug), /did not confirm the readable title/)
  assert.equal(h.storage.getSession(h.slug)?.title, "generated-slug")
  assert.equal(h.storage.getSession(h.slug)?.title_auto, 1, "invalid result is not committed as an explicit title")
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

test("concurrent Claude AI rename requests share one native submission", async () => {
  const h = harness({ titlesAfterSubmit: ["One generated title"] })
  const first = h.controller.rename(h.slug)
  assert.equal(h.controller.isPending(h.slug), true)
  const [a, b] = await Promise.all([first, h.controller.rename(h.slug)])
  assert.deepEqual(a, b)
  assert.deepEqual(h.calls, ["literal:/rename", "key:Enter"])
  assert.equal(h.controller.isPending(h.slug), false)
  h.storage.close()
})

test("adopted AI rename uses one exact text+Enter action and fails closed on an in-action replacement", async () => {
  const slug = "adopted-rename"
  const dir = mkdtempSync(join(tmpdir(), "fray-rename-adopted-"))
  const storage = createStorage(join(dir, "ui.db"))
  const saved = session(slug)
  saved.session_id = randomUUID()
  const token = randomUUID()
  assert.equal(storage.reserveAdoptionClaim({ slug, attemptToken: token, sessionId: saved.session_id, reservedAtMs: 1, leaseExpiresAtMs: 2 }), true)
  assert.equal(storage.recordAdoptionPane(slug, token, { paneId: "%12", panePid: 1200, sessionCreated: 12000 }, 2), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, token, saved, 2), true)
  const calls: string[] = []
  const terminal: RenameTerminal = {
    isLive: () => true,
    capturePane: () => { calls.push("slug-capture"); return "" },
    captureExpectedAdoptionPane: () => ({ kind: "captured", text: "❯\u00a0\n────────────────────────────\n" }),
    sendLiteral: () => void calls.push("slug-literal"),
    sendKey: () => void calls.push("slug-key"),
    sendTextToExpectedAdoptionPane: (_expected, text, submit) => {
      calls.push(`exact:${text}:${submit}`)
      return false
    },
  }
  const controller = createClaudeRenameController({
    storage,
    tailer: { get: () => telemetry(), tick: () => {} } as unknown as Tailer,
    board: { refresh: () => undefined } as unknown as BoardManager,
    terminal,
  })
  await assert.rejects(controller.rename(slug), /runtime identity changed.*nothing was submitted/)
  assert.deepEqual(calls, ["exact:/rename:true"])
  storage.close()
})

test("rename submission failures distinguish a safe retry from ambiguous staged input", async (t) => {
  await t.test("literal staging failed", async () => {
    const h = harness({ literalError: true })
    await assert.rejects(h.controller.rename(h.slug), /no command was submitted.*safe to retry/)
    h.storage.close()
  })
  await t.test("Enter failed after staging", async () => {
    const h = harness({ enterError: true })
    await assert.rejects(h.controller.rename(h.slug), /may be staged.*inspect Terminal before retrying/)
    assert.deepEqual(h.calls, ["literal:/rename"])
    h.storage.close()
  })
  await t.test("readable confirmation staging failed after bare rename succeeded", async () => {
    const h = harness({ titlesAfterSubmit: ["generated-internal-name"], literalErrorAt: 2 })
    await assert.rejects(h.controller.rename(h.slug), /generated an internal title.*manual rename or retry AI rename/)
    assert.deepEqual(h.calls, ["literal:/rename", "key:Enter"])
    assert.equal(h.storage.getSession(h.slug)?.title, h.slug, "the intermediate native slug is never persisted")
    h.storage.close()
  })
})

test("a native success plus persistence failure tells the user the exact manual recovery", async () => {
  const h = harness({ titlesAfterSubmit: ["Readable native title"] })
  h.storage.setTitleIfCurrent = () => { throw new Error("disk full") }
  await assert.rejects(h.controller.rename(h.slug), /renamed the session to “Readable native title”.*set that title manually/)
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

test("a later manual title or replacement session wins the asynchronous AI rename race", async (t) => {
  await t.test("manual title", async () => {
    const h = harness({
      titlesAfterSubmit: ["Readable native title"],
      onFirstWait: (storage, slug) => storage.setTitle(slug, "Newer manual title"),
    })
    await assert.rejects(h.controller.rename(h.slug), /newer state was kept/)
    assert.equal(h.storage.getSession(h.slug)?.title, "Newer manual title")
    h.storage.close()
  })
  await t.test("replacement session", async () => {
    const h = harness({
      titlesAfterSubmit: ["Readable native title"],
      onFirstWait: (storage, slug) => {
        const current = storage.getSession(slug)!
        storage.upsertSession({ ...current, session_id: "replacement-session", title: "Replacement title" })
      },
    })
    await assert.rejects(h.controller.rename(h.slug), /newer state was kept/)
    assert.equal(h.storage.getSession(h.slug)?.session_id, "replacement-session")
    assert.equal(h.storage.getSession(h.slug)?.title, "Replacement title")
    h.storage.close()
  })
})
