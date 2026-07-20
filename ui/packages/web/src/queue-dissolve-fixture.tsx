import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@fray-ui/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the DISSOLVE-in-place queue-card collapse: resolving a card (Mark as done) dissolves it
// with blur+scale (receding from centre) while its height closes and the cards below rise into the freed
// space. The queue does NO programmatic scrolling — the viewport stays put; native scroll anchoring holds
// visible content steady when the collapse happens off-screen.
//   Four tall needs-human cards so the page scrolls; the divider between cards collapses with the card.

const longReply = (n: number) =>
  Array.from({ length: 6 }, (_, i) =>
    `**Step ${i + 1}.** Card ${n}: agent output, realistic triage-card length. The page scrolls across the four cards so a mid-queue resolve has room above it. Lorem ipsum dolor sit amet.`,
  ).join("\n\n")

const CARDS = [
  { id: "auth-refresh", title: "Silent token refresh on 401" },
  { id: "csv-export", title: "Streaming CSV export for large tables" },
  { id: "flaky-e2e", title: "Flaky checkout e2e in CI" },
  { id: "dark-mode", title: "Persist theme preference across devices" },
]

function makeThread(id: string, title: string): ThreadViewModel {
  return {
    id,
    title,
    status: "needs-human",
    statusText: "Waiting on your call",
    mechanism: null,
    humanBlocked: true,
    needsYou: true,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "idle",
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
    lastActivityAt: new Date().toISOString(),
    spawnedAt: new Date().toISOString(),
  } as unknown as ThreadViewModel
}

const threads = CARDS.map((c) => makeThread(c.id, c.title))
store.board = { projectDir: "/fixture/fray", threads } as BoardSnapshot

function transcriptFor(slug: string, title: string): { messages: TranscriptMessage[]; transcriptKey: string; hasEarlier: boolean; historyLoaded: boolean } {
  const n = CARDS.findIndex((c) => c.id === slug) + 1
  const messages: TranscriptMessage[] = [
    { sourceId: `${slug}-u1`, role: "user", text: `Please handle: ${title}.`, tools: [], parts: [] },
    { sourceId: `${slug}-a1`, role: "assistant", text: longReply(n), tools: [], parts: [{ kind: "text", text: longReply(n) }] },
  ]
  return { messages, transcriptKey: `${slug}-key`, hasEarlier: false, historyLoaded: false }
}

// Pull the slug out of an RPC request body so each card gets its own transcript.
function slugFromBody(init?: RequestInit): string | null {
  try {
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
    const slug = slugFromBody(init) ?? CARDS[0].id
    const card = CARDS.find((c) => c.id === slug) ?? CARDS[0]
    return new Response(JSON.stringify({ result: transcriptFor(card.id, card.title) }), { headers: { "content-type": "application/json" } })
  }
  // Mark-as-done goes through completeThread; it must return a non-null object (needsConfirmation:false)
  // so the footer fires onArchived → onResolve → the card dissolves. FAITHFUL to production: the server's
  // handler calls ctx.board.refresh() SYNCHRONOUSLY (board.ts publish()), so the resolved thread is
  // dropped from the board at essentially the same instant the RPC returns. We model that here by pruning
  // the thread from store.board — the card must STILL dissolve fully even though the board drops it (the
  // exit is decoupled from the board push in TodosView). Without that decoupling the card unmounts
  // instantly and no animation plays.
  if (url.pathname === "/rpc/completeThread") {
    const slug = slugFromBody(init)
    if (slug && store.board) {
      store.board = { ...store.board, threads: store.board.threads.filter((t) => t.id !== slug) } as BoardSnapshot
    }
    return new Response(JSON.stringify({ result: { needsConfirmation: false } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

// Mirror App's <main> so page-scroll + my-auto centering behave exactly as production.
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
