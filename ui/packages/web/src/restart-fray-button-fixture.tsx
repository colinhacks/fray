import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import "./styles.css"
import { store } from "./store.ts"

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_fray/control/status") {
    return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true }), {
      headers: { "content-type": "application/json" },
    })
  }
  if (url.pathname === "/_fray/control/update-restart") {
    const requests = Number(window.sessionStorage.getItem("restartFixtureRequests") ?? "0") + 1
    window.sessionStorage.setItem("restartFixtureRequests", String(requests))
    await new Promise((resolve) => window.setTimeout(resolve, 1_000))
    return new Response(JSON.stringify({ protocol: 1, state: "restarting" }), {
      headers: { "content-type": "application/json" },
    })
  }
  return nativeFetch(input, init)
}

const { RestartFrayButton } = await import("./components/RestartFrayButton.tsx")
const { RestartOverlay } = await import("./components/RestartOverlay.tsx")

function Fixture() {
  const snap = useSnapshot(store)
  const restarting = snap.controlPlaneState === "restarting"
  return (
    <main className="min-h-screen bg-bg p-3 sm:p-8">
      <RestartOverlay open={restarting} message={snap.controlPlaneMessage} />
      <div inert={restarting}>
        {/* A focusable background control so QA can prove Tab cannot reach behind the scrim. */}
        <button type="button" data-testid="decoy" className="mb-4 rounded border border-border px-2 py-1">decoy</button>
        <div className="ml-auto w-fit"><RestartFrayButton /></div>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
