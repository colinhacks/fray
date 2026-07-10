import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

// READ-SIDE recovery for a malformed fray thread file. The write-side hook already blocks a compliant
// worker from writing a thread .md with no YAML frontmatter; this heals the stragglers it can't catch
// (pre-hook files, shell-written files that bypass the file-tool hooks, hand edits). A file with no
// frontmatter is INVISIBLE to the queue/status system (the board can't read its title/status) — this
// prepends a minimal, CONSERVATIVE frontmatter block that makes the thread visible again.
//
// Deliberately narrow: it ONLY prepends when frontmatter is entirely MISSING. It never guesses status
// from prose (this morning's incident file declared "DONE" in bold — guessing wrong silently is worse
// than surfacing). It stamps `status: active` so the thread becomes visible; if its agent is gone, the
// runtime crash-net cards it for human attention — the correct escalation.

export class RepairError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RepairError"
  }
}

// The status_text stamped onto a repaired thread — a standing flag that the status is UNVERIFIED.
export const REPAIR_STATUS_TEXT =
  "Frontmatter was missing and auto-repaired — verify the status (the body may declare the real one)."

// Quote a frontmatter scalar the way the fray thread files / thread-update.mjs do: a bare safe scalar
// (slug, date, single word) is left unquoted; anything with spaces/punctuation is double-quoted with
// inner quotes + backslashes escaped. Keeps the healed file byte-consistent with the rest of the board.
function quoteValue(v: string): string {
  if (/^[\w./#:+-]+$/.test(v)) return v
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// Title for the healed thread: the first Markdown H1 (`# heading`) in the body, else the filename slug.
// Only a real H1 counts (`## foo` and `#foo` do not) — matching what a human reading the file would
// call the title.
export function deriveTitle(body: string, slug: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : slug
}

// Repair the named thread file IN PLACE. `file` is expected to be a bare `<slug>.md` basename (the
// value carried on a BoardErrorItem), but is validated defensively regardless of caller. Throws a
// RepairError (surfaced to the RPC caller as the error message) on any refusal.
//   - path traversal / wrong location: the resolved path MUST sit directly under frayDir and end in .md
//   - missing file: nothing to repair
//   - already has a `---` block: repair is ONLY for the missing-frontmatter case, never an edit
export function repairThreadFile(frayDir: string, file: string): { slug: string } {
  const root = resolve(frayDir)
  const abs = resolve(root, file)
  // Prefix/location guard: reject `../escape.md`, `sub/nested.md`, and absolute paths alike — the file
  // must be a direct child of .fray/. Comparing the resolved dirname to the resolved root is the check.
  if (dirname(abs) !== root) throw new RepairError(`refusing to repair "${file}": not directly under .fray/`)
  if (!abs.endsWith(".md")) throw new RepairError(`refusing to repair "${file}": not a .md thread file`)
  if (!existsSync(abs)) throw new RepairError(`no thread file to repair: ${basename(abs)}`)

  const content = readFileSync(abs, "utf8")
  // Refuse only if the file OPENS with a frontmatter block — i.e. its first non-blank line is `---`.
  // (Was `/^---\s*$/m` which, with the multiline flag, matched a `---` anywhere; a markdown thematic
  // break in the BODY then blocked repair, so a heading-first doc like `# Title …\n---\n` could never
  // be healed — the exact recurring "no YAML frontmatter" error that Repair refused. YAML frontmatter
  // is only valid at the very top, so anchoring the check to the first line is both correct and the
  // conservative intent: a real (even broken) leading block stays a human concern.)
  const firstLine = content.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "")
  if (firstLine?.trim() === "---") {
    throw new RepairError(`${basename(abs)} already opens with a "---" block — repair only heals a MISSING frontmatter block`)
  }

  const slug = basename(abs).replace(/\.md$/, "")
  const title = deriveTitle(content, slug)
  const frontmatter = [
    "---",
    `title: ${quoteValue(title)}`,
    "status: active",
    `status_text: ${quoteValue(REPAIR_STATUS_TEXT)}`,
    "---",
    "",
  ].join("\n")
  // Preserve the original body verbatim below the new block (a single blank line already trails the
  // closing `---`); the prose that carried the real metadata stays intact for human verification.
  writeFileSync(abs, frontmatter + content)
  return { slug }
}
