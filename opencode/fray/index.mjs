#!/usr/bin/env node
import {
  STATUS,
  formatBoard,
  formatJson,
  formatValidation,
  frayRoot,
  searchThreads,
  validationErrors,
  setSessionOverride,
  clearSessionOverride,
  sessionOverride,
  frayActive,
} from "./core.mjs"

const root = frayRoot(process.cwd())
const args = process.argv.slice(2)

// PER-SESSION TOGGLE — flip/report fray enablement for THIS session via the
// `.fray/.session-state/<session_id>` sentinel (keyed on the harness session id).
const SESSION_ID = process.env.OPENCODE_SESSION_ID || process.env.FRAY_SESSION_ID || undefined
const sub = args[0]
if (sub === "on" || sub === "off" || sub === "enable" || sub === "disable") {
  if (!SESSION_ID) {
    console.error("fray: no session id (set OPENCODE_SESSION_ID/FRAY_SESSION_ID) — cannot toggle this session.")
    process.exit(1)
  }
  const state = sub === "on" || sub === "enable" ? "on" : "off"
  const path = setSessionOverride(root, SESSION_ID, state)
  console.log(`fray: ${state === "on" ? "ENABLED" : "DISABLED"} for this session (${SESSION_ID}).`)
  console.log(`  sentinel: ${path}`)
  process.exit(0)
}
if (sub === "reset" || sub === "default") {
  if (SESSION_ID) clearSessionOverride(root, SESSION_ID)
  console.log(`fray: session override cleared for ${SESSION_ID ?? "(no session id)"} — back to the default (active when .fray/ exists).`)
  process.exit(0)
}
if (sub === "status") {
  console.log(`fray: ${frayActive(root, SESSION_ID) ? "ACTIVE" : "INACTIVE"} this session (${SESSION_ID ?? "no session id"}); override: ${sessionOverride(root, SESSION_ID) ?? "none"}`)
  process.exit(0)
}

if (args.includes("--validate")) {
  const errors = validationErrors(root)
  const output = formatValidation(root)
  if (errors.length) {
    console.error(output)
    process.exit(1)
  }
  console.log(output)
  process.exit(0)
}

if (args.includes("--json")) {
  console.log(formatJson(root))
  process.exit(0)
}

const searchIndex = args.indexOf("--search")
if (searchIndex !== -1) {
  console.log(searchThreads(root, args[searchIndex + 1] || ""))
  process.exit(0)
}

const statusIndex = args.indexOf("--status")
const status = statusIndex === -1 ? null : args[statusIndex + 1]
if (status && !STATUS.includes(status)) {
  console.error(`unknown status "${status}" (expected one of: ${STATUS.join(", ")})`)
  process.exit(2)
}

console.log(formatBoard(root, status))
