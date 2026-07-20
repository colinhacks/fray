import { useQuery } from "@tanstack/react-query"
import { Github } from "lucide-react"
import type { DispatchProfileSnapshot } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { openGithubPicker, showToast } from "../store.ts"

// The auth-gated door into the GitHub picker — a small GitHub icon that sits just LEFT of the dispatch
// composer's send button (maintainer 2026-07-10: not a full-width pill). Renders ONLY when gh is authed
// AND the project is a gh-resolvable GitHub repo — otherwise NOTHING (a hidden feature, not a disabled
// control). `githubStatus` is shared with App's not-signed-in hint via the query cache (one fetch);
// detection is cached server-side, `authed` re-checked live, so a later `gh auth login` surfaces it.
export function GithubTrigger({
  profile,
  profileError,
  className = "",
}: {
  profile?: DispatchProfileSnapshot
  profileError?: string
  className?: string
}) {
  const status = useQuery({ queryKey: ["githubStatus"], queryFn: () => rpc.githubStatus() })
  if (!status.data?.inRepo || !status.data.authed) return null
  return (
    <button
      type="button"
      onClick={() => {
        if (!profile) {
          showToast(profileError ?? "Choose a valid model and reasoning level before opening GitHub")
          return
        }
        openGithubPicker(profile)
      }}
      onMouseDown={(e) => e.preventDefault()}
      title="Investigate this issue and make recommendations"
      aria-label="Investigate this issue and make recommendations"
      className={`flex h-7 w-7 items-center justify-center rounded-lg text-muted outline-none transition-[color,background-color,box-shadow] enabled:hover:bg-panel-2/70 enabled:hover:text-fg enabled:focus-visible:bg-panel-2/70 enabled:focus-visible:text-muted enabled:focus-visible:ring-1 enabled:focus-visible:ring-muted/80 enabled:focus-visible:ring-offset-1 enabled:focus-visible:ring-offset-bg enabled:active:bg-elevated enabled:active:text-muted disabled:bg-transparent disabled:text-muted/35 ${className}`}
    >
      <Github size={15} strokeWidth={2} />
    </button>
  )
}
