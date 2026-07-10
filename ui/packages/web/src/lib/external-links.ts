import { rpc } from "../api/rpc.ts"

// The fray UI runs inside a chromeless Chrome --app window with a DEDICATED user-data-dir. Any
// http(s) link clicked inside therefore navigates within that isolated profile — the
// "anonymous Chrome window" the user reported — instead of their real, default browser. This
// installs ONE document-level, capture-phase click listener that catches every external link
// (including anchors inside transcript markdown rendered via dangerouslySetInnerHTML, which is why
// it must be global rather than per-component) and hands it to the OS default browser via the
// `openExternal` RPC.
//
// Only http(s) links to a DIFFERENT origin are intercepted. Internal/relative links (same origin)
// and non-http schemes (cursor://, file:, mailto:, …) pass through untouched. Modifier keys are
// intentionally ignored — routing every external link to the default browser is the whole point.
export function installExternalLinkInterceptor(): void {
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented) return
      if (e.button !== 0) return // left-click only; let middle/right do their thing

      const anchor = findAnchor(e)
      if (!anchor) return
      const href = anchor.getAttribute("href")
      if (!href) return

      let url: URL
      try {
        url = new URL(href, location.href) // resolve relative hrefs against the current document
      } catch {
        return
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return // cursor://, file:, mailto: → pass through
      if (url.origin === location.origin) return // internal/relative → let the SPA handle it

      // External link: keep it out of our app-profile window.
      e.preventDefault()
      const target = url.toString()
      rpc.openExternal({ url: target }).catch(() => {
        // The running server may predate this mutation (its half activates on the next restart), or
        // the OS open failed. Degrade gracefully so the link still works in the pre-restart window.
        window.open(target, "_blank", "noopener,noreferrer")
      })
    },
    true, // capture: run before React's synthetic handlers / any SPA nav
  )
}

// Nearest enclosing anchor with an href — via composedPath (crosses shadow boundaries) with a
// closest() fallback.
function findAnchor(e: MouseEvent): HTMLAnchorElement | null {
  const path = typeof e.composedPath === "function" ? e.composedPath() : []
  for (const el of path) {
    if (el instanceof HTMLAnchorElement && el.hasAttribute("href")) return el
  }
  const target = e.target as Element | null
  return (target?.closest?.("a[href]") as HTMLAnchorElement | null) ?? null
}
