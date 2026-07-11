import { useState } from "react"
import { useSnapshot } from "valtio"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { store, showToast } from "../store.ts"
import { appendQueuedMessage, removeQueuedMessage } from "../hooks.ts"
import { Composer } from "./Composer.tsx"

// The bar under the chat/terminal is now JUST the follow-up composer — the Done button and the
// ⋯ menu live in the workpane header (ThreadHeaderActions) next to the tabs.
export function ThreadActionBar({ slug }: { slug: string }) {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((t) => t.id === slug)
  const [message, setMessage] = useState("")
  const qc = useQueryClient()

  const followUp = useMutation({ mutationFn: (m: string) => rpc.followUp({ slug, message: m }) })

  function send() {
    const m = message.trim()
    if (!m) return
    // INSTANT + OPTIMISTIC (send-latency): clear the box and paint the queued bubble SYNCHRONOUSLY on
    // Enter — the felt response must NEVER wait on the followUp round-trip. Both the input clear and
    // the optimistic bubble used to sit inside onSuccess, so nothing painted until the RPC returned
    // (a full server round-trip the maintainer perceived as lag — profiled at ~420ms behind a 400ms
    // stub, with the queued bubble not appearing until the reply landed). This is ONE eager render:
    // appendQueuedMessage adds ONLY the new bubble (the memoized transcript bails on the other
    // messages — measured 2 Message re-renders regardless of length) and scrolls to the tail. The
    // TRUTH stays the mutation: a failed send rolls the optimistic bubble back, RESTORES the draft
    // (only if the box is still empty, so a new draft typed meanwhile isn't clobbered), and explains —
    // so a dead session no longer leaves a phantom "sent" bubble. Mirrors the queue's optimistic
    // sendMessage (useLiveAnswering) so the two send paths can't drift.
    setMessage("")
    appendQueuedMessage(qc, slug, m)
    followUp.mutate(m, {
      onError: (e) => {
        removeQueuedMessage(qc, slug, m)
        setMessage((cur) => (cur ? cur : m))
        showToast(`Send failed: ${(e as Error).message.slice(0, 80)}`)
      },
    })
  }

  if (!thread) return null

  // A FOREIGN session (a maintainer terminal — no registry row) is a read-only transcript view: no
  // composer, no verbs. Say so plainly instead of the follow-up box (there's no tmux stdin to steer).
  if (thread.foreign) {
    return (
      <div className="shrink-0 border-t border-border bg-panel px-4 py-3 text-[11.5px] text-muted/70">
        Read-only — running in an external terminal.
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border bg-panel px-3 py-3">
      <Composer
        id="followup-input"
        surface="chatComposer"
        value={message}
        onChange={setMessage}
        onSubmit={send}
        placeholder="Follow up…"
      />
    </div>
  )
}

// The old ⋯ overflow menu is gone: the fray-document, dismiss, and done actions all live as direct
// icons in the shared <HeaderActions> (Kill was dropped entirely — Dismiss ends the session too).
