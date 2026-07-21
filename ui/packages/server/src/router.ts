import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { query, mutation } from "@fray-ui/rpc/server"
import {
  BoardSnapshot,
  AdoptThreadInput,
  AdoptThreadResult,
  DispatchInput,
  FollowUpInput,
  SetThreadSnoozeInput,
  GithubStatus,
  GithubItem,
  GithubListInput,
  GithubBatchInput,
  GithubBatchResult,
  Settings,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  CodexModel,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  RenameThreadInput,
  AiRenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadProfileOptionsResult,
  SetThreadProfileInput,
  SetThreadProfileResult,
  SubmitCodexDraftInput,
  SubmitCodexDraftResult,
  PrepareCodexDraftReplacementInput,
  PrepareCodexDraftReplacementResult,
  ClearAmbiguousCodexInputInput,
  ClearAmbiguousCodexInputResult,
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
  type InteractionRecord,
  type ThreadView,
  ThreadSlug,
} from "@fray-ui/shared"
import type { AppContext } from "./context.ts"
import { runThreadUpdate } from "./fray.ts"
import { repairThreadFile } from "./repair.ts"
import { resumeThread } from "./resume.ts"
import {
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  readTranscriptFile,
} from "./transcript.ts"
import { openExternalUrl } from "./open-external.ts"
import { openLocalFile, resolveOpenableFile } from "./local-file.ts"
import { openableFileRoots } from "./project.ts"
import { ghInstalled, ghAuthed, ghRepo, listItems, hydrateIssue, hydratePr, renderGithubPrompt, effectiveTemplate, DEFAULT_ISSUE_PROMPT, DEFAULT_PR_PROMPT } from "./github.ts"
import { slugify, resolveSlug, resolveLegacyThreadFile } from "./dispatch.ts"
import { readCodexModels } from "./backend/codex-models.ts"
import { readQuota } from "./quota.ts"
import { readAuthSnapshot } from "./backend/auth-status.ts"
import { liveThreadsForBackend, runProviderLogout } from "./backend/account-actions.ts"
import { threadProfileOptions, validateThreadProfile } from "./backend/thread-profiles.ts"
import * as tmux from "./tmux.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { createClaudeRenameController } from "./rename-controller.ts"
import { getDispatchPreferences, setDispatchPreference } from "./dispatch-preferences.ts"
import type { SessionRow, Storage } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"
import { resolvePlanFile, deletePlanFile } from "./plan-files.ts"
import { providerResumeCommand } from "./external-terminal.ts"

const SlugInput = z.object({ slug: ThreadSlug }).strict()

const CLAUDE_GITHUB_PERMISSIONS = new Set(["auto", "default", "acceptEdits", "bypassPermissions"])
const CODEX_GITHUB_PERMISSIONS = new Set(["default", "plan", "bypassPermissions"])

// GitHub is a delayed confirmation flow, so validate its captured tuple again at the final server
// boundary. This intentionally rejects cross-provider permission values and stale model/effort pairs;
// neither is normalized, clamped, or replaced with Settings defaults.
export function validateGithubDispatchProfile(input: z.infer<typeof GithubBatchInput>): void {
  validateThreadProfile(input.backend, input.model, input.effort)
  const permissions = input.backend === "codex" ? CODEX_GITHUB_PERMISSIONS : CLAUDE_GITHUB_PERMISSIONS
  if (!permissions.has(input.permissionMode)) {
    throw new Error(`Unsupported ${input.backend} permission mode: ${input.permissionMode}`)
  }
}

export function githubDispatcherRequest(
  input: z.infer<typeof GithubBatchInput>,
  item: { prompt: string; title: string; slug: string },
): {
  payload: z.infer<typeof DispatchInput>
  options: { backend: z.infer<typeof GithubBatchInput>["backend"] }
} {
  return {
    payload: {
      ...item,
      backend: input.backend,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
    },
    options: { backend: input.backend },
  }
}

export function hasUnresolvedBackgroundOps(thread: {
  subAgents: readonly { state: string }[]
  bgShells: readonly { state: string }[]
}): boolean {
  return thread.subAgents.some((op) => op.state === "running" || op.state === "stale") ||
    thread.bgShells.some((op) => op.state === "running" || op.state === "stale")
}

export function hasPendingPermissionChange(row: { permission_pending?: unknown } | undefined): boolean {
  return row?.permission_pending !== null && row?.permission_pending !== undefined
}

interface RegisteredRuntimeTerminator {
  findExpectedAdoptionPane(expected: tmux.ExpectedAdoptionPane): tmux.AdoptionPaneLookup
  killExpectedAdoptionPane(expected: tmux.ExpectedAdoptionPane): boolean
  killSession(slug: string): void
  isLive(slug: string): boolean
}

// A finalized cold adoption is permanently bound to one exact tmux generation. Destructive UI
// actions must never fall back to the reusable session name: another process may already occupy it
// after the owner exited. Verify token + full tuple, kill that tuple only, then prove it disappeared
// before deleting registry ownership or reporting the worker stopped.
export function stopRegisteredRuntime(
  storage: Pick<Storage, "getAdoptionClaim"> & Partial<Pick<Storage, "getSession" | "getAdoptionRuntimeSnapshot">>,
  row: Pick<SessionRow, "slug" | "session_id" | "runtime_generation">,
  runtime: RegisteredRuntimeTerminator = tmux,
): "absent" | "stopped" {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; nothing was stopped")
  }
  if (binding.kind === "unbound") {
    runtime.killSession(row.slug)
    return "stopped"
  }

  const claim = binding.claim
  const current = runtime.findExpectedAdoptionPane(claim)
  if (current.kind === "absent") return "absent"
  if (current.kind !== "found" || !tmux.isExpectedAdoptionPane(claim, current.pane)) {
    throw new Error("The adopted worker's exact runtime identity is unavailable; nothing was stopped")
  }
  if (!runtime.killExpectedAdoptionPane(claim)) {
    const afterMiss = runtime.findExpectedAdoptionPane(claim)
    if (afterMiss.kind !== "absent") {
      throw new Error("The adopted worker changed before it could be stopped; nothing was stopped")
    }
    return "absent"
  }
  if (runtime.findExpectedAdoptionPane(claim).kind !== "absent") {
    throw new Error("The adopted worker could not be confirmed stopped")
  }
  return "stopped"
}

export function stopRuntimeBySlug(
  storage: Pick<Storage, "getAdoptionClaim" | "getSession">,
  slug: string,
  runtime: RegisteredRuntimeTerminator = tmux,
): { outcome: "absent" | "stopped"; row?: SessionRow } {
  const row = storage.getSession(slug)
  if (row) return { outcome: stopRegisteredRuntime(storage, row, runtime), row }
  if (storage.getAdoptionClaim(slug)) throw new Error("An adoption attempt is in progress; nothing was stopped")
  // A rowless tmux name has no durable owner identity. Even a DB lock cannot make a forked tmux
  // client crash-safe after this process dies, so never issue a reusable-name kill without a row.
  throw new Error("No registered runtime identity is available; nothing was stopped")
}

// A live provider shell is deliberately not synonymous with a live *turn*. Providers keep their
// tmux session around at an idle prompt so a later steer can reuse it. Marking that resting shell
// done is safe to perform immediately (and must still terminate it so it is not orphaned). We ask
// only when the server can see work still being executed. Missing telemetry is intentionally
// conservative: a live, unobservable runtime may still be in the middle of a turn.
export function completionNeedsConfirmation(telemetry: SessionTelemetry | undefined): boolean {
  if (!telemetry) return true

  // These are paused waiting for a person, not churning. They are safe to stop as part of an
  // immediate Done transition; neither is evidence of an executing model/tool turn.
  if (telemetry.permPrompt || telemetry.nativeInputRequired || telemetry.pendingAsk) return false

  if (telemetry.turn === "in-flight") return true

  // An idle parent can still have a background child/shell doing work. `stale` is not proof that
  // it has stopped, so retain the confirmation safeguard rather than silently killing it.
  return telemetry.subAgents.some((op) => op.state === "running" || op.state === "stale") ||
    telemetry.bgShells.some((op) => op.state === "running" || op.state === "stale")
}

// A completion is intentionally stronger than an archive toggle. It first establishes whether the
// *registered* runtime is still executing, and it only records Done after any necessary termination
// has been proved. A live resting shell is stopped and archived in one click; an executing or
// unobservable runtime requires explicit confirmation. Adopted workers stay bound to their exact
// pane tuple; a same-name replacement is never killed or mistaken for the original worker.
export function completeRegisteredThread(
  storage: Pick<Storage,
    "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession" | "completeIfCurrent"
  >,
  row: SessionRow,
  terminateLive: boolean,
  runtime: RegisteredRuntimeTerminator = tmux,
  telemetry?: SessionTelemetry,
): { needsConfirmation: boolean } {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; nothing was changed")
  }
  const live = binding.kind === "unbound"
    ? runtime.isLive(row.slug)
    : (() => {
        const current = runtime.findExpectedAdoptionPane(binding.claim)
        if (current.kind === "unknown") {
          throw new Error("The session's runtime identity is unavailable; nothing was changed")
        }
        return current.kind === "found" && !current.pane.dead
      })()

  if (live && !terminateLive && completionNeedsConfirmation(telemetry)) return { needsConfirmation: true }
  if (live) {
    stopRegisteredRuntime(storage, row, runtime)
    // For standalone sessions this is the postcondition that turns tmux's idempotent kill into a
    // safe completion operation. An adopted binding is already verified by stopRegisteredRuntime.
    if (binding.kind === "unbound" && runtime.isLive(row.slug)) {
      throw new Error("The session could not be confirmed stopped; it was not marked done")
    }
  }

  const generation = row.runtime_generation ?? 0
  if (!storage.completeIfCurrent(row.slug, row.session_id, generation)) {
    throw new Error("This thread resumed or was replaced while it was being completed; the new worker was preserved")
  }
  return { needsConfirmation: false }
}

export function stopAndForgetRegisteredRuntime(
  storage: Pick<Storage,
    "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession" | "forgetSessionIfCurrent"
  >,
  row: SessionRow,
  runtime: RegisteredRuntimeTerminator = tmux,
): SessionRow {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread changed while it was being dismissed; nothing was removed")
  }
  const expected = {
    sessionId: row.session_id,
    runtimeGeneration: row.runtime_generation ?? 0,
    adoptionAttemptToken: binding.kind === "bound" ? binding.claim.attempt_token : null,
  }
  stopRegisteredRuntime(storage, row, runtime)
  const forgotten = storage.forgetSessionIfCurrent(row.slug, expected)
  if (!forgotten) {
    throw new Error("This thread resumed or was replaced while it was being dismissed; the new worker was preserved")
  }
  return forgotten
}

// The typed RPC surface. Every handler is thin: state mutations go through fray scripts
// (thread files) or tmux (agents), then rebuild the board so a fresh snapshot fans out on SSE.
export function createRouter(ctx: AppContext) {
  const frayDir = join(ctx.project.dir, ".fray")
  // Roots for the file-OPEN action + the inline-code path classifier (see openableFileRoots): shared so
  // a path the resolver blesses is exactly a path the open action will accept.
  const openRoots = openableFileRoots(ctx.project)
  const claudeRename = createClaudeRenameController({ storage: ctx.storage, tailer: ctx.tailer, board: ctx.board })

  // An auto-titled registry row is session-first authority. A same-slug `.fray/<slug>.md` may have
  // been planted independently and is never a readable or writable extension of that session.
  function isAutoTitledSession(slug: string): boolean {
    return ctx.storage.getSession(slug)?.title_auto === 1
  }

  function assertLegacyMutationAllowed(slug: string): void {
    if (isAutoTitledSession(slug)) {
      throw new Error("session-first auto-titled threads do not own a legacy thread file")
    }
  }

  // Every interaction RPC re-derives the project from this server and binds the requested slug to the
  // CURRENT registered session id. Foreign transcripts have no registry row; a stale page holding a
  // replaced session id fails closed instead of reading or answering the replacement's requests.
  function interactionScope(slug: string, sessionId: string) {
    const row = ctx.storage.getSession(slug)
    if (!row || row.session_id !== sessionId) throw new Error("interaction is not available for this project session")
    return { projectId: ctx.project.id, threadSlug: slug, sessionId }
  }

  // Add only the provider-neutral action effect needed by a client. Adapter delivery rows contain
  // transport ids, durable provider responses, and context that must never cross the RPC boundary.
  // A terminal journal row wins and carries no delivery effect; pending/terminal disagreement fails
  // closed as reconnect-required rather than resurrecting buttons.
  function interactionForRead(
    scope: ReturnType<typeof interactionScope>,
    interaction: InteractionRecord,
  ): InteractionRecord {
    if (interaction.lifecycle !== "pending") return interaction
    const delivery = ctx.interactions.providerDelivery(scope, interaction.id)
    if (!delivery) return interaction
    const effect = delivery.state === "queued" || delivery.state === "sent"
      ? "sending" as const
      : delivery.state === "awaiting-user" &&
          ctx.codexAppServer?.ownsInteraction(scope, interaction.id) === true
        ? "awaiting-user" as const
        : "reconnect-required" as const
    return { ...interaction, delivery: { effect } }
  }

  // Resolve the repo owner/name for a GitHub call. A POSITIVE boot cache short-circuits (stable, no
  // gh call — the common path). A null/absent cache is NOT trusted: it can be the boot race (cache not
  // resolved yet) OR an unauthed-at-boot detection (`gh repo view` needs auth), so fall back to a live
  // ghRepo and WARM the cache on success — this makes a post-boot `gh auth login` light up the feature
  // without a server restart. Never throws (ghRepo swallows failures → null).
  async function resolveRepo(): Promise<string | null> {
    const cached = ctx.github?.nameWithOwner
    if (cached) return cached
    const live = await ghRepo(ctx.project.dir)
    if (live) {
      if (ctx.github) {
        ctx.github.inRepo = true
        ctx.github.nameWithOwner = live
      } else {
        ctx.github = { installed: true, inRepo: true, nameWithOwner: live }
      }
    }
    return live
  }

  return {
    board: query({
      output: BoardSnapshot,
      handler: () => ctx.board.snapshot(),
    }),

    threadBody: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        if (isAutoTitledSession(input.slug)) return { markdown: "" }
        const file = resolveLegacyThreadFile(ctx.project.dir, input.slug)
        if (!file) return { markdown: "" }
        // Use the bytes read under the resolver's before/after lstat checks. Reopening `file.path`
        // here would reintroduce a symlink-swap window after containment had already succeeded.
        return { markdown: file.contents.toString("utf8") }
      },
    }),

    // The full conversation, parsed mechanically from the session JSONL. Chat-first UI renders
    // this by default; the raw terminal is the power-user toggle.
    threadTranscript: query({
      input: SlugInput,
      output: TranscriptPage,
      handler: async ({ input }) => {
        // Registry row → its session's transcript; foreign slug (a session id) → resolved directly; else [].
        // backendFor routes a codex thread through the codex rollout reader (else it renders empty).
        return readLatestThreadTranscriptPage(ctx.project, ctx.storage, input.slug, ctx.backendFor)
      },
    }),

    // One bounded backward step through the canonical projected transcript. The cursor excludes the
    // already-visible anchor and is rejected on session/runtime/transcript replacement.
    threadTranscriptEarlier: query({
      input: TranscriptEarlierInput,
      output: TranscriptPage,
      handler: async ({ input }) => {
        return readEarlierThreadTranscriptPage(ctx.project, ctx.storage, input.slug, input.cursor, ctx.backendFor)
      },
    }),

    // Runtime adapters create interactions internally. React gets only scoped reads and terminal
    // transitions; there is deliberately no public/provider-spoofable create RPC.
    pendingInteractions: query({
      input: ListInteractionsInput,
      output: ListInteractionsResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        return { interactions: ctx.interactions.listPending(scope).map((interaction) => interactionForRead(scope, interaction)) }
      },
    }),

    interactionGet: query({
      input: GetInteractionInput,
      output: GetInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        const interaction = ctx.interactions.get(scope, input.interactionId)
        if (!interaction) throw new Error("interaction is not available for this project session")
        return { interaction: interactionForRead(scope, interaction) }
      },
    }),

    interactionResolve: mutation({
      input: ResolveInteractionInput,
      output: ResolveInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        const delivery = ctx.interactions.providerDelivery(scope, input.interactionId)
        let result
        if (delivery) {
          if (!ctx.codexAppServer || !ctx.codexAppServer.ownsInteraction(scope, input.interactionId)) {
            throw new Error("provider-backed interaction is unavailable until its provider bridge reconnects")
          }
          const providerResult = await ctx.codexAppServer.resolveInteraction(scope, input)
          if (!providerResult) throw new Error("provider-backed interaction lost its durable delivery owner")
          result = {
            effect: providerResult.effect === "already-sent" ? "already-queued" as const : providerResult.effect,
            interaction: providerResult.interaction,
          }
        } else {
          result = ctx.interactions.resolve(scope, input)
        }
        // The journal result contains only the persisted/redacted response. Secret input values are
        // never echoed by this RPC (and are absent from SQLite before this function returns). Re-read
        // after provider I/O: its acknowledgement may have won the race and terminalized the journal
        // while the bridge still holds the pending object returned by its earlier queue transaction.
        const latest = ctx.interactions.get(scope, result.interaction.id) ?? result.interaction
        return {
          effect: latest.lifecycle === "resolved" &&
              (result.effect === "queued" || result.effect === "already-queued")
            ? "resolved" as const
            : result.effect,
          interaction: interactionForRead(scope, latest),
        }
      },
    }),

    interactionCancel: mutation({
      input: CancelInteractionInput,
      output: CancelInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        if (ctx.interactions.providerDelivery(scope, input.interactionId)) {
          // Provider cancellation is an advertised decision that must traverse the acknowledged
          // delivery path. A local-only terminal transition would strand the app-server request.
          throw new Error("provider-backed interaction must use its advertised cancel decision")
        }
        const result = ctx.interactions.cancel(scope, input)
        return { effect: result.effect, interaction: result.interaction }
      },
    }),

    // A live/stale background sub-agent's OWN transcript, for the drill-in drawer that overlays the
    // thread. Resolves the tracked child (thread slug + dispatch tool_use id) to its output JSONL, then
    // parses it with the same mechanical extractor. Never throws: an unknown/dropped id (completed
    // children leave tracking on their terminal notification) or an unreadable file → an empty
    // transcript with state "gone", which the drawer renders as its quiet "unavailable" state.
    subAgentTranscript: query({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({ messages: z.array(TranscriptMessage), state: z.enum(["running", "stale", "done", "gone"]) }),
      handler: async ({ input }) => {
        const info = ctx.tailer.subAgent(input.slug, input.id)
        if (!info) return { messages: [], state: "gone" as const }
        const messages = info.outputFile ? readTranscriptFile(info.outputFile) : []
        return { messages, state: info.state }
      },
    }),

    dispatch: mutation({
      input: DispatchInput,
      output: z.object({ slug: ThreadSlug, sessionId: z.string() }),
      // Forward the picker-selected backend into the dispatch opts seam (Codex-support epic, Phase 3).
      // Omitted ⇒ the dispatcher defaults to "claude", so an old client (no backend field) is
      // byte-identical. The resume path needs NO analog — resume reads the backend from the row's
      // `backend` column (backendFor(row.backend)), which dispatch already stamped for a codex thread.
      handler: ({ input }) => ctx.dispatcher.dispatch(input, { backend: input.backend }),
    }),

    // Cold-adopt a pre-existing thread (no session row): spawn a fresh worker on its file.
    adoptThread: mutation({
      input: AdoptThreadInput,
      output: AdoptThreadResult,
      handler: ({ input }) => ctx.dispatcher.adopt(input.slug, input.message),
    }),

    followUp: mutation({
      input: FollowUpInput,
      handler: async ({ input }) => {
        // Codex's TUI drops Enter when it follows literal text in the same instant, and an active turn
        // explicitly requires Tab to queue. Persist + capture-gate that path; Claude keeps its native
        // live injection, and any dead session resumes through the backend command.
        const row = ctx.storage.getSession(input.slug)
        if (hasPendingPermissionChange(row)) {
          throw new Error("Wait for the current permission change to finish before sending a follow-up")
        }
        if (row?.backend === "codex") {
          const binding = adoptionRuntimeBinding(ctx.storage, row)
          if (binding.kind === "conflict") {
            throw new Error("This thread has a competing adoption attempt; no worker was contacted")
          }
          const live = binding.kind === "bound"
            ? tmux.findExpectedAdoptionPane(binding.claim).kind === "found"
            : tmux.isLive(input.slug)
          if (live) {
            ctx.permissionController.queueFollowUp(input.slug, input.message, input.deliveryId)
            ctx.storage.setSnoozedUntil(input.slug, null)
            ctx.board.refresh()
            return
          }
        }
        resumeThread({ project: ctx.project, storage: ctx.storage, board: ctx.board, getSettings: ctx.getSettings, backendFor: ctx.backendFor }, input.slug, input.message)
        ctx.storage.setSnoozedUntil(input.slug, null)
        ctx.board.refresh()
      },
    }),

    // Per-thread permission/sandbox control. Idle conversations reattach with backend-native launch
    // flags; active work, pending approvals, and unsent native drafts fail closed with a precise error.
    setThreadPermission: mutation({
      input: SetThreadPermissionInput,
      output: SetThreadPermissionResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((t) => t.id === input.slug)
        if (!thread || thread.foreign || thread.kind !== "session") throw new Error(`thread ${input.slug} is not editable`)
        return ctx.permissionController.request(input.slug, input.permissionMode)
      },
    }),

    threadProfileOptions: query({
      input: ThreadProfileOptionsInput,
      output: ThreadProfileOptionsResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not editable`)
        return threadProfileOptions(row.backend)
      },
    }),

    setThreadProfile: mutation({
      input: SetThreadProfileInput,
      output: SetThreadProfileResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.foreign || thread.kind !== "session") throw new Error(`thread ${input.slug} is not editable`)
        if (!ctx.profileController) throw new Error("Runtime profile controls are unavailable; restart Fray and retry")
        return ctx.profileController.request(input.slug, { model: input.model, effort: input.effort })
      },
    }),

    // Explicit recovery for a pre-existing Codex TUI draft. The controller re-captures and validates
    // the composer at click time, persists a delivery barrier, then uses only the backend-advertised
    // idle Enter / active Tab path. It never clears or rewrites the draft.
    submitCodexDraft: mutation({
      input: SubmitCodexDraftInput,
      output: SubmitCodexDraftResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((t) => t.id === input.slug)
        if (!thread || thread.foreign || thread.backend !== "codex") throw new Error(`thread ${input.slug} is not an editable Codex session`)
        return ctx.permissionController.submitExistingDraft(input.slug)
      },
    }),

    // This recovery is intentionally read-only. The operator receives the queued text to paste
    // after manually replacing the terminal draft; no transport claims a compare-and-swap it lacks.
    prepareCodexDraftReplacement: query({
      input: PrepareCodexDraftReplacementInput,
      output: PrepareCodexDraftReplacementResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((t) => t.id === input.slug)
        if (!thread || thread.foreign || thread.backend !== "codex") throw new Error(`thread ${input.slug} is not an editable Codex session`)
        return ctx.permissionController.prepareCodexDraftReplacement(input.slug)
      },
    }),

    // A submitted key is never replayed automatically: if transcript confirmation never arrives,
    // the human explicitly acknowledges that ambiguity and removes only that queue barrier.
    clearAmbiguousCodexInput: mutation({
      input: ClearAmbiguousCodexInputInput,
      output: ClearAmbiguousCodexInputResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((t) => t.id === input.slug)
        if (!thread || thread.foreign || thread.backend !== "codex") throw new Error(`thread ${input.slug} is not an editable Codex session`)
        return ctx.permissionController.clearAmbiguousCodexInput(input.slug)
      },
    }),

    // Archive = hide the row (UI flag) AND settle the fray doc: a non-terminal thread gets
    // status: done written to its frontmatter. Respawn/resume un-archives the row.
    archiveThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.setArchived(input.slug, true)
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (!isAutoTitledSession(input.slug) && t && t.status !== "done" && t.status !== "dismissed") {
          await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"]).catch(() => {})
        }
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    markRead: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.markRead(input.slug)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Read/seen telemetry only: opening a thread records both seen_at and last_read_at. Queue
    // membership is lifecycle-driven, so viewing a resting handoff never acknowledges or removes it.
    // No-op for a foreign thread (no registry row — foreign threads never enter the queue).
    threadSeen: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) return
        const at = new Date().toISOString()
        ctx.storage.setSeenAt(input.slug, at)
        ctx.storage.markRead(input.slug, at)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Explicit lifecycle write for session threads: Archive (the done-card button / row action) and
    // Reopen. This is the ONLY writer of state='archived' — the done fence itself mutates nothing
    // (maintainer-settled). Touches only ui.db; never the .fray legacy files.
    setThreadState: mutation({
      input: z.object({ slug: ThreadSlug, state: z.enum(["open", "archived"]) }).strict(),
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`no session registered for ${input.slug}`)
        ctx.storage.setState(input.slug, input.state)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // “Mark as done” stops a resting provider shell and archives in one action. The server—not the
    // client—asks for confirmation only when current telemetry shows an executing/ambiguous turn.
    completeThread: mutation({
      input: z.object({ slug: ThreadSlug, terminateLive: z.boolean().default(false) }).strict(),
      output: z.object({ needsConfirmation: z.boolean() }),
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`no session registered for ${input.slug}`)
        const result = completeRegisteredThread(ctx.storage, row, input.terminateLive, tmux, ctx.tailer.get(input.slug))
        if (!result.needsConfirmation) ctx.board.refresh()
        return result
      },
    }),

    // Durable manual snooze. The client sends one exact UTC instant derived from its local picker;
    // Archive clears it, and a human follow-up wakes immediately. The operator may deliberately park
    // any queue reason—including an unresolved ask, permission prompt, or crash—until this deadline.
    setThreadSnooze: mutation({
      input: SetThreadSnoozeInput,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`no session registered for ${input.slug}`)
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.kind !== "session" || thread.foreign) throw new Error(`thread ${input.slug} is not editable`)
        if (input.until !== null) {
          if (thread.state === "archived") throw new Error("Reopen this thread before snoozing it")
          if (Date.parse(input.until) <= Date.now()) throw new Error("Snooze time must be in the future")
        }
        ctx.storage.setSnoozedUntil(input.slug, input.until)
        ctx.board.refresh()
      },
    }),

    // Dismiss/forget: the HARD-DELETE verb for a stalled/exited phantom the user wants GONE, not merely
    // shelved (Archive = state='archived', still listed in Inactive). Removes the registry row AND
    // tombstones its transcript id so a log-dir rescan / foreign-discovery can never resurrect it, then
    // drops the tailer's in-memory state. GATED on a NOT-live row: only a thread whose derived runtime is
    // "exited" (a dead pane, or a boot-failure "Stalled" session degradeIfNoTranscript flags) can be
    // forgotten — a genuinely-live session (running / turn-idle / perm-prompt) is refused so it can't be
    // yanked out from under itself. Idempotent: an already-forgotten slug no-ops.
    forgetThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) {
          if (ctx.storage.getAdoptionClaim(input.slug)) {
            throw new Error("An adoption attempt is in progress; nothing was dismissed")
          }
          return // already gone — idempotent
        }
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (t && t.runtime !== "exited") {
          throw new Error("only a stalled or exited session can be dismissed — archive a live one instead")
        }
        stopAndForgetRegisteredRuntime(ctx.storage, row)
        ctx.tailer.forget(input.slug)
        ctx.board.refresh() // storage-only change — the removed row fans out as a delete delta on SSE
      },
    }),

    // A plan artifact's markdown. The exact resolver used by board discovery requires direct,
    // non-symlink parent directories and a stable no-follow direct `.md` child, so an RPC path cannot
    // traverse, follow an indirect file, or win a check/read replacement race.
    planBody: query({
      input: z.object({ path: z.string() }),
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        const file = resolvePlanFile(ctx.project.dir, input.path)
        return { markdown: file?.contents.toString("utf8") ?? "" }
      },
    }),

    // Hard-delete a plan artifact (.fray/plans/*.md). Same secure resolver as planBody gates it, so a
    // traversal / symlink / indirect target unlinks nothing; an already-gone plan is idempotent. A real
    // filesystem failure re-throws out of deletePlanFile and surfaces as an RPC error. rebuild() (NOT the
    // overlay-only refresh()) recomputes the plans cache so the removed plan drops immediately rather than
    // only when the .fray watcher's debounced rebuild later catches up.
    planDelete: mutation({
      input: z.object({ path: z.string() }),
      handler: async ({ input }) => {
        deletePlanFile(ctx.project.dir, input.path)
        await ctx.board.rebuild()
      },
    }),

    // The thread's scratchpad (.fray/threads/<session-id>/scratch.md) — the worker's compaction-proof
    // working memory, rendered as the thread's doc tab. "" when never provisioned / foreign.
    threadScratchpad: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) return { markdown: "" }
        try {
          return { markdown: readFileSync(join(frayDir, "scratch", `${row.session_id}.md`), "utf8") }
        } catch {
          return { markdown: "" }
        }
      },
    }),

    // Copy only a provider-native resume invocation. The board snapshot is the ownership authority:
    // a row in SQLite alone is insufficient if it is no longer an owned session view. The command is a
    // provider-native `claude --resume`/`codex resume` that attaches a SECOND client to the same session
    // — it never touches Fray's private tmux pane — so it is offered in every runtime state, live too
    // (see the handler body). Do not return a command for foreign discovery, legacy docs, or an
    // absent/replaced registry row.
    threadTerminalCommand: query({
      input: SlugInput,
      output: z.object({ command: z.string().nullable(), mode: z.enum(["resume", "unavailable"]), reason: z.string().nullable() }),
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!row || !thread || thread.kind !== "session" || thread.foreign) {
          throw new Error("No Fray-owned terminal session is available for this thread")
        }
        // Resuming the SAME session from another terminal is safe and supported by both CLIs whether or
        // not Fray is still driving it (a live session simply gets a second attached view; cards in the
        // queue are at rest anyway). So offer the command in every runtime state, gated only on a real
        // provider-native id existing — no paternalistic "wait for it to exit" block.
        const backend = row.backend
        if (backend === "claude" || backend === "codex") {
          // Claude pins session_id via --session-id, so its native id IS session_id. Codex mints its OWN
          // rollout id (agent_session_id), discovered shortly after spawn; the Fray UUID would not resume
          // it, so require the discovered id rather than falling back to session_id.
          const nativeId = backend === "codex" ? row.agent_session_id : (row.agent_session_id ?? row.session_id)
          if (nativeId) {
            return {
              command: providerResumeCommand(backend, ctx.project.dir, nativeId),
              mode: "resume" as const,
              reason: null,
            }
          }
          if (backend === "codex") {
            return {
              command: null,
              mode: "unavailable" as const,
              reason: "Codex hasn't reported its resumable session id yet — it appears once the first turn begins.",
            }
          }
        }
        return {
          command: null,
          mode: "unavailable" as const,
          reason: "This Fray-owned thread has no verified provider session available to resume.",
        }
      },
    }),

    // Route a link clicked inside the chromeless Chrome --app window to the OS default browser.
    // Without this, http(s) links open within our dedicated user-data-dir profile — the
    // "anonymous Chrome window" the user reported. Validation lives in open-external.ts, which
    // rejects any non-http(s) scheme and spawns `open`/`xdg-open` with an args array (no shell).
    openExternal: mutation({
      input: z.object({ url: z.string() }),
      handler: async ({ input }) => {
        openExternalUrl(input.url)
      },
    }),

    // A local file can be opened only after its canonical real path is contained by the openable roots
    // (home-and-below + temp + project). The HTTP layer already rejects non-local/mismatched origins;
    // this gate means the endpoint never becomes arbitrary remote-origin or whole-filesystem access.
    openLocalFile: mutation({
      input: z.object({ path: z.string(), image: z.boolean().optional() }).strict(),
      output: z.object({ action: z.enum(["opened", "copy"]), path: z.string() }),
      handler: async ({ input }) => openLocalFile(
        input.path,
        ctx.getSettings().localFileOpener ?? "system",
        openRoots,
        { forceSystem: input.image === true },
      ),
    }),

    // Batch-classify path REFERENCES (as they appear in inline code) → their canonical openable path, or
    // null when a candidate doesn't resolve to a real file under the openable roots. The client renders
    // resolved ones as clickable inline code (opened via openLocalFile). Pure read: it only realpath-
    // resolves + stats within the gate, never opening a file nor revealing existence outside it.
    resolveLocalPaths: query({
      input: z.object({ paths: z.array(z.string().max(1024)).max(128) }).strict(),
      output: z.object({ resolved: z.array(z.object({ input: z.string(), path: z.string().nullable() })) }),
      handler: async ({ input }) => {
        const memo = new Map<string, string | null>()
        const resolved = input.paths.map((raw) => {
          if (!memo.has(raw)) memo.set(raw, resolveOpenableFile(raw, ctx.project.dir, openRoots))
          return { input: raw, path: memo.get(raw) ?? null }
        })
        return { resolved }
      },
    }),

    markComplete: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"])
        ctx.storage.markRead(input.slug)
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Assign ANY status (the "Mark as <status>" split button): the exact fray status the human picks.
    // Dismissing also ends the live agent session (same side-effect the Dismiss verb carries).
    setThreadStatus: mutation({
      input: z.object({ slug: ThreadSlug, status: z.enum(["active", "planning", "planned", "needs-human", "blocked", "done", "dismissed"]) }).strict(),
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        if (input.status === "dismissed") {
          const stopped = stopRuntimeBySlug(ctx.storage, input.slug)
          if (stopped.row && !ctx.storage.setExitedIfCurrent(
            stopped.row.slug,
            stopped.row.session_id,
            stopped.row.runtime_generation ?? 0,
            true,
          )) {
            throw new Error("This thread resumed or was replaced while it was being stopped; the new worker was preserved")
          }
        }
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", input.status])
        if (input.status === "done" || input.status === "dismissed") ctx.storage.markRead(input.slug)
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // One-click recovery for a malformed thread file: PREPEND minimal frontmatter to a thread .md that
    // has none (see repair.ts for the guards + why it's deliberately conservative), then rebuild the
    // board so the healed thread appears in the queue/status system. Repairs the missing-frontmatter
    // case ONLY — the write hook already blocks compliant workers; this catches the stragglers.
    repairThread: mutation({
      input: z.object({ file: z.string() }),
      output: z.object({ slug: ThreadSlug }),
      handler: async ({ input }) => {
        const candidate = input.file.match(/^([a-z0-9][a-z0-9-]*)\.md$/)?.[1]
        if (candidate) assertLegacyMutationAllowed(candidate)
        const { slug } = repairThreadFile(frayDir, input.file)
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, fresh snapshot fans out on SSE (watcher also fires)
        return { slug }
      },
    }),

    dismissThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "dismissed"])
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Persist a HUMAN display title in Fray's session registry. This deliberately does not inject a
    // backend slash command: Codex and Claude expose different rename behavior, the process need not
    // be idle/live, and transcript ai-title records must never be allowed to replace explicit intent.
    renameThread: mutation({
      input: RenameThreadInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`thread ${input.slug} is not editable`)
        if (claudeRename.isPending(input.slug)) throw new Error("AI rename is still in progress; wait for it to finish before setting a manual title")
        ctx.storage.setTitle(input.slug, input.title)
        ctx.board.refresh() // storage-only overlay; publishes an immediate board delta to every client
      },
    }),

    aiRenameThread: mutation({
      input: AiRenameThreadInput,
      output: AiRenameThreadResult,
      handler: ({ input }) => claudeRename.rename(input.slug),
    }),

    killAgent: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        const stopped = stopRuntimeBySlug(ctx.storage, input.slug)
        if (stopped.row && !ctx.storage.setExitedIfCurrent(
          stopped.row.slug,
          stopped.row.session_id,
          stopped.row.runtime_generation ?? 0,
          true,
        )) {
          throw new Error("This thread resumed or was replaced while it was being stopped; the new worker was preserved")
        }
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // The selectable Codex models + PER-MODEL effort options, read fresh (short TTL) from the
    // authoritative ~/.codex/models_cache.json so the picker tracks codex's own catalogue instead of a
    // hand-maintained list. Degrades to a minimal fallback (never throws) when the cache is absent.
    codexModels: query({
      output: z.array(CodexModel),
      handler: async () => readCodexModels(),
    }),

    // Provider subscription quota (5h + weekly rate-limit windows) for the sidebar status bar. Codex
    // reads clean from the rollout JSONL fray already tails; Claude best-effort via its undocumented
    // OAuth usage endpoint. Never throws — degrades to per-provider "unavailable".
    quota: query({
      output: QuotaSnapshot,
      handler: async () => readQuota(),
    }),

    // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from `quota`
    // (whose "unavailable" is overloaded with transient endpoint failures): this reports only whether a
    // credential exists, so a dispatch can be blocked on a genuine "signed-out" without false-blocking
    // on a network blip. Never throws — degrades to per-provider "unknown", on which the gate fails open.
    authStatus: query({
      output: AuthSnapshot,
      handler: async () => readAuthSnapshot(),
    }),

    // Typed provider account action behind the `/logout` alias + confirm dialog (claude-auth plan).
    // Refuses to race a live turn for that provider (account state is process-global), then runs the
    // exact provider CLI argv without a shell and reports the post-attempt credential state.
    accountLogout: mutation({
      input: AccountLogoutInput,
      output: AccountLogoutResult,
      handler: async ({ input }) => {
        const snapshot = await ctx.board.snapshot()
        return runProviderLogout({
          backend: input.backend,
          claudeBin: ctx.claudeBin,
          liveThreads: liveThreadsForBackend(snapshot.threads, input.backend),
        })
      },
    }),

    settingsGet: query({
      output: Settings,
      handler: async () => ctx.getSettings(),
    }),

    settingsSet: mutation({
      input: Settings,
      output: Settings,
      handler: async ({ input }) => ctx.setSettings(input),
    }),

    // Clear the stored settings blob so defaults (incl. the shipped default preamble) apply again.
    settingsReset: mutation({
      input: z.object({}),
      output: Settings,
      handler: async () => ctx.resetSettings(),
    }),

    dispatchPreferencesGet: query({
      output: DispatchPreferences,
      handler: async () => getDispatchPreferences(ctx.storage, ctx.getSettings(), readCodexModels()),
    }),

    dispatchPreferenceSet: mutation({
      input: SetDispatchPreferenceInput,
      output: DispatchPreferences,
      handler: async ({ input }) => setDispatchPreference(ctx.storage, ctx.getSettings(), input, readCodexModels()),
    }),

    // The shipped GitHub batch-dispatch prompt templates (single source of truth: server/github.ts).
    // The Settings UI reads these to prefill the editors for editing and to power "reset to default";
    // an empty/unset githubIssuePrompt/githubPrPrompt setting means the server uses exactly these.
    githubPromptDefaults: query({
      output: z.object({ issue: z.string(), pr: z.string() }),
      handler: async () => ({ issue: DEFAULT_ISSUE_PROMPT, pr: DEFAULT_PR_PROMPT }),
    }),

    // ---- GitHub-first batch dispatch ----

    // gh availability: installed (cached, else live) + inRepo/nameWithOwner (cache-warmed resolveRepo)
    // + a LIVE authed re-check (never cached — a mid-session `gh auth login` reflects on the next
    // query). The repo is resolved only when authed (gh repo view needs auth), so a cached-negative
    // inRepo from an unauthed/racy boot never sticks. Never throws (all probes degrade to false/null).
    githubStatus: query({
      output: GithubStatus,
      handler: async () => {
        const installed = ctx.github?.installed ?? (await ghInstalled())
        if (!installed) return { installed: false, inRepo: false, nameWithOwner: null, authed: false }
        const authed = await ghAuthed()
        const nameWithOwner = authed ? await resolveRepo() : (ctx.github?.nameWithOwner ?? null)
        return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner, authed }
      },
    }),

    // The repo's issues or PRs, gh-sorted (recency or reactions). Empty when this isn't a GitHub repo.
    // resolveRepo warms/uses the cache with a live fallback (so a post-boot sign-in works). A gh error
    // (rate limit / network) propagates → surfaced to the client as a failed query (risk 7), rather
    // than silently reading as "no items".
    githubList: query({
      input: GithubListInput,
      output: z.object({ items: z.array(GithubItem) }),
      handler: async ({ input }) => {
        const repo = await resolveRepo()
        if (!repo) return { items: [] }
        return { items: await listItems(repo, input.kind, input.sort, input.limit) }
      },
    }),

    // Spin up one fray thread per checked item: hydrate each fresh from gh, template a server-side
    // prompt (single source of truth, unit-tested), then REUSE ctx.dispatcher.dispatch (no new spawn
    // logic). SEQUENTIAL — a burst of 20 concurrent tmux spawns would hammer the box (risk 5). A
    // per-item failure is captured in `failed[]` and never aborts the rest of the batch.
    githubDispatchBatch: mutation({
      input: GithubBatchInput,
      output: GithubBatchResult,
      handler: async ({ input }) => {
        validateGithubDispatchProfile(input)
        const repo = await resolveRepo()
        if (!repo) throw new Error("not a GitHub repo")
        // Read the templates ONCE per batch: the user's Settings override (githubIssuePrompt /
        // githubPrPrompt) when non-blank, else the exported default (effectiveTemplate decides).
        const settings = ctx.getSettings()
        const dispatched: { number: number; kind: string; slug: string }[] = []
        const failed: { number: number; kind: string; error: string }[] = []
        for (const it of input.items) {
          try {
            // Explicit title skips the fallback-chop so the slug reads investigate-owner-repo-N. RESERVE
            // the slug here with the SAME predicate dispatch uses (existing .fray file / registry row)
            // and pass it EXPLICITLY, so the prompt's THREAD tag equals the real dispatched slug even on
            // a collision (re-dispatch / duplicate items) — otherwise the worker would write a ghost
            // .fray/<base>.md disjoint from the -2 registry row (resolveSlug is idempotent on a free slug).
            const title = `${it.kind === "issue" ? "Investigate" : "Review"} ${repo}#${it.number}`
            const slug = resolveSlug(frayDir, slugify(title), (s) => ctx.storage.getSession(s) !== undefined)
            const template = effectiveTemplate(it.kind, it.kind === "issue" ? settings.githubIssuePrompt : settings.githubPrPrompt)
            const hydrated = it.kind === "issue" ? await hydrateIssue(repo, it.number) : await hydratePr(repo, it.number)
            const prompt = renderGithubPrompt(template, repo, hydrated, slug, it.kind)
            const request = githubDispatcherRequest(input, { prompt, title, slug })
            const res = await ctx.dispatcher.dispatch(request.payload, request.options)
            dispatched.push({ number: it.number, kind: it.kind, slug: res.slug })
          } catch (e) {
            failed.push({ number: it.number, kind: it.kind, error: (e as Error).message.slice(0, 120) })
          }
        }
        return { dispatched, failed }
      },
    }),
  }
}

export type AppRouter = ReturnType<typeof createRouter>
