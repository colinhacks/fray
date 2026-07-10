import type { FrayStatus } from "@fray-ui/shared"
import { pushDrawer } from "../store.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { sortThreads, displayTitle } from "../groups.ts"

const STATUS_LABEL: Record<string, string> = {
  planning: "Being designed",
  planned: "Roadmap",
  active: "Active",
  "needs-human": "Awaiting you",
  blocked: "Blocked",
  done: "Done",
  dismissed: "Dismissed",
  archived: "Archived",
}

// Workpane view for a status-count nav row: the full thread list in that fray status ("archived"
// is the UI-level pseudo-status — the session flag, not frontmatter).
export function StatusListView({ status }: { status: string }) {
  const board = useBoard()
  const threads = sortThreads(asThreads(board?.threads ?? [])).filter((t) =>
    status === "archived" ? t.archived : t.status === (status as FrayStatus),
  )

  return (
    <>
      <header className="shrink-0 flex items-center gap-2 px-4 h-10 border-b border-border">
        <span className="font-medium">{STATUS_LABEL[status] ?? status}</span>
        <span className="text-[11px] text-muted tabular-nums">{threads.length}</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
        {threads.length === 0 && <p className="px-4 py-6 text-sm text-muted">No threads.</p>}
        {threads.map((t) => (
          <button
            key={t.id}
            className="w-full text-left px-4 py-2 hover:bg-panel-2/60"
            onClick={() => pushDrawer("thread", t.id)}
          >
            <div className="leading-snug">{displayTitle(t)}</div>
            {t.statusText && <div className="text-[11px] text-muted mt-0.5">{t.statusText}</div>}
          </button>
        ))}
      </div>
    </>
  )
}
