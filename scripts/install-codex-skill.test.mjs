import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectInstall,
  installSkill,
  LEGACY_SKILL_NAME,
  SKILL_NAME,
  uninstallSkill,
} from "./install-codex-skill.mjs";

const quiet = () => {};

async function makeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fray-codex-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceRoot = join(root, "source", SKILL_NAME);
  const codexHome = join(root, "home", ".codex");
  await mkdir(join(sourceRoot, "agents"), { recursive: true });
  await writeFile(join(sourceRoot, "SKILL.md"), `---\nname: ${SKILL_NAME}\n---\n# Fray Orchestrator\n`);
  await writeFile(join(sourceRoot, "agents", "openai.yaml"), 'interface:\n  display_name: "Fray Orchestrator"\n');
  return { root, sourceRoot, codexHome };
}

async function seedPreviousInstall(codexHome) {
  const destination = join(codexHome, "skills", SKILL_NAME);
  await mkdir(join(destination, "agents"), { recursive: true });
  await writeFile(join(destination, "SKILL.md"), "previous skill\n");
  await writeFile(join(destination, "agents", "openai.yaml"), "previous metadata\n");
  return destination;
}

test("hardlink preflight failure leaves the existing install intact", async (t) => {
  const { sourceRoot, codexHome } = await makeFixture(t);
  const destination = await seedPreviousInstall(codexHome);
  const expectedSkill = await readFile(join(destination, "SKILL.md"), "utf8");
  const expectedMetadata = await readFile(join(destination, "agents", "openai.yaml"), "utf8");

  const failHardlink = async () => {
    const error = new Error("simulated cross-device link");
    error.code = "EXDEV";
    throw error;
  };

  await assert.rejects(
    installSkill({ sourceRoot, codexHome, linkFile: failHardlink, log: quiet, warn: quiet }),
    /hardlink preflight failed before changing the active install/,
  );
  assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), expectedSkill);
  assert.equal(await readFile(join(destination, "agents", "openai.yaml"), "utf8"), expectedMetadata);
  assert.deepEqual(await readdir(join(codexHome, "skills")), [SKILL_NAME]);
});

test("activation failure restores the previous install", async (t) => {
  const { sourceRoot, codexHome } = await makeFixture(t);
  const destination = await seedPreviousInstall(codexHome);
  let injected = false;
  const failCandidateActivation = async (from, to) => {
    if (!injected && from.includes(`.${SKILL_NAME}-install-`) && to === destination) {
      injected = true;
      const error = new Error("simulated activation failure");
      error.code = "EIO";
      throw error;
    }
    await rename(from, to);
  };

  await assert.rejects(
    installSkill({ sourceRoot, codexHome, renamePath: failCandidateActivation, log: quiet, warn: quiet }),
    /simulated activation failure/,
  );
  assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), "previous skill\n");
  assert.equal(
    await readFile(join(destination, "agents", "openai.yaml"), "utf8"),
    "previous metadata\n",
  );
  assert.deepEqual(await readdir(join(codexHome, "skills")), [SKILL_NAME]);
});

test("install, relink after inode replacement, and uninstall are idempotent", async (t) => {
  const { sourceRoot, codexHome } = await makeFixture(t);

  await installSkill({ sourceRoot, codexHome, log: quiet, warn: quiet });
  await installSkill({ sourceRoot, codexHome, log: quiet, warn: quiet });
  let result = await inspectInstall({ sourceRoot, codexHome });
  assert.equal(result.ok, true, result.problems.join("; "));

  const sourceSkill = join(sourceRoot, "SKILL.md");
  const installedSkill = join(codexHome, "skills", SKILL_NAME, "SKILL.md");
  let [sourceInfo, installedInfo] = await Promise.all([stat(sourceSkill), stat(installedSkill)]);
  assert.equal(installedInfo.dev, sourceInfo.dev);
  assert.equal(installedInfo.ino, sourceInfo.ino);

  const replacement = join(sourceRoot, ".replacement-SKILL.md");
  await writeFile(replacement, `---\nname: ${SKILL_NAME}\n---\n# Replaced Fray Orchestrator\n`);
  await rename(replacement, sourceSkill);
  [sourceInfo, installedInfo] = await Promise.all([stat(sourceSkill), stat(installedSkill)]);
  assert.notEqual(installedInfo.ino, sourceInfo.ino);

  await installSkill({ sourceRoot, codexHome, log: quiet, warn: quiet });
  result = await inspectInstall({ sourceRoot, codexHome });
  assert.equal(result.ok, true, result.problems.join("; "));
  [sourceInfo, installedInfo] = await Promise.all([stat(sourceSkill), stat(installedSkill)]);
  assert.equal(installedInfo.dev, sourceInfo.dev);
  assert.equal(installedInfo.ino, sourceInfo.ino);
  assert.match(await readFile(installedSkill, "utf8"), /Replaced Fray/);

  assert.equal((await uninstallSkill({ codexHome, log: quiet })).changed, true);
  assert.equal((await uninstallSkill({ codexHome, log: quiet })).changed, false);
});

test("install retires a recognized legacy fray skill outside discovery", async (t) => {
  const { sourceRoot, codexHome } = await makeFixture(t);
  const legacyRoot = join(codexHome, "skills", LEGACY_SKILL_NAME);
  await mkdir(join(legacyRoot, "agents"), { recursive: true });
  await writeFile(join(legacyRoot, "SKILL.md"), "---\nname: fray\n---\n# Fray\n\nLegacy body.\n");
  await writeFile(join(legacyRoot, "agents", "openai.yaml"), "interface: {}\n");

  const result = await installSkill({ sourceRoot, codexHome, log: quiet, warn: quiet });

  assert.equal(result.legacy.changed, true);
  assert.deepEqual(await readdir(join(codexHome, "skills")), [SKILL_NAME]);
  assert.match(result.legacy.archivedRoot, /legacy-skills/);
  assert.match(await readFile(join(result.legacy.archivedRoot, "SKILL.md"), "utf8"), /name: fray/);
});

test("install leaves an unrelated skill named fray untouched", async (t) => {
  const { sourceRoot, codexHome } = await makeFixture(t);
  const legacyRoot = join(codexHome, "skills", LEGACY_SKILL_NAME);
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(join(legacyRoot, "SKILL.md"), "---\nname: fray\n---\n# Different Project\n");

  const result = await installSkill({ sourceRoot, codexHome, log: quiet, warn: quiet });

  assert.equal(result.legacy.changed, false);
  assert.equal(result.legacy.unrecognized, true);
  assert.deepEqual((await readdir(join(codexHome, "skills"))).sort(), [LEGACY_SKILL_NAME, SKILL_NAME]);
});
