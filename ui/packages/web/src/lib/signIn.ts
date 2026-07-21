import type { Backend } from "@fray-ui/shared"

// The exact CLI command that (re-)authenticates each provider, surfaced in the sign-in modal for the
// user to run in their own terminal. fray-ui is browser-attached and can't host the interactive
// browser-OAuth flow itself, so the honest affordance is the copyable command plus a re-check — not a
// button that pretends to log in. Verified against `claude auth --help` / `codex login --help`.
export const SIGN_IN_COMMAND: Record<Backend, string> = {
  claude: "claude auth login",
  codex: "codex login",
}

// Human label for each backend, for sign-in copy ("You're signed out of Claude").
export const PROVIDER_LABEL: Record<Backend, string> = {
  claude: "Claude",
  codex: "Codex",
}
