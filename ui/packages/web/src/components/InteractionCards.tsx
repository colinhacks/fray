import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ExternalLink, KeyRound, ShieldCheck } from "lucide-react"
import type {
  InteractionField,
  InteractionRecord,
  InteractionValues,
  ThreadView,
} from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import {
  failClosedAmbiguousInteraction,
  interactionRecordKey,
  pendingInteractionsKey,
  reconcileCachedInteraction,
} from "../api/interaction-cache.ts"
import { pendingInteractionScope, usePendingInteractions } from "../hooks.ts"
import { ApprovalDetails } from "./ApprovalDetails.ts"
import {
  canonicalInteractionDecisions,
  initialInteractionDraft,
  interactionDecisionSignature,
  interactionDeliveryPresentation,
  interactionKindLabel,
  interactionProviderLabel,
  interactionSourceLabel,
  parseInteractionDraft,
  updateInteractionDraft,
  type CanonicalInteractionDecision,
  type InteractionDraft,
  type InteractionDraftValue,
} from "../lib/typedInteractions.ts"
import { safeHttpUrl } from "../lib/external-links.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The request could not be updated."
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

function newResponseId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `fray-response-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function InteractionStack({
  thread,
  className = "",
  autoFocusFirst = false,
}: {
  thread: ThreadView | undefined
  className?: string
  autoFocusFirst?: boolean
}) {
  const scope = pendingInteractionScope(thread)
  const query = usePendingInteractions(thread)
  const interactions = useMemo(
    () => [...(query.data?.interactions ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    [query.data?.interactions],
  )
  if (!scope) return null
  if (query.isError && interactions.length === 0) {
    return (
      <div
        data-interactions-error
        role="alert"
        className={`rounded-lg border border-amber-500/35 bg-amber-500/[0.07] px-3.5 py-3 text-[12px] text-amber-100 ${className}`}
      >
        <div className="font-medium">Pending requests could not be loaded.</div>
        <div className="mt-1 break-words text-amber-100/75">{errorText(query.error)}</div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-2 rounded-md border border-amber-400/40 px-2 py-1 text-[11px] hover:bg-amber-500/10"
        >
          Try again
        </button>
      </div>
    )
  }
  if (interactions.length === 0) return null
  return (
    <section
      data-typed-interactions
      aria-label={`${interactions.length} pending request${interactions.length === 1 ? "" : "s"}`}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {interactions.map((interaction, index) => (
        <InteractionCard
          key={interaction.id}
          record={interaction}
          autoFocus={autoFocusFirst && index === 0}
        />
      ))}
    </section>
  )
}

type MutationAction = {
  decision: CanonicalInteractionDecision
  values?: InteractionValues
  responseId: string
}

type MutationResult = {
  effect: string
  interaction: InteractionRecord
  waitingForProvider: boolean
}

export function InteractionCard({
  record,
  autoFocus = false,
}: {
  record: InteractionRecord
  autoFocus?: boolean
}) {
  const qc = useQueryClient()
  const headingId = useId()
  const cardRef = useRef<HTMLElement>(null)
  const responseIds = useRef(new Map<string, string>())
  const fields = record.payload.kind === "mcp-elicitation-form" || record.payload.kind === "agent-question"
    ? record.payload.fields
    : []
  const hasSecretFields = fields.some((field) => field.secret)
  const projectDir = useProjectDir()
  const textKeys = fields.filter((field) => !field.secret && (field.input === "text" || field.input === "multiline")).map((field) =>
    draftKey.interaction(projectDir, record.owner.projectId, record.owner.threadSlug, record.owner.sessionId, record.owner.sessionEpoch, record.id, field.id),
  )
  const persistedText = useDraftValues(textKeys)
  const [localDraft, setDraft] = useState<InteractionDraft>(() => initialInteractionDraft(fields))
  // Persist only free text. Checkboxes, selections, numeric values and every secret stay in-memory.
  const draft = useMemo(() => {
    const next = { ...localDraft }
    fields.forEach((field) => {
      if (!field.secret && (field.input === "text" || field.input === "multiline")) {
        const key = draftKey.interaction(projectDir, record.owner.projectId, record.owner.threadSlug, record.owner.sessionId, record.owner.sessionEpoch, record.id, field.id)
        next[field.id] = persistedText.get(key) ?? ""
      }
    })
    return next
  }, [fields, localDraft, persistedText, projectDir, record.id, record.owner])
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [responseAccepted, setResponseAccepted] = useState(false)
  const [confirming, setConfirming] = useState<CanonicalInteractionDecision>()
  const [durableAcknowledged, setDurableAcknowledged] = useState(false)
  const delivery = interactionDeliveryPresentation(record.delivery?.effect)
  const decisions = useMemo(() => canonicalInteractionDecisions(record), [record])
  const visibleDecisions = decisions.filter((decision) => !(hasSecretFields && decision.requiresValues))
  const unavailableCount = record.allowedDecisions.length - visibleDecisions.length
  const setInteractionDraft = useCallback((next: InteractionDraft) => {
    for (const field of fields) {
      if (!field.secret && (field.input === "text" || field.input === "multiline")) {
        const value = next[field.id]
        if (typeof value === "string") draftStore.set(draftKey.interaction(projectDir, record.owner.projectId, record.owner.threadSlug, record.owner.sessionId, record.owner.sessionEpoch, record.id, field.id), value)
      }
    }
    setDraft(next)
  }, [fields, projectDir, record.id, record.owner])

  useEffect(() => {
    if (!autoFocus) return
    const active = document.activeElement
    if (active && active !== document.body) return
    requestAnimationFrame(() => cardRef.current?.focus())
  }, [autoFocus, record.id])

  useEffect(() => {
    if (delivery.actionsEnabled) return
    setConfirming(undefined)
    setDurableAcknowledged(false)
  }, [delivery.actionsEnabled])

  const mutation = useMutation<MutationResult, unknown, MutationAction>({
    mutationFn: async ({ decision, values, responseId }) => {
      // A Fray-owned request has no provider delivery to acknowledge; its advertised cancel is a
      // journal cancellation. Provider-backed cancel choices travel through resolve so the provider
      // receives the exact advertised decision.
      if (decision.semantic === "cancel" && record.provider.kind === "fray") {
        const result = await rpc.interactionCancel({
          slug: record.owner.threadSlug,
          sessionId: record.owner.sessionId,
          interactionId: record.id,
          sessionEpoch: record.owner.sessionEpoch,
          capabilityRevision: record.owner.capabilityRevision,
          expectedRecordRevision: record.recordRevision,
        })
        return { effect: result.effect, interaction: result.interaction, waitingForProvider: false }
      }
      const result = await rpc.interactionResolve({
        slug: record.owner.threadSlug,
        sessionId: record.owner.sessionId,
        interactionId: record.id,
        sessionEpoch: record.owner.sessionEpoch,
        capabilityRevision: record.owner.capabilityRevision,
        expectedRecordRevision: record.recordRevision,
        responseId,
        decisionId: decision.id,
        ...(values === undefined ? {} : { values }),
      })
      return {
        effect: result.effect,
        interaction: result.interaction,
        waitingForProvider: result.interaction.delivery?.effect === "sending" ||
          result.effect === "queued" || result.effect === "already-queued",
      }
    },
    onSuccess: (result, action) => {
      if (!result.waitingForProvider) {
        responseIds.current.delete(interactionDecisionSignature(action.decision.id, action.values))
      }
      setError(undefined)
      setConfirming(undefined)
      setDurableAcknowledged(false)
      setResponseAccepted(true)
      textKeys.forEach((key) => draftStore.clear(key))
      setStatus(result.waitingForProvider ? "Response sent. Waiting for the provider to acknowledge it…" : "Request completed.")
      reconcileCachedInteraction(qc, result.interaction)
      qc.setQueryData(
        interactionRecordKey(record.owner.threadSlug, record.owner.sessionId, record.id),
        { interaction: result.interaction },
      )
      void qc.invalidateQueries({
        queryKey: pendingInteractionsKey(record.owner.threadSlug, record.owner.sessionId),
        exact: true,
      })
      if (result.waitingForProvider) {
        window.setTimeout(() => {
          void qc.invalidateQueries({
            queryKey: pendingInteractionsKey(record.owner.threadSlug, record.owner.sessionId),
            exact: true,
          })
        }, 1_000)
      }
    },
    onError: (cause) => {
      setStatus(undefined)
      setError(errorText(cause))
      // The write may have committed even though its HTTP response was lost. Fail the shared list
      // cache closed before attempting reconciliation so a remount (or a second copy of this card in
      // Queue) cannot expose a different decision during an ambiguous network window. Only a
      // successful scoped GET proving `awaiting-user` may enable an idempotent retry.
      failClosedAmbiguousInteraction(qc, record)
      // Re-read the exact record after a stale/concurrent/network-ambiguous failure. A terminal result
      // removes the card; an unreachable server stays fail-closed. A proven awaiting-user result keeps
      // the idempotent response id and safely re-enables the same action.
      void rpc.interactionGet({
        slug: record.owner.threadSlug,
        sessionId: record.owner.sessionId,
        interactionId: record.id,
      }).then(({ interaction }) => {
        reconcileCachedInteraction(qc, interaction)
        qc.setQueryData(
          interactionRecordKey(record.owner.threadSlug, record.owner.sessionId, record.id),
          { interaction },
        )
        if (interaction.delivery?.effect === "sending") {
          setError(undefined)
          setStatus(undefined)
          setResponseAccepted(true)
        } else if (interaction.delivery?.effect === "reconnect-required") {
          setError(undefined)
          setStatus(undefined)
        } else if (interaction.lifecycle !== "pending" || interaction.recordRevision !== record.recordRevision) {
          setError(undefined)
          setStatus(interaction.lifecycle === "expired" ? "This request expired." : "This request changed in another client.")
          void qc.invalidateQueries({
            queryKey: pendingInteractionsKey(record.owner.threadSlug, record.owner.sessionId),
            exact: true,
          })
        }
        void qc.invalidateQueries({
          queryKey: pendingInteractionsKey(record.owner.threadSlug, record.owner.sessionId),
          exact: true,
        })
      }).catch(() => {})
    },
  })

  function valuesFor(decision: CanonicalInteractionDecision): InteractionValues | undefined | null {
    if (!decision.requiresValues) {
      setFieldErrors({})
      return undefined
    }
    const parsed = parseInteractionDraft(fields, draft)
    setFieldErrors(parsed.errors)
    if (parsed.formError) {
      setError(parsed.formError)
      return null
    }
    if (!parsed.values) return null
    return parsed.values
  }

  function submitDecision(decision: CanonicalInteractionDecision, confirmed = false): void {
    if (!delivery.actionsEnabled || mutation.isPending || responseAccepted) return
    setError(undefined)
    const values = valuesFor(decision)
    if (values === null) return
    if (decision.durable && !confirmed) {
      setConfirming(decision)
      setDurableAcknowledged(false)
      return
    }
    const signature = interactionDecisionSignature(decision.id, values)
    const responseId = responseIds.current.get(signature) ?? newResponseId()
    responseIds.current.set(signature, responseId)
    mutation.mutate({ decision, values, responseId })
  }

  const primaryFormDecision = visibleDecisions.find((decision) => decision.requiresValues && decision.tone === "primary")
  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    if (delivery.actionsEnabled && primaryFormDecision) submitDecision(primaryFormDecision)
  }

  return (
    <article
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-interaction-id={record.id}
      data-interaction-kind={record.payload.kind}
      data-delivery-effect={record.delivery?.effect}
      className="min-w-0 rounded-lg border border-accent/45 bg-accent/[0.065] shadow-sm shadow-black/15 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <div className="flex min-w-0 items-start gap-3 border-b border-accent/20 px-4 py-3">
        <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-accent">
            {interactionKindLabel(record.payload.kind)} · {delivery.eyebrow}
          </div>
          <h3 id={headingId} className="mt-0.5 break-words text-[14px] font-semibold leading-snug text-fg">
            {record.payload.title}
          </h3>
        </div>
      </div>

      <form onSubmit={onSubmit} className="min-w-0 px-4 py-3.5" noValidate>
        <fieldset disabled={!delivery.actionsEnabled} className="min-w-0 border-0 p-0">
          <legend className="sr-only">Interaction request</legend>
        <InteractionPayloadBody
          record={record}
          instanceId={headingId}
          draft={draft}
          setDraft={setInteractionDraft}
          errors={fieldErrors}
          autoFocus={autoFocus}
        />

        {hasSecretFields && (
          <div data-secret-fallback className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/[0.07] p-3 text-[12px] leading-snug text-amber-100/90">
            <div className="flex items-start gap-2">
              <KeyRound aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Secret input is unavailable in this page.</div>
                <div className="mt-1 text-amber-100/70">Fray will not persist or send secret values through the current RPC.</div>
              </div>
            </div>
            <div className="mt-2 font-medium">Use the provider's trusted secret-input flow. The thread terminal cannot answer this typed request.</div>
          </div>
        )}

        {unavailableCount > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[11px] leading-snug text-amber-100/75">
            <AlertTriangle aria-hidden="true" size={13} className="mt-0.5 shrink-0" />
            <span>{unavailableCount === 1 ? "One advertised choice" : `${unavailableCount} advertised choices`} cannot be safely labeled or delivered in Fray and is not shown.</span>
          </div>
        )}

        {confirming && (
          <div data-durable-confirmation role="group" aria-label={`Confirm ${confirming.label}`} className="mt-3 rounded-md border border-amber-400/45 bg-amber-500/[0.08] p-3">
            <div className="text-[12px] font-semibold text-amber-100">This approval persists beyond the current request.</div>
            <div className="mt-1 text-[11px] leading-snug text-amber-100/75">{confirming.scope}</div>
            <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11px] leading-snug text-fg/85">
              <input
                type="checkbox"
                autoFocus
                checked={durableAcknowledged}
                onChange={(event) => setDurableAcknowledged(event.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>I understand this may authorize later matching actions in this session.</span>
            </label>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(undefined)
                  setDurableAcknowledged(false)
                }}
                className="rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
              >
                Back
              </button>
              <button
                type="button"
                disabled={!durableAcknowledged || mutation.isPending}
                onClick={() => submitDecision(confirming, true)}
                className="rounded-md border border-amber-400/50 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-500/25 disabled:opacity-35"
              >
                Confirm {confirming.label.toLowerCase()}
              </button>
            </div>
          </div>
        )}

        {error && <div role="alert" className="mt-3 break-words text-[11px] leading-snug text-red-300">{error}</div>}
        {(delivery.status ?? status) && <div role="status" aria-live="polite" className="mt-3 text-[11px] leading-snug text-muted">{delivery.status ?? status}</div>}

        {delivery.actionsEnabled && !confirming && !responseAccepted && visibleDecisions.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {visibleDecisions.map((decision) => (
              <button
                key={decision.id}
                type={decision === primaryFormDecision ? "submit" : "button"}
                data-interaction-decision={decision.id}
                disabled={mutation.isPending}
                aria-describedby={decision.durable ? `${headingId}-scope-${decision.id}` : undefined}
                onClick={decision === primaryFormDecision ? undefined : () => submitDecision(decision)}
                className={decisionButtonClass(decision)}
              >
                {mutation.isPending ? "Sending…" : decision.label}
                {decision.durable && <span className="sr-only">; persistent approval</span>}
              </button>
            ))}
            {visibleDecisions.filter((decision) => decision.durable).map((decision) => (
              <span key={`scope-${decision.id}`} id={`${headingId}-scope-${decision.id}`} className="sr-only">{decision.scope}</span>
            ))}
          </div>
        )}
        </fieldset>
      </form>
    </article>
  )
}

function decisionButtonClass(decision: CanonicalInteractionDecision): string {
  const base = "rounded-md border px-2.5 py-1.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-fg/50 disabled:opacity-40"
  if (decision.tone === "primary") return `${base} border-accent/55 bg-accent/15 text-fg hover:bg-accent/25`
  if (decision.tone === "danger") return `${base} border-red-400/35 bg-red-500/[0.07] text-red-200 hover:bg-red-500/15`
  return `${base} border-border bg-panel text-muted hover:bg-panel-2 hover:text-fg`
}

function InteractionPayloadBody({
  record,
  instanceId,
  draft,
  setDraft,
  errors,
  autoFocus,
}: {
  record: InteractionRecord
  instanceId: string
  draft: InteractionDraft
  setDraft: (draft: InteractionDraft) => void
  errors: Record<string, string>
  autoFocus: boolean
}) {
  const payload = record.payload
  const setValue = (id: string, value: InteractionDraftValue) => setDraft(updateInteractionDraft(draft, id, value))
  let content: ReactNode
  if (payload.kind === "command-approval" || payload.kind === "file-approval" || payload.kind === "permission-approval") {
    content = <ApprovalDetails payload={payload} />
  } else if (payload.kind === "mcp-elicitation-url") {
    content = <UrlElicitation url={payload.url} />
  } else {
    content = (
      <InteractionFields
        instanceId={instanceId}
        fields={payload.fields}
        draft={draft}
        setValue={setValue}
        errors={errors}
        autoFocus={autoFocus}
      />
    )
  }
  return (
    <>
      {"message" in payload && payload.message && <BoundedPlainText text={payload.message} />}
      <div className={("message" in payload && payload.message) ? "mt-3" : ""}>{content}</div>
      <RequestMetadata record={record} />
    </>
  )
}

function BoundedPlainText({ text }: { text: string }) {
  const long = text.length > 600 || text.split("\n").length > 6
  if (!long) return <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg/80">{text}</div>
  return (
    <details className="rounded-md border border-border/70 bg-panel/60">
      <summary className="cursor-pointer px-2.5 py-2 text-[11px] text-muted outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/50">Request message</summary>
      <div className="max-h-52 overflow-auto border-t border-border/60 px-2.5 py-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg/80">{text}</div>
    </details>
  )
}

function UrlElicitation({ url }: { url: string }) {
  const href = safeHttpUrl(url, location.href)
  return (
    <div>
      <div className="text-[11px] font-medium text-fg">Open this page to continue</div>
      <code className="mt-1.5 block max-h-24 overflow-auto break-all rounded-md border border-border bg-bg/40 px-2.5 py-2 font-mono-keep text-[10.5px] text-fg/80">{url}</code>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1.5 text-[11px] font-medium text-fg hover:bg-panel-2"
        >
          <ExternalLink aria-hidden="true" size={12} />
          Open page
        </a>
      ) : (
        <div role="alert" className="mt-1.5 break-words text-[11px] text-red-300">
          This request did not provide a safe http(s) URL.
        </div>
      )}
    </div>
  )
}

function RequestMetadata({ record }: { record: InteractionRecord }) {
  return (
    <details className="mt-3 border-t border-border/50 pt-2 text-[10.5px] text-muted/70">
      <summary className="cursor-pointer w-fit outline-none hover:text-muted focus-visible:ring-1 focus-visible:ring-fg/50">Request details</summary>
      <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>Provider</dt><dd className="min-w-0 break-all text-fg/65">{interactionProviderLabel(record.provider.kind)}</dd>
        {record.provider.name && <><dt>Reported name</dt><dd className="min-w-0 break-all text-fg/65">{record.provider.name}</dd></>}
        {record.provider.version && <><dt>Reported version</dt><dd className="min-w-0 break-all text-fg/65">{record.provider.version}</dd></>}
        <dt>Source</dt><dd className="min-w-0 break-all text-fg/65">{interactionSourceLabel(record.source.kind)}</dd>
        {record.source.label && <><dt>Reported source</dt><dd className="min-w-0 break-all text-fg/65">{record.source.label}</dd></>}
        <dt>Scope</dt><dd className="min-w-0 break-all text-fg/65">This thread · this request</dd>
        {record.expiresAt && <><dt>Expires</dt><dd className="min-w-0 break-all text-fg/65">{record.expiresAt}</dd></>}
      </dl>
    </details>
  )
}

function InteractionFields({
  instanceId,
  fields,
  draft,
  setValue,
  errors,
  autoFocus,
}: {
  instanceId: string
  fields: readonly InteractionField[]
  draft: InteractionDraft
  setValue: (id: string, value: InteractionDraftValue) => void
  errors: Record<string, string>
  autoFocus: boolean
}) {
  const firstEditable = fields.findIndex((field) => !field.secret)
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Requested information</legend>
      <div className="flex min-w-0 flex-col gap-3">
        {fields.map((field, index) => (
          <InteractionFieldControl
            key={field.id}
            instanceId={instanceId}
            field={field}
            value={draft[field.id]}
            setValue={(value) => setValue(field.id, value)}
            error={errors[field.id]}
            autoFocus={autoFocus && index === firstEditable}
          />
        ))}
      </div>
    </fieldset>
  )
}

function InteractionFieldControl({
  instanceId,
  field,
  value,
  setValue,
  error,
  autoFocus,
}: {
  instanceId: string
  field: InteractionField
  value: InteractionDraftValue | undefined
  setValue: (value: InteractionDraftValue) => void
  error?: string
  autoFocus: boolean
}) {
  // The same request can be visible in Queue and the open thread drawer at once. Scope form ids to
  // this mounted card so both copies retain valid, unambiguous label/description associations.
  const baseId = `${instanceId}-${field.id}`
  const descriptionId = field.description ? `${baseId}-description` : undefined
  const errorId = error ? `${baseId}-error` : undefined
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined
  const label = <>{field.label}{field.required && <span aria-hidden="true" className="ml-0.5 text-accent">*</span>}</>
  const commonClass = "mt-1 w-full min-w-0 rounded-md border border-border bg-bg/45 px-2.5 py-2 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
  let control: ReactNode
  if (field.secret) {
    control = <div className="mt-1 text-[11px] text-amber-100/70">Use the secure fallback below.</div>
  } else if (field.input === "multiline") {
    control = (
      <textarea
        id={baseId}
        name={field.id}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => setValue(event.target.value)}
        required={field.required}
        minLength={field.minLength}
        maxLength={field.maxLength}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        autoFocus={autoFocus}
        rows={4}
        className={`${commonClass} resize-y`}
      />
    )
  } else if (field.input === "text") {
    const type = field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"
    control = (
      <input
        id={baseId}
        name={field.id}
        type={type}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => setValue(event.target.value)}
        required={field.required}
        minLength={field.minLength}
        maxLength={field.maxLength}
        placeholder={field.format === "date-time" ? "2026-07-13T12:00:00Z" : undefined}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        autoFocus={autoFocus}
        className={commonClass}
      />
    )
  } else if (field.input === "number" || field.input === "integer") {
    control = (
      <input
        id={baseId}
        name={field.id}
        type="number"
        step={field.input === "integer" ? 1 : "any"}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => setValue(event.target.value)}
        required={field.required}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        autoFocus={autoFocus}
        className={commonClass}
      />
    )
  } else if (field.input === "boolean") {
    control = (
      <label htmlFor={baseId} className="mt-1 flex cursor-pointer items-center gap-2 rounded-md border border-border bg-bg/30 px-2.5 py-2 text-[12px] text-fg/85">
        <input
          id={baseId}
          name={field.id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => setValue(event.target.checked)}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          className="accent-[var(--color-accent)]"
        />
        <span>{label}</span>
      </label>
    )
  } else if (field.input === "select") {
    control = (
      <select
        id={baseId}
        name={field.id}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => setValue(event.target.value)}
        required={field.required}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        autoFocus={autoFocus}
        className={commonClass}
      >
        <option value="">Choose an option…</option>
        {field.options.map((option, index) => <option key={index} value={String(index)}>{option.label}</option>)}
      </select>
    )
  } else if (field.input === "multi-select") {
    const selected = Array.isArray(value) ? value : []
    control = (
      <fieldset id={baseId} aria-describedby={describedBy} className="mt-1 rounded-md border border-border bg-bg/30 px-2.5 py-2">
        <legend className="px-1 text-[11px] font-medium text-fg/85">{label}</legend>
        <div className="flex flex-col gap-1.5">
          {field.options.map((option, index) => {
            const token = String(index)
            return (
              <label key={token} className="flex cursor-pointer items-start gap-2 text-[12px] text-fg/85">
                <input
                  type="checkbox"
                  name={field.id}
                  value={token}
                  checked={selected.includes(token)}
                  onChange={(event) => setValue(event.target.checked ? [...selected, token] : selected.filter((item) => item !== token))}
                  autoFocus={autoFocus && index === 0}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span>{option.label}</span>
              </label>
            )
          })}
        </div>
      </fieldset>
    )
  }
  return (
    <div className="min-w-0">
      {field.secret
        ? <div className="text-[11px] font-medium text-fg/85">{label}</div>
        : field.input !== "boolean" && field.input !== "multi-select"
          ? <label htmlFor={baseId} className="block text-[11px] font-medium text-fg/85">{label}</label>
          : null}
      {field.description && <div id={descriptionId} className="mt-0.5 whitespace-pre-wrap break-words text-[10.5px] leading-snug text-muted">{field.description}</div>}
      {control}
      {error && <div id={errorId} role="alert" className="mt-1 text-[10.5px] text-red-300">{error}</div>}
    </div>
  )
}
