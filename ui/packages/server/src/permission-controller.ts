import {
  CODEX_INPUT_CONFIRMATION_TIMEOUT_MS,
  PermissionMode,
  type PermissionMode as PermissionModeValue,
} from "@fray-ui/shared"
import type { BoardManager } from "./board.ts"
import type { RuntimeExpectation, SessionRow, Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import * as tmux from "./tmux.ts"
import { effectivePermissionMode } from "./dispatch.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"

const POLL_MS = 750
// Durable machine signal, not UI copy. board.ts turns this into a terse failure state while
// retaining the delivery id so the originating composer can restore its exact draft.
export const STEER_FAILURE_PREFIX = "fray-steer-failed:"

export interface PermissionTerminal {
  isLive(slug: string): boolean
  paneIdentity?(slug: string): tmux.PaneIdentity | null
  capturePane(slug: string): string
  capturePaneEscaped(slug: string): string
  sendLiteral(slug: string, text: string): void
  sendTextWithKey?(slug: string, text: string, key: "Enter" | "Tab"): boolean
  sendKey(slug: string, key: "Enter" | "Tab" | "Up" | "Down" | "Escape"): void
  findExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane): tmux.AdoptionPaneLookup
  captureExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, escaped?: boolean): tmux.ExactPaneCapture
  sendTextToExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, text: string, submit: boolean): boolean
  sendTextWithKeyToExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, text: string, key: "Enter" | "Tab"): boolean
  sendKeyToExpectedAdoptionPane?(
    expected: tmux.ExpectedAdoptionPane,
    key: "Enter" | "Tab" | "Up" | "Down" | "Escape",
  ): boolean
}

export interface PermissionController {
  request(slug: string, requested: PermissionModeValue): Promise<{ effect: "applied" | "next-resume" }>
  queueFollowUp(slug: string, message: string, deliveryId?: string, expectedSessionId?: string): void
  submitExistingDraft(slug: string): { effect: "submitted" }
  prepareCodexDraftReplacement(slug: string): { queuedMessage: string }
  clearAmbiguousCodexInput(slug: string): { effect: "cleared" }
  tick(): void
  start(): void
  stop(): void
}

interface PermissionControllerDeps {
  storage: Storage
  tailer: Tailer
  board: BoardManager
  terminal?: PermissionTerminal
  reattach?: (
    slug: string,
    current: PermissionModeValue,
    requested: PermissionModeValue,
    onGeneration?: (generation: number) => void,
  ) => Promise<{ generation: number } | void>
  now?: () => number
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (text: string) => text.replace(ANSI_RE, "")

// Claude's resume sidecar can lag one process generation: the process being replaced appends its
// permission-mode record during shutdown, after the controller's pre-handoff transcript fold. The
// new TUI footer, however, renders the mode that is actually active in the newly created pane. Read
// only the footer tail (never transcript history) so that launch-time coercion such as unsupported
// Auto on Haiku is authoritative without mistaking the old process's shutdown record for the new one.
export function detectClaudePermissionMode(pane: string): PermissionModeValue | undefined {
  const lines = stripAnsi(pane).split("\n")
  let prompt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯(?:\u00a0|\s)*$/u.test(lines[i])) {
      prompt = i
      break
    }
  }
  if (prompt < 0) return undefined
  const footer = lines.slice(prompt + 1, prompt + 15).join("\n")
  if (/\bbypass permissions on\b/i.test(footer)) return "bypassPermissions"
  if (/\baccept edits(?: mode)? on\b/i.test(footer)) return "acceptEdits"
  if (/\bauto mode on\b/i.test(footer)) return "auto"
  if (/\bmanual mode on\b/i.test(footer)) return "default"
  return undefined
}

export interface QueuedInput {
  text: string
  enqueuedAt: string
  state: "pending" | "submitted"
  submittedAt?: string
  // Positive native Codex ownership observed for an already-queued input before JSONL emits
  // user_message. Kept durable so queues created by an earlier Fray process can drain safely even
  // after their native block scrolls away.
  providerQueuedAt?: string
  source?: "existing-draft"
  match?: "normalized"
  deliveryId?: string
}

function isQueuedInput(item: unknown): item is QueuedInput {
  if (!item || typeof item !== "object") return false
  const candidate = item as Partial<QueuedInput>
  return typeof candidate.text === "string" &&
    typeof candidate.enqueuedAt === "string" &&
    (candidate.state === "pending" || candidate.state === "submitted") &&
    (candidate.submittedAt === undefined || typeof candidate.submittedAt === "string") &&
    (candidate.providerQueuedAt === undefined || typeof candidate.providerQueuedAt === "string") &&
    (candidate.source === undefined || candidate.source === "existing-draft") &&
    (candidate.match === undefined || candidate.match === "normalized") &&
    (candidate.deliveryId === undefined || typeof candidate.deliveryId === "string")
}

export function parseCodexInputQueue(
  value: string | null | undefined,
): { valid: boolean; items: QueuedInput[] } {
  if (!value) return { valid: true, items: [] }
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every(isQueuedInput)) return { valid: false, items: [] }
    return { valid: true, items: parsed }
  } catch {
    return { valid: false, items: [] }
  }
}

function parseInputQueue(value: string | null | undefined): QueuedInput[] {
  return parseCodexInputQueue(value).items
}

const normalizedInput = (value: string) => value.replace(/\s+/g, " ").trim()

export type CodexComposerState =
  | { kind: "empty" }
  | { kind: "typed"; text: string; queueHint: boolean }
  | { kind: "unavailable" }

export type ClaudeComposerState =
  | { kind: "empty" }
  | { kind: "typed"; text: string }
  | { kind: "unavailable" }

type CodexComposerCapture =
  | { kind: "empty" }
  | { kind: "typed"; parts: string[]; queueHint: boolean }
  | { kind: "unavailable" }

const codexDimAnsi = /\x1b\[(?:\d+;)*2(?:;\d+)*m/
const codexModelFooter = /^(?:gpt-[\w.-]+|o\d[\w.-]*)(?:\s+(?:low|medium|high|xhigh|max|ultra|default))?\s+·\s+\S+/i

function isCodexDimFooter(line: string): boolean {
  const plain = stripAnsi(line).trim()
  return codexDimAnsi.test(line) && (
    /^tab to queue message\b/i.test(plain) ||
    /^\d+%\s+context left\b/i.test(plain)
  )
}

function isCodexStyledModelFooter(line: string): boolean {
  return /\x1b\[/.test(line) && codexModelFooter.test(stripAnsi(line).trim())
}

function codexQueueHint(escapedPane: string): boolean {
  const lines = escapedPane.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/\x1b\[(?:0;)?1m›\x1b\[0m/.test(lines[i])) continue
    return lines.slice(i + 1).some((line) => {
      const plain = stripAnsi(line).trimStart()
      return codexDimAnsi.test(line) && plain.startsWith("tab to queue message")
    })
  }
  return false
}

// Capture only Codex's LAST bold composer prompt. Keeping the visual rows lets the durable-input
// controller distinguish content from Codex's own width-dependent line breaks without treating an
// arbitrary difference inside a row as equivalent.
function captureCodexComposer(escapedPane: string): CodexComposerCapture {
  const lines = escapedPane.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    // Codex emits both SGR `1` and the equivalent reset-plus-bold `0;1` across redraws.
    const matches = [...lines[i].matchAll(/\x1b\[(?:0;)?1m›\x1b\[0m/g)]
    const marker = matches.at(-1)
    if (!marker || marker.index === undefined) continue
    const raw = lines[i].slice(marker.index + marker[0].length)
    if (/^\s*\x1b\[2m/.test(raw)) return { kind: "empty" }
    const parts = [stripAnsi(raw).trim()]
    for (let j = i + 1; j < lines.length; j++) {
      const part = stripAnsi(lines[j]).trim()
      if (!part) {
        const footer = lines.slice(j + 1).filter((line) => stripAnsi(line).trim())
        if (!footer.every((line) => isCodexDimFooter(line) || isCodexStyledModelFooter(line))) {
          return { kind: "unavailable" }
        }
        break
      }
      parts.push(part)
    }
    return {
      kind: "typed",
      parts,
      // The phrase can occur in transcript history or in the user's draft. Trust only Codex's dim
      // footer after this (last) composer marker, never a global plain-text match.
      queueHint: codexQueueHint(escapedPane),
    }
  }
  return { kind: "unavailable" }
}

// Inspect only Codex's bold composer prompt. Empty suggestions are dim; real typed text is not.
// Plain text after a paragraph gap is ambiguous with Codex's unstyled footer, so it fails closed.
export function inspectCodexComposer(escapedPane: string): CodexComposerState {
  const captured = captureCodexComposer(escapedPane)
  if (captured.kind !== "typed") return captured
  const { parts, queueHint } = captured
    // Codex reflows a draft to the pane width. Ordinary continuation rows break at whitespace, but
    // hyphenated tokens are allowed to break immediately AFTER the hyphen (for example
    // `restart-` + `test`). Joining every visual row with a space silently changes that draft to
    // `restart- test`, so the durable queue no longer recognizes the exact text it just injected.
    // Suppress the synthetic space only for a word-ending hyphen; a standalone ` -` still keeps its
    // real following space. This stays deliberately narrow/fail-closed for every other ambiguous
    // visual wrap rather than auto-submitting text we cannot prove is ours.
    const text = parts.reduce((joined, part, index) => {
      if (index === 0) return part
      return `${joined}${/\S-$/.test(joined) ? "" : " "}${part}`
    }, "")
    return {
      kind: "typed",
      text: normalizedInput(text),
      queueHint,
    }
}

// Compare a persisted queue item with the visual composer without guessing where Codex inserted a
// soft row break. Every boundary may represent either zero characters (a token split) or one
// normalized whitespace character (a word/newline break); differences anywhere INSIDE a row still
// fail closed. The position-set DP is linear in practice and cannot explode as 2^rows.
export function codexComposerMatches(escapedPane: string, expected: string): boolean {
  const captured = captureCodexComposer(escapedPane)
  if (captured.kind !== "typed" || captured.parts.length === 0) return false
  const target = normalizedInput(expected)
  const parts = captured.parts.map(normalizedInput)
  if (!target.startsWith(parts[0])) return false
  let positions = new Set([parts[0].length])
  for (const part of parts.slice(1)) {
    const next = new Set<number>()
    for (const position of positions) {
      for (const separator of ["", " "]) {
        const token = separator + part
        if (target.startsWith(token, position)) next.add(position + token.length)
      }
    }
    if (next.size === 0) return false
    positions = next
  }
  return positions.has(target.length)
}

// Codex can visibly own a queued follow-up before JSONL emits a user_message. Require both its native
// label and the exact text in its bounded local section; history text alone is never enough proof to
// suppress the fail-closed path. This recognizes queues created by an earlier Fray process while new
// browser follow-ups use Enter to steer the active turn. A queued message can span many visual rows,
// so the block ends only at the next Codex composer marker (with a defensive line cap), never after
// an arbitrary handful of wrapped lines.
export function codexNativeQueuedInputMatches(escapedPane: string, expected: string): boolean {
  const expectedText = normalizedInput(expected)
  if (!expectedText) return false
  const lines = escapedPane.split("\n").map((line) => normalizedInput(stripAnsi(line)))
  for (let i = 0; i < lines.length; i++) {
    if (!/^queued follow-?up(?: inputs?|s?)(?:\s*\(\d+\)|\s*:\s*)?$/i.test(lines[i])) continue
    const block: string[] = []
    for (const line of lines.slice(i + 1, i + 241)) {
      if (/^›(?:\s|$)/u.test(line)) break
      block.push(line)
    }
    const visible = normalizedInput(block.join(" "))
    if (visible.includes(expectedText)) return true
  }
  return false
}

// Claude's idle composer is the last `❯` row immediately above its footer divider. A trust prompt,
// selector, or other modal may also use `❯`, but always carries text and therefore fails closed as a
// nonempty input. This check exists only to protect unsent drafts before a controlled idle reattach;
// it never drives menu navigation or submits terminal input.
export function inspectClaudeComposer(pane: string): ClaudeComposerState {
  const lines = stripAnsi(pane).split("\n")
  let prompt = -1
  let first = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^❯(?:\u00a0|\s)?(.*)$/u)
    if (!match) continue
    prompt = i
    first = match[1]
    break
  }
  if (prompt === -1) return { kind: "unavailable" }

  const divider = lines.findIndex((line, i) => i > prompt && /^\s*[─━]{8,}/u.test(line))
  if (divider === -1) return { kind: "unavailable" }
  // A draft can begin with a blank first line and continue below the `❯` row. Everything up to the
  // real footer divider belongs to the composer; never inspect only the marker row.
  const text = normalizedInput([first, ...lines.slice(prompt + 1, divider)].join(" "))
  if (text) return { kind: "typed", text }

  // Fail closed if the empty prompt is stale above later modal/output content. Real idle footer rows
  // are blank, the project/status line (`·`), the mode line (`⏵⏵`), or the standard shortcut/context
  // hint. Unknown content below the divider means this is not a provably current idle composer.
  const footer = lines.slice(divider + 1).map((line) => line.trim()).filter(Boolean)
  const idleFooter = (line: string) =>
    line.includes(" · ") || /^[⏵⏸?]/u.test(line) || /(?:for shortcuts|context left|tokens left|shift\+tab)/i.test(line)
  return footer.every(idleFooter) ? { kind: "empty" } : { kind: "unavailable" }
}

function pendingMode(value: unknown): PermissionModeValue | undefined {
  const parsed = PermissionMode.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function createPermissionController(deps: PermissionControllerDeps): PermissionController {
  const terminal: PermissionTerminal = deps.terminal ?? {
    isLive: tmux.isLive,
    capturePane: tmux.capturePane,
    capturePaneEscaped: tmux.capturePaneEscaped,
    sendLiteral: tmux.sendLiteral,
    sendTextWithKey: tmux.sendTextWithKey,
    sendKey: tmux.sendKey,
    findExpectedAdoptionPane: tmux.findExpectedAdoptionPane,
    captureExpectedAdoptionPane: tmux.captureExpectedAdoptionPane,
    sendTextToExpectedAdoptionPane: tmux.sendTextToExpectedAdoptionPane,
    sendTextWithKeyToExpectedAdoptionPane: tmux.sendTextWithKeyToExpectedAdoptionPane,
    sendKeyToExpectedAdoptionPane: tmux.sendKeyToExpectedAdoptionPane,
  }
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | null = null
  const activePermissionRequests = new Set<string>()

  type RuntimeState = "live" | "absent" | "conflict" | "unavailable"

  function runtimeState(row: SessionRow): RuntimeState {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return "conflict"
    if (binding.kind === "unbound") return terminal.isLive(row.slug) ? "live" : "absent"
    const current = terminal.findExpectedAdoptionPane?.(binding.claim)
    if (!current || current.kind === "unknown") return "unavailable"
    return current.kind === "found" && !current.pane.dead ? "live" : "absent"
  }

  function captureOwned(row: SessionRow, escaped: boolean): string | undefined {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return undefined
    if (binding.kind === "unbound") {
      if (!terminal.isLive(row.slug)) return undefined
      return escaped ? terminal.capturePaneEscaped(row.slug) : terminal.capturePane(row.slug)
    }
    const captured = terminal.captureExpectedAdoptionPane?.(binding.claim, escaped)
    return captured?.kind === "captured" ? captured.text : undefined
  }

  function sendTextWithKeyOwned(row: SessionRow, text: string, key: "Enter" | "Tab"): boolean {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return false
    if (binding.kind === "bound") {
      return terminal.sendTextWithKeyToExpectedAdoptionPane?.(binding.claim, text, key) === true
    }
    if (!terminal.isLive(row.slug)) return false
    return terminal.sendTextWithKey?.(row.slug, text, key) === true
  }

  function sendKeyOwned(
    row: SessionRow,
    key: "Enter" | "Tab" | "Up" | "Down" | "Escape",
  ): boolean {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return false
    if (binding.kind === "bound") {
      return terminal.sendKeyToExpectedAdoptionPane?.(binding.claim, key) === true
    }
    if (!terminal.isLive(row.slug)) return false
    terminal.sendKey(row.slug, key)
    return true
  }

  function setError(slug: string, error: string | null): void {
    const row = deps.storage.getSession(slug)
    if (!row || (row.control_error ?? null) === error) return
    if (deps.storage.setControlErrorIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, error)) {
      deps.board.refresh()
    }
  }

  function writeQueue(slug: string, queue: QueuedInput[], expectedRow?: SessionRow): void {
    const row = expectedRow ?? deps.storage.getSession(slug)
    if (!row) throw new Error(`session ${slug} is no longer available`)
    const saved = deps.storage.setCodexInputQueueIfCurrent(
      slug,
      {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        queue: row.codex_input_queue ?? null,
      },
      queue.length ? JSON.stringify(queue) : null,
    )
    if (!saved) throw new Error("Codex input changed while this action was running; refresh and retry")
    deps.board.refresh()
  }

  function ownCodexInput(row: SessionRow): SessionRow {
    if (row.runtime_control === "codex-input") return row
    if (row.runtime_control !== null && row.runtime_control !== undefined) {
      throw new Error("Another runtime control is in progress; queued input was not changed")
    }
    const revision = deps.storage.beginRuntimeControl(row.slug, {
      sessionId: row.session_id,
      nativeSessionId: row.agent_session_id ?? null,
      generation: row.runtime_generation ?? 0,
    }, "codex-input")
    if (revision === null) throw new Error("This thread changed before queued input could take control")
    const owned = deps.storage.getSession(row.slug)
    if (!owned || owned.session_id !== row.session_id || owned.runtime_control_revision !== revision) {
      throw new Error("Queued input lost runtime ownership before it could be persisted")
    }
    return owned
  }

  function releaseCodexInput(row: SessionRow): void {
    if (row.runtime_control !== "codex-input") return
    deps.storage.releaseRuntimeControl(row.slug, {
      sessionId: row.session_id,
      generation: row.runtime_generation ?? 0,
      kind: "codex-input",
      revision: row.runtime_control_revision ?? 0,
    })
  }

  function queueFollowUp(slug: string, message: string, deliveryId?: string, expectedSessionId?: string): void {
    let row = deps.storage.getSession(slug)
    if (expectedSessionId && row?.session_id !== expectedSessionId) {
      throw new Error("This thread was replaced before queued input could take control")
    }
    if (!row || row.backend !== "codex" || runtimeState(row) !== "live") {
      throw new Error(`live Codex session ${slug} is not available`)
    }
    if (row.runtime_control !== null && row.runtime_control !== undefined && row.runtime_control !== "codex-input") {
      throw new Error("Wait for the current runtime control to finish before sending a follow-up")
    }
    if (activePermissionRequests.has(slug) || row.permission_pending !== null && row.permission_pending !== undefined) {
      throw new Error("Wait for the current permission change to finish before sending a follow-up")
    }
    if (!parseCodexInputQueue(row.codex_input_queue).valid) {
      throw new Error("Durable Codex input state is invalid; clear or repair it before sending another follow-up")
    }
    row = ownCodexInput(row)
    if (row.state === "archived" || row.archived === 1) {
      if (!deps.storage.setStateIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, "open")) {
        throw new Error("The thread changed before it could be reopened; no input was queued")
      }
    }
    const queue = parseInputQueue(row.codex_input_queue)
    if (deliveryId) {
      const existing = queue.find((item) => item.deliveryId === deliveryId)
      if (existing) {
        if (existing.text !== message) throw new Error("Wake delivery id was reused with different input")
        setError(slug, null)
        return
      }
    }
    queue.push({ text: message, enqueuedAt: new Date(now()).toISOString(), state: "pending", ...(deliveryId ? { deliveryId } : {}) })
    writeQueue(slug, queue, row)
    setError(slug, null)
    tickInput(slug)
  }

  function submitExistingDraft(slug: string): { effect: "submitted" } {
    let row = deps.storage.getSession(slug)
    if (!row || row.backend !== "codex" || runtimeState(row) !== "live") throw new Error(`live Codex session ${slug} is not available`)
    if (row.runtime_control !== null && row.runtime_control !== undefined && row.runtime_control !== "codex-input") {
      throw new Error("Wait for the current runtime control to finish before submitting the draft")
    }
    if (activePermissionRequests.has(slug) || row.permission_pending !== null && row.permission_pending !== undefined) {
      throw new Error("Wait for the current permission change to finish before submitting the draft")
    }
    if (!parseCodexInputQueue(row.codex_input_queue).valid) {
      throw new Error("Durable Codex input state is invalid; clear or repair it before submitting the draft")
    }
    row = ownCodexInput(row)
    const escaped = captureOwned(row, true) ?? ""
    const pane = stripAnsi(escaped || captureOwned(row, false) || "")
    if (pane.includes("Press enter to confirm or esc to go back")) {
      throw new Error("Codex is showing a modal; resolve it in Terminal before submitting the draft")
    }
    const composer = inspectCodexComposer(escaped)
    if (composer.kind !== "typed" || !composer.text) throw new Error("No nonempty Codex terminal draft is available to submit")

    const tele = deps.tailer.get(slug)
    if (tele?.permPrompt || tele?.pendingAsk || tele?.nativeInputRequired) {
      throw new Error("Codex is showing a modal; resolve it in Terminal before submitting the draft")
    }
    const key = (composer.queueHint || tele?.turn === "idle" || tele?.turn === "in-flight") ? "Enter" : undefined
    if (!key) throw new Error("Codex input readiness could not be confirmed")

    const queue = parseInputQueue(row.codex_input_queue)
    if (queue.some((item) => item.source === "existing-draft" && item.state === "submitted")) {
      throw new Error("The existing Codex draft was already submitted and is awaiting transcript confirmation")
    }
    // Persist the recovery barrier BEFORE the key. The queued follow-up and permission request cannot
    // overtake it, and a control-plane restart waits for the same rollout confirmation.
    queue.unshift({
      text: composer.text,
      enqueuedAt: new Date(now()).toISOString(),
      state: "submitted",
      submittedAt: new Date(now()).toISOString(),
      source: "existing-draft",
      match: "normalized",
    })
    writeQueue(slug, queue, row)
    setError(slug, null)
    if (!sendKeyOwned(row, key)) throw new Error("Codex runtime identity changed before the draft could be submitted")
    return { effect: "submitted" }
  }

  // This intentionally does not clear, type, or submit anything. tmux can atomically authorize a
  // pane identity, but cannot atomically compare its rendered composer with this capture and then
  // replace it. Returning only the queued text gives the operator a safe terminal-mediated path:
  // copying it cannot lose or duplicate either message if Codex redraws between capture and paste.
  function prepareCodexDraftReplacement(slug: string): { queuedMessage: string } {
    let row = deps.storage.getSession(slug)
    if (!row || row.backend !== "codex" || runtimeState(row) !== "live") throw new Error(`live Codex session ${slug} is not available`)
    if (row.runtime_control !== null && row.runtime_control !== undefined && row.runtime_control !== "codex-input") {
      throw new Error("Wait for the current runtime control to finish before preparing terminal recovery")
    }
    if (!parseCodexInputQueue(row.codex_input_queue).valid) {
      throw new Error("Durable Codex input state is invalid; Fray will not disclose or discard queued input")
    }
    const queue = parseInputQueue(row.codex_input_queue)
    const queued = queue[0]
    if (!queued || queued.state !== "pending" || queued.source === "existing-draft") {
      throw new Error("No pending Codex follow-up is available for terminal replacement")
    }
    const escaped = captureOwned(row, true) ?? ""
    const composer = inspectCodexComposer(escaped)
    if (composer.kind !== "typed" || !composer.text) {
      throw new Error("The existing Codex terminal draft changed; refresh and inspect Terminal before replacing it")
    }
    return { queuedMessage: queued.text }
  }

  function clearAmbiguousCodexInput(slug: string): { effect: "cleared" } {
    let row = deps.storage.getSession(slug)
    if (!row || row.backend !== "codex") throw new Error(`Codex session ${slug} is not available`)
    if (row.runtime_control !== null && row.runtime_control !== undefined && row.runtime_control !== "codex-input") {
      throw new Error("Wait for the current runtime control to finish before clearing queued input")
    }
    if (!parseCodexInputQueue(row.codex_input_queue).valid) {
      throw new Error("Durable Codex input state is invalid and cannot be cleared as a submitted message")
    }
    row = ownCodexInput(row)
    const queue = parseInputQueue(row.codex_input_queue)
    const item = queue[0]
    const submittedAt = item?.submittedAt ? Date.parse(item.submittedAt) : NaN
    if (item?.state !== "submitted" || !Number.isFinite(submittedAt) || now() - submittedAt < CODEX_INPUT_CONFIRMATION_TIMEOUT_MS) {
      throw new Error("No timed-out unconfirmed Codex submission is available to clear")
    }
    // This is an acknowledgement barrier, not a retry: remove exactly the ambiguous head item and
    // never replay its key or text. It may have reached Codex, so the UI tells the human to inspect the
    // transcript before choosing whether to send anything again.
    queue.shift()
    writeQueue(slug, queue, row)
    if (queue.length === 0) releaseCodexInput(row)
    setError(slug, null)
    return { effect: "cleared" }
  }

  function failRequest(slug: string, message: string, expected?: RuntimeExpectation): never {
    let row = deps.storage.getSession(slug)
    if (!row) throw new Error(message)
    if (expected) {
      const mode = pendingMode(row.permission_mode) ?? "default"
      if (!deps.storage.setPermissionStateIfCurrent(slug, expected, {
        exited: row.exited === 1,
        permissionMode: mode,
        permissionPending: null,
        controlError: message,
      })) {
        throw new Error(message)
      }
    } else {
      deps.storage.setControlErrorIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, message)
    }
    deps.board.refresh()
    throw new Error(message)
  }

  async function request(slug: string, requested: PermissionModeValue): Promise<{ effect: "applied" | "next-resume" }> {
    const initial = deps.storage.getSession(slug)
    if (!initial) throw new Error(`no session registered for ${slug}`)
    if (initial.runtime_control !== null && initial.runtime_control !== undefined) {
      throw new Error("Another runtime control is already in progress for this thread")
    }
    const controlRevision = deps.storage.beginRuntimeControl(slug, {
      sessionId: initial.session_id,
      nativeSessionId: initial.agent_session_id ?? null,
      generation: initial.runtime_generation ?? 0,
    }, "permission")
    if (controlRevision === null) {
      throw new Error("This thread changed or another runtime control started; permissions were not changed")
    }
    try {
      return await requestOwned(slug, requested)
    } finally {
      const current = deps.storage.getSession(slug)
      if (current?.session_id === initial.session_id) {
        deps.storage.releaseRuntimeControl(slug, {
          sessionId: initial.session_id,
          generation: current.runtime_generation ?? 0,
          kind: "permission",
          revision: controlRevision,
        })
      }
    }
  }

  async function requestOwned(slug: string, requested: PermissionModeValue): Promise<{ effect: "applied" | "next-resume" }> {
    let row = deps.storage.getSession(slug)
    if (!row) throw new Error(`no session registered for ${slug}`)
    const codex = row.backend === "codex"
    if (codex && requested !== "plan" && requested !== "default" && requested !== "bypassPermissions") {
      throw new Error("Choose Read-only, Workspace-write, or Full access for a Codex thread")
    }
    if (!codex && requested === "plan") throw new Error("Plan mode is not available for dashboard workers")
    if (activePermissionRequests.has(slug)) {
      throw new Error("A permission change is already in progress for this thread")
    }
    if (row.permission_pending !== null && row.permission_pending !== undefined) {
      throw new Error("A durable permission change is already in progress for this thread")
    }

    const initialRuntime = runtimeState(row)
    if (initialRuntime === "conflict" || initialRuntime === "unavailable") {
      throw new Error("This thread's exact runtime identity is unavailable; permissions were not changed")
    }
    if (initialRuntime === "absent") {
      const saved = deps.storage.setPermissionStateIfCurrent(
        slug,
        {
          sessionId: row.session_id,
          generation: row.runtime_generation ?? 0,
          permissionPending: null,
          runtimeControl: "permission",
        },
        {
          exited: row.exited === 1,
          permissionMode: requested,
          permissionPending: null,
          controlError: null,
        },
      )
      if (!saved) throw new Error("This thread changed while permissions were being saved; retry")
      deps.board.refresh()
      return { effect: "next-resume" }
    }

    // Fold every sidecar already written by the current process before choosing the rollback mode or
    // replacing that process. Without this barrier, a delayed Claude permission-mode record from the
    // prior generation can be consumed after reattach and overwrite the exact new launch value.
    deps.tailer.tick()
    row = deps.storage.getSession(slug)
    if (!row) throw new Error(`no session registered for ${slug}`)
    if (runtimeState(row) !== "live") {
      failRequest(slug, "The worker changed while permissions were being prepared; nothing was changed")
    }
    const sessionId = row.session_id
    const initialGeneration = row.runtime_generation ?? 0
    const tele = deps.tailer.get(slug)
    const permissionRevision = tele?.permissionModeRevision ?? 0
    const savedMode = pendingMode(row.permission_mode)
    const current = savedMode
      ? effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", savedMode)
      : tele?.permissionMode
    if (!current) failRequest(slug, "Current permission mode is still loading; retry after the session metadata appears")
    if (current === requested) {
      const saved = deps.storage.setPermissionStateIfCurrent(
        slug,
        { sessionId, generation: initialGeneration, permissionPending: null, runtimeControl: "permission" },
        { exited: row.exited === 1, permissionMode: requested, permissionPending: null, controlError: null },
      )
      if (!saved) throw new Error("This thread changed while permissions were being confirmed; retry")
      deps.board.refresh()
      return { effect: "applied" }
    }
    if (!tele) failRequest(slug, "Runtime state is still loading; retry in a moment")
    if (tele.permPrompt || tele.pendingAsk || tele.nativeInputRequired) {
      failRequest(slug, "Resolve the current terminal approval or question before changing permissions")
    }
    if (tele.turn !== "idle") {
      failRequest(slug, "Permission changes require an idle thread; wait for the current turn to finish")
    }
    const unresolvedOps = [...tele.subAgents, ...tele.bgShells].filter((op) => op.state === "running" || op.state === "stale").length
    if (unresolvedOps > 0) {
      failRequest(slug, `Permission changes require no unresolved background work; wait for ${unresolvedOps} operation${unresolvedOps === 1 ? "" : "s"}`)
    }
    const durableQueue = parseCodexInputQueue(row.codex_input_queue)
    if (!durableQueue.valid) {
      failRequest(slug, "Durable Codex input state is invalid; repair it before changing permissions")
    }
    if (durableQueue.items.length > 0) {
      failRequest(slug, "Wait for the queued Codex input to finish before changing permissions")
    }

    const composer = row.backend === "codex"
      ? inspectCodexComposer(captureOwned(row, true) ?? "")
      : inspectClaudeComposer(captureOwned(row, false) ?? "")
    if (composer.kind === "typed") {
      failRequest(slug, `Permission change blocked: submit or clear the existing ${row.backend === "codex" ? "Codex" : "Claude"} terminal draft`)
    }
    if (composer.kind !== "empty") {
      failRequest(slug, `Permission change blocked by the current ${row.backend === "codex" ? "Codex" : "Claude"} terminal screen; return it to the idle prompt`)
    }
    if (!deps.reattach) failRequest(slug, "Live permission changes are unavailable in this Fray server; restart Fray and retry")

    // Standalone TUIs expose no typed live permission-control protocol. Reopen the already-saved idle
    // conversation with the backend's documented launch flag; never navigate an interactive menu or
    // inject control characters. The pending value exists only for this bounded, readiness-checked
    // process handoff.
    const armed = deps.storage.setPermissionStateIfCurrent(
      slug,
      { sessionId, generation: initialGeneration, permissionPending: null, runtimeControl: "permission" },
      { exited: false, permissionMode: current, permissionPending: requested, controlError: null },
    )
    if (!armed) throw new Error("This thread changed before the permission handoff could start; retry")
    deps.board.refresh()
    activePermissionRequests.add(slug)
    let ownedGeneration = initialGeneration
    try {
      const result = await deps.reattach(slug, current, requested, (generation) => {
        ownedGeneration = generation
      })
      const handoffRow = deps.storage.getSession(slug)
      const expectedGeneration = result?.generation ?? ownedGeneration
      if (
        !handoffRow ||
        handoffRow.session_id !== sessionId ||
        (handoffRow.runtime_generation ?? 0) !== expectedGeneration ||
        handoffRow.permission_pending !== requested
      ) {
        throw new Error("Permission change canceled because this thread or process generation was deleted or replaced during startup")
      }
      // Fold everything appended while the old pane exited and the new pane booted BEFORE installing
      // the launch fallback. A fresh backend record is authoritative: Claude can reject/coerce a mode
      // for a particular model/version, and presenting the requested flag as applied would be false.
      deps.tailer.tick()
      const observed = deps.tailer.get(slug)
      const paneMode = row.backend === "claude" ? detectClaudePermissionMode(captureOwned(handoffRow, false) ?? "") : undefined
      // The fresh pane is generation-scoped (reattach verified its PID before returning), while an
      // untimestamped Claude sidecar observed in this window may belong to the pane just killed. A
      // visible footer therefore wins. If the footer is unavailable (very narrow/partial capture), a
      // genuinely fresh backend record remains the fail-closed fallback.
      const observedAt = observed?.permissionModeAt ? Date.parse(observed.permissionModeAt) : NaN
      const handoffSpawnedAt = Date.parse(handoffRow.spawned_at)
      const codexObservationIsCurrent =
        (observed?.permissionModeRevision ?? 0) > permissionRevision &&
        Number.isFinite(observedAt) &&
        Number.isFinite(handoffSpawnedAt) &&
        observedAt >= handoffSpawnedAt
      const actualMode = row.backend === "claude"
        ? paneMode
        : codexObservationIsCurrent
          ? observed?.permissionMode
          : undefined
      if (row.backend === "claude" && !actualMode) {
        throw new Error("Backend mode could not be confirmed from the new Claude pane; the change was not reported as applied")
      }
      if (
        actualMode &&
        actualMode !== requested
      ) {
        const committed = deps.storage.setPermissionStateIfCurrent(
          slug,
          { sessionId, generation: expectedGeneration, permissionPending: requested, runtimeControl: "permission" },
          {
            exited: false,
            permissionMode: actualMode,
            permissionPending: null,
            controlError: `Backend did not apply ${requested}; it reported ${actualMode}`,
          },
        )
        if (committed) deps.board.refresh()
        throw new Error(`Backend did not apply ${requested}; it reported ${actualMode}`)
      }
      deps.tailer.notePermissionMode?.(slug, requested)
      // The reattach command carries the backend-native mode flag and returned only after the new
      // process was created. Transcript telemetry subsequently reconciles the persisted value, but
      // the UI must not pretend that observation is an indefinitely pending operation.
      if (!deps.storage.setPermissionStateIfCurrent(
        slug,
        { sessionId, generation: expectedGeneration, permissionPending: requested, runtimeControl: "permission" },
        { exited: false, permissionMode: requested, permissionPending: null, controlError: null },
      )) {
        throw new Error("Permission change canceled because this process generation no longer owns the thread")
      }
      deps.board.refresh()
      return { effect: "applied" }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failRequest(slug, message, {
        sessionId,
        generation: ownedGeneration,
        permissionPending: requested,
        runtimeControl: "permission",
      })
    } finally {
      activePermissionRequests.delete(slug)
    }
  }

  function delivered(item: QueuedInput, slug: string): boolean {
    // Pending input has not crossed the native submit boundary yet. `submittedAt` disambiguates
    // identical consecutive messages: telemetry from the earlier turn must never acknowledge the
    // later one merely because both were enqueued before that telemetry arrived.
    if (item.state !== "submitted" || !item.submittedAt) return false
    const tele = deps.tailer.get(slug)
    if (!tele?.lastUserText || !tele.lastUserAt) return false
    const textMatches = item.match === "normalized" ? normalizedInput(tele.lastUserText) === item.text : tele.lastUserText === item.text
    if (!textMatches) return false
    const observedAt = Date.parse(tele.lastUserAt)
    const submittedAt = Date.parse(item.submittedAt)
    return Number.isFinite(observedAt) && Number.isFinite(submittedAt) && observedAt >= submittedAt
  }

  // Returns true while a queued input owns or is waiting for the composer; a permission reattach must
  // stay behind it. New input is pasted and submitted by one tmux command queue after its durable
  // barrier is written, so Fray never has to rediscover its own multiline draft from screen text.
  function tickInput(slug: string): boolean {
    let row = deps.storage.getSession(slug)
    if (!row) return false
    if (row.runtime_control !== null && row.runtime_control !== undefined && row.runtime_control !== "codex-input") {
      return true
    }
    const parsed = parseCodexInputQueue(row.codex_input_queue)
    if (!parsed.valid) {
      setError(slug, "Durable Codex input state is invalid; Fray will not type or discard any part of it")
      return true
    }
    const queue = parsed.items
    if (queue.length === 0) {
      releaseCodexInput(row)
      return false
    }
    if (row.runtime_control === null || row.runtime_control === undefined) row = ownCodexInput(row)
    const item = queue[0]
    if (delivered(item, slug)) {
      queue.shift()
      writeQueue(slug, queue, row)
      if (queue.length === 0) releaseCodexInput(row)
      setError(slug, null)
      return queue.length > 0
    }
    if (item.state === "submitted" && item.submittedAt) {
      // Persist provider ownership as soon as we can positively witness an input queued by an older
      // Fray process. The TUI can later scroll this block out of capture while the message remains
      // owned by Codex; looking only at the timeout capture would turn that handoff into a false
      // failure during a rolling upgrade.
      if (!item.providerQueuedAt) {
        const escaped = captureOwned(row, true) ?? ""
        if (codexNativeQueuedInputMatches(escaped, item.text)) {
          item.providerQueuedAt = new Date(now()).toISOString()
          writeQueue(slug, queue, row)
          setError(slug, null)
          return true
        }
      }
      if (item.providerQueuedAt) return true

      const submittedAt = Date.parse(item.submittedAt)
      if (Number.isFinite(submittedAt) && now() - submittedAt >= CODEX_INPUT_CONFIRMATION_TIMEOUT_MS) {
        // Without transcript confirmation or native ownership, delivery is indeterminate. Drop
        // only Fray's barrier and surface a compact failure signal; the browser restores its draft.
        // Retrying would risk duplicating provider-visible input, so there is intentionally none.
        queue.shift()
        writeQueue(slug, queue, row)
        if (queue.length === 0) releaseCodexInput(row)
        setError(slug, `${STEER_FAILURE_PREFIX}${item.deliveryId ?? ""}`)
        return queue.length > 0
      }
    }
    const liveState = runtimeState(row)
    if (liveState !== "live") {
      setError(slug, item.state === "submitted"
        ? "Waiting for confirmation of the last Codex submission"
        : liveState === "conflict" || liveState === "unavailable"
          ? "Queued Codex message is blocked because this thread's exact runtime identity is unavailable"
          : "Queued Codex message was not submitted before the session exited; send another follow-up to resume")
      return true
    }
    if (item.state === "submitted") return true

    const escaped = captureOwned(row, true) ?? ""
    const composer = inspectCodexComposer(escaped)
    const tele = deps.tailer.get(slug)
    if (tele?.permPrompt || tele?.pendingAsk || tele?.nativeInputRequired) {
      setError(slug, "Queued message blocked by an ambiguous Codex composer or modal; resolve it in Terminal")
      return true
    }
    if (composer.kind === "empty") {
      const key = (codexQueueHint(escaped) || tele?.turn === "idle" || tele?.turn === "in-flight") ? "Enter" : undefined
      if (!key) {
        setError(slug, "Queued Codex message is waiting for an idle or steerable composer")
        return true
      }
      // Persist the barrier before one tmux command queue pastes the complete message and submits it.
      // Fray never leaves its own draft behind for a later content-based guess.
      item.state = "submitted"
      item.submittedAt = new Date(now()).toISOString()
      writeQueue(slug, queue, row)
      setError(slug, null)
      if (!sendTextWithKeyOwned(row, item.text, key)) {
        setError(slug, "Queued Codex submission could not be confirmed; Fray will not retry it automatically")
      }
      return true
    }
    if (composer.kind === "typed" && codexComposerMatches(escaped, item.text)) {
      const key = (composer.queueHint || tele?.turn === "idle" || tele?.turn === "in-flight") ? "Enter" : undefined
      if (!key) {
        setError(slug, "Queued Codex message is waiting for an idle or steerable composer")
        return true
      }
      // Persist the submission barrier before sending the key. A crash in between can leave an item
      // safely awaiting confirmation, but can never replay a key that Codex may already have handled.
      item.state = "submitted"
      item.submittedAt = new Date(now()).toISOString()
      writeQueue(slug, queue, row)
      setError(slug, null)
      if (!sendKeyOwned(row, key)) {
        setError(slug, "Queued Codex message was not submitted because the worker identity changed")
      }
      return true
    }
    if (composer.kind === "typed") {
      setError(slug, "Queued message blocked: submit or clear the existing Codex terminal draft")
      return true
    }
    setError(slug, "Queued message blocked by an ambiguous Codex composer or modal; resolve it in Terminal")
    return true
  }

  function tick(): void {
    for (const row of deps.storage.allSessions()) {
      if (row.permission_pending !== null && row.permission_pending !== undefined) {
        const requested = pendingMode(row.permission_pending)
        if (!requested) {
          const message = "Invalid durable permission state; restart or repair this thread before continuing"
          if ((row.control_error ?? null) !== message) {
            deps.storage.setControlErrorIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, message)
            deps.board.refresh()
          }
          continue
        }
        if (activePermissionRequests.has(row.slug)) continue
        const observed = deps.tailer.get(row.slug)
        const live = runtimeState(row) === "live"
        const observedIsCurrent = live && (
          row.backend === "codex"
            ? observed?.permissionMode === requested &&
              !!observed.permissionModeAt &&
              Number.isFinite(Date.parse(observed.permissionModeAt)) &&
              Number.isFinite(Date.parse(row.spawned_at)) &&
              Date.parse(observed.permissionModeAt) >= Date.parse(row.spawned_at)
            : detectClaudePermissionMode(captureOwned(row, false) ?? "") === requested
        )
        const next = observedIsCurrent
          ? { permissionMode: requested, controlError: null }
          : {
              permissionMode: pendingMode(row.permission_mode) ?? requested,
              controlError: "The prior permission change was not observed; retry from the idle thread",
            }
        if (deps.storage.setPermissionStateIfCurrent(
          row.slug,
          {
            sessionId: row.session_id,
            generation: row.runtime_generation ?? 0,
            permissionPending: requested,
            runtimeControl: row.runtime_control ?? null,
          },
          {
            exited: row.exited === 1,
            permissionMode: next.permissionMode,
            permissionPending: null,
            controlError: next.controlError,
          },
        )) {
          deps.board.refresh()
        }
        continue
      }

      tickInput(row.slug)
    }
  }

  return {
    request,
    queueFollowUp,
    submitExistingDraft,
    prepareCodexDraftReplacement,
    clearAmbiguousCodexInput,
    tick,
    start() {
      if (timer) return
      tick()
      timer = setInterval(tick, POLL_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
