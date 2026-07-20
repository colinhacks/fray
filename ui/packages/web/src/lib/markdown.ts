import { Marked } from "marked"
import { renderHighlightedCode } from "./syntaxHighlight.ts"
import { localImageUrlForTarget, localMarkdownTarget } from "./markdownTargets.ts"

const markdown = new Marked({
  breaks: true,
  renderer: {
    code: ({ text, lang }) => renderHighlightedCode(text, lang),
  },
})

// Agent-written markdown → sanitized HTML. Shared by the chat view, the To-dos pager, and the
// thread-details drawer. marked output goes through a small allowlist sanitizer (content is only
// semi-trusted): script-like tags dropped, event handlers and javascript: URLs stripped, links
// forced to new tabs. Parsing happens in a detached template so nothing executes.
export function mdToHtml(md: string): string {
  if (!md.trim()) return ""
  // breaks: single newlines are HARD breaks (chat convention — Slack/GitHub-comment style);
  // CommonMark default silently glued "item ✅\nitem ✅" lists onto one line.
  return sanitize(markdown.parse(md, { async: false }) as string)
}

// INLINE-only render: emphasis/strong/code/del/links but NO block wrapping (`<p>`, headings, lists).
// For places that render a single short line inside their own element and must stay inline — answer
// chips, the recommendation caption — where a worker's `code`/**bold**/_em_ must be honored rather than
// shown as raw markdown, but a `<p>` wrapper would break the layout. Same allowlist sanitizer as the
// block path (content is only semi-trusted).
// `inertInteractive` — flatten links (and the local-file button the normal path would mint) to plain
// spans. Set it when the result is dropped INSIDE an interactive host (an answer chip is itself a
// `<button>`): a nested `<a>`/`<button>` there is invalid interactive-in-interactive HTML and a click
// would both follow the link and trigger the host (open a file AND select the option). Emphasis/code
// still render; only the interactivity is stripped.
export function mdInlineToHtml(md: string, opts?: { inertInteractive?: boolean }): string {
  if (!md.trim()) return ""
  return sanitize(markdown.parseInline(md, { async: false }) as string, opts?.inertInteractive ?? false)
}

export function stripFrontmatter(md: string): string {
  const m = md.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? md.slice(m[0].length) : md
}

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "em", "del", "code", "pre",
  "blockquote", "ul", "ol", "li", "a", "img", "button", "table", "thead", "tbody", "tr", "th", "td", "span",
])
const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "type", "class", "data-local-path", "data-local-image"])
const ALLOWED_HIGHLIGHT_CLASS = /^(?:hljs(?:-[a-z0-9_-]+)?|language-[a-z0-9-]+)$/

function sanitize(dirty: string, inertInteractive = false): string {
  const tpl = document.createElement("template")
  tpl.innerHTML = dirty
  walk(tpl.content, inertInteractive)
  return tpl.innerHTML
}

function walk(node: ParentNode, inertInteractive: boolean) {
  for (const el of Array.from(node.children)) {
    const tag = el.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      el.remove()
      continue
    }
    if (tag === "a" && inertInteractive) {
      // Chip context (see mdInlineToHtml): flatten the anchor to a plain span so no interactive element
      // (nor the local-file button the branch below would mint) lands inside the host `<button>`.
      const span = document.createElement("span")
      while (el.firstChild) span.append(el.firstChild)
      el.replaceWith(span)
      walk(span, inertInteractive)
      continue
    }
    if (tag === "a") {
      const target = localMarkdownTarget(el.getAttribute("href"))
      if (target) {
        const imageUrl = localImageUrlForTarget(target)
        if (imageUrl) {
          // The server resolves the path and admits only supported images beneath its trusted roots.
          // Keep the author's link label and normal Markdown link treatment; only the destination is
          // rewritten so an absolute filesystem path cannot become a bogus same-origin web URL.
          el.setAttribute("href", imageUrl)
          el.setAttribute("title", target.display)
          el.setAttribute("data-local-path", target.posixPath!)
          el.setAttribute("data-local-image", "true")
        } else {
          // Don't turn a filesystem path into a bogus localhost URL or inert code. The app-wide
          // same-origin click handler sends this explicit action to the server, which realpath-gates
          // it before invoking the selected desktop opener.
          const button = document.createElement("button")
          button.type = "button"
          button.className = "local-file-action"
          button.title = target.display
          if (target.posixPath) button.setAttribute("data-local-path", target.posixPath)
          while (el.firstChild) button.append(el.firstChild)
          el.replaceWith(button)
          continue
        }
      }
    }
    if (tag === "img") {
      const target = localMarkdownTarget(el.getAttribute("src"))
      const imageUrl = target && localImageUrlForTarget(target)
      if (!imageUrl) {
        // The only Markdown images admitted are local POSIX files through the existing, server-side
        // allowlisted proxy. Remote/data/file-host images remain disallowed.
        el.remove()
        continue
      }
      el.setAttribute("src", imageUrl)
      el.setAttribute("title", target.display)
      el.setAttribute("data-local-path", target.posixPath!)
      el.setAttribute("data-local-image", "true")
      if (!el.getAttribute("alt")) el.setAttribute("alt", target.display)
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name === "class" && (tag === "code" || tag === "span")) {
        const classes = attr.value.split(/\s+/).filter((value) => ALLOWED_HIGHLIGHT_CLASS.test(value))
        if (classes.length > 0) el.setAttribute("class", classes.join(" "))
        else el.removeAttribute(attr.name)
        continue
      }
      if (!ALLOWED_ATTRS.has(name)) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === "href" && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
    if (tag === "a") {
      el.setAttribute("target", "_blank")
      el.setAttribute("rel", "noopener noreferrer")
    }
    walk(el, inertInteractive)
  }
}
