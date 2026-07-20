import { useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { activeSidebarSection, type SidebarSectionGeometry } from "./lib/sidebarScrollspy.ts"
import "./styles.css"

const threads = [
  { id: "long-card", kind: "session", title: "Long queue card above", backend: "codex", runtime: "turn-idle", status: "needs-human", needsYou: true, subAgents: [] },
  { id: "short-final-card", kind: "session", title: "Short final queue card at document bottom", backend: "codex", runtime: "turn-idle", status: "needs-human", needsYou: true, subAgents: [] },
] as unknown as ThreadView[]

function Fixture() {
  const [activeId, setActiveId] = useState<string | null>(null)
  const sync = useCallback(() => {
    const cards = [...document.querySelectorAll<HTMLElement>("[data-queue-card]")]
      .map((card) => {
        const id = card.dataset.queueCard
        if (!id) return null
        const { top, bottom } = card.getBoundingClientRect()
        return { id, top, bottom } satisfies SidebarSectionGeometry
      })
      .filter((card): card is SidebarSectionGeometry => card !== null)
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const next = activeSidebarSection(cards, undefined, maxScrollY > 0 && window.scrollY >= maxScrollY - 1)
    setActiveId((current) => current === next ? current : next)
  }, [])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(sync)
    }
    schedule()
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [sync])

  return (
    <main className="min-h-[1500px] bg-bg p-5 pl-[410px] text-fg max-[800px]:p-3 max-[800px]:pt-40">
      <aside className="fixed left-5 top-5 z-10 w-[360px] rounded-lg border border-border bg-panel p-2 shadow-lg max-[800px]:left-3 max-[800px]:right-3 max-[800px]:w-auto">
        <p className="mb-2 text-[11px] text-muted">At true document bottom, the final visible card owns the yellow full-row reading rail.</p>
        {threads.map((thread) => <ThreadRow key={thread.id} t={thread} active={activeId === thread.id} />)}
      </aside>
      <section data-queue-card="long-card" className="mx-auto min-h-[900px] max-w-2xl rounded-xl border border-border bg-panel p-5">
        Long queue card. Scroll to the actual document bottom.
      </section>
      <section data-queue-card="short-final-card" className="mx-auto mt-10 max-w-2xl rounded-xl border-2 border-accent bg-panel p-5">
        Short final queue card — its top cannot reach 12px before the document stops.
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<TooltipProvider><Fixture /></TooltipProvider>)
