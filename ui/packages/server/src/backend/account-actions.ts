import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AccountLogoutResult, Backend, ThreadView } from "@fray-ui/shared"
import { readAuthSnapshot } from "./auth-status.ts"

const execFileAsync = promisify(execFile)

// Typed provider account actions (claude-auth plan): `/logout` and the future login utility both
// resolve to these — never to text submitted into a provider transcript. Logout is more consequential
// than login because it mutates process-GLOBAL account state: it must refuse to race a live turn for
// that provider, and the exact CLI argv runs WITHOUT a shell.

// A turn that could be mid-request for this provider. turn-idle is safe ONLY when nothing is running
// underneath it: a parked parent with a live background sub-agent/shell is still consuming the
// credential, so logout must refuse it too (review finding L3 — a naive runtime check would yank the
// token from an in-flight child). A truly idle worker's next follow-up surfaces the signed-out state
// through the runtime 401 classifier.
const LIVE_RUNTIMES = new Set(["spawning", "running", "perm-prompt"])

// Count this provider's live sessions from a board snapshot. Rows with no recorded backend are
// treated as Claude (the unmarked default) so an unlabeled live worker still blocks a Claude logout.
export function liveThreadsForBackend(
  threads: readonly Pick<ThreadView, "backend" | "runtime" | "kind" | "foreign" | "subAgents" | "bgShells">[],
  backend: Backend,
): number {
  let count = 0
  for (const thread of threads) {
    if (thread.kind !== "session" || thread.foreign) continue
    if ((thread.backend ?? "claude") !== backend) continue
    const backgroundWork =
      thread.subAgents.some((agent) => agent.state === "running") ||
      thread.bgShells.some((shell) => shell.state === "running")
    if (LIVE_RUNTIMES.has(thread.runtime) || backgroundWork) count++
  }
  return count
}

// Run the provider's own logout CLI (`claude auth logout` / `codex logout`) as an argv vector, then
// re-read the local credential state so the caller can refresh the auth snapshot. The detail string is
// BOUNDED and never carries raw provider output beyond a short trimmed line (logout output is not
// secret, but the boundary discipline matches the rest of the auth surface).
export async function runProviderLogout(opts: {
  backend: Backend
  claudeBin?: string
  codexBin?: string
  timeoutMs?: number
  liveThreads: number
}): Promise<AccountLogoutResult> {
  if (opts.liveThreads > 0) {
    return { status: "blocked", activeThreads: opts.liveThreads, auth: (await readAuthSnapshot({ claudeBin: opts.claudeBin }))[opts.backend] }
  }
  const bin = opts.backend === "codex" ? (opts.codexBin ?? "codex") : (opts.claudeBin ?? "claude")
  const args = opts.backend === "codex" ? ["logout"] : ["auth", "logout"]
  let failure: string | undefined
  try {
    await execFileAsync(bin, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 15_000 })
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string }
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : ""
    failure = (stderr || e.message || "logout command failed").slice(0, 200)
  }
  // The credential state AFTER the attempt is the truth the UI needs — a "failed" logout that still
  // cleared the credential (or was already signed out) should read as signed out.
  const auth = (await readAuthSnapshot({ claudeBin: opts.claudeBin }))[opts.backend]
  if (failure && auth !== "signed-out") return { status: "failed", detail: failure, auth }
  return { status: "done", auth }
}
