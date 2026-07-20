import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { InteractionPayload } from "@fray-ui/shared"
import { ApprovalDetails } from "./ApprovalDetails.ts"

type ApprovalPayload = Extract<InteractionPayload, {
  kind: "command-approval" | "file-approval" | "permission-approval"
}>

function render(payload: ApprovalPayload): string {
  return renderToStaticMarkup(createElement(ApprovalDetails, { payload }))
}

test("command approval renders hostile display text literally with accessible, narrow-safe detail sections", () => {
  const html = render({
    kind: "command-approval",
    title: "Command",
    message: "<img src=x onerror=alert(1)>",
    command: {
      summary: "Run <script>alert(1)</script>",
      preview: "rm -rf / && echo '<script>alert(1)</script>'",
      redacted: true,
      workingDirectoryLabel: "/very/long/<script>/workspace",
      actions: [{
        kind: "read",
        commandPreview: "cat /etc/passwd",
        resourceLabel: "/etc/passwd?<img src=x>",
      }],
    },
    capabilities: [
      { kind: "network", enabled: true, hosts: ["https: packages.example.test/<script>"] },
      { kind: "filesystem", access: "write", resources: ["/very/long/path/that/must/wrap"] },
      { kind: "exec-policy", prefixes: ["git", "push", "--force"] },
    ],
  })
  assert.match(html, /aria-label="Parsed command actions"/)
  assert.match(html, /aria-label="Requested capabilities"/)
  assert.match(html, /aria-label="Hosts and protocols"/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|<img\b/)
  assert.match(html, /min-w-0/)
  assert.match(html, /break-all/)
  assert.match(html, /max-w-full min-w-0 overflow-auto/)
  assert.doesNotMatch(html, /rpc-request-id|provider-context|transport-secret/)
})

test("file approval exposes affected paths, operations, destinations, and bounded plain-text diffs", () => {
  const html = render({
    kind: "file-approval",
    title: "Files",
    operation: "write",
    pathLabel: "2 affected paths",
    grantRootLabel: "/workspace/<session-root>",
    scopeLabel: "Approving for this session authorizes writes below this root for the remainder of the current Codex session.",
    changes: [
      {
        operation: "move",
        pathLabel: "/workspace/<source>.ts",
        destinationLabel: "/workspace/<destination>.ts",
        diffPreview: "- const unsafe = '<script>'\n+ const safe = true",
      },
      { operation: "delete", pathLabel: "/workspace/obsolete.ts" },
    ],
  })
  assert.match(html, /aria-label="Affected file changes"/)
  assert.match(html, /Move file/)
  assert.match(html, /Delete file/)
  assert.match(html, /→/)
  assert.match(html, /Move file plain-text diff/)
  assert.match(html, /aria-label="Requested session write root"/)
  assert.match(html, /Approving for this session authorizes writes below this root/)
  assert.match(html, /&lt;session-root&gt;/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /min-w-0/)
  assert.match(html, /overflow-auto/)
})

test("permission approval gives canonical capability and scope labels without provider transport metadata", () => {
  const html = render({
    kind: "permission-approval",
    title: "Permissions",
    permission: "network+filesystem",
    workingDirectoryLabel: "/workspace",
    scopeLabel: "Approval can be granted for this turn or for the current Codex session.",
    capabilities: [
      { kind: "filesystem", access: "read", resources: ["Project roots, subpath: src"] },
      { kind: "filesystem", access: "deny", resources: ["Filesystem root (/)"] },
      { kind: "glob-scan", depth: 0 },
      { kind: "network-policy", access: "deny", hosts: ["metadata.internal"] },
    ],
  })
  assert.match(html, /aria-label="Requested capabilities"/)
  assert.match(html, /Read filesystem paths/)
  assert.match(html, /Deny filesystem paths/)
  assert.match(html, /Maximum depth: 0/)
  assert.match(html, /Deny future network hosts/)
  assert.match(html, /this turn or for the current Codex session/)
  assert.doesNotMatch(html, /providerRequestId|connectionEpoch|rpcRequestId|environmentId/)
})
