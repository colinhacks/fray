import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  assertAlphaWithinSafeCircle,
  buildMaskableSvg,
  discoverOwnedFrayShims,
  inspectOwnedFrayShim,
  refreshInstalledAppIcons,
} from "./generate-icons.mjs"

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
]

const parseJsonPlist = (bytes) => JSON.parse(bytes.toString("utf8"))
const copyBundleTree = (source, destination) => cpSync(source, destination, {
  recursive: true,
  preserveTimestamps: true,
  verbatimSymlinks: true,
})

function makeFixture(t, count = 2) {
  const root = mkdtempSync(join(tmpdir(), "fray-icon-test-"))
  const appsPath = join(root, "Applications", "Chrome Apps.localized")
  const projectsPath = join(root, ".fray", "projects")
  mkdirSync(appsPath, { recursive: true })
  mkdirSync(projectsPath, { recursive: true })
  const appsDir = realpathSync(appsPath)
  const projectsRoot = realpathSync(projectsPath)
  const apps = []
  for (let index = 0; index < count; index += 1) {
    const bundleName = index === 0 ? "Fray" : `Fray ${index}`
    const appPath = join(appsDir, `${bundleName}.app`)
    const contents = join(appPath, "Contents")
    const macos = join(contents, "MacOS")
    const resources = join(contents, "Resources")
    const projectDir = join(projectsRoot, ids[index])
    const browserProfile = join(projectDir, "browser-profile")
    mkdirSync(macos, { recursive: true })
    mkdirSync(resources)
    mkdirSync(browserProfile, { recursive: true })
    const info = {
      CFBundleName: bundleName,
      CFBundleExecutable: "app_mode_loader",
      CFBundleIdentifier: `com.google.Chrome.app.${"a".repeat(31)}${String.fromCharCode(97 + index)}`,
      CrAppModeShortcutURL: `http://127.0.0.1:${4917 + index}/`,
      CrAppModeUserDataDir: join(
        browserProfile,
        "-",
        "Web Applications",
        `_crx_${"a".repeat(31)}${String.fromCharCode(97 + index)}`,
      ),
    }
    writeFileSync(join(contents, "Info.plist"), JSON.stringify(info))
    writeFileSync(join(macos, "app_mode_loader"), `loader-${index}`)
    writeFileSync(join(resources, "app.icns"), `original-icon-${index}`, { mode: 0o600 })
    apps.push({
      appPath,
      bundleName,
      info,
      plistPath: join(contents, "Info.plist"),
      iconPath: join(resources, "app.icns"),
      loaderPath: join(macos, "app_mode_loader"),
      originalPlist: readFileSync(join(contents, "Info.plist")),
      originalIcon: readFileSync(join(resources, "app.icns")),
    })
  }
  const icnsPath = join(root, "candidate.icns")
  writeFileSync(icnsPath, "final-canonical-icns")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, appsDir, projectsRoot, apps, icnsPath, candidate: readFileSync(icnsPath) }
}

function options(fixture, overrides = {}) {
  return {
    appsDir: fixture.appsDir,
    projectsRoot: fixture.projectsRoot,
    icnsPath: fixture.icnsPath,
    processList: "",
    parsePlist: parseJsonPlist,
    copyBundle: copyBundleTree,
    signBundle: () => {},
    verifyBundle: () => {},
    activateBundle: () => {},
    log: () => {},
    ...overrides,
  }
}

function assertOriginals(fixture) {
  for (const app of fixture.apps) {
    assert.deepEqual(readFileSync(app.plistPath), app.originalPlist)
    assert.deepEqual(readFileSync(app.iconPath), app.originalIcon)
  }
  assert.deepEqual(readdirSync(fixture.appsDir).filter((name) => name.startsWith(".fray-icon-")), [])
}

test("owned shim identity accepts canonical Fray bundles and rejects forged metadata", (t) => {
  const fixture = makeFixture(t, 1)
  const [app] = fixture.apps
  const owned = inspectOwnedFrayShim(app.appPath, {
    containerRoot: fixture.appsDir,
    projectsRoot: fixture.projectsRoot,
    parsePlist: parseJsonPlist,
  })
  assert.equal(owned.info.CrAppModeShortcutURL, app.info.CrAppModeShortcutURL)
  assert.equal(discoverOwnedFrayShims({
    appsDir: fixture.appsDir,
    projectsRoot: fixture.projectsRoot,
    parsePlist: parseJsonPlist,
  }).length, 1)

  for (const forged of [
    { CrAppModeShortcutURL: "https://example.com/" },
    { CrAppModeShortcutURL: `${app.info.CrAppModeShortcutURL}?forged=1` },
    { CFBundleIdentifier: `com.google.Chrome.app.${"b".repeat(32)}` },
    { CrAppModeUserDataDir: join(dirname(dirname(app.info.CrAppModeUserDataDir)), "..", "escaped-profile") },
  ]) {
    writeFileSync(app.plistPath, JSON.stringify({ ...app.info, ...forged }))
    assert.equal(inspectOwnedFrayShim(app.appPath, {
      containerRoot: fixture.appsDir,
      projectsRoot: fixture.projectsRoot,
      parsePlist: parseJsonPlist,
    }), null)
  }
  writeFileSync(app.plistPath, app.originalPlist)
})

test("symlinked bundles and resources are rejected, including a staged no-follow attack", (t) => {
  const fixture = makeFixture(t, 1)
  const [app] = fixture.apps
  const linkedBundle = join(fixture.appsDir, "Fray 1.app")
  symlinkSync(app.appPath, linkedBundle)
  assert.throws(() => discoverOwnedFrayShims({
    appsDir: fixture.appsDir,
    projectsRoot: fixture.projectsRoot,
    parsePlist: parseJsonPlist,
  }), /non-symlink app bundle/)
  unlinkSync(linkedBundle)

  for (const relativeDirectory of ["Contents", join("Contents", "MacOS"), join("Contents", "Resources")]) {
    const directory = join(app.appPath, relativeDirectory)
    const holding = join(fixture.root, `holding-${relativeDirectory.replaceAll("/", "-")}`)
    renameSync(directory, holding)
    symlinkSync(holding, directory)
    assert.throws(() => inspectOwnedFrayShim(app.appPath, {
      containerRoot: fixture.appsDir,
      projectsRoot: fixture.projectsRoot,
      parsePlist: parseJsonPlist,
    }), /non-symlink directory/)
    unlinkSync(directory)
    renameSync(holding, directory)
  }

  const nestedRoot = join(fixture.appsDir, "nested")
  const nestedBundle = join(nestedRoot, "Fray 1.app")
  mkdirSync(nestedRoot)
  copyBundleTree(app.appPath, nestedBundle)
  assert.throws(() => inspectOwnedFrayShim(nestedBundle, {
    containerRoot: fixture.appsDir,
    projectsRoot: fixture.projectsRoot,
    expectedBundleName: "Fray",
    parsePlist: parseJsonPlist,
  }), /not a direct child/)

  const outside = join(fixture.root, "outside.icns")
  writeFileSync(outside, "do-not-touch")
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    copyBundle(source, destination) {
      copyBundleTree(source, destination)
      const stagedIcon = join(destination, "Contents", "Resources", "app.icns")
      unlinkSync(stagedIcon)
      symlinkSync(outside, stagedIcon)
    },
  })), /non-symlink regular file/)
  assert.equal(readFileSync(outside, "utf8"), "do-not-touch")
  assertOriginals(fixture)
})

test("running app loader or browser profile refuses refresh before staging", (t) => {
  const fixture = makeFixture(t, 1)
  let copies = 0
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    processList: `/bin/sh ${fixture.apps[0].loaderPath}`,
    copyBundle() { copies += 1 },
  })), /is running/)
  assert.equal(copies, 0)
  const profileRoot = fixture.apps[0].info.CrAppModeUserDataDir.split(`${join("-", "Web Applications")}`)[0]
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    processList: `/Applications/Google Chrome --user-data-dir=${profileRoot}`,
    copyBundle() { copies += 1 },
  })), /is running/)
  assert.equal(copies, 0)
  assertOriginals(fixture)
})

test("stage verification catches metadata mutation before installed paths change", (t) => {
  const fixture = makeFixture(t, 2)
  let mutated = false
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    signBundle(stagePath) {
      if (!mutated) {
        mutated = true
        const plist = join(stagePath, "Contents", "Info.plist")
        const info = JSON.parse(readFileSync(plist, "utf8"))
        writeFileSync(plist, JSON.stringify({ ...info, CrAppModeShortcutURL: "http://127.0.0.1:5999/" }))
      }
    },
  })), /metadata changed|ownership metadata/)
  assertOriginals(fixture)
})

test("final signature verification failure rolls back every swapped shim", (t) => {
  const fixture = makeFixture(t, 2)
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    verifyBundle(path) {
      if (dirname(path) === fixture.appsDir && basename(path) === "Fray 1.app") {
        throw new Error("signature invalid")
      }
    },
  })), /signature invalid/)
  assertOriginals(fixture)
})

test("activation failure on a later shim rolls back the complete multi-shim update", (t) => {
  const fixture = makeFixture(t, 2)
  let activated = 0
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    activateBundle() {
      activated += 1
      if (activated === 2) throw new Error("activation failed")
    },
  })), /activation failed/)
  assert.equal(activated, 2)
  assertOriginals(fixture)
})

test("a staged-install rename failure restores both the current backup and earlier shims", (t) => {
  const fixture = makeFixture(t, 2)
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    renameBundle(source, destination) {
      if (basename(source).endsWith("-stage.app") && destination === fixture.apps[1].appPath) {
        throw new Error("stage install rename failed")
      }
      renameSync(source, destination)
    },
  })), /stage install rename failed/)
  assertOriginals(fixture)
})

test("a post-commit backup cleanup failure keeps every installed shim updated", (t) => {
  const fixture = makeFixture(t, 2)
  let removals = 0
  assert.throws(() => refreshInstalledAppIcons(options(fixture, {
    removeBackup(path) {
      removals += 1
      if (removals === 2) throw new Error("backup cleanup failed")
      rmSync(path, { recursive: true, force: true })
    },
  })), /refresh committed but backup cleanup was incomplete/)
  assert.equal(removals, 2)
  for (const app of fixture.apps) {
    assert.deepEqual(readFileSync(app.plistPath), app.originalPlist)
    assert.deepEqual(readFileSync(app.iconPath), fixture.candidate)
  }
  const recoveryRoots = readdirSync(fixture.appsDir).filter((name) => name.startsWith(".fray-icon-transaction-"))
  assert.equal(recoveryRoots.length, 1)
  assert.ok(readdirSync(join(fixture.appsDir, recoveryRoots[0])).some((name) => name.endsWith("-backup.app")))
})

test("successful transaction preserves plist bytes and modes while updating every icon", (t) => {
  const fixture = makeFixture(t, 2)
  let signed = 0
  let verified = 0
  let activated = 0
  const refreshed = refreshInstalledAppIcons(options(fixture, {
    signBundle() { signed += 1 },
    verifyBundle() { verified += 1 },
    activateBundle() { activated += 1 },
  }))
  assert.equal(refreshed.length, 2)
  assert.equal(signed, 2)
  assert.equal(verified, 4)
  assert.equal(activated, 2)
  for (const app of fixture.apps) {
    assert.deepEqual(readFileSync(app.plistPath), app.originalPlist)
    assert.deepEqual(readFileSync(app.iconPath), fixture.candidate)
    assert.equal(lstatSync(app.iconPath).mode & 0o777, 0o600)
  }
  assert.deepEqual(readdirSync(fixture.appsDir).filter((name) => name.startsWith(".fray-icon-")), [])
})

test("maskable transforms are singular and safe-circle validation rejects overflow", () => {
  const source = readFileSync(join(dirname(new URL(import.meta.url).pathname), "../packages/web/public/favicon.svg"), "utf8")
  const result = buildMaskableSvg(source)
  assert.match(result.svg, /icon-mark" transform="translate\(56\.31999999999999 56\.31999999999999\) scale\(0\.78\)"/)
  const background = source.match(/<rect id="icon-background"[^>]*\/>/)[0]
  assert.throws(() => buildMaskableSvg(source.replace(background, `${background}${background}`)), /exactly one #icon-background/)
  assert.throws(() => buildMaskableSvg(source.replace(/<rect id="icon-border"[^>]*\/>/, "")), /exactly one #icon-border/)

  const alpha = new Uint8Array(100)
  alpha[5 * 10 + 5] = 255
  assert.equal(assertAlphaWithinSafeCircle({ width: 10, height: 10, alpha }), 1)
  alpha[0] = 1
  assert.throws(() => assertAlphaWithinSafeCircle({ width: 10, height: 10, alpha }), /outside the safe circle/)
})
