import type {
  CodexModel,
  DispatchProfileSnapshot,
  GithubBatchInput,
} from "@fray-ui/shared"
import type { ResolvedDispatchPreferences } from "./dispatchPreferences.ts"
import { CLAUDE_MODELS, EFFORTS } from "./options.ts"

const CLAUDE_PERMISSIONS = new Set(["auto", "default", "acceptEdits", "bypassPermissions"])
const CODEX_PERMISSIONS = new Set(["default", "plan", "bypassPermissions"])

export type ProfileCaptureResult =
  | { ok: true; profile: DispatchProfileSnapshot }
  | { ok: false; error: string }

// Capture the exact values currently rendered by a prompt box. Availability flags come from the same
// resolved preference object that gates typed submission, so the GitHub trigger cannot snapshot an
// unknown model or split an invalid model/effort pair.
export function captureDispatchProfile(
  resolved: ResolvedDispatchPreferences | undefined,
): ProfileCaptureResult {
  if (!resolved) return { ok: false, error: "Profile is still loading — wait before opening GitHub" }
  if (!resolved.modelAvailable) {
    return { ok: false, error: "Saved model is unavailable — choose a model before opening GitHub" }
  }
  if (!resolved.effortAvailable) {
    return { ok: false, error: "Saved reasoning level is unavailable — choose another level before opening GitHub" }
  }
  const profile: DispatchProfileSnapshot = {
    backend: resolved.backend,
    model: resolved.model,
    effort: resolved.effort as DispatchProfileSnapshot["effort"],
    permissionMode: resolved.permissionMode,
  }
  const error = dispatchProfileError(profile, resolved.backend === "codex" && resolved.codexModel
    ? [resolved.codexModel]
    : [])
  return error ? { ok: false, error } : { ok: true, profile }
}

// Revalidate immediately before the final mutation. A Codex cache refresh can invalidate a model or
// effort while the picker is open; that must stop visibly instead of falling back or downgrading.
export function dispatchProfileError(
  profile: DispatchProfileSnapshot,
  codexModels: readonly CodexModel[],
): string | undefined {
  if (profile.backend === "claude") {
    if (!CLAUDE_MODELS.some((option) => option.value === profile.model)) {
      return `Claude model ${profile.model} is no longer available`
    }
    if (!(EFFORTS as readonly string[]).includes(profile.effort)) {
      return `Reasoning level ${profile.effort} is not available for ${profile.model}`
    }
    if (!CLAUDE_PERMISSIONS.has(profile.permissionMode)) {
      return `Permission ${profile.permissionMode} is not valid for Claude dispatch`
    }
    return undefined
  }

  const model = codexModels.find((candidate) => candidate.slug === profile.model)
  if (!model) return `Codex model ${profile.model} is no longer available`
  if (!model.efforts.includes(profile.effort)) {
    return `Reasoning level ${profile.effort} is not available for ${profile.model}`
  }
  if (!CODEX_PERMISSIONS.has(profile.permissionMode)) {
    return `Sandbox ${profile.permissionMode} is not valid for Codex dispatch`
  }
  return undefined
}

export function buildGithubBatchInput(
  profile: DispatchProfileSnapshot,
  items: GithubBatchInput["items"],
): GithubBatchInput {
  return {
    items: items.map((item) => ({ ...item })),
    backend: profile.backend,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
  }
}
