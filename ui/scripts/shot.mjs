// Headless screenshot + in-page evaluate loop for iterating on the fray-ui UI.
// No chrome-devtools MCP this session, so we drive puppeteer directly (it resolves the cached Chrome
// under ~/.cache/puppeteer). This is the visual-review loop: screenshot + evaluate_script routines
// (occlusion/clip/alignment/optical-center) against the live app.
//
// Usage:
//   node ui/scripts/shot.mjs <url> [out.png] [evalExprOr@file] [--w=1440] [--h=900] [--wait=1500]
//   evalExpr: a JS expression string evaluated in page context (completion value → printed as JSON).
//   @file:    read the expression from a file (e.g. an occlusion routine).
import { readFileSync } from "node:fs"
import puppeteer from "puppeteer"

const args = process.argv.slice(2)
const pos = args.filter((a) => !a.startsWith("--"))
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const [url, out, evalArg] = pos
const W = Number(flags.w) || 1440
const H = Number(flags.h) || 900
const WAIT = Number(flags.wait) || 1500

if (!url) {
  console.error("usage: node shot.mjs <url> [out.png] [evalExprOr@file] [--w=] [--h=] [--wait=]")
  process.exit(1)
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 })
  const errors = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, WAIT)) // let the SSE board render
  if (out) {
    await page.screenshot({ path: out, fullPage: false })
    console.error("shot ->", out)
  }
  if (evalArg) {
    const expr = evalArg.startsWith("@") ? readFileSync(evalArg.slice(1), "utf8") : evalArg
    const res = await page.evaluate(expr)
    console.log(JSON.stringify(res, null, 2))
  }
  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"))
} finally {
  await browser.close()
}
