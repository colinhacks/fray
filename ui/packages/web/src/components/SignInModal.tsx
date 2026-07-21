import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Check, Loader2 } from "lucide-react"
import type { AccountLogoutResult, AuthSnapshot, Backend } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { SIGN_IN_COMMAND, PROVIDER_LABEL } from "../lib/signIn.ts"
import { TerminalPane } from "./TerminalPane.tsx"

// The sign-in gate modal. Shown when a dispatch targets a signed-out provider or the runtime 401
// classifier flags a rejected credential. The PRIMARY action embeds the provider's own login CLI
// (`claude auth login`) in a restricted, short-lived terminal (Slice B): the server spawns exactly
// that argv in a dedicated tmux session addressed by an opaque attempt id, the browser attaches over
// the existing hardened /term transport, and fray polls the credential state to detect completion.
// The copyable command remains the fallback when the embedded flow can't start or the user prefers
// their own terminal. Fails open — the gate only ever reaches here on a positive "signed-out".
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
  // The live embedded login attempt (slug-shaped server-issued id), else null → the plain state.
  const [attempt, setAttempt] = useState<string | null>(null)
  const settledRef = useRef(false)
  const command = SIGN_IN_COMMAND[backend]
  const label = PROVIDER_LABEL[backend]

  const start = useMutation({
    mutationFn: () => rpc.accountLoginStart({ backend }),
    onSuccess: (res) => {
      settledRef.current = false
      setAttempt(res.attemptId)
    },
    onError: (e) => showToast(`Couldn't start the sign-in terminal: ${(e as Error).message.slice(0, 80)} — use the command below instead`, { duration: 7000 }),
  })

  // Completion detection: poll the attempt + credential state while the terminal is embedded. The
  // login CLI exiting is the signal; the re-read credential is the verdict (an expired token still
  // reads authed here — the next real request and the runtime classifier are the validity proof).
  const status = useQuery({
    queryKey: ["accountLoginStatus", attempt],
    queryFn: () => rpc.accountLoginStatus({ attemptId: attempt! }),
    enabled: !!attempt,
    refetchInterval: 2000,
  })
  useEffect(() => {
    if (!attempt || settledRef.current) return
    const data = status.data
    if (!data || data.state === "running" || data.state === "unknown") return
    settledRef.current = true
    if (data.auth !== "signed-out") {
      queryClient.setQueryData(["authStatus"], (prev: AuthSnapshot | undefined) =>
        prev ? { ...prev, [backend]: data.auth } : prev)
      showToast(`Signed in to ${label}`)
      onAuthed()
      return
    }
    showToast(`${label} sign-in didn't complete — try again or use the command below`, { duration: 7000 })
    setAttempt(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, status.data, backend, label])

  // Leaving the modal abandons any live attempt: the server kills the pane so OAuth bytes don't
  // linger. Fire-and-forget — closing must never block on the RPC.
  function abandonAttempt() {
    if (attempt && !settledRef.current) void rpc.accountLoginCancel({ attemptId: attempt }).catch(() => {})
  }

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
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) { abandonAttempt(); onClose() } }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[210] bg-black/30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className={`fixed left-1/2 top-1/2 z-[210] ${attempt ? "w-[680px]" : "w-[440px]"} max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50 outline-none`}
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">Signed out of {label}</RadixDialog.Title>

          {attempt ? (
            <>
              <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
                This terminal is running <code className="font-mono-keep text-fg/90">{command}</code> —
                follow its prompts (it may open your browser). Fray detects completion automatically.
              </p>
              {/* The restricted account terminal: a global provider sign-in session, NOT a thread —
                  it inherits no project prompt and accepts no other command. */}
              <div className="mb-4 h-[340px] overflow-hidden rounded-lg border border-border bg-[#0d0e10]">
                <TerminalPane slug={attempt} />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { abandonAttempt(); setAttempt(null) }}
                  className="rounded-md px-3 py-1.5 text-[12.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
                >
                  Cancel sign-in
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
                Fray can't start a {label} thread until you're signed in. Sign in here, or run the
                command in your own terminal and retry:
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
                  className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-fg/90 outline-none transition-colors hover:bg-panel-2 disabled:opacity-60"
                >
                  {recheck.isPending && <Loader2 size={13} className="animate-spin" />}
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => start.mutate()}
                  disabled={start.isPending}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {start.isPending && <Loader2 size={13} className="animate-spin" />}
                  Sign in here
                </button>
              </div>
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

// Confirmation gate for the `/logout` alias. Sign-out is process-GLOBAL account state — it names the
// provider, warns that new turns will be blocked, and the server additionally refuses to race any
// live turn for that provider. Never auto-resumes, cancels, or rewrites a thread as a side effect.
export function LogoutConfirmModal({ backend, onClose }: { backend: Backend; onClose: () => void }) {
  const queryClient = useQueryClient()
  const label = PROVIDER_LABEL[backend]
  const logout = useMutation({
    mutationFn: () => rpc.accountLogout({ backend }),
    onSuccess: (res: AccountLogoutResult) => {
      // Prime the cached credential snapshot with the post-attempt truth (also blocks the next
      // dispatch immediately, without waiting out the poll interval).
      queryClient.setQueryData(["authStatus"], (prev: AuthSnapshot | undefined) =>
        prev ? { ...prev, [backend]: res.auth } : prev)
      if (res.status === "done") showToast(`Signed out of ${label}`)
      else if (res.status === "blocked") showToast(
        `Not signed out — ${res.activeThreads} active ${label} thread${res.activeThreads === 1 ? "" : "s"}. Let them finish (or complete them) first.`,
        { duration: 7000 },
      )
      else showToast(`${label} sign-out failed: ${res.detail ?? "unknown error"}`, { duration: 7000 })
      onClose()
    },
    onError: (e) => {
      showToast(`${label} sign-out failed: ${(e as Error).message.slice(0, 80)}`, { duration: 7000 })
      onClose()
    },
  })
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open && !logout.isPending) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[210] bg-black/30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[210] w-[420px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">Sign out of {label}?</RadixDialog.Title>
          <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
            New {label} threads will be blocked until you sign in again. Running {label} threads are
            left untouched — sign-out is refused while any are active.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={logout.isPending}
              className="rounded-md px-3 py-1.5 text-[12.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="flex items-center gap-1.5 rounded-md bg-red-500/90 px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {logout.isPending && <Loader2 size={13} className="animate-spin" />}
              Sign out
            </button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
