import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import "./styles.css"

// Codex model-reasoning rendering (the `reasoning` message kind). The summary text is a REAL capture
// from `codex exec -c model_reasoning_summary=detailed`: a turn's reasoning is a SEQUENCE of short
// `**bold header**` steps, coalesced by the server into one block. This fixture renders the SAME
// reasoning twice — the first left collapsed, the second auto-expanded on mount — so one screenshot
// shows both states and the full train of thought.
const REASON_SHORT = "**Recalling Rayleigh scattering**"
const REASON_FULL = [
  "**Planning the cache design and audit**",
  "**Listing workspace files with ripgrep**",
  "**Inspecting the resolver function's output**",
  "**Identifying the evaluation harness behavior**",
  "**Outlining key design decisions**",
  "**Detailing cache eviction and key normalization**",
  "**Planning comprehensive cache tests**",
  "**Recommending a caller-owned bounded cache**",
].join("\n\n")

const messages: ChatMessage[] = [
  { sourceId: "u1", role: "user", text: "Why is the sky blue?", tools: [], parts: [] },
  { sourceId: "r1", role: "assistant", kind: "reasoning", text: REASON_SHORT, durationMs: 8_000, tools: [], parts: [] },
  { sourceId: "a1", role: "assistant", text: "Rayleigh scattering makes shorter (blue) wavelengths scatter more, so the sky reads blue.", tools: [], parts: [] },
  { sourceId: "u2", role: "user", text: "Now plan an LRU cache for the resolver.", tools: [], parts: [] },
  { sourceId: "r2", role: "assistant", kind: "reasoning", text: REASON_FULL, durationMs: 47_000, tools: [], parts: [] },
  { sourceId: "a2", role: "assistant", text: "Recommend a caller-owned bounded cache keyed on the normalized id, with a regression test for the empty-input path.", tools: [], parts: [] },
]

function Fixture() {
  useEffect(() => {
    // Auto-expand the SECOND reasoning block so the single screenshot captures collapsed + expanded.
    const btns = document.querySelectorAll<HTMLButtonElement>('button[aria-label*="model reasoning"]')
    btns[1]?.click()
  }, [])
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto flex min-h-[440px] max-w-[720px] flex-col border border-border bg-panel px-5 py-4 shadow-xl shadow-black/30 sm:px-7">
        <header className="border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold text-fg">Codex reasoning — collapsed &amp; expanded</h1>
          <p className="mt-0.5 text-[12px] text-muted">The first block stays collapsed; the second is expanded.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} />)}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
