import { createElement } from "react"
import { createRoot } from "react-dom/client"
import type { ThreadView } from "@fray-ui/shared"
import "./styles.css"
import { Message } from "./components/ChatView.tsx"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"

const tomorrowAtNine = new Date()
tomorrowAtNine.setDate(tomorrowAtNine.getDate() + 1)
tomorrowAtNine.setHours(21, 0, 0, 0)
const timer = tomorrowAtNine.toISOString()
const awaiting = `Waiting for the scheduled review.\n\n\`\`\`awaiting\nThe next check is scheduled automatically.\ntimer: ${timer}\n\`\`\``

const thread = {
  id: "scheduled-review",
  kind: "session",
  title: "Scheduled review",
  status: "blocked",
  runtime: "turn-idle",
  state: "active",
  mechanism: "timer",
  needsYou: false,
  lastFence: { kind: "awaiting", body: "The next check is scheduled automatically.", hint: { kind: "timer", value: timer } },
  awaitingWaitConfirmed: true,
} as unknown as ThreadView

function Surface({ title, dense }: { title: string; dense?: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-panel p-4 shadow-sm">
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</h2>
      <Message m={{ role: "assistant", text: awaiting, tools: [], parts: [{ kind: "text", text: awaiting }] }} dense={dense} />
    </section>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="mx-auto grid max-w-5xl gap-5 p-6 text-fg">
      <h1 className="text-lg font-semibold">Timer label surfaces</h1>
      <div className="grid gap-5 md:grid-cols-2">
        <Surface title="Queue card" dense />
        <Surface title="Thread drawer" />
      </div>
      <section className="max-w-md rounded-xl border border-border bg-panel p-4 shadow-sm">
        <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">Sidebar</h2>
        <ThreadRow t={thread} />
      </section>
    </main>
  </TooltipProvider>,
)
