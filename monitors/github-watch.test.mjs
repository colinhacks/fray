import assert from "node:assert/strict"
import test from "node:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { classifyChecks, gh, humanReviewActivity, latestWorkflowRuns, parseArgs, PROTOCOL, report } from "./github-watch.mjs"

test("CI classifier keeps fork-gated action_required checks pending", () => {
  assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "ACTION_REQUIRED" }]).state, "pending")
  assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "SKIPPED" }]).state, "passed")
  assert.equal(classifyChecks([{ state: "FAILURE" }]).state, "failed")
})

test("review activity excludes bot nodes and preserves human ids", () => {
  const ids = humanReviewActivity({ data: { repository: { pullRequest: {
    reviews: { nodes: [{ id: "human", author: { login: "ana", __typename: "User" } }] },
    comments: { nodes: [{ id: "bot", author: { login: "dependabot[bot]", __typename: "Bot" } }] },
  } } } })
  assert.deepEqual([...ids], ["human"])
})

test("latest workflow run replaces retries but aggregates every exact-head workflow event", () => {
  const latest = latestWorkflowRuns([
    { workflowName: "CI", event: "pull_request", conclusion: "ACTION_REQUIRED", databaseId: 1, createdAt: "2026-07-14T10:00:00Z" },
    { workflowName: "CI", event: "pull_request", conclusion: "SUCCESS", databaseId: 2, createdAt: "2026-07-14T10:02:00Z" },
    { workflowName: "Lint", event: "pull_request", conclusion: "FAILURE", databaseId: 3, createdAt: "2026-07-14T10:00:00Z" },
    { workflowName: "Lint", event: "pull_request", conclusion: "SUCCESS", databaseId: 4, createdAt: "2026-07-14T10:03:00Z" },
    { workflowName: "E2E", event: "pull_request", conclusion: "ACTION_REQUIRED", databaseId: 5, createdAt: "2026-07-14T10:04:00Z" },
    { workflowName: "CI", event: "push", conclusion: "FAILURE", databaseId: 6, createdAt: "2026-07-14T10:05:00Z" },
  ])
  assert.deepEqual(latest.map((run) => [run.workflowName, run.event, run.conclusion]).sort(), [
    ["CI", "pull_request", "SUCCESS"],
    ["CI", "push", "FAILURE"],
    ["E2E", "pull_request", "ACTION_REQUIRED"],
    ["Lint", "pull_request", "SUCCESS"],
  ])
  assert.equal(classifyChecks(latest.map((run) => ({ state: run.conclusion }))).state, "failed")
})

test("watch arguments require a PR and repository", () => {
  assert.throws(() => parseArgs([], "usage"), /usage/)
  assert.throws(() => parseArgs(["--repo", "bad/repo/name", "--pr", "42"], "usage"), /OWNER\/REPO/)
  assert.throws(() => parseArgs(["--repo", "acme/app", "--pr", "0"], "usage"), /positive number/)
  assert.deepEqual(parseArgs(["--repo", "acme/app", "--pr", "42", "--once"], "usage"), { repo: "acme/app", pr: "42", interval: 60, once: true })
})

test("NDJSON reports have a versioned status or terminal schema", () => {
  let line = ""
  const write = process.stdout.write
  process.stdout.write = (chunk) => { line += chunk; return true }
  try { report("terminal", { kind: "ci", state: "passed", repo: "acme/app", pr: "42" }) } finally { process.stdout.write = write }
  const event = JSON.parse(line)
  assert.deepEqual(Object.keys(event).sort(), ["at", "kind", "pr", "protocol", "repo", "state", "type"])
  assert.equal(event.protocol, PROTOCOL)
  assert.equal(event.type, "terminal")
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.throws(() => report("progress", {}), /invalid monitor event type/)
})

function fakeGhDir(state = "SUCCESS") {
  const dir = mkdtempSync(join(tmpdir(), "fray-monitor-"))
  const gh = join(dir, "gh")
  writeFileSync(gh, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"headRefOid":"abc"}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then echo '[{"state":"${state}"}]'; exit 0; fi
if [ "$1" = "run" ]; then echo '[]'; exit 0; fi
exit 1
`)
  chmodSync(gh, 0o755)
  return dir
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for monitor output")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("CI entrypoint emits a terminal pass event and exits zero", () => {
  const dir = fakeGhDir()
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./ci-watch.mjs", import.meta.url)), "--repo", "acme/app", "--pr", "42", "--once"], { encoding: "utf8", env: { ...process.env, PATH: dir } })
    assert.equal(result.status, 0)
    const event = JSON.parse(result.stdout)
    assert.equal(event.type, "terminal")
    assert.equal(event.state, "passed")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("CI failure exits 2 and --once pending emits one status event with exit 0", () => {
  for (const [state, expectedStatus, expectedType, expectedState] of [
    ["FAILURE", 2, "terminal", "failed"],
    ["PENDING", 0, "status", "pending"],
  ]) {
    const dir = fakeGhDir(state)
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./ci-watch.mjs", import.meta.url)), "--repo", "acme/app", "--pr", "42", "--once"], { encoding: "utf8", env: { ...process.env, PATH: dir } })
      assert.equal(result.status, expectedStatus)
      const events = result.stdout.trim().split("\n").map(JSON.parse)
      assert.equal(events.length, 1)
      assert.deepEqual({ type: events[0].type, state: events[0].state, kind: events[0].kind }, { type: expectedType, state: expectedState, kind: "ci" })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test("CI auth or missing-gh failures are terminal error exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-monitor-empty-"))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./ci-watch.mjs", import.meta.url)), "--repo", "acme/app", "--pr", "42", "--once"], { encoding: "utf8", env: { ...process.env, PATH: dir } })
    assert.equal(result.status, 3)
    const event = JSON.parse(result.stdout)
    assert.deepEqual({ type: event.type, state: event.state }, { type: "terminal", state: "error" })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("malformed invocations are terminal NDJSON errors; --help is the documented plain-text exception", () => {
  const ci = fileURLToPath(new URL("./ci-watch.mjs", import.meta.url))
  const malformed = spawnSync(process.execPath, [ci, "--repo", "bad/repo/name", "--pr", "42"], { encoding: "utf8" })
  assert.equal(malformed.status, 3)
  assert.deepEqual(JSON.parse(malformed.stdout), {
    protocol: PROTOCOL,
    type: "terminal",
    kind: "ci",
    state: "error",
    error: "--repo must be OWNER/REPO",
    at: JSON.parse(malformed.stdout).at,
  })
  const help = spawnSync(process.execPath, [ci, "--help"], { encoding: "utf8" })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^Usage: ci-watch\.mjs/)
  assert.throws(() => JSON.parse(help.stdout))
})

test("CI SIGTERM emits one cancelled terminal event and exits 130", async () => {
  const dir = fakeGhDir("PENDING")
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./ci-watch.mjs", import.meta.url)), "--repo", "acme/app", "--pr", "42"], { env: { ...process.env, PATH: dir } })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    const closed = new Promise((resolve) => child.once("close", resolve))
    await waitFor(() => stdout.includes('"state":"pending"'))
    child.kill("SIGTERM")
    const code = await closed
    assert.equal(code, 130)
    const terminal = stdout.trim().split("\n").map(JSON.parse).filter((event) => event.type === "terminal")
    assert.deepEqual(terminal.map((event) => event.state), ["cancelled"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function fakeReviewGhDir() {
  const dir = mkdtempSync(join(tmpdir(), "fray-review-monitor-"))
  const gh = join(dir, "gh")
  writeFileSync(gh, `#!/bin/sh
count_file="$0.count"
count=0
[ -f "$count_file" ] && count=$(/bin/cat "$count_file")
count=$((count + 1))
echo "$count" > "$count_file"
if [ "$count" -eq 1 ]; then echo '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"id":"old","author":{"login":"ana","__typename":"User"}}]},"comments":{"nodes":[]}}}}}'; else echo '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"id":"old","author":{"login":"ana","__typename":"User"}},{"id":"new","author":{"login":"bea","__typename":"User"}}]},"comments":{"nodes":[]}}}}}'; fi
`)
  chmodSync(gh, 0o755)
  return dir
}

test("review --once emits an armed status and a live watch wakes only for new human activity", async () => {
  const review = fileURLToPath(new URL("./review-watch.mjs", import.meta.url))
  const onceDir = fakeReviewGhDir()
  try {
    const once = spawnSync(process.execPath, [review, "--repo", "acme/app", "--pr", "42", "--once"], { encoding: "utf8", env: { ...process.env, PATH: onceDir } })
    assert.equal(once.status, 0)
    assert.deepEqual(JSON.parse(once.stdout), { ...JSON.parse(once.stdout), type: "status", kind: "review", state: "armed", seen: 1 })
  } finally { rmSync(onceDir, { recursive: true, force: true }) }

  const dir = fakeReviewGhDir()
  try {
    const child = spawn(process.execPath, [review, "--repo", "acme/app", "--pr", "42", "--interval", "5"], { env: { ...process.env, PATH: dir } })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    const code = await new Promise((resolve) => child.once("close", resolve))
    assert.equal(code, 0)
    const events = stdout.trim().split("\n").map(JSON.parse)
    assert.deepEqual(events.map((event) => [event.type, event.state]), [["status", "armed"], ["terminal", "new-human-activity"]])
    assert.deepEqual(events[1].ids, ["new"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("review errors and cancellation emit a terminal NDJSON event", async () => {
  const review = fileURLToPath(new URL("./review-watch.mjs", import.meta.url))
  const empty = mkdtempSync(join(tmpdir(), "fray-review-empty-"))
  try {
    const result = spawnSync(process.execPath, [review, "--repo", "acme/app", "--pr", "42", "--once"], { encoding: "utf8", env: { ...process.env, PATH: empty } })
    assert.equal(result.status, 3)
    assert.deepEqual(JSON.parse(result.stdout).state, "error")
  } finally { rmSync(empty, { recursive: true, force: true }) }

  const dir = fakeReviewGhDir()
  try {
    const child = spawn(process.execPath, [review, "--repo", "acme/app", "--pr", "42"], { env: { ...process.env, PATH: dir } })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    await waitFor(() => stdout.includes('"state":"armed"'))
    child.kill("SIGTERM")
    const code = await new Promise((resolve) => child.once("close", resolve))
    assert.equal(code, 130)
    assert.deepEqual(stdout.trim().split("\n").map(JSON.parse).filter((event) => event.type === "terminal").map((event) => event.state), ["cancelled"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("gh calls time out and back off without a platform shell timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-gh-timeout-"))
  const executable = join(dir, "gh")
  writeFileSync(executable, "#!/bin/sh\n/bin/sleep 2\n")
  chmodSync(executable, 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = dir
  try {
    await assert.rejects(gh(["api"], { attempts: 1, timeoutMs: 25 }), /timed out after 0\.025 seconds/)
  } finally {
    process.env.PATH = oldPath
    rmSync(dir, { recursive: true, force: true })
  }
})
