import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"
import { App } from "./App.tsx"
import { connectSync } from "./api/socket.ts"
import { initFont } from "./lib/font.ts"
import { installExternalLinkInterceptor } from "./lib/external-links.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { installThreadLinkInterceptor } from "./lib/thread-links.ts"
import { primeRoute } from "./lib/router.ts"

const settingsFixture = typeof window !== "undefined" && window.location.pathname.endsWith("/settings-formatting-fixture.html")

if (!settingsFixture) {
  // Adopt a cold/deep URL before React takes its first store snapshot. startRouter installs the ongoing
  // store/history listeners from App; this synchronous seed is what makes the initial drawer real.
  primeRoute()
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

// One multiplexed /ws (board + transcript push + notify); falls back to SSE + polling if /ws is
// unavailable (a pre-restart server). The socket writes transcript pushes into this queryClient's cache.
if (!settingsFixture) {
  connectSync(queryClient)
  initFont(queryClient)
  installExternalLinkInterceptor()
  installLocalFileLinkInterceptor()
  installThreadLinkInterceptor()
}

// No StrictMode: it double-mounts effects, which would open the terminal
// WebSocket (and xterm instance) twice per selection in dev.
if (!settingsFixture) {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
}
