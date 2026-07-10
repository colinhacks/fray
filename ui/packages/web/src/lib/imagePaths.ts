// Split a prose markdown run into ordinary markdown chunks and standalone local-image-path lines, so
// the chat view can render an agent's screenshot path (e.g. `/Users/…/shot.png` on its own line) as a
// block <img> instead of dead mono text. Only a line that is SOLELY an absolute image path (optionally
// wrapped in backticks) becomes an image — an inline path inside a sentence stays prose. Detection
// happens on the raw markdown BEFORE the sanitizer runs, so nothing loosens the HTML allowlist.

export type ProsePart = { kind: "md"; text: string } | { kind: "image"; path: string }

// Absolute path ending in an image extension, the whole (trimmed) line, optional surrounding backticks.
const IMAGE_LINE = /^\s*`?(\/[^\s`]+\.(?:png|jpe?g|gif|webp|svg))`?\s*$/i

export function splitProseImages(md: string): ProsePart[] {
  const lines = md.split("\n")
  const parts: ProsePart[] = []
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      const text = buf.join("\n")
      if (text.trim()) parts.push({ kind: "md", text })
      buf = []
    }
  }
  for (const line of lines) {
    const m = line.match(IMAGE_LINE)
    if (m) {
      flush()
      parts.push({ kind: "image", path: m[1] })
    } else {
      buf.push(line)
    }
  }
  flush()
  return parts
}
