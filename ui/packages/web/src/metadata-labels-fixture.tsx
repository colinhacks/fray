import { createRoot } from "react-dom/client"
import type { ChatMessage } from "./hooks.ts"
import { Message, VSpace } from "./components/ChatView.tsx"
import "./styles.css"

const toolMessage: ChatMessage = {
  sourceId: "tools",
  role: "assistant",
  text: "",
  tools: [],
  parts: [
    {
      kind: "tools",
      tools: [
        { name: "Bash", detail: "Find tool call components" },
        { name: "Read", detail: "ui/packages/web/src/components/ChatView.tsx" },
        { name: "Grep", detail: "Thought for" },
        { name: "Read", detail: "ui/packages/web/src/styles.css" },
        { name: "Bash", detail: "Run focused tests" },
      ],
    },
  ],
}

const thoughtMessage: ChatMessage = {
  sourceId: "thought",
  role: "assistant",
  kind: "event",
  text: "Thought for 28s",
  tools: [],
  parts: [],
}

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 text-fg sm:p-8">
      <section className="mx-auto max-w-[720px] rounded-lg border border-border bg-panel px-5 py-5 shadow-xl shadow-black/30 sm:px-7">
        <header className="mb-5 border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold">Transcript metadata labels</h1>
          <p className="mt-0.5 text-[12px] text-muted">Compare the collapsed tool summary with the thought event label.</p>
        </header>
        <Message m={toolMessage} />
        <VSpace />
        <Message m={thoughtMessage} />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
