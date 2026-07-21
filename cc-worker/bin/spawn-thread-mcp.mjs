#!/usr/bin/env node
// @ts-check
/**
 * spawn-thread-mcp — a tiny, dependency-free MCP stdio server that gives a fray WORKER one tool,
 * `spawn_fray_thread`, to dispatch a brand-new TOP-LEVEL fray board thread (its own session +
 * scratchpad + independent drive — NOT an in-session Agent/Task helper). It wraps fray's own
 * dispatch RPC: it reads the running server's port from `<state-dir>/server.lock` and POSTs
 * `/rpc/dispatch`. The `/rpc` surface has no token auth — only a loopback-origin CSRF gate — so a
 * headerless local POST with `sec-fetch-site: same-origin` (undici sends no Origin) satisfies it.
 *
 * Injected identically into BOTH backends by the server (dispatch.ts): Claude via `--mcp-config`,
 * Codex via `-c mcp_servers.fray_spawn.*`. The server passes FRAY_STATE_DIR in this process's env so
 * we can locate server.lock without recomputing the project id.
 *
 * Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement exactly the four methods a
 * client drives (initialize, tools/list, tools/call, ping) plus the initialized notification. Hand-
 * rolled rather than pulling @modelcontextprotocol/sdk: the surface is tiny, it ships as one loose
 * .mjs next to bin/fray (no build/bundle/resolution concerns), and it matches this repo's own
 * hand-rolled-RPC aesthetic. The server NEVER crashes on a bad dispatch: failures come back as an
 * isError tool result so the worker sees a message instead of a dead tool.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PROTOCOL_FALLBACK = "2025-06-18"
// Comfortably above a codex dispatch's bounded rollout-discovery wait (~15s) so a legitimate slow
// dispatch is never aborted client-side (which would make the worker think it failed and retry,
// double-spawning). The server completes regardless; this is only the client's patience.
const DISPATCH_TIMEOUT_MS = 30_000

const TOOL = {
  name: "spawn_fray_thread",
  description:
    "Spawn a brand-new, separate top-level fray thread (its own board card, session, and scratchpad, " +
    "driving independently) — NOT an in-session sub-agent. Returns the new thread's slug and a ready-to-" +
    "paste markdown link `[title](/thread/<slug>)` that opens the thread in the fray drawer when clicked. " +
    "Use this to hand a distinct, self-contained effort to a fresh fray thread rather than doing it inline. " +
    "You MUST deliberately choose `model` and `effort` to match the NEW thread's task complexity — they are " +
    "required, there is NO default. Do not reflexively pick the cheapest; a hard task on a weak model/effort " +
    "wastes the whole thread.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The full task/prompt for the new thread's worker. Be self-contained — the new thread starts with empty context.",
      },
      model: {
        type: "string",
        description:
          "REQUIRED — pick by the NEW task's complexity; there is no default. For the `claude` backend: " +
          "`opus` (hardest reasoning, architecture, subtle correctness/security, adversarial review, the " +
          "fix that must land), `sonnet` (ordinary substantive implementation/research), `haiku` (simple, " +
          "fully-specified mechanical work), `fable` (fastest/cheapest — ONLY trivial throwaway tasks). For " +
          "the `codex` backend use a codex model id instead (e.g. `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`). " +
          "Match the model to the backend you choose. Bias toward Opus/a strong model when the task is " +
          "non-trivial or its outcome is load-bearing.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "REQUIRED — reasoning effort, pick by complexity; no default. `low` only for trivial tasks; " +
          "`medium` for routine work; `high` for ordinary substantive work; `xhigh` for hard coding/agentic " +
          "work; `max` for the single hardest problems. (Codex also accepts `ultra`.)",
      },
      backend: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional agent backend (default `claude`). If `codex`, `model` must be a codex model id.",
      },
      title: { type: "string", description: "Optional short title for the new thread (else derived from the prompt)." },
    },
    required: ["prompt", "model", "effort"],
  },
}

/** @param {unknown} obj */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}
/** @param {string|number} id @param {unknown} result */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}
/** @param {string|number} id @param {number} code @param {string} message */
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}
/** @param {string|number} id @param {string} text @param {boolean} [isError] */
function replyTool(id, text, isError) {
  reply(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })
}

function serverLockPort() {
  const lock = process.env.FRAY_SERVER_LOCK
    || (process.env.FRAY_STATE_DIR ? join(process.env.FRAY_STATE_DIR, "server.lock") : undefined)
  if (!lock) throw new Error("FRAY_STATE_DIR / FRAY_SERVER_LOCK not set — cannot locate the fray server")
  let parsed
  try {
    parsed = JSON.parse(readFileSync(lock, "utf8"))
  } catch (err) {
    throw new Error(`could not read the fray server lock at ${lock} (is the server running?): ${err instanceof Error ? err.message : err}`)
  }
  const port = parsed?.port
  if (!Number.isInteger(port)) throw new Error(`fray server lock at ${lock} has no valid port`)
  return port
}

/** @param {Record<string, unknown>} args */
async function dispatchThread(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string")
  // model + effort are REQUIRED (no default) so the caller must choose by task complexity — a defaulted
  // model (e.g. the project's cheap default) is exactly the bug this guards. Enforced server-side too,
  // not only in the tool schema, so a lenient client can't skip the decision.
  const model = typeof args.model === "string" ? args.model.trim() : ""
  if (!model) throw new Error("`model` is required — choose one by the new task's complexity (claude: opus/sonnet/haiku/fable; codex: a gpt-5.6 model id). There is no default.")
  const effort = typeof args.effort === "string" ? args.effort.trim() : ""
  if (!effort) throw new Error("`effort` is required — choose one by complexity (low/medium/high/xhigh/max). There is no default.")

  /** @type {Record<string, unknown>} */
  const body = { prompt, model, effort }
  if (typeof args.title === "string" && args.title.trim()) body.title = args.title.trim()
  if (args.backend === "claude" || args.backend === "codex") body.backend = args.backend

  const port = serverLockPort()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc/dispatch`, {
      method: "POST",
      // No Origin header (undici omits it for non-browser fetch); `sec-fetch-site: same-origin`
      // satisfies the server's loopback-origin gate (app.ts isTrustedLocalHttpRequest).
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`dispatch request failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`dispatch returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  const payload = await res.json().catch(() => null)
  const slug = payload?.result?.slug
  if (typeof slug !== "string" || !slug) throw new Error(`dispatch response missing a slug: ${JSON.stringify(payload)?.slice(0, 300)}`)
  const label = typeof body.title === "string" ? body.title : slug
  return { slug, label }
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "fray-spawn", version: "0.1.0" },
      })
      return
    }
    case "notifications/initialized":
    case "initialized":
      return // notification — no reply
    case "ping":
      if (!isNotification) reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: [TOOL] })
      return
    case "tools/call": {
      if (params?.name !== TOOL.name) {
        replyError(id, -32602, `unknown tool: ${params?.name}`)
        return
      }
      try {
        const { slug, label } = await dispatchThread(params?.arguments ?? {})
        replyTool(
          id,
          `Spawned a new fray thread \`${slug}\`. It is now on the board driving independently.\n\n` +
            `Paste this link to let the human open it in the drawer:\n\n[${label}](/thread/${slug})`,
        )
      } catch (err) {
        replyTool(id, `Failed to spawn a fray thread: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
      return
  }
}

// NDJSON reader: buffer stdin, dispatch each complete line. Messages never contain raw newlines.
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore unparseable lines
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
