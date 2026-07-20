import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { AgentBlock, BackgroundOpsStrip, ThreadSlugContext, ToolStatusMeta } from "./components/ChatView.tsx"
import { QueueSubAgentLines } from "./components/QueueSubAgentLines.tsx"
import { ToolDisclosureHeader } from "./components/ToolDisclosureHeader.ts"
import { store } from "./store.ts"
import "./styles.css"

const thread: ThreadView = {
  id: "operation-indicators",
  title: "Per-operation running indicators",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [
    { id: "agent-a", label: "Inspect logs", startedAt: "2026-07-14T10:00:00.000Z", state: "running" },
    { id: "agent-b", label: "Run regression suite", startedAt: "2026-07-14T10:01:00.000Z", state: "running" },
    { id: "agent-stale", label: "Prior investigation", startedAt: "2026-07-14T09:00:00.000Z", state: "stale" },
  ],
  bgShells: [
    { label: "Watch CI", startedAt: "2026-07-14T10:00:00.000Z", state: "running" },
    { label: "Tail build log", startedAt: "2026-07-14T10:01:00.000Z", state: "running" },
    // Alive but quiet: a dev server waiting for requests, and a Monitor (which has no output file, so
    // it is ALWAYS reported stale). Both are live processes — they breathe, never a dead gray dot.
    { label: "Dev server (waiting, no recent output)", startedAt: "2026-07-14T09:00:00.000Z", state: "stale" },
    { label: "Monitor: PR checks", startedAt: "2026-07-14T09:30:00.000Z", state: "stale" },
  ],
}

store.board = { threads: [thread] } as BoardSnapshot

function DisclosureFixture({ running }: { running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = `fixture-disclosure-${running ? "running" : "done"}`
  return (
    <div className="fray-bash">
      <ToolDisclosureHeader
        className="fray-bash-header"
        controls={bodyId}
        expanded={expanded}
        label={`${expanded ? "Collapse" : "Expand"} ${running ? "running" : "completed"} operation`}
        onToggle={() => setExpanded((value) => !value)}
        meta={<ToolStatusMeta status={running ? "pending" : "completed"} backgroundState={running ? "background" : undefined} />}
      >
        <span className="petite-caps fray-bash-label shrink-0">Bash</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted">{running ? "Watch CI until checks finish" : "Completed CI checks"}</span>
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!expanded} className="border-t border-border px-2.5 py-2 text-[11.5px] text-muted">Operation details remain available without changing the header alignment.</div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-5 py-10">
    <header>
      <p className="petite-caps text-[11px] text-accent">Fixture</p>
      <h1 className="mt-1 text-lg font-semibold">Per-operation running indicators</h1>
      <p className="mt-2 text-sm text-muted">Each dot belongs to a named operation. There is intentionally no aggregate session “Running” pulse.</p>
    </header>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Chat background operations</h2>
      <BackgroundOpsStrip slug={thread.id} className="pt-3" />
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Queue sub-agents</h2>
      <QueueSubAgentLines slug={thread.id} subAgents={thread.subAgents} />
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Tool disclosures</h2>
      <div className="mt-3 flex flex-col gap-2 text-[12px]">
        <div className="flex items-center justify-between gap-3"><span>Watch CI (launch wrapper returned)</span><ToolStatusMeta status="completed" backgroundState="background" liveBackgroundState="running" /></div>
        <div className="flex items-center justify-between gap-3"><span>Completed build</span><ToolStatusMeta status="completed" durationMs={32_000} /></div>
        <div className="flex items-center justify-between gap-3"><span>Failed test</span><ToolStatusMeta status="failed" exitCode={1} durationMs={12_000} /></div>
        <div className="flex items-center justify-between gap-3"><span>Cancelled command</span><ToolStatusMeta status="cancelled" /></div>
      </div>
    </section>
    {/* Agent rows carry TWO independent status sources — their own stateLabel (with its dot) and the
        shared meta slot — so they are the one card family that can render a DOUBLE indicator. Each row
        below must show exactly one `data-running-indicator`, and the no-child rows must still surface
        their terminal status/duration through the meta slot. */}
    <section data-agent-rows className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Agent rows</h2>
      <div className="mt-3 flex flex-col gap-2">
        <ThreadSlugContext.Provider value={thread.id}>
          {/* Live child, running: the reported bug — "running Nm ●" plus a second "● RUNNING" badge. */}
          <AgentBlock detail="Measure private repo placeholder prevalence" prompt="Measure how many repos use the placeholder." subagentType="fray:opus-high" agentId="agent-a" status="pending" />
          {/* Live child gone quiet: reads "stale", and must NOT be contradicted by a "running" badge. */}
          <AgentBlock detail="Prior investigation" prompt="Investigate the earlier failure." subagentType="fray:sonnet-high" agentId="agent-stale" status="pending" />
          {/* Completed child: agentStatus supplies "finished 3m"; the meta slot stays empty. */}
          <AgentBlock detail="Diagnose remotion model routing anomaly" prompt="Diagnose the routing anomaly." subagentType="fray:opus-high" agentId="agent-done" agentStatus="completed" agentElapsedMs={183_000} status="completed" durationMs={183_000} />
          {/* No child record at all — the meta slot is the ONLY status surface, so a terminal status
              and its duration must still render here (this is what the suppression must never eat). */}
          <AgentBlock detail="Cancelled dispatch (no child record)" prompt="This dispatch was interrupted." status="cancelled" />
          <AgentBlock detail="Failed dispatch (no child record)" prompt="This dispatch failed." status="failed" durationMs={12_000} />
        </ThreadSlugContext.Provider>
      </div>
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Disclosure row alignment</h2>
      <div className="mt-3 flex flex-col gap-2">
        <DisclosureFixture running />
        <DisclosureFixture running={false} />
      </div>
    </section>
  </main>,
)
