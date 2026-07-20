import type { QuotaSnapshot, ProviderQuota } from "@fray-ui/shared"
import { readCodexQuota } from "./backend/codex-quota.ts"
import { readClaudeQuota } from "./backend/claude-quota.ts"

// The polled provider-quota snapshot the sidebar status bar renders. Codex is CLEAN — it comes from
// the rollout JSONL fray already tails (no credentials, no network). Claude requires the undocumented
// OAuth usage endpoint (see claude-quota.ts), so it is credential-gated and best-effort.
//
// FIXTURE SEAM: set FRAY_QUOTA_FIXTURE to one of the named states below to return deterministic data
// instead of touching the live sources. This lets the UI be exercised (and screenshotted) across all
// visual states without live-calling the undocumented Claude endpoint or reading real credentials.

function fixture(name: string): QuotaSnapshot | undefined {
  const hour = 3600
  const now = Math.floor(Date.now() / 1000)
  const claudeOk: ProviderQuota = {
    status: "ok",
    planType: "max",
    windows: [
      { key: "5h", label: "5h", usedPercent: 34, resetsAt: now + 2 * hour + 900 },
      { key: "weekly", label: "Weekly", usedPercent: 61, resetsAt: now + 3 * 24 * hour },
    ],
  }
  const codexOk: ProviderQuota = {
    status: "ok",
    planType: "pro",
    windows: [
      { key: "5h", label: "5h", usedPercent: 12, resetsAt: now + 4 * hour },
      { key: "weekly", label: "Weekly", usedPercent: 47, resetsAt: now + 5 * 24 * hour },
    ],
  }
  switch (name) {
    case "ok":
      return { claude: claudeOk, codex: codexOk }
    case "near-limit":
      return {
        claude: { ...claudeOk, windows: [
          { key: "5h", label: "5h", usedPercent: 92, resetsAt: now + 40 * 60 },
          { key: "weekly", label: "Weekly", usedPercent: 78, resetsAt: now + 2 * 24 * hour },
        ] },
        codex: { ...codexOk, windows: [
          { key: "5h", label: "5h", usedPercent: 99, resetsAt: now + 12 * 60 },
          { key: "weekly", label: "Weekly", usedPercent: 88, resetsAt: now + 6 * 24 * hour },
        ] },
      }
    case "claude-unavailable":
      return { claude: { status: "unavailable", windows: [], detail: "Not logged in to Claude" }, codex: codexOk }
    case "codex-real":
      // REAL Codex quota from the local rollout tail, with Claude stubbed unavailable so QA never
      // live-calls the undocumented Claude endpoint. Proves the clean Codex path end-to-end in the UI.
      return { claude: { status: "unavailable", windows: [], detail: "Live call disabled for QA" }, codex: readCodexQuota() }
    default:
      return undefined
  }
}

export async function readQuota(): Promise<QuotaSnapshot> {
  // The fixture seam is a DEV/QA affordance only — never honor it in a production build, so an env var
  // leaking into a real deploy can't silently paint fabricated quota numbers.
  const fx = process.env.FRAY_QUOTA_FIXTURE
  if (fx && process.env.NODE_ENV !== "production") {
    const snap = fixture(fx)
    if (snap) {
      console.warn(`[fray-ui] quota: serving FIXTURE "${fx}" (FRAY_QUOTA_FIXTURE set; dev-only seam)`)
      return snap
    }
  }
  const [claude, codex] = await Promise.all([
    readClaudeQuota(),
    Promise.resolve(readCodexQuota()),
  ])
  return { claude, codex }
}
