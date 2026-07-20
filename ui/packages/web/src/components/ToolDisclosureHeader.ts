import { createElement, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

type ToolDisclosureHeaderProps = {
  children: ReactNode
  className: string
  controls: string
  expanded: boolean
  label: string
  meta?: ReactNode
  onToggle: () => void
  chevronSize?: number
}

// Tool headers sometimes contain an action of their own (open a file or drill into a sub-agent).
// Keep that action and the disclosure control as SIBLINGS: nesting either one inside the other makes
// the browser repair the markup inconsistently and gives keyboard/screen-reader users two actions
// with one ambiguous focus target. Kept JSX-free so the real rendered markup can be exercised by the
// workspace's native node:test runner (which intentionally does not transpile TSX).
export function ToolDisclosureHeader({
  children,
  className,
  controls,
  expanded,
  label,
  meta,
  onToggle,
  chevronSize = 12,
}: ToolDisclosureHeaderProps) {
  return createElement(
    "div",
    { className: `${className} w-full text-left`, "data-expanded": expanded },
    createElement("span", { className: "flex min-w-0 items-center gap-2" }, children),
    createElement(
      "span",
      { className: "flex shrink-0 items-center gap-1.5" },
      meta,
      createElement(
        "button",
        {
          type: "button",
          "data-tool-disclosure": true,
          "aria-controls": controls,
          "aria-expanded": expanded,
          "aria-label": label,
          title: label,
          onClick: onToggle,
          className:
            "-m-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-muted outline-none transition-colors hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-fg/60",
        },
        createElement(ChevronRight, {
          "aria-hidden": true,
          size: chevronSize,
          // Lucide's right-chevron sits a fraction low in its viewbox. A tiny optical lift makes
          // its visual center agree with the petite-caps running state beside it.
          className: `relative -top-px shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`,
        }),
      ),
    ),
  )
}
