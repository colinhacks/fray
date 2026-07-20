import { useEffect, useMemo, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { useMutation, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { store, threadBySlug, showToast, markDrawerClosing, removeDrawerAfterExit } from "../store.ts"
import type { BoardSnapshot } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { registerDrawerClose } from "../lib/overlays.ts"
import { mdToHtml, stripFrontmatter } from "../lib/markdown.ts"
import { canAdoptThread } from "../lib/adoption.ts"
import { Composer } from "./Composer.tsx"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"

// The fray-document drawer: a RIGHT side sheet (same slide/backdrop family as settings and the
// Open-thread sheet — nothing renders as a centered dialog) showing the thread's .fray/<slug>.md body
// — the Goal / Status / Decisions / Next-step contract — as markdown. Content is agent-written and
// thus only semi-trusted — rendered through the shared allowlist sanitizer (lib/markdown.ts).
//
// SESSION-LESS threads (runtime "none" — listing clicks route them here; the doc IS the substance,
// especially for plans) get a COMPOSITE surface: the doc body above, and pinned at the bottom a
// quiet no-session notice + the standard composer. Submitting ADOPTS a worker onto this thread
// (rpc.adoptThread — spawns on the thread file) and immediately follows up with the user's message
// as its first steer (rpc.followUp), then this drawer swaps IN PLACE into the chat drawer (same
// stack slot), where the spawning spinner takes over. This superseded an earlier bare
// "Start a session" header button — the composer is the affordance.
const CLOSE_MS = 210
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export function ThreadDrawer({ id, slug, title, depth, widthDepth }: { id: number; slug: string; title: string; depth: number; widthDepth: number }) {
  const [shown, setShown] = useState(false)
  // Mirrors `closing` for async callbacks (state would be a stale closure there) — see the adopt swap.
  const closingRef = useRef(false)
  const body = useQuery({
    queryKey: ["threadBody", slug],
    queryFn: () => rpc.threadBody({ slug }),
  })

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  function close() {
    if (closingRef.current) return
    closingRef.current = true
    markDrawerClosing(id) // stop URL/topThreadSlug counting this layer the instant it slides out
    setShown(false)
    window.setTimeout(() => {
      removeDrawerAfterExit(id)
    }, prefersReducedMotion() ? 0 : CLOSE_MS)
  }

  // Register the animated close for App's Esc handler (topmost-first unwinding).
  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // The thread file changes underneath us as the agent works; every board push (SSE) is a cheap
  // signal to re-read it while the drawer is open.
  const snap = useSnapshot(store)
  useEffect(() => {
    if (snap.drawers.find((drawer) => drawer.id === id)?.closing || !closingRef.current) return
    closingRef.current = false
    setShown(true)
  }, [snap.drawers, id])
  useEffect(() => {
    body.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.board])

  // Session-less composite (see header comment): runtime "none" = no session ever spawned. Submit =
  // adopt (spawn a worker on the thread FILE — the durable context) + followUp (the user's message
  // lands as the worker's first steer via tmux stdin), then swap this doc layer into the CHAT layer
  // in place — the chat view's "Session starting…" spinner covers the spawn.
  const thread = threadBySlug(snap.board as BoardSnapshot | null, slug)
  const adoptable = canAdoptThread(thread)
  const projectDir = useProjectDir()
  const messageKey = draftKey.adopt(projectDir, slug)
  const [message, setMessage, clearMessage] = useDraft(messageKey)
  // Once the drawer is animating out, a late adopt success must NOT re-kind the entry mid-close —
  // the swap would remount it as a fresh chat sheet for its last 200ms. The session still started;
  // the user just closed the drawer first.
  const adopt = useMutation({
    mutationFn: async (msg: string) => {
      // One RPC: the adoption orientation rides the SYSTEM prompt server-side; the human's message IS
      // the worker's first user message (maintainer: the transcript shows only their own words).
      await rpc.adoptThread({ slug, message: msg.trim() || undefined })
    },
    onSuccess: () => {
      // Swap THIS drawer layer doc → thread (same id, same depth): the chat surface takes over.
      // (A no-op if the drawer was already removed; skipped if it's mid-close animation.)
      if (closingRef.current) return
      store.drawers = store.drawers.map((d) => (d.id === id ? { ...d, kind: "thread" as const } : d))
    },
    onError: (e, submitted) => {
      if (!draftStore.get(messageKey)) setMessage(submitted)
      showToast(`Start failed: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  const html = useMemo(() => mdToHtml(stripFrontmatter(body.data?.markdown ?? "")), [body.data?.markdown])

  return (
    <div
      className={`fixed inset-0 flex justify-end bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
      onMouseDown={close}
    >
      <div
        className={`h-full flex flex-col border-l border-border bg-panel shadow-2xl shadow-black/50 transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "translate-x-0" : "translate-x-full"}`}
        // A3 fix: the doc is a "flip" surface of the CHAT drawer for the SAME thread, not a genuine
        // extra stack layer — so it must not read as a narrower stacked overlay (the bug: opened over
        // the chat drawer it landed at depth+1 → 692px vs the chat's 720px). Render at the width of the
        // drawer BENEATH it (depth-1) so it matches the chat drawer exactly; at depth 0 (a runtime-none
        // thread opened straight to its doc, nothing beneath) it's the base 720px. Preferred long-term
        // fix per the audit was a real third Chat|Terminal|Doc tab, deferred this pass: it collides with
        // the existing scratchpad "Doc" tab (a DIFFERENT file) and the runtime-none entry path — a design
        // call left for the maintainer.
        style={{ width: `min(${720 - Math.max(0, widthDepth - 1) * 28}px, ${80 - Math.max(0, widthDepth - 1) * 4}vw)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 border-b border-border px-5 h-12">
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate text-[13px]" title={title}>{title}</div>
            <div className="text-[10px] text-muted/60 truncate">{slug}.md</div>
          </div>
          <button
            aria-label="Close"
            onClick={close}
            className="rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {body.isLoading ? (
            <div className="text-[13px] text-muted">Loading…</div>
          ) : html ? (
            <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <div className="text-[13px] text-muted">No thread file found.</div>
          )}
        </div>
        {/* Session-less: the bottom-pinned no-session notice + composer (the affordance to start work). */}
        {adoptable && (
          <div className="shrink-0 border-t border-border/60 px-5 pb-4 pt-3">
            <p className="mb-2.5 text-[11.5px] text-muted/80">
              No session is attached to this thread yet. Send a message below to start one on this plan.
            </p>
            <Composer
              surface="adoptComposer"
              value={message}
              onChange={setMessage}
              onSubmit={() => {
                if (!message.trim() || adopt.isPending) return
                const submitted = message
                clearMessage()
                showToast("Starting thread…", { spinner: true, sticky: true })
                adopt.mutate(submitted)
              }}
              placeholder="Kick off work on this thread…"
              minHeight={44}
              busy={adopt.isPending}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// (The local marked/sanitize/stripFrontmatter copies were deleted — lib/markdown.ts is the one
// sanitizer pipeline; a review pass flagged the ~45-line duplication.)
