// Real-subsystem harness for the orphan reaper (fray:adhoc-cdp §3). Unit tests drive the pure logic
// with a FAKE ps; this drives the REAL `ps -axo` + `ps -Eww` env read and a REAL SIGKILL against
// REAL processes, with a NEGATIVE CONTROL (a live-slug root + its aux that MUST survive). Mocks
// prove nothing about whether macOS ps actually surfaces FRAY_UI_THREAD from the environment.
//
//   run: npx tsx scripts/verify-orphan-reaper.mjs   (from ui/)   → PASS/FAIL lines; exit 1 on any fail.
//
// Uses REAL `node` processes — the production shape of leaked aux (MCP/dev servers, and Chrome,
// whose env `ps -E` surfaces identically; verified separately). System binaries like /bin/sleep are
// deliberately NOT used: macOS restricts `ps -E` env reads for SIP platform binaries, which are
// never what a worker leaks.
//
// Controlled processes (all real, detached):
//   root   = `node` invoked through a symlink named `claude` → a SESSION ROOT (by basename), defines LIVE
//   liveAux= a `node` tagged LIVE → aux whose slug HAS a live root → must be KEPT
//   orphan = a `node` tagged DEAD → aux whose slug has NO root      → must be REAPED
// Only `orphan` is ever really killed; the harness never sweeps the machine with a live SIGKILL.

import { spawn } from "node:child_process"
import { mkdtempSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  enumerateProcs,
  decideOrphans,
  selfAndAncestors,
  reapSubtrees,
  sweepOrphansOnce,
  isSessionRoot,
} from "../packages/server/src/orphan-reaper.ts"

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("PASS", msg) } else { fail++; console.log("FAIL", msg) }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const uniq = `${process.pid}-${Date.now().toString(36)}`
const LIVE = `reaper-harness-live-${uniq}`
const DEAD = `reaper-harness-dead-${uniq}`
const IDLE = "node -e globalThis.__k=setInterval(()=>{},1e9)" // keep the proc alive; harmless

const dir = mkdtempSync(join(tmpdir(), "reaper-harness-"))
const fakeClaude = join(dir, "claude") // basename 'claude' → session root; really a symlink to node → env-readable
symlinkSync(process.execPath, fakeClaude)

const spawned = []
const spawnTagged = (cmd, args, slug) => {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", env: { ...process.env, FRAY_UI_THREAD: slug } })
  child.unref()
  spawned.push(child.pid)
  return child.pid
}
const cleanup = () => {
  for (const pid of spawned) { try { process.kill(pid, "SIGKILL") } catch {} }
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

try {
  const idleArgs = ["-e", "setInterval(()=>{},1e9)"]
  // node rejects an unknown --session-id flag; the `claude` symlink basename alone marks it a root.
  const rootPid = spawnTagged(fakeClaude, idleArgs, LIVE)
  const liveAuxPid = spawnTagged(process.execPath, idleArgs, LIVE)
  const orphanPid = spawnTagged(process.execPath, idleArgs, DEAD)
  // CRITICAL regression: a root whose ARGV contains a literal FRAY_UI_THREAD=<other> (pasted task
  // text) but whose ENV owns SPOOF. Ownership must read from ENV, else SPOOF looks dead and spoofAux
  // gets reaped mid-run. (The positional `note:` token is not a --flag, so node keeps running.)
  const SPOOF = `reaper-harness-spoof-${uniq}`
  const spoofRootPid = spawnTagged(fakeClaude, [...idleArgs, `note:FRAY_UI_THREAD=argv-decoy-${uniq}`], SPOOF)
  const spoofAuxPid = spawnTagged(process.execPath, idleArgs, SPOOF)
  await wait(700) // let them register in the process table

  // 1) REAL enumeration: ps -axo joined with ps -Eww env read
  const rows = enumerateProcs()
  const find = (pid) => rows.find((r) => r.pid === pid)
  ok(find(rootPid)?.slug === LIVE, "real ps -Eww surfaces FRAY_UI_THREAD env for the root")
  ok(find(liveAuxPid)?.slug === LIVE, "real ps -Eww surfaces the live-aux slug")
  ok(find(orphanPid)?.slug === DEAD, "real ps -Eww surfaces the orphan slug")
  ok(!!find(rootPid) && isSessionRoot(find(rootPid).command), "a binary named `claude` classified a session root")
  ok(!!find(orphanPid) && !isSessionRoot(find(orphanPid).command), "plain node classified aux, not a session root")
  // CRITICAL: the spoof root's slug must read from ENV (SPOOF), NOT the argv decoy literal
  ok(find(spoofRootPid)?.slug === SPOOF, "root slug read from ENV, argv `FRAY_UI_THREAD=` literal ignored")

  const protectedPids = selfAndAncestors(rows, process.pid)

  // 2) decideOrphans on the REAL table: orphan in, root/liveAux/self out
  const { reap, liveSlugs } = decideOrphans(rows, { minAgeMs: 0, protectedPids })
  const reapSet = new Set(reap)
  ok(reapSet.has(orphanPid), "orphan (dead slug) selected for reaping")
  ok(!reapSet.has(rootPid), "session root NEVER selected")
  ok(!reapSet.has(liveAuxPid), "live-slug aux NEVER selected (negative control)")
  ok(!reapSet.has(process.pid), "the harness's own pid NEVER selected")
  ok(liveSlugs.includes(LIVE), "LIVE slug reported live (its root is alive)")

  // 3) full sweep path, DRY RUN (record kills, don't signal) — proves the real orchestration
  const recorded = []
  sweepOrphansOnce({ minAgeMs: 0, selfPid: process.pid, kill: (pid) => recorded.push(pid) })
  const rec = new Set(recorded)
  ok(rec.has(orphanPid), "full sweep would reap the orphan")
  ok(!rec.has(rootPid) && !rec.has(liveAuxPid), "full sweep spares root + live-slug aux")
  ok(!rec.has(spoofRootPid) && !rec.has(spoofAuxPid), "full sweep spares the spoof root AND its aux (no argv mis-attribution)")

  // 4) REAL kill of ONLY the orphan; negative control must still be alive after
  reapSubtrees([orphanPid], rows, protectedPids, new Set(liveSlugs), (pid) => { try { process.kill(pid, "SIGKILL") } catch {} })
  await wait(300)
  ok(!alive(orphanPid), "orphan is REALLY dead after reap")
  ok(alive(rootPid), "session root still alive (never touched)")
  ok(alive(liveAuxPid), "live-slug aux still alive (never touched)")
} finally {
  cleanup()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
