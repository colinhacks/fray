import type { Backend, ThreadProfileOption } from "@fray-ui/shared"
import { readCodexModels } from "./codex-models.ts"

// Claude Code 2.1.207 accepts model and effort together on both a new session and --resume. Keep the
// native aliases here on the server: an existing-thread mutation must never depend on the browser's
// model-name classifier (whose historical unknown=>Claude fallback is intentionally irrelevant).
export const CLAUDE_THREAD_PROFILES: readonly ThreadProfileOption[] = [
  { model: "fable", label: "Fable", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "opus", label: "Opus", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "sonnet", label: "Sonnet", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "haiku", label: "Haiku", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
]

export function threadProfileOptions(backend: unknown): { backend: Backend; options: ThreadProfileOption[] } {
  if (backend === "claude") return { backend, options: CLAUDE_THREAD_PROFILES.map((option) => ({ ...option, efforts: [...option.efforts] })) }
  if (backend === "codex") {
    return {
      backend,
      options: readCodexModels().map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: [...model.efforts],
      })),
    }
  }
  throw new Error("This thread has an unknown backend; its runtime profile cannot be changed")
}

export function validateThreadProfile(backend: unknown, model: string, effort: string): void {
  const catalogue = threadProfileOptions(backend)
  const option = catalogue.options.find((candidate) => candidate.model === model)
  if (!option || !option.efforts.includes(effort)) {
    throw new Error(`Unsupported ${catalogue.backend} model/effort pair: ${model} / ${effort}`)
  }
}

export function normalizeObservedThreadModel(backend: unknown, model: string): string | undefined {
  const value = model.trim()
  if (backend === "codex") return threadProfileOptions(backend).options.some((option) => option.model === value) ? value : undefined
  if (backend === "claude") {
    const exact = CLAUDE_THREAD_PROFILES.find((option) => option.model === value)
    if (exact) return exact.model
    return CLAUDE_THREAD_PROFILES.find((option) => value.toLowerCase().includes(option.model))?.model
  }
  return undefined
}
