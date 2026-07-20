export type SidebarSectionGeometry = { id: string; top: number; bottom: number }

// The queue deliberately aligns navigated card borders at 12px. Reading the active section from that
// same sightline makes the rail marker match what the reader experiences, rather than whichever card
// happens to have the largest visible area after an async transcript resize.
export const SIDEBAR_SPY_REFERENCE_TOP = 12

export function activeSidebarSection(
  sections: readonly SidebarSectionGeometry[],
  referenceTop = SIDEBAR_SPY_REFERENCE_TOP,
  atDocumentBottom = false,
): string | null {
  // A short final card can never reach the 12px reading line: the browser has exhausted its scroll
  // range first. At that real boundary, its visible final card is the reader's current queue item.
  // Keep this exceptional rule out of normal scrolling so an upcoming final card cannot steal the
  // rail merely because it is nearest to the viewport bottom.
  if (atDocumentBottom) {
    const finalVisible = [...sections].reverse().find((section) => section.bottom > 0)
    if (finalVisible) return finalVisible.id
  }
  const visible = sections.filter((section) => section.bottom > referenceTop)
  if (!visible.length) return null
  const containing = visible.find((section) => section.top <= referenceTop)
  if (containing) return containing.id
  return visible.reduce((nearest, section) =>
    Math.abs(section.top - referenceTop) < Math.abs(nearest.top - referenceTop) ? section : nearest,
  ).id
}

// Keep the active marker reachable without disturbing the page's scroll position. The result is a
// delta for the rail's own scrollTop, with a small breathing margin around the highlighted row.
export function railRevealDelta(
  railTop: number,
  railBottom: number,
  itemTop: number,
  itemBottom: number,
  margin = 8,
): number {
  if (itemTop < railTop + margin) return itemTop - railTop - margin
  if (itemBottom > railBottom - margin) return itemBottom - railBottom + margin
  return 0
}
