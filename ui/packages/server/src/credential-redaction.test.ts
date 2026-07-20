import assert from "node:assert/strict"
import test from "node:test"
import { redactCredentialStructure, redactCredentialSyntax } from "./credential-redaction.ts"

const FIXTURES = {
  basic: "fixture-credential-alpha",
  quoted: "fixture credential beta",
  encoded: "%66%69%78%74%75%72%65-gamma",
  unicode: "fixture-δelta-credential",
  control: "fixture-control-credential",
  nested: "fixture-nested-credential",
  escaped: "fixture\\ credential-epsilon",
  multiline: "fixture\\\ncredential-zeta",
} as const

test("credential syntax redacts curl userinfo, long secret flags, quoting, continuations, controls, and URL credentials", () => {
  const continuation = "\\\n  "
  const escape = "\u001b"
  const raw = [
    `curl -u alice:${FIXTURES.basic} https://example.test/a`,
    `curl --user 'alice:${FIXTURES.quoted}' https://example.test/b`,
    `curl -u=alice:${FIXTURES.encoded} https://example.test/c`,
    `curl -ualice:${FIXTURES.unicode} https://example.test/d`,
    `tool --password ${FIXTURES.basic} --token="${FIXTURES.quoted}" --api-key='${FIXTURES.encoded}' --secret=${FIXTURES.unicode}`,
    `tool --client_secret ${continuation}${FIXTURES.nested}`,
    `tool --password ${FIXTURES.escaped}`,
    `tool --token="${FIXTURES.multiline}"`,
    `tool --token ${escape}[31m${FIXTURES.control}${escape}[0m --safe visible`,
    `https://bob:${FIXTURES.basic}@packages.example.test/private`,
    `https://bob:${FIXTURES.encoded}@packages.example.test/encoded-password`,
    `https://bob%3A${FIXTURES.nested}@packages.example.test/encoded-delimiter`,
  ].join("\n")

  const redacted = redactCredentialSyntax(raw)
  for (const fixture of Object.values(FIXTURES)) assert.equal(redacted.includes(fixture), false, fixture)
  assert.equal(redacted.includes("credential-epsilon"), false)
  assert.equal(redacted.includes("credential-zeta"), false)
  assert.match(redacted, /curl -u alice:\[redacted\] https:\/\/example\.test\/a/)
  assert.match(redacted, /--password \[redacted\].*--token=\[redacted\].*--api-key=\[redacted\].*--secret=\[redacted\]/)
  assert.match(redacted, /--safe visible/)
  assert.match(redacted, /https:\/\/bob:\[redacted\]@packages\.example\.test/)
  assert.match(redacted, /https:\/\/bob%3A\[redacted\]@packages\.example\.test/)
})

test("nested JSON-like payloads redact sensitive fields and separated argv values without flattening structure", () => {
  const input = {
    request: {
      argv: [
        "curl",
        "-u",
        `alice:${FIXTURES.basic}`,
        "--token",
        FIXTURES.quoted,
        `--password=${FIXTURES.encoded}`,
        "https://example.test/ok",
      ],
      metadata: {
        apiKey: FIXTURES.nested,
        dbPassword: FIXTURES.control,
        clientSecret: { value: FIXTURES.encoded },
        callback: `https://bob:${FIXTURES.unicode}@example.test/private`,
        label: "keep this readable",
      },
    },
  }
  const safe = redactCredentialStructure(input)
  const rendered = JSON.stringify(safe)
  for (const fixture of Object.values(FIXTURES)) assert.equal(rendered.includes(fixture), false, fixture)
  assert.deepEqual(safe.request.argv.slice(0, 2), ["curl", "-u"])
  assert.equal(safe.request.argv[2], "alice:[redacted]")
  assert.equal(safe.request.argv[3], "--token")
  assert.equal(safe.request.argv[4], "[redacted]")
  assert.equal(safe.request.metadata.label, "keep this readable")
  assert.equal(safe.request.metadata.dbPassword, "[redacted]")
  assert.equal(safe.request.metadata.clientSecret.value, "[redacted]")
  assert.match(safe.request.metadata.callback, /https:\/\/bob:\[redacted\]@example\.test/)

  assert.deepEqual(
    redactCredentialStructure(["curl", "-u", `top:${FIXTURES.basic}`, "--api-key", FIXTURES.nested]),
    ["curl", "-u", "top:[redacted]", "--api-key", "[redacted]"],
  )
})

test("ambiguous short flags, username-only auth, prose, and non-credential URLs remain unchanged", () => {
  const benign = [
    "python -p package-name",
    "server -t 30 -s staging",
    "sudo -u alice:staff id",
    "docker run -u 1000:1000 image",
    "curl -u alice https://example.test/public",
    "tool --user alice --password-stdin --tokenizer compact",
    "Discuss password rotation, secret scanning, and token accounting.",
    "https://example.test/org/repo@main",
    "ssh://alice@example.test/home",
    "git remote update -p",
    "--passｗord is a Unicode lookalike, not a real CLI flag",
  ].join("\n")
  assert.equal(redactCredentialSyntax(benign), benign)
})

test("bounded patterns stay linear on long hostile non-matches", () => {
  const hostile = `${"-".repeat(80_000)} --tokenizer ${"a".repeat(80_000)} https://${"b".repeat(20_000)}@example.test`
  const started = performance.now()
  assert.equal(redactCredentialSyntax(hostile), hostile)
  assert.ok(performance.now() - started < 1_000, "redaction should not pathologically backtrack")
})
