import { useState } from "react"
import { useSnapshot } from "valtio"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { store, showToast } from "../store.ts"
import { appendQueuedMessage } from "../hooks.ts"
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
    followUp.mutate(m, {
      onSuccess: () => {
        setMessage("")
        // Show the sent follow-up immediately as a queued bubble; the poll refetch replaces it.
        // appendQueuedMessage also forces the page to the conversation tail (shared send-path hook).
        appendQueuedMessage(qc, slug, m)
      },
      // Keep the draft in the box (already the behavior — nothing clears on error) AND say why:
      // an orange focus ring alone left the failure unexplained.
      onError: (e) => showToast(`Send failed: ${(e as Error).message.slice(0, 80)}`),
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
