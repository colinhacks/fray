// Dev entry: the unified server (API + Vite middleware) on the default port for the repo the
// server is launched from. Run with `node packages/server/src/dev.ts` from ui/.
import { DEFAULT_PORT } from "@fray-ui/shared"
import { startServer } from "./index.ts"

startServer({ dev: true, port: DEFAULT_PORT })
