#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "monitors")
const names = ["ci-watch.mjs", "github-watch.mjs", "review-watch.mjs"]
const targets = [
  join(root, "codex/skills/fray-orchestrator/scripts"),
  join(root, "cc-worker/skills/gh/scripts"),
]
const check = process.argv.slice(2).join(" ") === "--check"
if (process.argv.length > 2 && !check) throw new Error("Usage: sync-portable-monitors.mjs [--check]")

let drift = false
for (const target of targets) for (const name of names) {
  const from = join(source, name)
  const to = join(target, name)
  const same = existsSync(to) && readFileSync(from, "utf8") === readFileSync(to, "utf8")
  if (!same) {
    drift = true
    if (!check) cpSync(from, to)
    else console.error(`portable monitor copy drift: ${to}`)
  }
}
if (check && drift) process.exitCode = 1
