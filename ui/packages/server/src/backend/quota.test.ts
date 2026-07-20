import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCodexQuotaFromRollout } from "./codex-quota.ts"
import { parseClaudeUsage, tokenFromCredentialsJson } from "./claude-quota.ts"

// ---- Codex rollout parsing ----

test("codex: live event_msg-wrapped rate_limits (payload.rate_limits)", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-15T10:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1783730191 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1784316991 },
      },
    },
  })
  const q = parseCodexQuotaFromRollout(line + "\n")
  assert.equal(q?.status, "ok")
  assert.equal(q?.planType, "pro")
  assert.deepEqual(q?.windows.map((w) => [w.key, w.usedPercent]), [["5h", 12.5], ["weekly", 40]])
})

test("codex: flattened top-level rate_limits (exec/fixture shape)", () => {
  const line = JSON.stringify({
    type: "token_count",
    info: {},
    rate_limits: {
      plan_type: "pro",
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 2 },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 2)
})

test("codex: window labeled by window_minutes, not primary/secondary name (real single-window case)", () => {
  // Real observed: `primary` carries the WEEKLY window (10080), `secondary` is null.
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { plan_type: "pro", primary: { used_percent: 88, window_minutes: 10080, resets_at: 9 }, secondary: null },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 1)
  assert.equal(q?.windows[0]!.key, "weekly")
  assert.equal(q?.windows[0]!.usedPercent, 88)
})

test("codex: last token_count wins; junk lines skipped", () => {
  const stale = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } })
  const fresh = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 55, window_minutes: 300 } } } })
  const raw = [stale, "not json {", JSON.stringify({ type: "response_item" }), fresh].join("\n")
  const q = parseCodexQuotaFromRollout(raw)
  assert.equal(q?.windows[0]!.usedPercent, 55)
})

test("codex: no rate_limits anywhere → undefined", () => {
  assert.equal(parseCodexQuotaFromRollout(JSON.stringify({ type: "response_item" })), undefined)
  assert.equal(parseCodexQuotaFromRollout(""), undefined)
})

// ---- Claude usage endpoint parsing ----

test("claude: five_hour + seven_day utilization → windows", () => {
  const q = parseClaudeUsage(
    { five_hour: { utilization: 34, reset_at: "2026-07-15T18:00:00Z" }, seven_day: { utilization: 61, reset_at: "2026-07-18T00:00:00Z" } },
    "max",
  )
  assert.equal(q.status, "ok")
  assert.equal(q.planType, "max")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 34], ["weekly", 61]])
  assert.equal(typeof q.windows[0]!.resetsAt, "number")
})

test("claude: surfaces model-specific weekly caps (opus/sonnet) when present", () => {
  const q = parseClaudeUsage({
    five_hour: { utilization: 10, reset_at: "2026-07-15T18:00:00Z" },
    seven_day: { utilization: 40, reset_at: "2026-07-18T00:00:00Z" },
    seven_day_opus: { utilization: 91, reset_at: "2026-07-18T00:00:00Z" },
  })
  assert.deepEqual(q.windows.map((w) => w.key), ["5h", "weekly", "weekly-opus"])
  // The binding limit (opus 91% used) is the highest usedPercent → the chip's "tightest" pick.
  assert.equal(Math.max(...q.windows.map((w) => w.usedPercent)), 91)
})

test("claude: malformed / empty body → unavailable, never throws", () => {
  assert.equal(parseClaudeUsage(null).status, "unavailable")
  assert.equal(parseClaudeUsage({}).status, "unavailable")
  assert.equal(parseClaudeUsage({ five_hour: { reset_at: "x" } }).status, "unavailable")
})

// ---- Credential blob parsing (same shape whether it comes from ~/.claude/.credentials.json OR the
// macOS Keychain "Claude Code-credentials" generic password — `security -w` prints this exact blob). ----

test("claude creds: nested claudeAiOauth.accessToken (current shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } })), "tok-abc")
})

test("claude creds: flat access_token (drifted/older shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ access_token: "tok-flat" })), "tok-flat")
})

test("claude creds: garbage / empty / no token → undefined, never throws", () => {
  assert.equal(tokenFromCredentialsJson("not json {"), undefined)
  assert.equal(tokenFromCredentialsJson("null"), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "" } })), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ other: 1 })), undefined)
})
