import type { SubAgentView } from "@fray-ui/shared"
import { pushSubAgentDrawer } from "../store.ts"
import { runningQueueSubAgents } from "../lib/queueSubAgents.ts"

// A queue handoff should name the work still running beneath the parent without turning it into a
// second operations toolbar. Only live children render here; stale children disappear, and background
// shells/Monitors remain in BackgroundOpsStrip below as a separate runtime concern.
export function QueueSubAgentLines({ slug, subAgents }: { slug: string; subAgents: readonly SubAgentView[] }) {
  const running = runningQueueSubAgents(subAgents)
  if (running.length === 0) return null
  return (
    <div data-queue-subagents className="flex min-w-0 flex-col gap-0.5 px-1 pt-1.5">
      {running.map((agent, index) => {
        const open = agent.id
          ? () => pushSubAgentDrawer(slug, agent.id!, { label: agent.label, subagentType: agent.subagentType, startedAt: agent.startedAt })
          : undefined
        return (
          <button
            key={agent.id ?? `${agent.startedAt}-${index}`}
            type="button"
            disabled={!open}
            onClick={open}
            title={open ? "Open sub-agent transcript" : undefined}
            className="group flex min-w-0 items-center gap-1.5 rounded-sm text-left text-[11.5px] text-muted/65 outline-none transition-colors enabled:hover:text-fg/85 disabled:cursor-default"
          >
            <span aria-hidden className="shrink-0 text-[11px] leading-none text-muted/45">↳</span>
            <span aria-hidden className="fray-live-dot" data-running-indicator="queue-subagent" />
            <span className="min-w-0 truncate group-enabled:group-hover:underline">{agent.label}</span>
          </button>
        )
      })}
    </div>
  )
}
