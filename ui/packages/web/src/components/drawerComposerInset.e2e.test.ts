import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_DRAWER_COMPOSER_INSET_E2E_URL

test("thread drawer keeps the prompt box inset evenly while safe-area padding stays below lifecycle actions", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/drawer-composer-footer-fixture.html`, { waitUntil: "networkidle0" })
    const inset = await page.$eval("[data-thread-action-bar]", (actionBar) => {
      const composer = actionBar.querySelector<HTMLElement>("[data-surface=drawerFooterFixture]")?.closest<HTMLElement>(".group")
      const lifecycle = document.querySelector<HTMLElement>("[data-thread-lifecycle-footer]")
      const chatFooter = document.querySelector<HTMLElement>("[data-thread-chat-footer]")
      if (!composer || !lifecycle || !chatFooter) throw new Error("drawer footer fixture is incomplete")
      const bar = actionBar.getBoundingClientRect()
      const box = composer.getBoundingClientRect()
      const lifecycleStyle = getComputedStyle(lifecycle)
      const chatFooterStyle = getComputedStyle(chatFooter)
      return {
        top: box.top - bar.top,
        right: bar.right - box.right,
        bottom: bar.bottom - box.bottom,
        left: box.left - bar.left,
        chatFooterBottom: chatFooterStyle.paddingBottom,
        lifecycleBottom: lifecycleStyle.paddingBottom,
      }
    })
    assert.deepEqual([inset.top, inset.right, inset.bottom, inset.left], [12, 12, 12, 12])
    assert.equal(inset.chatFooterBottom, "0px")
    assert.ok(Number.parseFloat(inset.lifecycleBottom) >= 8, "safe-area floor belongs below lifecycle actions")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
