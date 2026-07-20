// POSIX shell quoting for a command copied into the user's terminal. Keep the command construction
// server-side: callers never turn an untrusted display field into a shell argument.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function providerResumeCommand(backend: "claude" | "codex", projectDir: string, sessionId: string): string {
  const resume = backend === "codex" ? `codex resume ${shellQuote(sessionId)}` : `claude --resume ${shellQuote(sessionId)}`
  return `cd ${shellQuote(projectDir)} && ${resume}`
}
