import { useState } from "react"
import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

const clicked = {
  id: "queue-457",
  kind: "session",
  title: "#457: This card must become the current reading position",
  backend: "codex",
  runtime: "turn-idle",
  status: "needs-human",
  needsYou: true,
  subAgents: [],
} as unknown as ThreadView

store.board = { threads: [clicked] } as typeof store.board
store.drawers = []

function Fixture() {
  const snap = useSnapshot(store)
  const [activeId, setActiveId] = useState("queue-451")
  return (
    <main className="min-h-[1800px] bg-bg p-4 pb-[1000px] text-fg">
      <aside className="sticky top-0 z-10 w-[360px] max-w-full rounded-lg border border-border bg-panel p-2 shadow-lg">
        <p className="mb-2 text-[11px] text-muted">Click #457. Its card lands at the 12px reading line and NO drawer opens (queued rows just scroll).</p>
        <ThreadRow t={clicked} active={activeId === clicked.id} onQueueNavigate={setActiveId} />
      </aside>
      <section className="mx-auto mt-[700px] max-w-2xl" data-queue-card="queue-451" data-queue-leaving="false">
        <div className="rounded-xl border border-border bg-panel p-5">#451: previous card (the old, incorrect reading position)</div>
      </section>
      <section className="mx-auto mt-48 max-w-2xl" data-queue-card="queue-457" data-queue-leaving="false">
        <div data-queue-card-root="queue-457" className="rounded-xl border-2 border-accent bg-panel p-5">
          #457: selected queue card — this outer border should sit 12px below the viewport top.
        </div>
      </section>
      {snap.drawers.length > 0 && (
        <aside data-fixture-thread-drawer className="fixed inset-y-4 right-4 w-72 rounded-xl border border-accent bg-panel p-4 shadow-2xl">
          Thread drawer open: {snap.drawers.length} layer
        </aside>
      )}
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
)
