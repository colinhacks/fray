import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import {
  buildFrayArtifact,
  captureFraySourceSnapshot,
  assertArtifactHostCompatible,
  currentArtifactHost,
  ensureStableFrayArtifact,
  findReusableFrayArtifact,
  promoteFrayArtifact,
  publishFrayArtifactStaging,
  readFrayArtifact,
  readStableArtifact,
  relevantSourceFingerprint,
} from "./artifacts.ts";
import {
  acquireProjectLaunchOwner,
  projectLaunchEnvironment,
} from "../../server/src/project-launch.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function fixtureDigest(manifest: Record<string, unknown>): string {
  const files = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)));
  return hash(JSON.stringify({
    source: (() => { try { return realpathSync(manifest.sourceDir as string); } catch { return resolve(manifest.sourceDir as string); } })(),
    sourceRevision: manifest.sourceRevision,
    sourceFingerprint: manifest.sourceFingerprint,
    nodeVersion: manifest.nodeVersion,
    host: manifest.host,
    webFiles: files(manifest.webFiles),
    runtimeFiles: files(manifest.runtimeFiles),
  }));
}

function legacyFixtureDigest(manifest: Record<string, unknown>): string {
  return hash(JSON.stringify({
    source: manifest.sourceDir && resolve(manifest.sourceDir as string).split("/").pop(),
    sourceRevision: manifest.sourceRevision,
    sourceFingerprint: manifest.sourceFingerprint,
    nodeVersion: manifest.nodeVersion,
    host: manifest.host,
    webFiles: manifest.webFiles,
    runtimeFiles: manifest.runtimeFiles,
  }));
}

function fixture(root: string, content: string): string {
  const digest = "0".repeat(64);
  const dir = join(root, digest);
  mkdirSync(join(dir, "web", "assets"), { recursive: true });
  mkdirSync(join(dir, "runtime", "src"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc-worker", ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc-worker", "hooks"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc-worker", "bin"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc", "scripts", "fray"), { recursive: true });
  mkdirSync(join(dir, "runtime", "prompts"), { recursive: true });
  writeFileSync(join(dir, "web", "index.html"), content);
  writeFileSync(join(dir, "web", "assets", "app.js"), "console.log('ok')");
  writeFileSync(
    join(dir, "runtime", "src", "index.js"),
    "console.log('runtime')"
  );
  writeFileSync(
    join(dir, "runtime", "cc-worker", ".claude-plugin", "plugin.json"),
    '{"name":"fray"}'
  );
  writeFileSync(join(dir, "runtime", "cc-worker", "hooks", "session-seed.mjs"), "seed");
  writeFileSync(join(dir, "runtime", "cc-worker", "hooks", "agent-bind.mjs"), "bind");
  writeFileSync(join(dir, "runtime", "cc-worker", "bin", "fray"), "board");
  writeFileSync(join(dir, "runtime", "cc-worker", "bin", "fray-update"), "update");
  writeFileSync(join(dir, "runtime", "cc", "scripts", "fray", "config.mjs"), "config");
  writeFileSync(join(dir, "runtime", "cc", "scripts", "fray", "agent-bindings.mjs"), "bindings");
  writeFileSync(join(dir, "runtime", "cc", "scripts", "fray", "index.mjs"), "index");
  writeFileSync(join(dir, "runtime", "cc", "scripts", "fray", "thread-update.mjs"), "update");
  writeFileSync(join(dir, "runtime", "prompts", "WORKER_PROMPT.md"), "prompt");
  writeFileSync(join(dir, "runtime", "prompts", "WORKER_PROMPT.claude.md"), "claude");
  writeFileSync(join(dir, "runtime", "prompts", "WORKER_PROMPT.codex.md"), "codex");
  const manifest = {
      version: 1,
      digest: "",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceDir: "/immutable/source",
      sourceRevision: "fixture",
      nodeVersion: process.version,
      host: currentArtifactHost(),
      webFiles: {
        "index.html": hash(content),
        "assets/app.js": hash("console.log('ok')"),
      },
      runtimeFiles: {
        "src/index.js": hash("console.log('runtime')"),
        "cc-worker/.claude-plugin/plugin.json": hash('{"name":"fray"}'),
        "cc-worker/hooks/session-seed.mjs": hash("seed"),
        "cc-worker/hooks/agent-bind.mjs": hash("bind"),
        "cc-worker/bin/fray": hash("board"),
        "cc-worker/bin/fray-update": hash("update"),
        "cc/scripts/fray/config.mjs": hash("config"),
        "cc/scripts/fray/agent-bindings.mjs": hash("bindings"),
        "cc/scripts/fray/index.mjs": hash("index"),
        "cc/scripts/fray/thread-update.mjs": hash("update"),
        "prompts/WORKER_PROMPT.md": hash("prompt"),
        "prompts/WORKER_PROMPT.claude.md": hash("claude"),
        "prompts/WORKER_PROMPT.codex.md": hash("codex"),
      },
    };
  manifest.digest = fixtureDigest(manifest);
  const finalDir = join(root, manifest.digest);
  renameSync(dir, finalDir);
  writeFileSync(join(finalDir, "manifest.json"), JSON.stringify(manifest));
  return manifest.digest;
}

test("artifact host compatibility accepts the host that built it", () => {
  const host = currentArtifactHost();
  assert.doesNotThrow(() =>
    assertArtifactHostCompatible({ digest: "a".repeat(64), manifest: { host } } as any, host)
  );
});

test("artifact host compatibility fails closed for a pre-portability manifest", () => {
  assert.throws(
    () => assertArtifactHostCompatible({ digest: "a".repeat(64), manifest: {} } as any),
    /does not record host compatibility; stop Fray and rerun fray-dev/
  );
});

for (const field of ["platform", "arch", "nodeMajor", "nodeModules"] as const) {
  test(`artifact host compatibility rejects a ${field} mismatch before launch`, () => {
    const host = currentArtifactHost();
    const artifactHost = { ...host, [field]: `${host[field]}-other` };
    assert.throws(
      () => assertArtifactHostCompatible({ digest: "a".repeat(64), manifest: { host: artifactHost } } as any, host),
      /incompatible with this host.*stop Fray and rerun fray-dev/
    );
  });
}

function gitRevision(source: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function markReusableArtifact(
  root: string,
  digest: string,
  source: string
): string {
  const path = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.sourceDir = source;
  manifest.sourceRevision = existsSync(join(source, ".git"))
    ? (() => {
        try {
          return gitRevision(source);
        } catch {
          return "unknown";
        }
      })()
    : "unknown";
  manifest.sourceFingerprint = relevantSourceFingerprint(source);
  manifest.digest = fixtureDigest(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  if (manifest.digest !== digest) renameSync(join(root, digest), join(root, manifest.digest));
  return manifest.digest;
}

function rewriteFixtureManifest(
  root: string,
  digest: string,
  change: (manifest: any) => void
): string {
  const path = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  manifest.digest = fixtureDigest(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  if (manifest.digest !== digest) renameSync(join(root, digest), join(root, manifest.digest));
  return manifest.digest;
}

function sourceFixture(root: string): string {
  const source = join(root, "source");
  mkdirSync(join(source, "packages", "server", "src"), { recursive: true });
  mkdirSync(join(source, "packages", "web", "src"), { recursive: true });
  writeFileSync(
    join(source, "packages", "server", "src", "entry.ts"),
    "export const version = 1\n"
  );
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  execFileSync("git", ["init", "-q"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-qm",
      "initial",
    ],
    { cwd: source }
  );
  return source;
}

test("verified artifacts are selected atomically with a retained rollback digest", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-"));
  const state = join(root, "state");
  const first = fixture(root, "first");
  const second = fixture(root, "second");
  assert.equal(
    readFrayArtifact(first, root).runtimeDir,
    join(root, first, "runtime")
  );
  assert.equal(promoteFrayArtifact(state, first, root).current, first);
  const promoted = promoteFrayArtifact(state, second, root);
  assert.equal(promoted.current, second);
  assert.equal(promoted.previous, first);
  assert.equal(readStableArtifact(state, root)?.digest, second);
  assert.equal(
    JSON.parse(readFileSync(join(state, "stable.json"), "utf8")).current,
    second
  );
});

test("artifact verification rejects modified web or runtime files before a stable pointer can select them", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-corrupt-"));
  const webDigest = fixture(root, "known-good");
  writeFileSync(join(root, webDigest, "web", "index.html"), "tampered");
  assert.throws(() => readFrayArtifact(webDigest, root), /changed or missing/);
  assert.throws(
    () => promoteFrayArtifact(join(root, "state"), webDigest, root),
    /changed or missing/
  );

  const runtimeDigest = fixture(root, "other-known-good");
  writeFileSync(
    join(root, runtimeDigest, "runtime", "src", "index.js"),
    "tampered"
  );
  assert.throws(
    () => readFrayArtifact(runtimeDigest, root),
    /changed or missing/
  );
  assert.throws(
    () => promoteFrayArtifact(join(root, "state"), runtimeDigest, root),
    /changed or missing/
  );
});

test("artifact verification rejects a worker closure omitted from the runtime manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-worker-manifest-"));
  const digest = fixture(root, "known-good");
  const manifestPath = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.runtimeFiles["cc/scripts/fray/index.mjs"];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => readFrayArtifact(digest, root), /failed manifest validation/);
});

test("reuse skips a host-incompatible candidate and rebuilds it", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-host-reuse-"));
  const source = sourceFixture(root);
  let stale = fixture(root, "shared");
  stale = markReusableArtifact(root, stale, source);
  stale = rewriteFixtureManifest(root, stale, (manifest) => {
    manifest.host.arch = `${manifest.host.arch}-other`;
  });
  let builds = 0;
  const selected = ensureStableFrayArtifact(join(root, "state"), source, root, {
    build: () => {
      builds++;
      let fresh = fixture(root, "fresh");
      fresh = markReusableArtifact(root, fresh, source);
      return readFrayArtifact(fresh, root);
    },
  });
  assert.equal(builds, 1);
  assert.notEqual(selected.digest, stale);
});

test("canonical checkout identity prevents same-content artifact collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-source-identity-"));
  const firstSource = sourceFixture(root);
  const secondSource = join(root, "second-source");
  cpSync(firstSource, secondSource, { recursive: true });
  let first = fixture(root, "shared");
  first = markReusableArtifact(root, first, firstSource);
  let second = fixture(root, "shared");
  second = markReusableArtifact(root, second, secondSource);
  assert.notEqual(first, second);
  assert.equal(findReusableFrayArtifact(firstSource, root)?.digest, first);
  assert.equal(findReusableFrayArtifact(secondSource, root)?.digest, second);
});

test("manifest paths and root identity are validated before an artifact is selected", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-manifest-schema-"));
  let traversal = fixture(root, "traversal");
  traversal = rewriteFixtureManifest(root, traversal, (manifest) => {
    manifest.webFiles["../outside"] = manifest.webFiles["index.html"];
  });
  assert.throws(() => readFrayArtifact(traversal, root), /failed manifest validation/);

  const rootTamper = fixture(root, "root-tamper");
  const path = join(root, rootTamper, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.sourceRevision = "changed-without-changing-directory";
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => readFrayArtifact(rootTamper, root), /failed root digest validation/);
});

test("an EEXIST publish race re-reads the verified winner", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-publish-race-"));
  const winner = fixture(root, "winner");
  const staging = join(root, ".staging-race");
  mkdirSync(staging);
  const selected = publishFrayArtifactStaging(staging, winner, root);
  assert.equal(selected.digest, winner);
  assert.equal(existsSync(staging), false);
});

test("a first workspace launch reuses and promotes a verified canonical-source artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-first-launch-"));
  const state = join(root, "project-state");
  const source = join(root, "source");
  mkdirSync(join(source, ".git"), { recursive: true });
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);

  let built = false;
  const progress: string[] = [];
  const selected = ensureStableFrayArtifact(state, source, root, {
    onProgress: (message) => progress.push(message),
    build: () => {
      built = true;
      throw new Error("should reuse");
    },
  });
  assert.equal(selected.digest, digest);
  assert.equal(readStableArtifact(state, root)?.digest, digest);
  assert.equal(built, false);
  assert.deepEqual(progress, [
    "Checking current workspace artifact",
    "Checking verified artifact cache",
    "Reusing cached immutable artifact",
    "Promoting verified immutable artifact",
  ]);
  assert.equal(findReusableFrayArtifact(source, root)?.digest, digest);
});

test("a same-HEAD tracked source edit does not reuse a stale artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-dirty-tracked-"));
  const source = sourceFixture(root);
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  assert.equal(findReusableFrayArtifact(source, root)?.digest, digest);
  writeFileSync(
    join(source, "packages", "server", "src", "entry.ts"),
    "export const version = 2\n"
  );
  assert.equal(findReusableFrayArtifact(source, root), null);
});

test("a stopped workspace refreshes its stable pointer to the current source fingerprint", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-refresh-stopped-"));
  const state = join(root, "project-state");
  const source = sourceFixture(root);
  let stale = fixture(root, "stale");
  let current: string;
  stale = markReusableArtifact(root, stale, source);
  promoteFrayArtifact(state, stale, root);

  writeFileSync(
    join(source, "packages", "server", "src", "entry.ts"),
    "export const version = 2\n"
  );
  current = fixture(root, "current");
  current = markReusableArtifact(root, current, source);

  let built = false;
  const selected = ensureStableFrayArtifact(state, source, root, {
    build: () => {
      built = true;
      throw new Error("the current verified artifact should be reused");
    },
  });
  assert.equal(selected.digest, current);
  assert.equal(readStableArtifact(state, root)?.digest, current);
  assert.equal(built, false);
});

test("a relevant untracked source file does not reuse a stale artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-dirty-untracked-"));
  const source = sourceFixture(root);
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  writeFileSync(
    join(source, "packages", "server", "src", "local-untracked.ts"),
    "export const local = true\n"
  );
  assert.equal(findReusableFrayArtifact(source, root), null);
});

test("an unchanged dirty source reuses the same verified artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-dirty-reuse-"));
  const source = sourceFixture(root);
  writeFileSync(
    join(source, "packages", "server", "src", "local-untracked.ts"),
    "export const local = true\n"
  );
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  assert.equal(findReusableFrayArtifact(source, root)?.digest, digest);
});

test("generated outputs and artifact evidence do not invalidate a reusable dirty-source artifact", () => {
  const root = mkdtempSync(
    join(tmpdir(), "fray-artifacts-fingerprint-ignore-")
  );
  const source = sourceFixture(root);
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  const before = relevantSourceFingerprint(source);
  mkdirSync(join(source, "packages", "web", "dist"), { recursive: true });
  mkdirSync(join(source, "artifacts", "evidence"), { recursive: true });
  writeFileSync(
    join(source, "packages", "web", "dist", "generated.js"),
    "generated"
  );
  writeFileSync(
    join(source, "artifacts", "evidence", "report.json"),
    "generated"
  );
  assert.equal(relevantSourceFingerprint(source), before);
  assert.equal(findReusableFrayArtifact(source, root)?.digest, digest);
});

test("a captured source snapshot remains usable after the checkout changes", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-snapshot-mutation-"));
  const source = sourceFixture(root);
  mkdirSync(join(source, "node_modules"));
  for (const file of [
    "cc-worker/.claude-plugin/plugin.json",
    "cc-worker/hooks/session-seed.mjs",
    "cc-worker/hooks/agent-bind.mjs",
    "cc-worker/bin/fray",
    "cc-worker/bin/fray-update",
    "cc/scripts/fray/config.mjs",
    "cc/scripts/fray/agent-bindings.mjs",
    "cc/scripts/fray/index.mjs",
    "cc/scripts/fray/thread-update.mjs",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "snapshot fixture\n");
  }
  const snapshot = captureFraySourceSnapshot(source, root);
  try {
    const entry = join(source, "packages", "server", "src", "entry.ts");
    writeFileSync(entry, "export const version = 2\n");
    assert.equal(readFileSync(join(snapshot.sourceDir, "packages", "server", "src", "entry.ts"), "utf8"), "export const version = 1\n");
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

async function availableLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) =>
        error
          ? reject(error)
          : resolvePort(typeof address === "object" && address ? address.port : 0)
      );
    });
  });
}

async function waitForArtifactHealth(
  port: number,
  child: ReturnType<typeof spawnChild>,
  projectId: string,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`bundled runtime exited before serving /health:\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const health = (await response.json()) as {
        ok?: unknown;
        projectId?: unknown;
      };
      if (response.ok && health.ok === true && health.projectId === projectId)
        return;
    } catch {
      // The disposable child is still loading its control plane.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `bundled runtime did not serve its WebSocket-capable control plane:\n${output()}`
  );
}

async function stopArtifactChild(
  child: ReturnType<typeof spawnChild>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("bundled runtime did not exit after SIGTERM")),
        15_000
      )
    ),
  ]);
}

test("a real Nub/esbuild artifact boots its WebSocket-capable server and loads its immutable native cell", async () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-real-bundle-"));
  const source = resolve(import.meta.dirname, "..", "..", "..");
  let child: ReturnType<typeof spawnChild> | undefined;
  let releaseOwner: (() => boolean) | undefined;
  try {
    const artifact = buildFrayArtifact(source, root);
    assert.match(
      execFileSync(process.execPath, [join(artifact.runtimeDir, "src", "index.js"), "--help"], { encoding: "utf8" }),
      /Fray source launcher/
    );
    assert.ok(artifact.manifest.dependencyCell, "runtime binds an immutable dependency cell");
    const modules = join(artifact.runtimeDir, "node_modules");
    assert.equal(resolve(dirname(modules), readlinkSync(modules)), join(root, "cells", artifact.manifest.dependencyCell!, "node_modules"));
    for (const prompt of ["WORKER_PROMPT.md", "WORKER_PROMPT.claude.md", "WORKER_PROMPT.codex.md"])
      assert.equal(existsSync(join(artifact.runtimeDir, "prompts", prompt)), true);
    const projectId = randomUUID();
    const canonicalRoot = realpathSync(root);
    const target = {
      projectId,
      projectDir: canonicalRoot,
      stateDir: join(canonicalRoot, "server-state"),
    };
    const owner = acquireProjectLaunchOwner(target, "launcher");
    releaseOwner = owner.release;
    const port = await availableLoopbackPort();
    let output = "";
    child = spawnChild(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
      cwd: root,
      env: projectLaunchEnvironment(
        {
          ...process.env,
          HOME: join(root, "home"),
          FRAY_DEV_CHILD: "1",
          FRAY_DEV_PORT: String(port),
          FRAY_STABLE_ARTIFACT: artifact.digest,
          FRAY_STABLE_WEB_DIST: artifact.webDir,
          FRAY_WORKER_PROMPT_DIR: join(artifact.runtimeDir, "prompts"),
          FRAY_SCRIPTS_DIR: join(artifact.runtimeDir, "cc", "scripts", "fray"),
          FRAY_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
        },
        target,
        owner.token
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    await waitForArtifactHealth(port, child, projectId, () => output);
    const nativeSmoke = `
      import Database from ${JSON.stringify(join(artifact.runtimeDir, "node_modules", "better-sqlite3", "lib", "database.js"))};
      import pty from ${JSON.stringify(join(artifact.runtimeDir, "node_modules", "node-pty", "lib", "index.js"))};
      import watcher from ${JSON.stringify(join(artifact.runtimeDir, "node_modules", "@parcel", "watcher", "index.js"))};
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const db = new Database(":memory:"); db.exec("create table t(x); insert into t values (1)"); if (db.prepare("select x from t").get().x !== 1) throw new Error("sqlite"); db.close();
      const child = pty.spawn(process.execPath, ["-e", "process.exit(0)"], { name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      await new Promise((resolve, reject) => child.onExit(({ exitCode }) => exitCode === 0 ? resolve() : reject(new Error("node-pty exited " + exitCode))));
      const dir = mkdtempSync(join(tmpdir(), "fray-watch-")); const sub = await watcher.subscribe(dir, () => {}); await sub.unsubscribe(); rmSync(dir, { recursive: true, force: true });
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", nativeSmoke], { encoding: "utf8" });
  } finally {
    if (child) await stopArtifactChild(child);
    releaseOwner?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skip("legacy deploy snapshot harness is superseded by the real bundled-artifact smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-source-snapshot-"));
  const source = join(root, "ui");
  const versionFile = join(source, "packages", "web", "src", "version.txt");
  const bin = join(root, "bin");
  mkdirSync(dirname(versionFile), { recursive: true });
  mkdirSync(join(source, "packages", "cli"), { recursive: true });
  mkdirSync(join(source, "packages", "shared"), { recursive: true });
  mkdirSync(join(source, "node_modules"), { recursive: true });
  mkdirSync(join(source, "packages", "web", "node_modules", "@fray-ui"), {
    recursive: true,
  });
  symlinkSync(
    "../../../shared",
    join(source, "packages", "web", "node_modules", "@fray-ui", "shared")
  );
  writeFileSync(versionFile, "before\n");
  writeFileSync(join(source, "packages", "shared", "version.txt"), "snapshot workspace\n");
  for (const file of [
    "cc-worker/.claude-plugin/plugin.json",
    "cc-worker/hooks/session-seed.mjs",
    "cc-worker/hooks/agent-bind.mjs",
    "cc-worker/bin/fray",
    "cc-worker/bin/fray-update",
    "cc/scripts/fray/config.mjs",
    "cc/scripts/fray/agent-bindings.mjs",
    "cc/scripts/fray/index.mjs",
    "cc/scripts/fray/thread-update.mjs",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `${file}\n`);
  }
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
if [ "$5" = "build" ]; then
  test -L "$2/packages/web/node_modules/@fray-ui/shared" || exit 21
  test "$(cat "$2/packages/web/node_modules/@fray-ui/shared/version.txt")" = "snapshot workspace" || exit 22
  version=$(cat "$2/packages/web/src/version.txt")
  if [ "$FRAY_TEST_MUTATE_LIVE" = "1" ]; then
    printf 'after\\n' > "$FRAY_TEST_LIVE_SOURCE/packages/web/src/version.txt"
    sleep 1
  fi
  mkdir -p "$2/packages/web/dist"
  printf '%s\\n' "$version" > "$2/packages/web/dist/index.html"
  exit 0
fi
mkdir -p "$6/src" "$6/node_modules/.pnpm/node_modules"
printf 'export const artifact = true\\n' > "$6/src/index.ts"
ln -s "$2/packages/cli" "$6/node_modules/.pnpm/node_modules/frayui"
`
  );
  chmodSync(pnpm, 0o755);
  const oldPath = process.env.PATH;
  const oldMutate = process.env.FRAY_TEST_MUTATE_LIVE;
  const oldLiveSource = process.env.FRAY_TEST_LIVE_SOURCE;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.FRAY_TEST_MUTATE_LIVE = "1";
  process.env.FRAY_TEST_LIVE_SOURCE = source;
  const beforeFingerprint = relevantSourceFingerprint(source);
  try {
    const first = buildFrayArtifact(source, root);
    assert.equal(readFileSync(join(first.webDir, "index.html"), "utf8"), "before\n");
    assert.equal(readFileSync(versionFile, "utf8"), "after\n");
    assert.equal(first.manifest.sourceFingerprint, beforeFingerprint);
    const selfLink = join(first.runtimeDir, "node_modules", ".pnpm", "node_modules", "frayui");
    assert.equal(
      resolve(dirname(selfLink), readlinkSync(selfLink)),
      first.runtimeDir,
      "the deploy self-link is sealed inside the immutable artifact"
    );
    process.env.FRAY_TEST_MUTATE_LIVE = "0";
    const second = buildFrayArtifact(source, root);
    assert.notEqual(second.digest, first.digest);
    assert.equal(readFileSync(join(second.webDir, "index.html"), "utf8"), "after\n");
    assert.equal(second.manifest.sourceFingerprint, relevantSourceFingerprint(source));
    assert.deepEqual(
      readdirSync(root).filter((entry) => entry.startsWith(".source-snapshot-")),
      []
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldMutate === undefined) delete process.env.FRAY_TEST_MUTATE_LIVE;
    else process.env.FRAY_TEST_MUTATE_LIVE = oldMutate;
    if (oldLiveSource === undefined) delete process.env.FRAY_TEST_LIVE_SOURCE;
    else process.env.FRAY_TEST_LIVE_SOURCE = oldLiveSource;
  }
});

test("an older verified manifest without a source fingerprint fails closed for new workspace reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-old-manifest-"));
  const source = sourceFixture(root);
  const digest = fixture(root, "shared");
  const path = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const legacy = legacyFixtureDigest(manifest);
  manifest.digest = legacy;
  writeFileSync(path, JSON.stringify(manifest));
  renameSync(join(root, digest), join(root, legacy));
  assert.equal(readFrayArtifact(legacy, root).digest, legacy);
  assert.equal(findReusableFrayArtifact(source, root), null);
});

test("a zero-artifact first launch builds then promotes only a complete verified candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-zero-launch-"));
  const state = join(root, "project-state");
  const source = join(root, "source");
  mkdirSync(source);
  let digest = "";
  let builds = 0;
  const progress: string[] = [];
  const selected = ensureStableFrayArtifact(state, source, root, {
    onProgress: (message) => progress.push(message),
    build: () => {
      builds++;
      digest = fixture(root, "built");
      return readFrayArtifact(digest, root);
    },
  });
  assert.equal(builds, 1);
  assert.deepEqual(progress, [
    "Checking current workspace artifact",
    "Checking verified artifact cache",
    "No matching artifact found; building immutable artifact",
    "Promoting verified immutable artifact",
  ]);
  assert.equal(selected.digest, digest);
  assert.equal(readStableArtifact(state, root)?.digest, digest);
});

test("a stale source pointer reports an actual immutable rebuild before promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-stale-progress-"));
  const state = join(root, "project-state");
  const source = sourceFixture(root);
  let stale = fixture(root, "stale");
  let rebuilt = "";
  stale = markReusableArtifact(root, stale, source);
  promoteFrayArtifact(state, stale, root);
  writeFileSync(join(source, "packages", "server", "src", "entry.ts"), "export const version = 2\n");
  const progress: string[] = [];
  const selected = ensureStableFrayArtifact(state, source, root, {
    onProgress: (message) => progress.push(message),
    build: () => {
      rebuilt = fixture(root, "rebuilt");
      rebuilt = markReusableArtifact(root, rebuilt, source);
      return readFrayArtifact(rebuilt, root);
    },
  });
  assert.equal(selected.digest, rebuilt);
  assert.deepEqual(progress, [
    "Checking current workspace artifact",
    "Checking verified artifact cache",
    "No matching artifact found; building immutable artifact",
    "Promoting verified immutable artifact",
  ]);
});

test("a failed first-launch build never writes a partial candidate to workspace selection", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-build-rollback-"));
  const state = join(root, "project-state");
  const source = join(root, "source");
  mkdirSync(source);
  assert.throws(
    () =>
      ensureStableFrayArtifact(state, source, root, {
        build: () => {
          throw new Error("build failed");
        },
      }),
    /build failed/
  );
  assert.equal(readStableArtifact(state, root), null);
  assert.equal(existsSync(join(state, "stable.json")), false);
});

test.skip("legacy deploy cleanup harness is superseded by the bundled-artifact smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-build-cleanup-"));
  const source = join(root, "source");
  const plugin = join(root, "cc-worker");
  const bin = join(root, "bin");
  mkdirSync(source);
  mkdirSync(join(source, "node_modules"));
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}\n");
  for (const file of [
    "hooks/session-seed.mjs",
    "hooks/agent-bind.mjs",
    "bin/fray",
    "bin/fray-update",
  ]) {
    mkdirSync(dirname(join(plugin, file)), { recursive: true });
    writeFileSync(join(plugin, file), "export {}\n");
  }
  for (const file of ["config.mjs", "agent-bindings.mjs", "index.mjs", "thread-update.mjs"]) {
    mkdirSync(join(root, "cc", "scripts", "fray"), { recursive: true });
    writeFileSync(join(root, "cc", "scripts", "fray", file), "export {}\n");
  }
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
if [ "$5" = "build" ]; then
  mkdir -p "$2/packages/web/dist"
  printf '<!doctype html>' > "$2/packages/web/dist/index.html"
  exit 0
fi
mkdir -p "$6/runtime"
exit 12
`
  );
  chmodSync(pnpm, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    assert.throws(() => buildFrayArtifact(source, root), /Command failed/);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepEqual(
    readdirSync(root).filter(
      (entry) =>
        entry.startsWith(".staging-") ||
        entry.startsWith(".source-snapshot-")
    ),
    []
  );
});

test.skip("legacy deploy worker harness is superseded by the bundled-artifact smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "fray-artifacts-worker-plugin-"));
  const source = join(root, "ui");
  const plugin = join(root, "cc-worker");
  const bin = join(root, "bin");
  mkdirSync(join(source, "packages", "web", "src"), { recursive: true });
  mkdirSync(join(source, "node_modules"));
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "skills", "worker"), { recursive: true });
  mkdirSync(join(plugin, "skills", "gh", "scripts"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "bin"), { recursive: true });
  mkdirSync(join(plugin, "scripts", "fray"), { recursive: true });
  mkdirSync(join(root, "cc", "scripts", "fray"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"fray"}\n');
  writeFileSync(join(plugin, "skills", "worker", "SKILL.md"), "worker\n");
  writeFileSync(join(plugin, "skills", "gh", "SKILL.md"), "gh\n");
  writeFileSync(join(plugin, "skills", "gh", "scripts", "ci-watch.mjs"), "watch\n");
  writeFileSync(
    join(plugin, "hooks", "session-seed.mjs"),
    `import { readFileSync } from "node:fs";
import { currentSessionId, setSessionOverride } from "../scripts/fray/config.mjs";
const input = JSON.parse(readFileSync(0, "utf8"));
const sessionId = currentSessionId(input.session_id);
setSessionOverride(process.env.CLAUDE_PROJECT_DIR, sessionId, "off");
process.stdout.write(JSON.stringify({ scratch: ".fray/threads/" + sessionId + "/scratch.md" }));
`
  );
  writeFileSync(join(plugin, "hooks", "agent-bind.mjs"), "bind\n");
  writeFileSync(join(plugin, "scripts", "fray", "config.mjs"), `export * from "../../../cc/scripts/fray/config.mjs";\n`);
  writeFileSync(join(plugin, "scripts", "fray", "agent-bindings.mjs"), `export * from "../../../cc/scripts/fray/agent-bindings.mjs";\n`);
  writeFileSync(join(plugin, "bin", "fray"), `await import(new URL("../../cc/scripts/fray/index.mjs", import.meta.url));\n`);
  writeFileSync(join(plugin, "bin", "fray-update"), `await import(new URL("../../cc/scripts/fray/thread-update.mjs", import.meta.url));\n`);
  writeFileSync(
    join(root, "cc", "scripts", "fray", "config.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const currentSessionId = (explicit) => explicit || process.env.CLAUDE_CODE_SESSION_ID || null;
export const setSessionOverride = (project, sessionId, state) => {
  const dir = join(project, ".fray", ".session-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), state + "\\n");
};
`
  );
  writeFileSync(join(root, "cc", "scripts", "fray", "agent-bindings.mjs"), "export const recordBinding = () => true; export const threadFromPrompt = () => null;\n");
  writeFileSync(join(root, "cc", "scripts", "fray", "index.mjs"), "process.stdout.write(\"portable-board\\n\");\n");
  writeFileSync(join(root, "cc", "scripts", "fray", "thread-update.mjs"), "process.stdout.write(\"portable-update\\n\");\n");
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
if [ "$5" = "build" ]; then
  mkdir -p "$2/packages/web/dist"
  printf '<!doctype html>' > "$2/packages/web/dist/index.html"
  exit 0
fi
mkdir -p "$6/src" "$6/node_modules/@fray-ui/server/src"
printf 'export const artifact = true\\n' > "$6/src/index.ts"
printf 'export const dispatch = true\\n' > "$6/node_modules/@fray-ui/server/src/dispatch.ts"
`
  );
  chmodSync(pnpm, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const artifact = buildFrayArtifact(source, root);
    const bundled = join(artifact.runtimeDir, "cc-worker");
    assert.equal(existsSync(join(bundled, ".claude-plugin", "plugin.json")), true);
    assert.equal(existsSync(join(bundled, "skills", "worker", "SKILL.md")), true);
    assert.equal(existsSync(join(bundled, "skills", "gh", "scripts", "ci-watch.mjs")), true);
    assert.equal(existsSync(join(bundled, "hooks", "session-seed.mjs")), true);
    assert.equal(existsSync(join(artifact.runtimeDir, "cc", "scripts", "fray", "config.mjs")), true);
    assert.equal(
      resolve(dirname(join(artifact.runtimeDir, "node_modules", "@fray-ui", "server", "src", "dispatch.js")), "../../../../cc-worker"),
      bundled,
      "the deployed workerPluginDir() resolver reaches the bundled plugin"
    );
    assert.equal(
      artifact.manifest.runtimeFiles["cc-worker/.claude-plugin/plugin.json"] !== undefined,
      true,
      "plugin files are manifest-verified runtime inputs"
    );
    assert.equal(
      artifact.manifest.runtimeFiles["cc/scripts/fray/index.mjs"] !== undefined,
      true,
      "the cc script closure is manifest-verified alongside the worker plugin"
    );
    const cleanHome = join(root, "clean-home")
    const project = join(root, "project")
    mkdirSync(join(project, ".fray", "threads", "portable-session"), { recursive: true })
    writeFileSync(join(project, ".fray", "threads", "portable-session", "scratch.md"), "# scratch\n")
    // Erase the checkout closure before invoking the copied artifact. The hook and both executable
    // shims must resolve only runtime/{cc-worker,cc}, with no global Fray config/plugin to help.
    rmSync(source, { recursive: true, force: true })
    rmSync(plugin, { recursive: true, force: true })
    rmSync(join(root, "cc"), { recursive: true, force: true })
    const cleanEnv = {
      PATH: process.env.PATH ?? "",
      HOME: cleanHome,
      FRAY_UI_THREAD: "portable-thread",
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CODE_SESSION_ID: "portable-session",
      CLAUDE_CODE_SUBAGENT_MODEL: "foreign-model",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
    }
    const hook = execFileSync(process.execPath, [join(bundled, "hooks", "session-seed.mjs")], {
      cwd: project,
      env: cleanEnv,
      input: JSON.stringify({ session_id: "portable-session" }),
      encoding: "utf8",
    })
    assert.deepEqual(JSON.parse(hook), { scratch: ".fray/threads/portable-session/scratch.md" })
    assert.equal(readFileSync(join(project, ".fray", ".session-state", "portable-session"), "utf8"), "off\n")
    assert.equal(execFileSync(process.execPath, [join(bundled, "bin", "fray")], { cwd: project, env: cleanEnv, encoding: "utf8" }), "portable-board\n")
    assert.equal(execFileSync(process.execPath, [join(bundled, "bin", "fray-update")], { cwd: project, env: cleanEnv, encoding: "utf8" }), "portable-update\n")
  } finally {
    process.env.PATH = oldPath;
  }
});
