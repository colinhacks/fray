// A tiny registry so the window-level Escape handler (App) can trigger an overlay's OWN animated
// close instead of yanking its store state (which unmounts instantly and skips the slide-out).
// Drawers register per-INSTANCE (keyed by their stack entry id) since the drawer stack has
// arbitrary depth; settings keeps its singleton slot.

let settingsClose: (() => void) | null = null

export function registerSettingsClose(fn: (() => void) | null): void {
  settingsClose = fn
}

// Returns true if it handled the close (an animated closer was registered), false otherwise.
export function closeSettingsAnimated(): boolean {
  if (settingsClose) {
    settingsClose()
    return true
  }
  return false
}

// Per-drawer-instance closers, keyed by the stack entry's id.
const drawerClosers = new Map<number, () => void>()

export function registerDrawerClose(id: number, fn: (() => void) | null): void {
  if (fn) drawerClosers.set(id, fn)
  else drawerClosers.delete(id)
}

// Close the given stack entry via its animated closer. False if none registered (caller pops raw).
export function closeDrawerAnimated(id: number): boolean {
  const fn = drawerClosers.get(id)
  if (fn) {
    fn()
    return true
  }
  return false
}
