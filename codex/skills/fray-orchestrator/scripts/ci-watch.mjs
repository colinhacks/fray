#!/usr/bin/env node
import { classifyChecks, gh, latestWorkflowRuns, parseArgs, report, sleep } from "./github-watch.mjs"

const usage = "Usage: ci-watch.mjs --repo OWNER/REPO --pr NUMBER [--interval SECONDS] [--once]"

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2), usage) } catch (error) {
    process.stderr.write(`ci-watch: ${error instanceof Error ? error.message : String(error)}\n`)
    report("terminal", { kind: "ci", state: "error", error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 3
    return
  }
  if (options.help) return console.log(usage)
  let emittedTerminal = false
  const terminal = (state, exitCode) => {
    if (emittedTerminal) return
    emittedTerminal = true
    report("terminal", { kind: "ci", repo: options.repo, pr: options.pr, state })
    process.exitCode = exitCode
  }
  const cancelled = () => { terminal("cancelled", 130); process.exit(130) }
  process.once("SIGINT", cancelled)
  process.once("SIGTERM", cancelled)
  let previous
  for (;;) {
    try {
      const pr = JSON.parse(await gh(["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"]))
      const checks = JSON.parse(await gh(["pr", "checks", String(options.pr), "--repo", options.repo, "--json", "name,state,bucket,workflow,link"]))
      const runs = pr.headRefOid ? JSON.parse(await gh(["run", "list", "--repo", options.repo, "--commit", pr.headRefOid, "--limit", "100", "--json", "name,workflowName,status,conclusion,databaseId,event,createdAt"])) : []
      const workflows = latestWorkflowRuns(runs).map((run) => ({
        name: run.name,
        state: String(run.status).toUpperCase() === "COMPLETED" ? run.conclusion : run.status,
        workflow: run.event,
        link: run.databaseId ? `https://github.com/${options.repo}/actions/runs/${run.databaseId}` : undefined,
      }))
      const result = classifyChecks([...checks, ...workflows])
      const signature = JSON.stringify(result)
      if (signature !== previous) {
        if (result.state === "pending") report("status", { kind: "ci", repo: options.repo, pr: options.pr, ...result })
        else { emittedTerminal = true; report("terminal", { kind: "ci", repo: options.repo, pr: options.pr, ...result }) }
      }
      previous = signature
      if (result.state === "passed") process.exitCode = 0
      if (result.state === "failed") process.exitCode = 2
      if (result.state !== "pending" || options.once) return
    } catch (error) {
      process.stderr.write(`ci-watch: ${error instanceof Error ? error.message : String(error)}\n`)
      terminal("error", 3)
      return
    }
    await sleep(options.interval * 1000)
  }
}

main().catch((error) => {
  process.stderr.write(`ci-watch: ${error instanceof Error ? error.message : String(error)}\n`)
  report("terminal", { kind: "ci", state: "error", error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 3
})
