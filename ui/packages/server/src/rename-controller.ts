import type { BoardManager } from "./board.ts"
import { inspectClaudeComposer } from "./permission-controller.ts"
import type { Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import * as tmux from "./tmux.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"

const POLL_MS = 100
const TIMEOUT_MS = 15_000
const TITLE_MAX = 200

export interface RenameTerminal {
  isLive(slug: string): boolean
  capturePane(slug: string): string
  captureExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane): tmux.ExactPaneCapture
  sendLiteral(slug: string, text: string): void
  sendKey(slug: string, key: "Enter"): void
  sendTextToExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, text: string, submit: boolean): boolean
}

export interface ClaudeRenameController {
  rename(slug: string): Promise<{ title: string }>
  isPending(slug: string): boolean
}

interface RenameControllerDeps {
  storage: Storage
  tailer: Tailer
  board: BoardManager
  terminal?: RenameTerminal
  wait?: (ms: number) => Promise<void>
  now?: () => number
  timeoutMs?: number
}

export function humanizeClaudeTitle(raw: string | undefined): string | undefined {
  const title = raw?.trim()
  if (!title || title.length > TITLE_MAX) return undefined
  // Claude 2.1.207's bare `/rename` deliberately emits a semantic kebab-case agent name. It is useful
  // input, but not a UI title. Preserve an already-readable custom title; otherwise turn the native
  // slug into words before setting that readable phrase back through Claude's own direct form.
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(title)) return title
  // SENTENCE case (capitalize only the first word) — thread titles follow the repo copy rule (see
  // AGENTS.md), never Title Case.
  const words = title.split(/[-_]+/).filter(Boolean)
  if (words.length === 0) return undefined
  const readable = [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ")
  return readable || undefined
}

// One controller per router/server generation. Its in-flight map makes simultaneous clicks/tabs share
// the same native command rather than submitting `/rename` twice.
export function createClaudeRenameController(deps: RenameControllerDeps): ClaudeRenameController {
  const terminal: RenameTerminal = deps.terminal ?? {
    isLive: tmux.isLive,
    capturePane: tmux.capturePane,
    captureExpectedAdoptionPane: tmux.captureExpectedAdoptionPane,
    sendLiteral: tmux.sendLiteral,
    sendKey: (slug, key) => tmux.sendKey(slug, key),
    sendTextToExpectedAdoptionPane: tmux.sendTextToExpectedAdoptionPane,
  }
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  const inFlight = new Map<string, Promise<{ title: string }>>()

  async function run(slug: string): Promise<{ title: string }> {
    const initial = deps.storage.getSession(slug)
    if (!initial) throw new Error(`thread ${slug} is not editable`)
    const revision = deps.storage.beginRuntimeControl(slug, {
      sessionId: initial.session_id,
      nativeSessionId: initial.agent_session_id ?? null,
      generation: initial.runtime_generation ?? 0,
    }, "ai-rename")
    if (revision === null) throw new Error("AI rename is blocked by another runtime control or queued input")
    try {
      return await runOwned(slug)
    } finally {
      const current = deps.storage.getSession(slug)
      if (current?.session_id === initial.session_id) {
        deps.storage.releaseRuntimeControl(slug, {
          sessionId: initial.session_id,
          generation: current.runtime_generation ?? 0,
          kind: "ai-rename",
          revision,
        })
      }
    }
  }

  async function runOwned(slug: string): Promise<{ title: string }> {
    const row = deps.storage.getSession(slug)
    if (!row) throw new Error(`thread ${slug} is not editable`)
    if (row.backend === "codex") throw new Error("Codex does not support AI rename; set the title manually")
    const runtimeBinding = adoptionRuntimeBinding(deps.storage, row)
    if (runtimeBinding.kind === "conflict") {
      throw new Error("AI rename is blocked by a competing adoption attempt; no worker was contacted")
    }
    const adoption = runtimeBinding.kind === "bound" ? runtimeBinding.claim : undefined
    const captureOwnedPane = (): string | undefined => {
      if (!adoption) return terminal.isLive(slug) ? terminal.capturePane(slug) : undefined
      const captured = terminal.captureExpectedAdoptionPane?.(adoption)
      return captured?.kind === "captured" ? captured.text : undefined
    }
    if (captureOwnedPane() === undefined) throw new Error("AI rename requires the exact live Claude session; set the title manually or resume the thread")

    // Fold transcript bytes already on disk before taking the revision baseline. A prior /rename must
    // never satisfy this request merely because the normal 1s tail tick had not consumed it yet.
    deps.tailer.tick()
    const before = deps.tailer.get(slug)
    if (!before) throw new Error("Claude runtime state is still loading; retry in a moment")
    if (before.permPrompt || before.pendingAsk || before.nativeInputRequired) {
      throw new Error("Resolve Claude's current terminal prompt before using AI rename")
    }
    if (before.turn !== "idle") throw new Error("AI rename requires an idle Claude thread; retry when the current turn finishes")

    const initialPane = captureOwnedPane()
    if (initialPane === undefined) throw new Error("Claude's runtime identity changed before /rename; nothing was submitted")
    const composer = inspectClaudeComposer(initialPane)
    if (composer.kind === "typed") {
      throw new Error("AI rename blocked: submit or clear the existing Claude terminal draft, then retry")
    }
    if (composer.kind !== "empty") {
      throw new Error("AI rename blocked by the current Claude terminal screen; return it to the idle prompt and retry")
    }

    function submitExact(command: string, stage: "generate" | "confirm"): void {
      if (adoption) {
        const submitted = terminal.sendTextToExpectedAdoptionPane?.(adoption, command, true) === true
        if (!submitted) throw new Error("Claude's runtime identity changed before /rename; nothing was submitted")
        return
      }
      if (!terminal.isLive(slug)) throw new Error("Claude's runtime identity changed before /rename; nothing was submitted")
      try {
        terminal.sendLiteral(slug, command)
      } catch {
        if (stage === "generate") {
          throw new Error("Could not stage Claude's /rename command; no command was submitted, so it is safe to retry")
        }
        throw new Error("Claude generated an internal title, but Fray could not stage the readable title; use manual rename or retry AI rename")
      }
      try {
        terminal.sendKey(slug, "Enter")
      } catch {
        throw new Error(
          stage === "generate"
            ? "Claude's /rename command may be staged but was not confirmed; inspect Terminal before retrying"
            : "Claude's readable /rename command may be staged but was not confirmed; inspect Terminal before retrying",
        )
      }
    }

    async function observeAfter(baseline: number): Promise<{ title: string; revision: number }> {
      const deadline = now() + timeoutMs
      while (now() < deadline) {
        await wait(POLL_MS)
        deps.tailer.tick()
        const after = deps.tailer.get(slug)
        const revision = after?.customTitleRevision ?? 0
        if (revision > baseline && after?.customTitle?.trim()) return { title: after.customTitle.trim(), revision }
        if (captureOwnedPane() === undefined) {
          throw new Error("Claude exited after /rename was submitted; inspect Terminal before retrying")
        }
      }
      throw new Error("Claude accepted /rename but no title appeared within 15 seconds; inspect Terminal before retrying")
    }

    submitExact("/rename", "generate")
    const generated = await observeAfter(before.customTitleRevision ?? 0)
    const readable = humanizeClaudeTitle(generated.title)
    if (!readable || readable.length > TITLE_MAX) {
      throw new Error("Claude returned an invalid internal title; nothing was saved—use manual rename or retry once")
    }

    // Bare /rename yields a slug in current Claude Code. Align the native session title with what the
    // UI will display by using the documented argument form, but only after re-verifying the exact
    // empty idle composer—never type over a draft or navigate a slash menu.
    if (generated.title !== readable) {
      const nextPane = captureOwnedPane()
      if (nextPane === undefined) throw new Error("Claude's runtime identity changed after /rename; inspect Terminal before retrying")
      const nextComposer = inspectClaudeComposer(nextPane)
      if (nextComposer.kind !== "empty") {
        throw new Error("Claude generated a title but its prompt is no longer empty; inspect Terminal before retrying")
      }
      submitExact(`/rename ${readable}`, "confirm")
      const confirmed = await observeAfter(generated.revision)
      if (confirmed.title !== readable) {
        throw new Error("Claude did not confirm the readable title; nothing was saved—inspect Terminal before retrying")
      }
    }

    // Treat the exact observed native result as explicit user intent. Clearing title_auto prevents any
    // later/stale ai-title record (including a slug-shaped one) from replacing it after refresh.
    let committed: boolean
    try {
      committed = deps.storage.setTitleIfCurrent(slug, readable, {
        sessionId: row.session_id,
        title: row.title,
        titleAuto: row.title_auto,
      })
    } catch {
      throw new Error(`Claude renamed the session to “${readable}”, but Fray could not save it; set that title manually`)
    }
    if (!committed) {
      throw new Error("The thread or its title changed while Claude was renaming; the newer state was kept")
    }
    deps.board.refresh()
    return { title: readable }
  }

  return {
    rename(slug) {
      const existing = inFlight.get(slug)
      if (existing) return existing
      const promise = run(slug).finally(() => inFlight.delete(slug))
      inFlight.set(slug, promise)
      return promise
    },
    isPending: (slug) => inFlight.has(slug),
  }
}
