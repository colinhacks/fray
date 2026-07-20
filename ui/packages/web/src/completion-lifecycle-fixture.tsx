import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadLifecycleFooter } from "./components/ThreadLifecycleFooter.tsx"
import "./styles.css"

const mode = new URLSearchParams(window.location.search).get("mode") === "executing" ? "executing" : "resting"
const nativeFetch = window.fetch.bind(window)
const rpcResult = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "content-type": "application/json", "x-fray-boot": "completion-lifecycle-fixture" },
})

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname === "/rpc/completeThread") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { terminateLive?: boolean }
    window.dispatchEvent(new CustomEvent("fixture-complete", { detail: body }))
    return rpcResult({ needsConfirmation: mode === "executing" && body.terminateLive !== true })
  }
  return nativeFetch(input, init)
}

const thread: ThreadView = {
  id: "completion-lifecycle-fixture",
  title: mode === "executing" ? "Actively analyzing a regression" : "Resting provider session",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: mode === "executing" ? "running" : "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [],
  bgShells: [],
}

function Fixture() {
  const [calls, setCalls] = useState<string[]>([])
  const [done, setDone] = useState(false)
  useEffect(() => {
    const onComplete = ((event: CustomEvent<{ terminateLive?: boolean }>) => {
      setCalls((prior) => [...prior, event.detail.terminateLive ? "terminate" : "initial"])
    }) as EventListener
    window.addEventListener("fixture-complete", onComplete)
    return () => window.removeEventListener("fixture-complete", onComplete)
  }, [])
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8">
      <section className="w-full overflow-hidden rounded-xl border border-border bg-panel shadow-2xl">
        <div className="border-b border-border px-4 py-4">
          <p className="petite-caps text-[10px] text-accent">Mark as done behavior</p>
          <h1 className="mt-1 text-[16px] font-semibold text-fg">{thread.title}</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {mode === "executing" ? "The server reports an executing turn." : "The server reports a live but resting turn."}
          </p>
          <p data-fixture-complete-calls className="mt-3 text-[11px] text-muted">RPC calls: {calls.join(", ") || "none"}</p>
          {done && <p data-fixture-done className="mt-1 text-[11px] text-accent">Done applied</p>}
        </div>
        <ThreadLifecycleFooter thread={thread} onArchived={() => setDone(true)} />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
