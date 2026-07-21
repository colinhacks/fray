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

// `/login` and `/logout` are FRAY-OWNED aliases for the typed provider account actions — they are
// intercepted at the composer submit boundary and NEVER sent to a thread as prompt text (a leading
// slash is not a stable provider command transport: live input is pasted into a TUI while a dead
// session resumes with the text as a positional prompt). Only the complete, exact input counts;
// "/login please" or any other "/word" remains an ordinary prompt — fray does not confiscate syntax
// it cannot prove is a command.
export function parseAccountAlias(text: string): "login" | "logout" | null {
  const t = text.trim()
  if (t === "/login") return "login"
  if (t === "/logout") return "logout"
  return null
}
