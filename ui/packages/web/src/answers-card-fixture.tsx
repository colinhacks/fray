import { createRoot } from "react-dom/client"
import type { TranscriptMessage } from "@fray-ui/shared"
import { Message } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Isolated view of the AnswersCard — the card the queue/thread renders when the last user message is
// a multi-answer reply to a ```question ("Answers:\n1. …\n2. …"). Used to tune its visual weight.
const paired = [
  { n: 1, answer: "Use the neutral chip treatment", question: "How should the answer chip read against the settled card?" },
  { n: 2, answer: "Keep it quiet — reserve yellow for awaiting-you", question: "Where does the yellow accent belong?" },
]

const m = {
  sourceId: "u1",
  role: "user",
  text: "Answers:\n1. Use the neutral chip treatment\n2. Keep it quiet — reserve yellow for awaiting-you",
  tools: [],
  parts: [],
} as unknown as TranscriptMessage

function Fixture() {
  return (
    <div className="mx-auto my-8 flex w-[min(560px,calc(100%-32px))] flex-col gap-6">
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted/70">Answers card (thread width)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={m} paired={paired} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted/70">Answers card (dense / queue width)</div>
        <div className="flex w-[380px] flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={m} paired={paired} dense />
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
)
