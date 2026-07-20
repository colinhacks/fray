import { useLayoutEffect, useState, type RefObject } from "react"
import { rpc } from "../api/rpc.ts"

// Clickable inline-code file paths. Agent prose often mentions files in backticks (`~/.claude/CLAUDE.md`,
// `packages/web/src/App.tsx`). When the text of an inline `<code>` resolves to a real file on disk under
// the server's openable roots, we tag it so the app-wide local-file click interceptor opens it in the
// user's editor/default app — same mechanism as a Markdown file link, just discovered from bare code.
//
// The existence check is a server round-trip (the browser can't stat), so this runs as a POST-render
// decoration: classify candidates locally to avoid statting every backtick, batch the unknowns to the
// server, and tag the ones that come back real. Resolutions are cached for the session.

// A path-like candidate: no whitespace, not a URL, and either home-anchored (`~`) or containing a slash
// (absolute or repo-relative). Bare words and shell commands are excluded so we never stat `git status`
// or `useState`. Length-capped to match the server input bound.
export function isPathCandidate(raw: string): boolean {
  const v = raw.trim()
  if (!v || v.length > 1024 || /\s/.test(v)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false // http(s)://, file://, cursor://, mailto:, …
  return v === "~" || v.startsWith("~/") || v.startsWith("/") || v.includes("/")
}

// Session cache: candidate text → canonical openable path, or null when it doesn't resolve to a real
// file under the gate. `undefined` = not yet asked. Module-scoped so every prose surface shares it and a
// given path is resolved once. Files rarely appear/vanish mid-session, so stale-none is acceptable.
const cache = new Map<string, string | null>()

// Matches the server's `resolveLocalPaths` input cap (router.ts). Candidates are chunked to this size so
// a path-heavy message (a big file listing in one prose block) can't blow the cap and lose EVERY link;
// each chunk resolves — or fails — independently.
const RESOLVE_BATCH = 128

// Resolve the not-yet-known candidates via batched queries; returns true if any new answer landed. A
// chunk that fails its round-trip (e.g. an older server without the route) caches its own candidates as
// unresolved so they stay plain code until the next reload — without dropping the chunks that succeeded.
async function resolveUnknown(paths: string[]): Promise<boolean> {
  const wanted = [...new Set(paths)].filter((p) => !cache.has(p))
  if (!wanted.length) return false
  const chunks: string[][] = []
  for (let i = 0; i < wanted.length; i += RESOLVE_BATCH) chunks.push(wanted.slice(i, i + RESOLVE_BATCH))
  const batches = await Promise.all(chunks.map(async (chunk) => {
    try {
      return (await rpc.resolveLocalPaths({ paths: chunk })).resolved
    } catch {
      return chunk.map((input) => ({ input, path: null }))
    }
  }))
  let changed = false
  for (const resolved of batches) {
    for (const r of resolved) if (!cache.has(r.input)) { cache.set(r.input, r.path); changed = true }
  }
  return changed
}

function decorate(code: Element, openPath: string): void {
  code.setAttribute("data-local-path", openPath)
  code.setAttribute("title", `Open ${openPath}`)
  code.classList.add("local-file-code")
}

// Post-render decoration hook: after `html` is committed into `ref`, tag inline-code file references that
// resolve to real files. Runs in a LAYOUT effect so cached hits re-tag before paint (no flicker) when
// `html` changes — React replaced the innerHTML, wiping prior tags. Also re-runs after an async batch
// resolves (via `version`). Block code (inside `<pre>`) is left alone.
export function useLocalFileCodeLinks(ref: RefObject<HTMLElement | null>, html: string): void {
  const [version, setVersion] = useState(0)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const unknown: string[] = []
    for (const code of root.querySelectorAll("code")) {
      if (code.closest("pre")) continue // block code, not an inline reference
      const raw = (code.textContent ?? "").trim()
      if (!isPathCandidate(raw)) continue
      const resolved = cache.get(raw)
      if (resolved === undefined) unknown.push(raw)
      else if (resolved) decorate(code, resolved)
    }
    if (unknown.length) void resolveUnknown(unknown).then((changed) => { if (changed) setVersion((v) => v + 1) })
  }, [ref, html, version])
}
