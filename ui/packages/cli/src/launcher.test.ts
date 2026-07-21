import { execFileSync, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { resolveProject } from "../../server/src/project.ts";
import {
  acquireGlobalLaunchLockSync,
  resolveGitWorktree,
} from "../../server/src/project-identity.ts";
import { deriveProjectSocket, deriveSocket } from "../../server/src/tmux.ts";
import {
  acquireProjectLaunchOwner,
  defaultProcessPlatformAdapter,
  projectLaunchTokenProof,
  readProjectLaunchOwner,
  registerProjectLaunchDelegate,
  type ProcessPlatformAdapter,
  type ProjectLaunchTarget,
} from "../../server/src/project-launch.ts";
import {
  acquireGlobalLaunchLock,
  choosePort,
  helpText,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  parseCliArgs,
  prepareBeforeGlobalLaunchLock,
  probeFray,
  readPreferredPort,
  requestFrayStop,
  resolveWorkspace,
  sourceWorkspaceDir,
  supervisorNeedsAttention,
  workspaceLaunchTarget,
  type Workspace,
} from "./launcher.ts";

test("artifact re-exec keeps the original canonical Fray source directory", () => {
  const source = mkdtempSync(join(tmpdir(), "fray-canonical-source-"));
  const artifactRuntime = join(tmpdir(), "fray-builds", "digest", "runtime", "src");
  assert.equal(
    sourceWorkspaceDir({ FRAY_SOURCE_DIR: source }),
    source,
    "a deployed runtime must not infer its cache path as build source"
  );
  assert.notEqual(sourceWorkspaceDir({}), artifactRuntime);
});

interface IdentityResult {
  root: string;
  id: string;
  stateDir: string;
  socket: string;
  identityScope: "repository" | "worktree";
}

type IdentityMode = "cli" | "server";

const launcherModuleUrl = pathToFileURL(
  join(import.meta.dirname, "launcher.ts")
).href;
const projectModuleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "..", "server", "src", "project.ts")
).href;
const projectIdentityModuleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "..", "server", "src", "project-identity.ts")
).href;
const projectLaunchModuleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "..", "server", "src", "project-launch.ts")
).href;
const cliEntry = join(import.meta.dirname, "index.ts");
const uiRoot = join(import.meta.dirname, "..", "..", "..");

function spawnLaunchProtocolChild(
  kind: "owner" | "delegate",
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = {}
) {
  const source =
    kind === "owner"
      ? `
    import { createServer } from "node:http"
    import { acquireProjectLaunchOwner, projectLaunchTokenProof } from ${JSON.stringify(
      projectLaunchModuleUrl
    )}
    const target = JSON.parse(process.env.TARGET)
    const lease = acquireProjectLaunchOwner(target, "supervisor")
    let control
    let port
    if (process.env.FAIL_CONTROL === "1") {
      control = createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            ok: true,
            projectId: target.projectId,
            projectDir: target.projectDir,
            bootId: "failed-control-fixture",
            ownerProof: projectLaunchTokenProof(target, lease.token),
          }))
          return
        }
        res.writeHead(req.url === "/control/stop" ? 503 : 404)
        res.end()
      })
      await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve))
      port = control.address().port
    }
    console.log(JSON.stringify({ token: lease.token, pid: lease.pid, processStart: lease.processStart, port }))
    const finish = () => {
      lease.release()
      if (control?.listening) control.close(() => process.exit(0))
      else process.exit(0)
    }
    process.on("SIGTERM", finish)
    setInterval(() => {}, 1000)
  `
      : `
    import { registerProjectLaunchDelegate } from ${JSON.stringify(
      projectLaunchModuleUrl
    )}
    const target = JSON.parse(process.env.TARGET)
    const lease = registerProjectLaunchDelegate(target, process.env.TOKEN)
    console.log(JSON.stringify({ pid: lease.pid, processStart: lease.processStart }))
    let ownerGoneAt = 0
    const finish = () => { clearInterval(timer); lease.release(); process.exit(0) }
    const timer = setInterval(() => {
      try { process.kill(Number(process.env.OWNER_PID), 0); ownerGoneAt = 0 }
      catch {
        ownerGoneAt ||= Date.now()
        if (Date.now() - ownerGoneAt >= Number(process.env.EXIT_DELAY_MS ?? 300)) finish()
      }
    }, 10)
    process.on("SIGTERM", finish)
  `;
  const child = spawnChild(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: uiRoot,
      env: { ...process.env, TARGET: JSON.stringify(target), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const line = new Promise<Record<string, unknown>>(
    (resolveLine, rejectLine) => {
      child.stdout.on("data", () => {
        const newline = stdout.indexOf("\n");
        if (newline >= 0)
          resolveLine(
            JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>
          );
      });
      child.once("exit", (code, signal) => {
        if (!stdout.includes("\n"))
          rejectLine(
            new Error(`launch child exited ${code}/${signal}: ${stderr}`)
          );
      });
    }
  );
  void line.catch(() => {});
  return { child, line };
}

async function stopDisposableChild(
  child: ReturnType<typeof spawnChild>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function runRealCli(
  cwd: string,
  home: string,
  args: string[]
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  for (const name of [
    "FRAY_DEV_CHILD",
    "FRAY_DIRECT_SUPERVISOR",
    "FRAY_DAEMON_CHILD",
    "FRAY_DEV_REEXEC",
    "FRAY_LAUNCH_OWNER_TOKEN",
    "FRAY_LAUNCH_PROJECT_ID",
    "FRAY_LAUNCH_PROJECT_DIR",
    "FRAY_LAUNCH_STATE_DIR",
    "FRAY_LAUNCH_IDENTITY_SCOPE",
  ])
    delete env[name];
  const child = spawnChild(process.execPath, [cliEntry, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
  timeout.unref?.();
  try {
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null
    ];
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function spawnIdentityChild(
  mode: IdentityMode,
  cwd: string,
  home: string,
  barrier: string,
  ready: string
) {
  const source = `
    import { existsSync, writeFileSync } from "node:fs"
    import { resolveWorkspace } from ${JSON.stringify(launcherModuleUrl)}
    import { resolveProject } from ${JSON.stringify(projectModuleUrl)}

    const [mode, cwd, home, barrier, ready] = process.argv.slice(1)
    writeFileSync(ready, "ready")
    const wait = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(barrier)) Atomics.wait(wait, 0, 0, 5)
    const value = mode === "cli" ? resolveWorkspace(cwd, home) : resolveProject(cwd, home)
    const root = mode === "cli" ? value.root : value.dir
    const identityScope = value.identityScope === "worktree" ? "worktree" : "repository"
    process.stdout.write(JSON.stringify({
      root,
      id: value.id,
      stateDir: value.stateDir,
      identityScope,
      socket: value.tmuxSocket,
    }))
  `;
  const child = spawnChild(
    process.execPath,
    ["--input-type=module", "-e", source, mode, cwd, home, barrier, ready],
    {
      cwd: uiRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<IdentityResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(`identity child exited ${code ?? signal}: ${stderr.trim()}`)
        );
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as IdentityResult);
      } catch (error) {
        reject(
          new Error(`identity child returned invalid JSON: ${stdout}`, {
            cause: error,
          })
        );
      }
    });
  });
  // Readiness failures are reported below; attach a handler immediately so an early child exit does
  // not become an unhandled rejection while its siblings are still reaching the barrier.
  void result.catch(() => {});
  return { child, result };
}

async function runIdentityRace(
  base: string,
  specs: Array<{ mode: IdentityMode; cwd: string }>,
  home: string
): Promise<IdentityResult[]> {
  const barrier = join(base, "identity-race.go");
  const readyPaths = specs.map((_, index) =>
    join(base, `identity-race-${index}.ready`)
  );
  const children = specs.map((spec, index) =>
    spawnIdentityChild(spec.mode, spec.cwd, home, barrier, readyPaths[index]!)
  );
  try {
    const deadline = Date.now() + 10_000;
    while (!readyPaths.every(existsSync)) {
      if (Date.now() >= deadline)
        throw new Error("identity children did not reach the race barrier");
      await delay(10);
    }
    writeFileSync(barrier, "go");
    return await Promise.all(children.map(({ result }) => result));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}

function assertOneIdentity(
  results: IdentityResult[],
  repo: string,
  home: string
): string {
  assert.ok(results.length > 1);
  const [first] = results;
  assert.ok(first);
  assert.deepEqual(
    [...new Set(results.map(({ root }) => root))],
    [realpathSync(repo)]
  );
  assert.deepEqual([...new Set(results.map(({ id }) => id))], [first.id]);
  assert.deepEqual(
    [...new Set(results.map(({ stateDir }) => stateDir))],
    [join(home, ".fray", "projects", first.id)]
  );
  assert.deepEqual(
    [...new Set(results.map(({ socket }) => socket))],
    [deriveSocket(first.id)]
  );
  assert.deepEqual(
    [...new Set(results.map(({ identityScope }) => identityScope))],
    ["repository"]
  );
  assert.deepEqual(
    execFileSync("git", ["config", "--local", "--get-all", "fray.id"], {
      cwd: repo,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/u),
    [first.id]
  );
  assert.deepEqual(readdirSync(join(home, ".fray", "projects")).sort(), [
    first.id,
  ]);
  assert.equal(existsSync(join(repo, ".fray", "fray.id")), false);
  return first.id;
}

test("CLI options default to immutable mode and make source/HMR explicit", () => {
  assert.deepEqual(parseCliArgs([]), {
    noApp: false,
    appMode: false,
    foreground: true,
    stop: false,
    status: false,
    help: false,
    dev: false,
    port: undefined,
    repoPath: undefined,
  });
  assert.deepEqual(parseCliArgs(["--no-app", "--foreground", "--port=5123"]), {
    noApp: true,
    appMode: false,
    foreground: true,
    stop: false,
    status: false,
    help: false,
    dev: false,
    port: 5123,
    repoPath: undefined,
  });
  assert.equal(parseCliArgs(["--dev"]).dev, true);
  assert.equal(
    parseCliArgs(["--no-app", "/tmp/repo with spaces"]).repoPath,
    "/tmp/repo with spaces"
  );
  assert.equal(parseCliArgs(["--app"]).appMode, true);
  assert.throws(() => parseCliArgs(["--port", "nope"]), /invalid --port/);
  assert.throws(() => parseCliArgs(["--port"]), /requires a value/);
  assert.equal(parseCliArgs(["--foreground"]).foreground, true);
  assert.throws(() => parseCliArgs(["--detach"]), /always runs in the foreground/);
  assert.throws(() => parseCliArgs(["--app", "--no-app"]), /either/);
  assert.throws(
    () => parseCliArgs(["one", "two"]),
    /at most one repository path/
  );
  assert.throws(() => parseCliArgs(["--mystery"]), /unknown option/);
  assert.match(helpText(), /always runs in the foreground/);
  assert.match(helpText(), /default browser/);
  assert.match(helpText(), /--app\s+use the legacy dedicated app window/);
  assert.match(
    helpText(),
    /--dev\s+explicitly use the unsafe source watcher and Vite\/HMR/
  );
});

test("workspace identity canonicalizes a symlink and survives spaces", () => {
  const base = mkdtempSync(join(tmpdir(), "fray launcher "));
  const repo = join(base, "repo with spaces");
  const alias = join(base, "repo alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    symlinkSync(repo, alias);
    const direct = resolveWorkspace(repo, home);
    const linked = resolveWorkspace(alias, home);
    assert.equal(linked.root, direct.root);
    assert.equal(linked.id, direct.id);
    assert.equal(linked.stateDir, direct.stateDir);
    assert.match(linked.root, /repo with spaces$/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("main and linked worktrees concurrently resolve to three stable isolated Fray instances", async () => {
  const base = mkdtempSync(join(tmpdir(), "fray linked worktree race "));
  const main = join(base, "main repo with spaces");
  const linkedOne = join(base, "linked worktree one");
  const linkedTwo = join(base, "linked worktree two");
  const linkedAlias = join(base, "linked one alias");
  const home = join(base, "home");
  const legacyId = "11111111-1111-4111-8111-111111111111";
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: main,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: main,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
      cwd: main,
    });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "linked-one", linkedOne],
      { cwd: main }
    );
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "linked-two", linkedTwo],
      { cwd: main }
    );
    execFileSync("git", ["config", "--local", "--add", "fray.id", legacyId], {
      cwd: main,
    });
    symlinkSync(linkedOne, linkedAlias);
    mkdirSync(join(home, ".fray", "projects", legacyId), { recursive: true });
    writeFileSync(
      join(home, ".fray", "projects", legacyId, "legacy-state"),
      "preserved"
    );

    const results = await runIdentityRace(
      base,
      [
        { mode: "cli", cwd: main },
        { mode: "server", cwd: main },
        { mode: "cli", cwd: linkedOne },
        { mode: "server", cwd: linkedAlias },
        { mode: "cli", cwd: linkedTwo },
        { mode: "server", cwd: linkedTwo },
      ],
      home
    );
    const roots = [main, linkedOne, linkedTwo].map((path) =>
      realpathSync(path)
    );
    const byRoot = new Map(
      roots.map((root) => [
        root,
        results.filter((result) => result.root === root),
      ])
    );
    assert.deepEqual(
      [...new Set(results.map((result) => result.root))].sort(),
      roots.sort()
    );

    for (const [root, group] of byRoot) {
      assert.equal(group.length, 2, `CLI and server agree for ${root}`);
      assert.equal(new Set(group.map(({ id }) => id)).size, 1);
      assert.equal(new Set(group.map(({ stateDir }) => stateDir)).size, 1);
      assert.equal(new Set(group.map(({ socket }) => socket)).size, 1);
      assert.equal(
        new Set(group.map(({ identityScope }) => identityScope)).size,
        1
      );
    }

    const representatives = roots.map((root) => byRoot.get(root)![0]!);
    assert.equal(new Set(representatives.map(({ id }) => id)).size, 3);
    assert.equal(
      new Set(representatives.map(({ stateDir }) => stateDir)).size,
      3
    );
    assert.equal(new Set(representatives.map(({ socket }) => socket)).size, 3);
    assert.equal(
      new Set(representatives.map(({ stateDir }) => join(stateDir, "ui.db")))
        .size,
      3
    );

    const mainResult = byRoot.get(realpathSync(main))![0]!;
    assert.equal(
      mainResult.id,
      legacyId,
      "main worktree retains the pre-migration repository identity"
    );
    assert.equal(mainResult.identityScope, "repository");
    assert.equal(
      mainResult.stateDir,
      join(home, ".fray", "projects", legacyId)
    );
    assert.equal(
      mainResult.socket,
      deriveSocket(legacyId),
      "main worktree migrates to its full project socket"
    );
    assert.equal(
      readFileSync(join(mainResult.stateDir, "legacy-state"), "utf8"),
      "preserved"
    );
    for (const linked of [linkedOne, linkedTwo]) {
      const result = byRoot.get(realpathSync(linked))![0]!;
      assert.equal(result.identityScope, "worktree");
      assert.notEqual(result.id, legacyId);
      assert.equal(result.socket, deriveProjectSocket(result.id, true));
      const config = resolveGitWorktree(linked).identityConfig;
      assert.ok(config);
      assert.equal(
        execFileSync(
          "git",
          ["config", "--file", config, "--get-all", "fray.id"],
          { encoding: "utf8" }
        ).trim(),
        result.id
      );
    }
    assert.equal(
      execFileSync("git", ["config", "--local", "--get-all", "fray.id"], {
        cwd: main,
        encoding: "utf8",
      }).trim(),
      legacyId
    );
    assert.throws(
      () =>
        execFileSync(
          "git",
          ["config", "--local", "--get", "extensions.worktreeConfig"],
          { cwd: main, stdio: "ignore" }
        ),
      "Fray does not mutate the repository-wide worktreeConfig extension"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("linked worktree identity survives moves and is retired on removal", () => {
  const base = mkdtempSync(join(tmpdir(), "fray worktree lifecycle "));
  const main = join(base, "main");
  const linked = join(base, "linked old");
  const moved = join(base, "linked moved");
  const alias = join(base, "moved alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: main,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: main,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
      cwd: main,
    });
    execFileSync("git", ["worktree", "add", "-q", "-b", "movable", linked], {
      cwd: main,
    });

    const before = resolveWorkspace(linked, home);
    const privateConfig = resolveGitWorktree(linked).identityConfig;
    assert.ok(privateConfig && existsSync(privateConfig));
    execFileSync("git", ["worktree", "move", linked, moved], { cwd: main });
    symlinkSync(moved, alias);

    const afterMove = resolveWorkspace(alias, home);
    assert.equal(afterMove.id, before.id);
    assert.equal(afterMove.stateDir, before.stateDir);
    assert.equal(afterMove.root, realpathSync(moved));
    assert.equal(resolveGitWorktree(moved).identityConfig, privateConfig);

    rmSync(alias);
    execFileSync("git", ["worktree", "remove", moved], { cwd: main });
    assert.equal(existsSync(privateConfig), false);
    execFileSync("git", ["worktree", "add", "-q", moved, "movable"], {
      cwd: main,
    });
    const replacement = resolveWorkspace(moved, home);
    assert.notEqual(
      replacement.id,
      before.id,
      "a removed worktree's private identity is not inherited"
    );
    assert.notEqual(replacement.stateDir, before.stateDir);
    assert.equal(
      existsSync(before.stateDir),
      true,
      "historical state is preserved rather than reassigned"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("simultaneous first-run CLI processes commit one project identity", async () => {
  const base = mkdtempSync(join(tmpdir(), "fray cli identity race "));
  const repo = join(base, "repo with spaces");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(home);
    const results = await runIdentityRace(
      base,
      Array.from({ length: 8 }, () => ({ mode: "cli" as const, cwd: repo })),
      home
    );
    assertOneIdentity(results, repo, home);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("simultaneous CLI and direct-server starts share one identity namespace through aliases", async () => {
  const base = mkdtempSync(join(tmpdir(), "fray mixed identity race "));
  const repo = join(base, "canonical repo with spaces");
  const alias = join(base, "symlink repo alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    symlinkSync(repo, alias);
    mkdirSync(home);
    const results = await runIdentityRace(
      base,
      Array.from({ length: 8 }, (_, index) => ({
        mode: index % 2 === 0 ? ("cli" as const) : ("server" as const),
        cwd: index % 3 === 0 ? alias : repo,
      })),
      home
    );
    assertOneIdentity(results, repo, home);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("invalid or duplicated git-local project ids fail closed before state paths are derived", () => {
  const base = mkdtempSync(join(tmpdir(), "fray invalid identity "));
  const repo = join(base, "repo");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync(
      "git",
      ["config", "--local", "--add", "fray.id", "../../outside"],
      { cwd: repo }
    );
    assert.throws(
      () => resolveWorkspace(repo, home),
      /expected exactly one UUID/
    );
    assert.throws(
      () => resolveProject(repo, home),
      /expected exactly one UUID/
    );
    assert.equal(existsSync(join(home, ".fray", "projects")), false);

    execFileSync("git", ["config", "--local", "--unset-all", "fray.id"], {
      cwd: repo,
    });
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "--add",
        "fray.id",
        "11111111-1111-1111-1111-111111111111",
      ],
      { cwd: repo }
    );
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "--add",
        "fray.id",
        "22222222-2222-2222-2222-222222222222",
      ],
      { cwd: repo }
    );
    assert.throws(
      () => resolveWorkspace(repo, home),
      /expected exactly one UUID/
    );
    assert.throws(
      () => resolveProject(repo, home),
      /expected exactly one UUID/
    );
    assert.equal(existsSync(join(repo, ".fray", "fray.id")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("linked-worktree identity config fails closed and recovers from an interrupted Git config lock", () => {
  const base = mkdtempSync(join(tmpdir(), "fray linked invalid identity "));
  const main = join(base, "main");
  const linked = join(base, "linked");
  const home = join(base, "home");
  const repositoryId = "11111111-1111-4111-8111-111111111111";
  const validWorktreeId = "22222222-2222-4222-8222-222222222222";
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: main,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: main,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
      cwd: main,
    });
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], {
      cwd: main,
    });
    execFileSync(
      "git",
      ["config", "--local", "--add", "fray.id", repositoryId],
      { cwd: main }
    );
    const config = resolveGitWorktree(linked).identityConfig;
    assert.ok(config);

    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "fray.id",
      "../../outside",
    ]);
    assert.throws(
      () => resolveWorkspace(linked, home),
      /linked-worktree fray\.id is invalid/
    );
    rmSync(config);
    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "fray.id",
      validWorktreeId,
    ]);
    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "fray.id",
      validWorktreeId,
    ]);
    assert.throws(
      () => resolveWorkspace(linked, home),
      /linked-worktree fray\.id is invalid/
    );

    rmSync(config);
    execFileSync("git", [
      "config",
      "--file",
      config,
      "--add",
      "fray.id",
      repositoryId,
    ]);
    assert.throws(
      () => resolveWorkspace(linked, home),
      /must differ from the repository/
    );

    rmSync(config);
    writeFileSync(`${config}.lock`, "partial interrupted config\n");
    assert.throws(
      () => resolveWorkspace(linked, home),
      /unable to persist linked-worktree/
    );
    assert.equal(existsSync(join(home, ".fray", "projects")), false);
    rmSync(`${config}.lock`);

    const recovered = resolveWorkspace(linked, home);
    assert.equal(recovered.identityScope, "worktree");
    assert.notEqual(recovered.id, repositoryId);
    assert.equal(
      execFileSync(
        "git",
        ["config", "--file", config, "--get-all", "fray.id"],
        { encoding: "utf8" }
      ).trim(),
      recovered.id
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an interrupted Git config write fails without inventing an id and recovers cleanly", () => {
  const base = mkdtempSync(join(tmpdir(), "fray config lock recovery "));
  const repo = join(base, "repo");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    const configLock = join(repo, ".git", "config.lock");
    writeFileSync(configLock, "partial interrupted config\n");
    assert.throws(() => resolveWorkspace(repo, home), /unable to persist/);
    assert.throws(() =>
      execFileSync("git", ["config", "--local", "--get-all", "fray.id"], {
        cwd: repo,
        stdio: "ignore",
      })
    );
    assert.equal(existsSync(join(home, ".fray", "projects")), false);

    rmSync(configLock);
    const recovered = resolveWorkspace(repo, home);
    assert.match(recovered.id, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(readdirSync(join(home, ".fray", "projects")), [
      recovered.id,
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a malformed repository config never degrades direct startup into a random namespace", () => {
  const base = mkdtempSync(join(tmpdir(), "fray malformed config "));
  const repo = join(base, "repo");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    const config = join(repo, ".git", "config");
    writeFileSync(config, `${readFileSync(config, "utf8")}\n[unterminated\n`);
    assert.throws(
      () => resolveWorkspace(repo, home),
      /must be run inside a Git repository/
    );
    assert.throws(
      () => resolveProject(repo, home),
      /unable to resolve Git repository root/
    );
    assert.equal(existsSync(join(home, ".fray", "projects")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("submodules keep an independent ordinary-repository identity", () => {
  const base = mkdtempSync(join(tmpdir(), "fray submodule identity "));
  const upstream = join(base, "submodule upstream");
  const parent = join(base, "parent repo");
  const submodule = join(parent, "modules", "child module");
  const alias = join(base, "submodule alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", upstream]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: upstream,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: upstream,
    });
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "submodule initial"],
      { cwd: upstream }
    );
    execFileSync("git", ["init", "-q", parent]);
    execFileSync("git", ["config", "user.email", "identity@example.invalid"], {
      cwd: parent,
    });
    execFileSync("git", ["config", "user.name", "Identity Test"], {
      cwd: parent,
    });
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "parent initial"],
      { cwd: parent }
    );
    execFileSync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        upstream,
        "modules/child module",
      ],
      { cwd: parent }
    );
    symlinkSync(submodule, alias);

    const parentWorkspace = resolveWorkspace(parent, home);
    const childWorkspace = resolveWorkspace(submodule, home);
    const aliasedChild = resolveWorkspace(alias, home);
    assert.equal(parentWorkspace.identityScope, "repository");
    assert.equal(childWorkspace.identityScope, "repository");
    assert.notEqual(childWorkspace.id, parentWorkspace.id);
    assert.notEqual(childWorkspace.stateDir, parentWorkspace.stateDir);
    assert.equal(aliasedChild.id, childWorkspace.id);
    assert.equal(aliasedChild.root, childWorkspace.root);
    assert.equal(
      resolveGitWorktree(submodule).gitDir,
      resolveGitWorktree(submodule).commonGitDir
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("bare and non-Git directories retain their explicit fail-closed/degraded behavior", () => {
  const base = mkdtempSync(join(tmpdir(), "fray non-worktree identity "));
  const bare = join(base, "bare repo.git");
  const plain = join(base, "plain directory");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", "--bare", bare]);
    mkdirSync(plain);
    assert.throws(
      () => resolveWorkspace(bare, home),
      /must be run inside a Git repository/
    );
    assert.throws(
      () => resolveProject(bare, home),
      /unable to resolve Git repository root/
    );
    assert.throws(
      () => resolveWorkspace(plain, home),
      /must be run inside a Git repository/
    );

    const degraded = resolveProject(plain, home);
    assert.equal(degraded.dir, realpathSync(plain));
    assert.match(degraded.id, /^[0-9a-f-]{36}$/u);
    assert.equal(degraded.identityScope, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an existing id stays lock-free for a source supervisor child", async () => {
  const base = mkdtempSync(join(tmpdir(), "fray existing identity "));
  const repo = join(base, "repo");
  const alias = join(base, "alias");
  const home = join(base, "home");
  try {
    execFileSync("git", ["init", "-q", repo]);
    symlinkSync(repo, alias);
    const initial = resolveWorkspace(repo, home);
    const release = await acquireGlobalLaunchLock(home);
    try {
      const startedAt = Date.now();
      const childProject = resolveProject(alias, home);
      assert.equal(childProject.id, initial.id);
      assert.equal(childProject.dir, initial.root);
      assert.equal(childProject.stateDir, initial.stateDir);
      assert.ok(
        Date.now() - startedAt < 1_000,
        "valid existing identity should not wait on the launch lock"
      );
    } finally {
      release();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("health probes accept only the expected Fray workspace identity", async () => {
  const fetcher = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        projectId: "p1",
        projectDir: "/tmp/repo",
        bootId: "boot",
        ownerProof: "proof",
      })
    );
  assert.equal(
    (
      await probeFray(
        5000,
        { projectId: "p1", projectDir: "/tmp/repo" },
        fetcher as typeof fetch
      )
    )?.projectDir,
    "/tmp/repo"
  );
  assert.equal(
    (
      await probeFray(
        5000,
        {
          projectId: "p1",
          projectDir: "/tmp/repo",
          ownerProof: "proof",
        },
        fetcher as typeof fetch
      )
    )?.ownerProof,
    "proof"
  );
  assert.equal(
    await probeFray(
      5000,
      {
        projectId: "p1",
        projectDir: "/tmp/repo",
        ownerProof: "forged",
      },
      fetcher as typeof fetch
    ),
    null
  );
  assert.equal(
    await probeFray(
      5000,
      { projectId: "other", projectDir: "/tmp/repo" },
      fetcher as typeof fetch
    ),
    null
  );
  assert.equal(
    await probeFray(
      5000,
      { projectId: "p1", projectDir: "/tmp/hostile-other-worktree" },
      fetcher as typeof fetch
    ),
    null
  );
  assert.equal(
    await probeFray(
      5000,
      { projectId: "p1", projectDir: "/tmp/repo" },
      (async () => new Response("nope")) as typeof fetch
    ),
    null
  );
});

test("token-bound status and control remain usable when external generation proof is unavailable", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fray-no-process-proof-"));
  const target: ProjectLaunchTarget = {
    projectId: randomUUID(),
    projectDir,
    stateDir: join(projectDir, "state"),
  };
  const owner = acquireProjectLaunchOwner(target, "supervisor");
  try {
    const record = readProjectLaunchOwner(target.stateDir)!;
    const unavailable: ProcessPlatformAdapter = {
      current: () => ({
        pid: record.pid + 10_000,
        processStart: "opaque:external-cli",
      }),
      observe: () => ({ confidence: "unavailable" }),
      isAlive: (pid) => pid === record.pid || pid === record.pid + 10_000,
      now: () => Date.now(),
      sleep: () => {},
    };
    const statusPath = join(target.stateDir, "dev-supervisor.lock");
    const status = {
      pid: record.pid,
      processStart: record.processStart,
      publisherToken: randomUUID(),
      ownerToken: record.token,
      projectId: target.projectId,
      projectDir: target.projectDir,
      port: 5099,
      state: "ready",
    };
    writeFileSync(statusPath, JSON.stringify(status));
    assert.deepEqual(
      liveWorkspaceOwner(target.stateDir, target, unavailable),
      status
    );

    writeFileSync(
      statusPath,
      JSON.stringify({ ...status, ownerToken: randomUUID() })
    );
    assert.equal(
      liveWorkspaceOwner(target.stateDir, target, unavailable),
      null
    );
    writeFileSync(
      statusPath,
      JSON.stringify({ ...status, projectDir: `${target.projectDir}-forged` })
    );
    assert.equal(
      liveWorkspaceOwner(target.stateDir, target, unavailable),
      null
    );
    writeFileSync(statusPath, JSON.stringify(status));

    const expected = expectedOwnerHealth(target, record);
    const proof = projectLaunchTokenProof(target, owner.token);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            projectId: target.projectId,
            projectDir: target.projectDir,
            bootId: "boot",
            ownerProof: proof,
          })
        );
      }
      assert.equal(
        new Headers(init?.headers).get("x-fray-launch-token"),
        owner.token
      );
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as typeof fetch;
    assert.equal(
      await requestFrayStop(status.port, expected, owner.token, fetcher),
      true
    );
    assert.equal(requests.length, 2);
  } finally {
    owner.release();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test(
  "real fray --stop reaps a dead v2 owner without attempting to signal it",
  { timeout: 15_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "fray-real-dead-owner-stop-"));
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
    const owner = spawnLaunchProtocolChild("owner", target);
    try {
      assert.ok((await owner.line).token);
      const exited = once(owner.child, "exit");
      owner.child.kill("SIGKILL");
      await exited;

      const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.match(result.stdout, /stopped Fray UI/u);
      assert.equal(readProjectLaunchOwner(target.stateDir), null);
    } finally {
      await stopDisposableChild(owner.child);
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test(
  "real fray --stop never falls back to a PID signal when authenticated control fails",
  { timeout: 15_000 },
  async () => {
    const base = mkdtempSync(
      join(tmpdir(), "fray-real-live-owner-stop-refusal-")
    );
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
    const owner = spawnLaunchProtocolChild("owner", target, {
      FAIL_CONTROL: "1",
    });
    try {
      const ownerRecord = await owner.line;
      assert.ok(Number.isInteger(ownerRecord.port));
      writeFileSync(
        join(target.stateDir, "dev-supervisor.lock"),
        JSON.stringify({
          pid: ownerRecord.pid,
          processStart: ownerRecord.processStart,
          ownerToken: ownerRecord.token,
          projectId: target.projectId,
          projectDir: target.projectDir,
          port: ownerRecord.port,
          state: "ready",
        })
      );
      const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /without authenticated token-bound control/u);
      assert.equal(
        owner.child.exitCode,
        null,
        "the unrelated live PID remains untouched"
      );
      assert.equal(
        owner.child.signalCode,
        null,
        "the unrelated live PID receives no signal"
      );
      assert.equal(
        readProjectLaunchOwner(target.stateDir)?.token,
        ownerRecord.token
      );
      assert.equal(
        existsSync(join(target.stateDir, "stable.json")),
        false,
        "a failed --stop must not fall through to artifact selection or a fresh launch"
      );
      assert.equal(
        existsSync(join(target.stateDir, "dev.log")),
        false,
        "a failed --stop must not spawn the detached supervisor"
      );
    } finally {
      await stopDisposableChild(owner.child);
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test(
  "real fray --stop refuses live opaque and observable weak owners without token control",
  { timeout: 20_000 },
  async () => {
    const base = mkdtempSync(
      join(tmpdir(), "fray-real-unverifiable-owner-stop-")
    );
    try {
      for (const [index, kind] of (["opaque", "weak"] as const).entries()) {
        const repo = join(base, `repo-${index}`);
        const home = join(base, `home-${index}`);
        mkdirSync(repo);
        execFileSync("git", ["init", "-q"], { cwd: repo });
        const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
        const live = spawnChild(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          { stdio: "ignore" }
        );
        assert.ok(live.pid);
        let marker = `opaque:${randomUUID()}`;
        if (kind === "weak") {
          let observed = defaultProcessPlatformAdapter.observe(live.pid);
          const deadline = Date.now() + 2_000;
          while (!observed.processStart && Date.now() < deadline) {
            await delay(10);
            observed = defaultProcessPlatformAdapter.observe(live.pid);
          }
          if (!observed.processStart || observed.confidence !== "weak") {
            await stopDisposableChild(live);
            continue;
          }
          marker = observed.processStart;
        }
        const adapter: ProcessPlatformAdapter = {
          current: () => ({ pid: live.pid!, processStart: marker }),
          observe: (pid) =>
            pid === live.pid
              ? {
                  processStart: marker,
                  confidence: marker.startsWith("ps-utc:")
                    ? "weak"
                    : "unavailable",
                }
              : { confidence: "unavailable" },
          isAlive: (pid) =>
            pid === live.pid &&
            live.exitCode === null &&
            live.signalCode === null,
          now: () => Date.now(),
          sleep: () => {},
        };
        const lease = acquireProjectLaunchOwner(target, "supervisor", {
          adapter,
        });
        try {
          const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
          assert.equal(result.code, 1);
          assert.equal(result.signal, null);
          assert.match(
            result.stderr,
            /without authenticated token-bound control/u
          );
          assert.equal(
            readProjectLaunchOwner(target.stateDir)?.token,
            lease.token
          );
          assert.equal(live.exitCode, null);
          assert.equal(live.signalCode, null);
        } finally {
          lease.release();
          await stopDisposableChild(live);
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test(
  "real fray --stop drains a dead owner's delegate before removing token status",
  { timeout: 15_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "fray-real-delegate-stop-"));
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const target = workspaceLaunchTarget(resolveWorkspace(repo, home));
    const owner = spawnLaunchProtocolChild("owner", target);
    let delegate: ReturnType<typeof spawnLaunchProtocolChild> | undefined;
    try {
      const ownerRecord = await owner.line;
      delegate = spawnLaunchProtocolChild("delegate", target, {
        TOKEN: String(ownerRecord.token),
        OWNER_PID: String(ownerRecord.pid),
        EXIT_DELAY_MS: "300",
      });
      const delegateRecord = await delegate.line;
      const statusPath = join(target.stateDir, "server.lock");
      writeFileSync(
        statusPath,
        JSON.stringify({
          pid: delegateRecord.pid,
          processStart: delegateRecord.processStart,
          ownerToken: ownerRecord.token,
          projectId: target.projectId,
          projectDir: target.projectDir,
          port: 5095,
          state: "ready",
        })
      );

      const ownerExit = once(owner.child, "exit");
      owner.child.kill("SIGKILL");
      await ownerExit;
      const result = await runRealCli(repo, home, ["--stop", "--no-app"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /stopped Fray UI/u);
      assert.equal(readProjectLaunchOwner(target.stateDir), null);
      assert.equal(existsSync(statusPath), false);
      await stopDisposableChild(delegate.child);
    } finally {
      await stopDisposableChild(owner.child);
      if (delegate) await stopDisposableChild(delegate.child);
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test("workspace status rejects a reused PID generation without probing a port or signalling", () => {
  const base = mkdtempSync(join(tmpdir(), "fray-reused-status-generation-"));
  const target: ProjectLaunchTarget = {
    projectId: randomUUID(),
    projectDir: base,
    stateDir: join(base, "state"),
  };
  const ownerGeneration = { pid: 710, processStart: "linux:boot:owner" };
  const delegateGeneration = {
    pid: 711,
    processStart: "linux:boot:old-delegate",
  };
  let self = ownerGeneration;
  const processTable = new Map([
    [ownerGeneration.pid, ownerGeneration.processStart],
    [delegateGeneration.pid, delegateGeneration.processStart],
  ]);
  const adapter: ProcessPlatformAdapter = {
    current: () => self,
    observe: (pid) => {
      const processStart = processTable.get(pid);
      return processStart
        ? { processStart, confidence: "exact" }
        : { confidence: "unavailable" };
    },
    isAlive: (pid) => processTable.has(pid),
    now: () => Date.now(),
    sleep: () => {},
  };
  const owner = acquireProjectLaunchOwner(target, "supervisor", { adapter });
  self = delegateGeneration;
  const delegate = registerProjectLaunchDelegate(
    target,
    owner.token,
    "control-plane",
    { adapter }
  );
  self = ownerGeneration;
  const status = {
    pid: delegate.pid,
    processStart: delegate.processStart,
    publisherToken: randomUUID(),
    ownerToken: owner.token,
    projectId: target.projectId,
    projectDir: target.projectDir,
    port: 5098,
    state: "ready",
  };
  try {
    writeFileSync(join(target.stateDir, "server.lock"), JSON.stringify(status));
    assert.deepEqual(
      liveWorkspaceOwner(target.stateDir, target, adapter),
      status
    );

    processTable.set(delegate.pid, "linux:boot:reused-delegate");
    assert.equal(liveWorkspaceOwner(target.stateDir, target, adapter), null);

    const legacyState = join(base, "legacy-state");
    mkdirSync(legacyState);
    writeFileSync(
      join(legacyState, "server.lock"),
      JSON.stringify({
        pid: delegate.pid,
        processStart: delegate.processStart,
        port: 5097,
        state: "ready",
      })
    );
    assert.equal(liveWorkspaceOwner(legacyState, undefined, adapter), null);
  } finally {
    delegate.release();
    owner.release();
    rmSync(base, { recursive: true, force: true });
  }
});

test("workspace status compares a stored generation with a real disposable process", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "fray-real-status-generation-"));
  const child = spawnChild(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    {
      stdio: "ignore",
    }
  );
  try {
    assert.ok(child.pid);
    let observed = defaultProcessPlatformAdapter.observe(child.pid);
    const deadline = Date.now() + 2_000;
    while (!observed.processStart && Date.now() < deadline) {
      await delay(10);
      observed = defaultProcessPlatformAdapter.observe(child.pid);
    }
    if (!observed.processStart || observed.confidence === "unavailable") {
      t.skip("this platform cannot observe an external process generation");
      return;
    }

    const path = join(base, "server.lock");
    const stale = {
      pid: child.pid,
      processStart: `${observed.processStart}-prior-generation`,
      port: 5096,
      state: "ready",
    };
    writeFileSync(path, JSON.stringify(stale));
    assert.equal(liveWorkspaceOwner(base), null);

    const current = { ...stale, processStart: observed.processStart };
    writeFileSync(path, JSON.stringify(current));
    assert.deepEqual(liveWorkspaceOwner(base), current);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise<void>((resolveClose) =>
      child.once("close", () => resolveClose())
    );
    rmSync(base, { recursive: true, force: true });
  }
});

test("port selection preserves a free preference, scans conflicts, and fails an occupied explicit port", async () => {
  const used = new Set([4917, 4918]);
  const available = async (port: number) => !used.has(port);
  assert.equal(await choosePort(undefined, 4999, available), 4999);
  assert.equal(await choosePort(undefined, 4917, available), 4919);
  await assert.rejects(
    choosePort(4917, undefined, available),
    /already in use/
  );
});

test("two distinct repositories concurrently reserve different launch ports without sharing tmux ownership", async () => {
  const base = mkdtempSync(join(tmpdir(), "fray-concurrent-repo-ports-"));
  const home = join(base, "home");
  const repos = [join(base, "repo-one"), join(base, "repo-two")];
  for (const repo of repos) {
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
  }
  const reservations: Array<{ workspace: Workspace; port: number; close: () => Promise<void> }> = [];
  try {
    await Promise.all(
      repos.map(async (repo) => {
        const workspace = resolveWorkspace(repo, home);
        const release = await acquireGlobalLaunchLock(home, 5_000);
        try {
          const port = await choosePort(undefined, readPreferredPort(workspace.stateDir));
          const server = createServer();
          await new Promise<void>((resolveListen, rejectListen) => {
            server.once("error", rejectListen);
            server.listen(port, "127.0.0.1", () => resolveListen());
          });
          reservations.push({
            workspace,
            port,
            close: () =>
              new Promise((resolveClose, rejectClose) =>
                server.close((error) => (error ? rejectClose(error) : resolveClose()))
              ),
          });
        } finally {
          // This mirrors the foreground launcher: serialize only allocation/startup, never runtime.
          release();
        }
      })
    );
    assert.equal(reservations.length, 2);
    assert.equal(new Set(reservations.map(({ port }) => port)).size, 2);
    assert.equal(new Set(reservations.map(({ workspace }) => workspace.id)).size, 2);
    assert.equal(new Set(reservations.map(({ workspace }) => workspace.tmuxSocket)).size, 2);
  } finally {
    await Promise.all(reservations.map(({ close }) => close()));
    rmSync(base, { recursive: true, force: true });
  }
});

test("workspace lock parsing removes stale owners and retains a live supervisor", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-lock-test-"));
  try {
    writeFileSync(
      join(dir, "dev-supervisor.lock"),
      JSON.stringify({ pid: 999_999_999, port: 5000 })
    );
    assert.equal(liveWorkspaceOwner(dir), null);
    writeFileSync(
      join(dir, "dev-supervisor.lock"),
      JSON.stringify({ pid: process.pid, port: 0 })
    );
    assert.equal(liveWorkspaceOwner(dir), null);
    writeFileSync(
      join(dir, "dev-supervisor.lock"),
      JSON.stringify({ pid: process.pid, port: 5001, state: "ready" })
    );
    assert.deepEqual(liveWorkspaceOwner(dir), {
      pid: process.pid,
      port: 5001,
      state: "ready",
    });
    writeFileSync(join(dir, "launcher.json"), JSON.stringify({ port: 5001 }));
    assert.equal(readPreferredPort(dir), 5001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status treats failed or degraded supervisor truth as actionable even with a healthy prior child", () => {
  assert.equal(supervisorNeedsAttention(null), false);
  assert.equal(
    supervisorNeedsAttention({ pid: process.pid, port: 5001, state: "ready" }),
    false
  );
  assert.equal(
    supervisorNeedsAttention({
      pid: process.pid,
      port: 5001,
      state: "restarting",
    }),
    false
  );
  assert.equal(
    supervisorNeedsAttention({
      pid: process.pid,
      port: 5001,
      state: "failed",
      message: "config invalid",
    }),
    true
  );
  assert.equal(
    supervisorNeedsAttention({
      pid: process.pid,
      port: 5001,
      state: "degraded",
      message: "watch failed",
    }),
    true
  );
});

test("global allocation lock is exclusive and recovers stale, partial, and crashed claims", async () => {
  const home = mkdtempSync(join(tmpdir(), "fray-global-lock-"));
  const homeAlias = `${home}-alias`;
  try {
    symlinkSync(home, homeAlias);
    const lockPath = join(home, ".fray", "dev-launch.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 999_999_999 })
    );
    const release = await acquireGlobalLaunchLock(homeAlias);
    await assert.rejects(acquireGlobalLaunchLock(home, 30), /still owns/);
    release();

    // A process can die after atomically claiming the pathname but before its JSON is complete.
    writeFileSync(lockPath, '{"version":1');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const releasePartial = await acquireGlobalLaunchLock(home);
    releasePartial();

    // A fully-written owner from a process that exited without releasing is recoverable immediately.
    const crashSource = `
      import { acquireGlobalLaunchLockSync } from ${JSON.stringify(
        projectIdentityModuleUrl
      )}
      acquireGlobalLaunchLockSync(process.argv[1])
    `;
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", crashSource, home],
      { cwd: uiRoot }
    );
    assert.equal(existsSync(lockPath), true);
    const releaseCrashed = await acquireGlobalLaunchLock(home);
    releaseCrashed();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(homeAlias, { force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("separate repositories prepare concurrently while global startup allocation is held", async () => {
  const home = mkdtempSync(join(tmpdir(), "fray-global-launch-sequencing-"));
  let first: { prepared: string; release: () => void } | undefined;
  let second: { prepared: string; release: () => void } | undefined;
  try {
    first = await prepareBeforeGlobalLaunchLock(
      () => "repo-a artifact prepared",
      () => acquireGlobalLaunchLock(home)
    );

    let markSecondPrepared: (() => void) | undefined;
    const secondPrepared = new Promise<void>((resolve) => {
      markSecondPrepared = resolve;
    });
    const secondLaunch = prepareBeforeGlobalLaunchLock(
      () => {
        markSecondPrepared?.();
        return "repo-b artifact prepared";
      },
      () => acquireGlobalLaunchLock(home)
    );

    // Repo B reaches its completed preparation even though repo A still owns the only shared
    // allocation/start lock. It remains blocked only at acquisition.
    await secondPrepared;
    let secondAcquired = false;
    void secondLaunch.then((value) => {
      secondAcquired = true;
      second = value;
    });
    await delay(50);
    assert.equal(secondAcquired, false);

    first.release();
    first = undefined;
    second = await secondLaunch;
    assert.equal(second.prepared, "repo-b artifact prepared");
  } finally {
    second?.release();
    first?.release();
    rmSync(home, { recursive: true, force: true });
  }
});

test("global first-id lock rejects a reused PID generation instead of blocking on PID-only liveness", () => {
  const home = mkdtempSync(join(tmpdir(), "fray-global-generation-lock-"));
  const lockPath = join(home, ".fray", "dev-launch.lock");
  mkdirSync(join(home, ".fray"), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: 700,
      processStart: "linux:boot:old",
      token: randomUUID(),
      at: new Date().toISOString(),
    })
  );
  const adapter: ProcessPlatformAdapter = {
    current: () => ({ pid: 701, processStart: "linux:boot:701" }),
    observe: (pid) =>
      pid === 700
        ? { processStart: "linux:boot:reused", confidence: "exact" }
        : { processStart: "linux:boot:701", confidence: "exact" },
    isAlive: () => true,
    now: () => Date.now(),
    sleep: () => {},
  };
  try {
    const release = acquireGlobalLaunchLockSync(home, 100, adapter);
    assert.equal(existsSync(lockPath), true);
    release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer manages only an executable source-backed immutable fray-dev shim idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-global-bin-"));
  const script = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "scripts",
    "install-global-cli.mjs"
  );
  try {
    execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    const shim = join(dir, "fray-dev");
    const body = readFileSync(shim, "utf8");
    assert.match(body, /fray-dev-source-launcher:v4/);
    assert.match(body, /env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN/);
    assert.match(body, /FRAY_SOURCE_COMMAND='fray-dev'/);
    assert.match(body, /packages\/cli\/src\/index\.ts/);
    assert.match(body, /\bnub\b/);
    assert.match(
      execFileSync(shim, ["--help"], { encoding: "utf8" }),
      /Fray source launcher/
    );
    assert.match(
      execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" }),
      /fray-dev:install/
    );
    assert.match(
      execFileSync(process.execPath, [script, "--check", `--bin-dir=${dir}`], {
        encoding: "utf8",
      }),
      /installed Fray development source launcher/
    );
    execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.equal(
      readFileSync(shim, "utf8"),
      body,
      "a repeat install keeps the owned shim stable"
    );
    execFileSync(
      process.execPath,
      [script, "--uninstall", `--bin-dir=${dir}`],
      { encoding: "utf8" }
    );
    assert.equal(existsSync(shim), false);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [script, "--check", `--bin-dir=${dir}`],
          { encoding: "utf8", stdio: "pipe" }
        ),
      (error: unknown) => {
        assert.match(
          String((error as { stderr?: unknown }).stderr),
          /not installed/
        );
        return true;
      }
    );

    writeFileSync(shim, "#!/bin/sh\necho unrelated\n");
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      (error: unknown) => {
        assert.match(
          String((error as { stderr?: unknown }).stderr),
          /already exists and is not/
        );
        return true;
      }
    );
    execFileSync(
      process.execPath,
      [script, "--uninstall", `--bin-dir=${dir}`],
      { encoding: "utf8" }
    );
    assert.equal(
      existsSync(shim),
      true,
      "uninstall leaves unrelated commands alone"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer rejects marker-bearing stale or altered shims", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-global-bin-stale-"));
  const script = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "scripts",
    "install-global-cli.mjs"
  );
  const shim = join(dir, "fray-dev");
  try {
    writeFileSync(
      shim,
      "#!/bin/sh\n# fray-dev-source-launcher:v3\nexec env FRAY_SOURCE_COMMAND='fray-dev' nub '/missing/deleted-index.ts' \"$@\"\n",
      { mode: 0o755 }
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, "--check", `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /not installed/
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /already exists and is not/
    );
    execFileSync(process.execPath, [script, "--uninstall", `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.equal(existsSync(shim), true, "uninstall leaves invalid shims alone");
    execFileSync(process.execPath, [script, "--force", `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.match(readFileSync(shim, "utf8"), /packages\/cli\/src\/index\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forced install replaces a symlink itself without changing its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-global-bin-symlink-"));
  const script = join(import.meta.dirname, "..", "..", "..", "scripts", "install-global-cli.mjs");
  const shim = join(dir, "fray-dev");
  const protectedTarget = join(dir, "protected-command");
  const protectedBody = "#!/bin/sh\necho protected\n";
  try {
    writeFileSync(protectedTarget, protectedBody, { mode: 0o755 });
    symlinkSync(protectedTarget, shim);
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--bin-dir=${dir}`], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /already exists and is not/
    );
    assert.equal(readFileSync(protectedTarget, "utf8"), protectedBody);
    execFileSync(process.execPath, [script, "--force", `--bin-dir=${dir}`], {
      encoding: "utf8",
    });
    assert.equal(readFileSync(protectedTarget, "utf8"), protectedBody);
    assert.match(readFileSync(shim, "utf8"), /fray-dev-source-launcher:v4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent installer processes publish only complete shims and clean up temporary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-global-bin-atomic-"));
  const script = join(import.meta.dirname, "..", "..", "..", "scripts", "install-global-cli.mjs");
  try {
    const children = Array.from({ length: 8 }, () =>
      spawnChild(process.execPath, [script, `--bin-dir=${dir}`], {
        stdio: "ignore",
      })
    );
    const results = await Promise.all(children.map((child) => once(child, "exit")));
    for (const [code, signal] of results) {
      assert.equal(code, 0, `installer exited with ${String(signal)}`);
    }
    const shim = readFileSync(join(dir, "fray-dev"), "utf8");
    assert.match(shim, /fray-dev-source-launcher:v3/);
    assert.match(shim, /packages\/cli\/src\/index\.ts/);
    assert.deepEqual(readdirSync(dir), ["fray-dev"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
