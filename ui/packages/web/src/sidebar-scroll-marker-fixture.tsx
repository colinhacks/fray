import { createRoot } from "react-dom/client"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

const thread = {
  id: "selected-queue-thread",
  kind: "session",
  title: "The queue card currently in view has a wrapped title",
  backend: "codex",
  runtime: "turn-idle",
  status: "needs-human",
  needsYou: true,
  activity: "Waiting for a detailed response from the reviewer",
  subAgents: [],
} as unknown as ThreadView

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-8 text-fg max-[800px]:p-3">
      <aside className="w-[360px] max-w-full">
        <p className="mb-3 text-[11px] text-muted">The yellow reading-position rule spans the entire active row, including its wrapped title and subtitle.</p>
        <div data-sidebar-rail className="max-h-44 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-panel">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="px-1.5 py-1 text-[13px] leading-[19px] text-muted">Other sidebar thread {index + 1}</div>
          ))}
          <ThreadRow t={thread} active />
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index + 4} className="px-1.5 py-1 text-[13px] leading-[19px] text-muted">Other sidebar thread {index + 5}</div>
          ))}
        </div>
      </aside>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
)
