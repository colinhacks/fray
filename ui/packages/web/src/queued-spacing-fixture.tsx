import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@fray-ui/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for inter-QUEUED-message spacing: two successive queued (optimistic) user bubbles must
// carry the same STEP rhythm as any other pair of messages. Both surfaces that render the queued tail
// are mounted — the drawer (ThreadView/ChatView) and the queue card (TodosView) — because the pinned
// queued group is built separately in each.

const SLUG = "queued-spacing"
const PARAMS = new URLSearchParams(location.search)
const QUEUED = PARAMS.get("queued") !== "0"
const INTERLEAVE = PARAMS.get("interleave") === "1"

const thread = {
  id: SLUG,
  title: "Spacing between successive queued messages",
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
  runtime: "running",
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
  lastActivityAt: "2026-07-18T10:00:00.000Z",
  spawnedAt: "2026-07-18T09:00:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/fray", threads: [thread] } as BoardSnapshot

const messages: TranscriptMessage[] = [
  { sourceId: "u1", role: "user", text: "Look at the queued-message spacing.", tools: [], parts: [] },
  {
    sourceId: "a1",
    role: "assistant",
    text: "On it — reproducing the queued tail now.",
    tools: [],
    parts: [{ kind: "text", text: "On it — reproducing the queued tail now." }],
  },
  // The queued TAIL: three successive optimistic sends, the case in the report. ?queued=0 drops it
  // entirely — the no-regression control for the always-rendered queued GROUP wrapper, which must add
  // no height and no stray gap when nothing is queued.
  ...(QUEUED
    ? ([
        { sourceId: "q1", role: "user", text: "and  what's the fic", tools: [], parts: [], queued: true },
        // A message that RENDERS NOTHING between two queued sends: the queued pass skips it, so the old
        // "previous array element is queued" margin test failed and the two bubbles butted together.
        ...(INTERLEAVE ? [{ sourceId: "ev1", role: "assistant", kind: "event", text: "", tools: [], parts: [] }] : []),
        { sourceId: "q2", role: "user", text: "fix", tools: [], parts: [], queued: true },
        {
          sourceId: "q3",
          role: "user",
          text: "third one, deliberately long enough to wrap onto a second line so the multi-line case is covered too",
          tools: [],
          parts: [],
          queued: true,
        },
      ] as unknown as TranscriptMessage[])
    : []),
] as unknown as TranscriptMessage[]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/rpc/threadTranscript" || url.pathname === "/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

// ?surface=drawer renders the thread drawer; default renders the queue card. Both are the REAL
// components, so whichever surface drops the gap shows it here.
const surface = PARAMS.get("surface") ?? "card"

function Fixture() {
  if (surface === "drawer") {
    return (
      <div className="relative h-screen bg-bg text-fg text-sm">
        <div className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border">
          <ThreadView slug={SLUG} tab="chat" onTab={() => {}} />
        </div>
      </div>
    )
  }
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
