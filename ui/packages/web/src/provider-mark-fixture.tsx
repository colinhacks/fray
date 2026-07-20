import { createRoot } from "react-dom/client"
import { ProviderMark } from "./components/ProviderMark.tsx"
import "./styles.css"

function SidebarTitle({ backend, children }: { backend: "claude" | "codex"; children: string }) {
  return (
    <div className="break-words text-[13px] leading-[19px] text-fg/90">
      {children}
      <ProviderMark backend={backend} className="ml-1" />
    </div>
  )
}

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto max-w-[680px] space-y-6 rounded-lg border border-border bg-panel p-4 shadow-xl shadow-black/30">
        <div>
          <p className="mb-2 text-[11px] text-muted">Sidebar/list title marks</p>
          <div className="space-y-2 rounded-md bg-panel-2 p-3">
            <SidebarTitle backend="claude">Investigate source maps and preserve the first useful human title</SidebarTitle>
            <SidebarTitle backend="codex">Implement the durable title protocol for new Codex sessions</SidebarTitle>
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] text-muted">Queue-card and drawer headers intentionally have no provider mark</p>
          <div className="rounded-md border border-border px-4 py-3 font-semibold text-[15px] leading-snug text-fg">
            Investigate permissions sidebar placement
          </div>
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
