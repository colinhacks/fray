import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectNativeRouting,
  installNativeRouting,
  patchNativeRoutingConfigText,
} from "../codex/skills/fray-orchestrator/scripts/configure-native-routing.mjs";

const quiet = () => {};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fray-native-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, codexHome: join(root, ".codex") };
}

test("routing config converts a boolean feature without disturbing siblings", () => {
  const original = `[features]\nplugins = true\nmulti_agent_v2 = false\nnetwork_proxy = false\n\n[notice]\nfoo = true\n`;
  const patched = patchNativeRoutingConfigText(original);
  assert.match(patched, /\[features]\nplugins = true\nnetwork_proxy = false/);
  assert.match(
    patched,
    /\[features\.multi_agent_v2]\nenabled = true\nhide_spawn_agent_metadata = false\ntool_namespace = "fray"/,
  );
  assert.match(patched, /\[notice]\nfoo = true/);
  assert.equal(patchNativeRoutingConfigText(patched), patched);
});

test("routing config repairs the hosted-backend-incompatible reserved namespace", () => {
  const original = `[features.multi_agent_v2]\nenabled = true\nhide_spawn_agent_metadata = false\ntool_namespace = "collaboration"\n`;
  const patched = patchNativeRoutingConfigText(original);
  assert.match(patched, /tool_namespace = "fray"/);
  assert.doesNotMatch(patched, /tool_namespace = "collaboration"/);
  assert.equal(patchNativeRoutingConfigText(patched), patched);
});

test("install is complete, mode-preserving, and idempotent", async (t) => {
  const { codexHome } = await fixture(t);
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  await writeFile(configPath, "[features]\nplugins = true\n");
  await chmod(configPath, 0o640);

  const first = await installNativeRouting({ codexHome, log: quiet });
  assert.equal(first.changed, true);
  assert.equal(first.ok, true);
  assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  assert.match(await readFile(configPath, "utf8"), /tool_namespace = "fray"/);
  assert.equal((await inspectNativeRouting({ codexHome })).ok, true);

  const second = await installNativeRouting({ codexHome, log: quiet });
  assert.equal(second.changed, false);
});

test("ambiguous duplicate routing sections fail before writing", async (t) => {
  const { codexHome } = await fixture(t);
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const original = `[features.multi_agent_v2]\nenabled = true\n\n[features.multi_agent_v2]\nenabled = false\n`;
  await writeFile(configPath, original);

  await assert.rejects(
    installNativeRouting({ codexHome, log: quiet }),
    /duplicate \[features\.multi_agent_v2] sections/,
  );
  assert.equal(await readFile(configPath, "utf8"), original);
});
