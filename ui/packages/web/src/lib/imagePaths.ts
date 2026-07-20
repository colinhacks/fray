// Split a prose markdown run into ordinary markdown chunks, standalone local-IMAGE-path lines, and
// standalone local-FILE-path lines (the safe-tier documents), so the chat view can render an agent's
// (or a just-attached) screenshot path as a block <img> and a document path as an openable file chip
// instead of dead mono text. Only a line that is SOLELY an absolute path (optionally wrapped in
// backticks) is promoted — an inline path inside a sentence stays prose, and a path INSIDE a fenced
// code block stays code (see the fence tracking below). Detection happens on the raw markdown BEFORE
// the sanitizer runs, so nothing loosens the HTML allowlist.

import { ATTACHMENT_DOC_EXTENSIONS } from "@fray-ui/shared"

export type ProsePart =
  | { kind: "md"; text: string }
  | { kind: "image"; path: string }
  | { kind: "file"; path: string }

// Absolute path ending in an INLINE-renderable raster extension (see ATTACHMENT_IMAGE_EXTENSIONS —
// these mirror the server's /local-image content-type map, which is why svg is NOT here: svg is a
// document chip, not an inline image). The whole (trimmed) line, optional surrounding backticks.
const IMAGE_LINE = /^\s*`?(\/[^\s`]+\.(?:png|jpe?g|gif|webp))`?\s*$/i
// The same shape for a non-image safe-tier document (pdf/svg/text/code/…), built from the shared
// allowlist so the two never drift. Matched only when the line is NOT already an image line.
const DOC_LINE = new RegExp(`^\\s*\`?(\\/[^\\s\`]+\\.(?:${ATTACHMENT_DOC_EXTENSIONS.join("|")}))\`?\\s*$`, "i")
// A fenced-code delimiter line: ``` or ~~~ (3+), optionally indented, optionally with an info string.
// Toggling on each such line keeps a standalone absolute path that lives INSIDE a code block (an agent
// pasting `ls`/`git`/`tree` output is common) as ordinary code, instead of ripping it into a chip and
// orphaning the fence markers.
const FENCE_LINE = /^\s{0,3}(?:```|~~~)/

export function splitProseAttachments(md: string): ProsePart[] {
  const lines = md.split("\n")
  const parts: ProsePart[] = []
  let buf: string[] = []
  let inFence = false
  const flush = () => {
    if (buf.length) {
      const text = buf.join("\n")
      if (text.trim()) parts.push({ kind: "md", text })
      buf = []
    }
  }
  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      buf.push(line)
      continue
    }
    if (inFence) {
      buf.push(line)
      continue
    }
    const image = line.match(IMAGE_LINE)
    if (image) {
      flush()
      parts.push({ kind: "image", path: image[1] })
      continue
    }
    const doc = line.match(DOC_LINE)
    if (doc) {
      flush()
      parts.push({ kind: "file", path: doc[1] })
      continue
    }
    buf.push(line)
  }
  flush()
  return parts
}

export type ComposerAttachment = { path: string; kind: "image" | "file" }

// The composer keeps attachment absolute paths INSIDE the draft value (trailing lines) so submit,
// draft persistence, and the worker/transcript pipeline all stay untouched — but presents them as
// chips instead of raw path text. This peels the TRAILING contiguous run of attachment parts off the
// value: everything before it is the prose the textarea shows; the peeled paths render as chips. Only
// a trailing run is peeled (via the same fence-aware split) so a path typed mid-message stays inline
// as prose and is never yanked into a chip or reordered.
export function splitComposerValue(value: string): { prose: string; attachments: ComposerAttachment[] } {
  const parts = splitProseAttachments(value)
  let i = parts.length
  const attachments: ComposerAttachment[] = []
  while (i > 0 && parts[i - 1].kind !== "md") {
    const p = parts[i - 1] as { kind: "image" | "file"; path: string }
    attachments.unshift({ path: p.path, kind: p.kind })
    i--
  }
  const prose = parts.slice(0, i).map((p) => (p.kind === "md" ? p.text : p.path)).join("\n")
  return { prose, attachments }
}

// Recombine edited prose with the (possibly edited) attachment path list into the single draft value
// the parent owns — prose first, then each attachment path on its own trailing line, matching exactly
// the format takeFiles has always appended.
export function joinComposerValue(prose: string, paths: string[]): string {
  if (!paths.length) return prose
  const head = prose.trimEnd()
  return `${head}${head ? "\n" : ""}${paths.join("\n")}`
}
