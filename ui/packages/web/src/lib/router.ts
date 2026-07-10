import { subscribe } from "valtio"
import { store, pushDrawer, topThreadSlug, closeDrawersById } from "../store.ts"

// URL ⇄ state sync, SPA-style. Paths: `/` (the unified queue — the only page), `/thread/<slug>`
// (the queue with that thread open in the drawer STACK's topmost thread layer — there is no
// standalone thread page), `/status/<status>` (URL-only lists).
//
// History contract (standard SPA): opening a thread layer PUSHES an entry so the browser Back
// button unwinds it; other transitions REPLACE so transient state never buries the back stack.
//
// (The focus machine this used to route through was deleted — the router writes store.view directly.)

function currentPath(): string {
  const top = topThreadSlug()
  if (top) return `/thread/${encodeURIComponent(top)}`
  if (store.view.startsWith("status:")) return `/status/${encodeURIComponent(store.view.slice(7))}`
  return "/"
}

function applyPath(path: string): void {
  const thread = path.match(/^\/thread\/([^/]+)$/)
  if (thread) {
    const slug = decodeURIComponent(thread[1])
    store.view = "todos"
    // Back/forward landed on a thread path: if that thread is somewhere in the stack, unwind ABOVE
    // it; otherwise open it fresh. A deep link opens the CHAT drawer deliberately — an explicit
    // /thread/ URL asks for the thread surface (unlike a listing click, which doc-routes
    // session-less threads; see store.openThread).
    const idx = store.drawers.findIndex((d) => d.kind === "thread" && d.slug === slug)
    // Unwind the layers ABOVE the matched thread through their animated closers (slide-out), not an
    // instant splice — Back/forward must play the same exit animation as backdrop/Esc.
    if (idx !== -1) closeDrawersById(store.drawers.slice(idx + 1).map((d) => d.id))
    else pushDrawer("thread", slug)
    return
  }
  const status = path.match(/^\/status\/([^/]+)$/)
  if (status) {
    closeDrawersById(store.drawers.map((d) => d.id))
    store.view = `status:${decodeURIComponent(status[1])}`
    return
  }
  // Everything else is the queue; Back past the last thread layer unwinds the stack (animated).
  closeDrawersById(store.drawers.map((d) => d.id))
  store.view = "todos"
}

export function startRouter(): () => void {
  // Boot: adopt whatever the address bar says (deep link / reload restores the state).
  applyPath(location.pathname)

  const unsub = subscribe(store, () => {
    const path = currentPath()
    if (path === location.pathname) return
    // A NEW topmost thread pushes history; unwinding or non-thread transitions replace.
    const openingThread = path.startsWith("/thread/")
    if (openingThread) history.pushState(null, "", path)
    else history.replaceState(null, "", path)
  })

  // URL → state (back/forward, hand-edited paths).
  const onPop = () => applyPath(location.pathname)
  window.addEventListener("popstate", onPop)
  return () => {
    unsub()
    window.removeEventListener("popstate", onPop)
  }
}
