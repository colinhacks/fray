#!/usr/bin/env node

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { inflateSync } from "node:zlib"

const scriptPath = fileURLToPath(import.meta.url)
const uiRoot = resolve(dirname(scriptPath), "..")
const publicDir = join(uiRoot, "packages/web/public")
const sourcePath = join(publicDir, "favicon.svg")

const outputs = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.error?.code === "ENOENT") throw new Error(`${command} is required`)
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.status}`)
  }
  return result.stdout
}

export function render(source, output, size) {
  try {
    run("rsvg-convert", ["-w", String(size), "-h", String(size), source, "-o", output])
  } catch (error) {
    if (String(error).includes("rsvg-convert is required")) {
      throw new Error("rsvg-convert is required (macOS: brew install librsvg)")
    }
    throw error
  }
}

function pngMetadata(path) {
  const bytes = readFileSync(path)
  const signature = "89504e470d0a1a0a"
  if (bytes.subarray(0, 8).toString("hex") !== signature || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${path} is not a PNG`)
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
  }
}

function assertRendered(path, size, { opaque = false } = {}) {
  const metadata = pngMetadata(path)
  if (metadata.width !== size || metadata.height !== size) {
    throw new Error(`${path} is ${metadata.width}x${metadata.height}; expected ${size}x${size}`)
  }
  const hasAlpha = metadata.colorType === 4 || metadata.colorType === 6
  if (opaque && hasAlpha) throw new Error(`${path} unexpectedly has an alpha channel`)
  if (!opaque && !hasAlpha) throw new Error(`${path} unexpectedly lacks an alpha channel`)
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`favicon.svg must contain exactly one ${label}; found ${matches.length}`)
  return source.replace(pattern, replacement)
}

export function buildMaskableSvg(source, { scale = 0.78 } = {}) {
  if (!(scale > 0 && scale <= 0.8)) throw new Error(`maskable scale ${scale} exceeds the central 80% safe zone`)
  const offset = (512 - 512 * scale) / 2
  let transformed = replaceExactlyOnce(
    source,
    /<rect id="icon-background"[^>]*\/>/g,
    '<rect id="icon-background" width="512" height="512" fill="url(#background)"/>',
    "#icon-background node",
  )
  transformed = replaceExactlyOnce(transformed, /\s*<rect id="icon-border"[^>]*\/>/g, "", "#icon-border node")
  transformed = replaceExactlyOnce(
    transformed,
    /<g id="icon-mark"([^>]*)>/g,
    (_node, attributes) => {
      if (/\stransform=/.test(attributes)) throw new Error("#icon-mark already has a transform")
      return `<g id="icon-mark" transform="translate(${offset} ${offset}) scale(${scale})"${attributes}>`
    },
    "#icon-mark opening node",
  )
  if (transformed.includes('id="icon-border"')) throw new Error("maskable SVG still contains #icon-border")
  const expectedTransform = `transform="translate(${offset} ${offset}) scale(${scale})"`
  if (!transformed.includes(expectedTransform)) throw new Error("maskable SVG did not receive the expected mark transform")

  let markOnly = replaceExactlyOnce(
    transformed,
    /\s*<rect id="icon-background"[^>]*\/>/g,
    "",
    "transformed #icon-background node",
  )
  markOnly = replaceExactlyOnce(markOnly, /\s*<circle id="icon-glow"[^>]*\/>/g, "", "#icon-glow node")
  return { svg: transformed, markOnlySvg: markOnly, scale, offset }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export function decodePngAlpha(path) {
  const bytes = readFileSync(path)
  const metadata = pngMetadata(path)
  if (metadata.bitDepth !== 8 || metadata.interlace !== 0 || ![4, 6].includes(metadata.colorType)) {
    throw new Error(`${path} must be a non-interlaced 8-bit PNG with alpha`)
  }
  const chunks = []
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const channels = metadata.colorType === 6 ? 4 : 2
  const stride = metadata.width * channels
  const inflated = inflateSync(Buffer.concat(chunks))
  if (inflated.length !== metadata.height * (stride + 1)) throw new Error(`${path} has unexpected scanline data`)
  const decoded = Buffer.alloc(metadata.height * stride)
  let sourceOffset = 0
  for (let y = 0; y < metadata.height; y += 1) {
    const filter = inflated[sourceOffset]
    sourceOffset += 1
    const rowOffset = y * stride
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x]
      const left = x >= channels ? decoded[rowOffset + x - channels] : 0
      const up = y > 0 ? decoded[rowOffset - stride + x] : 0
      const upperLeft = y > 0 && x >= channels ? decoded[rowOffset - stride + x - channels] : 0
      let value
      if (filter === 0) value = raw
      else if (filter === 1) value = raw + left
      else if (filter === 2) value = raw + up
      else if (filter === 3) value = raw + Math.floor((left + up) / 2)
      else if (filter === 4) value = raw + paeth(left, up, upperLeft)
      else throw new Error(`${path} uses unsupported PNG filter ${filter}`)
      decoded[rowOffset + x] = value & 0xff
    }
    sourceOffset += stride
  }
  const alpha = new Uint8Array(metadata.width * metadata.height)
  const alphaChannel = channels - 1
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = decoded[pixel * channels + alphaChannel]
  return { width: metadata.width, height: metadata.height, alpha }
}

export function assertAlphaWithinSafeCircle({ width, height, alpha }, safeDiameterRatio = 0.8) {
  if (width !== height) throw new Error("maskable safe-zone validation requires a square render")
  const center = width / 2
  const radius = (width * safeDiameterRatio) / 2
  let painted = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x] === 0) continue
      painted += 1
      if (Math.hypot(x + 0.5 - center, y + 0.5 - center) > radius) {
        throw new Error(`maskable mark paints outside the safe circle at ${x},${y}`)
      }
    }
  }
  if (painted === 0) throw new Error("maskable mark-only render is empty")
  return painted
}

function assertDirectDirectory(path, parent) {
  const parentReal = realpathSync(parent)
  if (dirname(resolve(path)) !== resolve(parent)) throw new Error(`${path} is not a direct child of ${parent}`)
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${path} must be a direct, non-symlink directory`)
  if (realpathSync(path) !== join(parentReal, basename(path))) throw new Error(`${path} escapes its canonical parent`)
  return entry
}

function assertDirectRegularFile(path, parent) {
  const parentReal = realpathSync(parent)
  if (dirname(resolve(path)) !== resolve(parent)) throw new Error(`${path} is not a direct child of ${parent}`)
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${path} must be a direct, non-symlink regular file`)
  if (realpathSync(path) !== join(parentReal, basename(path))) throw new Error(`${path} escapes its canonical parent`)
  return entry
}

function bundleStructure(appPath, containerRoot) {
  assertDirectDirectory(appPath, containerRoot)
  const contents = join(appPath, "Contents")
  const macos = join(contents, "MacOS")
  const resources = join(contents, "Resources")
  assertDirectDirectory(contents, appPath)
  assertDirectDirectory(macos, contents)
  assertDirectDirectory(resources, contents)
  const plistPath = join(contents, "Info.plist")
  const loaderPath = join(macos, "app_mode_loader")
  const iconPath = join(resources, "app.icns")
  assertDirectRegularFile(plistPath, contents)
  assertDirectRegularFile(loaderPath, macos)
  assertDirectRegularFile(iconPath, resources)
  return { plistPath, loaderPath, iconPath, resources }
}

function systemPlistParser(bytes) {
  return JSON.parse(run("plutil", ["-convert", "json", "-o", "-", "-"], { input: bytes }))
}

export function inspectOwnedFrayShim(appPath, {
  containerRoot,
  projectsRoot,
  expectedBundleName = basename(appPath, ".app"),
  parsePlist = systemPlistParser,
} = {}) {
  if (!containerRoot || !projectsRoot) throw new Error("containerRoot and projectsRoot are required")
  const structure = bundleStructure(appPath, containerRoot)
  let info
  try {
    info = parsePlist(readStableRegularFile(structure.plistPath, dirname(structure.plistPath)))
  } catch {
    return null
  }
  let shortcutUrl
  try {
    shortcutUrl = new URL(info.CrAppModeShortcutURL)
  } catch {
    return null
  }
  const bundleIdentifier = typeof info.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : ""
  const appId = bundleIdentifier.match(/^com\.google\.Chrome\.app\.([a-p]{32})$/)?.[1] ?? ""
  const projectsCanonical = realpathSync(projectsRoot)
  const profile = typeof info.CrAppModeUserDataDir === "string" ? info.CrAppModeUserDataDir : ""
  const profilePrefix = `${projectsCanonical}${sep}`
  const relativeProfile = profile.startsWith(profilePrefix) ? profile.slice(profilePrefix.length) : ""
  const projectId = relativeProfile.split(sep)[0]
  const projectDir = join(projectsCanonical, projectId)
  const browserProfile = join(projectDir, "browser-profile")
  const bundleName = info.CFBundleName ?? ""
  const expectedShortcutUrl = shortcutUrl.port ? `http://127.0.0.1:${shortcutUrl.port}/` : ""
  const expectedProfile = join(browserProfile, "-", "Web Applications", `_crx_${appId}`)
  if (
    bundleName !== expectedBundleName ||
    !/^Fray(?: [1-9]\d*)?$/.test(bundleName) ||
    info.CFBundleExecutable !== "app_mode_loader" ||
    !appId ||
    shortcutUrl.protocol !== "http:" ||
    shortcutUrl.hostname !== "127.0.0.1" ||
    shortcutUrl.pathname !== "/" ||
    !/^\d+$/.test(shortcutUrl.port) ||
    info.CrAppModeShortcutURL !== expectedShortcutUrl ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId) ||
    profile !== expectedProfile
  ) {
    return null
  }
  try {
    assertDirectDirectory(projectDir, projectsCanonical)
    assertDirectDirectory(browserProfile, projectDir)
  } catch {
    return null
  }
  return { info, ...structure, projectDir, browserProfile }
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
}

export function readStableRegularFile(path, parent) {
  const before = assertDirectRegularFile(path, parent)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!sameIdentity(before, opened)) throw new Error(`${path} changed identity before it could be read`)
    const bytes = readFileSync(fd)
    const after = assertDirectRegularFile(path, parent)
    if (!sameIdentity(opened, after)) throw new Error(`${path} changed identity while it was read`)
    return bytes
  } finally {
    closeSync(fd)
  }
}

export function writeStableRegularFile(path, parent, bytes, { mode } = {}) {
  const before = assertDirectRegularFile(path, parent)
  const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!sameIdentity(before, opened)) throw new Error(`${path} changed identity before it could be written`)
    ftruncateSync(fd, 0)
    writeFileSync(fd, bytes)
    if (mode !== undefined) fchmodSync(fd, mode)
    fsyncSync(fd)
    const after = assertDirectRegularFile(path, parent)
    if (!sameIdentity(opened, after)) throw new Error(`${path} changed identity while it was written`)
  } finally {
    closeSync(fd)
  }
}

export function discoverOwnedFrayShims({ appsDir, projectsRoot, parsePlist = systemPlistParser }) {
  const canonicalAppsDir = realpathSync(appsDir)
  const shims = []
  for (const entry of readdirSync(canonicalAppsDir, { withFileTypes: true })) {
    if (!/^Fray(?: [1-9]\d*)?\.app$/.test(entry.name)) continue
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`${entry.name} must be a direct, non-symlink app bundle`)
    }
    const path = join(canonicalAppsDir, entry.name)
    const owned = inspectOwnedFrayShim(path, {
      containerRoot: canonicalAppsDir,
      projectsRoot,
      parsePlist,
    })
    if (owned) shims.push({ path, owned })
  }
  return shims.sort((a, b) => a.path.localeCompare(b.path))
}

function defaultCopyBundle(source, destination) {
  run("ditto", [source, destination])
}

function defaultSignBundle(path) {
  run("codesign", [
    "--force",
    "--sign", "-",
    "--preserve-metadata=identifier,entitlements,flags,runtime",
    path,
  ])
}

function defaultVerifyBundle(path) {
  run("codesign", ["--verify", "--deep", "--strict", path])
}

function defaultActivateBundle(path) {
  const before = assertDirectDirectory(path, dirname(path))
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  const now = new Date()
  try {
    const opened = fstatSync(fd)
    if (!sameIdentity(before, opened)) throw new Error(`${path} changed identity before activation`)
    futimesSync(fd, now, now)
    const after = assertDirectDirectory(path, dirname(path))
    if (!sameIdentity(opened, after)) throw new Error(`${path} changed identity during activation`)
  } finally {
    closeSync(fd)
  }
}

function defaultRemoveBackup(path) {
  rmSync(path, { recursive: true, force: true })
}

export function refreshInstalledAppIcons({
  appsDir,
  projectsRoot,
  icnsPath,
  processList = run("ps", ["-axo", "command="]),
  parsePlist = systemPlistParser,
  copyBundle = defaultCopyBundle,
  signBundle = defaultSignBundle,
  verifyBundle = defaultVerifyBundle,
  activateBundle = defaultActivateBundle,
  renameBundle = renameSync,
  removeBackup = defaultRemoveBackup,
  log = console.log,
} = {}) {
  if (!appsDir || !projectsRoot || !icnsPath) throw new Error("appsDir, projectsRoot, and icnsPath are required")
  const shims = discoverOwnedFrayShims({ appsDir, projectsRoot, parsePlist })
  if (shims.length === 0) throw new Error(`no positively identified Fray app shims found in ${appsDir}`)
  for (const { path: appPath, owned } of shims) {
    const webAppsSuffix = `${sep}-${sep}Web Applications${sep}`
    const profile = owned.info.CrAppModeUserDataDir
    const profileRoot = profile.includes(webAppsSuffix) ? profile.slice(0, profile.indexOf(webAppsSuffix)) : profile
    if (processList.includes(owned.loaderPath) || processList.includes(`--user-data-dir=${profileRoot}`)) {
      throw new Error(`${basename(appPath)} is running; close it before refreshing its on-disk icon`)
    }
  }

  const icnsBytes = readStableRegularFile(icnsPath, dirname(icnsPath))
  const canonicalAppsDir = realpathSync(appsDir)
  const transactionRoot = mkdtempSync(join(canonicalAppsDir, ".fray-icon-transaction-"))
  const transactions = []
  let mayRemoveTransactionRoot = false
  let committed = false
  let cleanupComplete = false
  try {
    // Phase 1: stage and verify every bundle before changing any installed path.
    for (let index = 0; index < shims.length; index += 1) {
      const { path: appPath, owned } = shims[index]
      const stagePath = join(transactionRoot, `${index}-stage.app`)
      const backupPath = join(transactionRoot, `${index}-backup.app`)
      const failedPath = join(transactionRoot, `${index}-failed.app`)
      const originalPlist = readStableRegularFile(owned.plistPath, dirname(owned.plistPath))
      const originalIcon = readStableRegularFile(owned.iconPath, owned.resources)
      const originalMode = lstatSync(owned.iconPath).mode & 0o777
      copyBundle(appPath, stagePath)
      const staged = inspectOwnedFrayShim(stagePath, {
        containerRoot: transactionRoot,
        projectsRoot,
        expectedBundleName: owned.info.CFBundleName,
        parsePlist,
      })
      if (!staged) throw new Error(`${basename(appPath)} lost its Fray ownership metadata while staging`)
      writeStableRegularFile(staged.iconPath, staged.resources, icnsBytes, { mode: originalMode })
      signBundle(stagePath)
      verifyBundle(stagePath)
      const verifiedStage = inspectOwnedFrayShim(stagePath, {
        containerRoot: transactionRoot,
        projectsRoot,
        expectedBundleName: owned.info.CFBundleName,
        parsePlist,
      })
      if (!verifiedStage) throw new Error(`${basename(appPath)} lost its Fray ownership metadata after signing`)
      if (!readStableRegularFile(verifiedStage.plistPath, dirname(verifiedStage.plistPath)).equals(originalPlist)) {
        throw new Error(`${basename(appPath)} metadata changed while staging`)
      }
      if (!readStableRegularFile(verifiedStage.iconPath, verifiedStage.resources).equals(icnsBytes)) {
        throw new Error(`${basename(appPath)} staged icon does not match the generated ICNS`)
      }
      transactions.push({
        appPath,
        backupPath,
        failedPath,
        stagePath,
        originalPlist,
        originalIcon,
        owned,
        backupMoved: false,
      })
    }

    // Phase 2: swap all staged bundles, then verify and activate the whole set.
    for (const transaction of transactions) {
      renameBundle(transaction.appPath, transaction.backupPath)
      transaction.backupMoved = true
      renameBundle(transaction.stagePath, transaction.appPath)
    }
    for (const transaction of transactions) {
      verifyBundle(transaction.appPath)
      const installed = inspectOwnedFrayShim(transaction.appPath, {
        containerRoot: canonicalAppsDir,
        projectsRoot,
        expectedBundleName: transaction.owned.info.CFBundleName,
        parsePlist,
      })
      if (!installed) throw new Error(`${basename(transaction.appPath)} lost its installed Fray ownership metadata`)
      if (!readStableRegularFile(installed.plistPath, dirname(installed.plistPath)).equals(transaction.originalPlist)) {
        throw new Error(`${basename(transaction.appPath)} installed metadata differs from its original metadata`)
      }
      if (!readStableRegularFile(installed.iconPath, installed.resources).equals(icnsBytes)) {
        throw new Error(`${basename(transaction.appPath)} installed icon does not match the generated ICNS`)
      }
      activateBundle(transaction.appPath)
    }
    // Every installed shim is valid now. Backup disposal is post-commit cleanup:
    // a cleanup failure must retain recovery data, never roll back only a suffix.
    committed = true
    for (const transaction of transactions) {
      removeBackup(transaction.backupPath)
      transaction.backupMoved = false
    }
    cleanupComplete = true
    mayRemoveTransactionRoot = true
    for (const transaction of transactions) {
      log(`refreshed ${basename(transaction.appPath)} (${transaction.owned.info.CrAppModeShortcutURL})`)
    }
    log(`refreshed ${transactions.length} positively identified Fray app shim icon${transactions.length === 1 ? "" : "s"}`)
    return transactions.map(({ appPath }) => appPath)
  } catch (error) {
    if (committed) {
      mayRemoveTransactionRoot = cleanupComplete
      if (!cleanupComplete) {
        throw new AggregateError(
          [error],
          `app icon refresh committed but backup cleanup was incomplete; recovery data remains at ${transactionRoot}`,
        )
      }
      throw error
    }
    const rollbackErrors = []
    for (const transaction of [...transactions].reverse()) {
      if (!transaction.backupMoved) continue
      try {
        if (existsSync(transaction.appPath)) renameBundle(transaction.appPath, transaction.failedPath)
        renameBundle(transaction.backupPath, transaction.appPath)
        rmSync(transaction.failedPath, { recursive: true, force: true })
        transaction.backupMoved = false
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    mayRemoveTransactionRoot = rollbackErrors.length === 0
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `app icon refresh failed and rollback was incomplete; recovery data remains at ${transactionRoot}`)
    }
    throw error
  } finally {
    if (mayRemoveTransactionRoot) rmSync(transactionRoot, { recursive: true, force: true })
  }
}

function buildIcns(workDir) {
  if (process.platform !== "darwin") throw new Error("--refresh-app-icons is supported only on macOS")
  const iconset = join(workDir, "Fray.iconset")
  mkdirSync(iconset)
  const sizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]
  for (const [name, size] of sizes) render(sourcePath, join(iconset, name), size)
  const output = join(workDir, "app.icns")
  run("iconutil", ["-c", "icns", iconset, "-o", output])
  return output
}

export function main(args = process.argv.slice(2)) {
  const check = args.includes("--check")
  const refreshAppIcons = args.includes("--refresh-app-icons")
  if (check && refreshAppIcons) throw new Error("--check and --refresh-app-icons cannot be combined")
  const workDir = mkdtempSync(join(publicDir, ".icon-build-"))
  try {
    const source = readFileSync(sourcePath, "utf8")
    const maskable = buildMaskableSvg(source)
    for (const [name, size] of outputs) {
      const output = join(workDir, name)
      render(sourcePath, output, size)
      assertRendered(output, size)
    }

    const maskableSource = join(workDir, "maskable.svg")
    const maskableMarkSource = join(workDir, "maskable-mark.svg")
    const maskableOutput = join(workDir, "icon-maskable-512.png")
    const maskableMarkOutput = join(workDir, "maskable-mark-512.png")
    writeFileSync(maskableSource, maskable.svg)
    writeFileSync(maskableMarkSource, maskable.markOnlySvg)
    render(maskableSource, maskableOutput, 512)
    render(maskableMarkSource, maskableMarkOutput, 512)
    assertRendered(maskableOutput, 512, { opaque: true })
    assertRendered(maskableMarkOutput, 512)
    assertAlphaWithinSafeCircle(decodePngAlpha(maskableMarkOutput))

    const generated = [...outputs.map(([name]) => name), "icon-maskable-512.png"]
    if (check) {
      const stale = generated.filter((name) => {
        const committed = join(publicDir, name)
        return !existsSync(committed) || !readFileSync(committed).equals(readFileSync(join(workDir, name)))
      })
      if (stale.length > 0) throw new Error(`generated icon assets are stale: ${stale.join(", ")}`)
      console.log(`icon assets are current (${generated.length} PNGs)`)
    } else {
      for (const name of generated) renameSync(join(workDir, name), join(publicDir, name))
      console.log(`generated ${generated.length} PNGs from ${sourcePath}`)
    }
    if (refreshAppIcons) {
      refreshInstalledAppIcons({
        appsDir: join(homedir(), "Applications", "Chrome Apps.localized"),
        projectsRoot: join(homedir(), ".fray", "projects"),
        icnsPath: buildIcns(workDir),
      })
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(scriptPath)) main()
