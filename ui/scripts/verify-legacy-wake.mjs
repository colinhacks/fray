// Ad hoc proof for the legacy-socket wake fix, exercised against REAL tmux (no mocks).
//
// The bug: waking a days-old worker threw "A live matching worker exists on a compatible legacy tmux
// socket; no duplicate was spawned" forever, because the DETECT path (crossSocketLiveOwner) scanned the
// full project socket deriveSocket(project.id) while the INJECT path (findCompatibleLegacyWorker) did
// not — so a live worker stranded there was seen-but-unreachable and retried to exhaustion. This also
// hit every CODEX worker, whose rollout id is a bare positional the Claude-only matcher never matched.
//
// This harness spawns a fake worker pane on the FULL project socket with a realistic start command,
// then asserts BOTH scans now agree it's a compatible, injectable worker — for Claude and for Codex.
//
// Usage: npx tsx ui/scripts/verify-legacy-wake.mjs   (exit 0 = all green)
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { deriveSocket } from "../packages/server/src/tmux-socket.ts"
import { crossSocketLiveOwner, findCompatibleLegacyWorker } from "../packages/server/src/tmux.ts"

const projectId = randomUUID()
const projectDir = process.cwd()
const project = { id: projectId, dir: projectDir }
// The active runtime socket must DIFFER from deriveSocket(project.id) to reproduce the strand — that is
// exactly the override/worktree/cross-version case. The tmux.ts module socket defaults to "fray", which
// already differs from this random project's deriveSocket, so the stranded-on-full-socket path is live.
const fullSocket = deriveSocket(projectId)

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`) }

function tmux(socket, ...a) {
  return execFileSync("tmux", ["-L", socket, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}
function killSocket(socket) { try { tmux(socket, "kill-server") } catch {} }

// tmux session name mirrors tmuxSessionName(slug); the scans key off the session name = "fray-<slug>".
// `cmd` is passed as SEPARATE argv after `--`, exactly as production's spawnWorker does (tmux.ts) — a
// single quoted-string command would wrap args in quotes and misrepresent #{pane_start_command}.
function scenario(label, slug, cmd, nativeId, backend, expectFound) {
  const name = `fray-${slug}`
  killSocket(fullSocket)
  // Spawn a live pane on the FULL project socket whose start command carries the native id exactly like
  // a real days-old worker. cwd is the project dir so the belongs()/name checks pass.
  tmux(fullSocket, "new-session", "-d", "-s", name, "-c", projectDir, "--", ...cmd)
  try {
    const owner = crossSocketLiveOwner(slug, project)
    check(`${label}: crossSocketLiveOwner sees it live`, owner === "live", `got "${owner}"`)
    const lookup = findCompatibleLegacyWorker(slug, project, nativeId, backend)
    check(`${label}: findCompatibleLegacyWorker resolves it`, lookup.kind === expectFound, `got "${lookup.kind}" (want "${expectFound}")`)
  } finally {
    killSocket(fullSocket)
  }
}

const claudeId = randomUUID()
scenario("claude days-old worker", `wake-claude-${claudeId.slice(0, 8)}`,
  ["claude", "--session-id", claudeId, "--dangerously-skip-permissions"], claudeId, "claude", "found")

// Codex, id as the LAST positional (permission-only reattach, no trailing message).
const codexId = randomUUID()
scenario("codex days-old worker (id last)", `wake-codex-${codexId.slice(0, 8)}`,
  ["codex", "resume", "--cd", projectDir, "-a", "never", "-s", "workspace-write", codexId], codexId, "codex", "found")

// Codex, id followed by a multi-word message positional — the common follow-up form.
const codexId2 = randomUUID()
scenario("codex days-old worker (id + message)", `wake-codex2-${codexId2.slice(0, 8)}`,
  ["codex", "resume", "--cd", projectDir, "-s", "workspace-write", codexId2, "please continue the task"], codexId2, "codex", "found")

// Negative control: a live same-name pane whose command does NOT carry the id must stay "unknown"
// (never spuriously "found") — the widened scan must not weaken identity safety.
const strayId = randomUUID()
scenario("stray same-name pane (identity mismatch)", `wake-stray-${strayId.slice(0, 8)}`,
  ["sleep", "100000"], strayId, "claude", "unknown")

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
