// Disposable dev control-plane child. The long-lived supervisor forks this process and replaces it
// whenever server/shared/RPC source changes. Claude/Codex workers remain in their independent tmux
// server; this process owns only Fray's HTTP/Vite/watch/tailer/storage handles.
import { projectFromLaunchTarget } from "./project.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  currentProcessGeneration,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"
import { ShutdownTimeoutError } from "./shutdown.ts"

const rawPort = process.env.FRAY_DEV_PORT
const port = Number(rawPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[fray-ui] invalid FRAY_DEV_PORT for dev child: ${rawPort ?? "<unset>"}`)
  process.exit(1)
}

try {
  const target = projectLaunchTargetFromEnvironment(process.env)
  const launchOwnerToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  if (!target || !launchOwnerToken) throw new Error("dev child is missing pinned project launch ownership")
  verifyProjectLaunchDelegate(target, launchOwnerToken)
  const { startServer } = await import("./index.ts")
  const project = projectFromLaunchTarget(target)
  const stableWebDist = process.env.FRAY_STABLE_WEB_DIST
  const stableArtifact = process.env.FRAY_STABLE_ARTIFACT
  if (stableArtifact && !stableWebDist)
    throw new Error("stable artifact launch is missing FRAY_STABLE_WEB_DIST")
  if (stableWebDist) {
    const required = [
      ["FRAY_WORKER_PROMPT_DIR", process.env.FRAY_WORKER_PROMPT_DIR, "WORKER_PROMPT.md"],
      ["FRAY_SCRIPTS_DIR", process.env.FRAY_SCRIPTS_DIR, "index.mjs"],
      ["FRAY_WORKER_PLUGIN_DIR", process.env.FRAY_WORKER_PLUGIN_DIR, ".claude-plugin/plugin.json"],
    ] as const
    if (!existsSync(stableWebDist)) throw new Error("stable artifact launch is missing its verified web directory")
    for (const [name, directory, requiredFile] of required) {
      if (!directory || !existsSync(join(directory, requiredFile)))
        throw new Error(`stable artifact launch is missing verified ${name}`)
    }
  }
  const server = await startServer({
    dev: !stableWebDist,
    port,
    installSignalHandlers: false,
    requireDevWeb: !stableWebDist,
    ...(stableWebDist ? { webDistDir: stableWebDist } : {}),
    project,
    launchOwnerToken,
    requestOwnerStop: () => process.send?.({ type: "fray-stop-owner", token: launchOwnerToken }),
  })
  process.send?.({
    type: "fray-ready",
    ...currentProcessGeneration(),
    port: server.port,
    bootId: server.ctx.bootId,
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    const force = setTimeout(() => process.exit(1), 15_000)
    force.unref()
    try {
      await server.close()
      process.exit(0)
    } catch (err) {
      // close() reports its bounded public deadline while the shutdown fence continues draining.
      // Do not turn that diagnostic into an immediate process exit: doing so repeatedly kills clean
      // late drains and makes the supervisor log a misleading restart storm.
      if (err instanceof ShutdownTimeoutError) {
        console.warn(`[fray-ui] dev child shutdown exceeded ${err.timeoutMs}ms; retaining ownership while the drain completes`)
        try {
          await server.shutdownFence.whenSafe()
          process.exit(0)
          return
        } catch (drainError) {
          console.error(`[fray-ui] dev child late shutdown drain failed: ${drainError instanceof Error ? drainError.stack ?? drainError.message : drainError}`)
        }
      }
      console.error(`[fray-ui] dev child shutdown failed: ${err instanceof Error ? err.stack ?? err.message : err}`)
      process.exit(1)
    }
  }

  // Keep the guard installed for repeated same-kind signals so they cannot restore Node's default
  // immediate termination while the server's bounded shutdown barrier is draining.
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  // A crashed/killed supervisor must not leave an unsupervised control plane behind.
  process.once("disconnect", () => void shutdown())
} catch (err) {
  console.error(`[fray-ui] dev child failed to start: ${err instanceof Error ? err.stack ?? err.message : err}`)
  process.exit(1)
}
