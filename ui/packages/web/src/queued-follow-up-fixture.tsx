import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { ThreadActionBar } from "./components/ThreadActionBar.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA surface for the narrow Codex capability: the existing durable queue owns terminal
// delivery, so selectors stay fenced but the composer can append another safe follow-up.
const thread: ThreadView = {
  id: "queued-codex-follow-up",
  title: "Deliver queued Codex follow-up",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "running",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "codex",
  permissionMode: "default",
  runtimeControlPending: true,
  followUpQueueAvailable: true,
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

function Fixture() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-4 py-8">
      <section className="w-full rounded-lg border border-border bg-panel p-4 shadow-2xl">
        <p className="petite-caps text-[10px] text-accent">Codex queue delivery</p>
        <h1 className="mt-1 text-[16px] font-semibold">Append a follow-up while one is sending</h1>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">The terminal owner remains locked for profile and sandbox changes; a new follow-up is safely queued behind the first.</p>
        <ThreadActionBar slug={thread.id} />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>,
)
