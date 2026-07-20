/**
 * Option is reported as altKey by Chromium on macOS. Keep this Queue-only so other composer
 * surfaces retain their existing keyboard contracts.
 */
export function queueComposerHandlesOptionEnter(surface: string, key: string, altKey: boolean): boolean {
  return surface === "queueComposer" && key === "Enter" && altKey
}
