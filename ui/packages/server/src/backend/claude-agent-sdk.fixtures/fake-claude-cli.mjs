#!/usr/bin/env node

// Deterministic Claude CLI protocol stand-in used only by the Agent SDK contract tests. It speaks
// stream-json over stdio, performs no network access, and records only the explicit safe evidence
// fields the tests need (never credential values).

import { appendFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const executablePath = process.argv[1] ?? ""
const pathScenario = /^fake-claude--([a-z0-9-]+)(?:\.mjs)?$/i.exec(basename(executablePath))?.[1]
const scenario = process.env.FRAY_FAKE_CLAUDE_SCENARIO ?? pathScenario ?? "basic"
const capturePath = process.env.FRAY_FAKE_CLAUDE_CAPTURE ?? (pathScenario ? join(dirname(executablePath), "capture.jsonl") : undefined)
const requestedSessionId = optionValue("--session-id") ?? optionValue("--resume") ?? "00000000-0000-4000-8000-000000000001"
const sessionId = scenario === "mismatch" ? "00000000-0000-4000-8000-000000000099" : requestedSessionId
const eventSessionId = scenario === "late-mismatch" ? "00000000-0000-4000-8000-000000000098" : sessionId
const permissionRequest = {
  type: "control_request",
  request_id: "permission-request-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "printf safe" },
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "printf *" }], behavior: "allow", destination: "session" }],
    blocked_path: "/tmp/outside",
    decision_reason: "outside the working directory",
    title: "Run a safe command",
    display_name: "Run command",
    description: "Print a test marker",
    tool_use_id: "tool-use-permission-1",
    agent_id: "agent-main",
  },
}

let initializeCount = 0
let systemInitSent = false
let elicitationStep = 0
let permissionResponses = 0
let resultNumber = 0
let userInputCount = 0

record({
  kind: "startup",
  argv: args,
  cwd: process.cwd(),
  environment: {
    frayFakeInheritedPresent: process.env.FRAY_FAKE_INHERITED !== undefined,
    frayFakeOverridePresent: process.env.FRAY_FAKE_OVERRIDE !== undefined,
    clientApp: process.env.CLAUDE_AGENT_SDK_CLIENT_APP,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    pathPresent: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
    homePresent: typeof process.env.HOME === "string" && process.env.HOME.length > 0,
    nodeOptionsPresent: process.env.NODE_OPTIONS !== undefined,
    anthropicApiKeyPresent: process.env.ANTHROPIC_API_KEY !== undefined,
    anthropicBaseUrlPresent: process.env.ANTHROPIC_BASE_URL !== undefined,
    anthropicAuthTokenPresent: process.env.ANTHROPIC_AUTH_TOKEN !== undefined,
    oauthTokenPresent: process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
    githubTokenPresent: process.env.GITHUB_TOKEN !== undefined,
    openaiApiKeyPresent: process.env.OPENAI_API_KEY !== undefined,
    awsSecretAccessKeyPresent: process.env.AWS_SECRET_ACCESS_KEY !== undefined,
    fraySecretPresent: process.env.FRAY_SHOULD_NOT_LEAK !== undefined,
    arbitrarySecretPresent: process.env.ARBITRARY_SECRET !== undefined,
  },
})

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on("line", (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write("fake protocol received malformed JSON\n")
    return
  }
  if (message.type === "control_request") handleHostControl(message)
  else if (message.type === "control_response") handleHostResponse(message)
  else if (message.type === "user") handleUserMessage(message)
})

lines.on("close", () => {
  record({ kind: "stdin-end" })
  process.exit(0)
})

process.on("SIGTERM", () => {
  record({ kind: "signal", signal: "SIGTERM" })
  process.exit(0)
})

function optionValue(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function handleHostControl(message) {
  const request = message.request ?? {}
  record({ kind: "host-control", requestId: message.request_id, subtype: request.subtype, mode: request.mode })
  if (request.subtype === "initialize") {
    initializeCount += 1
    const pending = (scenario === "redelivery" || scenario === "conflicting-redelivery") && initializeCount > 1
      ? { pending_permission_requests: [scenario === "conflicting-redelivery"
        ? { ...permissionRequest, request: { ...permissionRequest.request, input: { command: "printf conflict" } } }
        : permissionRequest] }
      : {}
    respond(message.request_id, initializationPayload(), pending)
    if (!systemInitSent) {
      systemInitSent = true
      if (scenario !== "no-init") emitSystemInit()
      if (scenario === "duplicate-init") setTimeout(emitSystemInit, 25)
      if (scenario === "diagnostic") emitHostileDiagnostic()
    }
    return
  }
  if (request.subtype === "interrupt") {
    if (scenario === "hanging-control") return
    respond(message.request_id, scenario === "controls-no-receipt" ? {} : {
      still_queued: ["11111111-1111-4111-8111-111111111111", "internal-queue-id"],
    })
    return
  }
  if (request.subtype === "set_permission_mode") {
    respond(message.request_id, {})
    return
  }
  respondError(message.request_id, `unsupported fake control subtype ${String(request.subtype)}`)
}

function handleHostResponse(message) {
  const response = message.response ?? {}
  const requestId = response.request_id
  record({ kind: "host-response", requestId, response })
  if (requestId === "permission-request-1") {
    permissionResponses += 1
    if ((scenario === "redelivery" || scenario === "conflicting-redelivery") && permissionResponses === 1) return
    emitToolResult("tool-use-permission-1", "permission accepted")
    emitResult("permission complete")
    return
  }
  if (requestId === "ask-request-1") {
    emitToolResult("tool-use-ask-1", "question answered")
    emitResult("question complete")
    return
  }
  if (requestId === "elicitation-form-1") {
    elicitationStep = 1
    send({
      type: "control_request",
      request_id: "elicitation-url-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "example-mcp",
        message: "Complete approval in your browser",
        mode: "url",
        url: "https://example.test/approve?id=safe",
        elicitation_id: "elicitation-safe-1",
        title: "Browser approval",
        display_name: "Example MCP",
        description: "Approve access",
      },
    })
    return
  }
  if (requestId === "elicitation-url-1") {
    elicitationStep = 2
    emitResult("elicitation complete")
  }
}

function handleUserMessage(message) {
  userInputCount += 1
  record({ kind: "user-input", uuid: message.uuid, text: extractText(message.message?.content) })
  if (scenario === "crash") {
    process.stderr.write("fake child crash\n")
    process.exit(17)
    return
  }
  if (scenario === "permission" || scenario === "redelivery") {
    send(permissionRequest)
    return
  }
  if (scenario === "conflicting-redelivery") {
    send(permissionRequest)
    return
  }
  if (scenario === "permission-flood") {
    for (let index = 0; index < 140; index += 1) {
      send(permissionRequestFor(index))
    }
    return
  }
  if (scenario === "permission-hostile") {
    send({
      ...permissionRequest,
      request_id: "hostile-request",
      request: {
        ...permissionRequest.request,
        permission_suggestions: Array.from({ length: 40 }, (_, index) => ({ type: "suggestion", index })),
      },
    })
    return
  }
  if (scenario === "permission-ambiguous-text") {
    send({
      ...permissionRequest,
      request_id: "ambiguous-text-request",
      request: {
        ...permissionRequest.request,
        tool_name: "Bash\u061c",
      },
    })
    return
  }
  if (scenario === "permission-missing-request-id") {
    const missingId = { ...permissionRequest }
    delete missingId.request_id
    send(missingId)
    return
  }
  if (scenario === "ask") {
    send({
      type: "control_request",
      request_id: "ask-request-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [{
            question: "Which release channel?",
            header: "Channel",
            options: [{ label: "Stable", description: "Use stable" }, { label: "Beta", description: "Use beta" }],
            multiSelect: false,
          }],
        },
        tool_use_id: "tool-use-ask-1",
      },
    })
    return
  }
  if (scenario === "elicitation") {
    send({
      type: "control_request",
      request_id: "elicitation-form-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "example-mcp",
        message: "Choose a deployment region",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { region: { type: "string", enum: ["us-west", "eu-central"] } },
          required: ["region"],
        },
        title: "Deployment region",
        display_name: "Example MCP",
        description: "Select one region",
      },
    })
    return
  }
  if (scenario === "elicitation-secret") {
    send({
      type: "control_request",
      request_id: "elicitation-secret-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Enter your API token",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { api_token: { type: "string", title: "API token" } },
          required: ["api_token"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-secret-auth-code") {
    send({
      type: "control_request",
      request_id: "elicitation-secret-auth-code-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Enter the value",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { authorization_code: { type: "string", title: "Value" } },
          required: ["authorization_code"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-url-with-schema") {
    send({
      type: "control_request",
      request_id: "elicitation-url-with-schema-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Open approval",
        mode: "url",
        url: "https://example.test/approve",
        elicitation_id: "elicitation-url-with-schema-id",
        requested_schema: { type: "object", properties: { value: { type: "string" } } },
      },
    })
    return
  }
  if (scenario === "elicitation-nested-schema") {
    send({
      type: "control_request",
      request_id: "elicitation-nested-schema-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "hostile-mcp",
        message: "Complete your profile",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          },
          required: ["profile"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-invalid-response") {
    send({
      type: "control_request",
      request_id: "elicitation-invalid-response-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "example-mcp",
        message: "Choose a deployment region",
        mode: "form",
        requested_schema: {
          type: "object",
          properties: { region: { type: "string", enum: ["west", "east"] } },
          required: ["region"],
        },
      },
    })
    return
  }
  if (scenario === "elicitation-flood") {
    for (let index = 0; index < 140; index += 1) {
      send({
        type: "control_request",
        request_id: `elicitation-flood-${index}`,
        request: {
          subtype: "elicitation",
          mcp_server_name: "example-mcp",
          message: `Choose region ${index}`,
          mode: "form",
          requested_schema: {
            type: "object",
            properties: { region: { type: "string", enum: ["west", "east"] } },
            required: ["region"],
          },
        },
      })
    }
    return
  }
  if (scenario === "hold-inputs") return
  if (scenario === "synthetic-receipt") {
    send({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-receipt-tool", content: "synthetic" }] },
      parent_tool_use_id: null,
      uuid: message.uuid,
      session_id: eventSessionId,
      isSynthetic: true,
    })
    return
  }
  if (scenario === "tool-result-receipt") {
    send({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "receipt-tool", content: "provider generated" }] },
      parent_tool_use_id: null,
      uuid: message.uuid,
      session_id: eventSessionId,
    })
    return
  }
  if (scenario === "subagent-progress") {
    emitAssistant("subagent progressed", "subagent-parent-tool")
    return
  }
  if (scenario === "progress-no-receipt") {
    if (userInputCount === 1) {
      emitAssistant("provider progressed without echo")
      emitResult("progress complete")
    }
    return
  }
  if (scenario === "missing-session") {
    emitUserEcho(message, true)
    return
  }
  if (scenario === "event-flood") {
    for (let index = 0; index < 300; index += 1) emitAssistant(`flood ${index}`)
    return
  }

  emitUserEcho(message)
  emitAssistant("fake assistant response")
  emitResult("fake final result")
  emitPromptSuggestion()
  if (scenario === "eof") process.exit(0)
}

function initializationPayload() {
  return {
    commands: [{ name: "review", description: "Review changes", argumentHint: "<path>", aliases: ["inspect"] }],
    agents: [{ name: "Explore", description: "Explore the repository", model: "sonnet" }],
    output_style: "default",
    available_output_styles: ["default", "concise"],
    models: [{
      value: "sonnet",
      resolvedModel: "claude-sonnet-test",
      displayName: "Sonnet Test",
      description: "Fake test model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
    }],
    account: {},
  }
}

function emitSystemInit() {
  send({
    type: "system",
    subtype: "init",
    apiKeySource: "temporary",
    claude_code_version: "2.1.207",
    cwd: process.cwd(),
    tools: ["Bash", "AskUserQuestion"],
    mcp_servers: [{ name: "example-mcp", status: "connected" }],
    model: "claude-sonnet-test",
    permissionMode: optionValue("--permission-mode") ?? "default",
    slash_commands: ["review"],
    output_style: "default",
    skills: ["review"],
    plugins: [{ name: "fake-plugin", path: "/tmp/fake-plugin" }],
    capabilities: scenario === "controls-no-receipt" ? [] : ["interrupt_receipt_v1", "future_unknown_capability"],
    uuid: "20000000-0000-4000-8000-000000000001",
    session_id: sessionId,
  })
}

function emitUserEcho(message, omitSession = false) {
  const event = {
    ...message,
    uuid: message.uuid ?? "30000000-0000-4000-8000-000000000001",
    session_id: eventSessionId,
    parent_tool_use_id: null,
  }
  if (omitSession) delete event.session_id
  send(event)
}

function emitAssistant(text, parentToolUseId = null) {
  resultNumber += 1
  send({
    type: "assistant",
    message: {
      id: `msg_fake_${resultNumber}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: parentToolUseId,
    uuid: `40000000-0000-4000-8000-${String(resultNumber).padStart(12, "0")}`,
    session_id: eventSessionId,
  })
}

function emitToolResult(toolUseId, text) {
  send({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
    parent_tool_use_id: null,
    uuid: `50000000-0000-4000-8000-${String(permissionResponses + elicitationStep + 1).padStart(12, "0")}`,
    session_id: eventSessionId,
    isSynthetic: true,
  })
}

function emitResult(result) {
  resultNumber += 1
  send({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: `60000000-0000-4000-8000-${String(resultNumber).padStart(12, "0")}`,
    session_id: eventSessionId,
  })
}

function emitPromptSuggestion() {
  send({
    type: "prompt_suggestion",
    suggestion: "Run another fake turn",
    uuid: "70000000-0000-4000-8000-000000000001",
    session_id: eventSessionId,
  })
}

function emitHostileDiagnostic() {
  const secret = "stage-one-secret-value"
  process.stderr.write(`\u001b[31mBearer ${secret}\u001b[0m token=${secret} \u202ehostile ${"x".repeat(8_192)}\n`)
}

function permissionRequestFor(index) {
  return {
    ...permissionRequest,
    request_id: `permission-flood-${index}`,
    request: {
      ...permissionRequest.request,
      input: { command: `printf ${index}` },
      tool_use_id: `tool-use-flood-${index}`,
    },
  }
}

function extractText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((entry) => entry?.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("\n")
}

function respond(requestId, response, extra = {}) {
  send({ type: "control_response", response: { subtype: "success", request_id: requestId, response, ...extra } })
}

function respondError(requestId, error) {
  send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } })
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function record(value) {
  if (!capturePath) return
  appendFileSync(capturePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 })
}
