import * as RT from "@radix-ui/react-tooltip"
import { createPortal } from "react-dom"
import { cloneElement, isValidElement, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react"
import { OVERLAY_Z_CLASS } from "../lib/overlaySurface.ts"

// A small dark shadcn-style tooltip that shows IMMEDIATELY on hover (delayDuration 0) — used for the
// icon-only affordances (card-header actions) where a label needs to appear the instant you point at
// the glyph. One <Provider> wraps the app (App.tsx); each <Tooltip> wraps a single trigger element.

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={0} skipDelayDuration={0}>
      {children}
    </RT.Provider>
  )
}

export function Tooltip({
  label,
  children,
  side = "top",
  clickable = false,
  multiline = false,
}: {
  label: string
  children: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  /** Lets help controls remain available on touch-only, narrow viewports. */
  clickable?: boolean
  /** Preserve `\n` in the label as real line breaks (whitespace-pre-line) — for multi-row labels like
   *  the quota breakdown. Default (whitespace-normal) collapses newlines to spaces, as before. */
  multiline?: boolean
}) {
  const whitespace = multiline ? "whitespace-pre-line" : "whitespace-normal"
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const clickableChild = clickable && isValidElement(children)
    ? children as ReactElement<{ "aria-describedby"?: string }>
    : null
  const trigger = clickableChild ? cloneElement(clickableChild, { "aria-describedby": contentId }) : children
  const triggerRef = useRef<HTMLSpanElement>(null)

  if (clickableChild) {
    const rect = triggerRef.current?.getBoundingClientRect()
    const left = rect ? Math.min(Math.max(12, rect.right + 8), window.innerWidth - 364) : 12
    const top = rect ? Math.min(Math.max(12, rect.top - 6), window.innerHeight - 96) : 12
    const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpen(false)
      }
    }
    return (
      <span
        ref={triggerRef}
        className="inline-flex"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onKeyDown}
      >
        {trigger}
        {open && createPortal(
          <span
            id={contentId}
            role="tooltip"
            className={`${OVERLAY_Z_CLASS} max-w-[min(22rem,calc(100vw-1.5rem))] rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-black/40 break-words ${whitespace}`}
            style={{ position: "fixed", left, top }}
          >
            {label}
          </span>,
          document.body,
        )}
      </span>
    )
  }

  return (
    <RT.Root open={open} onOpenChange={setOpen}>
      <RT.Trigger asChild>{trigger}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          id={contentId}
          side={side}
          sideOffset={5}
          collisionPadding={12}
          className={`${OVERLAY_Z_CLASS} max-w-[min(22rem,calc(100vw-1.5rem))] select-none rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-black/40 break-words ${whitespace}`}
        >
          {label}
          <RT.Arrow className="fill-elevated" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
