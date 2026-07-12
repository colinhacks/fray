import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkerPrompt, composePrompt, scratchpadOrientation, scratchpadContent } from "./dispatch.ts"

// ---- Backend-aware worker contract (worker-contract-backend-aware) ----
// loadWorkerPrompt(kind) fills the four `{{FRAY_*}}` markers in ui/WORKER_PROMPT.md (the shared
// agnostic CORE) from WORKER_PROMPT.<kind>.md. The CLAUDE fill must reproduce the pre-split contract
// BYTE-FOR-BYTE (the regression bar); the CODEX fill swaps the Claude-Code-only guidance for codex's.

const here = dirname(fileURLToPath(import.meta.url))
// The FROZEN pre-split claude contract body (the exact string a claude dispatch got before the split).
// Regenerate ONLY when the shipped claude contract is deliberately changed — an unexpected diff here is
// a regression (a core/claude-fragment edit that altered what a claude worker receives).
const CLAUDE_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.claude.golden.txt"), "utf8")

test("loadWorkerPrompt: default kind is claude", () => {
  assert.equal(loadWorkerPrompt(), loadWorkerPrompt("claude"))
})

test("loadWorkerPrompt(claude) is BYTE-IDENTICAL to the pre-split contract (the regression bar)", () => {
  assert.equal(loadWorkerPrompt("claude"), CLAUDE_GOLDEN)
})

test("loadWorkerPrompt: no unresolved {{FRAY_*}} markers survive in either backend's contract", () => {
  assert.doesNotMatch(loadWorkerPrompt("claude"), /\{\{FRAY_/)
  assert.doesNotMatch(loadWorkerPrompt("codex"), /\{\{FRAY_/)
})

test("loadWorkerPrompt(claude) carries the Claude-Code-only guidance", () => {
  const c = loadWorkerPrompt("claude")
  assert.match(c, /a top-level `claude` session/)
  assert.match(c, /it re-runs `claude -r`/)
  assert.match(c, /## Sub-agents/)
  assert.match(c, /Always plain Agent tool \+ `run_in_background: true`/)
  assert.match(c, /namespaced string `fray:<model>-<effort>`/)
  assert.match(c, /the shared blackboard for your sub-agents/)
})

test("loadWorkerPrompt(codex) OMITS every Claude-Code-only construct a codex worker can't use", () => {
  const c = loadWorkerPrompt("codex")
  // No Claude session/wake, no Agent tool, no fray profiles, no sub-agent blackboard framing.
  assert.doesNotMatch(c, /claude session/)
  assert.doesNotMatch(c, /claude -r/)
  assert.doesNotMatch(c, /## Sub-agents/)
  assert.doesNotMatch(c, /Agent tool/)
  assert.doesNotMatch(c, /run_in_background/)
  assert.doesNotMatch(c, /fray:<model>-<effort>/)
  assert.doesNotMatch(c, /fray:opus/)
  assert.doesNotMatch(c, /blackboard/)
})

test("loadWorkerPrompt(codex) carries codex's OWN session/wake + model/effort/sandbox framing", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /a top-level `codex` session/)
  assert.match(c, /it re-runs `codex resume`/)
  assert.match(c, /## Working solo/)
  // The effort enum must match what fray actually sends codex: codexEffort (backend/codex.ts) passes
  // low/medium/high/xhigh through and clamps `max`→`xhigh`, so `xhigh` is a real spawn tier.
  assert.match(c, /reasoning effort \(low \/ medium \/ high \/ xhigh\)/)
  assert.match(c, /read-only/)
  assert.match(c, /workspace-write/)
  assert.match(c, /danger-full-access/)
})

test("loadWorkerPrompt: the backend-AGNOSTIC core is present in BOTH contracts", () => {
  for (const kind of ["claude", "codex"] as const) {
    const c = loadWorkerPrompt(kind)
    assert.match(c, /```done/) // fence grammar
    assert.match(c, /```awaiting/)
    assert.match(c, /```question/)
    assert.match(c, /## Thread types/)
    assert.match(c, /## Git discipline/)
    assert.match(c, /## Quality bar/)
    assert.match(c, /## The stop criterion/)
    assert.match(c, /pr: owner\/repo#NUMBER/) // the awaiting hint grammar
  }
})

// ---- composePrompt: the first VISIBLE user message's scratchpad line is backend-aware ----

test("composePrompt(claude) keeps the sub-agent blackboard framing; codex drops it", () => {
  const claude = composePrompt("sid", "do the thing", "", "claude")
  assert.match(claude, /shared blackboard for your sub-agents/)
  assert.match(claude, /pass its path to every sub-agent you dispatch/)
  assert.equal(composePrompt("sid", "do the thing", ""), claude) // default = claude (unchanged)

  const codex = composePrompt("sid", "do the thing", "", "codex")
  assert.doesNotMatch(codex, /sub-agent/)
  assert.doesNotMatch(codex, /blackboard/)
  assert.match(codex, /compaction-proof working memory/)
  assert.match(codex, /TASK:\ndo the thing/) // the task still rides through
})

// ---- scratchpadOrientation: the SYSTEM-level line is backend-aware ----

test("scratchpadOrientation(codex) drops the blackboard framing; claude keeps it (default unchanged)", () => {
  const claude = scratchpadOrientation("sid", null, "claude")
  assert.match(claude, /shared blackboard for your sub-agents/)
  assert.equal(scratchpadOrientation("sid", null), claude)

  const codex = scratchpadOrientation("sid", null, "codex")
  assert.doesNotMatch(codex, /sub-agent/)
  assert.doesNotMatch(codex, /blackboard/)
  assert.match(codex, /compaction-proof working memory/)

  // The plan line is agnostic and appended for both.
  assert.match(scratchpadOrientation("sid", ".fray/plans/x.md", "codex"), /PLAN: \.fray\/plans\/x\.md/)
})

// ---- scratchpadContent: the pad skeleton is backend-aware ----

test("scratchpadContent(codex) is compaction-only (no fleet-blackboard / Shared context section)", () => {
  const claude = scratchpadContent("t", "claude")
  assert.match(claude, /fleet blackboard/)
  assert.match(claude, /## Shared context/)
  assert.equal(scratchpadContent("t"), claude) // default = claude (unchanged)

  const codex = scratchpadContent("t", "codex")
  assert.doesNotMatch(codex, /blackboard/)
  assert.doesNotMatch(codex, /Shared context/)
  assert.doesNotMatch(codex, /sub-agent/)
  assert.match(codex, /## Task list/)
})
