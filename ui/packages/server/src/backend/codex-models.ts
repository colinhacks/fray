import { join } from "node:path"
import { readFileSync } from "node:fs"
import type { CodexModel } from "@fray-ui/shared"
import { defaultCodexHome } from "./codex.ts"

// Read the codex model catalogue + PER-MODEL reasoning-effort options from the AUTHORITATIVE local
// cache ~/.codex/models_cache.json — never a hand-maintained list. Two live breakages proved curation
// untenable: (1) a bare `gpt-5.6` id → codex 400s ("model not supported when using Codex with a ChatGPT
// account") → a silently dead thread (the real ids are gpt-5.6-sol/terra/luna); (2) the effort set is
// PER-MODEL (sol/terra → low..ultra, luna → …max, 5.5 → …xhigh), so ANY single hardcoded effort list is
// wrong for some model. codex refreshes this file itself, so reading it fresh tracks codex's own catalogue.
//
// Schema (codex-cli 0.144.1): { fetched_at, etag, client_version, models: Model[] }. Each Model:
//   slug (the `-m` id) · display_name · visibility ("list"|"hide" — offer only "list") · priority (int,
//   sort ASC; 1 = default) · default_reasoning_level (e.g. "medium") · supported_reasoning_levels:
//   [{effort, description}]. supported_in_api is IGNORED for selection: fray spawns the interactive TUI
//   (not the Responses API), so an api=false-but-listed model like gpt-5.3-codex-spark is still selectable.

function cachePath(codexHome: string): string {
  return join(codexHome, "models_cache.json")
}

// The DEGRADED fallback when the cache is absent / unreadable / malformed. Minimal ON PURPOSE — it is
// only the "codex hasn't written its cache yet" path, not a second catalogue to maintain. gpt-5.5's
// four levels are codex's safe common floor (every listed model supports low/medium/high/xhigh).
export const CODEX_MODELS_FALLBACK: CodexModel[] = [
  { slug: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
]

// Map one raw cache entry → CodexModel, or undefined to SKIP it (hidden, or missing the fields a
// selectable model needs). Defensive against every field being the wrong type — a malformed entry is
// dropped, never allowed to throw.
function toCodexModel(raw: unknown): { model: CodexModel; priority: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const m = raw as Record<string, unknown>
  if (m.visibility !== "list") return undefined // "hide" (e.g. codex-auto-review) is never offered
  const slug = typeof m.slug === "string" ? m.slug : ""
  if (!slug) return undefined
  const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
  const efforts = levels
    .map((l) => (l && typeof l === "object" ? (l as Record<string, unknown>).effort : undefined))
    .filter((e): e is string => typeof e === "string" && e.length > 0)
  if (efforts.length === 0) return undefined // a model with no reasoning levels can't be dispatched coherently
  const displayName = typeof m.display_name === "string" && m.display_name ? m.display_name : slug
  const def = typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : ""
  // The default effort MUST be one the model actually supports (so the dropdown can select it); fall
  // back to the first supported level when the cache's default is absent/unsupported.
  const defaultEffort = def && efforts.includes(def) ? def : efforts[0]!
  const priority = typeof m.priority === "number" && Number.isFinite(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER
  return { model: { slug, displayName, defaultEffort, efforts }, priority }
}

// Parse the raw cache JSON → the listed models ordered by priority ascending (1 = codex's default).
// PURE + total: any shape surprise (not JSON, no models array, all entries dropped) → the fallback, so
// a caller never sees an empty list and never catches a throw. Exported for a direct fixture unit test.
export function parseCodexModelsCache(raw: string): CodexModel[] {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return CODEX_MODELS_FALLBACK
  }
  const models = doc && typeof doc === "object" ? (doc as Record<string, unknown>).models : undefined
  if (!Array.isArray(models)) return CODEX_MODELS_FALLBACK
  const parsed = models
    .map(toCodexModel)
    .filter((x): x is { model: CodexModel; priority: number } => x !== undefined)
    .sort((a, b) => a.priority - b.priority)
    .map((x) => x.model)
  return parsed.length ? parsed : CODEX_MODELS_FALLBACK
}

// Short read-through memo so repeated RPC calls don't re-open the file every time, while still tracking
// codex's own periodic refreshes. Keyed on the resolved cache path so distinct CODEX_HOMEs (tests) never
// collide. TTL is short — the file is small and changes rarely, so a few seconds of staleness is fine.
const TTL_MS = 5_000
const memo = new Map<string, { at: number; models: CodexModel[] }>()

// The selectable Codex models for the picker (RPC-facing). Reads the cache fresh (past TTL), degrades to
// CODEX_MODELS_FALLBACK on any error, and NEVER throws.
export function readCodexModels(codexHome = defaultCodexHome()): CodexModel[] {
  const path = cachePath(codexHome)
  const hit = memo.get(path)
  const now = Date.now()
  if (hit && now - hit.at < TTL_MS) return hit.models
  let models: CodexModel[]
  try {
    models = parseCodexModelsCache(readFileSync(path, "utf8"))
  } catch {
    models = CODEX_MODELS_FALLBACK // absent / unreadable cache
  }
  memo.set(path, { at: now, models })
  return models
}
