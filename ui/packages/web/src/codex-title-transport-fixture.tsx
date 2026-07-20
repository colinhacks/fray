import { createRoot } from "react-dom/client"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import "./styles.css"

// The server projection has already removed both pieces of Fray-only protocol: the appended dispatch
// reminder from the human bubble, and the first-final title comment from the assistant response.
const messages: ChatMessage[] = [
  { sourceId: "user", role: "user", text: "Briefly confirm the Codex title transport is active, then stop.", tools: [], parts: [] },
  { sourceId: "assistant", role: "assistant", text: "Confirmed: the title transport is active.", tools: [], parts: [] },
]

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto flex min-h-[440px] max-w-[720px] flex-col border border-border bg-panel px-5 py-4 shadow-xl shadow-black/30 sm:px-7">
        <header className="border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold text-fg">Codex Title Transport Active</h1>
          <p className="mt-0.5 text-[12px] text-muted">A compact title is stored without appearing in the conversation.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} />)}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
