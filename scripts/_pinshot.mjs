import puppeteer from "puppeteer"
const [url, out, scrollY] = process.argv.slice(2)
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox","--force-color-profile=srgb"] })
const p = await b.newPage()
await p.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 })
await p.goto(url, { waitUntil: "networkidle0" })
await new Promise(r => setTimeout(r, 1200))
await p.evaluate((y) => window.scrollTo(0, Number(y)), scrollY)
await new Promise(r => setTimeout(r, 400))
const box = await p.evaluate(() => {
  const h = document.querySelector('[data-queue-card-root] .sticky')
  const r = h.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width }
})
// frame like the user's crop: from just left/above the header corner
await p.screenshot({ path: out, clip: { x: box.x - 34, y: Math.max(0, box.y - 8), width: 134, height: 71 } })
await b.close()
console.log("shot ->", out, JSON.stringify(box))
