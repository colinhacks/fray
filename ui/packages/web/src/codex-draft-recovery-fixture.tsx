import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { useThreadComposerControls } from "./hooks/useThreadComposerControls.tsx"
import { store } from "./store.ts"
import "./styles.css"

const thread: ThreadView = {
  id: "codex-draft-recovery-fixture",
  title: "Queued follow-up pending",
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
  backend: "codex",
  permissionMode: "default",
  // The durable machine signal must not surface recovery buttons or implementation detail.
  controlError: "fray-steer-failed:fixture-delivery-id",
  queuedInputCount: 1,
  subAgents: [],
  bgShells: [],
}

store.board = { projectDir: "/fixture/fray", threads: [thread] } as BoardSnapshot

const originalFetch = window.fetch
window.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname.endsWith("/threadProfileOptions")) {
    return new Response(JSON.stringify({ result: { backend: "codex", options: [{ model: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["medium", "high"] }] } }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input)
}

function RecoveryFixture() {
  const { status } = useThreadComposerControls(thread.id)
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-4 py-8">
      <section className="w-full rounded-lg border border-border bg-panel p-4 shadow-2xl">
        <p className="petite-caps text-[10px] text-accent">Codex follow-up fixture</p>
        <h1 className="mt-1 text-[16px] font-semibold">Queued follow-up pending</h1>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">A queued message remains unobtrusive while Codex accepts it.</p>
        {status}
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}><RecoveryFixture /></QueryClientProvider>,
)
