import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const names = ["ci-watch.mjs", "github-watch.mjs", "review-watch.mjs"]
const targets = ["codex/skills/fray-orchestrator/scripts", "cc-worker/skills/gh/scripts"]

test("provider packages contain byte-identical generated monitor entrypoints", () => {
  for (const target of targets) for (const name of names) {
    const source = join(root, "monitors", name)
    const copy = join(root, target, name)
    assert.ok(existsSync(copy), `missing ${copy}`)
    assert.equal(readFileSync(copy, "utf8"), readFileSync(source, "utf8"), `${copy} drifted from ${source}`)
  }
})

test("portable monitor guidance requires declared-project precedence and explicit validation", () => {
  const guide = readFileSync(join(root, "monitors", "README.md"), "utf8")
  assert.match(guide, /inspect project-local `AGENTS\.md`, active skills, repository docs,[\s\S]*`package\.json` scripts, and declared monitor tooling/)
  assert.match(guide, /Validate its absolute command and its\s+terminal event\/exit contract before launching it/)
  assert.match(guide, /do not silently fall back[\s\S]*shadow it/)
})

test("Codex and Claude provider guidance prefer declared tooling and make no Luna child mandatory", () => {
  const codex = readFileSync(join(root, "codex/skills/fray-orchestrator/SKILL.md"), "utf8")
  const claude = readFileSync(join(root, "cc-worker/skills/gh/SKILL.md"), "utf8")
  for (const guide of [codex, claude]) {
    assert.match(guide, /project-local `AGENTS\.md`/)
    assert.match(guide, /terminal\s+event\/exit contract/)
    assert.match(guide, /never silently shadow/)
    assert.match(guide, /workflow name.*event|workflow name plus event/)
  }
  assert.match(codex, /Luna\s+child is optional only/)
  assert.doesNotMatch(codex, /exactly one `gpt-5\.6-luna` \+ `medium` monitor child/)
  assert.match(claude, /use native `Monitor`/)

  const codexPrompt = readFileSync(join(root, "ui/packages/server/src/WORKER_PROMPT.codex.golden.txt"), "utf8")
  const claudePrompt = readFileSync(join(root, "ui/packages/server/src/WORKER_PROMPT.claude.golden.txt"), "utf8")
  for (const prompt of [codexPrompt, claudePrompt]) {
    assert.match(prompt, /project-local `AGENTS\.md`/)
    assert.match(prompt, /terminal event\/exit semantics/)
    assert.match(prompt, /silently shadow/)
  }
  assert.match(codexPrompt, /Luna child is optional/)
  assert.doesNotMatch(codexPrompt, /cheap monitor child/)
  assert.match(claudePrompt, /native `Monitor` is the\nClaude adapter/)
})
