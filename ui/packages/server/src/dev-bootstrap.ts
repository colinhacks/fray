// Tiny generation bootstrap. Prove the delegated owner before importing the watcher/supervisor
// module, then validate that module as part of the disposable control-plane generation.
import {
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"

const target = projectLaunchTargetFromEnvironment(process.env)
const token = projectLaunchOwnerTokenFromEnvironment(process.env)
if (!target || !token) throw new Error("dev bootstrap is missing pinned project launch ownership")
verifyProjectLaunchDelegate(target, token)
const { runDevControlPlaneChild } = await import("./dev-supervisor.ts")
await runDevControlPlaneChild()
