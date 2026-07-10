// Ephemeral verification server: a fresh fray-ui instance on a test port (default 4919), serving the
// CURRENT source (incl. the new GitHub RPC endpoints) so the orchestrator can drive an end-to-end
// visual pass without touching the maintainer's live instance. Wakers OFF (no scheduler side effects).
// cwd must be ui/ (its git toplevel = the fray repo → project = colinhacks/fray, a gh-authed repo).
import { startServer } from "../packages/server/src/index.ts"

startServer({ dev: true, port: Number(process.env.PORT) || 4919 })
