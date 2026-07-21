import { useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import type { Backend } from "@fray-ui/shared"
import { store } from "../store.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { Composer } from "./Composer.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"

// The bar under the chat/terminal is now JUST the follow-up composer — the Done button and the
// ⋯ menu live in the workpane header (ThreadHeaderActions) next to the tabs. `ops` (the live
// background-operations strip) renders INSIDE this padded box rather than beside it, so those rows
// hang tight off the prompt and the box's own pb becomes their gap to the lifecycle footer.
export function ThreadActionBar({ slug, ops }: { slug: string; onTerminal?: () => void; ops?: ReactNode }) {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((t) => t.id === slug)
  const projectDir = useProjectDir()
  const key = draftKey.followUp(projectDir, slug, thread?.sessionId)
  const [message, setMessage, clearMessage] = useDraft(key)
  const controls = useThreadComposerControls(slug)
  const followUp = useEagerFollowUp(slug)
  const [signInFor, setSignInFor] = useState<Backend | null>(null)
  const [logoutFor, setLogoutFor] = useState<Backend | null>(null)

  function send() {
    const m = message.trim()
    if (!m) return
    // `/login` / `/logout` are fray-owned account actions for THIS thread's backend — invoked
    // locally, never delivered to the worker as a prompt (a leading slash is not a stable provider
    // command transport across the live-paste vs dead-resume lifecycles).
    const alias = parseAccountAlias(m)
    if (alias) {
      clearMessage()
      const backend: Backend = thread?.backend === "codex" ? "codex" : "claude"
      if (alias === "login") setSignInFor(backend)
      else setLogoutFor(backend)
      return
    }
    followUp.submit(m, {
      onOptimistic: clearMessage,
      // Never clobber a newer draft typed while the request was in flight.
      onRollback: () => { if (!draftStore.get(key)) setMessage(message) },
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
    <div data-thread-action-bar className="shrink-0 border-t border-border bg-panel px-3 py-3">
      <Composer
        id="followup-input"
        surface="chatComposer"
        value={message}
        onChange={setMessage}
        onSubmit={send}
        placeholder="Follow up…"
        busy={controls.busy || followUp.pending}
        footer={controls.footer}
      />
      {controls.status}
      {ops}
      {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}

// The old ⋯ overflow menu is gone: the fray-document, dismiss, and done actions all live as direct
// icons in the shared <HeaderActions> (Kill was dropped entirely — Dismiss ends the session too).
