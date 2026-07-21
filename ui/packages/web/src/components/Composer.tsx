import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, FileText, Loader2, Paperclip, X } from "lucide-react"
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, isAllowedAttachmentName } from "@fray-ui/shared"
import { showToast } from "../store.ts"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter } from "../lib/composerKeyboard.ts"
import { queueComposerHandlesOptionEnter } from "../lib/queueComposerKeyboard.ts"

// The shared prompt composer (the pattern the user called "perfect"): ONE rounded bordered box
// holding a borderless auto-growing textarea plus a small round accent send button hovering INSIDE
// at the bottom-right. Grows with content up to maxHeight, then scrolls. Plain Enter submits;
// modifier-Enter uses the browser's native newline behavior, with a no-op fallback for Chromium's
// macOS Option-Enter quirk. Queue retains its separately-owned Option-Enter handling. Escape BLURS
// (climbs out — the next Esc, at rest, unwinds a drawer via
// App's window handler). Keyboard handling is entirely LOCAL: the focus machine that used to
// arbitrate boundary keys was deleted with the mouse-only sidebar. `surface` remains only as a
// data- tag for per-card input targeting (TodosView queries [data-surface="queueComposer"]).
// Upload a dropped/pasted/picked file and return its server-side absolute path. The path goes INTO the
// message text: workers open it with their Read/file tool; the chat renders images via /local-image and
// non-image files as an openable chip. The safe-tier allowlist (images + common docs/text/code) is
// enforced server-side too — the /attach route is the trust gate.
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
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Attachment paths live INSIDE the draft `value` (trailing lines) so submit, draft persistence, and
  // the worker/transcript pipeline stay untouched — but the box PRESENTS them as chips, not raw path
  // text. Split the value into the prose the textarea shows and the trailing attachment paths shown as
  // chips; recombine on every edit so the parent's `value` remains "prose + trailing paths" exactly.
  const { prose, attachments } = useMemo(() => splitComposerValue(value), [value])
  const attachmentPaths = attachments.map((a) => a.path)
  // Latest committed value, readable from an async callback that outlived its render. `takeFiles`
  // awaits the upload, so by the time it commits, `value`/`prose`/`attachmentPaths` in its closure may
  // be stale (the user typed, or another intake landed); it re-derives from this ref instead.
  const valueRef = useRef(value)
  valueRef.current = value
  // Synchronous in-box edits funnel through here: the textarea edits prose (paths unchanged); chip
  // removal edits the path list (prose unchanged). Either way the parent gets the rejoined value.
  const setProse = (nextProse: string) => onChange(joinComposerValue(nextProse, attachmentPaths))
  const setPaths = (nextPaths: string[]) => onChange(joinComposerValue(prose, nextPaths))

  // Attachment intake: drag-and-drop, paste, or the paperclip file picker. Each allowed file's absolute
  // path (returned by /attach) is appended to the message on its own line — images render as inline
  // blocks in the transcript, non-image docs as an openable chip, and the worker opens either with its
  // Read/file tool. An allowed file is any image by MIME (a pasted screenshot often has an empty/generic
  // name — the MIME check preserves the original image-paste behavior) OR any safe-tier file by name
  // (docs/text/code the picker's `accept` surfaces). The /attach route re-validates as the trust gate.
  async function takeFiles(files: FileList | File[] | null) {
    if (!files) return
    // Serialize intake: the paperclip button is disabled while uploading, but drop/paste are not, so a
    // second batch could race the first and clobber it (both commit against the same pre-upload base).
    // Reject the concurrent batch with feedback instead — uploads are quick; the user can re-drop.
    if (uploading) {
      showToast("An upload is already in progress — try again in a moment")
      return
    }
    const picked = [...files].filter((f) => f.type.startsWith("image/") || isAllowedAttachmentName(f.name))
    if (!picked.length) return
    // Reject an oversized file up front with a clear message (the server would 400 anyway — surface it
    // instead of silently dropping). MB is base-10 to match how the OS reports file sizes.
    const allowed = picked.filter((f) => {
      if (f.size > ATTACHMENT_MAX_BYTES) {
        showToast(`${f.name || "File"} is too large (max ${Math.round(ATTACHMENT_MAX_BYTES / 1e6)} MB)`)
        return false
      }
      return true
    })
    if (!allowed.length) return
    setUploading(true)
    const paths: string[] = []
    try {
      for (const f of allowed) {
        const path = await uploadAttachment(f)
        // A null means /attach rejected it (unsupported type the MIME filter let through, decode/write
        // failure). Don't leave the user guessing why nothing appeared.
        if (path) paths.push(path)
        else showToast(`Could not attach ${f.name || "file"}`)
      }
    } finally {
      setUploading(false)
    }
    // Commit against the LATEST value (valueRef), not this callback's render-time closure — the user
    // may have typed, or a prior intake committed, while the upload was in flight. Re-derive prose +
    // existing paths from the freshest value and append this batch, so nothing typed/attached mid-upload
    // is clobbered. The paperclip picker (and, on some browsers, drop/paste) pull focus off the textarea;
    // restore it after the async upload settles so the user can keep typing without re-clicking the box.
    if (paths.length) {
      const latest = splitComposerValue(valueRef.current)
      onChange(joinComposerValue(latest.prose, [...latest.attachments.map((a) => a.path), ...paths]))
    }
    requestAnimationFrame(() => taRef.current?.focus())
  }

  // Auto-grow: reset to auto, then snap to content height clamped at maxHeight. A first layout pass
  // can precede font settlement or a narrow drawer's final width, leaving scrollHeight stale and the
  // last wrapped line hidden beneath the in-box controls. Recheck on the next frame and when fonts
  // settle so the textarea always owns enough height for its actual wrapped content.
  useLayoutEffect(() => {
    let active = true
    const resize = () => {
      const el = taRef.current
      if (!el || !active) return
      el.style.height = "auto"
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    }
    resize()
    const frame = requestAnimationFrame(resize)
    void document.fonts?.ready.then(resize)
    const el = taRef.current
    let width = el?.clientWidth ?? 0
    // A responsive drawer can rewrap a preserved draft without changing its value. Observe width
    // only (not height, which this effect itself owns) and recompute from the new scrollHeight.
    let resizeFrame: number | undefined
    const observer = el ? new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width)
      if (nextWidth === width) return
      width = nextWidth
      // Writing `height` while ResizeObserver is delivering causes Chromium's loop warning. Run the
      // measurement in the next frame: the composer still tracks a drawer rewrap, without a browser
      // console error for every narrow-width resize.
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resize)
    }) : undefined
    if (el) observer?.observe(el)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      observer?.disconnect()
    }
  }, [value, maxHeight, footer])

  // The browser BLURS a focused element the instant it becomes `disabled`, so every `busy` window
  // evicts the caret and the user must re-click the box to keep typing. A focusout whose target is
  // ALREADY disabled is exactly that eviction and nothing else (a user-initiated blur always fires
  // while the element is still enabled), so it is the precise signal for taking focus back once the
  // box unlocks — and it is why a surface that deliberately blurs on send (the queue card dissolving
  // itself) is honored rather than fought: that blur lands while still enabled and never arms this.
  // The listener must be NATIVE: React does not dispatch synthetic events for disabled form controls,
  // so `onBlur` never sees this one (verified in a real browser — the synthetic handler stays silent
  // while the native focusout fires with disabled=true). Note `busy` is not only the send round-trip:
  // it also tracks board-derived control state, so this can fire on a lock the user never initiated.
  const evictedRef = useRef(false)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const onFocusOut = () => { evictedRef.current = el.disabled }
    el.addEventListener("focusout", onFocusOut)
    return () => el.removeEventListener("focusout", onFocusOut)
  }, [])
  useEffect(() => {
    if (busy || !evictedRef.current) return
    evictedRef.current = false
    // Restore only INTO THE VACUUM the eviction left — never steal focus back from somewhere the user
    // deliberately moved while the box was locked. The vacuum is <body> when the composer sits on the
    // page, but inside a modal drawer Radix's focus scope catches the eviction on the dialog container
    // instead; both are ANCESTORS of the box, which is exactly what a deliberate destination is not.
    const el = taRef.current
    const active = document.activeElement
    // preventScroll: this restore can land seconds after the send (a dispatch waits out session
    // startup), by which time the user may have scrolled far away — taking focus back must not yank
    // the page with it.
    if (el && (!active || active.contains(el))) el.focus({ preventScroll: true })
  }, [busy])

  const hasContent = value.trim().length > 0

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    const keyboardEvent = {
      key: e.key,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
    }
    if (queueComposerHandlesOptionEnter(surface, e.key, e.altKey)) {
      // Option-Enter inserts a newline EXPLICITLY (Claude Code muscle memory). Merely exempting it
      // from submit is not enough: on macOS Chrome, Option-Enter in a textarea inserts nothing
      // natively, so we splice the newline at the caret ourselves and restore the caret after the
      // controlled re-render.
      e.preventDefault()
      e.stopPropagation()
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      setProse(el.value.slice(0, start) + "\n" + el.value.slice(end))
      requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      return
    }
    if (shouldSubmitComposerEnter(keyboardEvent, hasContent && !busy)) {
      // Only a plain Enter submits. Modified Enter and IME composition deliberately retain native
      // textarea behavior, so they cannot accidentally submit or lose their newline.
      e.preventDefault()
      e.stopPropagation()
      onSubmit()
      return
    }
    if (shouldRestoreOptionEnterNewline(keyboardEvent)) {
      // Do NOT prevent the modifier path: first allow the browser to insert its native newline.
      // Chromium/macOS sometimes leaves the DOM unchanged, so repair only that no-op on the next
      // frame; browsers that did insert keep their value and never take this branch.
      const before = el.value
      const start = el.selectionStart ?? before.length
      const end = el.selectionEnd ?? start
      requestAnimationFrame(() => {
        if (el.value !== before) return
        setProse(before.slice(0, start) + "\n" + before.slice(end))
        requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      })
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
          Drop file to attach
        </div>
      )}
      <textarea
        id={id}
        ref={taRef}
        data-surface={surface}
        value={prose}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(e) => setProse(e.target.value)}
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
        // With a footer strip the box is an INSET-FOOTER layout: the strip below already reserves the
        // vertical band the floating buttons occupy, so the text runs FULL width (no right rail carved
        // out of every line). Without a footer the box is a single compact row and the right padding is
        // what keeps text from sliding under the floating paperclip/send buttons.
        className={`block w-full resize-none bg-transparent px-3.5 ${footer ? "py-2.5 pb-3" : `py-2.5 ${leftAction ? "pr-28" : "pr-20"}`} text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none disabled:opacity-60`}
      />
      {/* Attachment chips along the bottom row — one square tile per attached file (image thumbnail or
          file-type icon), each removable. The paths still live in `value`; these tiles just render them
          instead of the raw absolute-path text. Reserve the right rail so tiles never slip under the
          paperclip/send buttons on the last row. */}
      {attachments.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 px-3 pb-2 ${leftAction ? "pr-28" : "pr-20"}`}>
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.path}-${i}`}
              attachment={a}
              disabled={busy}
              onRemove={() => setPaths(attachmentPaths.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      {/* Inline footer strip along the bottom edge — always reserved below the auto-growing text.
          Inset = 6px (px-1.5 pb-1.5) so the leftmost readout chip's rounded-md (6px) bottom-left
          corner reads CONCENTRIC with the box's rounded-xl (12px): inner radius (6) = outer (12) −
          inset (6), i.e. both arcs share a center. At the old px-2 (8px) the chip's corner sat 2px
          inside the box arc and read misaligned. */}
      {/* Reserve the right-side action rail. Without this, three shrinkable readouts can extend under
          the absolutely positioned GitHub/send buttons on narrow composers. */}
      {footer && <div className={`flex min-w-0 flex-wrap items-center gap-1 pl-1.5 pb-1.5 ${leftAction ? "pr-28" : "pr-20"}`}>{footer}</div>}
      {leftAction && <div className="absolute bottom-2 right-11 flex items-center">{leftAction}</div>}
      {/* Attach: a hidden file input driven by the paperclip. Sits in the right rail LEFT of the send
          button (and left of any leftAction), so it never overlaps the mode/model footer or the send
          affordance. Accept is the shared safe-tier allowlist; the /attach route re-validates. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void takeFiles(e.target.files)
          e.target.value = "" // reset so re-picking the same file fires change again
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || uploading}
        title="Attach files"
        aria-label="Attach files"
        className={`absolute bottom-2 ${leftAction ? "right-[4.625rem]" : "right-11"} flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-[color,background-color] enabled:hover:bg-panel-2/70 enabled:hover:text-fg disabled:opacity-50`}
      >
        {uploading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Paperclip size={15} strokeWidth={2} />}
      </button>
      <button
        type="button"
        // Prevent the mousedown default so clicking Send never blurs the textarea (the repo's idiom for
        // every submit affordance that sits beside a live input). Focus then never leaves the box on the
        // click path, so there is nothing to restore — and a surface that blurs on send stays in charge.
        onMouseDown={(e) => e.preventDefault()}
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

// One attached file as a compact square tile. An image renders a /local-image thumbnail (object-cover,
// the same gated route the transcript uses); a document renders a bordered tile with a file glyph and
// its extension. A broken image (route 4xx / missing file) falls back to the document tile so a stale
// path is never a blank square. The × removes just this path from the draft. `title` carries the full
// path so the raw location is still one hover away.
function AttachmentChip({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: { path: string; kind: "image" | "file" }
  disabled?: boolean
  onRemove: () => void
}) {
  const [broken, setBroken] = useState(false)
  const base = attachment.path.split("/").filter(Boolean).pop() || attachment.path
  const ext = (base.includes(".") ? base.split(".").pop()! : "").toUpperCase()
  const asImage = attachment.kind === "image" && !broken
  return (
    <div className="group/att relative h-11 w-11" title={base}>
      {asImage ? (
        <img
          src={`/local-image?path=${encodeURIComponent(attachment.path)}`}
          alt={base}
          onError={() => setBroken(true)}
          className="h-11 w-11 rounded-md border border-border object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-panel-2 px-1">
          <FileText size={15} strokeWidth={2} className="shrink-0 text-muted" />
          {ext && <span className="max-w-full truncate text-[8px] font-medium leading-none text-muted/80">{ext}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={`Remove ${base}`}
        aria-label={`Remove ${base}`}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-bg text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/att:opacity-100 disabled:hidden"
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </div>
  )
}
