import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  PRODUCTION_REEXEC_FLAG,
  handoffToRegistrySuccessor,
  planRegistryUpdate,
  type RegistryReleaseAdapter,
} from "./production-update.ts";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unrefCalls: number; unref(): void };
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  return child;
}

test("registry update does nothing when the installed version is current", async () => {
  assert.equal(await planRegistryUpdate("fray", "1.2.3", { latestVersion: async () => "1.2.3" }), null);
});

test("registry update selects an immutable newer package spec", async () => {
  assert.deepEqual(await planRegistryUpdate("fray", "1.2.3", { latestVersion: async () => "1.3.0" }), {
    packageName: "fray", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "fray@1.3.0",
  });
});

test("registry lookup failure leaves the healthy process untouched", async () => {
  await assert.rejects(() => planRegistryUpdate("fray", "1.2.3", { latestVersion: async () => { throw new Error("offline"); } }), /offline/);
});

test("successor handoff uses npm exec rather than replacing the active npx cache", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnNpmExec"]>[0] | undefined;
  handoffToRegistrySuccessor(
    { packageName: "fray", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "fray@1.3.0" },
    { port: 4917, projectDir: "/repo", cwd: "/repo", env: { FRAY_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnNpmExec: (request) => { captured = request; return child as never; } },
  );
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917", "/repo"]);
  assert.equal(captured?.packageSpec, "fray@1.3.0");
  // The invoked bin tracks the package name so a renamed release (e.g. frayui) can't invoke a stale bin.
  assert.equal(captured?.bin, "fray");
  assert.equal(captured?.env.FRAY_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRAY_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});
