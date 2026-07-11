import { useMemo, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { useMutation, useQuery } from "@tanstack/react-query"
import { PermissionMode, type DispatchInput } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { Composer } from "./Composer.tsx"
import { GithubTrigger } from "./GithubTrigger.tsx"
import { Select } from "./ui/Select.tsx"
import {
  MODEL_GROUPS_CONCRETE,
  EFFORT_OPTIONS,
  CODEX_EFFORT_OPTIONS,
  EFFORTS,
  PERMISSION_COLOR,
  backendForModel,
  permOptionsFor,
  permValueFor,
  codexEffortValue,
} from "../lib/options.ts"

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
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })

  const [prompt, setPrompt] = useState("")
  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState<(typeof EFFORTS)[number] | "">("")

  // Dispatch does NOT navigate anywhere: you stay on the queue, the new thread appears in the
  // sidebar, and the toast walks through the lifecycle — an immediate spinner while the server
  // waits out session startup, then a link that opens the thread in the side drawer.
  const dispatch = useMutation({
    mutationFn: (input: DispatchInput) => rpc.dispatch(input),
    onMutate: () => showToast("Starting thread…", { spinner: true, sticky: true }),
    onSuccess: (res) => {
      setPrompt("")
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug } })
    },
    onError: (e) => showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`),
  })

  // Every control resolves to a CONCRETE value (shown in the readout): mode from settings, model
  // defaulting to OPUS and effort to HIGH unless settings or the user say otherwise.
  const effectiveMode = permissionMode || (settings.data?.permissionMode ?? "auto")
  const effectiveModel = model || settings.data?.model || "opus"
  const effectiveEffort = effort || settings.data?.effort || "high"
  // The model DRIVES the backend; the permission/effort readouts then present that backend's axis.
  const backend = backendForModel(effectiveModel)

  function submit() {
    if (!prompt.trim()) return
    dispatch.mutate({
      prompt: prompt.trim(),
      // For codex the stored permissionMode is mapped to the sandbox-facing value shown in the
      // readout, so the dispatch carries exactly what the user sees (the server's codexSandbox then
      // maps it to `-s`). Effort is clamped to the codex-accepted set (xhigh/max→high).
      permissionMode: permValueFor(backend, effectiveMode),
      model: effectiveModel,
      backend,
      effort: (backend === "codex" ? codexEffortValue(effectiveEffort) : effectiveEffort) as (typeof EFFORTS)[number],
      ...(planPath ? { planPath } : {}),
    })
  }

  // The mode/model/effort readouts live INSIDE the box, along its bottom edge — petite caps,
  // very quiet. Not dropdowns at rest: plain values (mode color-coded like Claude Code's
  // permission palette); hover materializes the border, click opens the menu.
  //
  // useMemo (measured in the render-perf profile): the footer used to be rebuilt inline on every
  // render, so each prompt KEYSTROKE re-rendered all three Radix Select trees — ~222 component
  // renders per keystroke, ~all of them Select internals. A keystroke only changes `prompt`; keeping
  // the footer element's identity stable lets React bail out of the whole Select subtree, and the
  // element is rebuilt exactly when a readout value actually changes. (The setXxx setters are
  // identity-stable, so the effective values are the complete dependency set.)
  const footer = useMemo(
    () => (
      <>
        <Select
          variant="readout"
          className="petite-caps"
          value={effectiveModel}
          onValueChange={setModel}
          groups={MODEL_GROUPS_CONCRETE}
          ariaLabel="Model"
        />
        <Select
          variant="readout"
          className={`petite-caps ${PERMISSION_COLOR[permValueFor(backend, effectiveMode)]}`}
          value={permValueFor(backend, effectiveMode)}
          onValueChange={(v) => setPermissionMode(v as PermissionMode)}
          options={permOptionsFor(backend)}
          ariaLabel={backend === "codex" ? "Sandbox" : "Permission mode"}
        />
        <Select
          variant="readout"
          className="petite-caps"
          value={backend === "codex" ? codexEffortValue(effectiveEffort) : effectiveEffort}
          onValueChange={(v) => setEffort(v as (typeof EFFORTS)[number])}
          options={backend === "codex" ? CODEX_EFFORT_OPTIONS : EFFORT_OPTIONS_CONCRETE}
          ariaLabel="Effort"
        />
      </>
    ),
    // Model is now FIRST (it drives the backend); `backend` is derived from effectiveModel so it's
    // already covered, but list it so the readout swaps the moment the family changes.
    [effectiveMode, effectiveModel, effectiveEffort, backend],
  )

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
        leftAction={<GithubTrigger />}
      />
      {dispatch.isError && (
        <span className="px-0.5 text-[11px] text-red-400 truncate">{(dispatch.error as Error).message}</span>
      )}
    </div>
  )
}

// Readout option lists have NO empty "default" row — the readout always shows a concrete value. The
// model readout uses the sectioned MODEL_GROUPS_CONCRETE (Claude Code / Codex) directly.
const EFFORT_OPTIONS_CONCRETE = EFFORT_OPTIONS.filter((o) => o.value !== "")

// The anywhere-modal behind the pill button: same form in a centered dialog. Esc closes (captured
// here BEFORE the composer's own Escape-blurs handler can swallow it).
export function NewThreadDialog({ onClose }: { onClose: () => void }) {
  // Seeded from a plan? (store.newThreadPlanPath, set by "New thread from plan"). The dispatch then
  // carries planPath; a quiet line names the plan the thread works from.
  const planPath = useSnapshot(store).newThreadPlanPath
  const planName = planPath ? planPath.split("/").pop() : null
  return (
    <Overlay onClose={onClose}>
      <div
        className="w-[640px] max-w-[86vw] rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50"
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <h2 className="mb-1 text-[14px] font-medium">New thread</h2>
        {planName && <p className="mb-3 text-[11.5px] text-muted/80">From plan <span className="font-mono-keep text-muted">{planName}</span></p>}
        <DispatchForm autoFocus onDispatched={onClose} planPath={planPath ?? undefined} />
      </div>
    </Overlay>
  )
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    // Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
    // texture behind the dialog rather than going fully dark.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-md backdrop-saturate-150"
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
