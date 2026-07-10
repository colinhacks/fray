#!/usr/bin/env node
// fray-ui: launch (or reuse) the per-repo server, then open the app window.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { DEFAULT_PORT } from "@fray-ui/shared"
import { launchApp } from "./browser.ts"

const argv = process.argv.slice(2)
const args = new Set(argv)
const noApp = args.has("--no-app") // opt out of the app window and just print the URL
const dev = args.has("--dev")

// --port <n> (or --port=<n>) overrides the default listen port.
function parsePort(): number | undefined {
  const i = argv.indexOf("--port")
  const raw = i !== -1 ? argv[i + 1] : argv.find((a) => a.startsWith("--port="))?.slice("--port=".length)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`invalid --port value: ${raw}`)
    process.exit(1)
  }
  return n
}
const portArg = parsePort()

function gitRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    console.error("fray-ui must be run inside a git repository")
    process.exit(1)
  }
}

function projectId(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "config", "fray.id"], { encoding: "utf8" }).trim()
  } catch {
    const id = crypto.randomUUID()
    execFileSync("git", ["-C", root, "config", "fray.id", id])
    return id
  }
}

function liveLock(stateDir: string): { pid: number; port: number } | null {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(stateDir, "server.lock"), "utf8"))
    process.kill(lock.pid, 0) // throws if dead
    return lock
  } catch {
    return null
  }
}

const root = gitRoot()
process.chdir(root)
const stateDir = path.join(os.homedir(), ".fray", "projects", projectId(root))
fs.mkdirSync(stateDir, { recursive: true })

let port = portArg ?? DEFAULT_PORT
const lock = liveLock(stateDir)
if (lock) {
  port = lock.port
  console.log(`fray-ui server already running (pid ${lock.pid}, port ${port})`)
} else {
  const { startServer } = await import("@fray-ui/server")
  const started = await startServer({ dev, port })
  port = started?.port ?? port
  console.log(`fray-ui serving ${root} on http://127.0.0.1:${port}`)
}

const url = `http://127.0.0.1:${port}`
if (noApp) {
  console.log(url)
} else {
  try {
    await launchApp(url, { dataPath: path.join(stateDir, "browser-profile") })
    console.log(`fray-ui window opened — ${url}`)
  } catch {
    // No supported browser for --app mode (or launch failed): the server is up regardless, so
    // point the user at the URL rather than exiting on a cosmetic failure.
    console.log(`No supported browser found to open the app window. Open this URL manually:\n  ${url}`)
  }
}
