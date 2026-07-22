import { test } from "node:test"
import assert from "node:assert/strict"
import {
  firstTokenBasename,
  isSessionRoot,
  isTmuxServer,
  decideOrphans,
  selfAndAncestors,
  subtreeKillOrder,
  parseEtimeMs,
  enumerateProcs,
  reapSubtrees,
  sweepOrphansOnce,
  type ProcRow,
  type Exec,
} from "./orphan-reaper.ts"

const OLD = 10 * 60_000 // comfortably past the age guard
const ORPHAN_GUARD = 120_000

function row(p: Partial<ProcRow> & { pid: number }): ProcRow {
  return { ppid: 1, ageMs: OLD, command: "node x", slug: null, ...p }
}

test("firstTokenBasename strips path and args", () => {
  assert.equal(firstTokenBasename("/usr/bin/node --foo bar"), "node")
  assert.equal(firstTokenBasename("claude --session-id abc"), "claude")
  assert.equal(firstTokenBasename("  /a/b/Google Chrome for Testing --x"), "Google")
  assert.equal(firstTokenBasename(""), "")
})

test("isSessionRoot: claude/codex binary or --session-id anywhere", () => {
  assert.ok(isSessionRoot("claude --session-id abc"))
  assert.ok(isSessionRoot("/opt/claude"))
  assert.ok(isSessionRoot("codex --cd /x -m gpt"))
  assert.ok(isSessionRoot("node /path/cli.js --session-id zzz")) // node-launched agent
  assert.ok(!isSessionRoot("node /path/chrome-devtools-mcp"))
  assert.ok(!isSessionRoot("Google Chrome for Testing --remote-debugging-port=0"))
})

test("isTmuxServer matches only the tmux binary", () => {
  assert.ok(isTmuxServer("tmux -L fray-repo-x new-session -d"))
  assert.ok(!isTmuxServer("node tmux-thing"))
})

test("decideOrphans: reap aux whose slug has no live root; keep everything protected", () => {
  const rows: ProcRow[] = [
    row({ pid: 100, command: "claude --session-id A", slug: "alpha" }), // live root alpha
    row({ pid: 101, command: "node chrome-devtools-mcp", slug: "alpha" }), // aux of LIVE alpha → keep
    row({ pid: 200, command: "Google Chrome for Testing --remote-debugging-port=0", slug: "beta" }), // aux, dead beta → REAP
    row({ pid: 201, command: "node --watch server.js", slug: "beta" }), // aux, dead beta → REAP
    row({ pid: 300, command: "codex --cd /x", slug: "gamma" }), // a session root with no aux; dead-ish but NEVER reaped
    row({ pid: 400, command: "tmux -L fray-repo-x new-session", slug: "delta" }), // tmux tagged, dead → keep
  ]
  const { reap, liveSlugs } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual([...reap].sort((a, b) => a - b), [200, 201])
  assert.deepEqual([...liveSlugs].sort(), ["alpha", "gamma"])
})

test("decideOrphans: age guard spares just-spawned aux", () => {
  const rows: ProcRow[] = [
    row({ pid: 200, ageMs: 5_000, command: "Google Chrome for Testing --x", slug: "beta" }), // fresh → keep
    row({ pid: 201, ageMs: OLD, command: "Google Chrome for Testing --x", slug: "beta" }), // old → reap
  ]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual(reap, [201])
})

test("decideOrphans: protected pids (self/ancestors) are never reaped", () => {
  const rows: ProcRow[] = [row({ pid: 200, command: "node orphan.js", slug: "beta" })]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set([200]) })
  assert.deepEqual(reap, [])
})

test("decideOrphans: a dead slug shared with a still-live root elsewhere is kept (never false-kill)", () => {
  // Same slug string owned by a live root — its aux must survive even if another proc has it too.
  const rows: ProcRow[] = [
    row({ pid: 100, command: "claude --session-id X", slug: "shared" }),
    row({ pid: 101, command: "node agent-browser", slug: "shared" }),
  ]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual(reap, [])
})

test("selfAndAncestors walks the parent chain", () => {
  const rows: ProcRow[] = [
    row({ pid: 10, ppid: 1 }),
    row({ pid: 20, ppid: 10 }),
    row({ pid: 30, ppid: 20 }),
  ]
  // includes the terminal ppid (1); harmless — protecting a pid only means "never reap it"
  assert.deepEqual([...selfAndAncestors(rows, 30)].sort((a, b) => a - b), [1, 10, 20, 30])
})

test("selfAndAncestors tolerates cycles", () => {
  const rows: ProcRow[] = [row({ pid: 10, ppid: 20 }), row({ pid: 20, ppid: 10 })]
  const set = selfAndAncestors(rows, 10)
  assert.ok(set.has(10) && set.has(20))
})

test("subtreeKillOrder: leaves before parents, drops kept procs", () => {
  const rows: ProcRow[] = [
    row({ pid: 100, ppid: 1, command: "node mcp", slug: "beta" }),
    row({ pid: 110, ppid: 100, command: "Chrome main", slug: "beta" }),
    row({ pid: 120, ppid: 110, command: "Chrome renderer", slug: "beta" }),
    row({ pid: 130, ppid: 100, command: "claude --session-id keepme", slug: "gamma" }), // must be dropped
  ]
  const keep = (r: ProcRow) => isSessionRoot(r.command)
  const order = subtreeKillOrder([100], rows, keep)
  assert.ok(!order.includes(130), "live session root nested under a target is never killed")
  // deepest first: 120 before 110 before 100
  assert.ok(order.indexOf(120) < order.indexOf(110))
  assert.ok(order.indexOf(110) < order.indexOf(100))
  assert.deepEqual([...order].sort((a, b) => a - b), [100, 110, 120])
})

test("parseEtimeMs handles all ps formats", () => {
  assert.equal(parseEtimeMs("05"), 5_000)
  assert.equal(parseEtimeMs("01:30"), 90_000)
  assert.equal(parseEtimeMs("02:00:00"), 2 * 3600_000)
  assert.equal(parseEtimeMs("3-04:00:00"), (3 * 24 + 4) * 3600_000)
  assert.equal(parseEtimeMs("garbage"), 0)
  assert.equal(parseEtimeMs(""), 0)
})

// ---- enumeration + reap with a fake `ps` ----------------------------------------------------------

function fakePs(base: string, env: string): Exec {
  return (file, args) => {
    assert.equal(file, "ps")
    if (args.includes("-Eww")) return env
    return base
  }
}

test("enumerateProcs joins argv pass with env pass, slug from the ENV segment only", () => {
  const base = [
    "  100        1 10:00 claude --session-id A",
    "  200      100 09:00 Google Chrome for Testing --remote-debugging-port=0",
    // tmux carries a FRAY_UI_THREAD literal in ARGV (the `-e` flag); its OWN env has a different one
    "  400        1 20:00 tmux -L fray-repo-x new-session -d -e FRAY_UI_THREAD=argvslug",
  ].join("\n")
  const env = [
    "100 claude --session-id A FRAY_UI_THREAD=alpha",
    "200 Google Chrome for Testing --remote-debugging-port=0 FRAY_UI_THREAD=alpha",
    "400 tmux -L fray-repo-x new-session -d -e FRAY_UI_THREAD=argvslug HOME=/x FRAY_UI_THREAD=envslug",
  ].join("\n")
  const procs = enumerateProcs(fakePs(base, env))
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  assert.equal(byPid.get(100)!.slug, "alpha")
  assert.equal(byPid.get(200)!.slug, "alpha")
  assert.equal(byPid.get(400)!.ppid, 1)
  assert.equal(byPid.get(200)!.ageMs, 9 * 60_000)
  // the ENV slug wins over the argv `-e FRAY_UI_THREAD=argvslug` literal
  assert.equal(byPid.get(400)!.slug, "envslug")
})

test("enumerateProcs: a FRAY_UI_THREAD literal in a ROOT's argv never overrides its real env slug", () => {
  // Reproduces the critical mis-attribution: a worker whose task text pasted `FRAY_UI_THREAD=other`
  // into its argv. Ownership must come from ENV, or the root's real slug would be lost from `live`.
  const base = ["  100 1 10:00 claude --session-id A pasted:FRAY_UI_THREAD=other-slug"].join("\n")
  const env = ["100 claude --session-id A pasted:FRAY_UI_THREAD=other-slug FRAY_UI_THREAD=realroot"].join("\n")
  const procs = enumerateProcs(fakePs(base, env))
  assert.equal(procs[0]!.slug, "realroot")
})

test("enumerateProcs: reads the slug across a multiline env value and re-merges false splits", () => {
  const base = ["  100 1 10:00 node dev.js"].join("\n")
  // env contains a PEM key with newlines, AND a line that starts with a digit+space (a false record
  // boundary that must be re-merged), with the real slug appearing AFTER all of it.
  const env = [
    "100 node dev.js KEY=-----BEGIN-----",
    "500 not-a-real-record continues the KEY value",
    "-----END----- FRAY_UI_THREAD=realslug",
  ].join("\n")
  const procs = enumerateProcs(fakePs(base, env))
  assert.equal(procs[0]!.slug, "realslug")
})

test("enumerateProcs: a pid whose pass-2 argv does not match pass-1 (reuse) yields no slug (fail-safe)", () => {
  const base = ["  100 1 10:00 node real-argv"].join("\n")
  const env = ["100 node DIFFERENT-argv FRAY_UI_THREAD=whatever"].join("\n") // marker mismatch
  const procs = enumerateProcs(fakePs(base, env))
  assert.equal(procs[0]!.slug, null)
})

test("enumerateProcs fails closed when the env pass throws", () => {
  const exec: Exec = (_file, args) => {
    if (args.includes("-Eww")) throw new Error("boom")
    return "  100 1 10:00 node x"
  }
  const procs = enumerateProcs(exec)
  assert.equal(procs.length, 1)
  assert.equal(procs[0]!.slug, null) // no slug → never reaped
})

test("sweepOrphansOnce end-to-end with fakes: reaps dead-slug Chrome, spares live + self", () => {
  const base = [
    "  100     1 10:00 claude --session-id A",
    "  101   100 10:00 node chrome-devtools-mcp",
    "  200     1 10:00 Google Chrome for Testing --remote-debugging-port=0",
    "  201   200 10:00 Google Chrome Helper (Renderer)",
    "  999     1 10:00 node server.js", // the reaper's own process (self)
  ].join("\n")
  const env = [
    "100 claude --session-id A FRAY_UI_THREAD=alpha",
    "101 node chrome-devtools-mcp FRAY_UI_THREAD=alpha",
    "200 Google Chrome for Testing --remote-debugging-port=0 FRAY_UI_THREAD=beta",
    "201 Google Chrome Helper (Renderer) FRAY_UI_THREAD=beta",
    "999 node server.js FRAY_UI_THREAD=beta", // even if tagged beta, it is self → protected
  ].join("\n")
  const killed: number[] = []
  const res = sweepOrphansOnce({
    exec: fakePs(base, env),
    kill: (pid) => killed.push(pid),
    selfPid: 999,
    minAgeMs: 120_000,
  })
  assert.deepEqual(killed.sort((a, b) => a - b), [200, 201]) // beta subtree only
  assert.ok(!killed.includes(999), "self never reaped even when tagged with a dead slug")
  assert.ok(!killed.includes(100) && !killed.includes(101), "live alpha kept")
  assert.equal(res.reaped, 2)
  assert.deepEqual(res.deadSlugs, ["beta"])
  assert.deepEqual(res.liveSlugs, ["alpha"])
})

test("sweepOrphansOnce: a live root whose argv holds a stray FRAY_UI_THREAD literal never gets its aux reaped", () => {
  // The critical false-kill regression: root's REAL slug is `realthread` (env); its argv also contains
  // a pasted `FRAY_UI_THREAD=spoofed`. If ownership were read from argv, `realthread` would look dead
  // and the live aux (101) would be reaped mid-verification. It must not be.
  const base = [
    "  100 1 10:00 claude --session-id A note:FRAY_UI_THREAD=spoofed",
    "  101 100 10:00 node chrome-devtools-mcp",
  ].join("\n")
  const env = [
    "100 claude --session-id A note:FRAY_UI_THREAD=spoofed FRAY_UI_THREAD=realthread",
    "101 node chrome-devtools-mcp FRAY_UI_THREAD=realthread",
  ].join("\n")
  const killed: number[] = []
  const res = sweepOrphansOnce({ exec: fakePs(base, env), kill: (p) => killed.push(p), selfPid: 999, minAgeMs: 120_000 })
  assert.deepEqual(killed, [], "no aux reaped — realthread is live via its root")
  assert.deepEqual(res.liveSlugs, ["realthread"])
})

test("reapSubtrees never signals a protected or live-slug pid even if seeded", () => {
  const rows: ProcRow[] = [
    row({ pid: 200, ppid: 1, command: "node x", slug: "beta" }),
    row({ pid: 201, ppid: 200, command: "claude --session-id L", slug: "live" }),
  ]
  const killed: number[] = []
  reapSubtrees([200], rows, new Set(), new Set(["live"]), (p) => killed.push(p))
  assert.deepEqual(killed, [200]) // 201 is a session root → dropped
})
