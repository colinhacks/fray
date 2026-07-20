// Immutable web artifacts are deliberately tooling-owned. The stable control plane never watches
// the Fray checkout; ordinary stopped-then-fresh launches select or build and promote one digest.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

export interface FrayArtifactManifest {
  version: 1 | 2;
  digest: string;
  createdAt: string;
  sourceDir: string;
  sourceRevision: string;
  /** Complete relevant canonical-source input set; absent on pre-fingerprint artifacts. */
  sourceFingerprint?: string;
  nodeVersion: string;
  /** Host/runtime boundary for the deploy closure (native modules are Node-ABI specific). */
  host?: {
    platform: string;
    arch: string;
    nodeMajor: number;
    nodeModules: string;
  };
  /** Immutable host-specific native dependency closure selected by the runtime bundle. */
  dependencyCell?: string;
  webFiles: Record<string, string>;
  runtimeFiles: Record<string, string>;
}

export interface FrayArtifactHost {
  platform: string;
  arch: string;
  nodeMajor: number;
  nodeModules: string;
}

export function currentArtifactHost(): FrayArtifactHost {
  return {
    platform: platform(),
    arch: arch(),
    nodeMajor: Number(process.versions.node.split(".")[0]),
    nodeModules: process.versions.modules,
  };
}

/** Reject a promoted closure before its server child can load incompatible native dependencies. */
export function assertArtifactHostCompatible(
  artifact: Pick<FrayArtifact, "digest" | "manifest">,
  host: FrayArtifactHost = currentArtifactHost()
): void {
  const built = artifact.manifest.host;
  if (!built)
    throw new Error(
      `Fray artifact ${artifact.digest} does not record host compatibility; stop Fray and rerun fray-dev on this machine to build a compatible immutable artifact`
    );
  const mismatches: string[] = [];
  if (built.platform !== host.platform) mismatches.push(`platform ${built.platform} != ${host.platform}`);
  if (built.arch !== host.arch) mismatches.push(`architecture ${built.arch} != ${host.arch}`);
  if (built.nodeMajor !== host.nodeMajor) mismatches.push(`Node major ${built.nodeMajor} != ${host.nodeMajor}`);
  if (built.nodeModules !== host.nodeModules) mismatches.push(`Node ABI ${built.nodeModules} != ${host.nodeModules}`);
  if (mismatches.length > 0)
    throw new Error(
      `Fray artifact ${artifact.digest} is incompatible with this host (${mismatches.join(", ")}); stop Fray and rerun fray-dev on this machine to build a compatible immutable artifact`
    );
}

function artifactHostMatches(
  built: FrayArtifactManifest["host"],
  host: FrayArtifactHost
): built is FrayArtifactHost {
  return !!built &&
    built.platform === host.platform &&
    built.arch === host.arch &&
    built.nodeMajor === host.nodeMajor &&
    built.nodeModules === host.nodeModules;
}

export interface FrayArtifact {
  digest: string;
  dir: string;
  webDir: string;
  runtimeDir: string;
  manifest: FrayArtifactManifest;
}

export interface StableArtifactPointer {
  version: 1;
  current: string;
  previous?: string;
  updatedAt: string;
}

export interface EnsureStableArtifactOptions {
  /** Injectable for the launcher regression tests; production uses buildFrayArtifact. */
  build?: (sourceDir: string, root: string) => FrayArtifact;
  /** Human-facing lifecycle updates; callers retain control of rendering. */
  onProgress?: (message: string) => void;
}

export interface BuildFrayArtifactOptions {
  /** Human-facing lifecycle updates; successful build-tool output stays deliberately quiet. */
  onProgress?: (message: string) => void;
}

export interface FraySourceSnapshot {
  /** Temporary workspace root; remove this whole directory after the build. */
  dir: string;
  /** Snapshot-local ui workspace consumed by build tools. */
  sourceDir: string;
  /** Canonical checkout path recorded in the artifact manifest. */
  originalSourceDir: string;
  sourceRevision: string;
  sourceFingerprint: string;
}

interface SourceArtifactIdentity {
  source: string;
  revision: string;
  fingerprint: string;
}

export function defaultArtifactRoot(home = homedir()): string {
  return join(home, ".fray", "builds");
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(
  root: string,
  path = root,
  entries: Record<string, string> = {}
): Record<string, string> {
  for (const name of readdirSync(path).sort()) {
    const file = join(path, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) collectFiles(root, file, entries);
    else if (stat.isSymbolicLink())
      entries[relative(root, file)] = `link:${readlinkSync(file)}`;
    else if (stat.isFile()) entries[relative(root, file)] = digestFile(file);
  }
  return entries;
}

function stableFileMap(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

/** The directory name is a commitment to source identity, runtime compatibility, and every file. */
function artifactDigestFromIdentity(identity: {
  sourceDir: string;
  sourceRevision: string;
  sourceFingerprint?: string;
  nodeVersion: string;
  host?: FrayArtifactHost;
  webFiles: Record<string, string>;
  runtimeFiles: Record<string, string>;
  dependencyCell?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: canonicalSourceDir(identity.sourceDir),
        sourceRevision: identity.sourceRevision,
        sourceFingerprint: identity.sourceFingerprint,
        nodeVersion: identity.nodeVersion,
        host: identity.host,
        webFiles: stableFileMap(identity.webFiles),
        runtimeFiles: stableFileMap(identity.runtimeFiles),
        dependencyCell: identity.dependencyCell,
      })
    )
    .digest("hex");
}

/** Compatibility verifier for artifacts built before canonical source identity became part of the key. */
function legacyArtifactDigest(manifest: FrayArtifactManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: basename(manifest.sourceDir),
        sourceRevision: manifest.sourceRevision,
        sourceFingerprint: manifest.sourceFingerprint,
        nodeVersion: manifest.nodeVersion,
        host: manifest.host,
        webFiles: manifest.webFiles,
        runtimeFiles: manifest.runtimeFiles,
        dependencyCell: manifest.dependencyCell,
      })
    )
    .digest("hex");
}

function assertNoExternalArtifactSymlinks(
  root: string,
  path = root,
  allowedExternalTarget?: string
): void {
  for (const name of readdirSync(path)) {
    const file = join(path, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      assertNoExternalArtifactSymlinks(root, file, allowedExternalTarget);
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = resolve(dirname(file), readlinkSync(file));
    if (!containedPath(root, target) && target !== allowedExternalTarget)
      throw new Error(
        `Fray artifact contains a symlink outside its immutable closure: ${relative(root, file)}`
      );
  }
}

function gitRevision(sourceDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function canonicalSourceDir(sourceDir: string): string {
  try {
    return realpathSync(sourceDir);
  } catch {
    return resolve(sourceDir);
  }
}

function workerPluginSourceDir(sourceDir: string): string {
  return resolve(sourceDir, "..", "cc-worker");
}

// cc-worker intentionally shares the board/update implementation with cc. The deploy artifact is
// allowed no source-checkout reach-back, so carry the exact scripts closure beside the plugin at
// runtime/cc/scripts/fray (the shims' existing relative imports resolve there).
function workerPluginCcClosureSourceDir(sourceDir: string): string {
  return resolve(sourceDir, "..", "cc", "scripts", "fray");
}

const WORKER_PLUGIN_REQUIRED_FILES = [
  "cc-worker/.claude-plugin/plugin.json",
  "cc-worker/hooks/session-seed.mjs",
  "cc-worker/hooks/agent-bind.mjs",
  "cc-worker/bin/fray",
  "cc-worker/bin/fray-update",
  "cc/scripts/fray/config.mjs",
  "cc/scripts/fray/agent-bindings.mjs",
  "cc/scripts/fray/index.mjs",
  "cc/scripts/fray/thread-update.mjs",
] as const;

const RUNTIME_PROMPT_REQUIRED_FILES = [
  "prompts/WORKER_PROMPT.md",
  "prompts/WORKER_PROMPT.claude.md",
  "prompts/WORKER_PROMPT.codex.md",
] as const;

function assertWorkerPluginClosure(root: string): void {
  for (const file of WORKER_PLUGIN_REQUIRED_FILES) {
    if (!existsSync(join(root, file)))
      throw new Error(`Fray worker plugin closure is missing ${file}`);
  }
}

function assertRuntimePromptClosure(root: string): void {
  for (const file of RUNTIME_PROMPT_REQUIRED_FILES) {
    if (!existsSync(join(root, file)))
      throw new Error(`Fray runtime prompt closure is missing ${file}`);
  }
}

// Build products and control-plane state must not turn a source edit fingerprint into a moving
// target. Everything else is included, including tracked, staged, unstaged, and relevant untracked
// files, because pnpm/Vite/deploy can consume them without Git knowing about them.
const SOURCE_FINGERPRINT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".fray",
  ".parcel-cache",
  ".turbo",
  ".vite",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
]);

const SOURCE_SNAPSHOT_PREFIX = ".source-snapshot-";
const SOURCE_SNAPSHOT_MAX_ATTEMPTS = 3;
const INTERRUPTED_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEPENDENCY_LINK_CACHE_DIRECTORIES = new Set([".cache", ".vite", ".vite-temp"]);

function ignoredFingerprintFile(name: string): boolean {
  return name === ".DS_Store" || name.endsWith(".tsbuildinfo");
}

/** Deterministic closure key for every source/config/lockfile input that can affect an artifact. */
export function relevantSourceFingerprint(sourceDir: string): string {
  const source = canonicalSourceDir(sourceDir);
  const hash = createHash("sha256");
  hash.update("fray-native-cell-v2\0");
  const visit = (root: string, label: string, directory = root): void => {
    for (const name of readdirSync(directory).sort()) {
      if (ignoredFingerprintFile(name)) continue;
      const file = join(directory, name);
      const stat = lstatSync(file);
      const path = `${label}/${relative(root, file)}`;
      if (stat.isDirectory()) {
        if (SOURCE_FINGERPRINT_IGNORED_DIRECTORIES.has(name)) continue;
        hash.update(`directory\0${path}\0`);
        visit(root, label, file);
      } else if (stat.isSymbolicLink()) {
        hash.update(`link\0${path}\0${readlinkSync(file)}\0`);
      } else if (stat.isFile()) {
        hash.update(`file\0${path}\0`).update(readFileSync(file));
      }
    }
  };
  visit(source, "ui");
  const plugin = workerPluginSourceDir(source);
  if (existsSync(plugin)) visit(plugin, "cc-worker");
  const closure = workerPluginCcClosureSourceDir(source);
  if (existsSync(closure)) visit(closure, "cc/scripts/fray");
  return hash.digest("hex");
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove only snapshots whose creating process is gone (or impossibly old). */
function reapInterruptedSourceSnapshots(root: string): void {
  const now = Date.now();
  for (const name of readdirSync(root)) {
    const match = /^\.source-snapshot-(\d+)-[a-f0-9-]+$/.exec(name);
    if (!match) continue;
    const path = join(root, name);
    const pid = Number(match[1]);
    let expired = false;
    try {
      expired = now - lstatSync(path).mtimeMs > INTERRUPTED_SNAPSHOT_MAX_AGE_MS;
    } catch {
      continue;
    }
    if (pid === process.pid || !pidIsAlive(pid) || expired)
      rmSync(path, { recursive: true, force: true });
  }
}

interface SnapshotTree {
  source: string;
  destination: string;
}

function containedPath(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

/**
 * Clone one relevant source tree. APFS clonefile makes regular files copy-on-write on macOS; other
 * filesystems honestly fall back to an ordinary copy. Source symlinks are allowed only when their
 * relative target is another captured source input, so no snapshot can reach back into mutable
 * checkout source.
 */
function cloneRelevantSourceTree(
  tree: SnapshotTree,
  trees: readonly SnapshotTree[],
  directory = tree.source
): void {
  const destinationDirectory = join(tree.destination, relative(tree.source, directory));
  mkdirSync(destinationDirectory, { recursive: true });
  for (const name of readdirSync(directory).sort()) {
    if (ignoredFingerprintFile(name)) continue;
    const sourcePath = join(directory, name);
    const destinationPath = join(destinationDirectory, name);
    const stat = lstatSync(sourcePath);
    if (stat.isDirectory()) {
      if (SOURCE_FINGERPRINT_IGNORED_DIRECTORIES.has(name)) continue;
      cloneRelevantSourceTree(tree, trees, sourcePath);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(sourcePath);
      if (isAbsolute(target))
        throw new Error(`Fray source snapshot cannot retain absolute symlink ${sourcePath}`);
      const resolvedTarget = resolve(dirname(sourcePath), target);
      const targetTree = trees.find((candidate) => containedPath(candidate.source, resolvedTarget));
      if (!targetTree)
        throw new Error(
          `Fray source snapshot cannot retain symlink ${sourcePath} outside the captured source closure`
        );
      const snapshotTarget = join(
        targetTree.destination,
        relative(targetTree.source, resolvedTarget)
      );
      symlinkSync(relative(dirname(destinationPath), snapshotTarget), destinationPath);
      continue;
    }
    if (stat.isFile())
      copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE);
  }
}

/**
 * Build tools need the already-installed native dependency graph. Keep its root store shared and
 * read-only by convention, while recreating package-level link farms inside the snapshot so their
 * workspace links resolve to snapshot source. An install that mutates node_modules concurrently is
 * outside the source-snapshot guarantee; the lockfile remains part of the source fingerprint and a
 * dependency-changing install must complete before launching fray-dev.
 */
function attachInstalledDependencyClosure(source: string, snapshot: string): void {
  const installed = join(source, "node_modules");
  if (!existsSync(installed))
    throw new Error("Fray source dependencies are not installed; run the project install first");
  symlinkSync(installed, join(snapshot, "node_modules"), "dir");
  const packages = join(source, "packages");
  if (!existsSync(packages)) return;
  for (const name of readdirSync(packages)) {
    const packageModules = join(packages, name, "node_modules");
    if (!existsSync(packageModules)) continue;
    cpSync(packageModules, join(snapshot, "packages", name, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => {
        if (path === packageModules) return true;
        const entry = basename(path);
        return !DEPENDENCY_LINK_CACHE_DIRECTORIES.has(entry);
      },
    });
  }
}

/** Capture a coherent launch-owned source closure before any slow build command starts. */
export function captureFraySourceSnapshot(
  sourceDir: string,
  root = defaultArtifactRoot()
): FraySourceSnapshot {
  const source = canonicalSourceDir(sourceDir);
  const parent = resolve(source, "..");
  assertWorkerPluginClosure(parent);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  reapInterruptedSourceSnapshots(root);
  let lastFailure = "source changed during capture";
  for (let attempt = 1; attempt <= SOURCE_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    const dir = join(root, `${SOURCE_SNAPSHOT_PREFIX}${process.pid}-${randomUUID()}`);
    const snapshotSource = join(dir, "ui");
    const trees: SnapshotTree[] = [
      { source, destination: snapshotSource },
      { source: workerPluginSourceDir(source), destination: join(dir, "cc-worker") },
      {
        source: workerPluginCcClosureSourceDir(source),
        destination: join(dir, "cc", "scripts", "fray"),
      },
    ];
    try {
      const beforeRevision = gitRevision(source);
      const beforeFingerprint = relevantSourceFingerprint(source);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const tree of trees) cloneRelevantSourceTree(tree, trees);
      const snapshotFingerprint = relevantSourceFingerprint(snapshotSource);
      const afterFingerprint = relevantSourceFingerprint(source);
      const afterRevision = gitRevision(source);
      if (
        beforeRevision !== afterRevision ||
        beforeFingerprint !== snapshotFingerprint ||
        beforeFingerprint !== afterFingerprint
      ) {
        lastFailure = "source changed during capture";
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      attachInstalledDependencyClosure(source, snapshotSource);
      return {
        dir,
        sourceDir: snapshotSource,
        originalSourceDir: source,
        sourceRevision: beforeRevision,
        sourceFingerprint: beforeFingerprint,
      };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      lastFailure = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object"
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (
        !lastFailure.includes("changed during capture") &&
        !["ENOENT", "ENOTDIR", "EISDIR", "ESTALE"].includes(code ?? "")
      )
        throw error;
      lastFailure = `${lastFailure} (source changed during capture)`;
    }
  }
  throw new Error(
    `Fray source did not remain stable long enough to capture after ${SOURCE_SNAPSHOT_MAX_ATTEMPTS} attempts: ${lastFailure}`
  );
}

function writeAtomic(path: string, value: unknown): void {
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(staging, path);
}

function validArtifactRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    containedPath("/fray-artifact-root", resolve("/fray-artifact-root", path)) &&
    resolve("/fray-artifact-root", path) !== "/fray-artifact-root"
  );
}

function validArtifactFileMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([path, digest]) =>
      validArtifactRelativePath(path) &&
      typeof digest === "string" &&
      (/^[a-f0-9]{64}$/.test(digest) || /^link:.+/.test(digest))
  );
}

function validArtifactManifest(
  manifest: unknown,
  digest: string
): manifest is FrayArtifactManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const value = manifest as Partial<FrayArtifactManifest>;
  const host = value.host;
  return (
    (value.version === 1 || value.version === 2) &&
    value.digest === digest &&
    typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.sourceDir === "string" && value.sourceDir.length > 0 && isAbsolute(value.sourceDir) &&
    typeof value.sourceRevision === "string" && value.sourceRevision.length > 0 &&
    (value.sourceFingerprint === undefined || /^[a-f0-9]{64}$/.test(value.sourceFingerprint)) &&
    typeof value.nodeVersion === "string" && value.nodeVersion.length > 0 &&
    validArtifactFileMap(value.webFiles) && validArtifactFileMap(value.runtimeFiles) &&
    (value.dependencyCell === undefined || /^[a-f0-9]{64}$/.test(value.dependencyCell)) &&
    (host === undefined ||
      (!!host &&
        typeof host.platform === "string" && host.platform.length > 0 &&
        typeof host.arch === "string" && host.arch.length > 0 &&
        Number.isSafeInteger(host.nodeMajor) && host.nodeMajor > 0 &&
        typeof host.nodeModules === "string" && /^\d+$/.test(host.nodeModules)))
  );
}

/** Build a deployable server/runtime closure plus static web into one content-addressed directory. */
function commandFailureOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { stdout?: Buffer | string; stderr?: Buffer | string };
  return [record.stdout, record.stderr]
    .filter((value): value is Buffer | string => value !== undefined)
    .map((value) => value.toString().trim())
    .filter(Boolean)
    .join("\n")
    .slice(-4_000);
}

function runArtifactCommand(args: string[], source: string): void {
  try {
    // Nub owns the build execution so both Vite/Rolldown and esbuild run through the same Node 26
    // loader contract as the source launcher. Successful tool chatter stays hidden behind the
    // launcher progress UI, while failures retain their useful trailing output.
    execFileSync("nub", ["--cwd", source, ...args], {
      cwd: source,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = commandFailureOutput(error);
    throw new Error(
      `Command failed: nub ${args.join(" ")} from ${source}${
        detail ? `\n${detail}` : ""
      }`
    );
  }
}

const RUNTIME_NATIVE_EXTERNALS = [
  "better-sqlite3",
  "node-pty",
  "@parcel/watcher",
] as const;

interface FrayDependencyCellManifest {
  version: 1;
  digest: string;
  createdAt: string;
  host: FrayArtifactHost;
  inputs: string;
  files: Record<string, string>;
}

interface FrayDependencyCell {
  digest: string;
  dir: string;
  modulesDir: string;
  manifest: FrayDependencyCellManifest;
}

function dependencyCellRoot(root: string): string {
  return join(root, "cells");
}

function dependencyCellInputs(source: string, host: FrayArtifactHost): string {
  const inputs = [
    "package.json",
    "pnpm-lock.yaml",
    "packages/cli/package.json",
    "packages/server/package.json",
    "packages/shared/package.json",
    "packages/rpc/package.json",
  ];
  const hash = createHash("sha256");
  for (const input of inputs) {
    const file = join(source, input);
    hash.update(`${input}\0`);
    if (existsSync(file)) hash.update(readFileSync(file));
    else hash.update("<absent>");
  }
  hash.update(`host\0${JSON.stringify(host)}`);
  return hash.digest("hex");
}

function dependencyCellDigest(inputs: string, files: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify({ inputs, files: stableFileMap(files) }))
    .digest("hex");
}

function validDependencyCellManifest(
  manifest: unknown,
  digest: string
): manifest is FrayDependencyCellManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const value = manifest as Partial<FrayDependencyCellManifest>;
  return value.version === 1 && value.digest === digest &&
    typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.inputs === "string" && /^[a-f0-9]{64}$/.test(value.inputs) &&
    validArtifactFileMap(value.files) &&
    artifactHostMatches(value.host, currentArtifactHost());
}

function readFrayDependencyCell(digest: string, root: string): FrayDependencyCell {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid Fray dependency cell digest");
  const dir = join(dependencyCellRoot(root), digest);
  let manifest: FrayDependencyCellManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`Fray dependency cell ${digest} is missing its manifest`);
  }
  if (!validDependencyCellManifest(manifest, digest) ||
    dependencyCellDigest(manifest.inputs, manifest.files) !== digest ||
    !existsSync(join(dir, "node_modules")))
    throw new Error(`Fray dependency cell ${digest} failed manifest validation`);
  try {
    assertNoExternalArtifactSymlinks(join(dir, "node_modules"));
  } catch {
    throw new Error(`Fray dependency cell ${digest} failed immutable closure validation`);
  }
  for (const [file, expected] of Object.entries(manifest.files)) {
    const path = join(dir, file);
    const valid = expected.startsWith("link:")
      ? (() => { try { return lstatSync(path).isSymbolicLink() && `link:${readlinkSync(path)}` === expected; } catch { return false; } })()
      : existsSync(path) && digestFile(path) === expected;
    if (!valid) throw new Error(`Fray dependency cell ${digest} has a changed or missing file: ${file}`);
  }
  return { digest, dir, modulesDir: join(dir, "node_modules"), manifest };
}

function packageDirectory(requireFrom: NodeRequire, name: string): string {
  try {
    return dirname(requireFrom.resolve(`${name}/package.json`));
  } catch {
    // A few packages intentionally do not export their package metadata. Their entry still has a
    // conventional nearest package.json, which is sufficient for copying the exact resolved copy.
    let directory = dirname(requireFrom.resolve(name));
    while (dirname(directory) !== directory) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name)
        return directory;
      directory = dirname(directory);
    }
    throw new Error(`unable to locate package root for ${name}`);
  }
}

function copyResolvedPackageClosure(source: string, modules: string): void {
  const serverRequire = createRequire(join(source, "packages", "server", "package.json"));
  const copied = new Set<string>();
  const copyPackage = (name: string, requireFrom: NodeRequire, optional = false): void => {
    if (copied.has(name)) return;
    let packageDir: string;
    try {
      packageDir = realpathSync(packageDirectory(requireFrom, name));
    } catch (error) {
      if (optional) return;
      throw error;
    }
    copied.add(name);
    const destination = join(modules, ...name.split("/"));
    const nativePrebuild = `${platform()}-${arch()}`;
    cpSync(packageDir, destination, {
      recursive: true,
      preserveTimestamps: true,
      filter: (path) => {
        if (path === packageDir) return true;
        const relativePath = relative(packageDir, path);
        if (relativePath === "node_modules" || relativePath.startsWith(`node_modules${sep}`)) return false;
        // node-pty publishes every OS's native binaries (and large Windows debug symbols) in one
        // package. A cell is host-bound, so retain only the exact platform/architecture loader.
        if (relativePath.startsWith(`prebuilds${sep}`)) {
          const [prebuild] = relativePath.slice(`prebuilds${sep}`.length).split(sep);
          return prebuild === nativePrebuild;
        }
        return true;
      },
    });
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const packageRequire = createRequire(join(packageDir, "package.json"));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort())
      copyPackage(dependency, packageRequire);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort())
      copyPackage(dependency, packageRequire, true);
  };
  for (const dependency of RUNTIME_NATIVE_EXTERNALS) copyPackage(dependency, serverRequire);
}

function ensureFrayDependencyCell(source: string, root: string): FrayDependencyCell {
  const host = currentArtifactHost();
  const inputs = dependencyCellInputs(source, host);
  const cells = dependencyCellRoot(root);
  mkdirSync(cells, { recursive: true, mode: 0o700 });
  // The input digest narrows the scan without assuming dependency-cell output names in advance.
  for (const entry of readdirSync(cells)) {
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
    try {
      const cell = readFrayDependencyCell(entry, root);
      if (cell.manifest.inputs === inputs) return cell;
    } catch {}
  }
  const staging = join(cells, `.staging-${process.pid}-${randomUUID()}`);
  try {
    const modules = join(staging, "node_modules");
    mkdirSync(modules, { recursive: true, mode: 0o700 });
    copyResolvedPackageClosure(source, modules);
    assertNoExternalArtifactSymlinks(modules);
    const files = collectFiles(staging);
    const digest = dependencyCellDigest(inputs, files);
    const manifest: FrayDependencyCellManifest = {
      version: 1, digest, createdAt: new Date().toISOString(), host, inputs, files,
    };
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    const destination = join(cells, digest);
    try { renameSync(staging, destination); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      rmSync(staging, { recursive: true, force: true });
    }
    return readFrayDependencyCell(digest, root);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Publish a completed staging directory; an identical concurrent publisher wins safely. */
export function publishFrayArtifactStaging(
  staging: string,
  digest: string,
  root = defaultArtifactRoot()
): FrayArtifact {
  const dir = join(root, digest);
  try {
    renameSync(staging, dir);
  } catch (error) {
    // Another identical builder may publish between our existence check and rename. Its complete
    // immutable directory is the winner; validate it rather than reporting a spurious failure.
    // macOS reports the same destination-won directory race as ENOTEMPTY.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    rmSync(staging, { recursive: true, force: true });
  }
  return readFrayArtifact(digest, root);
}

export function buildFrayArtifact(
  sourceDir: string,
  root = defaultArtifactRoot(),
  options: BuildFrayArtifactOptions = {}
): FrayArtifact {
  options.onProgress?.("Capturing current Fray source");
  const snapshot = captureFraySourceSnapshot(sourceDir, root);
  const source = snapshot.sourceDir;
  const workerPlugin = workerPluginSourceDir(source);
  const workerPluginCcClosure = workerPluginCcClosureSourceDir(source);
  const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
  try {
    options.onProgress?.("Building immutable artifact: web UI");
    runArtifactCommand(["run", "--filter", "@fray-ui/web", "build"], source);
    const webSource = join(source, "packages", "web", "dist");
    if (!existsSync(webSource))
      throw new Error("Fray web build did not produce packages/web/dist");
    mkdirSync(staging, { mode: 0o700 });
    // esbuild absorbs Fray's CLI, server and workspace code into one Node 26 ESM entry. Only the
    // native loaders stay external; their complete host-specific closure lives in an immutable cell
    // below, never in the mutable source checkout or an enormous deploy tree.
    options.onProgress?.("Building immutable artifact: bundled runtime");
    mkdirSync(join(staging, "runtime", "src"), { recursive: true, mode: 0o700 });
    runArtifactCommand(
      [
        "packages/cli/scripts/build-runtime.mjs",
        join(staging, "runtime", "src", "index.js"),
      ],
      source
    );
    options.onProgress?.("Finalizing immutable artifact");
    const cell = ensureFrayDependencyCell(source, root);
    symlinkSync(relative(join(staging, "runtime"), cell.modulesDir), join(staging, "runtime", "node_modules"), "dir");
    // dispatch.ts resolves four parents above the deployed server module, which lands at this
    // runtime root. Keep the plugin inside the verified runtime closure rather than pointing a
    // promoted server back at mutable checkout source.
    cpSync(workerPlugin, join(staging, "runtime", "cc-worker"), {
      recursive: true,
      preserveTimestamps: true,
    });
    cpSync(workerPluginCcClosure, join(staging, "runtime", "cc", "scripts", "fray"), {
      recursive: true,
      preserveTimestamps: true,
    });
    const promptSource = ["WORKER_PROMPT.md", "WORKER_PROMPT.claude.md", "WORKER_PROMPT.codex.md"];
    for (const prompt of promptSource) {
      const from = join(source, prompt);
      if (!existsSync(from)) throw new Error(`Fray worker prompt is missing ${prompt}`);
      mkdirSync(join(staging, "runtime", "prompts"), { recursive: true, mode: 0o700 });
      copyFileSync(from, join(staging, "runtime", "prompts", prompt));
    }
    assertWorkerPluginClosure(join(staging, "runtime"));
    assertRuntimePromptClosure(join(staging, "runtime"));
    cpSync(webSource, join(staging, "web"), {
      recursive: true,
      preserveTimestamps: true,
    });
    const webFiles = collectFiles(join(staging, "web"));
    const runtimeFiles = collectFiles(join(staging, "runtime"));
    const digest = artifactDigestFromIdentity({
      sourceDir: snapshot.originalSourceDir,
      sourceRevision: snapshot.sourceRevision,
      sourceFingerprint: snapshot.sourceFingerprint,
      nodeVersion: process.version,
      host: currentArtifactHost(),
      webFiles,
      runtimeFiles,
      dependencyCell: cell.digest,
    });
    const dir = join(root, digest);
    if (existsSync(join(dir, "manifest.json"))) {
      rmSync(staging, { recursive: true, force: true });
      return readFrayArtifact(digest, root);
    }
    const manifest: FrayArtifactManifest = {
      version: 2,
      digest,
      createdAt: new Date().toISOString(),
      sourceDir: snapshot.originalSourceDir,
      sourceRevision: snapshot.sourceRevision,
      sourceFingerprint: snapshot.sourceFingerprint,
      nodeVersion: process.version,
      host: currentArtifactHost(),
      webFiles,
      runtimeFiles,
      dependencyCell: cell.digest,
    };
    writeFileSync(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o400 }
    );
    return publishFrayArtifactStaging(staging, digest, root);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
}

export function readFrayArtifact(
  digest: string,
  root = defaultArtifactRoot()
): FrayArtifact {
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw new Error("invalid Fray artifact digest");
  const dir = join(root, digest);
  const manifestPath = join(dir, "manifest.json");
  let manifest: FrayArtifactManifest;
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as FrayArtifactManifest;
  } catch {
    throw new Error(`Fray artifact ${digest} is missing its manifest`);
  }
  if (!validArtifactManifest(manifest, digest) ||
    (manifest.version === 2 && !manifest.dependencyCell) ||
    !WORKER_PLUGIN_REQUIRED_FILES.every((file) => manifest.runtimeFiles[file]) ||
    !RUNTIME_PROMPT_REQUIRED_FILES.every((file) => manifest.runtimeFiles[file]) ||
    !existsSync(join(dir, "web")) ||
    !existsSync(join(dir, "runtime", "src", "index.js"))
  ) {
    throw new Error(`Fray artifact ${digest} failed manifest validation`);
  }
  const calculated = artifactDigestFromIdentity(manifest);
  // Existing v1 artifacts used the checkout basename. They remain readable, but source matching
  // below still requires the canonical path, so a collision cannot be selected for a new checkout.
  if (calculated !== digest && legacyArtifactDigest(manifest) !== digest)
    throw new Error(`Fray artifact ${digest} failed root digest validation (calculated ${calculated})`);
  try {
    assertWorkerPluginClosure(join(dir, "runtime"));
    assertRuntimePromptClosure(join(dir, "runtime"));
    const cell = manifest.dependencyCell
      ? readFrayDependencyCell(manifest.dependencyCell, root)
      : undefined;
    const modules = join(dir, "runtime", "node_modules");
    if (cell && (!lstatSync(modules).isSymbolicLink() ||
      resolve(dirname(modules), readlinkSync(modules)) !== cell.modulesDir))
      throw new Error("artifact runtime dependency cell link does not match its manifest");
    assertNoExternalArtifactSymlinks(join(dir, "runtime"), join(dir, "runtime"), cell?.modulesDir);
    assertNoExternalArtifactSymlinks(join(dir, "web"));
  } catch {
    throw new Error(`Fray artifact ${digest} failed immutable closure validation`);
  }
  for (const [file, expected] of Object.entries(manifest.webFiles)) {
    const path = join(dir, "web", file);
    const valid = expected.startsWith("link:")
      ? (() => {
          try {
            return (
              lstatSync(path).isSymbolicLink() &&
              `link:${readlinkSync(path)}` === expected
            );
          } catch {
            return false;
          }
        })()
      : existsSync(path) && digestFile(path) === expected;
    if (!valid)
      throw new Error(
        `Fray artifact ${digest} has a changed or missing web file: ${file}`
      );
  }
  for (const [file, expected] of Object.entries(manifest.runtimeFiles)) {
    const path = join(dir, "runtime", file);
    const valid = expected.startsWith("link:")
      ? (() => {
          try {
            return (
              lstatSync(path).isSymbolicLink() &&
              `link:${readlinkSync(path)}` === expected
            );
          } catch {
            return false;
          }
        })()
      : existsSync(path) && digestFile(path) === expected;
    if (!valid)
      throw new Error(
        `Fray artifact ${digest} has a changed or missing runtime file: ${file}`
      );
  }
  return {
    digest,
    dir,
    webDir: join(dir, "web"),
    runtimeDir: join(dir, "runtime"),
    manifest,
  };
}

export function readStableArtifact(
  stateDir: string,
  root = defaultArtifactRoot()
): FrayArtifact | null {
  try {
    const pointer = JSON.parse(
      readFileSync(join(stateDir, "stable.json"), "utf8")
    ) as StableArtifactPointer;
    if (pointer.version !== 1 || typeof pointer.current !== "string")
      return null;
    return readFrayArtifact(pointer.current, root);
  } catch {
    return null;
  }
}

function currentSourceArtifactIdentity(sourceDir: string): SourceArtifactIdentity {
  const source = canonicalSourceDir(sourceDir);
  return {
    source,
    revision: gitRevision(source),
    fingerprint: relevantSourceFingerprint(source),
  };
}

function manifestMatchesSource(
  manifest: Pick<FrayArtifactManifest, "sourceDir" | "sourceRevision" | "sourceFingerprint">,
  source: SourceArtifactIdentity
): boolean {
  return (
    canonicalSourceDir(manifest.sourceDir) === source.source &&
    manifest.sourceRevision === source.revision &&
    manifest.sourceFingerprint === source.fingerprint
  );
}

/** Read only enough metadata to narrow a global cache scan; final candidates still receive full verification. */
function readArtifactManifestCandidate(
  digest: string,
  root: string
): FrayArtifactManifest | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, digest, "manifest.json"), "utf8")
    ) as FrayArtifactManifest;
    return validArtifactManifest(manifest, digest) ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Select an already verified artifact produced from the current canonical launcher source.
 * A project-local pointer is deliberately not required: artifacts are content-addressed globally,
 * while the pointer only records this project's selected, rollback-safe version.
 */
export function findReusableFrayArtifact(
  sourceDir: string,
  root = defaultArtifactRoot(),
  sourceIdentity?: SourceArtifactIdentity
): FrayArtifact | null {
  if (!existsSync(root)) return null;
  const source = sourceIdentity ?? currentSourceArtifactIdentity(sourceDir);
  const candidates: Array<{ digest: string; createdAt: string }> = [];
  for (const entry of readdirSync(root)) {
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
    const manifest = readArtifactManifestCandidate(entry, root);
    if (
      manifest &&
      manifestMatchesSource(manifest, source) &&
      artifactHostMatches(manifest.host, currentArtifactHost())
    )
      candidates.push({ digest: entry, createdAt: manifest.createdAt });
  }
  candidates.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.digest.localeCompare(a.digest)
  );
  for (const candidate of candidates) {
    try {
      const artifact = readFrayArtifact(candidate.digest, root);
      if (
        manifestMatchesSource(artifact.manifest, source) &&
        artifactHostMatches(artifact.manifest.host, currentArtifactHost())
      )
        return artifact;
    } catch {
      // A corrupt matching candidate is skipped; unrelated cache entries were never hashed.
    }
  }
  return null;
}

/**
 * A workspace pointer is a convenient rollback record, not permission to serve an old checkout.
 * Compare it to the source closure at each fresh supervisor launch so `fray-dev` can keep its
 * no-HMR promise while still picking up edits after the user deliberately stops and relaunches.
 */
export function artifactMatchesCurrentSource(
  artifact: Pick<FrayArtifact, "manifest">,
  sourceDir: string
): boolean {
  return artifactHostMatches(artifact.manifest.host, currentArtifactHost()) && manifestMatchesSource(
    artifact.manifest,
    currentSourceArtifactIdentity(sourceDir)
  );
}

/**
 * Make ordinary first launch self-contained without ever serving checkout source or HMR. A healthy
 * running supervisor retains its immutable snapshot; after it is stopped, the next launch selects
 * only a verified artifact made from the checkout's current source closure. It reuses a global
 * candidate when possible, otherwise builds and atomically promotes a complete candidate.
 */
export function ensureStableFrayArtifact(
  stateDir: string,
  sourceDir: string,
  root = defaultArtifactRoot(),
  options: EnsureStableArtifactOptions = {}
): FrayArtifact {
  options.onProgress?.("Checking current workspace artifact");
  const source = currentSourceArtifactIdentity(sourceDir);
  const selected = readStableArtifact(stateDir, root);
  if (
    selected &&
    artifactHostMatches(selected.manifest.host, currentArtifactHost()) &&
    manifestMatchesSource(selected.manifest, source)
  ) {
    options.onProgress?.("Reusing current immutable artifact");
    return selected;
  }
  options.onProgress?.("Checking verified artifact cache");
  const reusable = findReusableFrayArtifact(sourceDir, root, source);
  const artifact = reusable
    ? (() => {
        options.onProgress?.("Reusing cached immutable artifact");
        return reusable;
      })()
    : (() => {
        options.onProgress?.("No matching artifact found; building immutable artifact");
        return options.build
          ? options.build(sourceDir, root)
          : buildFrayArtifact(sourceDir, root, { onProgress: options.onProgress });
      })();
  options.onProgress?.("Promoting verified immutable artifact");
  promoteFrayArtifact(stateDir, artifact.digest, root);
  return artifact;
}

/** Atomically select a verified artifact. The old current digest remains the single rollback slot. */
export function promoteFrayArtifact(
  stateDir: string,
  digest: string,
  root = defaultArtifactRoot()
): StableArtifactPointer {
  readFrayArtifact(digest, root);
  let previous: string | undefined;
  try {
    const old = JSON.parse(
      readFileSync(join(stateDir, "stable.json"), "utf8")
    ) as StableArtifactPointer;
    // Do not retain a broken pointer as the rollback target when repairing a damaged selection.
    if (typeof old.current === "string")
      previous = readFrayArtifact(old.current, root).digest;
  } catch {}
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pointer: StableArtifactPointer = {
    version: 1,
    current: digest,
    ...(previous && previous !== digest ? { previous } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(join(stateDir, "stable.json"), pointer);
  return pointer;
}
