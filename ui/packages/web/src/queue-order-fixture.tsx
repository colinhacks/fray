import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@fray-ui/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the NO-priority-band queue (maintainer 2026-07-21: the hidden hard-attention band was
// "too confusing" — removed). The queue is now ONE strict last-active order. This fixture proves the
// behavioural consequence visually: a FRESH crash (most urgent) sinks BELOW an OLDER done handoff, because
// order is age alone. Three queued cards, oldest→newest = done → question → crash. FIFO (default) must
// render them top-to-bottom in that exact age order, urgency notwithstanding.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const DAY = 24 * 60 * MIN

type Seed = { id: string; title: string; at: number; extra: Partial<ThreadViewModel> }
const SEEDS: Seed[] = [
  { id: "oldest-done", title: "① Oldest · done handoff · 5d ago", at: 5 * DAY, extra: { runtime: "turn-idle", lastFence: { kind: "done", body: "Shipped the fix." } } },
  { id: "middle-question", title: "② Middle · question · 3d ago", at: 3 * DAY, extra: { runtime: "turn-idle", pendingQuestion: true } },
  { id: "newest-crash", title: "③ Newest · CRASH · 40m ago", at: 40 * MIN, extra: { runtime: "exited", crashed: true } },
]

function makeThread({ id, title, at, extra }: Seed): ThreadViewModel {
  return {
    id,
    title,
    status: "active",
    statusText: "Waiting on your call",
    mechanism: null,
    humanBlocked: false,
    needsYou: true,
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
    backend: "claude",
    permissionMode: "default",
    subAgents: [],
    bgShells: [],
    lastUserAt: ago(at),
    lastActivityAt: ago(at),
    spawnedAt: ago(at),
    ...extra,
  } as unknown as ThreadViewModel
}

const threads = SEEDS.map(makeThread)
store.board = { projectDir: "/fixture/fray", threads } as BoardSnapshot

// Each card pulls its own short transcript; everything else is a benign empty RPC (no real server here).
// Queries carry their input in the `?input=` query param (GET) — see api/rpc.ts — not a POST body.
function slugFromReq(url: URL, init?: RequestInit): string | null {
  try {
    const q = url.searchParams.get("input")
    if (q) return JSON.parse(q)?.slug ?? null
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    return body?.slug ?? body?.params?.slug ?? null
  } catch {
    return null
  }
}
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/rpc/threadTranscript" || url.pathname === "/rpc/threadTranscriptEarlier") {
    const slug = slugFromReq(url, init) ?? SEEDS[0].id
    const seed = SEEDS.find((s) => s.id === slug) ?? SEEDS[0]
    const messages: TranscriptMessage[] = [
      { sourceId: `${seed.id}-u1`, role: "user", text: `Handle: ${seed.title}.`, tools: [], parts: [] },
      { sourceId: `${seed.id}-a1`, role: "assistant", text: seed.title, tools: [], parts: [{ kind: "text", text: seed.title }] },
    ]
    return new Response(JSON.stringify({ result: { messages, transcriptKey: `${seed.id}-key`, hasEarlier: false, historyLoaded: true } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

// Mirror App's <main> so the queue lays out exactly as production.
function Fixture() {
  return (
    <div className="relative min-h-screen bg-bg text-fg text-sm">
      <div className="flex min-h-screen justify-center">
        <main className="w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 min-h-screen max-[800px]:w-full max-[800px]:max-w-none">
          <TodosView />
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
