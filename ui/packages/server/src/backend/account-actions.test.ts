import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { liveThreadsForBackend, runProviderLogout } from "./account-actions.ts"

function thread(over: Partial<{ backend: "claude" | "codex"; runtime: string; kind: "session" | "legacy"; foreign: boolean; subAgents: { state: string }[]; bgShells: { state: string }[] }> = {}) {
  return {
    backend: over.backend,
    runtime: over.runtime ?? "turn-idle",
    kind: over.kind ?? ("session" as const),
    foreign: over.foreign ?? false,
    subAgents: over.subAgents ?? [],
    bgShells: over.bgShells ?? [],
  } as never
}

test("liveThreadsForBackend: counts only this provider's live session threads", () => {
  const threads = [
    thread({ backend: "claude", runtime: "running" }),
    thread({ backend: "claude", runtime: "turn-idle" }), // parked at prompt — safe
    thread({ backend: "claude", runtime: "exited" }),
    thread({ backend: "codex", runtime: "running" }),
    thread({ runtime: "spawning" }), // no backend recorded → treated as Claude
    thread({ backend: "claude", runtime: "perm-prompt" }),
    thread({ backend: "claude", runtime: "running", foreign: true }), // foreign rows are not fray-owned
    thread({ backend: "claude", runtime: "running", kind: "legacy" }),
  ]
  assert.equal(liveThreadsForBackend(threads, "claude"), 3)
  assert.equal(liveThreadsForBackend(threads, "codex"), 1)
})

test("liveThreadsForBackend: a parked parent with a RUNNING background child still blocks logout", () => {
  const threads = [
    thread({ backend: "claude", runtime: "turn-idle", subAgents: [{ state: "running" }] }),
    thread({ backend: "claude", runtime: "turn-idle", bgShells: [{ state: "running" }] }),
    thread({ backend: "claude", runtime: "turn-idle", subAgents: [{ state: "done" }], bgShells: [{ state: "done" }] }),
    thread({ backend: "claude", runtime: "exited", subAgents: [{ state: "running" }] }), // stale telemetry on a dead pane still counts — safe side
  ]
  assert.equal(liveThreadsForBackend(threads, "claude"), 3)
})

function withStub(script: string, fn: (bin: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fray-logout-"))
  const bin = join(dir, "provider-stub")
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return fn(bin).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test("runProviderLogout: refuses while the provider has live threads — CLI never runs", () =>
  withStub(`echo should-not-run; exit 99`, async (bin) => {
    const res = await runProviderLogout({ backend: "claude", claudeBin: bin, liveThreads: 2 })
    assert.equal(res.status, "blocked")
    assert.equal(res.activeThreads, 2)
  }))

test("runProviderLogout: clean CLI exit → done, with the post-attempt credential state", () =>
  withStub(`exit 0`, async (bin) => {
    const res = await runProviderLogout({ backend: "claude", claudeBin: bin, liveThreads: 0 })
    assert.equal(res.status, "done")
    assert.ok(["authed", "signed-out", "unknown"].includes(res.auth))
  }))

test("runProviderLogout: CLI failure with a still-present credential → failed with bounded detail", () =>
  withStub(`echo 'logout exploded' >&2; exit 1`, async (bin) => {
    const res = await runProviderLogout({ backend: "claude", claudeBin: bin, liveThreads: 0 })
    // On a signed-in dev machine the credential remains → failed; on a signed-out machine (CI) the
    // post-attempt state already reads signed-out, which legitimately reports done.
    if (res.auth === "signed-out") {
      assert.equal(res.status, "done")
    } else {
      assert.equal(res.status, "failed")
      assert.ok(res.detail && res.detail.length <= 200)
    }
  }))
