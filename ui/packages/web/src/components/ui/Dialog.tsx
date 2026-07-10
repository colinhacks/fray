import * as RadixDialog from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import type { ReactNode } from "react"

// Centered modal dialog on Radix. Dark scrim, elevated panel with a soft shadow and a titled
// header with a close affordance. Shared by the fray-document viewer and settings.
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  className = "w-[640px] max-w-[92vw] max-h-[82vh]",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay-in fixed inset-0 z-[60] bg-black/55 backdrop-blur-[1px]" />
        <RadixDialog.Content
          className={`pop-in fixed left-1/2 top-1/2 z-[60] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl shadow-black/50 outline-none ${className}`}
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
            <RadixDialog.Title className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close className="rounded-md p-1 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg">
              <X size={15} />
            </RadixDialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
              {footer}
            </footer>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
