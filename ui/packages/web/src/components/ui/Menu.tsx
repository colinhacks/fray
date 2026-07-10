import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import type { ReactNode } from "react"

// Thin styled wrappers over Radix DropdownMenu so call sites read declaratively. The popover
// matches the Select: elevated bg, soft shadow, padded rounded items.
export const Menu = RadixMenu.Root
export const MenuTrigger = RadixMenu.Trigger

export function MenuContent({
  children,
  align = "end",
  sideOffset = 6,
}: {
  children: ReactNode
  align?: "start" | "center" | "end"
  sideOffset?: number
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={sideOffset}
        className="pop-in z-[70] min-w-[184px] overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-2xl shadow-black/40"
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
}: {
  children: ReactNode
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
}) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      className={`flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none transition-colors data-[highlighted]:bg-panel-2 ${
        danger
          ? "text-red-400 data-[highlighted]:text-red-300"
          : "text-muted data-[highlighted]:text-fg"
      }`}
    >
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center">{icon}</span>}
      {children}
    </RadixMenu.Item>
  )
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-border" />
}
