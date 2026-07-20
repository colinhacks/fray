import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

// Fray deliberately binds its control plane to loopback. These are the only browser authorities the
// product serves; DNS names that merely begin with "localhost" and alternate 127/8 spellings are not
// equivalent trust identities. Browser Origin serialization is canonical, so requiring the exact
// serialized origin also rejects paths, credentials, trailing dots, and numeric-IP tricks.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"])
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const

type HeaderValue = string | string[] | undefined

export interface LocalRequestHeaders {
  host?: HeaderValue
  origin?: HeaderValue
  forwarded?: HeaderValue
  "x-forwarded-for"?: HeaderValue
  "x-forwarded-host"?: HeaderValue
  "x-forwarded-port"?: HeaderValue
  "x-forwarded-proto"?: HeaderValue
}

export interface ParsedLocalAuthority {
  hostname: "localhost" | "127.0.0.1" | "::1"
  port: number
  authority: string
}

function oneHeader(value: HeaderValue): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower
}

function explicitPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

function validExpectedPort(port: number | undefined): port is number {
  return Number.isInteger(port) && port! >= 1 && port! <= 65_535
}

/** Parse the browser's serialized Origin, accepting only Fray's exact HTTP loopback identities. */
export function parseLocalHttpOrigin(value: HeaderValue, expectedPort: number): ParsedLocalAuthority | null {
  const raw = oneHeader(value)
  if (!raw || !validExpectedPort(expectedPort) || raw !== raw.trim()) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // Origin is defined as a serialized origin, not an arbitrary URL. This exact comparison rejects a
  // trailing slash/path, case-normalization trick, userinfo, an explicit default port, or IP shorthand.
  if (url.protocol !== "http:" || url.origin !== raw) return null
  const hostname = normalizedHostname(url.hostname)
  if (!LOCAL_HOSTNAMES.has(hostname) || explicitPort(url) !== expectedPort) return null
  return { hostname: hostname as ParsedLocalAuthority["hostname"], port: expectedPort, authority: url.host }
}

/** Parse an HTTP Host authority independently of Origin; forwarded headers are never authority here. */
export function parseLocalHost(value: HeaderValue, expectedPort: number): ParsedLocalAuthority | null {
  const raw = oneHeader(value)
  if (!raw || !validExpectedPort(expectedPort) || raw !== raw.trim() || raw.includes(",")) return null
  let url: URL
  try {
    url = new URL(`http://${raw}`)
  } catch {
    return null
  }
  // Host is an authority only. URL parsing plus the exact host comparison prevents userinfo, paths,
  // encoded separators and canonicalized numeric aliases from becoming a trusted local host.
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null
  if (url.host.toLowerCase() !== raw.toLowerCase()) return null
  const hostname = normalizedHostname(url.hostname)
  if (!LOCAL_HOSTNAMES.has(hostname) || explicitPort(url) !== expectedPort) return null
  return { hostname: hostname as ParsedLocalAuthority["hostname"], port: expectedPort, authority: url.host.toLowerCase() }
}

function hasForwardedAuthority(headers: LocalRequestHeaders): boolean {
  return FORWARDED_HEADERS.some((name) => headers[name] !== undefined)
}

/**
 * HTTP policy: Host must be this exact loopback server and any PRESENT Origin must name the SAME
 * canonical loopback hostname + actual port. Treating localhost, 127.0.0.1, and ::1 as interchangeable
 * would let an unrelated service bound to another loopback family on the same numeric port become an
 * authorized browser origin. Callers must explicitly opt a route/request into missing Origin compatibility
 * (the app does so for the read-only CLI health probe and browser-forbidden `Sec-Fetch-Site: same-origin`
 * requests); it is never accepted by the WebSocket policy below.
 */
export function isTrustedLocalHttpRequest(
  headers: LocalRequestHeaders,
  expectedPort: number,
  allowMissingOrigin = false,
): boolean {
  if (hasForwardedAuthority(headers)) return false
  const host = parseLocalHost(headers.host, expectedPort)
  if (!host) return false
  if (headers.origin === undefined) return allowMissingOrigin
  const origin = parseLocalHttpOrigin(headers.origin, expectedPort)
  return !!origin && host.hostname === origin.hostname && host.port === origin.port
}

/** Return the exact origin for CORS reflection, or undefined for every non-local/prefix/port trick. */
export function allowedLocalCorsOrigin(origin: string, expectedPort: number): string | undefined {
  return parseLocalHttpOrigin(origin, expectedPort) ? origin : undefined
}

/**
 * Browser WebSockets are privileged control channels, so they require an Origin and it must be the
 * SAME canonical loopback host+port as the actual Host header. The socket's local port is authoritative;
 * Host and all forwarded claims are untrusted input. There is intentionally no production no-Origin
 * exception—non-browser test/CLI clients must send the same explicit Origin a browser would.
 */
export function isTrustedLocalWebSocketRequest(req: IncomingMessage, expectedPort = req.socket.localPort): boolean {
  if (!validExpectedPort(expectedPort)) return false
  const headers = req.headers as LocalRequestHeaders
  if (hasForwardedAuthority(headers)) return false
  const host = parseLocalHost(headers.host, expectedPort)
  const origin = parseLocalHttpOrigin(headers.origin, expectedPort)
  return !!host && !!origin && host.hostname === origin.hostname && host.port === origin.port
}

/** Claim a sensitive upgrade with a small explicit denial instead of letting another WS router try it. */
export function rejectWebSocketUpgrade(socket: Duplex, status = 403, reason = "Forbidden"): void {
  const body = `${reason}\n`
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n")
  try {
    socket.end(response)
  } catch {
    try {
      socket.destroy()
    } catch {
      // The peer already disappeared while the policy rejected it.
    }
  }
}
