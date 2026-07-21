// Disposable, fully-ISOLATED fray-ui stack for ad hoc CDP / manual verification.
//
// Why this exists: verifying a fray-ui change means driving the REAL app end-to-end, but you must never
// touch the maintainer's live instance, real ~/.fray SQLite, or real worker tmux sockets. This boots a
// throwaway stack that is sandboxed on every axis:
//   • HOME              → a fresh temp dir, so the SQLite DB + server.lock live in an empty ~/.fray
//   • FRAY_TMUX_SOCKET  → a unique socket name, so any spawned worker tmux never collides with real ones
//   • PORT              → a unique high port, so it never fights the dev server on 5175
//   • FRAY_WAKERS_OFF=1 → scheduler OFF by default (no wake side effects); pass --wakers to arm it
// The project defaults to the fray repo itself (a gh-authed repo, an empty board under the temp HOME).
//
// Usage:
//   npx tsx ui/scripts/adhoc-stack.mjs [--port=4930] [--project=/abs/dir] [--wakers] [--reaper] [--keep] [--seed]
//
// It prints ONE json line to stdout: {"url","port","home","socket","project"} once /health is green,
// then stays up until SIGINT/SIGTERM, deleting the temp HOME on exit (unless --keep). Run it with Bash
// run_in_background:true, parse that json line, then drive the url with Chrome DevTools MCP or shot.mjs.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}

const port = Number(opt("port", "4930"))
const projectDir = opt("project", process.cwd().replace(/\/ui$/, "")) // default: the fray repo root
const keep = flag("keep")

// Sandbox HOME first — resolveProject() reads homedir() lazily, so setting it now redirects the whole
// state tree (~/.fray/projects/<id>/) into the throwaway dir before the server derives any path.
const home = mkdtempSync(join(tmpdir(), "fray-adhoc-home-"))
mkdirSync(join(home, ".fray"), { recursive: true })
process.env.HOME = home
process.env.FRAY_TMUX_SOCKET = `fray-adhoc-${port}-${process.pid}`
if (!flag("wakers")) process.env.FRAY_WAKERS_OFF = "1"
// A disposable stack must never reap the real machine's leaked worker processes (the orphan reaper
// enumerates ALL processes, not just this stack's). Off by default, exactly like the scheduler; pass
// --reaper to arm it when verifying the reaper itself.
if (!flag("reaper")) process.env.FRAY_ORPHAN_REAPER_OFF = "1"
process.chdir(projectDir)

// Optional: drop a tiny fixture note so the board isn't stone empty when eyeballing the shell. Off by
// default — most verification wants a known clean board and seeds its own rows through the RPC surface.
if (flag("seed")) {
  try {
    writeFileSync(join(home, ".fray", "ADHOC_SEED"), "adhoc stack seed marker\n")
  } catch {}
}

let close = async () => {}
const cleanup = () => {
  if (!keep) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
}
const stop = (code) => {
  void (async () => {
    try { await close() } catch {}
    cleanup()
    process.exit(code ?? 0)
  })()
}
process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
process.on("uncaughtException", (e) => { console.error("[adhoc-stack] uncaught", e); stop(1) })

const { startServer } = await import("../packages/server/src/index.ts")
try {
  const started = await startServer({ dev: true, port, installSignalHandlers: false })
  close = () => started.close()
  // Confirm the API is actually serving before announcing — a race here would hand CDP a dead port.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(JSON.stringify({
    url: `http://127.0.0.1:${port}/`,
    port, home, socket: process.env.FRAY_TMUX_SOCKET, project: projectDir,
    wakers: flag("wakers"),
  }))
} catch (error) {
  console.error("[adhoc-stack] boot failed:", error)
  cleanup()
  process.exit(1)
}
