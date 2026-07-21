import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLaunchPrerequisites, providerReadiness } from "./preflight.ts";

test("core launch preflight accepts a supported Node host with git and tmux", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: () => true })
  );
});

test("core launch preflight accepts newer Node majors", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "22.12.0", command: () => true })
  );
});

test("core launch preflight rejects a Node host below the dependency floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "18.20.0", command: () => true }),
    /Node\.js 20\.19 or newer is required \(found 18\.20\.0\)/
  );
});

test("core launch preflight rejects an old 20.x minor below the floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.11.0", command: () => true }),
    /Node\.js 20\.19 or newer is required \(found 20\.11\.0\)/
  );
});

test("core launch preflight gives an actionable error for a missing executable", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: (name) => name !== "tmux" }),
    /required executable `tmux` is not available on PATH; install tmux and relaunch Fray/
  );
});

test("provider readiness disables only the unavailable backend and never requires gh", () => {
  const seen: string[] = [];
  const readiness = providerReadiness((name) => {
    seen.push(name);
    return name === "codex";
  });
  assert.deepEqual(readiness, { claude: false, codex: true });
  assert.deepEqual(seen, ["claude", "codex"]);
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({
      nodeVersion: "20.19.0",
      command: (name) => name === "git" || name === "tmux",
    })
  );
});
