import { createRoot } from "react-dom/client"
import { useState } from "react"
import { Select } from "./components/ui/Select.tsx"
import "./styles.css"

const OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "workspace", label: "Workspace-write" },
  { value: "full", label: "Full access" },
]

function PermissionPicker({ ariaLabel, side = "bottom" }: { ariaLabel: string; side?: "top" | "bottom" }) {
  const [value, setValue] = useState("full")
  return <Select variant="readout" value={value} onValueChange={setValue} options={OPTIONS} ariaLabel={ariaLabel} side={side} className="px-1.5 py-0.5 text-fg/80" />
}

function Fixture() {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="flex min-h-screen justify-center gap-13 px-8 max-[800px]:flex-col max-[800px]:gap-0 max-[800px]:px-3">
        <aside className="sticky top-0 self-start flex h-screen w-[min(34vw,420px)] shrink-0 flex-col justify-center max-[800px]:static max-[800px]:h-auto max-[800px]:w-full max-[800px]:justify-start max-[800px]:pt-6">
          <div className="max-h-[calc(100vh-32px)] overflow-hidden rounded-xl border border-border bg-panel p-4 shadow-2xl shadow-black/20">
            <p className="text-[11px] text-muted">Sticky sidebar prompt</p>
            <h1 className="mt-1 text-[15px] font-semibold">New task</h1>
            <textarea className="mt-4 min-h-24 w-full resize-none rounded-lg border border-border bg-bg p-3 text-[13px] outline-none" defaultValue="Opening permissions must not move this sticky sidebar." />
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] text-muted">Sandbox</span>
              <PermissionPicker ariaLabel="Sidebar sandbox" />
            </div>
          </div>
        </aside>
        <main className="w-[720px] max-w-[62vw] min-w-0 py-12 max-[800px]:w-full max-[800px]:max-w-none">
          <section className="rounded-xl border border-border bg-panel p-5 text-[13px] leading-relaxed text-muted">
            <p className="text-[11px] text-muted">Queue content</p>
            <h2 className="mt-1 text-[16px] font-semibold text-fg">Scroll to a thread composer</h2>
            {Array.from({ length: 20 }, (_, index) => <p key={index} className="mt-4">Long queue content keeps document scroll nonzero before the thread permission picker opens.</p>)}
          </section>
          <section className="my-10 rounded-xl border border-border bg-panel p-5">
            <p className="text-[11px] text-muted">Thread composer</p>
            <textarea className="mt-3 min-h-28 w-full resize-none rounded-lg border border-border bg-bg p-3 text-[13px] outline-none" defaultValue="Thread reply at a nonzero document scroll position." />
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] text-muted">Permission</span>
              <PermissionPicker ariaLabel="Thread sandbox" side="top" />
            </div>
          </section>
          <section className="rounded-xl border border-border bg-panel p-5 text-[13px] leading-relaxed text-muted">
            {Array.from({ length: 24 }, (_, index) => <p key={index} className="mt-4">Additional transcript content preserves a long document after the composer.</p>)}
          </section>
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
