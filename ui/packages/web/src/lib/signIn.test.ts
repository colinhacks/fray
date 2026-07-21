import { test } from "node:test"
import assert from "node:assert/strict"
import { SIGN_IN_COMMAND, PROVIDER_LABEL, parseAccountAlias } from "./signIn.ts"

// Lock the exact commands surfaced by the sign-in gate. These are real CLI invocations the user runs
// verbatim, verified against `claude auth --help` / `codex login --help` — a silent drift here would
// tell a signed-out user to run a command that doesn't exist.
test("sign-in commands are the verified provider login invocations", () => {
  assert.equal(SIGN_IN_COMMAND.claude, "claude auth login")
  assert.equal(SIGN_IN_COMMAND.codex, "codex login")
})

test("provider labels are human-facing names", () => {
  assert.equal(PROVIDER_LABEL.claude, "Claude")
  assert.equal(PROVIDER_LABEL.codex, "Codex")
})

// The alias boundary: ONLY the complete, exact spelling invokes an account action; everything else —
// arguments, other slash-words, mid-text mentions — remains an ordinary prompt fray must not confiscate.
test("parseAccountAlias: exact complete input only", () => {
  assert.equal(parseAccountAlias("/login"), "login")
  assert.equal(parseAccountAlias("  /logout \n"), "logout")
  assert.equal(parseAccountAlias("/login please"), null)
  assert.equal(parseAccountAlias("/LOGIN"), null)
  assert.equal(parseAccountAlias("run /login for me"), null)
  assert.equal(parseAccountAlias("/loginx"), null)
  assert.equal(parseAccountAlias("/compact"), null)
  assert.equal(parseAccountAlias(""), null)
})
