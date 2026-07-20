#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "# fray-dev-source-launcher:v3";
const args = new Set(process.argv.slice(2));
const knownArgs = new Set(["--uninstall", "--check", "--force", "--help"]);
for (const arg of process.argv.slice(2)) {
  if (!knownArgs.has(arg) && !arg.startsWith("--bin-dir=")) {
    console.error(`unknown option: ${arg}`);
    process.exit(1);
  }
}

const command = "fray-dev";

if (args.has("--help")) {
  console.log(
    "Usage: nub run fray-dev:install [-- --bin-dir=/path] [--force]\n" +
      "       nub run fray-dev:check [-- --bin-dir=/path]\n" +
      "       nub run fray-dev:uninstall [-- --bin-dir=/path]\n\n" +
      "Installs fray-dev, the source-checkout launcher."
  );
  process.exit(0);
}

const binDirArg = process.argv
  .find((arg) => arg.startsWith("--bin-dir="))
  ?.slice("--bin-dir=".length);
const binDir = binDirArg || process.env.FRAY_BIN_DIR || join(homedir(), ".local", "bin");
const target = join(binDir, command);
const launcher = realpathSync(
  fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url))
);
const quote = (value) => `'${value.replaceAll("'", `"'"'`)}'`;
const body = `#!/bin/sh\n${MARKER}\nexec env FRAY_SOURCE_COMMAND=${quote(command)} nub ${quote(launcher)} "$@"\n`;

function isOwned(path) {
  try {
    if (!lstatSync(path).isFile()) return false;
    return readFileSync(path, "utf8") === body;
  } catch {
    return false;
  }
}

function targetExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(path) {
  // A directory fsync makes the rename durable on filesystems that support it.
  // Some platforms/filesystems reject it, but the replacement itself is still atomic.
  let directory;
  try {
    directory = openSync(path, "r");
    fsyncSync(directory);
  } catch {
    // Best effort only: notably unsupported by some Windows/network filesystems.
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

function writeAtomic(path, contents) {
  const temp = join(
    binDir,
    `.${command}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    // Exclusive creation prevents one installer from ever writing another's temp file.
    descriptor = openSync(temp, "wx", 0o700);
    writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, 0o755);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // rename replaces a symlink itself, never the symlink's referent.
    renameSync(temp, path);
    syncDirectory(binDir);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temp);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const label = "Fray development source launcher";

if (args.has("--uninstall")) {
  if (existsSync(target) && isOwned(target)) {
    unlinkSync(target);
    console.log(`removed ${target}`);
  } else console.log(`no ${label} found at ${target}`);
  process.exit(0);
}

if (args.has("--check")) {
  if (existsSync(target) && isOwned(target)) {
    console.log(`installed ${label}: ${target}`);
    process.exit(0);
  }
  console.error(`${label} is not installed at ${target}`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
if (targetExists(target) && !isOwned(target) && !args.has("--force")) {
  console.error(
    `${target} already exists and is not the Fray source launcher; rerun with --force to replace it`
  );
  process.exit(1);
}
writeAtomic(target, body);
console.log(`installed ${target}`);
console.log(`source: ${launcher}`);
if (!(process.env.PATH ?? "").split(delimiter).includes(binDir)) {
  console.log(`add this directory to PATH:\n  export PATH=${quote(binDir)}:"$PATH"`);
}
