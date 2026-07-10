import { useQuery } from "@tanstack/react-query"
import { Github } from "lucide-react"
import { rpc } from "../api/rpc.ts"
import { openGithubPicker } from "../store.ts"

// The auth-gated door into the GitHub picker. It renders ONLY when gh is authed AND the project is a
// GitHub repo gh can resolve — otherwise NOTHING (a hidden feature, not a disabled control, per the
// maintainer 2026-07-10). Lives beneath the dispatch box (the "New thread" pill's home) as a second,
// quieter way to start threads. `githubStatus` is shared with App's not-signed-in hint via the query
// cache (one fetch); detection is cached server-side, `authed` re-checked live, so a later
// `gh auth login` surfaces the trigger on the next refetch.
export function GithubTrigger({ className = "" }: { className?: string }) {
  const status = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  if (!status.data?.inRepo || !status.data.authed) return null
  return (
    <button
      onClick={() => openGithubPicker()}
      onMouseDown={(e) => e.preventDefault()}
      className={`flex w-full items-center justify-center gap-1.5 rounded-md border border-border/60 bg-transparent px-2 py-1.5 text-[12px] text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg ${className}`}
    >
      <Github size={13} strokeWidth={2} />
      Dispatch from GitHub
    </button>
  )
}
