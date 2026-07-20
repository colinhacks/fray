import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { Message } from "./components/ChatView.tsx"
import { useLiveAnswering } from "./lib/answering.ts"
import type { ChatMessage } from "./hooks.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the open-tail change: a ```question the agent BURIED (it kept working after asking,
// with no human turn in between) must stay answerable in the drawer thread view — interactive chips on
// an ask that is NOT the last message. Renders the real Message + useLiveAnswering(multiMessage) path.

const slug = "buried-question-thread"
const thread: ThreadView = {
  id: slug, title: "Set up the database layer", status: "active", mechanism: null, humanBlocked: false,
  ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "running",
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false,
  backend: "claude", permissionMode: "default", subAgents: [], bgShells: [],
}
store.board = { projectDir: "/fixture/fray", threads: [thread] } as BoardSnapshot

// A buried single-block ask: user request → the ask (sourceId "ask-db") → a LATER assistant work turn
// (no human turn between) that makes the ask non-live. Under multiMessage the ask stays answerable.
const asMsg = (m: Partial<ChatMessage> & { role: string; text: string }): ChatMessage => ({
  tools: [], parts: [{ kind: "text", text: m.text }], ...m,
} as ChatMessage)

// Two answerable questions: an OLD one with a HUMAN TURN after it (pure-minimal: still answerable — we
// track nothing), and a BURIED one the agent kept working past. Both must show interactive chips.
const messages: ChatMessage[] = [
  asMsg({ role: "user", text: "Set up the database layer." }),
  asMsg({
    role: "assistant", sourceId: "ask-orm",
    text: "First, a choice:\n\n```question\nWhich ORM should we use?\n- A. Drizzle\n- B. Prisma\n```",
  }),
  asMsg({ role: "user", text: "Let's nail down the engine before the ORM." }),
  asMsg({
    role: "assistant", sourceId: "ask-db",
    text: "Sure — the engine call:\n\n```question\nWhich database should the layer target?\n- A. Postgres\n- B. SQLite\nRecommendation: A — matches prod.\n```",
  }),
  asMsg({ role: "assistant", sourceId: "work-1", text: "Meanwhile I wired up the migrations runner and a connection pool stub so we're ready either way." }),
]

// Capture the composed wire text the Send path produces, so QA can read the EXACT bytes.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), window.location.origin)
  if (url.pathname === "/rpc/followUp") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const node = document.querySelector("[data-sent-wire]")
    if (node) node.textContent = body.message
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/rpc/markRead") return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function Fixture() {
  // Per-message answering: each buried/open ask renders its OWN bottom Send button (Message's
  // showSendButton), scoped to just that message's blocks — no thread-level Send anymore.
  const { answeringForMessage } = useLiveAnswering(slug, messages, undefined, { multiMessage: true })
  const [width, setWidth] = useState(720)
  return (
    <main className="mx-auto min-h-screen w-full px-4 py-8">
      <div className="mx-auto mb-4 flex max-w-2xl items-center gap-3">
        <p className="petite-caps text-[10px] text-accent">Buried-question answerability</p>
        <button data-narrow onClick={() => setWidth((w) => (w === 720 ? 380 : 720))} className="rounded border border-border px-2 py-1 text-[11px]">
          Toggle width ({width}px)
        </button>
      </div>
      <section style={{ width }} className="mx-auto rounded-lg border border-border bg-panel p-5 shadow-2xl">
        <div className="flex flex-col gap-3.5">
          {messages.map((m, i) => (
            <Message key={i} m={m} answering={answeringForMessage(m)} showSendButton paired={null} />
          ))}
        </div>
        <div className="mt-4 border-t border-border pt-3">
          <p className="petite-caps text-[10px] text-muted">Composed wire text on send:</p>
          <pre data-sent-wire className="mt-1 whitespace-pre-wrap text-[12px] text-accent">(nothing sent yet)</pre>
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
)
