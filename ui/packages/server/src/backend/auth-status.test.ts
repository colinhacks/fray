import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readClaudeAuthState, readCodexAuthState } from "./auth-status.ts"

// Codex reads env keys BEFORE the file, so a file-based test must run with those keys cleared or an
// ambient OPENAI_API_KEY in the dev shell would mask the file logic. Clears + restores around fn.
const CODEX_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
function withTmp(fn: (dir: string) => void): void {
  const saved = CODEX_ENV_KEYS.map((k) => [k, process.env[k]] as const)
  for (const k of CODEX_ENV_KEYS) delete process.env[k]
  const dir = mkdtempSync(join(tmpdir(), "fray-auth-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

// ---- Codex: fully file-based ($CODEX_HOME/auth.json), deterministic on every platform ----

test("codex: OAuth token present → authed", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "tok", refresh_token: "r", account_id: "a" } }))
    assert.equal(readCodexAuthState(dir), "authed")
  })
})

test("codex: API key present → authed", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live", tokens: null }))
    assert.equal(readCodexAuthState(dir), "authed")
  })
})

test("codex: no auth.json → signed-out", () => {
  withTmp((dir) => {
    assert.equal(readCodexAuthState(dir), "signed-out")
  })
})

test("codex: auth.json present but empty of credentials → signed-out", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "" } }))
    assert.equal(readCodexAuthState(dir), "signed-out")
  })
})

test("codex: unparseable auth.json → unknown (fail open, never signed-out)", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), "{ not valid json")
    assert.equal(readCodexAuthState(dir), "unknown")
  })
})

test("codex: env key present with no auth.json → authed (fray forwards OPENAI_API_KEY et al.)", () => {
  withTmp((dir) => {
    process.env.OPENAI_API_KEY = "sk-env"
    // No auth.json in dir — env auth must still read as authed, not signed-out.
    assert.equal(readCodexAuthState(dir), "authed")
  })
})

// ---- Claude: file source is deterministic; the macOS Keychain fallback is disabled here so the
// signed-out path is reproducible off a real machine's Keychain. ----

test("claude: credentials file with token → authed", async () => {
  await withTmpAsync(async (dir) => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))
    assert.equal(await readClaudeAuthState(dir), "authed")
  })
})

test("claude: no file + Keychain disabled → signed-out", async () => {
  const prev = process.env.FRAY_KEYCHAIN_DISABLED
  process.env.FRAY_KEYCHAIN_DISABLED = "1"
  try {
    await withTmpAsync(async (dir) => {
      assert.equal(await readClaudeAuthState(dir), "signed-out")
    })
  } finally {
    if (prev === undefined) delete process.env.FRAY_KEYCHAIN_DISABLED
    else process.env.FRAY_KEYCHAIN_DISABLED = prev
  }
})

test("claude: file present but tokenless + Keychain disabled → signed-out", async () => {
  const prev = process.env.FRAY_KEYCHAIN_DISABLED
  process.env.FRAY_KEYCHAIN_DISABLED = "1"
  try {
    await withTmpAsync(async (dir) => {
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }))
      assert.equal(await readClaudeAuthState(dir), "signed-out")
    })
  } finally {
    if (prev === undefined) delete process.env.FRAY_KEYCHAIN_DISABLED
    else process.env.FRAY_KEYCHAIN_DISABLED = prev
  }
})

async function withTmpAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fray-auth-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
