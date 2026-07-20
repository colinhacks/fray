import assert from "node:assert/strict"
import test from "node:test"

// Opt-in because this drives a real Fray server and Chrome. The live seam is intentional: the
// regression came from Radix's portal/focus/outside-pointer side effects, which SSR cannot observe.
const baseUrl = process.env.FRAY_MENU_E2E_URL
const threadSlug = process.env.FRAY_MENU_E2E_SLUG

test("Snooze menu stays non-modal and preserves anchored menu interactions", {
  skip: !baseUrl || !threadSlug,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))

  const cardSelector = `[data-queue-card="${threadSlug}"]`
  const triggerSelector = `${cardSelector} button[aria-label="Snooze options"]`

  async function openMenu(selector = triggerSelector): Promise<void> {
    await page.focus(selector)
    await page.keyboard.press("Enter")
    await page.waitForSelector('[role="menu"]')
  }

  async function expectNonModalRoot(): Promise<void> {
    assert.deepEqual(await page.evaluate(() => {
      const root = document.querySelector("#root")
      return {
        pointerEvents: document.body.style.pointerEvents,
        ariaHidden: root?.getAttribute("aria-hidden") ?? null,
        dataAriaHidden: root?.getAttribute("data-aria-hidden") ?? null,
      }
    }), {
      pointerEvents: "",
      ariaHidden: null,
      dataAriaHidden: null,
    })
  }

  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector(triggerSelector)

    const asideBefore = await page.$eval("aside", (aside) => {
      const rect = aside.getBoundingClientRect()
      return { left: rect.left, width: rect.width, visibility: getComputedStyle(aside).visibility }
    })
    await openMenu()
    await expectNonModalRoot()
    const desktopOpen = await page.evaluate((selector) => {
      const aside = document.querySelector("aside")!
      const rect = aside.getBoundingClientRect()
      return {
        aside: { left: rect.left, width: rect.width, visibility: getComputedStyle(aside).visibility },
        expanded: document.querySelector(selector)?.getAttribute("aria-expanded"),
        focusInsideMenu: Boolean(document.querySelector('[role="menu"]')?.contains(document.activeElement)),
      }
    }, triggerSelector)
    assert.deepEqual(desktopOpen.aside, asideBefore)
    assert.equal(desktopOpen.expanded, "true")
    assert.equal(desktopOpen.focusInsideMenu, true)

    // A real outside pointer target must receive the same click that dismisses the menu.
    await page.evaluate(() => {
      const target = document.createElement("button")
      target.id = "menu-outside-probe"
      target.textContent = "outside probe"
      target.style.position = "fixed"
      target.style.left = "0"
      target.style.bottom = "0"
      target.addEventListener("click", () => target.dataset.clicked = "true")
      document.body.append(target)
    })
    await page.click("#menu-outside-probe")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    assert.equal(await page.$eval("#menu-outside-probe", (target) => target.getAttribute("data-clicked")), "true")

    // Escape closes only the menu and returns focus to its trigger.
    await openMenu()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      { polling: 50, timeout: 5_000 },
      triggerSelector,
    )

    // Compact layout keeps the menu within the viewport without making the page behind it modal.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), triggerSelector)
    await openMenu()
    await expectNonModalRoot()
    const compactRect = await page.$eval('[role="menu"]', (menu) => {
      const rect = menu.getBoundingClientRect()
      return { left: rect.left, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    assert.ok(compactRect.left >= 0)
    assert.ok(compactRect.right <= compactRect.viewportWidth)
    assert.ok(compactRect.bottom <= compactRect.viewportHeight)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))

    // In the mobile drawer, one Escape belongs to the menu; the actual modal drawer stays open.
    await page.click(`${cardSelector} button[aria-label="Open thread"]`)
    await page.waitForSelector('[role="dialog"][aria-modal="true"]')
    const drawerTrigger = '[role="dialog"] button[aria-label="Snooze options"]'
    await openMenu(drawerTrigger)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    assert.ok(await page.$('[role="dialog"][aria-modal="true"]'))
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      { polling: 50, timeout: 5_000 },
      drawerTrigger,
    )

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
