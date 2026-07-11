import { useQuery } from "@tanstack/react-query"
import { Github } from "lucide-react"
import { rpc } from "../api/rpc.ts"
import { openGithubPicker } from "../store.ts"

// The auth-gated door into the GitHub picker — a small GitHub icon that sits just LEFT of the dispatch
// composer's send button (maintainer 2026-07-10: not a full-width pill). Renders ONLY when gh is authed
// AND the project is a gh-resolvable GitHub repo — otherwise NOTHING (a hidden feature, not a disabled
// control). `githubStatus` is shared with App's not-signed-in hint via the query cache (one fetch);
// detection is cached server-side, `authed` re-checked live, so a later `gh auth login` surfaces it.
export function GithubTrigger({ className = "" }: { className?: string }) {
  const status = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  if (!status.data?.inRepo || !status.data.authed) return null
  return (
    <button
      type="button"
      onClick={() => openGithubPicker()}
      onMouseDown={(e) => e.preventDefault()}
      title="Dispatch from GitHub"
      aria-label="Dispatch from GitHub"
      className={`flex h-7 w-7 items-center justify-center rounded-lg text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg ${className}`}
    >
      <Github size={15} strokeWidth={2} />
    </button>
  )
}
