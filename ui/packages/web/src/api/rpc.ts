import type {
  BoardSnapshot,
  Settings,
  DispatchInput,
  AdoptThreadInput,
  AdoptThreadResult,
  FollowUpInput,
  RenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadProfileOptionsResult,
  SetThreadProfileInput,
  SetThreadProfileResult,
  SetThreadSnoozeInput,
  SubmitCodexDraftInput,
  SubmitCodexDraftResult,
  PrepareCodexDraftReplacementInput,
  PrepareCodexDraftReplacementResult,
  ClearAmbiguousCodexInputInput,
  ClearAmbiguousCodexInputResult,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  GithubStatus,
  GithubItem,
  GithubBatchInput,
  GithubBatchResult,
  CodexModel,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  DispatchPreferences,
  SetDispatchPreferenceInput,
  ListInteractionsInput,
  ListInteractionsResult,
  GetInteractionInput,
  GetInteractionResult,
  ResolveInteractionInput,
  ResolveInteractionResult,
  CancelInteractionInput,
  CancelInteractionResult,
} from "@fray-ui/shared"
import { noteServerBootId } from "./boot.ts"
import { store } from "../store.ts"

export const CONTROL_PLANE_RESTARTING_MESSAGE = "Fray is updating and restarting. Your draft is preserved; wait until it is ready before sending or changing settings."

export function assertMutationAllowedDuringControlPlaneTransition(type: ProcType): void {
  if (type === "mutation" && store.controlPlaneState === "restarting") {
    throw new Error(CONTROL_PLANE_RESTARTING_MESSAGE)
  }
}

// Typed surface of the server's rpc router. This mirrors the procedures defined
// in the server package; TODO: replace with
//   import type { AppRouter } from "@fray-ui/server/router"
//   type Api = ClientFromRouter<AppRouter>
// once the server package typechecks in this workspace.
export interface Api {
  board(): Promise<BoardSnapshot>
  threadBody(input: { slug: string }): Promise<{ markdown: string }>
  threadTranscript(input: { slug: string }): Promise<TranscriptPage>
  threadTranscriptEarlier(input: TranscriptEarlierInput): Promise<TranscriptPage>
  subAgentTranscript(input: { slug: string; id: string }): Promise<{ messages: TranscriptMessage[]; state: "running" | "stale" | "done" | "gone" }>
  // Scoped typed requests are read/answered only for the current registered session. There is
  // deliberately no browser create method: provider adapters alone can journal a request.
  pendingInteractions(input: ListInteractionsInput): Promise<ListInteractionsResult>
  interactionGet(input: GetInteractionInput): Promise<GetInteractionResult>
  interactionResolve(input: ResolveInteractionInput): Promise<ResolveInteractionResult>
  interactionCancel(input: CancelInteractionInput): Promise<CancelInteractionResult>
  dispatch(input: DispatchInput): Promise<{ slug: string; sessionId: string }>
  adoptThread(input: AdoptThreadInput): Promise<AdoptThreadResult>
  followUp(input: FollowUpInput): Promise<void>
  setThreadPermission(input: SetThreadPermissionInput): Promise<SetThreadPermissionResult>
  threadProfileOptions(input: ThreadProfileOptionsInput): Promise<ThreadProfileOptionsResult>
  setThreadProfile(input: SetThreadProfileInput): Promise<SetThreadProfileResult>
  submitCodexDraft(input: SubmitCodexDraftInput): Promise<SubmitCodexDraftResult>
  prepareCodexDraftReplacement(input: PrepareCodexDraftReplacementInput): Promise<PrepareCodexDraftReplacementResult>
  clearAmbiguousCodexInput(input: ClearAmbiguousCodexInputInput): Promise<ClearAmbiguousCodexInputResult>
  markRead(input: { slug: string }): Promise<void>
  // Opening a thread records read/seen telemetry only. Queue membership is lifecycle-driven and is
  // never cleared by viewing a resting thread. No-op for a foreign thread (no registry row).
  threadSeen(input: { slug: string }): Promise<void>
  // The ONLY writer of a session thread's open|archived lifecycle (the done fence mutates nothing).
  setThreadState(input: { slug: string; state: "open" | "archived" }): Promise<void>
  // Completes an inactive session immediately. A live provider shell reports that confirmation is
  // required; the caller must opt into its termination before the row can move to Done.
  completeThread(input: { slug: string; terminateLive?: boolean }): Promise<{ needsConfirmation: boolean }>
  setThreadSnooze(input: SetThreadSnoozeInput): Promise<void>
  // Hard-delete a stalled/exited session (the Dismiss verb): removes the row + tombstones its transcript
  // so it stays gone across a rescan. Server-gated to non-live rows; rejects a running/idle session.
  forgetThread(input: { slug: string }): Promise<void>
  // A plan artifact's markdown (.fray/plans/*.md); `path` is a PlanView.path from the board snapshot.
  planBody(input: { path: string }): Promise<{ markdown: string }>
  // Hard-delete a plan artifact (.fray/plans/*.md). Secure-resolver gated server-side; idempotent.
  planDelete(input: { path: string }): Promise<void>
  // A session thread's scratchpad (.fray/threads/<session-id>/scratch.md) — read-only doc tab.
  threadScratchpad(input: { slug: string }): Promise<{ markdown: string }>
  // Server-authoritative, shell-safe provider resume command for a registered Fray-owned session.
  // A live Fray-owned runtime is deliberately unavailable: a second provider client is uncoordinated.
  threadTerminalCommand(input: { slug: string }): Promise<{ command: string | null; mode: "resume" | "unavailable"; reason: string | null }>
  openExternal(input: { url: string }): Promise<void>
  openLocalFile(input: { path: string; image?: boolean }): Promise<{ action: "opened" | "copy"; path: string }>
  // Classify path references (as they appear in inline code) → canonical openable path, or null when the
  // candidate doesn't resolve to a real file under the server's openable roots. Drives clickable inline code.
  resolveLocalPaths(input: { paths: string[] }): Promise<{ resolved: { input: string; path: string | null }[] }>
  markComplete(input: { slug: string }): Promise<void>
  setThreadStatus(input: { slug: string; status: "active" | "planning" | "planned" | "needs-human" | "blocked" | "done" | "dismissed" }): Promise<void>
  dismissThread(input: { slug: string }): Promise<void>
  repairThread(input: { file: string }): Promise<{ slug: string }>
  archiveThread(input: { slug: string }): Promise<void>
  killAgent(input: { slug: string }): Promise<void>
  renameThread(input: RenameThreadInput): Promise<void>
  aiRenameThread(input: { slug: string }): Promise<AiRenameThreadResult>
  // The selectable Codex models + per-model effort options, read server-side from the authoritative
  // ~/.codex/models_cache.json (never a hand-maintained list). The model picker's Codex section and its
  // effort dropdown are driven by this; a tiny client fallback covers the loading/no-cache state.
  codexModels(): Promise<CodexModel[]>
  // Provider subscription quota (5h + weekly windows) for the sidebar status bar. Codex reads clean
  // from rollout JSONL; Claude best-effort via its undocumented OAuth usage endpoint. Never rejects —
  // each provider degrades to "unavailable".
  quota(): Promise<QuotaSnapshot>
  // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from quota's
  // overloaded "unavailable" — reports only whether a credential exists. Never rejects.
  authStatus(): Promise<AuthSnapshot>
  accountLogout(input: AccountLogoutInput): Promise<AccountLogoutResult>
  settingsGet(): Promise<Settings>
  settingsSet(input: Settings): Promise<void>
  settingsReset(): Promise<Settings>
  dispatchPreferencesGet(): Promise<DispatchPreferences>
  dispatchPreferenceSet(input: SetDispatchPreferenceInput): Promise<DispatchPreferences>
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
  threadTranscriptEarlier: "query",
  subAgentTranscript: "query",
  pendingInteractions: "query",
  interactionGet: "query",
  interactionResolve: "mutation",
  interactionCancel: "mutation",
  dispatch: "mutation",
  adoptThread: "mutation",
  followUp: "mutation",
  setThreadPermission: "mutation",
  threadProfileOptions: "query",
  setThreadProfile: "mutation",
  submitCodexDraft: "mutation",
  prepareCodexDraftReplacement: "query",
  clearAmbiguousCodexInput: "mutation",
  markRead: "mutation",
  threadSeen: "mutation",
  setThreadState: "mutation",
  completeThread: "mutation",
  setThreadSnooze: "mutation",
  forgetThread: "mutation",
  planBody: "query",
  planDelete: "mutation",
  threadScratchpad: "query",
  threadTerminalCommand: "query",
  openExternal: "mutation",
  openLocalFile: "mutation",
  resolveLocalPaths: "query",
  markComplete: "mutation",
  setThreadStatus: "mutation",
  dismissThread: "mutation",
  repairThread: "mutation",
  archiveThread: "mutation",
  killAgent: "mutation",
  renameThread: "mutation",
  aiRenameThread: "mutation",
  codexModels: "query",
  quota: "query",
  authStatus: "query",
  accountLogout: "mutation",
  settingsGet: "query",
  settingsSet: "mutation",
  settingsReset: "mutation",
  dispatchPreferencesGet: "query",
  dispatchPreferenceSet: "mutation",
  githubPromptDefaults: "query",
  githubStatus: "query",
  githubList: "query",
  githubDispatchBatch: "mutation",
}

// Parse one RPC envelope without leaking a browser JSON SyntaxError into the UI. During local HMR the
// web bundle can update before the long-running server process; a brand-new route then returns Hono's
// plain-text 404 ("404 Not Found"), which `res.json()` misleadingly reported as "Unexpected
// non-whitespace character after JSON". Name that operational fix directly.
export async function parseRpcResponse(res: Response, name: string): Promise<unknown> {
  const body = await res.text()
  let json: { result?: unknown; error?: unknown }
  try {
    json = JSON.parse(body) as { result?: unknown; error?: unknown }
  } catch {
    if (res.status === 404 || res.status === 405) {
      throw new Error("Fray server restart required — this control is newer than the running server")
    }
    throw new Error(`RPC ${name} returned an invalid response`)
  }
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `RPC ${name} failed`)
  return json.result
}

async function call(name: string, type: ProcType, input?: unknown): Promise<unknown> {
  // The old child may remain healthy while its durable owner is building a replacement. Do not let
  // a mutation race that handoff; local draft state remains editable and every query stays available.
  assertMutationAllowedDuringControlPlaneTransition(type)
  if (type === "query") {
    const url = new URL(`/rpc/${name}`, location.origin)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    const res = await fetch(url.toString())
    noteServerBootId(res.headers.get("x-fray-boot")) // notice a server restart on any RPC roundtrip
    return parseRpcResponse(res, name)
  }
  const res = await fetch(`/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  })
  noteServerBootId(res.headers.get("x-fray-boot"))
  return parseRpcResponse(res, name)
}

export const rpc = new Proxy({} as Api, {
  get(_target, name: string) {
    const type = PROCEDURES[name as keyof Api]
    if (!type) return undefined
    return (input?: unknown) => call(name, type, input)
  },
})
