import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { appendQueuedMessage, removeQueuedMessage } from "../hooks.ts"
import { showToast, store } from "../store.ts"
import { useSnapshot } from "valtio"

const STEER_FAILURE_PREFIX = "fray-steer-failed:"
let fallbackDeliverySequence = 0

function newDeliveryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  fallbackDeliverySequence += 1
  return `browser-${Date.now()}-${fallbackDeliverySequence}`
}

// The message surfaces all obey the same ordering: make the local UI truthful before beginning
// network work.  In particular, `onOptimistic` clears the controlled draft before the mutation
// starts, so an Enter cannot feel gated on an RPC round-trip.  Failure reverses that local work and
// lets the caller restore its exact draft (without overwriting any newer text).
export type EagerFollowUpCallbacks = {
  onOptimistic?: () => void
  onSuccess?: () => void
  onRollback?: () => void
  scrollToBottom?: boolean
}

export function beginEagerSubmission({
  optimistic,
  request,
  success,
  failure,
}: {
  optimistic: () => void
  request: () => Promise<unknown>
  success?: () => void
  failure: (error: Error) => void
}): void {
  // Do not make this function async: callers need `optimistic` to finish before the first awaitable
  // operation is even started. That ordering is the entire perceived-latency contract.
  optimistic()
  void request().then(
    () => success?.(),
    (error: unknown) => failure(error instanceof Error ? error : new Error(String(error))),
  )
}

export function useEagerFollowUp(slug: string): {
  submit: (text: string, callbacks?: EagerFollowUpCallbacks) => boolean
  pending: boolean
} {
  const queryClient = useQueryClient()
  const snap = useSnapshot(store)
  const controlError = snap.board?.threads.find((thread) => thread.id === slug)?.controlError
  const [pending, setPending] = useState(false)
  // A controlled textarea normally makes a second Enter impossible because it becomes empty
  // synchronously. Keep the guard anyway for duplicate programmatic/click submissions and for a
  // second mounted representation of the same draft.
  const inFlight = useRef(new Set<string>())
  // The RPC only acknowledges durable queue acceptance. Keep a small local record until provider
  // evidence arrives so an indeterminate server reconciliation can restore precisely this draft.
  const accepted = useRef(new Map<string, { text: string; callbacks: EagerFollowUpCallbacks }>())

  useEffect(() => {
    if (!controlError?.startsWith(STEER_FAILURE_PREFIX)) return
    const deliveryId = controlError.slice(STEER_FAILURE_PREFIX.length)
    const submission = accepted.current.get(deliveryId)
    if (!submission) return
    accepted.current.delete(deliveryId)
    removeQueuedMessage(queryClient, slug, submission.text, deliveryId)
    submission.callbacks.onRollback?.()
    showToast("Steer failed")
  }, [controlError, queryClient, slug])

  const submit = useCallback((text: string, callbacks: EagerFollowUpCallbacks = {}) => {
    const message = text.trim()
    const deliveryId = newDeliveryId()
    if (!message || inFlight.current.has(deliveryId)) return false
    inFlight.current.add(deliveryId)
    beginEagerSubmission({
      optimistic: () => {
        callbacks.onOptimistic?.()
        appendQueuedMessage(queryClient, slug, message, { scrollToBottom: callbacks.scrollToBottom, deliveryId })
        rpc.markRead({ slug }).catch(() => {})
      },
      request: () => rpc.followUp({ slug, message, deliveryId }),
      success: () => {
        inFlight.current.delete(deliveryId)
        setPending(inFlight.current.size > 0)
        accepted.current.set(deliveryId, { text: message, callbacks })
        callbacks.onSuccess?.()
        showToast("Steered")
      },
      failure: (error) => {
        inFlight.current.delete(deliveryId)
        setPending(inFlight.current.size > 0)
        removeQueuedMessage(queryClient, slug, message, deliveryId)
        callbacks.onRollback?.()
        // A transport rejection is not enough evidence to expose terminal-recovery machinery.
        // Restore the draft and leave the provider untouched.
        showToast("Steer failed")
      },
    })
    setPending(true)
    return true
  }, [queryClient, slug])

  return { submit, pending }
}
