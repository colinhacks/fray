import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

export interface ProcessGeneration {
  pid: number
  processStart: string
}

export type ProcessGenerationConfidence = "exact" | "weak" | "unavailable"

export interface ProcessGenerationObservation {
  processStart?: string
  confidence: ProcessGenerationConfidence
}

export type ProcessGenerationMatch = "exact" | "weak" | "unavailable" | "dead" | "mismatch"

/**
 * Injectable OS boundary for ownership tests and platforms without a queryable process birth id.
 * `weak` observations may retain a lease, but must never authorize a signal. `unavailable` is
 * deliberately fail-closed: token-bound health/control is the only cross-process proof in that case.
 */
export interface ProcessPlatformAdapter {
  current(): ProcessGeneration
  observe(pid: number): ProcessGenerationObservation
  isAlive(pid: number): boolean
  now(): number
  sleep(ms: number): void
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function linuxGeneration(pid: number): ProcessGenerationObservation | null {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) return null
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim()
    // proc(5): comm is parenthesized and may itself contain spaces or ')'. Fields after its final
    // `) ` begin at field 3; starttime is field 22, hence index 19 in this suffix.
    const suffixAt = stat.lastIndexOf(") ")
    if (suffixAt < 0) return null
    const fields = stat.slice(suffixAt + 2).trim().split(/\s+/u)
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/u.test(startTicks)) return null
    return { processStart: `linux:${bootId}:${startTicks}`, confidence: "exact" }
  } catch {
    return null
  }
}

function fixedPsGeneration(pid: number): ProcessGenerationObservation | null {
  try {
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().replace(/\s+/gu, " ")
    if (!value || value.length > 128 || /[\0\r\n]/u.test(value)) return null
    // Darwin exposes process birth only to the second through ps. Stable locale/TZ prevents live
    // owner theft, but equality remains weak: it can retain ownership, never authorize a PID signal.
    return { processStart: `ps-utc:${value}`, confidence: "weak" }
  } catch {
    return null
  }
}

function observeDefault(pid: number): ProcessGenerationObservation {
  if (!processAlive(pid)) return { confidence: "unavailable" }
  if (process.platform === "linux") {
    const linux = linuxGeneration(pid)
    if (linux) return linux
    const fallback = fixedPsGeneration(pid)
    return fallback ?? { confidence: "unavailable" }
  }
  if (process.platform === "darwin") return fixedPsGeneration(pid) ?? { confidence: "unavailable" }
  return { confidence: "unavailable" }
}

const defaultSelf = (() => {
  const observed = observeDefault(process.pid)
  return {
    pid: process.pid,
    processStart: observed.processStart ?? `opaque:${randomUUID()}`,
  }
})()

const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4))

export const defaultProcessPlatformAdapter: ProcessPlatformAdapter = {
  current: () => defaultSelf,
  observe: observeDefault,
  isAlive: processAlive,
  now: () => Date.now(),
  sleep: (ms) => {
    if (ms > 0) Atomics.wait(SYNC_WAIT, 0, 0, ms)
  },
}

export function observeProcessGeneration(
  generation: ProcessGeneration,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): ProcessGenerationMatch {
  if (!adapter.isAlive(generation.pid)) return "dead"
  const self = adapter.current()
  if (generation.pid === self.pid && generation.processStart === self.processStart) return "exact"
  if (generation.processStart.startsWith("opaque:")) return "unavailable"
  // Version-1 owners stored untagged, locale-dependent `ps` prose. It cannot be compared safely to
  // the canonical v2 marker: retain a live legacy owner until it exits instead of stealing from it.
  if (!/^(?:linux|ps-utc|opaque):/u.test(generation.processStart)) return "unavailable"
  const observed = adapter.observe(generation.pid)
  if (!observed.processStart || observed.confidence === "unavailable") return "unavailable"
  if (observed.processStart.split(":", 1)[0] !== generation.processStart.split(":", 1)[0]) {
    return "unavailable"
  }
  if (observed.processStart !== generation.processStart) return "mismatch"
  return observed.confidence
}

export function currentProcessGeneration(
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): ProcessGeneration {
  return adapter.current()
}

/** Back-compatible observer name; the value is now canonical/tagged rather than localized prose. */
export function processStartTime(
  pid: number,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): string | undefined {
  return adapter.observe(pid).processStart
}

export function exactProcessGenerationIsLive(
  generation: ProcessGeneration,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): boolean {
  return observeProcessGeneration(generation, adapter) === "exact"
}

export function processGenerationIsStale(
  generation: ProcessGeneration,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): boolean {
  const match = observeProcessGeneration(generation, adapter)
  return match === "dead" || match === "mismatch"
}
