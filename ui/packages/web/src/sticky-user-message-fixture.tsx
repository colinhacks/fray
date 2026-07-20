import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@fray-ui/shared"
import { ThreadView, FenceCard, Message } from "./components/ChatView.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { prefs } from "./lib/prefs.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the sticky most-recent-user-message change: the human's latest ask pins to the top
// of the scroll pane in BOTH the drawer (ChatView) and the queue card (TodosView), with top padding
// and a max-height that gives a very tall ask its own internal scroll.
//   ?surface=queue|drawer   which surface to render (default queue)
//   ?size=short|tall        short one-line ask, or a very tall ask (exercise max-h + inner scroll)
//   ?sticky=on|off  the client stickyUserMessage view pref (default on)
const params = new URLSearchParams(location.search)
const surfaceParam = params.get("surface")
const surface = surfaceParam === "drawer" ? "drawer" : surfaceParam === "fence" ? "fence" : surfaceParam === "sentfiles" ? "sentfiles" : "queue"
const sizeParam = params.get("size")
const size = sizeParam === "tall" ? "tall" : sizeParam === "medium" ? "medium" : "short"
const stickyParam = params.get("sticky")
if (stickyParam === "on" || stickyParam === "off") prefs.stickyUserMessage = stickyParam === "on"

const SLUG = "sticky-demo"

const shortAsk =
  "Can you make the most recent user message sticky at the top of the thread UI, with padding?"
// Medium: taller than the 200px collapsed cap but SHORTER than the 85vh expand cap — the case the
// reported reflow bug lived in (hover expands to fit, a transient scrollbar used to flash mid-animation).
const mediumAsk = Array.from({ length: 8 }, (_, i) =>
  `Line ${i + 1}: a medium-length ask that comfortably fits when expanded, so hovering it should reveal the whole message with no scrollbar and no reflow at all.`,
).join("\n")
const tallAsk = Array.from({ length: 30 }, (_, i) =>
  `Line ${i + 1}: this is a deliberately very tall user message so the pinned band exceeds the pane height and must scroll within its own max-height instead of swallowing the whole viewport.`,
).join("\n")
const askFor = (s: typeof size) => (s === "tall" ? tallAsk : s === "medium" ? mediumAsk : shortAsk)

const longReply = Array.from({ length: 40 }, (_, i) =>
  `**Paragraph ${i + 1}.** The assistant reply is intentionally long so the pane scrolls and the pinned ask stays visible above it. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
).join("\n\n")

const messages: TranscriptMessage[] = [
  { sourceId: "u0", role: "user", text: "First, an older ask that should scroll away normally.", tools: [], parts: [] },
  { sourceId: "a0", role: "assistant", text: "Sure — here is an earlier reply.", tools: [], parts: [{ kind: "text", text: "Sure — here is an earlier reply." }] },
  { sourceId: "u1", role: "user", text: askFor(size), tools: [], parts: [] },
  { sourceId: "a1", role: "assistant", text: longReply, tools: [], parts: [{ kind: "text", text: longReply }] },
]

const thread: ThreadViewModel = {
  id: SLUG,
  title: "Sticky most-recent-user-message demo",
  status: "needs-human",
  statusText: "Waiting on your review of the sticky behavior",
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

function DrawerHarness() {
  const [tab, setTab] = useState<"chat" | "scratch">("chat")
  // A fixed-height flex column mimicking the drawer's shell so ChatView's single scroll region engages.
  return (
    <div className="mx-auto my-8 flex h-[640px] w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
      <ThreadView slug={SLUG} tab={tab} onTab={setTab} />
    </div>
  )
}

// A done-fence body exercising the inline markdown a worker would write: `inline code` for paths /
// identifiers / CSS vars / commands, a [markdown link](url), and **bold**.
const fenceBody = [
  "- Fixed the over-cap scroll in `ui/packages/web/src/components/ChatView.tsx` (`UserBubble` stays `overflow-hidden` while animating).",
  "- Linked the scrollbar width into `:root { --sbw }` so `::-webkit-scrollbar` and the reserved gutter can't drift.",
  "- Opened [PR #391](https://github.com/acme/app/pull/391); ran `pnpm test` and `npm run lint` — **all green**.",
].join("\n")

// A SendUserFile delivery message → renders the SentFilesCard. `?img=<abs path>` supplies a servable
// image (load this fixture through the adhoc stack, whose /local-image serves os.tmpdir()).
const sentImg = params.get("img")
const sentFilesMessage: TranscriptMessage = {
  sourceId: "sf1", role: "assistant", text: "", tools: [],
  parts: [{
    kind: "tools",
    tools: [{
      name: "SendUserFile", detail: "before vs after",
      sentImages: sentImg ? [sentImg] : [],
      sentFiles: ["/Users/you/project/report.md", "/Users/you/project/trace.log"],
      caption: "Left is collapsed, right expands on hover — no reflow. Plus a couple of non-image files.",
    }],
  }],
} as unknown as TranscriptMessage

function Fixture() {
  if (surface === "sentfiles") {
    return (
      <div className="mx-auto mt-10 w-[min(680px,calc(100%-32px))]">
        <Message m={sentFilesMessage} />
      </div>
    )
  }
  if (surface === "fence") {
    return (
      <div className="mx-auto mt-10 w-[min(680px,calc(100%-32px))]">
        <FenceCard fenceKind="done" body={fenceBody} hints={[]} />
      </div>
    )
  }
  if (surface === "drawer") return <DrawerHarness />
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))]">
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
