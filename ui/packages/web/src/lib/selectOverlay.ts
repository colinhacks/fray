interface OpenSelectEntry {
  dismiss: () => void
}

let activeSelect: OpenSelectEntry | undefined
let escapeGuardInstalled = false

function ensureEscapeGuard(): void {
  if (escapeGuardInstalled || typeof window === "undefined") return
  escapeGuardInstalled = true
  // Radix's portaled menus and dialogs each observe the same native Escape. Claim it at the earliest
  // capture boundary from the shared registry so mount/listener ordering cannot close both layers.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeSelect) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    dismissOpenSelect()
  }, { capture: true })
}

// A Radix Select portal is not a DOM descendant of its dialog. Keep one tiny process-local pointer
// to the currently open Select so a parent dialog's document-capture Escape handler can defer to it
// regardless of which Radix listener was registered first.
export function registerOpenSelect(dismiss: () => void): () => void {
  ensureEscapeGuard()
  const entry = { dismiss }
  activeSelect = entry
  return () => {
    if (activeSelect === entry) activeSelect = undefined
  }
}

export function dismissOpenSelect(): boolean {
  const entry = activeSelect
  if (!entry) return false
  activeSelect = undefined
  entry.dismiss()
  return true
}

export function handleDialogEscape(event: Pick<KeyboardEvent, "preventDefault" | "stopPropagation">): void {
  // preventDefault tells Radix not to dismiss this dialog. The Select is controlled, so its registry
  // callback has already closed it; the next Escape reaches this dialog with no active Select.
  if (dismissOpenSelect()) event.preventDefault()
  event.stopPropagation()
}
