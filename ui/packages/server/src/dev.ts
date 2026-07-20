// Dev entry: a durable source watcher supervising a disposable API + Vite control-plane child.
// Run with `node packages/server/src/dev.ts` from ui/. Worker tmux sessions remain independent.
import { DEFAULT_PORT } from "@fray-ui/shared"
import { projectFromLaunchTarget, projectLaunchTarget, resolveProject } from "./project.ts"
import {
  acquireProjectLaunchOwner,
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"

if (process.env.FRAY_DEV_CHILD === "1") {
  const childTarget = projectLaunchTargetFromEnvironment(process.env)
  const childToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  if (!childTarget || !childToken) throw new Error("dev child is missing pinned project launch ownership")
  verifyProjectLaunchDelegate(childTarget, childToken)
  const { runDevControlPlaneChild } = await import("./dev-supervisor.ts")
  await runDevControlPlaneChild()
} else {
  const inheritedTarget = projectLaunchTargetFromEnvironment(process.env)
  const inheritedToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  const project = inheritedTarget && inheritedToken ? projectFromLaunchTarget(inheritedTarget) : resolveProject()
  const target = projectLaunchTarget(project)
  const launchOwner = inheritedToken
    ? adoptProjectLaunchOwner(target, inheritedToken, "supervisor")
    : acquireProjectLaunchOwner(target, "supervisor")
  const launchEnv = projectLaunchEnvironment(process.env, target, launchOwner.token)
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import("./dev-supervisor.ts")

  let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>
  try {
    supervisor = await startDevSupervisor({
      port: DEFAULT_PORT,
      cwd: project.dir,
      env: launchEnv,
      stateDir: project.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      childEntry: process.argv[1],
    })
    await supervisor.firstBoot
  } catch (error) {
    launchOwner.release()
    throw error
  }

  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    release: () => { launchOwner.release() },
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  void supervisor.stopRequested.then(stop)
}
