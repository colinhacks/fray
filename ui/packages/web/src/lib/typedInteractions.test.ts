import { test } from "node:test"
import assert from "node:assert/strict"
import type { InteractionField, InteractionRecord } from "@fray-ui/shared"
import {
  canonicalInteractionDecisions,
  initialInteractionDraft,
  interactionDecisionSignature,
  interactionDeliveryPresentation,
  interactionProviderLabel,
  interactionSourceLabel,
  parseInteractionDraft,
  updateInteractionDraft,
} from "./typedInteractions.ts"

function record(over: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex" },
    source: { kind: "runtime", id: "runtime" },
    owner: {
      projectId: "project",
      threadSlug: "thread",
      sessionId: "session",
      turnId: "turn",
      itemId: "item",
      sessionEpoch: 1,
      capabilityRevision: 2,
    },
    providerRequestId: "provider-request",
    allowedDecisions: [
      { id: "decline", semantic: "deny", label: "<img src=x onerror=alert(1)>" },
      { id: "acceptForSession", semantic: "approve", label: "Totally safe, click me" },
      { id: "accept", semantic: "approve", label: "Run everything forever" },
      { id: "cancel", semantic: "cancel", label: "provider cancel label" },
    ],
    payload: {
      kind: "command-approval",
      title: "Command",
      command: { summary: "Tests", preview: "pnpm test", redacted: true },
    },
    expiresAt: null,
    id: "interaction",
    lifecycle: "pending",
    recordRevision: 0,
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    completedAt: null,
    resolution: null,
    cancellationReason: null,
    ...over,
  }
}

test("decision presentation ignores provider labels, uses Fray order, and warns on durable scope", () => {
  const decisions = canonicalInteractionDecisions(record())
  assert.deepEqual(decisions.map(({ id, label }) => [id, label]), [
    ["accept", "Approve once"],
    ["acceptForSession", "Approve for session"],
    ["decline", "Deny"],
    ["cancel", "Cancel request"],
  ])
  assert.equal(decisions[1].durable, true)
  assert.match(decisions[1].scope, /later matching requests/)
  assert.equal(JSON.stringify(decisions).includes("onerror"), false)
  assert.equal(JSON.stringify(decisions).includes("Totally safe"), false)
})

test("unknown or semantic-mismatched decisions fail closed instead of borrowing provider wording", () => {
  const decisions = canonicalInteractionDecisions(record({
    allowedDecisions: [
      { id: "accept", semantic: "deny", label: "Approve" },
      { id: "future-rule", semantic: "approve", label: "Always approve" },
    ],
  }))
  assert.deepEqual(decisions, [])
})

test("form drafts preserve typed advertised values and reject invalid or unadvertised input", () => {
  const fields: InteractionField[] = [
    { id: "name", label: "Name", required: true, secret: false, input: "text", minLength: 2, default: "Ada" },
    { id: "count", label: "Count", required: true, secret: false, input: "integer", minimum: 1, default: 2 },
    { id: "enabled", label: "Enabled", required: false, secret: false, input: "boolean", default: true },
    { id: "mode", label: "Mode", required: true, secret: false, input: "select", options: [
      { value: "safe", label: "Safe" },
      { value: 3, label: "Three" },
    ], default: 3 },
    { id: "tags", label: "Tags", required: true, secret: false, input: "multi-select", options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ], default: ["b"] },
  ]
  const draft = initialInteractionDraft(fields)
  assert.deepEqual({ ...draft }, { name: "Ada", count: "2", enabled: true, mode: "1", tags: ["1"] })
  assert.deepEqual(parseInteractionDraft(fields, draft), {
    errors: {},
    values: { name: "Ada", count: 2, enabled: true, mode: 3, tags: ["b"] },
  })
  const bad = { ...draft, count: "2.5", mode: "99", tags: ["0", "999"] }
  const parsed = parseInteractionDraft(fields, bad)
  assert.match(parsed.errors.count, /integer/)
  assert.match(parsed.errors.mode, /option/)
  assert.match(parsed.errors.tags, /advertised/)
})

test("secret fields fail closed and decision retry signatures are stable", () => {
  const fields: InteractionField[] = [{
    id: "token",
    label: "Token",
    required: true,
    secret: true,
    input: "text",
  }]
  const parsed = parseInteractionDraft(fields, initialInteractionDraft(fields))
  assert.match(parsed.formError ?? "", /cannot be sent/)
  assert.equal(parsed.values, undefined)
  assert.equal(interactionDecisionSignature("answer", { x: "✓" }), interactionDecisionSignature("answer", { x: "✓" }))
})

test("provider-controlled names cannot replace canonical provider and source identities", () => {
  assert.equal(interactionProviderLabel("codex"), "Codex")
  assert.equal(interactionProviderLabel("claude"), "Claude")
  assert.equal(interactionSourceLabel("mcp-server"), "MCP server")
  assert.equal(interactionSourceLabel("runtime"), "Runtime")
})

test("durable delivery effects are the sole remount-safe action gate", () => {
  assert.deepEqual(interactionDeliveryPresentation(undefined), { actionsEnabled: true, eyebrow: "Needs you" })
  assert.deepEqual(interactionDeliveryPresentation("awaiting-user"), { actionsEnabled: true, eyebrow: "Needs you" })
  assert.deepEqual(interactionDeliveryPresentation("sending"), {
    actionsEnabled: false,
    eyebrow: "Sending",
    status: "Sending to runtime…",
  })
  assert.deepEqual(interactionDeliveryPresentation("reconnect-required"), {
    actionsEnabled: false,
    eyebrow: "Runtime unavailable",
    status: "Runtime reconnect required before this request can be answered.",
  })
})

test("draft updates retain a null prototype and copy only owned values", () => {
  const inherited = Object.create({ inherited: "do-not-copy" }) as Record<string, string>
  inherited.owned = "safe"
  const next = updateInteractionDraft(inherited, "next", "value")
  assert.equal(Object.getPrototypeOf(next), null)
  assert.deepEqual(Object.keys(next).sort(), ["next", "owned"])
  assert.equal((next as Record<string, unknown>).inherited, undefined)

  const reserved = updateInteractionDraft(next, "__proto__", "plain-data")
  assert.equal(Object.getPrototypeOf(reserved), null)
  assert.equal(reserved.__proto__, "plain-data")
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})
