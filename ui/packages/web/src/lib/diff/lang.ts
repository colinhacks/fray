// Filename → language id, for the highlighter. A small deliberate map: the languages fray agents
// actually touch, plus a plain fallback. Ported from gent's renderer, trimmed to what the tokenizer
// (highlight.ts) understands — anything mapping to "text" renders unhighlighted.

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".jsonc": "json",
  ".css": "css", ".scss": "css", ".less": "css",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown", ".mdx": "markdown",
  ".html": "html", ".htm": "html", ".xml": "html", ".svg": "html",
}

const NAME_TO_LANG: Record<string, string> = {
  Dockerfile: "shell",
  Makefile: "shell",
  ".gitignore": "shell",
  ".env": "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
}

export function detectLang(path: string): string {
  const name = path.split("/").pop() ?? ""
  if (NAME_TO_LANG[name]) return NAME_TO_LANG[name]
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ""
  return EXT_TO_LANG[ext] ?? "text"
}
