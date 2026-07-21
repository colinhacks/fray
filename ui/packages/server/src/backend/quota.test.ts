import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCodexQuotaFromRollout } from "./codex-quota.ts"
import { parseClaudeUsage, tokenFromCredentialsJson, readClaudeQuota } from "./claude-quota.ts"

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

// ---- Quota memo: outcome-based TTL (the "recheck actually re-hits" fix) ----
// readClaudeQuota memoizes per configDir; a FLAT 3-min cache used to strand a transient failure for
// minutes, so a chip stuck on "Usage endpoint unreachable" ignored every recheck. These drive the real
// function through injected clock/fetch/token seams (no network, no credential store) and assert the
// cache clears — or holds — for the RIGHT duration per outcome. Each test uses a unique configDir so the
// module-global memo never bleeds across tests.

const okBody = { five_hour: { utilization: 20, reset_at: "2030-01-01T00:00:00Z" } }
// A fetch stub that counts calls and yields a scripted status/body each time. The call counter is a
// LIVE getter (Object.defineProperty, not Object.assign — the latter would copy the getter's value once
// and freeze it at 0).
function countingFetch(steps: Array<{ status: number; body?: unknown } | "throw">) {
  let calls = 0
  const impl = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!
    calls++
    if (step === "throw") throw new Error("network down")
    return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => step.body ?? {} }
  }) as unknown as typeof fetch
  Object.defineProperty(impl, "calls", { get: () => calls })
  return impl as typeof fetch & { readonly calls: number }
}
const withToken = async () => "tok-test"
let dirN = 0
const freshDir = () => `/nonexistent-fray-quota-test-${++dirN}`

test("quota memo: a transient failure clears within FAIL_TTL so the next read re-hits (not stranded 3 min)", async () => {
  const dir = freshDir()
  const fetchImpl = countingFetch(["throw", { status: 200, body: okBody }])
  const first = await readClaudeQuota(dir, { now: () => 0, fetchImpl, readToken: withToken })
  assert.equal(first.status, "unavailable")
  assert.equal(first.detail, "Usage endpoint unreachable")
  assert.equal(fetchImpl.calls, 1)
  // Within the 10s failure window → served from cache, endpoint NOT re-hit.
  const cached = await readClaudeQuota(dir, { now: () => 5_000, fetchImpl, readToken: withToken })
  assert.equal(cached.status, "unavailable")
  assert.equal(fetchImpl.calls, 1)
  // Past the failure window → live re-hit, and it recovers to a healthy read.
  const recovered = await readClaudeQuota(dir, { now: () => 11_000, fetchImpl, readToken: withToken })
  assert.equal(recovered.status, "ok")
  assert.equal(fetchImpl.calls, 2)
})

test("quota memo: a healthy read is cached generously (1 min) but DOES expire (~3 min), not forever", async () => {
  const dir = freshDir()
  const fetchImpl = countingFetch([{ status: 200, body: okBody }])
  const first = await readClaudeQuota(dir, { now: () => 0, fetchImpl, readToken: withToken })
  assert.equal(first.status, "ok")
  const oneMinLater = await readClaudeQuota(dir, { now: () => 60_000, fetchImpl, readToken: withToken })
  assert.equal(oneMinLater.status, "ok")
  assert.equal(fetchImpl.calls, 1) // still cached at 1 min (< 3 min OK TTL)
  // Past the 3-min OK TTL → live re-hit. Asserting the EXPIRY (not just that it holds) guards against
  // an OK_TTL accidentally set too high / infinite, which the "still cached" check alone would pass.
  const past = await readClaudeQuota(dir, { now: () => 181_000, fetchImpl, readToken: withToken })
  assert.equal(past.status, "ok")
  assert.equal(fetchImpl.calls, 2)
})

test("quota memo: a 429 backs off ~1 min — longer than a plain failure, shorter than the old 3 min", async () => {
  const dir = freshDir()
  const fetchImpl = countingFetch([{ status: 429 }, { status: 200, body: okBody }])
  const limited = await readClaudeQuota(dir, { now: () => 0, fetchImpl, readToken: withToken })
  assert.equal(limited.detail, "Usage endpoint 429")
  // At 30s the 429 is still cached — a recheck must NOT hammer the endpoint back into the wall.
  await readClaudeQuota(dir, { now: () => 30_000, fetchImpl, readToken: withToken })
  assert.equal(fetchImpl.calls, 1)
  // Past ~1 min it re-hits (and would have stayed stranded under the old flat 3-min cache).
  const recovered = await readClaudeQuota(dir, { now: () => 61_000, fetchImpl, readToken: withToken })
  assert.equal(recovered.status, "ok")
  assert.equal(fetchImpl.calls, 2)
})

test("quota memo: not-logged-in clears fast so a fresh sign-in recovers within a poll", async () => {
  const dir = freshDir()
  const fetchImpl = countingFetch([{ status: 200, body: okBody }])
  let token: string | undefined = undefined
  const readToken = async () => token
  const out = await readClaudeQuota(dir, { now: () => 0, fetchImpl, readToken })
  assert.equal(out.detail, "Not logged in to Claude")
  assert.equal(fetchImpl.calls, 0) // no token → endpoint never called
  token = "tok-now-present"
  const after = await readClaudeQuota(dir, { now: () => 11_000, fetchImpl, readToken })
  assert.equal(after.status, "ok")
})
