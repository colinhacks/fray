import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn as spawnChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tmuxSessionName } from "@fray-ui/shared"
import {
  deriveProjectSocket,
  deriveSocket,
  deriveWorktreeSocket,
  hasSession,
  killPane,
  killExpectedAdoptionPane,
  killSession,
  lookupAdoptionPane,
  findAdoptionPane,
  findPaneIdentity,
  findExpectedAdoptionPane,
  captureExpectedAdoptionPane,
  crossSocketLiveOwner,
  sendTextWithKey,
  sendTextWithKeyToExpectedAdoptionPane,
  sendTextToExpectedAdoptionPane,
  expectedAdoptionAttachArgs,
  isExpectedAdoptionPaneLiveAnywhereCached,
  setSocket,
  socketName,
  spawn,
  spawnWithRunner,
  TmuxSpawnError,
} from "./tmux.ts"

const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

test("deriveSocket: per-project socket name from the stable project id", () => {
  // UUIDs retain all 128 bits; the historical first-eight mapping could collide.
  assert.equal(
    deriveSocket("3f2a1b9c-dead-beef-0000-111122223333"),
    "fray-repo-3f2a1b9cdeadbeef0000111122223333",
  )
  assert.notEqual(
    deriveSocket("aaaaaaaa-1111-4111-8111-111111111111"),
    deriveSocket("aaaaaaaa-2222-4222-8222-222222222222"),
  )
  // Non-UUID fixture ids are deterministic and remain valid tmux socket components.
  assert.equal(deriveSocket("--ab-cd-ef-gh--"), "fray-repo-abcdefgh")
  // Empty / missing id falls back to the bare "fray" for narrow compatibility callers.
  assert.equal(deriveSocket(""), "fray")
  assert.equal(deriveSocket(undefined), "fray")
  assert.equal(deriveSocket(null), "fray")
  assert.equal(deriveSocket("abc"), "fray-repo-abc")
})

test("deriveWorktreeSocket: linked worktrees use complete ids and explicit overrides remain verbatim", () => {
  const first = "aaaaaaaa-1111-4111-8111-111111111111"
  const second = "aaaaaaaa-2222-4222-8222-222222222222"
  assert.equal(deriveWorktreeSocket(first), "fray-worktree-aaaaaaaa111141118111111111111111")
  assert.notEqual(deriveWorktreeSocket(first), deriveWorktreeSocket(second))
  assert.equal(deriveProjectSocket(first, true), deriveWorktreeSocket(first))
  assert.equal(deriveProjectSocket(first, true, "fray-legacy-shared"), "fray-legacy-shared")
  assert.equal(deriveProjectSocket(first, false), deriveSocket(first))
  assert.equal(deriveProjectSocket(first, false, "fray-legacy-shared"), "fray-legacy-shared")
  assert.equal(deriveProjectSocket(first), deriveSocket(first))
})

test("setSocket/socketName: install the active socket; empty resets to the default", () => {
  const original = socketName()
  try {
    setSocket("fray-deadbeef")
    assert.equal(socketName(), "fray-deadbeef")
    // Empty string coerces back to the bare "fray" (never an invalid empty -L arg).
    setSocket("")
    assert.equal(socketName(), "fray")
  } finally {
    setSocket(original) // restore so socket state can't leak into other tests in this process
  }
})

test("crossSocketLiveOwner treats absent compatible tmux servers as exited, not an unsafe unknown", { skip: !tmuxAvailable }, () => {
  const original = socketName()
  const projectId = randomUUID()
  const slug = `no-owner-${process.pid}-${Date.now()}`
  setSocket(`fray-cross-socket-active-${process.pid}`)
  try {
    assert.equal(crossSocketLiveOwner(slug, { id: projectId, dir: process.cwd() }), "absent")
  } finally {
    setSocket(original)
  }
})

test("spawn diagnostics never expose prompt argv, cwd, environment credentials, stderr, or exec errors", () => {
  const secret = "github_pat_PRIVATE_CREDENTIAL"
  const prompt = "the full private user prompt"
  const logs: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "))
  let thrown: unknown
  try {
    spawnWithRunner(
      "safe-diagnostic",
      ["worker", prompt],
      `/private/${secret}`,
      { GITHUB_TOKEN: secret },
      { adoptionAttemptToken: randomUUID() },
      () => {
        const error = new Error(`Command failed with ${prompt} ${secret}`) as Error & { stderr: string }
        error.stderr = `tmux echoed ${secret}`
        throw error
      },
    )
  } catch (error) {
    thrown = error
  } finally {
    console.error = originalError
  }
  assert.ok(thrown instanceof TmuxSpawnError)
  assert.equal(thrown.message, "worker spawn failed")
  const rendered = `${logs.join("\n")}\n${String(thrown)}`
  assert.doesNotMatch(rendered, new RegExp(secret))
  assert.doesNotMatch(rendered, new RegExp(prompt))
  assert.doesNotMatch(rendered, /GITHUB_TOKEN|\/private\//)
  assert.match(rendered, /stage=new-session, created=no/)
})

test("new-session atomically exposes the adoption token with its exact pane generation", { skip: !tmuxAvailable }, () => {
  const original = socketName()
  const slug = `adoption-token-${process.pid}`
  const token = randomUUID()
  setSocket(`fray-adoption-token-test-${process.pid}`)
  try {
    const exact = spawn(
      slug,
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
      undefined,
      { adoptionAttemptToken: token },
    )
    const bySlug = lookupAdoptionPane(slug)
    const byToken = findAdoptionPane(token)
    assert.equal(bySlug.kind, "found")
    assert.equal(byToken.kind, "found")
    if (bySlug.kind === "found" && byToken.kind === "found") {
      assert.equal(bySlug.pane.adoptionAttemptToken, token)
      assert.deepEqual(
        { paneId: bySlug.pane.paneId, panePid: bySlug.pane.panePid, sessionCreated: bySlug.pane.sessionCreated },
        exact,
      )
      assert.deepEqual(byToken.pane, bySlug.pane)
    }
  } finally {
    killSession(slug)
    setSocket(original)
  }
})

test("killPane: a reused pane id with a different process tuple is never killed", { skip: !tmuxAvailable }, () => {
  const original = socketName()
  const slug = `kill-pane-identity-${process.pid}`
  setSocket(`fray-kill-pane-test-${process.pid}`)
  try {
    const current = spawn(slug, [process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd())
    assert.equal(hasSession(slug), true)

    killPane({
      paneId: current.paneId,
      panePid: current.panePid + 1,
      sessionCreated: current.sessionCreated - 1,
    })
    assert.equal(hasSession(slug), true, "the matching pane id alone cannot authorize teardown")

    killPane(current)
    assert.equal(hasSession(slug), false, "the complete captured tuple authorizes teardown")
  } finally {
    killSession(slug)
    setSocket(original)
  }
})

test("exact adoption control is atomic, survives rename, and never contacts a replacement", { skip: !tmuxAvailable }, () => {
  const originalSocket = socketName()
  const slug = `exact-control-${process.pid}`
  const renamed = `renamed-exact-${process.pid}`
  const token = randomUUID()
  const competitorToken = randomUUID()
  setSocket(`fray-exact-control-test-${process.pid}`)
  let exact: ReturnType<typeof spawn> | undefined
  try {
    exact = spawn(
      slug,
      [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('OWNER:' + d))"],
      process.cwd(),
      undefined,
      { adoptionAttemptToken: token },
    )
    const expected = {
      attempt_token: token,
      pane_id: exact.paneId,
      pane_pid: exact.panePid,
      session_created: exact.sessionCreated,
    }
    execFileSync("tmux", ["-L", socketName(), "rename-session", "-t", tmuxSessionName(slug), renamed])
    assert.equal(lookupAdoptionPane(slug).kind, "absent", "the reusable canonical name is now free")
    assert.equal(findExpectedAdoptionPane(expected).kind, "found", "global token + tuple still find the renamed owner")
    assert.equal(isExpectedAdoptionPaneLiveAnywhereCached(expected), true)
    assert.equal(captureExpectedAdoptionPane(expected).kind, "captured")
    assert.equal(sendTextWithKeyToExpectedAdoptionPane(expected, "hello-owner", "Enter"), true)

    const competitor = spawn(
      slug,
      [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('COMPETITOR:' + d))"],
      process.cwd(),
      undefined,
      { adoptionAttemptToken: competitorToken },
    )
    const competitorBefore = execFileSync(
      "tmux",
      ["-L", socketName(), "capture-pane", "-p", "-t", tmuxSessionName(slug)],
      { encoding: "utf8" },
    )
    assert.equal(sendTextToExpectedAdoptionPane({ ...expected, attempt_token: competitorToken }, "must-not-send", true), false)
    assert.equal(captureExpectedAdoptionPane({ ...expected, attempt_token: competitorToken }).kind, "unavailable")
    killPane(exact)
    assert.equal(sendTextToExpectedAdoptionPane(expected, "after-replacement", true), false)
    const competitorAfter = execFileSync(
      "tmux",
      ["-L", socketName(), "capture-pane", "-p", "-t", tmuxSessionName(slug)],
      { encoding: "utf8" },
    )
    assert.equal(competitorAfter, competitorBefore, "no stale exact action fell back to the same-name competitor")

    const attach = expectedAdoptionAttachArgs({
      attempt_token: competitorToken,
      pane_id: competitor.paneId,
      pane_pid: competitor.panePid,
      session_created: competitor.sessionCreated,
    })
    assert.equal(attach?.[0], "if-shell")
    assert.match(attach?.join(" ") ?? "", new RegExp(competitor.paneId.replace("%", "\\%")))
    assert.doesNotMatch(attach?.join(" ") ?? "", new RegExp(tmuxSessionName(slug)))
  } finally {
    if (exact) killPane(exact)
    killSession(slug)
    try {
      execFileSync("tmux", ["-L", socketName(), "kill-session", "-t", renamed], { stdio: "ignore" })
    } catch {
      // Exact owner already gone.
    }
    setSocket(originalSocket)
  }
})

test("token + full tuple teardown is one atomic authorization, including dead panes", { skip: !tmuxAvailable }, async () => {
  const originalSocket = socketName()
  const slug = `exact-kill-${process.pid}`
  const token = randomUUID()
  const gateDir = mkdtempSync(join(tmpdir(), "fray-tmux-dead-pane-"))
  const gate = join(gateDir, "release")
  setSocket(`fray-exact-kill-test-${process.pid}`)
  try {
    const exact = spawn(slug, [
      process.execPath,
      "-e",
      "const fs = require('node:fs'); const gate = process.argv[1]; const wait = () => fs.existsSync(gate) ? process.exit(0) : setTimeout(wait, 5); wait()",
      gate,
    ], process.cwd(), undefined, {
      adoptionAttemptToken: token,
    })
    const expected = {
      attempt_token: token,
      pane_id: exact.paneId,
      pane_pid: exact.panePid,
      session_created: exact.sessionCreated,
    }
    assert.equal(killExpectedAdoptionPane({ ...expected, attempt_token: randomUUID() }), false)
    assert.notEqual(findPaneIdentity(exact).kind, "absent", "a retokened same-tuple pane is not killed")
    writeFileSync(gate, "release")
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const lookup = findPaneIdentity(exact)
      if (lookup.kind === "found" && lookup.pane.dead) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const dead = findPaneIdentity(exact)
    assert.equal(dead.kind, "found")
    if (dead.kind === "found") assert.equal(dead.pane.dead, true, "the retained pane exited before teardown")
    assert.equal(killExpectedAdoptionPane(expected), true, "remain-on-exit dead pane is an authorized target")
    assert.equal(findExpectedAdoptionPane(expected).kind, "absent")
  } finally {
    killSession(slug)
    rmSync(gateDir, { recursive: true, force: true })
    setSocket(originalSocket)
  }
})

test("atomic text-and-key sends leave no secret-bearing tmux buffer on success, mismatch, or server error", { skip: !tmuxAvailable }, () => {
  const originalSocket = socketName()
  const slug = `exact-buffer-${process.pid}`
  const token = randomUUID()
  const secret = `FRAY_BUFFER_SECRET_${randomUUID()}`
  setSocket(`fray-exact-buffer-test-${process.pid}`)
  const buffers = (): string => {
    try {
      return execFileSync("tmux", ["-L", socketName(), "list-buffers", "-F", "#{buffer_name}\t#{buffer_sample}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      return ""
    }
  }
  try {
    const exact = spawn(
      slug,
      [process.execPath, "-e", "process.stdin.resume()"],
      process.cwd(),
      undefined,
      { adoptionAttemptToken: token },
    )
    const expected = {
      attempt_token: token,
      pane_id: exact.paneId,
      pane_pid: exact.panePid,
      session_created: exact.sessionCreated,
    }
    const payload = `${secret}\n${"large-line\t\u001b[31m\r".repeat(8192)}\nfinal-line`
    assert.equal(sendTextToExpectedAdoptionPane(expected, payload, false), true)
    assert.doesNotMatch(buffers(), /fray-exact-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))

    assert.equal(sendTextToExpectedAdoptionPane({ ...expected, attempt_token: randomUUID() }, secret, false), false)
    assert.doesNotMatch(buffers(), /fray-exact-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))

    assert.equal(sendTextWithKeyToExpectedAdoptionPane(expected, secret, "Tab"), true)
    assert.doesNotMatch(buffers(), /fray-exact-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))

    assert.equal(sendTextWithKeyToExpectedAdoptionPane({ ...expected, attempt_token: randomUUID() }, secret, "Enter"), false)
    assert.doesNotMatch(buffers(), /fray-exact-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))

    killSession(slug)
    assert.equal(sendTextToExpectedAdoptionPane(expected, secret, false), false)
    assert.equal(sendTextWithKeyToExpectedAdoptionPane(expected, secret, "Enter"), false)
    assert.doesNotMatch(buffers(), /fray-exact-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))
  } finally {
    killSession(slug)
    setSocket(originalSocket)
  }
})

test("local atomic text-and-key send pastes the complete multiline payload and cleans its private buffer", { skip: !tmuxAvailable }, async () => {
  const originalSocket = socketName()
  const slug = `local-atomic-send-${process.pid}`
  const secret = `FRAY_LOCAL_BUFFER_SECRET_${randomUUID()}`
  setSocket(`fray-local-atomic-send-test-${process.pid}`)
  const buffers = (): string => {
    try {
      return execFileSync("tmux", ["-L", socketName(), "list-buffers", "-F", "#{buffer_name}\t#{buffer_sample}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      return ""
    }
  }
  try {
    spawn(
      slug,
      [process.execPath, "-e", `
        process.stdin.setRawMode(true);
        let sawPayload = false;
        process.stdin.on('data', d => {
          const value = d.toString();
          if (value === '\\r') {
            process.stdout.write(sawPayload ? 'SUBMIT_AFTER_PASTE' : 'COALESCED_SUBMIT');
          } else {
            sawPayload = true;
            process.stdout.write('PAYLOAD:' + value);
          }
        });
      `],
      process.cwd(),
    )
    const payload = `${secret} first paragraph\n\nsecond paragraph`
    assert.equal(sendTextWithKey(slug, payload, "Enter"), true)
    assert.doesNotMatch(buffers(), /fray-input-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))

    let pane = ""
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      pane = execFileSync("tmux", ["-L", socketName(), "capture-pane", "-p", "-t", tmuxSessionName(slug)], { encoding: "utf8" })
      if (pane.includes("first paragraph") && pane.includes("second paragraph") && pane.includes("SUBMIT_AFTER_PASTE")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.match(pane, /first paragraph/)
    assert.match(pane, /second paragraph/)
    assert.match(pane, /SUBMIT_AFTER_PASTE/, "the submit key reaches the application in a later input event than the paste")
    assert.doesNotMatch(pane, /COALESCED_SUBMIT/)

    killSession(slug)
    assert.equal(sendTextWithKey(slug, secret, "Enter"), false)
    assert.doesNotMatch(buffers(), /fray-input-/)
    assert.doesNotMatch(buffers(), new RegExp(secret))
  } finally {
    killSession(slug)
    setSocket(originalSocket)
  }
})

test("a pane replaced during the paste settle boundary receives no delayed key and strands no input buffer", { skip: !tmuxAvailable }, async () => {
  const originalSocket = socketName()
  const slug = `local-settle-race-${process.pid}`
  const holder = `local-settle-holder-${process.pid}`
  const testSocket = `fray-local-settle-race-test-${process.pid}`
  setSocket(testSocket)
  const buffers = (): string => {
    try {
      return execFileSync("tmux", ["-L", testSocket, "list-buffers", "-F", "#{buffer_name}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      return ""
    }
  }
  try {
    spawn(holder, [process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd())
    spawn(slug, [process.execPath, "-e", "process.stdin.resume()"], process.cwd())
    const moduleUrl = new URL("./tmux.ts", import.meta.url).href
    let output = ""
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", `
      import { setSocket, sendTextWithKey } from ${JSON.stringify(moduleUrl)};
      setSocket(${JSON.stringify(testSocket)});
      process.stdout.write("FRAY_SETTLE_READY\\n");
      const result = sendTextWithKey(${JSON.stringify(slug)}, "MUST_NOT_REACH_REPLACEMENT", "Enter");
      process.stdout.write("RESULT:" + result + "\\n");
    `], { stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (chunk) => { output += String(chunk) })

    const bufferDeadline = Date.now() + 2_000
    while (Date.now() < bufferDeadline && !buffers().includes("fray-input-")) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.match(buffers(), /fray-input-/, "the target is replaced while the server-side settle queue is paused")

    killSession(slug)
    spawn(slug, [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('COMPETITOR:' + d))"], process.cwd())
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve))
    assert.equal(code, 0)
    assert.match(output, /RESULT:false/)
    assert.doesNotMatch(buffers(), /fray-input-/)

    const competitor = execFileSync(
      "tmux",
      ["-L", testSocket, "capture-pane", "-p", "-t", tmuxSessionName(slug)],
      { encoding: "utf8" },
    )
    assert.doesNotMatch(competitor, /MUST_NOT_REACH_REPLACEMENT|COMPETITOR:/)
  } finally {
    killSession(slug)
    killSession(holder)
    setSocket(originalSocket)
  }
})

test("an exact adopted pane replaced during settle receives no delayed key and strands no input buffer", { skip: !tmuxAvailable }, async () => {
  const originalSocket = socketName()
  const slug = `exact-settle-race-${process.pid}`
  const holder = `exact-settle-holder-${process.pid}`
  const token = randomUUID()
  const competitorToken = randomUUID()
  const testSocket = `fray-exact-settle-race-test-${process.pid}`
  setSocket(testSocket)
  const buffers = (): string => {
    try {
      return execFileSync("tmux", ["-L", testSocket, "list-buffers", "-F", "#{buffer_name}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      return ""
    }
  }
  let exact: ReturnType<typeof spawn> | undefined
  try {
    spawn(holder, [process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd())
    exact = spawn(slug, [process.execPath, "-e", "process.stdin.resume()"], process.cwd(), undefined, {
      adoptionAttemptToken: token,
    })
    const expected = {
      attempt_token: token,
      pane_id: exact.paneId,
      pane_pid: exact.panePid,
      session_created: exact.sessionCreated,
    }
    const moduleUrl = new URL("./tmux.ts", import.meta.url).href
    let output = ""
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", `
      import { setSocket, sendTextWithKeyToExpectedAdoptionPane } from ${JSON.stringify(moduleUrl)};
      setSocket(${JSON.stringify(testSocket)});
      process.stdout.write("FRAY_EXACT_SETTLE_READY\\n");
      const result = sendTextWithKeyToExpectedAdoptionPane(
        ${JSON.stringify(expected)},
        "MUST_NOT_REACH_EXACT_REPLACEMENT",
        "Enter",
      );
      process.stdout.write("RESULT:" + result + "\\n");
    `], { stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (chunk) => { output += String(chunk) })

    const bufferDeadline = Date.now() + 2_000
    while (Date.now() < bufferDeadline && !buffers().includes("fray-exact-")) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.match(buffers(), /fray-exact-/, "the exact owner is replaced while its settle queue is paused")

    killPane(exact)
    exact = undefined
    spawn(
      slug,
      [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('COMPETITOR:' + d))"],
      process.cwd(),
      undefined,
      { adoptionAttemptToken: competitorToken },
    )
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve))
    assert.equal(code, 0)
    assert.match(output, /RESULT:false/)
    assert.doesNotMatch(buffers(), /fray-exact-/)

    const competitor = execFileSync(
      "tmux",
      ["-L", testSocket, "capture-pane", "-p", "-t", tmuxSessionName(slug)],
      { encoding: "utf8" },
    )
    assert.doesNotMatch(competitor, /MUST_NOT_REACH_EXACT_REPLACEMENT|COMPETITOR:/)
  } finally {
    if (exact) killPane(exact)
    killSession(slug)
    killSession(holder)
    setSocket(originalSocket)
  }
})

test("SIGKILL during exact atomic text-and-key transport cannot strand its private tmux buffer", { skip: !tmuxAvailable }, async () => {
  const originalSocket = socketName()
  const slug = `exact-buffer-kill-${process.pid}`
  const token = randomUUID()
  const testSocket = `fray-exact-buffer-kill-test-${process.pid}`
  setSocket(testSocket)
  try {
    const exact = spawn(slug, [process.execPath, "-e", "process.stdin.resume()"], process.cwd(), undefined, {
      adoptionAttemptToken: token,
    })
    const expected = {
      attempt_token: token,
      pane_id: exact.paneId,
      pane_pid: exact.panePid,
      session_created: exact.sessionCreated,
    }
    const moduleUrl = new URL("./tmux.ts", import.meta.url).href
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", `
      import { setSocket, sendTextWithKeyToExpectedAdoptionPane } from ${JSON.stringify(moduleUrl)};
      setSocket(${JSON.stringify(testSocket)});
      process.stdout.write("FRAY_SEND_READY\\n");
      sendTextWithKeyToExpectedAdoptionPane(
        ${JSON.stringify(expected)},
        "FRAY_SIGKILL_BUFFER_SECRET_" + "x".repeat(32 * 1024 * 1024),
        "Enter",
      );
    `], { stdio: ["ignore", "pipe", "pipe"] })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("exact-send child did not start")), 5_000)
      child.stdout.once("data", () => {
        clearTimeout(timeout)
        resolve()
      })
      child.once("error", reject)
    })
    let sawTmuxClient = false
    const until = Date.now() + 5_000
    while (Date.now() < until) {
      try {
        const children = execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim()
        if (children) {
          sawTmuxClient = true
          break
        }
      } catch {
        // The synchronous tmux child has not been created yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(sawTmuxClient, true, "SIGKILL occurs while the one tmux client invocation is active")
    child.kill("SIGKILL")
    const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.once("close", (_code, value) => resolve(value)))
    assert.equal(signal, "SIGKILL")

    let buffers = ""
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        buffers = execFileSync("tmux", ["-L", testSocket, "list-buffers", "-F", "#{buffer_name}\t#{buffer_sample}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      } catch {
        buffers = ""
      }
      if (!buffers.includes("fray-exact-")) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.doesNotMatch(buffers, /fray-exact-/)
    assert.doesNotMatch(buffers, /FRAY_SIGKILL_BUFFER_SECRET/)
  } finally {
    killSession(slug)
    setSocket(originalSocket)
  }
})
