#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

// The tool namespace remains `fray`; the explicit skill name is `fray-orchestrator`.
const FRAY_TOOL_NAMESPACE = "fray";

function defaultCodexHome() {
  return resolve(process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex"));
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function splitLines(contents) {
  return { lines: contents.split(/\r?\n/), eol: contents.includes("\r\n") ? "\r\n" : "\n" };
}

function sectionRange(lines, sectionName) {
  const header = `[${sectionName}]`;
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().replace(/\s+#.*$/, "") === header) starts.push(index);
  }
  if (starts.length > 1) throw new Error(`config.toml contains duplicate ${header} sections`);
  if (starts.length === 0) return null;

  let end = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+]\s*(?:#.*)?$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start: starts[0], end };
}

function upsertValue(lines, range, key, serializedValue) {
  const matches = [];
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (keyPattern.test(lines[index])) matches.push(index);
  }
  if (matches.length > 1) throw new Error(`config.toml contains duplicate ${key} values`);

  const line = `${key} = ${serializedValue}`;
  if (matches.length === 1) {
    lines[matches[0]] = line;
    return;
  }
  lines.splice(range.end, 0, line);
}

/**
 * Configure native Multi-Agent v2 under a non-reserved namespace.
 *
 * The hosted backend reserves `collaboration.spawn_agent` to a fixed hidden
 * schema. Renaming the namespace to `fray` lets Codex expose the native
 * `model` and `reasoning_effort` fields without replacing AgentControl or its
 * parent/child lifecycle.
 */
export function patchNativeRoutingConfigText(contents) {
  const { lines, eol } = splitLines(contents);
  let range = sectionRange(lines, "features.multi_agent_v2");

  if (!range) {
    const features = sectionRange(lines, "features");
    if (features) {
      const scalarMatches = [];
      for (let index = features.start + 1; index < features.end; index += 1) {
        if (/^\s*multi_agent_v2\s*=/.test(lines[index])) scalarMatches.push(index);
      }
      if (scalarMatches.length > 1) {
        throw new Error("config.toml contains duplicate features.multi_agent_v2 values");
      }
      if (scalarMatches.length === 1) {
        if (!/^\s*multi_agent_v2\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(lines[scalarMatches[0]])) {
          throw new Error("cannot safely convert a non-boolean features.multi_agent_v2 value");
        }
        lines.splice(scalarMatches[0], 1);
      }
    }

    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(
      "# Fray uses a non-reserved namespace so Codex accepts explicit spawn routing fields.",
      "[features.multi_agent_v2]",
      "enabled = true",
      "hide_spawn_agent_metadata = false",
      `tool_namespace = "${FRAY_TOOL_NAMESPACE}"`,
      "",
    );
    return lines.join(eol);
  }

  upsertValue(lines, range, "enabled", "true");
  range = sectionRange(lines, "features.multi_agent_v2");
  upsertValue(lines, range, "hide_spawn_agent_metadata", "false");
  range = sectionRange(lines, "features.multi_agent_v2");
  upsertValue(lines, range, "tool_namespace", `"${FRAY_TOOL_NAMESPACE}"`);
  while (lines.length > 1 && lines.at(-1) === "" && lines.at(-2) === "") lines.pop();
  if (lines.at(-1) !== "") lines.push("");
  return lines.join(eol);
}

export async function inspectNativeRouting({ codexHome = defaultCodexHome() } = {}) {
  const configPath = join(resolve(codexHome), "config.toml");
  const configText = (await readOptional(configPath)) ?? "";
  const patchedConfigText = patchNativeRoutingConfigText(configText);
  const configured = patchedConfigText === configText;
  return { ok: configured, configured, configPath, configText, patchedConfigText };
}

async function atomicWrite(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.fray-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function installNativeRouting({
  codexHome = defaultCodexHome(),
  log = console.log,
} = {}) {
  const inspection = await inspectNativeRouting({ codexHome });
  if (inspection.configured) {
    log("Fray native model/effort routing is already configured");
    return { ...inspection, changed: false };
  }

  let mode = 0o600;
  try {
    mode = (await stat(inspection.configPath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWrite(inspection.configPath, inspection.patchedConfigText, mode);

  const finalInspection = await inspectNativeRouting({ codexHome });
  if (!finalInspection.ok) throw new Error("post-install routing verification failed");
  log("configured native Fray model/effort routing; start a new Codex thread to load the routed spawn schema");
  return { ...finalInspection, changed: true };
}

function usage() {
  return "usage: configure-native-routing.mjs [check|install] [--codex-home PATH] [--json]";
}

function parseArgs(argv) {
  let command = "check";
  let codexHome;
  let json = false;
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
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
  return { command, codexHome, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let result;
  if (args.command === "check") result = await inspectNativeRouting({ codexHome: args.codexHome });
  else if (args.command === "install") {
    result = await installNativeRouting({ codexHome: args.codexHome, log: args.json ? () => {} : console.log });
  } else throw new Error(`unknown command: ${args.command}\n${usage()}`);

  if (args.json) {
    console.log(JSON.stringify({ ok: result.ok, configured: result.configured, configPath: result.configPath, changed: result.changed ?? false }, null, 2));
  } else if (args.command === "check") {
    console.log(result.ok ? "Fray native model/effort routing is configured" : "Fray native model/effort routing is not configured");
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`configure-native-routing: ${error.message}`);
    process.exitCode = 1;
  });
}
