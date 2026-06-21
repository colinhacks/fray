#!/usr/bin/env node
import { STATUS, formatBoard, formatJson, formatValidation, frayRoot, searchThreads, validationErrors } from "./core.mjs"

const root = frayRoot(process.cwd())
const args = process.argv.slice(2)

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
