// Codex Phase-3 UI verification: drive the Settings drawer + composer to prove Model-first ordering,
// the two-section (Claude Code / Codex) model dropdown, and the permission/effort controls swapping
// when a Codex model is picked. Radix Select opens on a real pointer sequence that headless mouse
// clicks don't reproduce, so dropdowns are opened via keyboard (focus → Enter). Shots → /tmp/codex-shots.
import { mkdirSync } from "node:fs"
import puppeteer from "puppeteer"

const URL = "http://127.0.0.1:4917"
const OUT = "/tmp/codex-shots"
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const openSelect = async (page, aria) => {
  await page.evaluate((a) => document.querySelector(`button[aria-label="${a}"]`)?.focus(), aria)
  await page.keyboard.press("Enter")
  await sleep(500)
}
const pickOption = async (page, re) => {
  const picked = await page.evaluate((rs) => {
    const rx = new RegExp(rs)
    const el = [...document.querySelectorAll('[role="option"]')].find((e) => rx.test(e.textContent || ""))
    if (el) { el.click(); return el.textContent }
    return null
  }, re)
  await sleep(500)
  return picked
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 })
  await sleep(1500)

  // ---- Settings drawer: Model is the FIRST control ----
  await page.click('button[title="Settings"]')
  await sleep(1000)
  await page.screenshot({ path: `${OUT}/1-settings-model-first.png` })

  // Model dropdown open → the two sections (Claude Code / Codex).
  await openSelect(page, "Model")
  await page.screenshot({ path: `${OUT}/2-model-two-sections.png` })
  const modelOpts = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((e) => e.textContent))
  const sectionLabels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-radix-select-viewport] [role="group"] > :first-child')].map((e) => e.textContent).filter(Boolean),
  )

  // Pick a Codex model (GPT-5.5) → the dependent controls flip to Sandbox + codex effort set.
  const pickedModel = await pickOption(page, "GPT-5\\.5")
  await page.screenshot({ path: `${OUT}/3-settings-codex-swapped.png` })
  const afterPick = await page.evaluate(() => {
    const perm = document.querySelector('button[aria-label="Sandbox"], button[aria-label="Permission mode"]')
    return {
      model: document.querySelector('button[aria-label="Model"]')?.textContent,
      permAria: perm?.getAttribute("aria-label"),
      permText: perm?.textContent,
    }
  })

  // Codex sandbox options.
  await openSelect(page, "Sandbox")
  const sandboxOpts = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((e) => e.textContent))
  await page.screenshot({ path: `${OUT}/4-codex-sandbox-options.png` })
  await page.keyboard.press("Escape")
  await sleep(300)

  // Codex effort options (should be low/medium/high + Default only).
  await openSelect(page, "Effort")
  const codexEffortOpts = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((e) => e.textContent))
  await page.screenshot({ path: `${OUT}/5-codex-effort-options.png` })
  await page.keyboard.press("Escape")
  await sleep(300)

  // Switch back to a Claude model → controls revert to Permission mode + full effort set.
  await openSelect(page, "Model")
  const pickedClaude = await pickOption(page, "Sonnet")
  const afterClaude = await page.evaluate(() => {
    const perm = document.querySelector('button[aria-label="Sandbox"], button[aria-label="Permission mode"]')
    return { model: document.querySelector('button[aria-label="Model"]')?.textContent, permAria: perm?.getAttribute("aria-label") }
  })
  await page.screenshot({ path: `${OUT}/6-back-to-claude.png` })
  // Close settings without saving (Escape) so we don't mutate the live prefs.
  await page.keyboard.press("Escape")
  await sleep(400)

  // ---- Composer: open the New-thread modal, prove the same model-first grouped selector ----
  await page.keyboard.down("Meta"); await page.keyboard.press("KeyN"); await page.keyboard.up("Meta")
  await sleep(600)
  await page.screenshot({ path: `${OUT}/7-composer.png` })
  await openSelect(page, "Model")
  await page.screenshot({ path: `${OUT}/8-composer-model-sections.png` })
  const composerModelOpts = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((e) => e.textContent))
  await pickOption(page, "GPT-5\\.5")
  await sleep(300)
  await page.screenshot({ path: `${OUT}/9-composer-codex-swapped.png` })
  const composerAfter = await page.evaluate(() => {
    const perm = document.querySelector('button[aria-label="Sandbox"], button[aria-label="Permission mode"]')
    return { model: document.querySelector('button[aria-label="Model"]')?.textContent, permAria: perm?.getAttribute("aria-label"), permText: perm?.textContent }
  })

  console.log(JSON.stringify({ modelOpts, sectionLabels, pickedModel, afterPick, sandboxOpts, codexEffortOpts, pickedClaude, afterClaude, composerModelOpts, composerAfter, errors }, null, 2))
} finally {
  await browser.close()
}
