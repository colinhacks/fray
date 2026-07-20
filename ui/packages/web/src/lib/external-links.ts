// Fray normally runs in an ordinary browser tab. External http(s) anchors should therefore stay in
// the browser's native click path: target=_blank opens a normal tab synchronously from the user
// gesture, preserves modifier-key behavior, and cannot be stranded behind an async RPC. Internal
// links and non-http schemes are left untouched so local navigation remains local.

type AnchorLike = Pick<HTMLAnchorElement, "getAttribute" | "setAttribute" | "hasAttribute">

/** Resolve an untrusted href, accepting only http(s). Useful for explicit link-like controls too. */
export function safeHttpUrl(raw: string, baseHref: string): string | null {
  try {
    const url = new URL(raw, baseHref)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Give an external http(s) anchor safe native new-tab attributes. Returns true only when the anchor
 * is external. No navigation is prevented or synthesized here; the browser completes the click.
 */
export function prepareExternalAnchor(anchor: AnchorLike, currentHref: string): boolean {
  const href = anchor.getAttribute("href")
  if (!href) return false
  const targetUrl = safeHttpUrl(href, currentHref)
  if (!targetUrl) return false

  let currentUrl: URL
  try {
    currentUrl = new URL(currentHref)
  } catch {
    return false
  }
  if (new URL(targetUrl).origin === currentUrl.origin) return false

  anchor.setAttribute("target", "_blank")
  const rel = new Set((anchor.getAttribute("rel") ?? "").split(/\s+/u).filter(Boolean))
  rel.add("noopener")
  rel.add("noreferrer")
  anchor.setAttribute("rel", [...rel].join(" "))
  return true
}

/** Exported for focused node tests; the installed listener delegates to this exact handler. */
export function createExternalLinkClickHandler(
  currentHref: () => string = () => location.href,
): (event: MouseEvent) => void {
  return (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = findAnchor(event)
    if (anchor) prepareExternalAnchor(anchor, currentHref())
  }
}

export function installExternalLinkInterceptor(): () => void {
  const handler = createExternalLinkClickHandler()
  document.addEventListener("click", handler, true)
  return () => document.removeEventListener("click", handler, true)
}

// Nearest enclosing anchor with an href — via composedPath (crosses shadow boundaries) with a
// closest() fallback. Structural detection keeps this helper testable without a synthetic DOM.
function findAnchor(event: MouseEvent): HTMLAnchorElement | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : []
  for (const value of path) {
    if (isAnchor(value)) return value
  }
  const target = event.target as { closest?: (selector: string) => unknown } | null
  const closest = target?.closest?.("a[href]")
  return isAnchor(closest) ? closest : null
}

function isAnchor(value: unknown): value is HTMLAnchorElement {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HTMLAnchorElement>
  return candidate.tagName?.toLowerCase() === "a"
    && typeof candidate.getAttribute === "function"
    && typeof candidate.setAttribute === "function"
    && typeof candidate.hasAttribute === "function"
    && candidate.hasAttribute("href")
}
