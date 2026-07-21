import { useCallback, useEffect, useRef, useState } from "react"
import { seedBoard } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import {
  clampThreadTab,
  readThreadTab,
  resolveThreadTabCapabilities,
  writeThreadTab,
  type ScopedThreadTabCapabilities,
} from "../lib/threadTabState.ts"
import { ThreadView, type ThreadTab } from "./ChatView.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { Toaster } from "./Toaster.tsx"

export function StandaloneThreadPage({ slug }: { slug: string }) {
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const thread = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir
  const scope = projectDir ? `${projectDir}\0${slug}` : undefined
  const rememberedCapabilitiesRef = useRef<ScopedThreadTabCapabilities | undefined>(undefined)
  const resolvedCapabilities = resolveThreadTabCapabilities(
    scope,
    thread ? { scratch: Boolean(thread.scratchpadPath) } : undefined,
    rememberedCapabilitiesRef.current,
  )
  rememberedCapabilitiesRef.current = resolvedCapabilities.remembered
  const loadedScopeRef = useRef<string | null>(projectDir && thread ? scope ?? null : null)
  const [tab, setTabState] = useState<ThreadTab>(() => (
    projectDir && thread ? readThreadTab(projectDir, slug) : "chat"
  ))
  const requestedTab = loadedScopeRef.current === scope ? tab : "chat"
  const effectiveTab = clampThreadTab(requestedTab, resolvedCapabilities.capabilities)

  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [])

  useEffect(() => {
    if (!projectDir || !scope || !resolvedCapabilities.authoritative) return
    if (loadedScopeRef.current === scope) return
    loadedScopeRef.current = scope
    setTabState(readThreadTab(projectDir, slug))
  }, [projectDir, resolvedCapabilities.authoritative, scope, slug])

  const setTab = useCallback((next: ThreadTab) => {
    if (projectDir) writeThreadTab(projectDir, slug, next)
    setTabState(next)
  }, [projectDir, slug])

  const atRest = thread?.runtime === "turn-idle" || thread?.runtime === "exited" || thread?.runtime === "none"
  useEffect(() => {
    if (!thread || !atRest) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [atRest, slug, thread?.lastActivityAt])

  useEffect(() => {
    const projectLabel = board?.projectLabel ?? board?.projectName
    const threadLabel = thread ? displayTitle(thread) : slug
    document.title = projectLabel
      ? `${threadLabel} · ${projectLabel} · fray`
      : `${threadLabel} · fray`
  }, [board?.projectLabel, board?.projectName, slug, thread])

  return (
    <TooltipProvider>
      <div className="h-dvh min-h-0 bg-bg px-0 text-sm text-fg sm:px-5">
        <main
          data-standalone-thread
          className="mx-auto flex h-full w-full max-w-[900px] min-w-0 flex-col overflow-hidden border-border bg-panel sm:border-x"
        >
          {route.kind === "loading" ? (
            <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading thread">
              <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
            </div>
          ) : route.kind === "missing" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <div>
                <h1 className="font-medium text-fg">Thread unavailable</h1>
                <p className="mt-1 text-muted">Thread “{slug}” was not found in this project.</p>
              </div>
              <a href="/" className="rounded-md border border-border px-3 py-1.5 text-[12px] text-fg/90 hover:bg-panel-2">
                Return to queue
              </a>
            </div>
          ) : (
            <ThreadView slug={slug} tab={effectiveTab} onTab={setTab} virtualized />
          )}
        </main>
        <Toaster />
      </div>
    </TooltipProvider>
  )
}
