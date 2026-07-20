import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_AGENT_ROW_INDICATORS_E2E_URL

// An agent row is the ONE card family with two independent status sources — its own stateLabel (which
// carries its own dot) and the shared right-hand meta slot — so it is the only one that can render the
// same fact twice. It shipped doing exactly that: a live child read "running 3 min ●" AND "● running",
// and a quiet child read the self-contradicting "stale ●running". Pin both halves of the rule here:
// a resolved child owns the row's status alone, and a dispatch with NO child record must still surface
// its terminal status/duration through the meta slot (the suppression must never eat that).
test("an agent row shows exactly one running indicator, and a child-less dispatch keeps its terminal status", {
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
  // The bare fixture page serves no favicon, so Chrome logs a 404 whose console text carries no URL.
  // Track the failing RESPONSE urls separately and exclude that one by path — precise enough to still
  // fail on any other missing resource, rather than blanket-ignoring every 404.
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1000, height: 1500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/operation-indicators-fixture.html`, { waitUntil: "networkidle0" })
    const rows = await page.$$eval("[data-agent-rows] .fray-bash", (cards) =>
      cards.map((card) => ({
        text: card.querySelector<HTMLElement>(".fray-bash-header")!.innerText.replace(/\s+/g, " ").trim(),
        indicators: card.querySelectorAll("[data-running-indicator]").length,
      })),
    )
    assert.equal(rows.length, 5, "the fixture must cover live/stale/finished/cancelled/failed agent rows")

    // A LIVE child: one dot, and the word "running" appears once — never doubled by the meta badge.
    assert.equal(rows[0].indicators, 1)
    assert.equal(rows[0].text.match(/running/g)?.length, 1)

    // A quiet child reads "stale" with no dot, and must NOT be contradicted by a "running" badge.
    assert.equal(rows[1].indicators, 0)
    assert.match(rows[1].text, /stale/)
    assert.doesNotMatch(rows[1].text, /running/)

    // A completed child: its own "finished Nm" is the sole status surface.
    assert.equal(rows[2].indicators, 0)
    assert.match(rows[2].text, /finished 3 min/)

    // No child record at all → the meta slot is the only status surface, so terminal state + duration
    // must still render. This is the regression the one-indicator rule must never cause.
    assert.equal(rows[3].indicators, 0)
    assert.match(rows[3].text, /cancelled/)
    assert.equal(rows[4].indicators, 0)
    assert.match(rows[4].text, /failed · 12 sec/)

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
