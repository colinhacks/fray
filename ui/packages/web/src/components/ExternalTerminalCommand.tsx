import { useMutation } from "@tanstack/react-query"
import { TerminalSquare } from "lucide-react"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable; copy the command from a secure Fray page")
  await navigator.clipboard.writeText(value)
}

export function useCopyTerminalCommand(slug: string): () => void {
  const copy = useMutation({
    mutationFn: async () => {
      const result = await rpc.threadTerminalCommand({ slug })
      if (!result.command) throw new Error(result.reason ?? "No verified provider session is available to resume")
      const { command } = result
      await copyText(command)
    },
  })
  return () => copy.mutate(undefined, {
    onSuccess: () => showToast("Provider resume command copied"),
    onError: (error) => showToast(error instanceof Error ? `Could not copy provider resume command: ${error.message}` : "Could not copy provider resume command", { duration: 7000 }),
  })
}

// Always clickable for a Fray-owned session — resuming the same session in another terminal is safe
// (both CLIs allow multiple attached views), so there is no live-ownership gate. The click always
// attempts a copy; if the server genuinely has no resumable id (e.g. codex before its first turn),
// the mutation surfaces the reason as a toast rather than pre-disabling the affordance.
export function CopyTerminalCommandButton({ slug }: { slug: string }) {
  const copy = useCopyTerminalCommand(slug)
  return (
    <Tooltip label="Copy provider resume command">
      <button
        type="button"
        aria-label="Copy provider resume command"
        title="Copy provider resume command"
        onClick={() => copy()}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
      >
        <TerminalSquare size={14} strokeWidth={1.8} />
      </button>
    </Tooltip>
  )
}
