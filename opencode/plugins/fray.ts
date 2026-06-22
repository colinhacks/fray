import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tool } from "@opencode-ai/plugin"
import {
  appendLedger,
  formatBoard,
  formatValidation,
  frayActive,
  frayRoot,
  reminder,
  searchThreads,
  threadPath,
  validationErrors,
} from "../fray/core.mjs"

const THREAD_RE = /^THREAD:\s*([a-z0-9][a-z0-9-]*)\s*$/
const DISPATCH_RE = /^FRAY_DISPATCH_ID:\s*(\S+)\s*$/m

const EPILOGUE = `

---
[ORCHESTRATION EPILOGUE - appended by .opencode/plugins/fray.ts]
End your final report with a \`## Follow-ups\` section so the orchestrator can chain the next steps:
1. Concrete follow-up work your findings or changes imply.
2. If you implemented something substantial, recommend a fresh adversarial review pass.
3. If you changed code or tests CI should exercise, recommend a push-to-main and CI-watch follow-up.
4. The single most important next step, and whether it needs the maintainer because it is a default/security/product/brand/API-config-env call.
If there are no follow-ups, write exactly:
\`\`\`markdown
## Follow-ups
None.
\`\`\``

function leadingThread(prompt: string) {
  const first = prompt.split("\n").find((line) => line.trim())?.trim() || ""
  return first.match(THREAD_RE)?.[1]
}

function dispatchId(prompt: string) {
  return prompt.match(DISPATCH_RE)?.[1]
}

function returnedTaskId(output: string) {
  return output.match(/<task\s+id="([^"]+)"/)?.[1] || output.match(/task_id["`':\s]+(ses_[A-Za-z0-9_-]+)/)?.[1] || ""
}

function rejectProModels(config: Record<string, any>) {
  const offenders: string[] = []
  if (config.model === "openai/gpt-5.5-pro") offenders.push("model")
  if (config.small_model === "openai/gpt-5.5-pro") offenders.push("small_model")
  for (const [name, agent] of Object.entries(config.agent || {})) {
    if ((agent as Record<string, unknown>)?.model === "openai/gpt-5.5-pro") offenders.push(`agent.${name}.model`)
  }
  if (offenders.length) throw new Error(`Fray forbids openai/gpt-5.5-pro because of cost. Replace: ${offenders.join(", ")}`)
}

export const OpenCodeFray = async ({ directory, worktree }: { directory: string; worktree?: string }) => {
  const root = frayRoot(directory, worktree)

  return {
    config: async (config: Record<string, any>) => {
      rejectProModels(config)
    },

    tool: {
      fray_status: tool({
        description: "Print the OpenCode fray board computed from .fray thread files.",
        args: {
          status: tool.schema.string().optional().describe("Optional status filter such as active, needs-decision, done, or dismissed."),
        },
        async execute(args, context) {
          const r = frayRoot(context.directory, context.worktree)
          return formatBoard(r, args.status || undefined)
        },
      }),
      fray_validate: tool({
        description: "Validate OpenCode fray thread frontmatter and return validation errors.",
        args: {},
        async execute(_args, context) {
          const r = frayRoot(context.directory, context.worktree)
          const errors = validationErrors(r)
          return { output: formatValidation(r), metadata: { ok: errors.length === 0, errors } }
        },
      }),
      fray_search: tool({
        description: "Search OpenCode fray thread ids, titles, and bodies.",
        args: {
          query: tool.schema.string().describe("Search text."),
        },
        async execute(args, context) {
          const r = frayRoot(context.directory, context.worktree)
          return searchThreads(r, args.query)
        },
      }),
    },

    "experimental.chat.system.transform": async (_input: unknown, output: { system?: string[] }) => {
      if (!frayActive(root)) return
      output.system ||= []
      const pulse = reminder(root)
      if (pulse) output.system.push(pulse)
    },

    "tool.definition": async (input: { toolID?: string }, output: { description?: string }) => {
      if (String(input.toolID || "").toLowerCase() !== "task") return
      output.description = `${output.description || ""}\n\nFray discipline for thread-scoped OpenCode Task calls: put THREAD: <slug> at the top of the prompt, create .fray/<slug>.md first, make the prompt self-contained, tell the agent not to edit .fray/<slug>.md or .fray/config.yml, and require a final ## Follow-ups section. Completed Task agents can be resumed with task_id; running agents cannot be live-steered.`
    },

    "command.execute.before": async (input: { command?: string }, output: { parts?: Array<Record<string, unknown>> }) => {
      const command = String(input.command || "")
      if (command !== "fray" && command !== "fray-validate") return
      if (!frayActive(root)) return
      output.parts ||= []
      const textPart = output.parts.find((part) => part.type === "text" && typeof part.text === "string")
      if (textPart) textPart.text = `${textPart.text}\n\n${command === "fray" ? formatBoard(root) : formatValidation(root)}`
    },

    "tool.execute.before": async (input: { tool?: string; callID?: string; sessionID?: string }, output: { args?: Record<string, unknown> }) => {
      const toolName = String(input.tool || "").toLowerCase()
      if (toolName !== "task") return

      const args = output.args || {}
      let prompt = typeof args.prompt === "string" ? args.prompt : ""
      const thread = leadingThread(prompt)
      if (!thread) return

      if (!frayActive(root, input.sessionID)) return

      if (!existsSync(threadPath(root, thread))) {
        throw new Error(`Fray thread .fray/${thread}.md does not exist. Create the thread file before dispatching.`)
      }

      let id = dispatchId(prompt)
      if (!id) {
        id = `opencode-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`
        prompt = prompt.replace(/^(\s*THREAD:\s*.+)$/m, `$1\nFRAY_DISPATCH_ID: ${id}`)
      }

      if (!prompt.includes("[ORCHESTRATION EPILOGUE")) prompt += EPILOGUE
      args.prompt = prompt
      output.args = args

      appendLedger(root, {
        ts: new Date().toISOString(),
        tool: "opencode.task",
        phase: "before",
        session_id: input.sessionID || "",
        call_id: input.callID || "",
        dispatch_id: id,
        thread,
        task_id: typeof args.task_id === "string" ? args.task_id : "",
        reconciled: false,
      })
    },

    "tool.execute.after": async (input: { tool?: string; callID?: string; sessionID?: string; args?: Record<string, unknown> }, output: { output?: string }) => {
      const toolName = String(input.tool || "").toLowerCase()
      if (toolName !== "task") return
      const prompt = typeof input.args?.prompt === "string" ? input.args.prompt : ""
      const thread = leadingThread(prompt)
      if (!thread) return
      if (!frayActive(root, input.sessionID)) return
      const text = String(output.output || "")
      appendLedger(root, {
        ts: new Date().toISOString(),
        tool: "opencode.task",
        phase: "after",
        session_id: input.sessionID || "",
        call_id: input.callID || "",
        dispatch_id: dispatchId(prompt) || "",
        thread,
        task_id: returnedTaskId(text),
        has_followups: /^##\s+Follow-ups\b/m.test(text),
        reconciled: false,
      })
    },

    "experimental.session.compacting": async (_input: unknown, output: { context?: string[] }) => {
      if (!frayActive(root)) return
      output.context ||= []
      output.context.push(`## OpenCode Fray State\n${reminder(root)}\nBefore continuing, load the opencode-fray skill and run \`fray_status\` or \`node .opencode/fray/index.mjs\`.`)
    },

    "shell.env": async (_input: unknown, output: { env?: Record<string, string> }) => {
      if (!frayActive(root)) return
      output.env ||= {}
      output.env.FRAY_ROOT = root
      output.env.FRAY_OPENCODE = "1"
    },
  }
}
