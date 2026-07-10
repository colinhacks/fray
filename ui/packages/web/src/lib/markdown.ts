import { marked } from "marked"

// Agent-written markdown → sanitized HTML. Shared by the chat view, the To-dos pager, and the
// thread-details drawer. marked output goes through a small allowlist sanitizer (content is only
// semi-trusted): script-like tags dropped, event handlers and javascript: URLs stripped, links
// forced to new tabs. Parsing happens in a detached template so nothing executes.
export function mdToHtml(md: string): string {
  if (!md.trim()) return ""
  // breaks: single newlines are HARD breaks (chat convention — Slack/GitHub-comment style);
  // CommonMark default silently glued "item ✅\nitem ✅" lists onto one line.
  return sanitize(marked.parse(md, { async: false, breaks: true }) as string)
}

export function stripFrontmatter(md: string): string {
  const m = md.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? md.slice(m[0].length) : md
}

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "em", "del", "code", "pre",
  "blockquote", "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "span",
])
const ALLOWED_ATTRS = new Set(["href", "title"])

function sanitize(dirty: string): string {
  const tpl = document.createElement("template")
  tpl.innerHTML = dirty
  walk(tpl.content)
  return tpl.innerHTML
}

function walk(node: ParentNode) {
  for (const el of Array.from(node.children)) {
    const tag = el.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      el.remove()
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
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
    walk(el)
  }
}
