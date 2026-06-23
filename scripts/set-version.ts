#!/usr/bin/env node
/**
 * set-version — single source of truth for the fray Claude Code plugin version.
 *
 * The CC plugin version lives in TWO files that MUST stay in lockstep:
 *   - cc/.claude-plugin/plugin.json  ("version")
 *   - cc/skills/fray/SKILL.md        (YAML frontmatter `version:`)
 * These drifted once (plugin.json at 1.6.3 while SKILL.md frontmatter fell to
 * 1.0.x) because each was bumped by hand independently. This script makes them
 * a single atomic write so they can never disagree again.
 *
 * DELIBERATELY EXCLUDED (independent version tracks — NOT bumped here):
 *   - codex/.codex-plugin/plugin.json — the Codex port is a separate harness on
 *     its own release cadence (currently 0.2.0). Its SKILL.md has no version.
 *   - pi/package.json — private (`"private": true`, 0.0.0), never published.
 *   - opencode/package.json — carries no version field at all (only a dep pin).
 *   - .claude-plugin/marketplace.json — the marketplace manifest has no version.
 * If a future port should share the CC version, add its file to SYNCED_FILES.
 *
 * Usage:
 *   node scripts/set-version.ts 1.8.0     # write 1.8.0 to all synced files
 *   nub  scripts/set-version.ts 1.8.0     # same, via nub
 *   node scripts/set-version.ts --check   # CI: exit nonzero if files disagree
 *
 * No build step, no deps beyond Node built-ins. Runs under Node 22.6+ native
 * TS-type-stripping and under nub.
 */

import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A version-bearing file and how to read/replace the version within it. */
interface SyncedFile {
  readonly path: string;
  readonly label: string;
  read(text: string): string | null;
  write(text: string, version: string): string;
}

const SYNCED_FILES: readonly SyncedFile[] = [
  {
    path: "cc/.claude-plugin/plugin.json",
    label: 'plugin.json "version"',
    read(text) {
      const m = text.match(/"version"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    },
    write(text, version) {
      // Surgical replacement preserves the file's exact formatting/key order.
      return text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
    },
  },
  {
    path: "cc/skills/fray/SKILL.md",
    label: "SKILL.md frontmatter version:",
    read(text) {
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      if (!m) return null;
      const fm = m[1].match(/^version:\s*(.+)$/m);
      return fm ? fm[1].trim() : null;
    },
    write(text, version) {
      const fm = text.match(/^(---\n)([\s\S]*?)(\n---)/);
      if (!fm) throw new Error("SKILL.md: no YAML frontmatter block found");
      if (!/^version:\s*.+$/m.test(fm[2])) {
        throw new Error("SKILL.md: no `version:` key in frontmatter");
      }
      // Replace ONLY within the frontmatter block, never a body `version:` line.
      const nextFm = fm[2].replace(/^(version:\s*).+$/m, `$1${version}`);
      return fm[1] + nextFm + fm[3] + text.slice(fm[0].length);
    },
  },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function readVersion(f: SyncedFile): string | null {
  const abs = join(REPO_ROOT, f.path);
  return f.read(readFileSync(abs, "utf8"));
}

// Per-FILE atomic (write-then-rename). NOT transactional across the whole set —
// each synced file is written independently, so a mid-loop failure can leave an
// earlier file already bumped. That's fine here: re-running `set-version` (or
// `--check` in CI) immediately surfaces and reconciles any partial state.
function writeAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.set-version.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

function check(): number {
  const found = SYNCED_FILES.map((f) => ({ f, version: readVersion(f) }));
  const missing = found.filter((x) => x.version === null);
  if (missing.length > 0) {
    console.error("✖ version not found in:");
    for (const m of missing) console.error(`    ${m.f.path} (${m.f.label})`);
    return 1;
  }
  const versions = new Set(found.map((x) => x.version));
  if (versions.size === 1) {
    console.log(`✓ all ${found.length} synced files agree: ${[...versions][0]}`);
    return 0;
  }
  console.error("✖ version DRIFT — synced files disagree:");
  for (const { f, version } of found) console.error(`    ${version}\t${f.path} (${f.label})`);
  console.error("\nrun `node scripts/set-version.ts <version>` to reconcile.");
  return 1;
}

function set(version: string): number {
  if (!SEMVER.test(version)) {
    console.error(`✖ not a valid semver: "${version}"`);
    console.error("  expected e.g. 1.8.0 (optionally with -prerelease / +build)");
    return 1;
  }
  const changes: string[] = [];
  for (const f of SYNCED_FILES) {
    const abs = join(REPO_ROOT, f.path);
    const text = readFileSync(abs, "utf8");
    const before = f.read(text);
    const next = f.write(text, version);
    if (f.read(next) !== version) {
      console.error(`✖ ${f.path}: write did not take effect`);
      return 1;
    }
    if (next !== text) {
      writeAtomic(abs, next);
      changes.push(`  ${f.path}: ${before} → ${version}`);
    } else {
      changes.push(`  ${f.path}: already ${version} (unchanged)`);
    }
  }
  console.log(`set version ${version}:`);
  for (const c of changes) console.log(c);
  return 0;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: set-version <version> | --check");
    return 1;
  }
  if (args[0] === "--check") return check();
  if (args.length > 1) {
    console.error("usage: set-version <version> | --check  (one positional version arg)");
    return 1;
  }
  return set(args[0]);
}

process.exit(main());
