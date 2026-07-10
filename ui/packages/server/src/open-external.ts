import { spawn } from "node:child_process"

// Validate a URL handed to us by the web client before we let the OS open it. The fray UI runs as a
// chromeless Chrome --app window with a DEDICATED user-data-dir, so links clicked inside would open
// in that anonymous-looking profile; we instead route them to the OS default browser. This endpoint
// must NOT become a shell-injection or arbitrary-file-open vector, so we accept ONLY http/https URLs
// that actually parse — everything else (javascript:, file:, data:, mailto:, garbage) is rejected.
export function validateExternalUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: "unparseable URL" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme: ${parsed.protocol}` }
  }
  return { ok: true, url: parsed.toString() }
}

// Open a validated http(s) URL in the OS default browser. Uses spawn with an ARGS ARRAY (never a
// shell string) so the URL can never be reinterpreted as a command. macOS-first (`open`); linux uses
// `xdg-open`. The child is detached + unref'd so it outlives this request.
export function openExternalUrl(raw: string): void {
  const v = validateExternalUrl(raw)
  if (!v.ok) throw new Error(v.reason)
  const [cmd, args] =
    process.platform === "darwin"
      ? (["open", [v.url]] as const)
      : (["xdg-open", [v.url]] as const)
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()
}
