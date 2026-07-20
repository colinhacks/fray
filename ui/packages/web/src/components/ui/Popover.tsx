import * as RadixPopover from "@radix-ui/react-popover"
import type { ComponentProps, ReactNode } from "react"
import { OPAQUE_SURFACE_BASE, OVERLAY_Z_CLASS } from "../../lib/overlaySurface.ts"

// Thin styled wrappers over Radix Popover — the battle-tested primitive for click-to-open anchored
// panels (quota breakdown, the token-help panel). Replaces the app's hand-rolled panels that mispainted
// as transparent (opacity-0 enter frames) and stacked too low (z-10/z-50, hidden under the sidebar and
// the composer). Every panel here is OPAQUE from its first frame and portals to <body> at OVERLAY_Z
// (z-[250]) — above the sidebar/board rail, the selector surface, and modal dialogs, below only the
// restart scrim. Anchored, not modal: the app stays visible + interactive to assistive tech while open.
export function Popover({ modal = false, ...props }: ComponentProps<typeof RadixPopover.Root>) {
  return <RadixPopover.Root modal={modal} {...props} />
}

export const PopoverTrigger = RadixPopover.Trigger
export const PopoverAnchor = RadixPopover.Anchor

export function PopoverContent({
  children,
  side = "top",
  align = "center",
  sideOffset = 6,
  className = "",
  ...rest
}: {
  children: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  className?: string
} & Omit<ComponentProps<typeof RadixPopover.Content>, "side" | "align" | "sideOffset" | "className">) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        // Flip/shift to stay on-screen; keep a margin from the viewport edge so a panel opened off a
        // trigger low in the sidebar never clips under the composer or off the bottom.
        avoidCollisions
        collisionPadding={12}
        // Escape closes ONLY this popover — stop it bubbling to App's window-level Esc handler, which
        // would otherwise ALSO unwind the overlay under it (e.g. close the whole Settings drawer when
        // dismissing the token-help popover). Radix still closes the layer (we don't preventDefault).
        onEscapeKeyDown={(e) => e.stopPropagation()}
        // OPAQUE surface (bg-elevated, opacity-100) + EXACTLY ONE z utility (OVERLAY_Z) so the panel is
        // never see-through and never hides behind the sidebar/composer — and no z-index collision.
        className={`${OPAQUE_SURFACE_BASE} ${OVERLAY_Z_CLASS} rounded-lg outline-none ${className}`}
        {...rest}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  )
}
