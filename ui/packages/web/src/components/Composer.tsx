import { useLayoutEffect, useRef, useState } from "react"
import { ArrowUp, Loader2 } from "lucide-react"

// The shared prompt composer (the pattern the user called "perfect"): ONE rounded bordered box
// holding a borderless auto-growing textarea plus a small round accent send button hovering INSIDE
// at the bottom-right. Grows with content up to maxHeight, then scrolls. Enter submits; Shift/Option-
// Enter insert a newline; Escape BLURS (climbs out — the next Esc, at rest, unwinds a drawer via
// App's window handler). Keyboard handling is entirely LOCAL: the focus machine that used to
// arbitrate boundary keys was deleted with the mouse-only sidebar. `surface` remains only as a
// data- tag for per-card input targeting (TodosView queries [data-surface="queueComposer"]).
// Upload a dropped/pasted image and return its server-side absolute path. The path goes INTO the
// prompt text: workers open it with Read; the chat renders it via /local-image.
async function uploadAttachment(file: File): Promise<string | null> {
  const buf = await file.arrayBuffer()
  let bin = ""
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const res = await fetch("/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name || "pasted.png", data: btoa(bin) }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { path?: string }
  return json.path ?? null
}

export function Composer({
  value,
  onChange,
  onSubmit,
  surface,
  placeholder,
  id,
  minHeight = 44,
  maxHeight = 220,
  autoFocus,
  busy,
  footer,
  leftAction,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  // Pure data- tag on the textarea (e.g. TodosView targets [data-surface="queueComposer"] to focus a
  // card's input). No focus registry behind it anymore.
  surface: string
  placeholder?: string
  id?: string
  minHeight?: number
  maxHeight?: number
  autoFocus?: boolean
  // While busy the textarea is locked and the send button spins — used for the New-thread dispatch
  // round-trip so the composer commits instantly instead of sitting live during the spawn.
  busy?: boolean
  // Rendered INSIDE the box along its bottom edge (the dispatch form's inline mode/model/effort
  // readouts). The textarea auto-grows above it; the footer strip is always reserved.
  footer?: React.ReactNode
  // A small action rendered just LEFT of the send button (the dispatch composer's GitHub-picker icon).
  // Only surfaces that pass it get it; reply/queue composers omit it.
  leftAction?: React.ReactNode
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [dragging, setDragging] = useState(false)

  // Screenshot intake: drag-and-drop or paste. The uploaded file's absolute path is appended to the
  // text on its own line (the transcript renderer shows standalone image paths as blocks).
  async function takeFiles(files: FileList | File[] | null) {
    if (!files) return
    const images = [...files].filter((f) => f.type.startsWith("image/"))
    const paths: string[] = []
    for (const f of images) {
      const path = await uploadAttachment(f)
      if (path) paths.push(path)
    }
    // One append for the whole batch (per-file appends would each read a stale `value`).
    if (paths.length) onChange(`${value.trimEnd()}${value.trim() ? "\n" : ""}${paths.join("\n")}\n`)
  }

  // Auto-grow: reset to auto, then snap to content height clamped at maxHeight.
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])

  const hasContent = value.trim().length > 0

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    if (e.key === "Enter" && e.altKey) {
      // Option-Enter inserts a newline EXPLICITLY (Claude Code muscle memory). Merely exempting it
      // from submit is not enough: on macOS Chrome, Option-Enter in a textarea inserts nothing
      // natively, so we splice the newline at the caret ourselves and restore the caret after the
      // controlled re-render.
      e.preventDefault()
      e.stopPropagation()
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      onChange(el.value.slice(0, start) + "\n" + el.value.slice(end))
      requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Plain Enter (and still ⌘/Ctrl-Enter) SUBMITS; Shift-Enter or Option-Enter inserts a newline.
      e.preventDefault()
      e.stopPropagation()
      onSubmit()
      return
    }
    if (e.key === "Escape") {
      // Climb out: blur the textarea and STOP the event — the same physical keypress must not also
      // reach App's window handler and pop a drawer. The NEXT Esc, at rest, unwinds normally.
      e.preventDefault()
      e.stopPropagation()
      el.blur()
    }
    // Arrow keys just move the caret — no boundary semantics (the nav walk they used to drive is gone).
  }

  return (
    // Focused = the accent (yellow) border: the visual handoff from the nav chevron to the box.
    // While a file drags over, the border dashes and a hint overlay appears (screenshot intake).
    <div
      className={`group relative rounded-xl border bg-bg transition-colors focus-within:border-accent ${
        dragging ? "border-dashed border-accent" : "border-border"
      }`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void takeFiles(e.dataTransfer.files)
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg/80 text-[12px] text-muted">
          Drop image to attach
        </div>
      )}
      <textarea
        id={id}
        ref={taRef}
        data-surface={surface}
        value={value}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean)
          if (files.length) {
            e.preventDefault()
            void takeFiles(files)
          }
        }}
        placeholder={placeholder}
        rows={1}
        spellCheck={false}
        style={{ minHeight, maxHeight }}
        className="block w-full resize-none bg-transparent px-3.5 py-2.5 pr-12 text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none disabled:opacity-60"
      />
      {/* Inline footer strip along the bottom edge — always reserved below the auto-growing text.
          Inset = 6px (px-1.5 pb-1.5) so the leftmost readout chip's rounded-md (6px) bottom-left
          corner reads CONCENTRIC with the box's rounded-xl (12px): inner radius (6) = outer (12) −
          inset (6), i.e. both arcs share a center. At the old px-2 (8px) the chip's corner sat 2px
          inside the box arc and read misaligned. */}
      {footer && <div className="flex items-center gap-1 px-1.5 pb-1.5">{footer}</div>}
      {leftAction && <div className="absolute bottom-2 right-11 flex items-center">{leftAction}</div>}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!hasContent || busy}
        title="Send (Enter)"
        aria-label="Send"
        className={`absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg transition-all ${
          // Active = neutral-bright (light-on-dark) primary, NOT accent — yellow stays the focus motif.
          hasContent && !busy
            ? "bg-fg text-bg hover:opacity-90 active:scale-95"
            : "bg-panel-2 text-muted"
        }`}
      >
        {busy ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <ArrowUp size={14} strokeWidth={2.5} />}
      </button>
    </div>
  )
}
