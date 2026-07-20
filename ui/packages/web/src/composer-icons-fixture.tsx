import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import { GithubTrigger } from "./components/GithubTrigger.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Browser QA for the dispatch composer's icon RAIL: paperclip (attach) + GitHub (investigate) + send.
// The GitHub icon only renders when gh is authed in a repo, which the isolated adhoc stack can't satisfy
// (it changes HOME), so stub githubStatus here. Verifies: (1) the paperclip brightness matches the GitHub
// icon (both text-muted), and (2) the paperclip↔GitHub gap reads even with the GitHub↔send gap.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/rpc/githubStatus") {
    return new Response(JSON.stringify({ result: { inRepo: true, authed: true } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/rpc/")) return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function Fixture() {
  const [value, setValue] = useState("A short task prompt to enable the send button.")
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center p-10">
      <div className="w-[520px]">
        <Composer
          surface="newComposer"
          value={value}
          onChange={setValue}
          onSubmit={() => {}}
          placeholder="Describe the task…"
          minHeight={96}
          maxHeight={340}
          footer={<span className="text-[11px] text-muted">gpt-5.6 · default</span>}
          leftAction={<GithubTrigger profile={{ label: "stub" } as never} />}
        />
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
