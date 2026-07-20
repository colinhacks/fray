export type TerminalCloseKind = "exited" | "reconnect"
export const TERMINAL_PENDING_INPUT_MAX_BYTES = 1_048_576

// node-pty reports a missing/dead tmux pane as a clean websocket close whose reason names the PTY
// exit. Everything else (server replacement, network loss, laptop sleep, proxy reset) is transport
// failure and should reconnect without throwing away the xterm buffer.
export function terminalCloseKind(code: number, reason: string): TerminalCloseKind {
  return code === 1000 && /^pty exit\s+-?\d+$/.test(reason.trim()) ? "exited" : "reconnect"
}

// Fast first recovery, capped so an offline server never becomes a reconnect storm.
export function terminalReconnectDelay(failures: number): number {
  return Math.min(250 * 2 ** Math.max(0, failures - 1), 5_000)
}

// Returns the new queued byte count, or null when accepting the input would exceed the offline
// bound. Byte accounting matches the server's UTF-8 validation rather than JavaScript code units.
export function queuedTerminalInputBytes(currentBytes: number, input: string): number | null {
  const next = currentBytes + new TextEncoder().encode(input).byteLength
  return next <= TERMINAL_PENDING_INPUT_MAX_BYTES ? next : null
}
