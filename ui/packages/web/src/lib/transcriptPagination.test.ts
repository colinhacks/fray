import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptMessage, TranscriptPage } from "@fray-ui/shared"
import {
  captureTranscriptViewportAnchor,
  prependEarlierPage,
  previousUserBoundary,
  reconcileLatestPage,
  restoreTranscriptViewportAnchor,
  transcriptAnchorScrollDelta,
} from "./transcriptPagination.ts"

const message = (role: "user" | "assistant", sourceId: string): TranscriptMessage => ({
  sourceId,
  role,
  text: sourceId,
  tools: [],
  parts: [],
})

const page = (ids: Array<["user" | "assistant", string]>, overrides: Partial<TranscriptPage> = {}): TranscriptPage => ({
  messages: ids.map(([role, id]) => message(role, id)),
  beforeCursor: null,
  hasEarlier: false,
  reachedTurnBoundary: true,
  transcriptKey: "transcript-A",
  ...overrides,
})

test("client boundary selection handles first-visible assistant, user, consecutive users, and no prior user", () => {
  const messages = [message("user", "u0"), message("assistant", "a0"), message("user", "u1"), message("user", "u2"), message("assistant", "a2")]
  assert.equal(previousUserBoundary(messages, 4), 3, "assistant-visible start steps to preceding user")
  assert.equal(previousUserBoundary(messages, 3), 2, "user-visible start steps to user immediately before it")
  assert.equal(previousUserBoundary(messages, 2), 0)
  assert.equal(previousUserBoundary([message("assistant", "event")], 1), 0, "no user reveals the remaining prefix")
  assert.equal(previousUserBoundary(messages, 0), null)
})

test("client prepend is gap-free/idempotent across a repeated response", () => {
  const current = { ...page([["user", "u2"], ["assistant", "a2"]], { beforeCursor: "cursor-2", hasEarlier: true }) }
  const earlier = page([["user", "u1"], ["assistant", "a1"]], { beforeCursor: "cursor-1", hasEarlier: true })
  const once = prependEarlierPage(current, earlier)
  const twice = prependEarlierPage(once, earlier)
  assert.deepEqual(twice.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2"])
  assert.equal(twice.beforeCursor, "cursor-1")
})

test("client latest reconciliation retains loaded history across concurrent append and refreshes overlap", () => {
  const loaded = prependEarlierPage(
    page([["user", "u2"], ["assistant", "a2-old"]], { beforeCursor: "cursor-2", hasEarlier: true }),
    page([["user", "u1"], ["assistant", "a1"]], { beforeCursor: "cursor-1", hasEarlier: true }),
  )
  const incoming = page([["user", "u2"], ["assistant", "a2-old"], ["user", "u3"], ["assistant", "a3"]], { beforeCursor: "new-window", hasEarlier: true })
  const reconciled = reconcileLatestPage(loaded, incoming)
  assert.deepEqual(reconciled.messages.map((m) => m.sourceId), ["u1", "a1", "u2", "a2-old", "u3", "a3"])
  assert.equal(reconciled.beforeCursor, "cursor-1")
})

test("client transcript replacement discards loaded history instead of mixing sessions", () => {
  const loaded = { ...page([["user", "old-u"], ["assistant", "old-a"]]), historyLoaded: true }
  const replacement = page([["user", "new-u"], ["assistant", "new-a"]], { transcriptKey: "transcript-B" })
  assert.deepEqual(reconcileLatestPage(loaded, replacement).messages.map((m) => m.sourceId), ["new-u", "new-a"])
})

test("scroll-anchor restoration applies the exact post-prepend top delta", () => {
  let top = 240
  const node = {
    dataset: { transcriptSourceId: "u2" },
    getBoundingClientRect: () => ({ top, bottom: top + 40 }),
  }
  const root = { querySelectorAll: () => [node] }
  const anchor = captureTranscriptViewportAnchor(root as unknown as HTMLElement)
  assert.deepEqual(anchor, { sourceId: "u2", top: 240 })
  top = 910
  let correction = 0
  assert.equal(restoreTranscriptViewportAnchor(root as unknown as HTMLElement, anchor, (delta) => { correction = delta }), true)
  assert.equal(correction, 670)
  assert.equal(transcriptAnchorScrollDelta(240, 910), 670)
})

test("scroll-anchor skips the pinned (sticky) user message and anchors on a natural-flow node", () => {
  // The pinned band comes first in DOM order and — being sticky — sits at the pane top with an
  // invariant rect, which would otherwise win as the anchor and zero out every load-earlier delta.
  const sticky = {
    dataset: { transcriptSourceId: "u-pinned", transcriptSticky: "true" },
    getBoundingClientRect: () => ({ top: 12, bottom: 60 }),
  }
  const flow = {
    dataset: { transcriptSourceId: "a1" },
    getBoundingClientRect: () => ({ top: 300, bottom: 360 }),
  }
  const root = { querySelectorAll: () => [sticky, flow] }
  const anchor = captureTranscriptViewportAnchor(root as unknown as HTMLElement)
  assert.deepEqual(anchor, { sourceId: "a1", top: 300 })
})
