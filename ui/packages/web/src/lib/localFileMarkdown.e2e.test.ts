import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_LOCAL_FILE_MARKDOWN_E2E_URL

test("Markdown local image syntax uses the gated image proxy and local files remain app actions", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (request.url().includes("/local-image?path=%2Ffixture%2Fshot.png")) {
        void request.respond({ status: 200, contentType: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") })
      } else {
        void request.continue()
      }
    })
    await page.goto(`${baseUrl}/local-file-opener-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[data-local-path="/fixture/report.md"]')
    const rendered = await page.$eval(".md-body", (node) => ({
      button: node.querySelector("button")?.getAttribute("data-local-path"),
      imageSrc: node.querySelector("img")?.getAttribute("src"),
      imagePath: node.querySelector("img")?.getAttribute("data-local-path"),
      imageAlt: node.querySelector("img")?.getAttribute("alt"),
    }))
    assert.deepEqual(rendered, {
      button: "/fixture/report.md",
      imageSrc: "/local-image?path=%2Ffixture%2Fshot.png",
      imagePath: "/fixture/shot.png",
      imageAlt: "descriptive alt",
    })
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
