import { createRoot } from "react-dom/client"
import "./styles.css"
import { splitProseAttachments } from "./lib/imagePaths.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { BlockImage, BlockFile } from "./components/ChatView.tsx"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"

// Proves the transcript render half of the attachment feature end-to-end with the REAL components:
// a message whose body carries standalone absolute attachment paths splits (splitProseAttachments)
// into an inline <img> for the image and an openable file chip for each non-image doc — exactly the
// mapping ChatView performs. /local-image and /rpc/openLocalFile are stubbed so the fixture renders
// and the chip's click wiring (data-local-path → openLocalFile) can be asserted without a live stack.

// A 1x1 PNG so the <img> actually paints (the route is stubbed to return these bytes).
const PNG_1x1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/local-image") {
    return new Response(PNG_1x1, { headers: { "content-type": "image/png" } })
  }
  if (url.pathname === "/rpc/openLocalFile") {
    ;(window as Window & { __openedLocalPath?: string }).__openedLocalPath =
      JSON.parse((init?.body as string) ?? "{}").path
    return new Response(JSON.stringify({ result: { action: "opened", path: "opened" } }), {
      headers: { "content-type": "application/json", "x-fray-boot": "attach-fixture" },
    })
  }
  return nativeFetch(input, init)
}

// Covers: intro prose, an attached image (inline) + pdf + svg (chips), AND a fenced code block whose
// body contains standalone absolute paths — those must stay INSIDE the code block, never become chips.
const message = [
  "Please review these attachments before we start.",
  "/tmp/fray-att/spec-notes.pdf",
  "/tmp/fray-att/diagram.png",
  "/tmp/fray-att/logo.svg",
  "Here is the file listing I ran:",
  "```",
  "/Users/foo/project/src/main.rs",
  "/Users/foo/project/README.md",
  "```",
  "That's everything.",
].join("\n")

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl p-8">
    <p className="mb-4 text-sm text-muted">Attachment render fixture — image inline, docs as chips, code fences intact</p>
    <div className="flex flex-col gap-2">
      {splitProseAttachments(message).map((part, i) =>
        part.kind === "image" ? <BlockImage key={i} path={part.path} />
        : part.kind === "file" ? <BlockFile key={i} path={part.path} />
        : <div key={i} className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(part.text) }} />,
      )}
    </div>
  </main>,
)
