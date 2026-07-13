#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";

import {
  inspectNativeRouting,
  installNativeRouting,
} from "../codex/skills/fray-orchestrator/scripts/configure-native-routing.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_NAME = "fray-orchestrator";
export const LEGACY_SKILL_NAME = "fray";
export const CANONICAL_SKILL_ROOT = join(REPO_ROOT, "codex", "skills", SKILL_NAME);

const REQUIRED_FILES = ["SKILL.md", join("agents", "openai.yaml")];

function defaultCodexHome() {
  return resolve(process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex"));
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeIfPresent(path, removePath = rm) {
  try {
    await removePath(path, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function retireRecognizedLegacySkill({ codexHome, renamePath, log, warn }) {
  const legacyRoot = join(codexHome, "skills", LEGACY_SKILL_NAME);
  const legacyInfo = await pathInfo(legacyRoot);
  if (!legacyInfo) return { changed: false, legacyRoot };
  if (!legacyInfo.isDirectory()) {
    warn(`left unrecognized legacy path in place: ${legacyRoot}`);
    return { changed: false, legacyRoot, unrecognized: true };
  }

  let skillText;
  try {
    skillText = await readFile(join(legacyRoot, "SKILL.md"), "utf8");
  } catch {
    warn(`left unrecognized legacy skill in place: ${legacyRoot}`);
    return { changed: false, legacyRoot, unrecognized: true };
  }
  const legacyFrontmatter = /^---\s*$[\s\S]*?^name:\s*fray\s*$[\s\S]*?^---\s*$/m.test(skillText);
  const legacyHeading = /^# Fray\s*$/m.test(skillText);
  if (!legacyFrontmatter || !legacyHeading) {
    warn(`left unrecognized legacy skill in place: ${legacyRoot}`);
    return { changed: false, legacyRoot, unrecognized: true };
  }

  const archiveRoot = join(codexHome, "legacy-skills");
  await mkdir(archiveRoot, { recursive: true, mode: 0o755 });
  const archivedRoot = join(
    archiveRoot,
    `${LEGACY_SKILL_NAME}-retired-for-${SKILL_NAME}-${randomUUID()}`,
  );
  await renamePath(legacyRoot, archivedRoot);
  log(`retired legacy ${legacyRoot} -> ${archivedRoot}`);
  return { changed: true, legacyRoot, archivedRoot };
}

async function collectTree(root) {
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error(`canonical skill is not a directory: ${root}`);

  const items = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        const info = await stat(absolutePath);
        items.push({ kind: "directory", relativePath, mode: info.mode & 0o777 });
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        items.push({ kind: "file", relativePath });
      } else {
        throw new Error(`canonical skill contains an unsupported entry: ${absolutePath}`);
      }
    }
  }

  await visit(root);
  return { mode: rootInfo.mode & 0o777, items };
}

async function validateCanonicalSource(sourceRoot) {
  const tree = await collectTree(sourceRoot);
  for (const relativePath of REQUIRED_FILES) {
    const info = await stat(join(sourceRoot, relativePath));
    if (!info.isFile()) throw new Error(`required canonical file is missing: ${relativePath}`);
  }
  return tree;
}

async function preflightHardlink({ sourceRoot, skillsRoot, linkFile }) {
  await mkdir(skillsRoot, { recursive: true, mode: 0o755 });
  const source = join(sourceRoot, REQUIRED_FILES[0]);
  const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(skillsRoot)]);
  if (sourceInfo.dev !== destinationInfo.dev) {
    throw new Error(
      `hardlinks require one filesystem: canonical device ${sourceInfo.dev}, destination device ${destinationInfo.dev}`,
    );
  }

  const probe = join(skillsRoot, `.${SKILL_NAME}-hardlink-probe-${process.pid}-${randomUUID()}`);
  try {
    await linkFile(source, probe);
    const probeInfo = await stat(probe);
    if (probeInfo.dev !== sourceInfo.dev || probeInfo.ino !== sourceInfo.ino) {
      throw new Error("hardlink probe did not preserve canonical device and inode");
    }
  } catch (error) {
    throw new Error(`hardlink preflight failed before changing the active install: ${error.message}`, {
      cause: error,
    });
  } finally {
    try {
      await unlink(probe);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function buildInstall({ sourceRoot, tempRoot, tree, linkFile }) {
  await mkdir(tempRoot, { mode: tree.mode });
  await chmod(tempRoot, tree.mode);

  for (const item of tree.items) {
    const destination = join(tempRoot, item.relativePath);
    if (item.kind === "directory") {
      await mkdir(destination, { mode: item.mode });
      await chmod(destination, item.mode);
      continue;
    }

    const source = join(sourceRoot, item.relativePath);
    await linkFile(source, destination);
    const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destination)]);
    if (sourceInfo.dev !== destinationInfo.dev || sourceInfo.ino !== destinationInfo.ino) {
      throw new Error(`built file is not a canonical hardlink: ${item.relativePath}`);
    }
  }
}

export async function inspectInstall({
  sourceRoot = CANONICAL_SKILL_ROOT,
  codexHome = defaultCodexHome(),
} = {}) {
  const destinationRoot = join(resolve(codexHome), "skills", SKILL_NAME);
  const problems = [];
  let tree;
  try {
    tree = await validateCanonicalSource(sourceRoot);
  } catch (error) {
    return { ok: false, destinationRoot, problems: [error.message] };
  }

  const destinationInfo = await pathInfo(destinationRoot);
  if (!destinationInfo?.isDirectory()) {
    return { ok: false, destinationRoot, problems: [`install is not a directory: ${destinationRoot}`] };
  }

  let destinationTree;
  try {
    destinationTree = await collectTree(destinationRoot);
  } catch (error) {
    return { ok: false, destinationRoot, problems: [error.message] };
  }

  const expectedShape = tree.items.map(({ kind, relativePath }) => `${kind}:${relativePath}`);
  const actualShape = destinationTree.items.map(({ kind, relativePath }) => `${kind}:${relativePath}`);
  if (expectedShape.join("\n") !== actualShape.join("\n")) {
    problems.push("installed directory layout differs from the canonical skill");
  }

  for (const item of tree.items.filter((entry) => entry.kind === "file")) {
    try {
      const [sourceInfo, installedInfo] = await Promise.all([
        stat(join(sourceRoot, item.relativePath)),
        stat(join(destinationRoot, item.relativePath)),
      ]);
      if (sourceInfo.dev !== installedInfo.dev || sourceInfo.ino !== installedInfo.ino) {
        problems.push(`not hardlinked to canonical source: ${item.relativePath}`);
      }
    } catch (error) {
      problems.push(`${item.relativePath}: ${error.message}`);
    }
  }

  return { ok: problems.length === 0, destinationRoot, problems };
}

async function activateInstall({ tempRoot, destinationRoot, renamePath, removePath, verify, warn }) {
  const parent = dirname(destinationRoot);
  const backupRoot = join(parent, `.${SKILL_NAME}-backup-${process.pid}-${randomUUID()}`);
  const previous = await pathInfo(destinationRoot);
  let previousMoved = false;
  let candidateMoved = false;

  try {
    if (previous) {
      await renamePath(destinationRoot, backupRoot);
      previousMoved = true;
    }
    await renamePath(tempRoot, destinationRoot);
    candidateMoved = true;
    await verify();
  } catch (error) {
    const rollbackErrors = [];
    if (candidateMoved) {
      try {
        await renamePath(destinationRoot, tempRoot);
        candidateMoved = false;
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`could not move failed candidate aside: ${rollbackError.message}`));
      }
    }
    if (previousMoved && !candidateMoved) {
      try {
        await renamePath(backupRoot, destinationRoot);
        previousMoved = false;
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`could not restore previous install at ${backupRoot}: ${rollbackError.message}`));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "install activation failed and rollback was incomplete");
    }
    throw error;
  }

  if (previousMoved) {
    try {
      await removeIfPresent(backupRoot, removePath);
    } catch (error) {
      warn(`new install is active, but old backup cleanup failed at ${backupRoot}: ${error.message}`);
    }
  }
}

export async function installSkill({
  sourceRoot = CANONICAL_SKILL_ROOT,
  codexHome = defaultCodexHome(),
  linkFile = link,
  renamePath = rename,
  removePath = rm,
  log = console.log,
  warn = console.warn,
} = {}) {
  const resolvedHome = resolve(codexHome);
  const skillsRoot = join(resolvedHome, "skills");
  const destinationRoot = join(skillsRoot, SKILL_NAME);
  const tree = await validateCanonicalSource(sourceRoot);

  await preflightHardlink({ sourceRoot, skillsRoot, linkFile });

  const tempRoot = join(skillsRoot, `.${SKILL_NAME}-install-${process.pid}-${randomUUID()}`);
  try {
    await buildInstall({ sourceRoot, tempRoot, tree, linkFile });
    await activateInstall({
      tempRoot,
      destinationRoot,
      renamePath,
      removePath,
      warn,
      verify: async () => {
        const result = await inspectInstall({ sourceRoot, codexHome: resolvedHome });
        if (!result.ok) throw new Error(`candidate verification failed: ${result.problems.join("; ")}`);
      },
    });
  } finally {
    await removeIfPresent(tempRoot, removePath);
  }

  const legacy = await retireRecognizedLegacySkill({
    codexHome: resolvedHome,
    renamePath,
    log,
    warn,
  });
  log(`linked ${relative(REPO_ROOT, sourceRoot)} -> ${destinationRoot}`);
  return { destinationRoot, legacy };
}

export async function uninstallSkill({
  codexHome = defaultCodexHome(),
  renamePath = rename,
  removePath = rm,
  log = console.log,
} = {}) {
  const destinationRoot = join(resolve(codexHome), "skills", SKILL_NAME);
  if (!(await pathInfo(destinationRoot))) {
    log(`already uninstalled: ${destinationRoot}`);
    return { changed: false, destinationRoot };
  }

  const quarantine = join(dirname(destinationRoot), `.${SKILL_NAME}-uninstall-${process.pid}-${randomUUID()}`);
  await renamePath(destinationRoot, quarantine);
  try {
    await removeIfPresent(quarantine, removePath);
  } catch (error) {
    throw new Error(`skill was removed from discovery, but cleanup failed at ${quarantine}: ${error.message}`, {
      cause: error,
    });
  }
  log(`uninstalled ${destinationRoot}`);
  return { changed: true, destinationRoot };
}

function usage() {
  return `usage: node scripts/install-codex-skill.mjs [install|relink|update|check|uninstall] [--codex-home PATH]

install, relink, and update rebuild ~/.codex/skills/fray-orchestrator through a temporary,
rollback-capable hardlink tree rooted at this checkout's canonical
codex/skills/fray-orchestrator directory, then configure native dynamic model/effort routing
under the non-reserved fray tool namespace. A recognized legacy ~/.codex/skills/fray install is
moved outside skill discovery to ~/.codex/legacy-skills/ so it cannot remain implicitly active.
CODEX_HOME is honored.`;
}

function parseArgs(argv) {
  let command = "install";
  let codexHome;
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--codex-home") {
      codexHome = argv[index + 1];
      if (!codexHome) throw new Error("--codex-home requires a path");
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    if (commandSeen) throw new Error(`unexpected argument: ${arg}`);
    command = arg;
    commandSeen = true;
  }
  return { command, codexHome };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (["install", "relink", "update"].includes(args.command)) {
    await installSkill({ codexHome: args.codexHome });
    await installNativeRouting({ codexHome: args.codexHome });
    return;
  }
  if (args.command === "check") {
    const result = await inspectInstall({ codexHome: args.codexHome });
    if (!result.ok) throw new Error(`invalid install at ${result.destinationRoot}: ${result.problems.join("; ")}`);
    const routing = await inspectNativeRouting({ codexHome: args.codexHome });
    if (!routing.ok) throw new Error("Fray native model/effort routing is not configured");
    console.log(`valid canonical hardlink install: ${result.destinationRoot}`);
    console.log("Fray native dynamic model/effort routing is configured");
    return;
  }
  if (args.command === "uninstall") {
    await uninstallSkill({ codexHome: args.codexHome });
    return;
  }
  throw new Error(`unknown command: ${args.command}\n${usage()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`install-codex-skill: ${error.message}`);
    process.exitCode = 1;
  });
}
