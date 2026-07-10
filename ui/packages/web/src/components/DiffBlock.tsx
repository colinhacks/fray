import { useEffect, useMemo, useState } from "react"
import { useSnapshot } from "valtio"
import { ChevronRight } from "lucide-react"
import type { TranscriptEdit } from "@fray-ui/shared"
import { renderDiff, type DiffHunk } from "../lib/diff/index.ts"
import "../lib/diff/diff.css"
import { prefs } from "../lib/prefs.ts"

// Open a file in the user's editor. The absolute path already carries its leading slash, so it
// concatenates directly onto the scheme's empty authority (cursor://file + /Users/… ). An optional
// 1-based line appends as `:N`.
export function cursorHref(path: string, line?: number | null): string {
  return `cursor://file${path}${line ? `:${line}` : ""}`
}

// A file path rendered as an editor deep-link. Plain (inherits the surrounding gray); brightens +
// underlines on hover. Used by the tool-call one-liners and the diff header.
export function PathLink({ path, line, className = "", children }: { path: string; line?: number | null; className?: string; children?: React.ReactNode }) {
  return (
    // File paths ALWAYS render mono, even under the sans app font.
    <a href={cursorHref(path, line)} title={path} className={`font-mono-keep cursor-pointer hover:underline hover:text-fg/80 ${className}`}>
      {children ?? path}
    </a>
  )
}

// A basename for the header (last path segment), full path stays in the link title.
function basename(p: string): string {
  const segs = p.split("/").filter(Boolean)
  return segs.length ? segs[segs.length - 1] : p
}

// A gent-style rendered diff for a group of Edit/Write/MultiEdit calls that all touch ONE file
// (consecutive same-file edits merge upstream in collapseTools): a bordered block with a header row
// (clickable file path + summed +N/−N counts) and a syntax-highlighted, line-numbered body. Multiple
// edits stack as sequential hunk groups under the one header, divided by a hairline. Wide diffs
// scroll horizontally INSIDE the body (never the page). In compact mode the body is hidden — the
// header alone shows — and clicking a header expands that one block.
export function DiffBlock({ edits }: { edits: TranscriptEdit[] }) {
  const { compactDiffs } = useSnapshot(prefs)
  const file = edits[0].file
  const diffs = useMemo(() => edits.map((e) => renderDiff(e.old, e.new, e.file)), [edits])
  const additions = diffs.reduce((n, d) => n + d.additions, 0)
  const deletions = diffs.reduce((n, d) => n + d.deletions, 0)

  // COLLAPSED BY DEFAULT — full card-family consistency (Bash/Read/Agent all open on demand; the
  // maintainer settled the deferred question 2026-07-09). The Settings "compact diffs" toggle is the
  // escape hatch: switching it OFF returns to expanded-by-default. A per-block click overrides either
  // way, and re-syncing the override to null when the global flips lets the switch drive every block.
  const [override, setOverride] = useState<boolean | null>(null)
  useEffect(() => setOverride(null), [compactDiffs])
  const open = override ?? !compactDiffs

  return (
    <div className="fray-diff">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        onMouseDown={(e) => e.preventDefault()}
        className="fray-diff-header w-full cursor-pointer text-left outline-none"
      >
        {/* Left group: petite-caps "Edit" label (sibling of Bash/Read), file path, +N −M summary. The
            chevron is pushed to the far right by the header's space-between (aligns the three families). */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">Edit</span>
          {/* The path link swallows its own click so opening the file doesn't also toggle the block. */}
          <span className="fray-diff-file" onClick={(e) => e.stopPropagation()}>
            <PathLink path={file} className="text-inherit no-underline">
              {basename(file)}
            </PathLink>
          </span>
          {additions > 0 && <span className="fray-diff-add tabular-nums shrink-0">+{additions}</span>}
          {deletions > 0 && <span className="fray-diff-del tabular-nums shrink-0">−{deletions}</span>}
        </span>
        <ChevronRight size={11} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="fray-diff-body">
          {diffs.map((d, i) => (
            <div key={i} className={i > 0 ? "fray-diff-editsep" : undefined}>
              <DiffBody hunks={d.hunks} collapsedAfter={d.collapsedAfter} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DiffBody({ hunks, collapsedAfter }: { hunks: DiffHunk[]; collapsedAfter: number }) {
  // collapsedBefore is an absolute start index; the count of unchanged lines hidden immediately
  // before a hunk is that index minus where the previous hunk ended.
  let prevEnd = 0
  const rows: React.ReactNode[] = []
  hunks.forEach((h, hi) => {
    const gap = h.collapsedBefore - prevEnd
    if (gap > 0) rows.push(<Sep key={`s${hi}`} n={gap} />)
    for (const l of h.lines) {
      const num = l.type === "del" ? l.oldLine : l.newLine
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " "
      rows.push(
        <div key={`${hi}:${l.oldLine}:${l.newLine}`} className="fray-diff-line" data-type={l.type}>
          <span className="fray-diff-gutter">{num}</span>
          <span className="fray-diff-sign">{sign}</span>
          <span className="fray-diff-code">
            {l.tokens.map((t, i) => (
              <span key={i} className={`ftk-${t.kind}`}>{t.text}</span>
            ))}
          </span>
        </div>,
      )
    }
    prevEnd = h.collapsedBefore + h.lines.length
  })
  if (collapsedAfter > 0) rows.push(<Sep key="safter" n={collapsedAfter} />)
  return <>{rows}</>
}

function Sep({ n }: { n: number }) {
  return <div className="fray-diff-sep">{n} unchanged line{n === 1 ? "" : "s"}</div>
}
