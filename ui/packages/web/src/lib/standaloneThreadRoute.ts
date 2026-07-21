export function standaloneThreadHref(slug: string): string {
  return `/thread/${encodeURIComponent(slug)}/full`
}

export function parseStandaloneThreadPath(path: string): string | null {
  const match = path.match(/^\/thread\/([^/]+)\/full$/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
