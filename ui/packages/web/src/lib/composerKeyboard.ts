export type ComposerKeyboardEvent = {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  // React's synthetic KeyboardEvent omits this DOM field from its type, though its native event
  // exposes it. Undefined is safely treated as not composing.
  isComposing?: boolean
}

/**
 * Submit only an unmodified, non-IME Enter when the composer can actually send. Every modifier
 * path falls through to the textarea's browser default, preserving newline behavior.
 */
export function shouldSubmitComposerEnter(event: ComposerKeyboardEvent, canSubmit: boolean): boolean {
  return canSubmit
    && event.key === "Enter"
    && !event.isComposing
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
}

/**
 * Chromium on macOS can report Option-Enter without applying textarea's usual line break. Let the
 * keydown default run first, then restore the newline only if the DOM value stayed unchanged.
 */
export function shouldRestoreOptionEnterNewline(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter"
    && event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.isComposing
}
