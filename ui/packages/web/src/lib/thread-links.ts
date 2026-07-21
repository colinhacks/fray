import { openThread } from "../store.ts"

// A worker can emit a markdown link to another fray thread — `[label](/thread/<slug>)` — e.g. after
// spawning one via the spawn_fray_thread MCP tool. `/thread/<slug>` is a RESERVED SPA route
// (markdownTargets.ts isFrayRoute), so markdown.ts leaves it a normal anchor rather than a local-file
// button. This one delegated listener intercepts a plain left-click on any such anchor and opens the
// thread IN THE DRAWER (openThread — dedupes/raises if already open) instead of letting the browser
// navigate a new tab. A modified click (⌘/ctrl/shift/alt) is left alone so the same href still works
// as a real deep-link opened in a new tab. Covers every sanitized markdown surface (chat, scratchpad,
// plans, drawers) since it delegates from document.
const THREAD_HREF = /^\/thread\/([a-z0-9][a-z0-9-]*)\/?$/

export function installThreadLinkInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="/thread/"]') : null
    const href = anchor?.getAttribute("href")
    if (!anchor || !href) return
    const match = THREAD_HREF.exec(href)
    if (!match) return
    event.preventDefault()
    event.stopPropagation()
    openThread(match[1])
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}
