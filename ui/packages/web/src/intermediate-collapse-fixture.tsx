import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage, TranscriptToolCall } from "@fray-ui/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the higher-level "intermediate logs collapse" in the queue card (QCard). The card shows
// the TEXT ONLY of the agent's first and last messages; EVERYTHING between their prose — the fully-hidden
// middle messages AND the tool calls batched into the first/last messages themselves — collapses behind
// ONE summary bar with a stacked-chevron (ChevronsUpDown) expand glyph. So the card reads: pinned ask →
// first message's narration (text only) → collapse bar → final message (text only). Clicking is one-way:
// the full log (all tool bands restored) renders and the bar unmounts.
//   ?variant=heavy   (default) a user ask + an opening narration (WITH batched tools) + several tool-heavy
//                    intermediate steps + a final question. First message's tools must fold into the bar.
//   ?variant=single  user ask + ONE assistant reply (no middle → NO collapse bar, control case)
//   ?variant=notools user ask + a couple of prose-only intermediate steps (bar shows "N steps", no tools)
//   ?variant=batchedends  user ask + first(narration + tools) + ONE middle step + final(summary text + a
//                         trailing tool). BOTH ends' tools fold into the bar; both texts show tool-free.
//   ?variant=questionthentool  user ask + narration + a FINAL question + a trailing TOOLS-ONLY message.
//                         Regression guard: the final-text anchor stays on the question (chips stay live);
//                         the text-less tool message must NOT steal the anchor and hide the question.
//   ?variant=trailingevent  user ask + intermediate steps + a FINAL question, then a sub-agent completion
//                           event AFTER it. Regression guard: the question (with answer chips) must stay
//                           visible — a trailing event must NOT pull it into the collapsed range.
const params = new URLSearchParams(location.search)
const variant = params.get("variant") ?? "heavy"

const SLUG = "intermediate-collapse-demo"

const tool = (name: string, over: Partial<TranscriptToolCall> = {}): TranscriptToolCall => ({
  name,
  status: "completed",
  ...over,
})

const asst = (text: string, tools: TranscriptToolCall[] = []): TranscriptMessage => ({
  role: "assistant",
  text,
  tools,
  parts: [
    ...(tools.length ? [{ kind: "tools" as const, tools }] : []),
    ...(text ? [{ kind: "text" as const, text }] : []),
  ],
})

const event = (text: string): TranscriptMessage => ({ role: "assistant", kind: "event", text, tools: [], parts: [] })

// A real ```question block so the queue card renders answer chips + the "Send answers" flow — this is
// what the trailing-event regression must not hide.
const finalQuestion = [
  "```question",
  "I've added the collapse bar. Which label reads best?",
  "",
  "- A. **`11 tool calls · 3 steps`** — combined (current default).",
  "- B. Just **`11 tool calls`** — leaner.",
  "",
  "Recommendation: **A** — the step count adds useful context.",
  "```",
].join("\n")

let counter = 0
const withId = (m: TranscriptMessage): TranscriptMessage => ({ ...m, sourceId: `m${counter++}` })

const heavy: TranscriptMessage[] = [
  { sourceId: "u-old", role: "user", text: "An earlier ask from a previous turn.", tools: [], parts: [] },
  withId(asst("Done with that earlier one.")),
  { sourceId: "u-cur", role: "user", text: "Add a collapsed-by-default view for the intermediate agent logs in the queue card, and wire up a one-way expand.", tools: [], parts: [] },
  // --- intermediate run: several tool-heavy assistant steps + chatter ---
  withId(asst("Let me find the queue card renderer and understand how it windows the transcript.", [
    tool("Grep", { detail: "QCard|QueueCard|renderCard" }),
    tool("Read", { detail: "components/TodosView.tsx", read: "…740 lines…" }),
  ])),
  withId(asst("I'll check how tool-call collapsing works today so the new one is clearly higher-level.", [
    tool("Read", { detail: "components/ChatView.tsx" }),
    tool("Grep", { detail: "collapseTools|ToolCalls" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck the web package" }),
  ])),
  withId(asst("Now editing the render loop to inject the summary bar and gate it on the middle range.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Re-typecheck after edits" }),
    tool("Bash", { detail: "npx tsx --test packages/web/src/**/*.test.ts", desc: "Run web tests" }),
  ])),
  withId(asst("Verified the counts line up with what the loop skips (queued + render-nothing messages).", [
    tool("Read", { detail: "packages/shared/src/index.ts" }),
  ])),
  // --- final standing message (always shown in full) ---
  withId(asst(finalQuestion)),
]

// Same as heavy, but a sub-agent completion EVENT lands in the JSONL AFTER the final question — the
// exact sequence that (pre-fix) pulled the question into the collapsed range and disabled answering.
const trailingevent: TranscriptMessage[] = [
  ...heavy,
  withId(event('Agent "reviewer" finished — 5m')),
]

const single: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Quick one — what's the current default label?", tools: [], parts: [] },
  withId(asst("It's the combined `N tool calls · M steps` form. Nothing intermediate here, so no collapse bar should appear.")),
]

const notools: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Summarize the trade-offs before you build anything.", tools: [], parts: [] },
  withId(asst("First, the collapse is one-way by design, so we avoid re-collapse jank.")),
  withId(asst("Second, it keys off the pinned ask and the final message, so loaded-earlier history is untouched.")),
  withId(asst("So — proceed with the one-way collapse? That's my recommendation.")),
]

// Tools batched into BOTH the first and the last agent message. The final message is a normal summary
// (not a question) with a trailing tool call. After collapse: first + last show text only, and the bar
// counts every tool across the span (2 first + 2 middle + 1 last = 5) with 1 fully-hidden middle step.
const batchedends: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Rename the flag and update its callers.", tools: [], parts: [] },
  withId(asst("On it — let me locate the flag definition and every reader first.", [
    tool("Grep", { detail: "intermediateExpanded" }),
    tool("Read", { detail: "components/TodosView.tsx", read: "…820 lines…" }),
  ])),
  withId(asst("Found 3 call sites; applying the rename across them.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/ChatView.tsx" }),
  ])),
  withId(asst("Done — renamed the flag and its 3 callers, and re-typechecked clean.", [
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck after rename" }),
  ])),
]

// REGRESSION GUARD: the agent asks a ```question, THEN emits a TOOLS-ONLY message (text "") after it —
// e.g. it kept working past the ask. The final-text anchor must stay on the QUESTION (not slide onto the
// text-less tool message), so its answer chips remain visible + interactive. The trailing tool renders in
// full below the question (it is outside the collapsed span). Pre-fix this hid the question and killed the
// answer flow.
const questionthentool: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Wire up the one-way expand and ask me about the label.", tools: [], parts: [] },
  withId(asst("Let me add the expand handler and draft the two label options.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck" }),
  ])),
  withId(asst(finalQuestion)),
  // Tools-only follow-up (no prose) AFTER the question — must not become the standing message.
  withId(asst("", [tool("Read", { detail: "components/ChatView.tsx" })])),
]

const messages =
  variant === "single" ? single
  : variant === "notools" ? notools
  : variant === "batchedends" ? batchedends
  : variant === "questionthentool" ? questionthentool
  : variant === "trailingevent" ? trailingevent
  : heavy

const thread: ThreadViewModel = {
  id: SLUG,
  title: "Intermediate-logs collapse demo",
  status: "needs-human",
  statusText: "Waiting on your review of the collapsed intermediate view",
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
  subAgents: [],
  bgShells: [],
  lastActivityAt: new Date().toISOString(),
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
