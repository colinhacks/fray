import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"

const settings = {
  dispatchPreamble: "Keep implementation notes concise.\nCheck the affected workflow before reporting completion.",
  permissionMode: "auto",
  notifications: true,
  font: "sans",
}

const rpcResult = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "content-type": "application/json", "x-fray-boot": "settings-fixture" },
})

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/rpc/settingsGet") return rpcResult(settings)
  if (url.pathname === "/rpc/codexModels") return rpcResult([])
  if (url.pathname === "/rpc/githubPromptDefaults") {
    return rpcResult({
      issue: "Investigate the reported issue. Classify it, reproduce it when possible, and give an evidence-backed implementation plan.",
      pr: "Audit this pull request adversarially. Verify behavior, edge cases, tests, and CI before recommending approve or request changes.",
    })
  }
  if (url.pathname === "/rpc/settingsSet") return rpcResult(settings)
  return nativeFetch(input, init)
}

Object.defineProperty(window, "Notification", {
  configurable: true,
  value: { permission: "denied", requestPermission: async () => "denied" },
})

const [{ SettingsDrawer }, { queryClient }, { TooltipProvider }] = await Promise.all([
  import("./components/SettingsDrawer.tsx"),
  import("./main.tsx"),
  import("./components/Tooltip.tsx"),
])

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <SettingsDrawer />
    </TooltipProvider>
  </QueryClientProvider>,
)
