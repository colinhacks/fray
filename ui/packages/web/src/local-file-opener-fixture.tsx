import { createRoot } from "react-dom/client"
import "./styles.css"
import { mdToHtml } from "./lib/markdown.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/rpc/openLocalFile") {
    ;(window as Window & { __localFileFixtureOpened?: boolean }).__localFileFixtureOpened = true
    return new Response(JSON.stringify({ result: { action: "copy", path: "/fixture/report.md" } }), {
      headers: { "content-type": "application/json", "x-fray-boot": "local-file-fixture" },
    })
  }
  return nativeFetch(input, init)
}

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl p-8">
    <p className="mb-4 text-sm text-muted">Local artifact link fixture</p>
    <div className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml("Open the [review report](/fixture/report.md).\n\n![descriptive alt](/fixture/shot.png)") }} />
  </main>,
)
