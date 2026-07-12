import type { BoardSnapshot, Settings, DispatchInput, FollowUpInput, TranscriptMessage, GithubStatus, GithubItem, GithubBatchInput, GithubBatchResult, CodexModel } from "@fray-ui/shared"
import { noteServerBootId } from "./boot.ts"

// Typed surface of the server's rpc router. This mirrors the procedures defined
// in the server package; TODO: replace with
//   import type { AppRouter } from "@fray-ui/server/router"
//   type Api = ClientFromRouter<AppRouter>
// once the server package typechecks in this workspace.
export interface Api {
  board(): Promise<BoardSnapshot>
  threadBody(input: { slug: string }): Promise<{ markdown: string }>
  threadTranscript(input: { slug: string }): Promise<{ messages: TranscriptMessage[] }>
  subAgentTranscript(input: { slug: string; id: string }): Promise<{ messages: TranscriptMessage[]; state: "running" | "stale" | "done" | "gone" }>
  dispatch(input: DispatchInput): Promise<{ slug: string; sessionId: string }>
  adoptThread(input: { slug: string; message?: string }): Promise<{ slug: string; sessionId: string }>
  followUp(input: FollowUpInput): Promise<void>
  markRead(input: { slug: string }): Promise<void>
  // Session-first queue mechanics: opening a thread records seen_at (clears it from Needs-you until
  // new activity re-arms). Also marks read server-side. No-op for a foreign thread (no registry row).
  threadSeen(input: { slug: string }): Promise<void>
  // The ONLY writer of a session thread's open|archived lifecycle (the done fence mutates nothing).
  setThreadState(input: { slug: string; state: "open" | "archived" }): Promise<void>
  // Hard-delete a stalled/exited session (the Dismiss verb): removes the row + tombstones its transcript
  // so it stays gone across a rescan. Server-gated to non-live rows; rejects a running/idle session.
  forgetThread(input: { slug: string }): Promise<void>
  // A plan artifact's markdown (.fray/plans/*.md); `path` is a PlanView.path from the board snapshot.
  planBody(input: { path: string }): Promise<{ markdown: string }>
  // A session thread's scratchpad (.fray/scratch/<session-id>.md) — read-only doc tab.
  threadScratchpad(input: { slug: string }): Promise<{ markdown: string }>
  openExternal(input: { url: string }): Promise<void>
  markComplete(input: { slug: string }): Promise<void>
  setThreadStatus(input: { slug: string; status: "active" | "planning" | "planned" | "needs-human" | "blocked" | "done" | "dismissed" }): Promise<void>
  dismissThread(input: { slug: string }): Promise<void>
  repairThread(input: { file: string }): Promise<{ slug: string }>
  archiveThread(input: { slug: string }): Promise<void>
  killAgent(input: { slug: string }): Promise<void>
  renameThread(input: { slug: string }): Promise<void>
  // The selectable Codex models + per-model effort options, read server-side from the authoritative
  // ~/.codex/models_cache.json (never a hand-maintained list). The model picker's Codex section and its
  // effort dropdown are driven by this; a tiny client fallback covers the loading/no-cache state.
  codexModels(): Promise<CodexModel[]>
  settingsGet(): Promise<Settings>
  settingsSet(input: Settings): Promise<void>
  settingsReset(): Promise<Settings>
  // The shipped GitHub batch-dispatch prompt templates — the Settings UI prefills its editors from
  // these and resets to them (an empty githubIssuePrompt/githubPrPrompt setting = the server default).
  githubPromptDefaults(): Promise<{ issue: string; pr: string }>
  // GitHub-first batch dispatch. Detection (installed/inRepo/nameWithOwner) is cached server-side;
  // `authed` is re-checked live per call. githubList reads the repo's issues/PRs; githubDispatchBatch
  // hydrates each selected item fresh + spins up one thread per item (sequential, reuses dispatch).
  githubStatus(): Promise<GithubStatus>
  githubList(input: { kind: "issues" | "prs"; sort: "recent" | "reactions"; limit?: number }): Promise<{ items: GithubItem[] }>
  githubDispatchBatch(input: GithubBatchInput): Promise<GithubBatchResult>
}

type ProcType = "query" | "mutation"

const PROCEDURES: Record<keyof Api, ProcType> = {
  board: "query",
  threadBody: "query",
  threadTranscript: "query",
  subAgentTranscript: "query",
  dispatch: "mutation",
  adoptThread: "mutation",
  followUp: "mutation",
  markRead: "mutation",
  threadSeen: "mutation",
  setThreadState: "mutation",
  forgetThread: "mutation",
  planBody: "query",
  threadScratchpad: "query",
  openExternal: "mutation",
  markComplete: "mutation",
  setThreadStatus: "mutation",
  dismissThread: "mutation",
  repairThread: "mutation",
  archiveThread: "mutation",
  killAgent: "mutation",
  renameThread: "mutation",
  codexModels: "query",
  settingsGet: "query",
  settingsSet: "mutation",
  settingsReset: "mutation",
  githubPromptDefaults: "query",
  githubStatus: "query",
  githubList: "query",
  githubDispatchBatch: "mutation",
}

async function call(name: string, type: ProcType, input?: unknown): Promise<unknown> {
  if (type === "query") {
    const url = new URL(`/rpc/${name}`, location.origin)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    const res = await fetch(url.toString())
    noteServerBootId(res.headers.get("x-fray-boot")) // notice a server restart on any RPC roundtrip
    const json = await res.json()
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `RPC ${name} failed`)
    return json.result
  }
  const res = await fetch(`/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  })
  noteServerBootId(res.headers.get("x-fray-boot"))
  const json = await res.json()
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `RPC ${name} failed`)
  return json.result
}

export const rpc = new Proxy({} as Api, {
  get(_target, name: string) {
    const type = PROCEDURES[name as keyof Api]
    if (!type) return undefined
    return (input?: unknown) => call(name, type, input)
  },
})
