import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLaunchPrerequisites, providerReadiness } from "./preflight.ts";

test("core launch preflight accepts any Node host with git and tmux", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ command: () => true })
  );
});

test("core launch preflight gives an actionable error for a missing executable", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ command: (name) => name !== "tmux" }),
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
    assertLaunchPrerequisites({ command: (name) => name === "git" || name === "tmux" })
  );
});
