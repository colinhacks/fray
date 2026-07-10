/**
 * Browser detection and app-mode launcher.
 * Vendored from @gluon-framework/gluon (MIT), adapted for gent.
 * Supports Chromium-based and Firefox-based browsers on macOS, Linux, and Windows.
 */

import { spawn, execFile } from "node:child_process"
import { access, readdir, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, delimiter, sep, basename } from "node:path"

// ---- Browser path registry ----

type BrowserPaths = Record<string, string | string[]>

const browserPaths: BrowserPaths | undefined = ({
  win32: process.platform === "win32" && {
    chrome: [
      join("Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.USERPROFILE ?? "", "scoop", "apps", "googlechrome", "current", "chrome.exe"),
    ],
    chrome_canary: join("Google", "Chrome SxS", "Application", "chrome.exe"),
    chromium: [
      join("Chromium", "Application", "chrome.exe"),
      join(process.env.USERPROFILE ?? "", "scoop", "apps", "chromium", "current", "chrome.exe"),
    ],
    edge: join("Microsoft", "Edge", "Application", "msedge.exe"),
    brave: join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    vivaldi: join("Vivaldi", "Application", "vivaldi.exe"),
    thorium: join("Thorium", "Application", "thorium.exe"),
    firefox: [
      join("Mozilla Firefox", "firefox.exe"),
      join(process.env.USERPROFILE ?? "", "scoop", "apps", "firefox", "current", "firefox.exe"),
    ],
    firefox_developer: join("Firefox Developer Edition", "firefox.exe"),
    firefox_nightly: join("Firefox Nightly", "firefox.exe"),
    librewolf: join("LibreWolf", "librewolf.exe"),
    waterfox: join("Waterfox", "waterfox.exe"),
  },

  linux: {
    chrome: ["chrome", "google-chrome", "chrome-browser", "google-chrome-stable"],
    chrome_canary: ["chrome-canary", "google-chrome-canary"],
    chromium: ["chromium", "chromium-browser"],
    edge: ["microsoft-edge", "microsoft-edge-stable"],
    brave: ["brave", "brave-browser"],
    vivaldi: ["vivaldi", "vivaldi-browser"],
    thorium: ["thorium", "thorium-browser"],
    firefox: ["firefox", "firefox-browser"],
    firefox_nightly: ["firefox-nightly"],
    librewolf: ["librewolf", "librewolf-browser"],
    waterfox: ["waterfox", "waterfox-browser"],
  },

  darwin: {
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chrome_canary: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    vivaldi: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    thorium: "/Applications/Thorium.app/Contents/MacOS/Thorium",
    firefox: "/Applications/Firefox.app/Contents/MacOS/firefox",
    firefox_nightly: "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    librewolf: "/Applications/LibreWolf.app/Contents/MacOS/librewolf",
    waterfox: "/Applications/Waterfox.app/Contents/MacOS/waterfox",
  },
} as Record<string, BrowserPaths | false>)[process.platform] || undefined

// Windows: prepend standard install directories
if (process.platform === "win32" && browserPaths) {
  for (const browser in browserPaths) {
    const val = browserPaths[browser]!
    const isArray = Array.isArray(val)
    const basePath = isArray ? val[0] : val
    if (!basePath) continue
    browserPaths[browser] = [
      join(process.env.PROGRAMFILES ?? "", basePath),
      join(process.env.LOCALAPPDATA ?? "", basePath),
      join(process.env["PROGRAMFILES(X86)"] ?? "", basePath),
      ...(isArray ? val.slice(1) : []),
    ]
  }
}

// ---- Path existence checks ----

let _binariesInPath: string[] | undefined
async function getBinariesInPath(): Promise<string[]> {
  if (_binariesInPath) return _binariesInPath
  _binariesInPath = (
    await Promise.all(
      (process.env.PATH ?? "")
        .replaceAll('"', "")
        .split(delimiter)
        .filter(Boolean)
        .map((x) => readdir(x.replace(/"+/g, "")).catch(() => []))
    )
  ).flat()
  return _binariesInPath
}

async function pathExists(path: string): Promise<boolean> {
  if (path.includes(sep)) return access(path).then(() => true).catch(() => false)
  return (await getBinariesInPath()).includes(path)
}

async function getBrowserPath(browser: string): Promise<string | null> {
  if (!browserPaths) return null
  const paths = browserPaths[browser]
  if (!paths) return null
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    if (await pathExists(p)) return p
  }
  return null
}

// ---- Browser type detection ----

export type BrowserType = "chromium" | "firefox"

function getBrowserType(name: string): BrowserType {
  if (name.startsWith("firefox") || ["librewolf", "waterfox"].includes(name)) return "firefox"
  return "chromium"
}

// ---- Find best available browser ----

export async function findBrowser(
  forceBrowser?: string
): Promise<{ path: string; name: string; type: BrowserType } | null> {
  if (!browserPaths) return null

  if (forceBrowser) {
    const path = await getBrowserPath(forceBrowser)
    if (path) return { path, name: forceBrowser, type: getBrowserType(forceBrowser) }
    return null
  }

  for (const name in browserPaths) {
    const path = await getBrowserPath(name)
    if (path) return { path, name, type: getBrowserType(name) }
  }

  return null
}

// ---- Launch browser in app mode ----

export async function launchApp(
  url: string,
  opts: { windowSize?: [number, number]; dataPath?: string } = {}
): Promise<void> {
  const { windowSize = [1400, 900], dataPath } = opts
  const browser = await findBrowser()

  if (!browser) {
    throw new Error("No supported browser found for --app mode")
  }

  if (browser.type === "chromium") {
    // macOS Dock identity: a plain `--app=<url>` window is hosted by the Chrome browser process, so
    // the Dock always shows "Google Chrome" (verified empirically — a self-authored shim .app that
    // exec's Chrome loses the same way: exec replaces the process image and CFBundle then resolves
    // Google Chrome.app). The only mechanism that yields an own Dock name+icon is Chrome's app-shim
    // (the bundle Chrome generates in ~/Applications/Chrome Apps.localized when the PWA is
    // installed). We make that hands-free: a one-time CDP-over-pipe PWA.install into this project's
    // profile, then every launch goes through the shim. Any failure falls back to plain `--app`.
    if (process.platform === "darwin" && dataPath) {
      // Launch the shim bundle itself (what the Dock/Finder would do). The shim's app_mode_loader
      // is a universal Mach-O, so LaunchServices runs it native arm64 (verified: LSArchitecture=
      // arm64); it boots Chrome on this profile by itself when Chrome isn't running, and that Chrome
      // holds the "Fray" identity (own Dock tile/icon) for the window's lifetime.
      const shim = await ensureAppShim(browser.path, url, dataPath)
      // `open` is fire-and-forget and CAN silently no-op: a still-live register-only instance can
      // swallow it (LaunchServices "activates" the running instance instead of launching), the shim
      // can boot no window, or `open` can error. openShimVerified confirms a hosting Chrome actually
      // materializes on this profile; if it doesn't, fall through to plain --app so a launch is NEVER
      // a silent no-op.
      if (shim && (await openShimVerified(shim, dataPath))) return
    }
    launchChromium(browser.path, url, windowSize, dataPath)
  } else {
    await launchFirefox(browser.path, url, windowSize, dataPath)
  }
}

// ---- Chromium app-shim (macOS Dock identity) ----
//
// All of this is empirically verified on macOS + Chrome 150 (2026-07). The interesting findings:
//  · The CDP `PWA` domain (PWA.install / PWA.changeAppUserSettings / …) is only exposed to clients
//    with AllowUnsafeOperations() — which is true for --remote-debugging-pipe connections and FALSE
//    for --remote-debugging-port websockets (chrome_devtools_session.cc gates the handler). So: pipe.
//  · PWA.install(manifestId, installUrl) generates the shim bundle, but defaults the app's *user
//    display mode* to "open in a browser tab" — launching then answers the shim kSuccessAndDisconnect
//    (no host) and the window stays Chrome-branded. PWA.changeAppUserSettings(displayMode:
//    "standalone") is the missing half; after it the shim hosts the window under its own identity.
//  · Chrome's generated app id is NOT reproducible as crx-id(SHA-256(start_url)) (tried; mismatch),
//    so we never compute ids — the shim's Info.plist (CrAppModeShortcutURL / CrAppModeUserDataDir /
//    CrAppModeShortcutID) is the source of truth for detection.
//  · Bundle NAME: the .app filename and CFBundleName are both the manifest `name` verbatim
//    (verified: name "Fray" → Fray.app, CFBundleName "Fray"). EXPECTED_BUNDLE_NAME must therefore
//    track packages/web/public/manifest.webmanifest `name`. findAppShim matches on URL + data-dir
//    (NOT name), so a bundle installed under an old name keeps launching under it forever — we
//    treat a CFBundleName mismatch as a STALE shim and reinstall (self-heals a manifest rename).
//  · SUCCESS SENTINEL: PWA.install and the standalone flip are two separate CDP calls; if install
//    lands but the flip doesn't, the bundle exists in open-in-a-tab mode and would brand every
//    window as Chrome forever (findAppShim would keep matching it). So after — and only after —
//    changeAppUserSettings(standalone) succeeds we drop a `<dataPath>/.fray-pwa-standalone` marker.
//    A found shim is trusted only if that marker exists; a shim without it is a POISONED partial
//    install and is reinstalled (see ensureAppShim). Both staleness conditions share one heal path.
//  · FIRST-RUN seeding: a shim launch boots Chrome ITSELF, so our --no-first-run/--no-default-
//    browser-check flags never apply — a freshly-installed profile (the CDP install writes NO "First
//    Run" sentinel) shows the "Welcome to Chrome"/make-default UI on the first shim launch. We seed
//    the "First Run" sentinel (and additively turn off the default-browser check) into the profile at
//    launch time so shim boots are clean; this also self-heals profiles installed before this fix.

// NOTE (fragility): this hard-codes Chrome's macOS shim directory. Chrome writes generated app
// bundles to "~/Applications/Chrome Apps.localized" — an undocumented, product-name-derived path.
// A Chromium channel/fork with a different app-shortcuts dir (or a future Chrome rename) silently
// breaks detection here; ensureAppShim then always reinstalls / falls back to plain --app.
const CHROME_APPS_DIR = join(homedir(), "Applications", "Chrome Apps.localized")

// Must equal the manifest `name` (packages/web/public/manifest.webmanifest) — the string Chrome
// stamps verbatim into the generated bundle's CFBundleName AND the .app filename (verified). Kept
// here (not fetched from the manifest) because this launcher only ever has the origin URL, not the
// manifest body — so KEEP THESE TWO IN LOCKSTEP: renaming the app means editing both, and the
// mismatch drives the stale-shim reinstall that migrates an already-installed bundle to the new name.
const EXPECTED_BUNDLE_NAME = "Fray"

// The file that marks a shim install as fully completed (bundle generated AND flipped to standalone).
const STANDALONE_SENTINEL = ".fray-pwa-standalone"

function manifestIdFor(url: string): string {
  // The web manifest declares `"id": "/"`, which resolves to origin + "/". This assumes callers pass
  // a BARE ORIGIN URL (scheme://host:port, no path) — the coupling lives at index.ts:75, which hands
  // us `http://127.0.0.1:<port>`. A URL carrying a path would compute the wrong manifest id and never
  // match the installed shim. Keep the two in lockstep.
  return url.endsWith("/") ? url : `${url}/`
}

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 10_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  })
}

// Find the Chrome-generated shim bundle for THIS app (url) in THIS project profile (dataPath) by
// scanning shim Info.plists. Stateless on purpose: it self-heals across uninstalls, regenerated
// bundles, and URL/port drift (no match → reinstall). Matches on URL + data-dir (NOT the bundle
// name), so a bundle installed under an old manifest name still matches — the caller compares
// bundleName to catch that. Returns { path, bundleName } or null.
async function findAppShim(
  url: string,
  dataPath: string
): Promise<{ path: string; bundleName: string } | null> {
  const manifestId = manifestIdFor(url)
  const bundles = await readdir(CHROME_APPS_DIR).catch(() => [] as string[])
  for (const name of bundles) {
    if (!name.endsWith(".app")) continue
    const plist = join(CHROME_APPS_DIR, name, "Contents", "Info.plist")
    try {
      // plutil ships with macOS; -convert json handles xml and binary plists alike.
      const info = JSON.parse(await execFileP("plutil", ["-convert", "json", "-o", "-", plist])) as {
        CFBundleName?: string
        CrAppModeShortcutURL?: string
        CrAppModeUserDataDir?: string
      }
      if (
        info.CrAppModeShortcutURL === manifestId &&
        info.CrAppModeUserDataDir?.startsWith(dataPath + sep)
      ) {
        return { path: join(CHROME_APPS_DIR, name), bundleName: info.CFBundleName ?? "" }
      }
    } catch {
      // unreadable/foreign bundle — skip
    }
  }
  return null
}

// pgrep -f matches its pattern as an EXTENDED REGULAR EXPRESSION, so regex-special chars in a
// filesystem path (the dots in ".localized"/".app"/".fray", "+", parens, …) would otherwise match
// too loosely and risk false hits. Escape them so the path matches as a literal substring.
function escapeERE(s: string): string {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")
}

// True if any process command line contains `pattern` (matched literally). "--" ends option parsing
// since patterns can start with dashes. pgrep exits 1 on no match → false.
async function pgrepMatches(pattern: string): Promise<boolean> {
  try {
    const out = await execFileP("pgrep", ["-f", "--", escapeERE(pattern)])
    return out.trim().length > 0
  } catch {
    return false
  }
}

// True when some Chrome instance already runs on this user-data-dir. In that case a fresh spawn just
// forwards to it and exits, so the CDP pipe would never hand-shake — skip the install this launch.
// It is also the "a window is materializing" signal after `open` (the shim boots Chrome on the
// profile to host the window; a register-only instance never does).
async function profileInUse(dataPath: string): Promise<boolean> {
  return pgrepMatches(`--user-data-dir=${dataPath}`)
}

// A --remote-debugging-pipe CDP session on a project profile: Chrome spawned windowless with
// fd3=commands / fd4=responses (NUL-delimited JSON). `call()` issues a method and awaits its reply;
// `close()` shuts Chrome down cleanly (flushing the registrar + AppShimRegistry) and waits for the
// process to exit so profile locks release; `kill()` is the hard stop for the error path.
type CdpSession = {
  call: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>
  close: () => Promise<void>
  kill: () => void
}

function openCdpSession(browserPath: string, dataPath: string): CdpSession {
  const child = spawn(
    browserPath,
    [
      `--user-data-dir=${dataPath}`,
      "--remote-debugging-pipe",
      "--no-startup-window",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  )
  const cmdPipe = child.stdio[3] as import("node:stream").Writable
  const resPipe = child.stdio[4] as import("node:stream").Readable

  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let buf = Buffer.alloc(0)
  resPipe.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    let nul
    while ((nul = buf.indexOf(0)) !== -1) {
      const raw = buf.subarray(0, nul).toString("utf8")
      buf = buf.subarray(nul + 1)
      try {
        const msg = JSON.parse(raw) as { id?: number; error?: { message: string }; result?: unknown }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        }
      } catch {
        // non-JSON noise on the pipe — ignore
      }
    }
  })
  // Route async failures (spawn error, broken pipe, Chrome dying mid-handshake) into the awaited
  // call chain so callers' try/catch can fall back — an unhandled 'error' event on the child or a
  // pipe would otherwise throw as an uncaughtException (past the try/catch), and a clean death with
  // no 'error' would leave every pending call hanging until its full timeout.
  const failAll = (e: Error) => {
    for (const [, p] of pending) p.reject(e)
    pending.clear()
  }
  child.on("error", failAll)
  cmdPipe.on("error", failAll)
  resPipe.on("error", failAll)
  child.on("exit", () => failAll(new Error("chrome exited before the CDP handshake completed")))
  const call = (method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      cmdPipe.write(JSON.stringify({ id, method, params }) + "\0")
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`${method}: timed out`))
        }
      }, timeoutMs).unref()
    })
  const close = async () => {
    // Tolerate a close/exit race: if Browser.close makes Chrome exit before it answers, failAll
    // rejects the pending call — that must NOT discard an otherwise-successful operation.
    await call("Browser.close").catch(() => {})
    if (child.exitCode !== null || child.signalCode !== null) return // already gone
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill()
        resolve()
      }, 10_000)
      t.unref()
      child.once("exit", () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
  return { call, close, kill: () => child.kill() }
}

// One-time, hands-free PWA install over CDP: PWA.install generates the shim bundle, then flip the
// user display mode to standalone (without which the shim just answers kSuccessAndDisconnect and the
// window stays Chrome-branded). Empirically ~1s for the install plus Chrome's cold start. Throws on
// any failure. On success drops the standalone sentinel — the marker findAppShim's caller requires
// to trust the bundle (see the header notes on partial-install poisoning).
async function cdpInstallPwa(browserPath: string, url: string, dataPath: string): Promise<void> {
  const manifestId = manifestIdFor(url)
  const s = openCdpSession(browserPath, dataPath)
  try {
    await s.call("Browser.getVersion") // handshake: proves we own a fresh browser on this profile
    await s.call("PWA.install", { manifestId, installUrlOrBundleUrl: manifestId }, 30_000)
    await s.call("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" })
    // Both CDP steps landed → the shim is genuinely standalone. Mark it BEFORE closing so a healthy
    // install is always sentinel-backed. (Chrome created dataPath when it booted on this profile.)
    await writeFile(join(dataPath, STANDALONE_SENTINEL), "")
    await s.close()
  } catch (err) {
    s.kill()
    throw err
  }
}

// Remove a shim bundle over CDP. PWA.uninstall deletes the generated .app too (verified), which is
// how a poisoned/stale bundle is cleared before a fresh install. Also drops the stale sentinel so a
// subsequent install re-establishes it from scratch. Throws on any failure.
async function cdpUninstallPwa(browserPath: string, url: string, dataPath: string): Promise<void> {
  const manifestId = manifestIdFor(url)
  const s = openCdpSession(browserPath, dataPath)
  try {
    await s.call("Browser.getVersion")
    await s.call("PWA.uninstall", { manifestId })
    await s.close()
  } catch (err) {
    s.kill()
    throw err
  }
  await rm(join(dataPath, STANDALONE_SENTINEL), { force: true }).catch(() => {})
}

// After an install, Chrome launches the new shim once in REGISTER-ONLY mode (to register the bundle
// with LaunchServices); it opens no window and exits within a few seconds. `open`-ing the bundle
// while that instance is still alive gets swallowed (LaunchServices "activates" the running instance
// instead of launching), so the app window never appears — drain it first.
//
// APPEARANCE-then-idle (not a fixed pre-wait): LaunchServices may not have spawned the register-only
// instance yet when we get here, so a fixed 1s wait can elapse BEFORE it appears — then pgrep sees
// nothing, we `open` too early, and the still-to-come register-only instance swallows it. So first
// wait (bounded) for the instance to APPEAR, then for it to EXIT. If it never appears within the
// window it already drained (or this Chrome build spawns none) — proceed.
async function waitForShimIdle(shimPath: string): Promise<void> {
  const appearBy = Date.now() + 6_000
  let appeared = false
  while (Date.now() < appearBy) {
    if (await pgrepMatches(shimPath)) {
      appeared = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!appeared) return
  const idleBy = Date.now() + 15_000
  while (Date.now() < idleBy) {
    if (!(await pgrepMatches(shimPath))) return // drained
    await new Promise((r) => setTimeout(r, 250))
  }
}

// Launch the shim via `open`, then verify a hosting Chrome actually materializes on this profile
// within a bounded window; returns false if it doesn't so the caller can fall back to plain --app.
// We watch for Chrome on THIS user-data-dir (the shim boots one to host the window — observed
// <400ms) rather than merely a process on the shim path: a register-only instance also lives on the
// shim path but never boots the profile, so watching the profile avoids a false "it launched".
async function openShimVerified(shimPath: string, dataPath: string): Promise<boolean> {
  spawn("open", [shimPath], { detached: true, stdio: "ignore" }).unref()
  // A clean first-ever shim boot brings Chrome up on the profile in ~2s (measured); allow generous
  // margin for a cold/loaded machine before declaring the launch a no-op and falling back.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await profileInUse(dataPath)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function standaloneSentinelExists(dataPath: string): Promise<boolean> {
  return access(join(dataPath, STANDALONE_SENTINEL)).then(() => true).catch(() => false)
}

// Make shim launches skip Chrome's first-run experience. A shim boots Chrome itself, so our
// --no-first-run/--no-default-browser-check flags never reach it; without this a freshly-installed
// profile pops the welcome + "make Chrome your default browser" UI on the first shim launch (the CDP
// install runs with --no-first-run and leaves NO "First Run" sentinel behind). Idempotent and cheap,
// so it runs on every launch — which also self-heals profiles created before this fix.
async function seedFirstRunState(dataPath: string): Promise<void> {
  // The sentinel is read only at Chrome startup, so writing it is safe even while Chrome runs; `wx`
  // makes it a race-safe no-op if it already exists.
  await writeFile(join(dataPath, "First Run"), "", { flag: "wx" }).catch(() => {})
  // Additively turn off the default-browser check in the profile Preferences — but ONLY while the
  // profile is idle: Chrome rewrites Preferences on exit, so a concurrent write would be lost or
  // corrupt the file. (The sentinel alone already suppresses the first-run default-browser prompt;
  // this also quiets the later periodic infobar.)
  if (await profileInUse(dataPath)) return
  const prefsPath = join(dataPath, "Default", "Preferences")
  try {
    const prefs = JSON.parse(await readFile(prefsPath, "utf8")) as {
      browser?: Record<string, unknown>
    }
    if (prefs.browser?.check_default_browser === false) return // already seeded
    prefs.browser = { ...(prefs.browser ?? {}), check_default_browser: false }
    await writeFile(prefsPath, JSON.stringify(prefs))
  } catch {
    // no Preferences yet / unreadable — the sentinel alone already handles the first-run prompt
  }
}

// Returns the shim bundle to launch through, installing the PWA first if needed. Never throws — any
// failure returns null and the caller uses the plain `--app` window (today's behavior).
//
// A found shim is trusted only if it is (1) sentinel-backed — the standalone flip completed, not a
// poisoned partial install — AND (2) named as the current manifest expects — not a stale bundle from
// a prior app name. Either failure triggers the SAME heal: on a cold profile, uninstall the bad
// bundle and reinstall cleanly; if the profile is busy we can't take it for a background (un)install,
// so fall back to plain --app for this launch (the next cold launch heals it).
async function ensureAppShim(browserPath: string, url: string, dataPath: string): Promise<string | null> {
  try {
    const existing = await findAppShim(url, dataPath)
    if (
      existing &&
      existing.bundleName === EXPECTED_BUNDLE_NAME &&
      (await standaloneSentinelExists(dataPath))
    ) {
      await seedFirstRunState(dataPath) // heal profiles that predate the first-run seeding
      return existing.path // healthy
    }

    if (await profileInUse(dataPath)) return null // can't take the profile for a background (un)install

    if (existing) {
      // Poisoned (no sentinel) or stale (wrong name) — remove it before reinstalling. Best-effort:
      // even if uninstall fails, a fresh install regenerates the bundle in place.
      await cdpUninstallPwa(browserPath, url, dataPath).catch(() => {})
    }
    await cdpInstallPwa(browserPath, url, dataPath) // writes the sentinel on success
    await seedFirstRunState(dataPath) // Chrome is idle here → seed sentinel + default-browser pref
    const installed = await findAppShim(url, dataPath)
    if (installed) await waitForShimIdle(installed.path) // drain the register-only instance first
    return installed?.path ?? null
  } catch {
    return null
  }
}

// ---- Chromium launch ----

// A direct `spawn()` of the Chrome binary (never a shell-script chain) so on Apple Silicon the
// universal binary launches its native arm64 slice — LaunchServices running a script main-executable
// runs the interpreter (and thus Chrome) under Rosetta/x86_64.
function launchChromium(
  browserPath: string,
  url: string,
  windowSize: [number, number],
  dataPath?: string
): void {
  const args = [
    `--app=${url}`,
    `--window-size=${windowSize.join(",")}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-translate",
    "--disable-sync",
    "--disable-popup-blocking",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-component-extensions-with-background-pages",
    "--autoplay-policy=no-user-gesture-required",
  ]

  if (dataPath) {
    args.push(`--user-data-dir=${dataPath}`)
  }

  spawn(browserPath, args, { detached: true, stdio: "ignore" }).unref()
}

// ---- Firefox launch ----

async function launchFirefox(
  browserPath: string,
  url: string,
  windowSize: [number, number],
  dataPath?: string
): Promise<void> {
  const profileDir = dataPath ?? join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".gent",
    "firefox-profile"
  )

  await mkdir(profileDir, { recursive: true })

  // User prefs: hide browser chrome, set window size
  await writeFile(
    join(profileDir, "user.js"),
    `
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("privacy.resistFingerprinting", false);
user_pref("ui.key.menuAccessKeyFocuses", false);
user_pref("media.autoplay.blocking_policy", 0);
${process.platform === "darwin" ? 'user_pref("browser.tabs.inTitlebar", 0);' : ""}
`
  )

  // CSS: hide nav bar, tabs, and URL bar for app-like appearance
  await mkdir(join(profileDir, "chrome"), { recursive: true })
  await writeFile(
    join(profileDir, "chrome", "userChrome.css"),
    `
.titlebar-spacer, #firefox-view-button, #alltabs-button,
#tabbrowser-arrowscrollbox-periphery, .tab-close-button {
  display: none;
}
#nav-bar, #urlbar-container, #searchbar { visibility: collapse !important; }
.tab-background, .tab-content, #tabbrowser-tabs {
  background: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  box-shadow: none !important;
}
#tabbrowser-tabs { margin: 0 6px !important; }
.tabbrowser-tab { pointer-events: none; }
#titlebar, .tabbrowser-tab { height: 20px; }
.tab-content { height: 42px; }
html:not([tabsintitlebar="true"]) #titlebar,
html:not([tabsintitlebar="true"]) .tabbrowser-tab,
html:not([tabsintitlebar="true"]) .tab-background,
html:not([tabsintitlebar="true"]) .tab-content,
html:not([tabsintitlebar="true"]) #tabbrowser-tabs {
  display: none !important;
}
`
  )

  spawn(
    browserPath,
    [
      "-width", String(windowSize[0]),
      "-height", String(windowSize[1]),
      "-profile", profileDir,
      "-new-window", url,
      "-new-instance",
      "-no-remote",
    ],
    { detached: true, stdio: "ignore" }
  ).unref()
}
