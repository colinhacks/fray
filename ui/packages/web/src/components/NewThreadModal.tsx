import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Backend, DispatchInput, SetDispatchPreferenceInput } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { Composer } from "./Composer.tsx"
import { GithubTrigger } from "./GithubTrigger.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { SignInModal } from "./SignInModal.tsx"
import {
  applyDispatchPreferenceUpdate,
  dispatchProfileGroups,
  resolveDispatchPreferences,
} from "../lib/dispatchPreferences.ts"
import { captureDispatchProfile } from "../lib/githubDispatch.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"

// THE dispatch prompt box — composer + quiet selects row — shared by every surface that can start a
// thread: the queue's inline section and the anywhere-modal. There is no title field — the server
// derives a fallback and Claude names the session itself (ai-title), which the UI prefers for display.
export function DispatchForm({
  autoFocus,
  onDispatched,
  planPath,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  // When present, the dispatch carries this plan artifact path (.fray/plans/*.md) so the worker is
  // oriented to the plan and the thread is associated with it.
  planPath?: string
}) {
  const queryClient = useQueryClient()
  const preferences = useQuery({ queryKey: ["dispatchPreferencesGet"], queryFn: () => rpc.dispatchPreferencesGet() })
  // The codex model catalogue + per-model effort options, from the authoritative ~/.codex cache (never a
  // hand-maintained list). [] until it loads; the option builders fall back to a compiled-in mirror.
  const codexModels = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels() })
  const codexList = codexModels.data ?? []
  const projectDir = useProjectDir()
  // Queue and modal are the same semantic new-thread composer. A plan gets a distinct intent because
  // dispatching it changes the worker's durable context.
  const [prompt, setPrompt, clearPrompt] = useDraft(draftKey.dispatch(projectDir, planPath))
  const promptKey = draftKey.dispatch(projectDir, planPath)
  const submittedDraftRef = useRef("")
  const [pendingDispatch, setPendingDispatch] = useState<string | null>(null)

  // Per-provider LOCAL credential presence, polled so the submit gate has a fresh value without a
  // round-trip on every keystroke. The gate blocks ONLY on a positive "signed-out" (fails open on
  // "unknown"/loading/error), so a stale or missing snapshot can never trap a logged-in user.
  const authStatus = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  // When submit is gated, the built dispatch is stashed here and the sign-in modal opens for this
  // backend; a successful re-check runs the stashed dispatch unchanged.
  const [signInFor, setSignInFor] = useState<Backend | null>(null)
  const gatedInputRef = useRef<DispatchInput | null>(null)

  const preference = useMutation({
    mutationFn: (update: SetDispatchPreferenceInput) => rpc.dispatchPreferenceSet(update),
    // TanStack serializes mutations sharing this scope. This prevents a fast pair of selections from
    // reaching SQLite out of order while optimistic query data keeps every mounted composer in sync.
    scope: { id: "dispatch-preferences" },
    onMutate: (update) => {
      const current = queryClient.getQueryData<Awaited<ReturnType<typeof rpc.dispatchPreferencesGet>>>(["dispatchPreferencesGet"])
      if (current) queryClient.setQueryData(["dispatchPreferencesGet"], applyDispatchPreferenceUpdate(current, update))
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ["dispatchPreferencesGet"] })
      showToast(`Could not save new-thread preference: ${(error as Error).message.slice(0, 80)}`)
    },
  })

  // Dispatch does NOT navigate anywhere: you stay on the queue, the new thread appears in the
  // sidebar, and the toast walks through the lifecycle — an immediate spinner while the server
  // waits out session startup, then a link that opens the thread in the side drawer.
  const dispatch = useMutation({
    mutationFn: (input: DispatchInput) => rpc.dispatch(input),
    onMutate: () => showToast("Starting thread…", { spinner: true, sticky: true }),
    onSuccess: (res) => {
      // The board stream now owns the durable thread row. Drop our local bridge as soon as the
      // server acknowledges it, preventing an optimistic card + server card duplicate.
      setPendingDispatch(null)
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug } })
    },
    onError: (e, input) => {
      // A submit clears before the RPC starts. Restore only into a still-empty field so retry is
      // effortless without overwriting text typed during the failed request.
      if (!draftStore.get(promptKey)) setPrompt(submittedDraftRef.current || input.prompt)
      setPendingDispatch(null)
      // Server-side auth preflight rejection (the client gate can miss on a stale snapshot): open the
      // same sign-in modal with the dispatch stashed, instead of a dead-end failure toast. The server
      // created no thread state, and the draft was restored above.
      const auth = /^AUTH_REQUIRED:(claude|codex)$/.exec((e as Error).message)
      if (auth) {
        gatedInputRef.current = input
        setSignInFor(auth[1] as Backend)
        showToast(`Signed out of ${auth[1] === "claude" ? "Claude" : "Codex"}`, { duration: 3000 })
        return
      }
      showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  // Do not render Opus/high while durable intent is still loading. In particular, a saved Codex model
  // must not be classified as Claude merely because the Codex catalogue has not hydrated yet.
  const controlsReady = !!preferences.data && !!codexModels.data
  const resolved = useMemo(
    () => controlsReady ? resolveDispatchPreferences(preferences.data!, codexList) : undefined,
    [controlsReady, preferences.data, codexList],
  )
  const githubProfile = useMemo(() => captureDispatchProfile(resolved), [resolved])

  function savePreference(update: SetDispatchPreferenceInput) {
    preference.mutate(update)
  }

  // Fire the dispatch and do the one-shot UI bookkeeping (optimistic toast + prompt clear). Called both
  // on a clean submit and after the sign-in gate is cleared, so the prompt is only cleared once the
  // thread is actually being started — a gated submit leaves the draft intact.
  function runDispatch(input: DispatchInput) {
    submittedDraftRef.current = prompt
    clearPrompt()
    setPendingDispatch(input.prompt)
    dispatch.mutate(input)
  }

  function submit() {
    if (!prompt.trim() || !resolved) return
    if (!resolved.modelAvailable) {
      showToast("Saved model is unavailable — choose a model before starting the thread")
      return
    }
    if (!resolved.effortAvailable) {
      showToast("Saved reasoning level is unavailable for this model — choose another level")
      return
    }
    const input: DispatchInput = {
      prompt: prompt.trim(),
      // No permissionMode: the server stamps every created worker with its fixed non-interactive
      // mode (WORKER_DISPATCH_PERMISSION) — dispatch offers no permission choice.
      model: resolved.model,
      backend: resolved.backend,
      effort: resolved.effort as DispatchInput["effort"],
      ...(planPath ? { planPath } : {}),
    }
    // Auth gate: block ONLY on a positive "signed-out" for this dispatch's backend. Loading/unknown/
    // authed all fall through (fail open) so a flaky or slow read never blocks a logged-in user.
    if (authStatus.data?.[resolved.backend] === "signed-out") {
      gatedInputRef.current = input
      setSignInFor(resolved.backend)
      return
    }
    runDispatch(input)
  }

  // The profile/permission readouts live INSIDE the box, along its bottom edge — petite caps,
  // very quiet. Not dropdowns at rest: plain values (mode color-coded like Claude Code's
  // permission palette); hover materializes the border, click opens the menu.
  //
  // useMemo (measured in the render-perf profile): the footer used to be rebuilt inline on every
  // render, so each prompt KEYSTROKE re-rendered every picker tree — ~222 component renders per
  // keystroke. A keystroke only changes `prompt`; keeping the footer element's identity stable lets
  // React bail out of the whole control subtree, and the
  // element is rebuilt exactly when durable preference data or the model catalogue changes.
  const footer = useMemo(() => {
    if (!resolved) {
      return (
        <ProfileGridSelector
          groups={[]}
          value={undefined}
          onValueChange={() => {}}
          placeholder={preferences.isError || codexModels.isError ? "Profile unavailable" : "Profile loading…"}
          ariaLabel="Model and effort loading"
          disabled
        />
      )
    }
    const profileGroups = dispatchProfileGroups(codexList)
    return (
      <ProfileGridSelector
        groups={profileGroups}
        value={{ provider: resolved.backend, model: resolved.model, effort: resolved.effort }}
        onValueChange={(selection) => savePreference({
          field: "profile",
          backend: selection.provider as typeof resolved.backend,
          model: selection.model,
          effort: selection.effort as DispatchInput["effort"] & string,
        })}
        ariaLabel="Model and effort"
        title={resolved.modelAvailable && resolved.effortAvailable
          ? "Model and reasoning effort"
          : "Saved model or reasoning effort unavailable — choose a supported pair"}
        className="max-w-[min(21rem,72vw)]"
      />
    )
  }, [resolved, codexList, preferences.isError, codexModels.isError])

  return (
    <div className="w-full flex flex-col gap-3">
      <Composer
        surface="newComposer"
        autoFocus={autoFocus}
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder="Describe the task…"
        minHeight={96}
        maxHeight={340}
        busy={dispatch.isPending}
        footer={footer}
        leftAction={<GithubTrigger
          profile={githubProfile.ok ? githubProfile.profile : undefined}
          profileError={githubProfile.ok ? undefined : githubProfile.error}
        />}
      />
      {dispatch.isError && (
        <span className="px-0.5 text-[11px] text-red-400 truncate">{(dispatch.error as Error).message}</span>
      )}
      {pendingDispatch && (
        <div data-pending-dispatch role="status" className="rounded-lg border border-border bg-panel-2 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <span>Starting thread…</span>
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{pendingDispatch}</p>
        </div>
      )}
      {signInFor && (
        <SignInModal
          backend={signInFor}
          onClose={() => setSignInFor(null)}
          onAuthed={() => {
            const input = gatedInputRef.current
            gatedInputRef.current = null
            setSignInFor(null)
            if (input) runDispatch(input)
          }}
        />
      )}
    </div>
  )
}

// The anywhere-modal behind the pill button: same form in a centered dialog. Esc closes (captured
// here BEFORE the composer's own Escape-blurs handler can swallow it).
export function NewThreadDialog({ onClose }: { onClose: () => void }) {
  // Seeded from a plan? (store.newThreadPlanPath, set by "Implement this"). The dispatch then
  // carries planPath; a quiet line names the plan the thread works from.
  const planPath = useSnapshot(store).newThreadPlanPath
  const planName = planPath ? planPath.split("/").pop() : null
  const contentRef = useRef<HTMLDivElement>(null)
  // Fray opens this dialog by writing store state, not through RadixDialog.Trigger. Capture the real
  // opener during the mount render so close can restore it explicitly (including plan-drawer openers).
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(() => () => {
    const opener = openerRef.current
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }, 0)
  }, [])
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <RadixDialog.Portal>
        {/* Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
            texture behind the dialog rather than going fully dark. */}
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          ref={contentRef}
          aria-modal="true"
          aria-describedby={undefined}
          onEscapeKeyDown={handleDialogEscape}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const opener = openerRef.current
            if (opener?.isConnected) opener.focus({ preventScroll: true })
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true })
          }}
          className="fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">New thread</RadixDialog.Title>
          {planName && <p className="mb-3 text-[11.5px] text-muted/80">From plan <span className="font-mono-keep text-muted">{planName}</span></p>}
          <DispatchForm autoFocus onDispatched={onClose} planPath={planPath ?? undefined} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    // Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
    // texture behind the dialog rather than going fully dark. z-[200] matches the shared Radix Dialog
    // tier so the centered picker sits ABOVE the sidebar/prompt box (z-[100] on desktop) rather than
    // behind it.
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 backdrop-blur-md backdrop-saturate-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {children}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}
