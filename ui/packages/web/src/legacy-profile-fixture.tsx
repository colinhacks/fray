import { createRoot } from "react-dom/client"
import { useState } from "react"
import { ProfileGridSelector } from "./components/ProfileGridSelector.tsx"
import "./styles.css"

const groups = [{
  id: "claude",
  label: "Claude Code",
  options: [{ model: "opus", label: "Opus", defaultEffort: "max", efforts: ["high", "max"] }],
}]

function Fixture() {
  const [profile, setProfile] = useState({ provider: "claude", model: "opus" })
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <section className="w-[min(420px,100%)] rounded-lg border border-border bg-panel p-5 shadow-xl">
        <p className="mb-2 text-[11px] text-muted">Historical Claude session</p>
        <h1 className="mb-4 text-[15px] font-semibold text-fg">Resolved model; launch effort unavailable</h1>
        <ProfileGridSelector
          groups={groups}
          value={profile}
          onValueChange={setProfile}
          ariaLabel="Thread model and effort"
          menuAriaLabel="Choose Claude model and effort"
          className="w-full"
        />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
