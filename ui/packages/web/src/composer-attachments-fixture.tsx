import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Browser QA for the attachment CHIPS: the composer now keeps attachment absolute paths inside its
// draft value (trailing lines) but renders them as square tiles along the bottom row — an image
// thumbnail (via /local-image) or a file-type icon (docs) — instead of the raw path text. This proves
// the real <Composer> splits a value of "prose + trailing paths" into prose-in-textarea + chips, at
// desktop and narrow widths. /local-image is stubbed to a small solid PNG so the image tiles paint.
const PNG = Uint8Array.from(
  atob(
    // 8x8 solid teal PNG — enough to prove the <img> tile paints under object-cover.
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mNk+M/wn4EIwDiqEF3hKAUAxvcH/eKt6jkAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
)
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/local-image") return new Response(PNG, { headers: { "content-type": "image/png" } })
  if (url.pathname.startsWith("/rpc/")) return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

// Prose followed by a trailing run of attachment paths — exactly what takeFiles produces. The textarea
// must show ONLY the prose; the four paths must render as chips (2 image thumbnails, a pdf tile, a csv
// tile), each removable.
const INITIAL = [
  "Please review these attachments before we start on the redesign.",
  "/tmp/fray-att/hero-mock.png",
  "/tmp/fray-att/before-after.webp",
  "/tmp/fray-att/spec-notes.pdf",
  "/tmp/fray-att/metrics.csv",
].join("\n")

function Fixture() {
  const [wide, setWide] = useState("Ship the new dashboard layout.\n/tmp/fray-att/wireframe.png")
  const [narrow, setNarrow] = useState(INITIAL)
  return (
    <div className="min-h-screen bg-bg text-fg flex flex-col items-center gap-10 p-10">
      <div className="w-[520px]">
        <p className="mb-2 text-[11px] text-muted">Desktop composer — one attachment</p>
        <Composer
          surface="newComposer"
          value={wide}
          onChange={setWide}
          onSubmit={() => {}}
          placeholder="Describe the task…"
          minHeight={96}
          maxHeight={340}
          footer={<span className="text-[11px] text-muted">gpt-5.6 · default</span>}
        />
      </div>
      <div className="w-[380px]">
        <p className="mb-2 text-[11px] text-muted">Narrow composer — four attachments (chips wrap)</p>
        <Composer
          surface="chatComposer"
          value={narrow}
          onChange={setNarrow}
          onSubmit={() => {}}
          placeholder="Follow up…"
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
