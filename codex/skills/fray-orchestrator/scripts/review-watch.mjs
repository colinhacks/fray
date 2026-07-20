#!/usr/bin/env node
import { gh, humanReviewActivity, parseArgs, report, sleep } from "./github-watch.mjs"

const usage = "Usage: review-watch.mjs --repo OWNER/REPO --pr NUMBER [--interval SECONDS] [--once]"
const QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(last:50){nodes{id author{login __typename}}} comments(last:50){nodes{id author{login __typename}}}}}}`

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2), usage) } catch (error) {
    process.stderr.write(`review-watch: ${error instanceof Error ? error.message : String(error)}\n`)
    report("terminal", { kind: "review", state: "error", error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 3
    return
  }
  if (options.help) return console.log(usage)
  const [owner, repo] = options.repo.split("/")
  if (!owner || !repo) throw new Error("--repo must be OWNER/REPO")
  let emittedTerminal = false
  const terminal = (state, exitCode, extra = {}) => {
    if (emittedTerminal) return
    emittedTerminal = true
    report("terminal", { kind: "review", repo: options.repo, pr: options.pr, state, ...extra })
    process.exitCode = exitCode
  }
  const cancelled = () => { terminal("cancelled", 130); process.exit(130) }
  process.once("SIGINT", cancelled)
  process.once("SIGTERM", cancelled)
  let baseline
  for (;;) {
    try {
      const raw = JSON.parse(await gh(["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${options.pr}`]))
      const current = humanReviewActivity(raw)
      if (!baseline) {
        baseline = current
        report("status", { kind: "review", repo: options.repo, pr: options.pr, state: "armed", seen: current.size })
      } else {
        const added = [...current].filter((id) => !baseline.has(id))
        if (added.length) { terminal("new-human-activity", 0, { ids: added }); return }
      }
      if (options.once) return
    } catch (error) {
      process.stderr.write(`review-watch: ${error instanceof Error ? error.message : String(error)}\n`)
      terminal("error", 3)
      return
    }
    await sleep(options.interval * 1000)
  }
}

main().catch((error) => {
  process.stderr.write(`review-watch: ${error instanceof Error ? error.message : String(error)}\n`)
  report("terminal", { kind: "review", state: "error", error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 3
})
