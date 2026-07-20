export interface ProviderMarkDefinition {
  /** Backend value carried on a known, owned thread. */
  backend: "claude" | "codex"
  /** Exposed to assistive technology because the mark is the provider cue. */
  label: "Claude Code" | "OpenAI Codex"
}

/**
 * Provider-specific optical sizing is intentionally part of the component contract. The OpenAI
 * knot fills its viewBox more densely than the Claude Code asterisk, so matching nominal boxes
 * makes Codex read too large. The Codex knot also needs no downward baseline correction: at this
 * compact size that correction left it reading one pixel low beside title text.
 */
export const PROVIDER_MARK_GEOMETRY: Record<ProviderMarkDefinition["backend"], string> = {
  claude: "size-[11px] translate-y-px",
  codex: "size-[10px]",
}

const PROVIDER_MARKS: Record<ProviderMarkDefinition["backend"], ProviderMarkDefinition> = {
  claude: { backend: "claude", label: "Claude Code" },
  codex: { backend: "codex", label: "OpenAI Codex" },
}

// Board snapshots from an older server, plans, legacy rows, and future backends intentionally have
// no identity mark. Do not infer one from the current dispatch preference or model name.
export function providerMarkForBackend(backend: string | null | undefined): ProviderMarkDefinition | undefined {
  return backend === "claude" || backend === "codex" ? PROVIDER_MARKS[backend] : undefined
}
