import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"
import { App } from "./App.tsx"
import { connectSync } from "./api/socket.ts"
import { initFont } from "./lib/font.ts"
import { installExternalLinkInterceptor } from "./lib/external-links.ts"

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

// One multiplexed /ws (board + transcript push + notify); falls back to SSE + polling if /ws is
// unavailable (a pre-restart server). The socket writes transcript pushes into this queryClient's cache.
connectSync(queryClient)
initFont(queryClient)
installExternalLinkInterceptor()

// No StrictMode: it double-mounts effects, which would open the terminal
// WebSocket (and xterm instance) twice per selection in dev.
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
