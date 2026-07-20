import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import test from "node:test"
import {
  allowedLocalCorsOrigin,
  isTrustedLocalHttpRequest,
  isTrustedLocalWebSocketRequest,
  parseLocalHost,
  parseLocalHttpOrigin,
} from "./local-origin.ts"

const PORT = 49_177

function upgradeRequest(host: string | undefined, origin: string | undefined, extra: Record<string, string> = {}) {
  return {
    headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}), ...extra },
    socket: { localPort: PORT },
  } as unknown as IncomingMessage
}

test("local origin parser accepts only canonical loopback URL serializations on the expected port", () => {
  for (const [origin, hostname] of [
    [`http://127.0.0.1:${PORT}`, "127.0.0.1"],
    [`http://localhost:${PORT}`, "localhost"],
    [`http://[::1]:${PORT}`, "::1"],
  ] as const) {
    assert.equal(parseLocalHttpOrigin(origin, PORT)?.hostname, hostname)
    assert.equal(allowedLocalCorsOrigin(origin, PORT), origin)
  }

  for (const origin of [
    undefined,
    "null",
    `https://localhost:${PORT}`,
    `http://localhost.evil:${PORT}`,
    `http://127.0.0.1.evil:${PORT}`,
    `http://127.0.0.1:${PORT + 1}`,
    `http://127.1:${PORT}`,
    `http://2130706433:${PORT}`,
    `http://0177.0.0.1:${PORT}`,
    `HTTP://LOCALHOST:${PORT}`,
    `http://localhost:${PORT}/`,
    `http://user@localhost:${PORT}`,
    `http://localhost.:${PORT}`,
    `http://localhоst:${PORT}`,
    `http://%6cocalhost:${PORT}`,
    `http://[0:0:0:0:0:0:0:1]:${PORT}`,
    `http://[::ffff:127.0.0.1]:${PORT}`,
    `http://localhost:0${PORT}`,
    `http://localhost:${PORT}, http://evil.example`,
  ]) {
    assert.equal(parseLocalHttpOrigin(origin, PORT), null, String(origin))
  }
})

test("local Host parser rejects DNS suffixes, port aliases, userinfo, and canonicalization tricks", () => {
  for (const [host, hostname] of [
    [`127.0.0.1:${PORT}`, "127.0.0.1"],
    [`localhost:${PORT}`, "localhost"],
    [`[::1]:${PORT}`, "::1"],
  ] as const) {
    assert.equal(parseLocalHost(host, PORT)?.hostname, hostname)
  }
  for (const host of [
    `localhost.evil:${PORT}`,
    `127.0.0.1.evil:${PORT}`,
    `127.0.0.1:${PORT + 1}`,
    `127.1:${PORT}`,
    `2130706433:${PORT}`,
    `0177.0.0.1:${PORT}`,
    `user@localhost:${PORT}`,
    `localhost:${PORT}/path`,
    `localhost.:${PORT}`,
    `localhоst:${PORT}`,
    `%6cocalhost:${PORT}`,
    `[0:0:0:0:0:0:0:1]:${PORT}`,
    `[::ffff:127.0.0.1]:${PORT}`,
    `localhost:0${PORT}`,
    `localhost:${PORT}, evil.example`,
  ]) {
    assert.equal(parseLocalHost(host, PORT), null, host)
  }
})

test("HTTP requires the present Origin to match Host and narrowly opts missing Origin into compatibility", () => {
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}` }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}` }, PORT, true), true)
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://localhost:${PORT}`],
    [`LOCALHOST:${PORT}`, `http://localhost:${PORT}`],
    [`[::1]:${PORT}`, `http://[::1]:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalHttpRequest({ host, origin }, PORT), true, `${host} / ${origin}`)
  }
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://localhost:${PORT}`],
    [`127.0.0.1:${PORT}`, `http://[::1]:${PORT}`],
    [`localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://[::1]:${PORT}`],
    [`[::1]:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`[::1]:${PORT}`, `http://localhost:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalHttpRequest({ host, origin }, PORT), false, `${host} / ${origin}`)
  }
  assert.equal(isTrustedLocalHttpRequest({ host: `localhost.evil:${PORT}` }, PORT, true), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: "http://evil.example" }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: [`127.0.0.1:${PORT}`], origin: `http://127.0.0.1:${PORT}` }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: [`http://127.0.0.1:${PORT}`] }, PORT), false)
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ] as const) {
    assert.equal(isTrustedLocalHttpRequest({
      host: `127.0.0.1:${PORT}`,
      origin: `http://127.0.0.1:${PORT}`,
      [name]: name === "forwarded" ? "" : "attacker-controlled",
    }, PORT), false, name)
  }
})

test("WebSocket policy requires a present exact same-origin Host across IPv4, localhost, and IPv6", () => {
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://localhost:${PORT}`],
    [`[::1]:${PORT}`, `http://[::1]:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(host, origin)), true, origin)
  }
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`127.0.0.1:${PORT}`, undefined)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`127.0.0.1:${PORT}`, `http://localhost:${PORT}`)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`localhost.evil:${PORT}`, `http://localhost.evil:${PORT}`)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(
    `127.0.0.1:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    { "x-forwarded-proto": "https" },
  )), false)
})
