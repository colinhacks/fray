import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, resolveLocalImage, type AppOptions } from "./app.ts"
import { trustedLocalFileRoots } from "./project.ts"
import type { AppContext } from "./context.ts"

// A 1x1 PNG's leading bytes are enough — the route serves the bytes verbatim, it doesn't decode.
const PNG = Buffer.from("89504e470d0a1a0a", "hex")

function originTestApp(port: number, onDispatch?: () => void, options: Partial<AppOptions> = {}, stateDir = "/tmp/origin-test-state") {
  const inert = new Proxy({}, { get: () => () => {} })
  const ctx = {
    bootId: "origin-test-boot",
    project: {
      id: "origin-test-project",
      dir: "/tmp/origin-test-project",
      stateDir,
      cwdSlug: "-tmp-origin-test-project",
      name: "origin-test",
      label: "local/origin-test",
    },
    bus: inert,
    transcriptChange: inert,
    storage: inert,
    interactions: inert,
    board: inert,
    tailer: inert,
    dispatcher: onDispatch
      ? {
          dispatch: async () => {
            onDispatch()
            return { slug: "authority-probe", sessionId: "authority-probe-session" }
          },
        }
      : inert,
    backendFor: () => inert,
    scheduler: inert,
    permissionController: inert,
    getSettings: () => ({}),
    setSettings: (settings: unknown) => settings,
    resetSettings: () => ({}),
  } as unknown as AppContext
  return createApp(ctx, { port, ...options })
}

test("HTTP control plane accepts exact local origins and intentional no-Origin CLI probes", async () => {
  const port = 49_177
  const app = originTestApp(port)
  const request = (headers: Record<string, string>) => app.request(`http://127.0.0.1:${port}/health`, { headers })

  const cli = await request({ host: `127.0.0.1:${port}` })
  assert.equal(cli.status, 200, "native local health probes intentionally carry no Origin")

  const missingOriginControl = await app.request(`http://127.0.0.1:${port}/local-image`, {
    headers: { host: `127.0.0.1:${port}` },
  })
  assert.equal(missingOriginControl.status, 403, "no-Origin compatibility is not control-plane-wide")

  const sameOriginBrowser = await app.request(`http://127.0.0.1:${port}/local-image`, {
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
  })
  assert.equal(sameOriginBrowser.status, 400, "same-origin browser metadata reaches the route (which then rejects its missing path)")

  for (const [host, origin] of [
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
    [`localhost:${port}`, `http://localhost:${port}`],
    [`[::1]:${port}`, `http://[::1]:${port}`],
  ]) {
    const response = await request({ host, origin })
    assert.equal(response.status, 200, origin)
    assert.equal(response.headers.get("access-control-allow-origin"), origin)
  }
})

test("token-bound health and stop control never expose or accept a forged owner capability", async () => {
  const port = 49_177
  let stops = 0
  const app = originTestApp(port, undefined, {
    ownerProof: "project-bound-proof",
    controlToken: "owner-capability",
    requestOwnerStop: () => { stops++ },
  })
  const health = await app.request(`http://127.0.0.1:${port}/health`, {
    headers: { host: `127.0.0.1:${port}` },
  })
  assert.deepEqual(await health.json(), {
    ok: true,
    projectId: "origin-test-project",
    projectDir: "/tmp/origin-test-project",
    bootId: "origin-test-boot",
    ownerProof: "project-bound-proof",
  })

  const forged = await app.request(`http://127.0.0.1:${port}/control/stop`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-fray-launch-token": "forged" },
  })
  assert.equal(forged.status, 403)
  const crossOrigin = await app.request(`http://127.0.0.1:${port}/control/stop`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://localhost:${port}`,
      "x-fray-launch-token": "owner-capability",
    },
  })
  assert.equal(crossOrigin.status, 403)
  const accepted = await app.request(`http://127.0.0.1:${port}/control/stop`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-fray-launch-token": "owner-capability" },
  })
  assert.equal(accepted.status, 202)
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(stops, 1)
})

test("HTTP/CORS rejects every cross-loopback Host/Origin pair before reads, preflights, or mutation bodies", async () => {
  const port = 49_177
  let dispatchCalls = 0
  const app = originTestApp(port, () => { dispatchCalls++ })
  const authorities = [
    { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    { host: `[::1]:${port}`, origin: `http://[::1]:${port}` },
  ]

  for (const target of authorities) {
    for (const source of authorities) {
      if (target.host === source.host) continue
      const headers = { host: target.host, origin: source.origin }

      const read = await app.request(`http://127.0.0.1:${port}/health`, { headers })
      assert.equal(read.status, 403, `read ${source.origin} -> ${target.host}`)
      assert.equal(read.headers.get("access-control-allow-origin"), null)

      const preflight = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
        method: "OPTIONS",
        headers: {
          ...headers,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      })
      assert.equal(preflight.status, 403, `preflight ${source.origin} -> ${target.host}`)
      assert.equal(preflight.headers.get("access-control-allow-origin"), null)

      const mutation = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "must not dispatch", slug: "must-not-dispatch" }),
      })
      assert.equal(mutation.status, 403, `mutation ${source.origin} -> ${target.host}`)
      assert.equal(mutation.headers.get("access-control-allow-origin"), null)
    }
  }
  assert.equal(dispatchCalls, 0, "rejected cross-authority bodies never reach the RPC handler")
})

test("HTTP/CORS preserves same-authority desktop/PWA preflights and valid mutation routing", async () => {
  const port = 49_177
  let dispatchCalls = 0
  const app = originTestApp(port, () => { dispatchCalls++ })
  for (const { host, origin } of [
    { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    { host: `[::1]:${port}`, origin: `http://[::1]:${port}` },
  ]) {
    const preflight = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
      method: "OPTIONS",
      headers: {
        host,
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    })
    assert.equal(preflight.status, 204, origin)
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin)
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i)

    const mutation = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
      method: "POST",
      headers: { host, origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "same-authority dispatch", slug: "authority-probe" }),
    })
    assert.equal(mutation.status, 200, `${origin} reaches the typed mutation handler`)
    assert.equal(mutation.headers.get("access-control-allow-origin"), origin)
  }
  const sameOriginMetadataOnly = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "same-origin metadata dispatch", slug: "authority-probe" }),
  })
  assert.equal(sameOriginMetadataOnly.status, 200, "same-origin Fetch Metadata preserves the no-Origin PWA path")
  assert.equal(dispatchCalls, 4)
})

test("HTTP control plane rejects hostile/prefix/port/Host/forwarded origin tricks", async () => {
  const port = 49_177
  const app = originTestApp(port)
  const request = (headers: Record<string, string>) => app.request(`http://127.0.0.1:${port}/health`, { headers })
  const validHost = `127.0.0.1:${port}`

  const hostileOrigins = [
    "http://evil.example",
    `http://localhost.evil.example:${port}`,
    `http://127.0.0.1.evil.example:${port}`,
    `http://127.0.0.1:${port + 1}`,
    `http://127.1:${port}`,
    `http://2130706433:${port}`,
    `http://0177.0.0.1:${port}`,
    `HTTP://LOCALHOST:${port}`,
    `http://localhost:${port}/`,
    `http://xn--localhst-sbh:${port}`,
    `http://%6cocalhost:${port}`,
    `http://[0:0:0:0:0:0:0:1]:${port}`,
    `http://[::ffff:127.0.0.1]:${port}`,
    "null",
  ]
  for (const origin of hostileOrigins) {
    assert.equal((await request({ host: validHost, origin })).status, 403, origin)
    const preflight = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
      method: "OPTIONS",
      headers: {
        host: validHost,
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    })
    assert.equal(preflight.status, 403, `preflight ${origin}`)
    assert.equal(preflight.headers.get("access-control-allow-origin"), null)
  }
  const hostileHosts = [
    `localhost.evil.example:${port}`,
    `127.0.0.1.evil.example:${port}`,
    `127.0.0.1:${port + 1}`,
    `127.1:${port}`,
    `2130706433:${port}`,
    `0177.0.0.1:${port}`,
    `xn--localhst-sbh:${port}`,
    `%6cocalhost:${port}`,
    `[0:0:0:0:0:0:0:1]:${port}`,
    `[::ffff:127.0.0.1]:${port}`,
  ]
  for (const host of hostileHosts) {
    assert.equal((await request({ host })).status, 403, host)
    const preflight = await app.request(`http://127.0.0.1:${port}/rpc/dispatch`, {
      method: "OPTIONS",
      headers: {
        host,
        origin: `http://127.0.0.1:${port}`,
        "access-control-request-method": "POST",
      },
    })
    assert.equal(preflight.status, 403, `preflight Host ${host}`)
  }
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ]) {
    assert.equal((await request({
      host: validHost,
      origin: `http://127.0.0.1:${port}`,
      [name]: name === "forwarded" ? "" : "attacker-controlled",
    })).status, 403, name)
  }
  assert.equal((await app.request(`http://127.0.0.1:${port}/local-image`, {
    headers: { host: validHost, "sec-fetch-site": "cross-site" },
  })).status, 403, "a cross-site browser cannot use the CLI's missing-Origin exception")
})

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), "fray-img-"))
  const img = join(root, "shot.png")
  writeFileSync(img, PNG)
  return { root, img }
}

test("allowed: absolute png under a trusted root → 200 with content-type", () => {
  const { root, img } = fixtures()
  const r = resolveLocalImage(img, [root])
  assert.equal(r.status, 200)
  if (r.status === 200) {
    assert.equal(r.contentType, "image/png")
    assert.deepEqual(r.body, PNG)
  }
})

test("blocked: path outside every root → 403", () => {
  const { root, img } = fixtures()
  assert.equal(resolveLocalImage(img, ["/some/other/root"]).status, 403)
})

test("blocked: /etc/passwd → 403 (outside roots, and not an image ext → 400 first)", () => {
  const { root } = fixtures()
  // wrong extension is rejected before the root check
  assert.equal(resolveLocalImage("/etc/passwd", [root]).status, 400)
})

test("blocked: relative path → 400", () => {
  const { root } = fixtures()
  assert.equal(resolveLocalImage("shot.png", [root]).status, 400)
})

test("blocked: non-image extension → 400", () => {
  const { root } = fixtures()
  const txt = join(root, "note.txt")
  writeFileSync(txt, "hi")
  assert.equal(resolveLocalImage(txt, [root]).status, 400)
})

test("missing file → 404", () => {
  const { root } = fixtures()
  assert.equal(resolveLocalImage(join(root, "nope.png"), [root]).status, 404)
})

test("trustedLocalFileRoots trusts BOTH temp trees so an agent scratchpad under /tmp serves", () => {
  const roots = trustedLocalFileRoots({ dir: "/nonexistent-project", stateDir: "/nonexistent-state" })
  assert.ok(roots.includes("/tmp"), "the shared /tmp tree is a trusted root (covers /tmp/claude-<uid>/… scratchpads)")
  // A Claude-Code-scratchpad-shaped path (…/claude-<uid>/<project>/<session>/scratchpad/shot.png) under the
  // shared temp tree — not under os.tmpdir() (/var/folders on macOS) — must now serve, since /tmp is trusted.
  const scratch = mkdtempSync(join("/tmp", "claude-501-scratch-"))
  const img = join(scratch, "shot.png")
  writeFileSync(img, PNG)
  assert.equal(resolveLocalImage(img, roots).status, 200)
})

test("/local-image route serves an agent screenshot under /tmp end-to-end", async () => {
  const port = 49_233
  const app = originTestApp(port)
  // A Claude-Code-scratchpad-shaped screenshot under the shared temp tree — the exact case that used to
  // 403 before /tmp joined the trusted roots. Driven through the REAL route (Hono + trustedLocalFileRoots).
  const scratch = mkdtempSync(join("/tmp", "claude-501-worker-"))
  const shot = join(scratch, "summary-dark-crop.png")
  writeFileSync(shot, PNG)
  const served = await app.request(`http://127.0.0.1:${port}/local-image?path=${encodeURIComponent(shot)}`, {
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
  })
  assert.equal(served.status, 200, "worker screenshot under /tmp now serves")
  assert.equal(served.headers.get("content-type"), "image/png")
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)
  // The gate still gates outside the trusted roots — covered by the resolveLocalImage unit + symlink tests.
})

test("symlink escaping the root is resolved and blocked → 403", () => {
  const { root, img } = fixtures()
  const outside = mkdtempSync(join(tmpdir(), "fray-out-"))
  writeFileSync(join(outside, "real.png"), PNG)
  const link = join(root, "link.png")
  symlinkSync(join(outside, "real.png"), link)
  // link sits inside root, but its realpath is under `outside` — must be blocked when only root is trusted
  assert.equal(resolveLocalImage(link, [root]).status, 403)
  // and allowed when the real target's root is trusted
  assert.equal(resolveLocalImage(link, [root, outside]).status, 200)
})

test("/attach accepts the safe tier, rejects office/extensionless/oversized, and writes a sanitized name", async () => {
  const port = 49_231
  const stateDir = mkdtempSync(join(tmpdir(), "fray-attach-"))
  const app = originTestApp(port, undefined, {}, stateDir)
  const b64 = (s: string) => Buffer.from(s).toString("base64")
  const attach = (body: unknown) =>
    app.request(`http://127.0.0.1:${port}/attach`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  // A document (PDF): accepted, path sanitized (spaces/dots → dashes) and timestamp-prefixed, on disk.
  const pdf = await attach({ name: "My Report v2.pdf", data: b64("%PDF-1.4 hello") })
  assert.equal(pdf.status, 200)
  const pdfPath = (await pdf.json() as { path: string }).path
  assert.match(pdfPath, /\/attachments\/\d+-[0-9a-f]{8}-My-Report-v2\.pdf$/)
  assert.ok(existsSync(pdfPath))
  assert.equal(readFileSync(pdfPath, "utf8"), "%PDF-1.4 hello")

  // A text/code file and an image are both in the safe tier.
  assert.equal((await attach({ name: "notes.md", data: b64("# hi") })).status, 200)
  assert.equal((await attach({ name: "main.ts", data: b64("export {}") })).status, 200)
  assert.equal((await attach({ name: "shot.png", data: b64("\x89PNG") })).status, 200)

  // Office formats are deliberately OUT of the safe tier; extension-less + unknown are rejected too.
  assert.equal((await attach({ name: "sheet.xlsx", data: b64("x") })).status, 400)
  assert.equal((await attach({ name: "doc.docx", data: b64("x") })).status, 400)
  assert.equal((await attach({ name: "README", data: b64("x") })).status, 400)
  assert.equal((await attach({ name: "archive.zip", data: b64("x") })).status, 400)

  // The base64 payload cap is enforced (ATTACHMENT_MAX_BASE64_CHARS = 25_000_000).
  assert.equal((await attach({ name: "big.pdf", data: "A".repeat(25_000_001) })).status, 400)
})
