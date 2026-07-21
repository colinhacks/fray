import { useMutation } from "@tanstack/react-query"
import { Check, TerminalSquare } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { rpc } from "../api/rpc.ts"
import { createCopyCommandFeedback } from "../lib/copyCommandFeedback.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable; copy the command from a secure Fray page")
  await navigator.clipboard.writeText(value)
}

interface CopyCallbacks {
  onError?: () => void
}

export function useCopyTerminalCommand(slug: string): (callbacks?: CopyCallbacks) => void {
  const copy = useMutation({
    mutationFn: async () => {
      const result = await rpc.threadTerminalCommand({ slug })
      if (!result.command) throw new Error(result.reason ?? "No verified provider session is available to resume")
      const { command } = result
      await copyText(command)
    },
  })
  return (callbacks) => copy.mutate(undefined, {
    onSuccess: () => showToast("Provider resume command copied"),
    onError: (error) => {
      callbacks?.onError?.()
      showToast(error instanceof Error ? `Could not copy provider resume command: ${error.message}` : "Could not copy provider resume command", { duration: 7000 })
    },
  })
}

// Always clickable for a Fray-owned session — resuming the same session in another terminal is safe
// (both CLIs allow multiple attached views), so there is no live-ownership gate. The click always
// attempts a copy; if the server genuinely has no resumable id (e.g. codex before its first turn),
// the mutation surfaces the reason as a toast rather than pre-disabling the affordance.
export function CopyTerminalCommandButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const feedback = useRef<ReturnType<typeof createCopyCommandFeedback> | null>(null)
  if (!feedback.current) {
    feedback.current = createCopyCommandFeedback(setCopied, {
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    })
  }
  const copy = useCopyTerminalCommand(slug)

  useEffect(() => () => feedback.current?.dispose(), [])

  function handleCopy() {
    const generation = feedback.current!.begin()
    copy({ onError: () => feedback.current?.fail(generation) })
  }

  const label = copied ? "Provider resume command copied" : "Copy provider resume command"
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={handleCopy}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        {copied
          ? <Check size={14} strokeWidth={2.2} className="text-live" />
          : <TerminalSquare size={14} strokeWidth={1.8} />}
      </button>
    </Tooltip>
  )
}
