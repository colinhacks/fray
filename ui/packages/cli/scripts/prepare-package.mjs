import { cpSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, "..")
const ui = resolve(cli, "..", "..")
const webDist = resolve(ui, "packages/web/dist")
const target = resolve(cli, "web-dist")
execFileSync("pnpm", ["--dir", ui, "--filter", "@fray-ui/web", "build"], { stdio: "pipe" })
if (!existsSync(webDist)) throw new Error("Fray web build did not produce packages/web/dist")
rmSync(target, { recursive: true, force: true })
cpSync(webDist, target, { recursive: true })
