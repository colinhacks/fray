import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./ExternalTerminalCommand.tsx", import.meta.url)), "utf8")

test("copy command button wires the feedback lifecycle before starting the copy and renders both icon states", () => {
  assert.match(source, /function handleCopy\(\) \{\s*const generation = feedback\.current!\.begin\(\)\s*copy\(\{ onError:/)
  assert.match(source, /copied\s*\? <Check[\s\S]*: <TerminalSquare/)
  assert.match(source, /useEffect\(\(\) => \(\) => feedback\.current\?\.dispose\(\), \[\]\)/)
  assert.match(source, /const label = copied \? "Provider resume command copied" : "Copy provider resume command"/)
})
