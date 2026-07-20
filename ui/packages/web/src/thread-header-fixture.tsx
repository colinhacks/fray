import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as RadixTabs from "@radix-ui/react-tabs"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { ThreadHeader } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

const base = {
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  spawnedAt: "2026-07-14T14:30:00.000Z",
  lastActivityAt: "2026-07-14T15:15:00.000Z",
} as const

const claudeThread = {
  ...base,
  id: "claude-header-fixture",
  title: "Source maps",
  backend: "claude",
  runtime: "turn-idle",
} as unknown as ThreadView

const codexThread = {
  ...base,
  id: "codex-header-fixture",
  title: "Implement the durable title protocol for new Codex sessions",
  backend: "codex",
  runtime: "exited",
} as unknown as ThreadView

store.board = { projectDir: "/fixture", threads: [claudeThread, codexThread] } as BoardSnapshot

function HeaderFixture({ slug }: { slug: string }) {
  return (
    <RadixTabs.Root value="chat" className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader slug={slug} tab="chat" onStatusApplied={() => {}} onClose={() => {}} />
      <div className="flex min-h-28 flex-1 items-center justify-center px-5 text-center text-[12px] text-muted">
        Drawer body — title controls remain in the header title line.
      </div>
    </RadixTabs.Root>
  )
}

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <div className="mx-auto grid max-w-[900px] gap-6">
        <section className="overflow-hidden border border-border bg-panel shadow-xl shadow-black/30">
          <p className="border-b border-border px-3 py-2 text-[11px] text-muted">Claude idle — click the title itself to edit; no manual-title icon</p>
          <HeaderFixture slug={claudeThread.id} />
        </section>
        <section className="overflow-hidden border border-border bg-panel shadow-xl shadow-black/30">
          <p className="border-b border-border px-3 py-2 text-[11px] text-muted">Codex exited — long title truncation and direct title editing</p>
          <HeaderFixture slug={codexThread.id} />
        </section>
      </div>
    </main>
  )
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
