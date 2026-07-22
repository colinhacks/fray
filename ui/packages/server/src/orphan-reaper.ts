// Orphan process reaper — fray spawns a worker per thread (a detached `claude`/`codex` in a tmux
// pane) and each worker spawns auxiliary processes for its task: MCP servers, dev/watch servers, and
// verification browsers (chrome-devtools-mcp, agent-browser, puppeteer). `tmux kill-session` signals
// only the pane's process group, so anything that daemonized out of that group (agent-browser
// double-forks its Chrome to launchd; a `node --watch` reparents on crash) SURVIVES the stop and
// leaks — permanently, since nothing else collects it. Over days this accretes GBs of orphaned
// Chrome/node whose owning thread is long gone. This module reaps exactly those.
//
// Ownership is read from the env marker every worker carries: FRAY_UI_THREAD=<slug> (set at spawn in
// dispatch.ts/resume.ts), inherited by everything the worker spawns. A slug is LIVE iff a live
// `claude`/`codex` session process still carries it — a worker's only OS-level agent process is its
// session root (Agent sub-agents are in-process), so this is exact and socket-agnostic (it protects
// a live adhoc-stack's workers automatically, since their roots are alive on the machine).
//
// SAFETY — the reaper only ever kills an AUXILIARY process whose slug is live NOWHERE. It never
// touches: a session root (`claude`/`codex`, or anything bearing `--session-id`), a tmux server
// (they carry the first thread's slug in env but are shared infrastructure), the reaper's own
// process or any ancestor (so it can never kill the server it runs in — which is untagged anyway,
// being user-spawned rather than worker-spawned), or any process whose slug is currently live. Every
// enumeration failure fails CLOSED (reap nothing). An age guard skips just-spawned processes.

import { execFileSync } from "node:child_process"

export const ORPHAN_REAP_INTERVAL_MS = 60_000
export const ORPHAN_MIN_AGE_MS = 120_000

const SLUG_RE = /FRAY_UI_THREAD=([A-Za-z0-9._-]+)/

export interface ProcRow {
  pid: number
  ppid: number
  ageMs: number
  /** argv only (no env), from `ps -o command=` */
  command: string
  /** FRAY_UI_THREAD read from the process ENVIRONMENT, or null when untagged/unreadable */
  slug: string | null
}

// ---- Pure classification --------------------------------------------------------------------------

export function firstTokenBasename(command: string): string {
  const first = command.trimStart().split(/\s+/, 1)[0] ?? ""
  const slash = first.lastIndexOf("/")
  return slash >= 0 ? first.slice(slash + 1) : first
}

/** A worker's session process — the only thing that DEFINES a slug as live, and never a reap target. */
export function isSessionRoot(command: string): boolean {
  const base = firstTokenBasename(command)
  if (base === "claude" || base === "codex") return true
  // A node-launched agent CLI still carries --session-id; belt-and-suspenders so a session process
  // is never mistaken for reapable aux regardless of how it was invoked.
  return /(?:^|\s)--session-id(?:\s|=)/.test(command)
}

/** tmux servers inherit the first thread's FRAY_UI_THREAD in env, but are shared infrastructure. */
export function isTmuxServer(command: string): boolean {
  return firstTokenBasename(command) === "tmux"
}

// ---- Pure decisions -------------------------------------------------------------------------------

export interface ReapDecision {
  /** aux "roots" to reap (each expanded to its subtree by the caller) */
  reap: number[]
  liveSlugs: string[]
}

function reapable(row: ProcRow, live: Set<string>, protectedPids: ReadonlySet<number>): boolean {
  if (!row.slug) return false // untagged → not ours to touch
  if (live.has(row.slug)) return false // owner still alive
  if (isSessionRoot(row.command)) return false // never a session process
  if (isTmuxServer(row.command)) return false // never shared tmux infra
  if (protectedPids.has(row.pid)) return false // never self / ancestors
  return true
}

/** Periodic sweep decision: reap tagged aux whose slug is live nowhere and which cleared the age guard. */
export function decideOrphans(
  rows: readonly ProcRow[],
  opts: { minAgeMs: number; protectedPids: ReadonlySet<number> },
): ReapDecision {
  const live = new Set<string>()
  for (const r of rows) if (r.slug && isSessionRoot(r.command)) live.add(r.slug)

  const reap: number[] = []
  for (const r of rows) {
    if (!reapable(r, live, opts.protectedPids)) continue
    if (r.ageMs < opts.minAgeMs) continue // just-spawned; give the owner time to appear
    reap.push(r.pid)
  }
  return { reap, liveSlugs: [...live] }
}

/** self + every ancestor, so the reaper can never kill the server process it runs inside. */
export function selfAndAncestors(rows: readonly ProcRow[], selfPid: number): Set<number> {
  const parentOf = new Map<number, number>()
  for (const r of rows) parentOf.set(r.pid, r.ppid)
  const set = new Set<number>([selfPid])
  let cur = selfPid
  for (let guard = 0; guard < 10_000; guard++) {
    const pp = parentOf.get(cur)
    if (pp === undefined || pp <= 0 || set.has(pp)) break
    set.add(pp)
    cur = pp
  }
  return set
}

/**
 * Expand seed pids to their full descendant subtrees, deepest-first, dropping any pid that must not
 * die (protected / session root / tmux / live-slug). Leaves-first order guarantees a parent is never
 * killed before its children, so no child is re-orphaned to launchd mid-reap.
 */
export function subtreeKillOrder(
  seed: readonly number[],
  rows: readonly ProcRow[],
  keep: (row: ProcRow) => boolean,
): number[] {
  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()
  for (const r of rows) {
    byPid.set(r.pid, r)
    const list = childrenOf.get(r.ppid) ?? []
    list.push(r.pid)
    childrenOf.set(r.ppid, list)
  }
  const set = new Set<number>()
  const stack = [...seed]
  while (stack.length) {
    const pid = stack.pop()!
    if (set.has(pid)) continue
    const row = byPid.get(pid)
    if (row && keep(row)) continue // a protected/live proc nested under a target is never killed
    set.add(pid)
    for (const c of childrenOf.get(pid) ?? []) stack.push(c)
  }
  const depth = (pid: number): number => {
    let d = 0
    let cur = pid
    for (let guard = 0; guard < 10_000; guard++) {
      const pp = byPid.get(cur)?.ppid
      if (pp === undefined || !set.has(pp)) break
      d++
      cur = pp
    }
    return d
  }
  return [...set].sort((a, b) => depth(b) - depth(a))
}

// ---- etime parsing --------------------------------------------------------------------------------

/** ps etime → ms. Accepts `SS`, `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`. Unparseable → 0 (fails the guard). */
export function parseEtimeMs(etime: string): number {
  const trimmed = etime.trim()
  if (!trimmed) return 0
  let days = 0
  let rest = trimmed
  const dash = rest.indexOf("-")
  if (dash >= 0) {
    days = Number(rest.slice(0, dash))
    rest = rest.slice(dash + 1)
  }
  const parts = rest.split(":").map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  let h = 0
  let m = 0
  let s = 0
  if (parts.length === 3) [h, m, s] = parts
  else if (parts.length === 2) [m, s] = parts
  else if (parts.length === 1) [s] = parts
  else return 0
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000
}

// ---- Process enumeration (impure, injectable) -----------------------------------------------------

export type Exec = (file: string, args: string[]) => string

const defaultExec: Exec = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })

/**
 * Two `ps` passes joined by pid: pass 1 (`-o command=`, argv only) for pid/ppid/etime/command; pass 2
 * (`-Eww`, env appended) to read the FRAY_UI_THREAD slug FROM THE ENV SEGMENT ONLY (the pass-1 argv
 * is stripped off first). Reading the slug from env — never argv — is what stops a literal
 * `FRAY_UI_THREAD=x` inside a process's argv (pasted task text, a tmux `-e` flag, a grep) from
 * spoofing ownership and mis-attributing a live thread's slug.
 *
 * Deliberately TWO passes, not one `-Eww` pass storing the whole line: a process's full environment
 * (which `ps -E` appends) contains its secrets — API keys, tokens, private keys. The retained
 * `command` is argv-only, and the env-bearing text never escapes this function beyond the slug regex,
 * so secrets can't leak into a log or error. The cost is a negligible pid-reuse race (a pid reassigned
 * between the two sub-ms `ps` calls fails the `${pid} ${argv}` marker match → no slug → not reaped, so
 * the race is fail-safe, never a false kill).
 *
 * Env VALUES can contain newlines (PEM keys, JSON service accounts), so a pass-2 record spans several
 * physical lines; records are delimited by their `<pid> <argv>` marker and false splits re-merged,
 * rather than split on raw newlines. Returns only same-user, parseable rows. macOS `ps -E` cannot read
 * the env of SIP platform binaries like /bin/sleep, but every process a worker actually leaks — node
 * MCP/dev servers and Chrome browsers — is a non-system binary whose env IS readable (verified in the
 * harness). A total env-pass failure fails closed (every slug null → nothing reapable), and since a
 * root and its aux share one env read there is no partial mode that hides a live root while surfacing
 * its aux.
 */
export function enumerateProcs(exec: Exec = defaultExec): ProcRow[] {
  // `-ww` (both passes) disables ps's column truncation so pass-1 argv is the FULL argv — required
  // for the prefix strip below to leave a clean env segment.
  const base = exec("ps", ["-axww", "-o", "pid=,ppid=,etime=,command="])
  const rows: ProcRow[] = []
  const byPid = new Map<number, ProcRow>()
  const pids: number[] = []
  for (const line of base.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const row: ProcRow = { pid, ppid, ageMs: parseEtimeMs(m[3]!), command: m[4]!, slug: null }
    rows.push(row)
    byPid.set(pid, row)
    pids.push(pid)
  }
  if (!pids.length) return rows

  // Pass 2: `-Eww -o pid=,command=` appends the full ENVIRONMENT after argv. Two subtleties:
  //  (a) the slug MUST come from the env, not argv — a process whose argv contains a literal
  //      `FRAY_UI_THREAD=x` (pasted task text, a grep, a tmux `-e` flag) would otherwise spoof
  //      ownership. So strip the known pass-1 argv prefix and read the slug only from what follows.
  //  (b) an env VALUE can contain newlines (PEM keys, JSON), so a record spans multiple physical
  //      lines. Split on record starts (`<pid> <argv>`), re-merging any line that isn't a real
  //      record start (a false split inside a multiline value), rather than splitting on raw \n.
  let text: string
  try {
    text = exec("ps", ["-Eww", "-o", "pid=,command=", "-p", pids.join(",")])
  } catch {
    return rows // env unreadable → every slug null → reap nothing this pass (fail closed)
  }
  const records: string[] = []
  for (const chunk of text.split(/\n(?=\d+ )/)) {
    const pid = Number(chunk.match(/^(\d+) /)?.[1])
    const argv = byPid.get(pid)?.command
    if (argv !== undefined && chunk.startsWith(`${pid} ${argv}`)) records.push(chunk)
    else if (records.length) records[records.length - 1] += `\n${chunk}` // false split → re-merge
  }
  for (const rec of records) {
    const pid = Number(rec.slice(0, rec.indexOf(" ")))
    const row = byPid.get(pid)
    if (!row) continue
    const envSegment = rec.slice(`${pid} ${row.command}`.length)
    row.slug = envSegment.match(SLUG_RE)?.[1] ?? null
  }
  return rows
}

const defaultKill = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone / not permitted — idempotent
  }
}

/** Expand seeds to subtrees and SIGKILL leaves-first. Returns the count actually signalled. */
export function reapSubtrees(
  seed: readonly number[],
  rows: readonly ProcRow[],
  protectedPids: ReadonlySet<number>,
  live: ReadonlySet<string>,
  kill: (pid: number) => void = defaultKill,
): number {
  const keep = (row: ProcRow): boolean =>
    protectedPids.has(row.pid) ||
    isSessionRoot(row.command) ||
    isTmuxServer(row.command) ||
    (row.slug !== null && live.has(row.slug))
  const order = subtreeKillOrder(seed, rows, keep)
  for (const pid of order) kill(pid)
  return order.length
}

// ---- Orchestration --------------------------------------------------------------------------------

export interface SweepDeps {
  exec?: Exec
  kill?: (pid: number) => void
  selfPid?: number
  minAgeMs?: number
  log?: (msg: string) => void
}

export interface SweepResult {
  /** total processes SIGKILLed (aux roots + their descendants) */
  reaped: number
  /** distinct dead thread slugs whose aux were reaped */
  deadSlugs: string[]
  liveSlugs: string[]
}

/** One periodic sweep: enumerate → decide → reap. Never throws (fails closed). */
export function sweepOrphansOnce(deps: SweepDeps = {}): SweepResult {
  const exec = deps.exec ?? defaultExec
  const selfPid = deps.selfPid ?? process.pid
  const minAgeMs = deps.minAgeMs ?? ORPHAN_MIN_AGE_MS
  let rows: ProcRow[]
  try {
    rows = enumerateProcs(exec)
  } catch {
    return { reaped: 0, deadSlugs: [], liveSlugs: [] }
  }
  const protectedPids = selfAndAncestors(rows, selfPid)
  const { reap, liveSlugs } = decideOrphans(rows, { minAgeMs, protectedPids })
  if (!reap.length) return { reaped: 0, deadSlugs: [], liveSlugs }
  const bySlug = new Map(rows.map((r) => [r.pid, r.slug]))
  const deadSlugs = [...new Set(reap.map((pid) => bySlug.get(pid)).filter((s): s is string => !!s))]
  const live = new Set(liveSlugs)
  const reaped = reapSubtrees(reap, rows, protectedPids, live, deps.kill)
  deps.log?.(
    `orphan-reaper: reaped ${reaped} process(es) from ${deadSlugs.length} dead thread(s): ${deadSlugs.join(", ")}`,
  )
  return { reaped, deadSlugs, liveSlugs }
}

/** Start the startup + periodic sweep. Returns a stop handle. Timer is unref'd (never holds the loop open). */
export function startOrphanReaper(deps: SweepDeps & { intervalMs?: number } = {}): () => void {
  const intervalMs = deps.intervalMs ?? ORPHAN_REAP_INTERVAL_MS
  try {
    sweepOrphansOnce(deps)
  } catch {
    // startup sweep is best-effort
  }
  const timer = setInterval(() => {
    try {
      sweepOrphansOnce(deps)
    } catch {
      // never let a sweep error escape the timer
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
