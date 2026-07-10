import * as RT from "@radix-ui/react-tooltip"
import type { ReactNode } from "react"

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

export function Tooltip({ label, children, side = "top" }: { label: string; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={5}
          className="z-50 select-none rounded-md border border-border bg-elevated px-2 py-1 text-[11px] leading-none text-fg shadow-md shadow-black/40"
        >
          {label}
          <RT.Arrow className="fill-elevated" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
