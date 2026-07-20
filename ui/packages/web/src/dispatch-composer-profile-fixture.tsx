import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, CodexModel, DispatchPreferences, SetDispatchPreferenceInput } from "@fray-ui/shared"
import { DispatchForm } from "./components/NewThreadModal.tsx"
import { store } from "./store.ts"
import "./styles.css"

const codexModels: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
  { slug: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", defaultEffort: "low", efforts: ["low", "medium"] },
]

let preferences: DispatchPreferences = {
  backend: "codex",
  claude: { permissionMode: "auto" },
  codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" },
}
const writes: SetDispatchPreferenceInput[] = []
const outcome = new URL(window.location.href).searchParams.get("outcome") === "failure" ? "failure" : "success"

declare global {
  interface Window { dispatchComposerProfileFixture?: { preferences: DispatchPreferences; writes: SetDispatchPreferenceInput[] } }
}

window.dispatchComposerProfileFixture = { preferences, writes }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.origin)
  if (url.pathname === "/rpc/dispatchPreferencesGet") return json(preferences)
  if (url.pathname === "/rpc/codexModels") return json(codexModels)
  if (url.pathname === "/rpc/dispatchPreferenceSet") {
    const update = JSON.parse(String(init?.body ?? "{}")) as SetDispatchPreferenceInput
    writes.push(update)
    if (update.field === "profile") {
      preferences = {
        ...preferences,
        backend: update.backend,
        [update.backend]: { ...preferences[update.backend], model: update.model, effort: update.effort },
      }
    }
    window.dispatchComposerProfileFixture = { preferences, writes }
    return json(preferences)
  }
  if (url.pathname === "/rpc/dispatch") {
    // A deliberately isolated RPC seam for visual QA: no local server state, worker, terminal, or
    // live thread can be touched from this fixture. The short delay leaves the optimistic task card
    // visible long enough to inspect before either acknowledgement or rollback.
    await new Promise((resolve) => window.setTimeout(resolve, 900))
    if (outcome === "failure") return new Response(JSON.stringify({ error: "Fixture dispatch rejected" }), { status: 500, headers: { "content-type": "application/json" } })
    return json({ slug: "fixture-started-thread", sessionId: "fixture-session" })
  }
  return nativeFetch(input, init)
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-fray-boot": "fixture" } })
}

store.board = { projectDir: "/fixture/dispatch-composer" } as BoardSnapshot

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <main className="min-h-screen bg-bg p-6">
      <section className="mx-auto max-w-xl rounded-xl border border-border bg-panel p-5">
        <h1 className="mb-3 text-sm font-medium">New thread</h1>
        <DispatchForm />
      </section>
    </main>
  </QueryClientProvider>,
)
