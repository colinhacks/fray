import { spawn } from "node:child_process"

export const PROTOCOL = "fray.github-monitor/v1"
const SUCCESS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"])
const FAILURE = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"])
export const GH_TIMEOUT_MS = 30_000
const GH_ATTEMPTS = 3

export function classifyChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return { state: "pending", checks: [] }
  let failed = false
  let pending = false
  for (const check of checks) {
    const state = String(check?.state ?? check?.bucket ?? "").toUpperCase()
    // A fork-gated workflow is reported as ACTION_REQUIRED after its skipped run completes. It is
    // not CI success: continue watching for an approved replacement run instead of waking green.
    if (state.includes("ACTION_REQUIRED") || state === "PENDING" || state === "QUEUED" || state === "IN_PROGRESS" || state === "WAITING") pending = true
    else if (FAILURE.has(state) || state.includes("FAIL")) failed = true
    else if (!SUCCESS.has(state) && state !== "PASS") pending = true
  }
  return { state: failed ? "failed" : pending ? "pending" : "passed", checks }
}

export function humanReviewActivity(raw) {
  const pr = raw?.data?.repository?.pullRequest
  const nodes = [...(pr?.reviews?.nodes ?? []), ...(pr?.comments?.nodes ?? [])]
  return new Set(nodes
    .filter((node) => node?.author?.__typename !== "Bot" && !String(node?.author?.login ?? "").endsWith("[bot]"))
    .map((node) => String(node.id))
    .filter(Boolean))
}

export function latestWorkflowRuns(runs) {
  const latest = new Map()
  for (const run of runs ?? []) {
    const key = `${run.workflowName ?? run.name ?? "unknown"}\u0000${run.event ?? ""}`
    const old = latest.get(key)
    const stamp = String(run.createdAt ?? "")
    const oldStamp = String(old?.createdAt ?? "")
    const id = Number(run.databaseId ?? 0)
    const oldId = Number(old?.databaseId ?? 0)
    if (!old || stamp > oldStamp || (stamp === oldStamp && id > oldId)) latest.set(key, run)
  }
  return [...latest.values()]
}

function ghOnce(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn("gh", args, {
      env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // A separate process group lets POSIX hosts terminate a hung credential helper too. Windows
      // uses ChildProcess.kill below; both paths remain Node-only and need no `timeout` utility.
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let stderr = ""
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const kill = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, signal); return } catch { /* child may already be gone */ }
      }
      child.kill(signal)
    }
    const timeout = setTimeout(() => {
      kill("SIGTERM")
      // Some broken credential helpers ignore SIGTERM. Do not let one wedged gh process hold a
      // monitor forever; a second, portable child-process kill keeps the watch bounded.
      setTimeout(() => kill("SIGKILL"), 1_000).unref()
      fail(new Error(`gh timed out after ${timeoutMs / 1000} seconds`))
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", (error) => { clearTimeout(timeout); fail(error) })
    child.once("close", (status) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true
      if (status !== 0) reject(new Error(stderr.trim() || `gh exited ${status ?? "without a status"}`))
      else resolve(stdout)
    })
  })
}

export async function gh(args, { attempts = GH_ATTEMPTS, timeoutMs = GH_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("gh attempts must be a positive integer")
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("gh timeout must be positive")
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await ghOnce(args, timeoutMs) } catch (error) { lastError = error }
    // A short bounded backoff covers transient GitHub and credential-helper failures. The final
    // failure remains a terminal monitor error rather than an unbounded retry loop.
    if (attempt + 1 < attempts) await sleep(250 * 2 ** attempt)
  }
  throw lastError
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseArgs(argv, usage) {
  const out = { interval: 60, once: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help") return { help: true }
    if (arg === "--once") out.once = true
    else if (arg === "--repo" || arg === "--pr" || arg === "--interval") out[arg.slice(2)] = argv[++i]
    else throw new Error(`Unknown argument: ${arg}\n${usage}`)
  }
  if (!out.repo || !out.pr) throw new Error(usage)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(out.repo)) throw new Error("--repo must be OWNER/REPO")
  if (!/^\d+$/.test(String(out.pr)) || Number(out.pr) < 1) throw new Error("--pr must be a positive number")
  out.interval = Number(out.interval)
  if (!Number.isFinite(out.interval) || out.interval < 5) throw new Error("--interval must be at least 5 seconds")
  return out
}

// Every stdout line is one schema-versioned NDJSON event. A monitor may emit many status events
// but exactly one terminal event when it reaches a terminal verdict. Exit codes: passed/new activity
// 0, CI failure 2, invocation/GitHub error 3. `--once` may end after a non-terminal snapshot with 0.
export function report(type, value) {
  if (type !== "status" && type !== "terminal") throw new Error(`invalid monitor event type: ${type}`)
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, type, at: new Date().toISOString(), ...value })}\n`)
}
