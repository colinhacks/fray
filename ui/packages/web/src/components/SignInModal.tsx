import * as RadixDialog from "@radix-ui/react-dialog"
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Copy, Check, Loader2 } from "lucide-react"
import type { AuthSnapshot, Backend } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { SIGN_IN_COMMAND, PROVIDER_LABEL } from "../lib/signIn.ts"

// The sign-in gate modal. Shown when a new-thread dispatch targets a provider whose LOCAL credential is
// missing (authStatus === "signed-out"). fray-ui can't host the interactive browser-OAuth flow, so this
// surfaces the exact `claude auth login` / `codex login` command to run in a terminal, then re-checks:
// once the credential appears, `onAuthed` fires and the original dispatch proceeds. Fails open — the
// gate only ever reaches here on a positive "signed-out", never on an "unknown" read error.
export function SignInModal({
  backend,
  onClose,
  onAuthed,
}: {
  backend: Backend
  onClose: () => void
  onAuthed: () => void
}) {
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)
  const command = SIGN_IN_COMMAND[backend]
  const label = PROVIDER_LABEL[backend]

  async function copyCommand() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable")
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      showToast("Couldn't copy — select the command and copy it manually", { duration: 6000 })
    }
  }

  // Re-read the live credential state. On success we prime the cached authStatus so the composer's own
  // gate sees the fresh value too, then either proceed (authed / unknown → fail open) or nudge again.
  const recheck = useMutation({
    mutationFn: () => rpc.authStatus(),
    onSuccess: (snap: AuthSnapshot) => {
      queryClient.setQueryData(["authStatus"], snap)
      if (snap[backend] === "signed-out") {
        showToast(`Still signed out of ${label} — run the command, then retry`, { duration: 6000 })
        return
      }
      onAuthed()
    },
    onError: () => onAuthed(), // read failed → fail open rather than trap the user
  })

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[210] bg-black/30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[210] w-[440px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">Signed out of {label}</RadixDialog.Title>
          <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
            Fray can't start a {label} thread until you're signed in. Run this in your terminal, then retry:
          </p>

          <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2">
            <code className="flex-1 select-all font-mono-keep text-[12.5px] text-fg">{command}</code>
            <button
              type="button"
              aria-label="Copy command"
              onClick={copyCommand}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel hover:text-fg"
            >
              {copied ? <Check size={14} strokeWidth={2} className="text-green-400" /> : <Copy size={14} strokeWidth={1.8} />}
            </button>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {recheck.isPending && <Loader2 size={13} className="animate-spin" />}
              Retry
            </button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
