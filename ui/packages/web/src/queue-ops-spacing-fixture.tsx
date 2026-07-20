import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@fray-ui/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the vertical rhythm at the BOTTOM of a queue card: composer → BackgroundOpsStrip
// (⤷ SHELL rows) → ThreadLifecycleFooter. The maintainer read the gap under the prompt box as too
// large and the gap above the footer as too small; this fixture is the measuring surface.

const SLUG = "queue-ops-spacing-demo"

const messages: TranscriptMessage[] = [
  { role: "user", text: "Poll the panes and report what you find.", tools: [], parts: [{ kind: "text", text: "Poll the panes and report what you find." }] },
  {
    role: "assistant",
    text: "Three watchers are live; I'll fold their output in as they land.",
    tools: [],
    parts: [{ kind: "text", text: "Three watchers are live; I'll fold their output in as they land." }],
  },
]

const thread = {
  id: SLUG,
  title: "Ops-strip spacing",
  status: "active",
  mechanism: null,
  humanBlocked: false,
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
  // ?agents=1 puts live ↳ sub-agent lines directly above the ⤷ shell rows — the adjacency the
  // strip's pt-1.5 is matched to, and the only state where the two lists' rhythm can be compared.
  subAgents: new URLSearchParams(location.search).get("agents") === "1"
    ? [{ id: "agent-a", label: "Diff the queue card against the drawer footer", startedAt: "2026-07-18T09:05:00.000Z", state: "running" }]
    : [],
  // ?shells=0 is the CONTROL case: with no live ops the strip unmounts, so the composer must still
  // sit correctly above the lifecycle footer on the wrapper's own padding.
  bgShells: new URLSearchParams(location.search).get("shells") === "0" ? [] : [
    { label: "Poll panes for perm-prompt false positives", startedAt: "2026-07-18T09:06:00.000Z", state: "stale" },
    { label: "Poll panes for near-miss perm markers", startedAt: "2026-07-18T09:07:00.000Z", state: "running" },
    { label: "Record 5min of fray board SSE", startedAt: "2026-07-18T09:09:00.000Z", state: "running" },
  ],
  lastActivityAt: "2026-07-18T09:11:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/fray", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/rpc/threadTranscript" || url.pathname === "/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
      <TodosView />
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
