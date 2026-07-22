import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import type { AwaitingHint, BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { FenceCard, ThreadSlugContext, Message } from "./components/ChatView.tsx"
import { QueueSubAgentLines } from "./components/QueueSubAgentLines.tsx"
import { ThreadLifecycleFooter } from "./components/ThreadLifecycleFooter.tsx"
import { setBoard } from "./store.ts"
import { splitFenceBlocks } from "./lib/fenceBlocks.ts"
import "./styles.css"

// Exercises the REAL FenceCard buttons against a seeded board + the ThreadSlugContext the transcript
// sets in production:
//   • the done card's white "Mark as done" button (completeThread; ?mode=executing → needsConfirmation
//     → the End-session dialog path)
//   • the awaiting card's one opt-in action (timer → "Confirm snooze"; github-review → "Confirm
//     watcher") and the post-confirmation states.
// RPC is mocked like completion-lifecycle-fixture so nothing real is hit.
const mode = new URLSearchParams(window.location.search).get("mode") === "executing" ? "executing" : "resting"
const calloutsOnly = new URLSearchParams(window.location.search).get("callouts") === "1"
const agentOnly = new URLSearchParams(window.location.search).get("agent") === "1"
const requestedDelay = Number(new URLSearchParams(window.location.search).get("delay") ?? "0")
const responseDelayMs = Number.isFinite(requestedDelay) ? Math.min(Math.max(requestedDelay, 0), 5_000) : 0
const signalAt = "2099-07-14T08:00:00.000Z"
const nativeFetch = window.fetch.bind(window)
const rpcResult = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "content-type": "application/json", "x-fray-boot": "done-card-button-fixture" },
})

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname === "/rpc/completeThread") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { terminateLive?: boolean }
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "completeThread", ...body } }))
    return rpcResult({ needsConfirmation: mode === "executing" && body.terminateLive !== true })
  }
  if (url.pathname === "/rpc/confirmAwaiting") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string }
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "confirmAwaiting", ...body } }))
    if (body.slug) {
      setBoard({
        ...board,
        threads: board.threads.map((thread) => thread.id === body.slug
          ? { ...thread, awaitingWaitConfirmed: true, needsYou: false }
          : thread),
      })
    }
    return rpcResult(null)
  }
  if (url.pathname === "/rpc/setThreadSnooze") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string; sessionId?: string; until?: string | null }
    if (responseDelayMs) await new Promise((resolve) => setTimeout(resolve, responseDelayMs))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "setThreadSnooze", ...body } }))
    return rpcResult(null)
  }
  return nativeFetch(input, init)
}

const baseThread = (id: string, title: string, subAgents: ThreadView["subAgents"] = [], confirmed = false): ThreadView => ({
  id,
  sessionId: `${id}-session`,
  title,
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: mode === "executing" ? "running" : "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  state: "open",
  kind: "session",
  foreign: false,
  subAgents,
  bgShells: [],
  awaitingWaitConfirmed: confirmed,
  lastActivityAt: signalAt,
  lastAssistantAt: signalAt,
})

// A fixed future instant so the timer card renders a real "Confirm snooze" (isValidAwaitingTimer + future).
const timerIso = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

const cards: { slug: string; label: string; fence: "done" | "awaiting"; body: string; hint?: AwaitingHint; confirmed?: boolean; renderedSignalAt?: string }[] = [
  { slug: "card-done", label: "done", fence: "done", body: "Shipped the change." },
  { slug: "card-timer", label: "timer proposal", fence: "awaiting", body: "Park until the checkpoint.", hint: { kind: "timer", value: timerIso } },
  { slug: "card-review", label: "review proposal", fence: "awaiting", body: "The implementation is ready for Alice's review.", hint: { kind: "github-review", value: "owner/repo#42" } },
  { slug: "card-review-historical", label: "historical identical review (inert)", fence: "awaiting", body: "An older request for Alice's review.", hint: { kind: "github-review", value: "owner/repo#42" }, renderedSignalAt: "2099-07-14T07:00:00.000Z" },
  { slug: "card-review-active", label: "confirmed review watcher", fence: "awaiting", body: "The implementation is ready for Alice's review.", hint: { kind: "github-review", value: "owner/repo#42" }, confirmed: true },
  { slug: "card-invalid", label: "invalid proposal (no action)", fence: "awaiting", body: "human: Alice must approve\nci: owner/repo#7\nThese lines are visible prose." },
]

// The QUEUE path: the queue card renders the fence through <Message dense> inside a ThreadSlugContext,
// so this reproduces exactly how a done/awaiting card in the queue reaches FenceCard. Proves the button
// shows in the queue too. Each renders a real assistant message whose text IS the fence block.
const queueCards: { slug: string; label: string; text: string }[] = [
  { slug: "queue-done", label: "done", text: "Shipped it.\n\n```done\nAll green.\n```" },
  { slug: "queue-timer", label: "timer snooze", text: "```awaiting\nPark until the checkpoint.\ntimer: " + timerIso + "\n```" },
  { slug: "queue-review", label: "review watcher", text: "```awaiting\ngithub-review: owner/repo#42\nAlice must review the PR.\n```" },
]

// A queue thread with a LIVE sub-agent dispatch. Dense messages intentionally omit the nested Agent
// tool card; QueueSubAgentLines is the queue's one flat, drillable child surface.
const agentSlug = "queue-agent"
const agentId = "sub-live-1"
const agentThread = baseThread(agentSlug, "agent · live sub-agent", [
  { label: "Investigate the failing test", startedAt: new Date(Date.now() - 90_000).toISOString(), state: "running", subagentType: "fray:opus-high", id: agentId },
])

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  frayActive: true,
  threads: [
    ...cards.map((c) => ({
      ...baseThread(c.slug, c.label, [], c.confirmed),
      lastFence: { kind: c.fence, body: c.body, ...(c.hint ? { hint: c.hint } : {}), at: signalAt },
    })),
    ...queueCards.map((c) => {
      const segment = splitFenceBlocks(c.text).find((item) => item.kind === "fence")
      return {
        ...baseThread(c.slug, c.label),
        ...(segment?.kind === "fence" ? {
          lastFence: {
            kind: segment.fenceKind,
            body: segment.body,
            ...(segment.hint ? { hint: segment.hint } : {}),
            at: signalAt,
          },
        } : {}),
      }
    }),
    agentThread,
  ],
  errors: [],
  warnings: [],
}
setBoard(board)

const agentMessage = {
  role: "assistant" as const,
  text: "",
  tools: [],
  parts: [{ kind: "tools" as const, tools: [{ name: "Agent", detail: "Investigate the failing test", prompt: "Go investigate the failing test and report back.", subagentType: "fray:opus-high", agentId, status: "pending" as const }] }],
}

function Fixture() {
  const [calls, setCalls] = useState<string[]>([])
  useEffect(() => {
    const onRpc = ((event: CustomEvent<{ rpc: string; until?: string; terminateLive?: boolean; slug?: string; sessionId?: string; fenceAt?: string; hint?: AwaitingHint }>) => {
      const d = event.detail
      const detail = d.rpc === "confirmAwaiting"
        ? `confirmAwaiting(slug=${d.slug}, sessionId=${d.sessionId}, fenceAt=${d.fenceAt}, hint=${d.hint?.kind}:${d.hint?.value})`
        : d.rpc === "setThreadSnooze"
          ? `setThreadSnooze(slug=${d.slug}, sessionId=${d.sessionId}, until=${d.until})`
        : `completeThread(terminateLive=${d.terminateLive})`
      setCalls((prior) => [...prior, detail])
    }) as EventListener
    window.addEventListener("fixture-rpc", onRpc)
    return () => window.removeEventListener("fixture-rpc", onRpc)
  }, [])
  if (calloutsOnly) {
    return (
      <main data-callout-gallery className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-3 px-4 py-8">
        {cards.filter((card) => card.fence === "awaiting").map((card) => (
          <ThreadSlugContext.Provider key={card.slug} value={card.slug}>
            <FenceCard fenceKind={card.fence} body={card.body} hint={card.hint} signalAt={card.renderedSignalAt ?? signalAt} />
          </ThreadSlugContext.Provider>
        ))}
        <p data-fixture-rpc-calls className="sr-only">RPC calls: {calls.join(" | ") || "none"}</p>
      </main>
    )
  }
  if (agentOnly) {
    return (
      <main data-agent-gallery className="mx-auto min-h-screen w-full max-w-xl px-4 py-8">
        <article data-agent-queue-card className="overflow-hidden rounded-lg border border-border bg-panel">
          <header className="border-b border-border/60 px-4 py-3">
            <strong className="text-[13px] font-semibold">Fix queue regression</strong>
          </header>
          <div className="px-4 py-3">
            <ThreadSlugContext.Provider value={agentSlug}>
              <Message m={agentMessage} dense />
            </ThreadSlugContext.Provider>
            <QueueSubAgentLines slug={agentSlug} subAgents={agentThread.subAgents} />
          </div>
        </article>
      </main>
    )
  }
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-3 px-4 py-8">
      {cards.map((c) => (
        <div key={c.slug} data-fence-fixture={c.slug} data-fixture-label={c.label} className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted">{c.label}</p>
          <ThreadSlugContext.Provider value={c.slug}>
            <FenceCard fenceKind={c.fence} body={c.body} hint={c.hint} signalAt={c.renderedSignalAt ?? signalAt} />
          </ThreadSlugContext.Provider>
        </div>
      ))}
      {queueCards.map((c) => (
        <div key={c.slug} data-queue-fixture={c.slug} data-fixture-label={c.label}>
          <ThreadSlugContext.Provider value={c.slug}>
            <Message m={{ role: "assistant", text: c.text, tools: [], parts: [{ kind: "text", text: c.text }], signalAt }} dense />
          </ThreadSlugContext.Provider>
        </div>
      ))}
      <div data-queue-fixture={agentSlug}>
        <ThreadSlugContext.Provider value={agentSlug}>
          <Message m={agentMessage} dense />
        </ThreadSlugContext.Provider>
        <QueueSubAgentLines slug={agentSlug} subAgents={agentThread.subAgents} />
      </div>
      <div data-confirmed-wait-footer className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel">
        <p className="px-3 pt-3 text-[11px] text-muted">confirmed review wait · lifecycle cancellation</p>
        <ThreadLifecycleFooter thread={board.threads.find((thread) => thread.id === "card-review-active")!} />
      </div>
      <p data-fixture-rpc-calls className="text-[11px] text-muted">RPC calls: {calls.join(" | ") || "none"}</p>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
