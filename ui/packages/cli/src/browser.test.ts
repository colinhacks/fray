import { test } from "node:test"
import assert from "node:assert/strict"
import {
  defaultBrowserOpenCommand,
  launchBrowserTab,
} from "./browser.ts"

test("default browser launch uses each platform's shell-free URL handler", () => {
  const url = "http://127.0.0.1:4917"
  assert.deepEqual(defaultBrowserOpenCommand(url, "darwin"), {
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:4917/"],
  })
  assert.deepEqual(defaultBrowserOpenCommand(url, "linux"), {
    command: "xdg-open",
    args: ["http://127.0.0.1:4917/"],
  })
  assert.deepEqual(defaultBrowserOpenCommand(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4917/"],
  })
})

test("default browser launch accepts only absolute http(s) URLs", () => {
  assert.deepEqual(defaultBrowserOpenCommand("https://example.com/path?a=1", "darwin"), {
    command: "/usr/bin/open",
    args: ["https://example.com/path?a=1"],
  })
  assert.throws(() => defaultBrowserOpenCommand("not a URL", "darwin"), /invalid browser URL/)
  assert.throws(() => defaultBrowserOpenCommand("file:///tmp/fray", "darwin"), /unsupported browser URL scheme/)
  assert.throws(() => defaultBrowserOpenCommand("https://example.com", "aix"), /not supported/)
})

test("macOS makes exactly one awaited standard default-browser request", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  let accepted = false
  await launchBrowserTab("http://127.0.0.1:4917", {
    platform: "darwin",
    runCommand: async (command, args) => {
      calls.push({ command, args })
      accepted = true
      return ""
    },
  })

  assert.equal(accepted, true)
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:4917/"],
  }])
})

test("browser launch reports OS-handler rejection", async () => {
  await assert.rejects(
    launchBrowserTab("http://127.0.0.1:4917", {
      platform: "darwin",
      runCommand: async () => { throw new Error("open failed") },
    }),
    /open failed/,
  )
})

test("non-macOS launch waits for the platform URL handler before reporting success", async () => {
  let completed = false
  await launchBrowserTab("http://127.0.0.1:4917", {
    platform: "linux",
    runCommand: async (command, args) => {
      assert.equal(command, "xdg-open")
      assert.deepEqual(args, ["http://127.0.0.1:4917/"])
      completed = true
      return ""
    },
  })
  assert.equal(completed, true)
})
