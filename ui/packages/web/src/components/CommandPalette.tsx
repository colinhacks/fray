import { useEffect, useState } from "react"
import { useSnapshot } from "valtio"
import { Command } from "cmdk"
import { store, openThread, openNewThread, pushDrawer, topThreadSlug, closeDrawersById } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBoard, asThreads } from "../hooks.ts"
import { sortThreads, displayTitle } from "../groups.ts"

// Cmd+K palette: fuzzy-jump to any thread (over title + slug, grouped like the sidebar) plus the
// common actions. cmdk owns the filtering; we set each item's `value` to the text we want matched.
export function CommandPalette() {
  const snap = useSnapshot(store)
  const board = useBoard()
  const [search, setSearch] = useState("")

  // Reset the query each time it opens so a stale filter never hides everything.
  useEffect(() => {
    if (snap.showPalette) setSearch("")
  }, [snap.showPalette])

  if (!snap.showPalette) return null

  const threads = sortThreads(asThreads(board?.threads ?? []))
  // "Current thread" = the topmost open thread drawer (there is no nav selection anymore).
  const topSlug = snap.drawers.length ? [...snap.drawers].reverse().find((d) => d.kind === "thread")?.slug : undefined
  const selected = board?.threads.find((t) => t.id === topSlug)

  function close() {
    store.showPalette = false
  }

  function run(fn: () => void) {
    fn()
    close()
  }

  function jump(slug: string) {
    openThread(slug) // side drawer: chat, or the fray doc for a never-spawned thread
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <Command
        label="Command palette"
        className="w-[560px] max-w-[92vw] rounded-lg border border-border bg-panel shadow-2xl overflow-hidden"
        // cmdk defaults to matching the DOM text; we drive matching via each item's `value` instead.
        filter={(value: string, query: string, _keywords?: string[]) => (value.toLowerCase().includes(query.toLowerCase()) ? 1 : 0)}
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Jump to a thread or run a command…"
          className="w-full px-4 h-12 bg-transparent outline-none border-b border-border text-sm placeholder:text-muted"
        />
        <Command.List className="max-h-[52vh] overflow-y-auto py-1.5">
          <Command.Empty className="px-4 py-6 text-center text-sm text-muted">No matches.</Command.Empty>

          <Command.Group heading="Actions" className="cmdk-group">
            {/* "Home" died with the Home view (the dispatch box is always visible on the queue);
                "New thread" opens the anywhere-modal. Queue remains as the way back from a status list. */}
            <Item value="new thread create home" onSelect={() => run(() => openNewThread())}>
              New thread
            </Item>
            <Item value="queue todos inbox pending" onSelect={() => run(() => { closeDrawersById(store.drawers.map((d) => d.id)); store.view = "todos" })}>
              Queue
            </Item>
            <Item value="open settings preferences" onSelect={() => run(() => (store.showSettings = true))}>
              Open settings
            </Item>
            {selected && (
              <>
                <Item
                  value={`open details drawer doc ${displayTitle(selected)}`}
                  onSelect={() => run(() => { const t = topThreadSlug(); if (t) pushDrawer("doc", t) })}
                >
                  {/* "Open", honestly — closing the palette-pushed layer is Esc's job, not a toggle. */}
                  Open thread details
                </Item>
                <Item
                  value={`mark complete done ${displayTitle(selected)}`}
                  onSelect={() => run(() => rpc.markComplete({ slug: selected.id }).catch(() => {}))}
                >
                  Mark “{displayTitle(selected)}” complete
                </Item>
                <Item
                  value={`mark read ${displayTitle(selected)}`}
                  onSelect={() => run(() => rpc.markRead({ slug: selected.id }).catch(() => {}))}
                >
                  Mark “{displayTitle(selected)}” read
                </Item>
              </>
            )}
          </Command.Group>

          {threads.length > 0 && (
            <Command.Group heading="Threads" className="cmdk-group">
              {threads.map((t) => (
                <Item key={t.id} value={`${displayTitle(t)} ${t.id}`} onSelect={() => run(() => jump(t.id))}>
                  <span className="truncate">{displayTitle(t)}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted/70">{t.id}</span>
                </Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

function Item({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="mx-1.5 px-2.5 py-1.5 rounded flex items-center gap-2 text-sm cursor-pointer data-[selected=true]:bg-panel-2 data-[selected=true]:text-fg text-muted"
    >
      {children}
    </Command.Item>
  )
}
